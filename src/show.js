// ---------------------------------------------------------------------------
// The show: asset loading, scheduling, rendering, and operator controls.
// ---------------------------------------------------------------------------

import { SETLIST, SLOT_SECONDS, TRANSITION_SECONDS, FRAMING, INTENSITY, DATAMOSH_FLOW } from '../config.js';
import { EFFECTS, EFFECT_NAMES, FEEDBACK_EFFECTS, RESOLVE_EFFECTS } from './effects.js';
import { TRANSITIONS, transitionFor } from './transitions.js';
import { juliaTarget, JuliaCamera } from './julia.js';
import { Chamber, MAX_TRACKS } from './chamber.js';
import { createContext, createScreenQuad, createTexture, draw, bindScreen, Program, Framebuffer, COPY_FRAGMENT } from './gl.js';

// --- URL overrides ---------------------------------------------------------

const params = new URLSearchParams(location.search);
const num = (key, fallback) => {
  const v = parseFloat(params.get(key));
  return Number.isFinite(v) ? v : fallback;
};

const opts = {
  slotDur: Math.max(1, num('dur', SLOT_SECONDS)),
  transDur: Math.max(0.2, num('trans', TRANSITION_SECONDS)),
  intensity: num('intensity', INTENSITY),
  flowAmount: num('flow', DATAMOSH_FLOW.amount),
  flowSpeed: num('flowspeed', DATAMOSH_FLOW.speed),
  fixedOrder: params.get('order') === 'fixed',
  hud: params.get('hud') === '1',
  capture: params.get('capture') === '1',
  lockedEffect: (() => {
    const raw = params.get('fx');
    if (!raw) return null;
    if (EFFECT_NAMES.includes(raw)) return raw;
    const i = parseInt(raw, 10);
    return Number.isInteger(i) ? EFFECT_NAMES[((i % EFFECT_NAMES.length) + EFFECT_NAMES.length) % EFFECT_NAMES.length] : null;
  })(),
};
opts.transDur = Math.min(opts.transDur, opts.slotDur * 0.5);

// --- DOM -------------------------------------------------------------------

const canvas = document.getElementById('stage');
const hudEl = document.getElementById('hud');
const debugEl = document.getElementById('debug');
const fatalEl = document.getElementById('fatal');

function fatal(message) {
  fatalEl.textContent = message;
  fatalEl.classList.add('on');
  console.error(message);
}

// --- Deterministic per-slot randomness -------------------------------------

const runSeed = Math.floor(Math.random() * 1e9);
function hashInt(n) {
  let x = (n ^ runSeed) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 2246822507);
  x = Math.imul(x ^ (x >>> 13), 3266489909);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

// --- Asset loading ---------------------------------------------------------

const covers = SETLIST.map((entry) => ({ ...entry, image: null, backdrop: null, texture: null, bgTexture: null, ok: false }));

/**
 * A tiny downscale of the cover. Magnified back up with linear filtering it
 * becomes a smooth blur for free — no blur pass, no mipmaps, no extra draw.
 * Downscaled in two steps because a single huge reduction aliases badly.
 */
function makeBackdrop(img) {
  const step = document.createElement('canvas');
  step.width = step.height = 192;
  const sc = step.getContext('2d');
  sc.imageSmoothingEnabled = true;
  sc.imageSmoothingQuality = 'high';
  sc.drawImage(img, 0, 0, 192, 192);

  const out = document.createElement('canvas');
  out.width = out.height = 48;
  const oc = out.getContext('2d');
  oc.imageSmoothingEnabled = true;
  oc.imageSmoothingQuality = 'high';
  oc.drawImage(step, 0, 0, 48, 48);
  return out;
}

async function loadCovers() {
  await Promise.all(covers.map(async (cover) => {
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = cover.file;
      await img.decode();
      cover.image = img;
      cover.backdrop = makeBackdrop(img);
      cover.ok = true;
    } catch (err) {
      console.warn(`Skipping "${cover.title}" — could not load ${cover.file}`, err);
    }
  }));
  return covers.filter((c) => c.ok);
}

// --- Play order ------------------------------------------------------------
//
// `sequence` is an ever-growing list of indices into `playable`. It is extended
// one shuffled cycle at a time, so every cover shows once per cycle and no
// cover ever plays twice in a row across a cycle boundary.

let playable = [];
const sequence = [];
let cycleCount = 0;

function shuffledCycle() {
  const cycle = playable.map((_, i) => i);
  if (opts.fixedOrder) return cycle;
  for (let i = cycle.length - 1; i > 0; i--) {
    const j = Math.floor(hashInt(cycleCount * 1013 + i * 7) * (i + 1));
    [cycle[i], cycle[j]] = [cycle[j], cycle[i]];
  }
  return cycle;
}

function ensureSequence(upTo) {
  while (sequence.length <= upTo) {
    const cycle = shuffledCycle();
    cycleCount++;
    const last = sequence[sequence.length - 1];
    if (cycle.length > 1 && last !== undefined && cycle[0] === last) {
      [cycle[0], cycle[1]] = [cycle[1], cycle[0]];
    }
    sequence.push(...cycle);
  }
}

const coverAt = (pos) => playable[sequence[pos]];
const seedAt = (pos) => hashInt(pos * 2654435761);

// Set from the Tab panel or ?fx=; overrides whatever the setlist assigns.
let effectOverride = opts.lockedEffect;

// Shaders chosen by a manual skip, keyed by position. Remembered rather than
// re-rolled, so the choice does not change under you every frame.
const skipFx = new Map();

function effectAt(pos) {
  if (effectOverride) return effectOverride;
  const skipped = skipFx.get(pos);
  if (skipped) return skipped;
  const fx = coverAt(pos).fx;
  if (fx && EFFECTS[fx]) return fx;
  return EFFECT_NAMES[Math.floor(seedAt(pos) * EFFECT_NAMES.length) % EFFECT_NAMES.length];
}

/**
 * Asking for the next cover is asking for something else to look at, so it
 * changes the shader as well — and it wins over a pinned one, because pinning
 * is for holding a shader while the show runs itself, not for refusing to move.
 * Press the shader key again after skipping to pin the new one.
 */
function freshEffect(targetPos) {
  const leaving = effectAt(pos);
  effectOverride = null;
  const choices = EFFECT_NAMES.filter((name) => name !== leaving);
  skipFx.set(targetPos, choices[Math.floor(Math.random() * choices.length)]);
  // Slots already behind us are never looked at again.
  for (const at of skipFx.keys()) if (at < pos - 1) skipFx.delete(at);
}

// --- GL resources ----------------------------------------------------------

let gl = null;
let effectPrograms = new Map();
let transitionPrograms = new Map();
let resolvePrograms = new Map();
let copyProgram = null;
let fboA = null;
let fboB = null;

// Feedback effects need a buffer that survives between frames. Channel 0 is
// whatever is playing, channel 1 the cover arriving during a transition, so a
// feedback effect on both sides of a handoff keeps two separate accumulations.
// Allocated only if a feedback effect actually runs.
const histories = [null, null];

function getHistory(channel) {
  if (!histories[channel]) {
    histories[channel] = {
      read: new Framebuffer(gl, width, height),
      write: new Framebuffer(gl, width, height),
      pos: null,
      name: null,
    };
  }
  return histories[channel];
}

function buildGL() {
  gl = createContext(canvas, opts.capture);
  createScreenQuad(gl);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  gl.clearColor(0, 0, 0, 1);

  effectPrograms = new Map();
  for (const [name, src] of Object.entries(EFFECTS)) {
    effectPrograms.set(name, new Program(gl, src, `effect:${name}`));
  }
  transitionPrograms = new Map();
  for (const [name, src] of Object.entries(TRANSITIONS)) {
    transitionPrograms.set(name, new Program(gl, src, `transition:${name}`));
  }
  resolvePrograms = new Map();
  for (const [name, src] of Object.entries(RESOLVE_EFFECTS)) {
    resolvePrograms.set(name, new Program(gl, src, `resolve:${name}`));
  }
  copyProgram = new Program(gl, COPY_FRAGMENT, 'copy');
  histories[0] = histories[1] = null;

  for (const cover of playable) {
    cover.texture = createTexture(gl, cover.image);
    cover.bgTexture = createTexture(gl, cover.backdrop);
  }

  fboA = new Framebuffer(gl, 2, 2);
  fboB = new Framebuffer(gl, 2, 2);
  resize(true);
}


// --- Sizing and adaptive resolution ----------------------------------------

const SCALE_STEPS = [1.0, 0.8, 0.65, 0.5];
let scaleStep = 0;
let width = 2;
let height = 2;

function resize(force = false) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const scale = SCALE_STEPS[scaleStep];
  const w = Math.max(2, Math.round(canvas.clientWidth * dpr * scale));
  const h = Math.max(2, Math.round(canvas.clientHeight * dpr * scale));
  if (!force && w === width && h === height) return;
  width = w;
  height = h;
  canvas.width = w;
  canvas.height = h;
  fboA.resize(w, h);
  fboB.resize(w, h);
}

let slowFrames = 0;
let scaleCooldown = 0;

function trackPerformance(dtMs) {
  if (scaleCooldown > 0) { scaleCooldown--; return; }
  if (dtMs > 22 && scaleStep < SCALE_STEPS.length - 1) {
    if (++slowFrames >= 60) {
      scaleStep++;
      slowFrames = 0;
      scaleCooldown = 180;
      console.info(`Render scale reduced to ${SCALE_STEPS[scaleStep]} to hold frame rate.`);
      resize(true);
    }
  } else {
    slowFrames = Math.max(0, slowFrames - 1);
  }
}

// --- Clock and scheduling --------------------------------------------------

let clockTime = 0;     // never stops; drives the shader animation
let showTime = 0;      // scheduling clock; frozen while held
let slotStart = 0;     // showTime at which the current slot began
let pos = 0;           // index into `sequence`
let pendingPos = null; // target while a transition is running
let held = false;
let running = false;

const songTime = () => showTime - slotStart;
const transitionStart = () => opts.slotDur - opts.transDur;
const isTransitioning = () => pendingPos !== null && songTime() >= transitionStart();

// Only ever called by the operator — the automatic advance sets pendingPos
// itself — so this is the one place that knows a skip was asked for.
function goTo(targetPos) {
  if (targetPos < 0) return;
  ensureSequence(targetPos);
  freshEffect(targetPos);
  pendingPos = targetPos;
  slotStart = showTime - transitionStart();
}

function commitAdvance() {
  pos = pendingPos;
  pendingPos = null;
  slotStart += opts.slotDur;
  ensureSequence(pos + 1);
}

// --- Rendering -------------------------------------------------------------

// The Julia view carries a velocity and is steered by a bounded acceleration,
// so it can never jump however abruptly the target moves — see JuliaCamera.
// Only channel 0 is steered: during a transition the incoming cover has a
// negative song time, so its envelope is zero and the effect renders as the
// plain artwork whatever the camera says.
const juliaCam = new JuliaCamera();
let juliaCamPos = null;
let frameDt = 0.016;

const IDLE_JULIA = { cx: 0, cy: 0, x: 0, y: 0, view: 1, zb: 0 };

// The bubble chamber's particles, likewise, only run for whatever is actually
// on screen. During a transition the incoming cover's envelope is zero, so it
// gets empty slots and draws no tracks — its exposure starts when it lands.
const chamber = new Chamber();
const NO_TRACKS = new Float32Array(MAX_TRACKS * 4);
let chamberPos = null;

function chamberFor(atPos, channel, live) {
  if (!live || channel !== 0) return null;
  if (chamberPos !== atPos) {
    chamber.reset(seedAt(atPos));
    chamberPos = atPos;
  }
  // Events are aimed at the cover panel, not at the whole 16:9 frame, so the
  // simulation needs to know how big the panel is.
  chamber.step(frameDt, width / Math.max(height, 1), FRAMING.fit * 0.5);
  return chamber;
}

function juliaFor(atPos, channel) {
  if (channel !== 0) return IDLE_JULIA;
  const target = juliaTarget(clockTime, seedAt(atPos));
  if (juliaCamPos !== atPos) {
    juliaCam.reset(target);
    juliaCamPos = atPos;
  } else {
    juliaCam.step(target, target.view, frameDt);
  }
  target.x = juliaCam.x;
  target.y = juliaCam.y;
  return target;
}

function renderEffect(atPos, songT, target, channel) {
  const cover = coverAt(atPos);
  const name = effectAt(atPos);
  const prog = effectPrograms.get(name);
  const feedback = FEEDBACK_EFFECTS.has(name);

  let hist = null;
  let reset = 0;
  if (feedback) {
    hist = getHistory(channel);
    if (hist.read.width !== width || hist.read.height !== height) {
      hist.read.resize(width, height);
      hist.write.resize(width, height);
      reset = 1;
    }
    // Two feedback effects share the pair of buffers, and they read the alpha
    // channel as different things, so switching between them mid-slot has to
    // start clean as surely as changing cover does.
    if (hist.pos !== atPos || hist.name !== name) {
      hist.pos = atPos;
      hist.name = name;
      reset = 1;
    }
    hist.write.bind();
  } else if (target) {
    target.bind();
  } else {
    bindScreen(gl, width, height);
  }

  const jt = juliaFor(atPos, channel);
  const ch = chamberFor(atPos, channel, name === 'chamber');

  // A resolve pass gets exactly the same uniforms as the effect it belongs to,
  // so anything the effect used to place the artwork it can place it the same.
  const setUniforms = (p) => p.use()
    .tex('u_tex', cover.texture, 0)
    .tex('u_bg', cover.bgTexture, 1)
    .v2('u_resolution', width, height)
    .f('u_time', clockTime)
    .f('u_songTime', songT)
    .f('u_progress', songT / opts.slotDur)
    .f('u_slotDur', opts.slotDur)
    .f('u_intensity', opts.intensity)
    .f('u_seed', seedAt(atPos))
    .f('u_reset', reset)
    .f('u_dt', frameDt)
    .v2('u_flow', opts.flowAmount, opts.flowSpeed)
    .v4('u_julia', jt.cx, jt.cy, jt.x, jt.y)
    .v2('u_juliaView', jt.view, jt.zb)
    .v4v('u_tracks', ch ? ch.segments : NO_TRACKS)
    .v4v('u_trackStyle', ch ? ch.styles : NO_TRACKS)
    // Whatever a feedback effect accumulates is stored in screen space, so the
    // slow framing breathe is held still for them — otherwise the buffer would
    // drift out of register with the artwork underneath it.
    .v4('u_framing', FRAMING.fit, feedback ? 0 : FRAMING.breathe,
        FRAMING.backdropDim, FRAMING.backdropZoom);

  setUniforms(prog);
  if (feedback) prog.tex('u_prev', hist.read.texture, 2);
  draw(gl);

  if (feedback) {
    const swap = hist.read; hist.read = hist.write; hist.write = swap;
    if (target) target.bind(); else bindScreen(gl, width, height);
    // Effects whose buffer is already the frame just get copied out. Ones whose
    // buffer holds something else — chamber stores a distortion field, not a
    // picture — run their own pass to turn it into one.
    const resolve = resolvePrograms.get(name);
    if (resolve) {
      setUniforms(resolve).tex('u_src', hist.read.texture, 2);
    } else {
      copyProgram.use().tex('u_src', hist.read.texture, 0);
    }
    draw(gl);
  }
}

function renderFrame() {
  const t = songTime();

  if (!isTransitioning()) {
    renderEffect(pos, t, null, 0);
    return;
  }

  // Outgoing at its own slot time; incoming counts up to zero, so it arrives
  // clean and its effect grows in once the handoff completes.
  renderEffect(pos, t, fboA, 0);
  renderEffect(pendingPos, t - opts.slotDur, fboB, 1);

  const mix = (t - transitionStart()) / opts.transDur;
  const prog = transitionPrograms.get(transitionFor(effectAt(pendingPos)));
  bindScreen(gl, width, height);
  prog.use()
    .tex('u_from', fboA.texture, 0)
    .tex('u_to', fboB.texture, 1)
    .f('u_t', Math.min(1, Math.max(0, mix)))
    .v2('u_resolution', width, height)
    .f('u_time', clockTime)
    .f('u_seed', seedAt(pendingPos));
  draw(gl);
}

// --- Main loop -------------------------------------------------------------

let lastFrame = 0;
let rafId = 0;

function tick(now) {
  rafId = requestAnimationFrame(tick);
  const dtMs = lastFrame ? now - lastFrame : 16.7;
  lastFrame = now;

  const dt = Math.min(dtMs, 100) / 1000;
  frameDt = dt;
  clockTime += dt;
  // Holding freezes the schedule but not the animation, so a held image keeps
  // moving instead of looking like a crashed machine. A hold pressed mid-
  // transition still lets that transition finish before it takes effect.
  if (!held || isTransitioning()) showTime += dt;

  // A slot with no pending target queues the automatic advance.
  if (pendingPos === null && songTime() >= transitionStart()) {
    ensureSequence(pos + 1);
    pendingPos = pos + 1;
  }
  if (pendingPos !== null && songTime() >= opts.slotDur) commitAdvance();

  resize();
  renderFrame();
  trackPerformance(dtMs);
  updateHud();
  if (debugOn && hudTick % 10 === 0) updateDebugPanel();
}

function start() {
  if (running) return;
  running = true;
  lastFrame = 0;
  rafId = requestAnimationFrame(tick);
}

function stop() {
  running = false;
  cancelAnimationFrame(rafId);
}

// --- HUD -------------------------------------------------------------------

let hudOn = opts.hud;
let hudTick = 0;

function updateHud() {
  hudTick++;
  if (!hudOn || hudTick % 10) return;
  const remaining = Math.max(0, opts.slotDur - songTime());
  const target = pendingPos !== null ? ` -> ${coverAt(pendingPos).title}` : '';
  hudEl.textContent =
    `${coverAt(pos).title}\n` +
    `${effectAt(pos)}  ${remaining.toFixed(0)}s${held ? '  [HELD]' : ''}${target}\n` +
    `${width}x${height} @ ${SCALE_STEPS[scaleStep]}x`;
}

function setHud(on) {
  hudOn = on;
  hudEl.classList.toggle('on', on);
  if (!on) hudEl.textContent = '';
}

// --- Debug panel -----------------------------------------------------------
//
// Tab opens a cheat-sheet listing every cover and every shader with the key
// that selects it, so the whole library can be flipped through and judged
// without touching the code.

const EFFECT_KEYS = ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o'];
let debugOn = false;

function buildDebugPanel() {
  const panel = debugEl.querySelector('.panel');
  const list = (heading, items) =>
    `<div><h2>${heading}</h2><ul>${items.map(
      ({ key, name, id }) =>
        `<li data-id="${id}"><kbd>${key}</kbd><span class="name">${name}</span></li>`
    ).join('')}</ul></div>`;

  panel.innerHTML =
    list('Cover', playable.map((c, i) => ({
      key: i + 1, name: c.title, id: `cover:${i}`,
    }))) +
    list('Shader', EFFECT_NAMES.map((name, i) => ({
      key: EFFECT_KEYS[i] || '-', name, id: `fx:${name}`,
    }))) +
    list('Show', [
      { key: '0', name: 'shader back to setlist', id: 'x0' },
      { key: '→', name: 'next cover', id: 'x1' },
      { key: '←', name: 'previous cover', id: 'x2' },
      { key: 'P', name: 'hold / release', id: 'x3' },
      { key: 'F', name: 'fullscreen', id: 'x4' },
      { key: 'H', name: 'small overlay', id: 'x5' },
      { key: '[ ]', name: 'intensity down / up', id: 'x6' },
      { key: '⇥', name: 'close this panel', id: 'x7' },
    ]) +
    '<div class="now"></div>';
}

function updateDebugPanel() {
  if (!debugOn) return;
  const activeCover = `cover:${sequence[pos]}`;
  const activeFx = `fx:${effectAt(pos)}`;
  for (const li of debugEl.querySelectorAll('li')) {
    const id = li.dataset.id;
    li.classList.toggle('active', id === activeCover || id === activeFx);
  }
  const remaining = Math.max(0, opts.slotDur - songTime());
  debugEl.querySelector('.now').textContent =
    `${coverAt(pos).title} — ${effectAt(pos)}` +
    `${effectOverride ? ' (locked)' : ''}${held ? ' — HELD' : ''}\n` +
    `${remaining.toFixed(0)}s left of ${opts.slotDur}s` +
    `${pendingPos !== null ? `, transitioning via ${transitionFor(effectAt(pendingPos))} to ${coverAt(pendingPos).title}` : ''}\n` +
    `intensity ${opts.intensity.toFixed(2)} · ${width}×${height} @ ${SCALE_STEPS[scaleStep]}×`;
}

function setDebug(on) {
  debugOn = on;
  debugEl.classList.toggle('on', on);
  updateDebugPanel();
}

/** Jump to the next upcoming slot showing setlist entry `wanted`. */
function jumpToCover(wanted) {
  let target = pos + 1;
  ensureSequence(target + playable.length * 2);
  for (let i = 0; i < playable.length * 2; i++) {
    if (sequence[target + i] === wanted) { target += i; break; }
  }
  goTo(target);
}

// --- Controls --------------------------------------------------------------

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen().catch(() => {});
}

function installControls() {
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();

    if (e.key === 'Tab') { e.preventDefault(); setDebug(!debugOn); return; }

    const fxIndex = EFFECT_KEYS.indexOf(k);
    if (fxIndex >= 0 && fxIndex < EFFECT_NAMES.length) {
      effectOverride = EFFECT_NAMES[fxIndex];
      updateDebugPanel();
      return;
    }

    switch (k) {
      case 'arrowright': case ' ':
        e.preventDefault(); if (!isTransitioning()) goTo(pos + 1); break;
      case 'arrowleft':
        e.preventDefault(); if (!isTransitioning() && pos > 0) goTo(pos - 1); break;
      case 'p': held = !held; break;
      case 'f': toggleFullscreen(); break;
      case 'h': setHud(!hudOn); break;
      // Back to the setlist: drops a pinned shader and every shader a skip
      // picked, so what is on screen is what the show would have chosen.
      case '0': effectOverride = null; skipFx.clear(); updateDebugPanel(); break;
      case '[': opts.intensity = Math.max(0, opts.intensity - 0.1); updateDebugPanel(); break;
      case ']': opts.intensity = Math.min(2, opts.intensity + 0.1); updateDebugPanel(); break;
      default: {
        const n = parseInt(k, 10);
        if (Number.isInteger(n) && n >= 1 && n <= playable.length && !isTransitioning()) {
          jumpToCover(n - 1);
        }
      }
    }
  });

  // Single click advances; double click toggles fullscreen without also
  // advancing twice.
  let clickTimer = 0;
  canvas.addEventListener('click', () => {
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => { if (!isTransitioning()) goTo(pos + 1); }, 250);
  });
  canvas.addEventListener('dblclick', () => {
    clearTimeout(clickTimer);
    toggleFullscreen();
  });

  window.addEventListener('resize', () => resize(true));

  // Recover rather than die if the GPU drops the context mid-set.
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    stop();
    console.warn('WebGL context lost — waiting for restore.');
  });
  canvas.addEventListener('webglcontextrestored', () => {
    console.warn('WebGL context restored — rebuilding.');
    try { buildGL(); start(); }
    catch (err) { fatal(`Could not rebuild after GPU context loss.\n\n${err.message}`); }
  });

  // Idle cursor.
  let idleTimer = 0;
  const wake = () => {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => document.body.classList.add('idle'), 2000);
  };
  window.addEventListener('mousemove', wake);
  wake();
}

// --- Keep the display awake for the length of the set ----------------------

async function keepAwake() {
  if (!('wakeLock' in navigator)) return;
  let lock = null;
  const acquire = async () => {
    try { lock = await navigator.wakeLock.request('screen'); }
    catch { /* denied or unsupported; the show still runs */ }
  };
  await acquire();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (!lock || lock.released)) acquire();
  });
}

// --- Boot ------------------------------------------------------------------

async function main() {
  playable = await loadCovers();
  if (playable.length === 0) {
    fatal('No cover images could be loaded. Check that the images/ folder shipped with the page.');
    return;
  }

  try {
    buildGL();
  } catch (err) {
    fatal(`This browser could not start the visualizer.\n\n${err.message}`);
    return;
  }

  ensureSequence(1);
  setHud(hudOn);
  buildDebugPanel();
  installControls();
  keepAwake();
  start();

  console.info(
    `Visualizer running — ${playable.length} covers, ${opts.slotDur}s slots, ` +
    `${opts.transDur}s transitions${opts.lockedEffect ? `, locked to "${opts.lockedEffect}"` : ''}. ` +
    `Press Tab for the full key list.`
  );
}

main();
