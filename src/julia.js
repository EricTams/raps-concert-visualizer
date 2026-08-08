// ---------------------------------------------------------------------------
// CPU-side targeting and camera for the Julia effect.
//
// The only part of a Julia set worth looking at is its boundary. The interior
// is featureless and the far exterior is a handful of very wide escape bands,
// so zooming toward any fixed coordinate lands on something dull most of the
// time — the boundary keeps moving as the constant c walks its circle.
//
// Inverse iteration solves this exactly rather than by guesswork. The Julia set
// is the attractor of the two inverse branches z <- ±sqrt(z - c), so iterating
// them from almost any start converges onto the boundary geometrically fast.
// Two dozen steps with a fixed sign sequence single out one specific boundary
// point, and because the map is contracting the result depends on the last few
// choices rather than where it started.
//
// All of this is a few dozen flops per frame here, versus running the same
// iteration redundantly in every one of several million fragments.
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;

const C_RADIUS = 0.7885;    // the classic circle, rich in distinct topologies
const C_RATE = 0.045;       // radians per second around it
const ZOOM_RATE = 1 / 58;   // one in-and-out cycle every 58 seconds
const VIEW_WIDE = 2.4;      // complex-plane view width at the wide end
const VIEW_TIGHT = 0.28;    // ... and at the tight end
const INVERSE_STEPS = 24;

/** Zoom phase, 0 at the wide end of the cycle and 1 at the tight end. */
function zoomAt(f) {
  return 0.5 - 0.5 * Math.cos(f * TAU);
}

/** Complex-plane view width. Geometric, so apparent zoom rate is constant. */
function viewAt(f) {
  return VIEW_TIGHT * Math.pow(VIEW_WIDE / VIEW_TIGHT, 1 - zoomAt(f));
}

/**
 * A point on the Julia set for c. On the first call the branch at each step is
 * chosen from `seedBits`, which is what picks out one boundary point rather
 * than another. On later calls it is chosen to stay near `prev`, the same
 * step's value from the frame before.
 *
 * That continuity rule is essential, not a refinement. The principal square
 * root swaps which of the two roots it names as w crosses the negative real
 * axis, and as c drifts some intermediate w crosses it every few seconds. With
 * a fixed sign sequence the point then teleports to an unrelated part of the
 * boundary — measured at roughly 490 view-widths in a single frame, about once
 * every nine seconds — and the view goes chasing after it for no reason.
 */
function walkToBoundary(cx, cy, seedBits, prev) {
  const traj = new Float64Array(2 * INVERSE_STEPS);
  let zx = 0, zy = 0;
  let bits = seedBits >>> 0;

  for (let i = 0; i < INVERSE_STEPS; i++) {
    const wx = zx - cx, wy = zy - cy;
    const r = Math.hypot(wx, wy);
    // Principal square root of w; the other root is its negation.
    let sx = Math.sqrt(Math.max(0, (r + wx) * 0.5));
    let sy = Math.sqrt(Math.max(0, (r - wx) * 0.5));
    if (wy < 0) sy = -sy;

    bits = (Math.imul(bits, 1103515245) + 12345) >>> 0;
    let flip = (bits & 0x10000) !== 0;

    if (prev) {
      const px = prev[2 * i], py = prev[2 * i + 1];
      const ax = sx - px, ay = sy - py;
      const bx = -sx - px, by = -sy - py;
      flip = (bx * bx + by * by) < (ax * ax + ay * ay);
    }

    if (flip) { sx = -sx; sy = -sy; }
    traj[2 * i] = sx;
    traj[2 * i + 1] = sy;
    zx = sx;
    zy = sy;
  }

  return { x: zx, y: zy, traj };
}

// ---------------------------------------------------------------------------
// Choosing which boundary point to aim at.
//
// Any point of the boundary has infinite detail arbitrarily close to it, so
// "on the boundary" is not on its own a useful standard. Inverse iteration
// samples the boundary by harmonic measure, which readily lands out on a bare
// filament at the edge of the set with nothing else in view — technically
// interesting, visually dead, and it puts all the drama off screen.
//
// So audition a batch and keep a good one. Two things make a point good:
// sitting near the middle of the set, and having plenty of other boundary
// nearby. The second is nearly free — the candidates are themselves a sample
// of the boundary, so counting how many fall within a view of each other
// measures local busyness directly.
//
// Both measures are taken relative to the set's own extent, because these
// Julia sets range from fat connected blobs to sparse dust and a fixed
// distance would mean quite different things for each.
// ---------------------------------------------------------------------------

const CANDIDATES = 32;
const SHORTLIST = 6;          // pick among this many best, so it still varies
const NEIGHBOUR_RADIUS = 0.35; // as a fraction of the set's extent
const RADIUS_WEIGHT = 1.25;    // how strongly to prefer the middle

function chooseBits(cx, cy, n) {
  const pts = [];
  let extent = 1e-6;
  for (let k = 0; k < CANDIDATES; k++) {
    const bits = Math.imul(Math.imul(n, 2654435761) + Math.imul(k, 40503), 2246822519);
    const p = walkToBoundary(cx, cy, bits, null);
    const r = Math.hypot(p.x, p.y);
    if (r > extent) extent = r;
    pts.push({ bits, x: p.x, y: p.y, r, score: 0 });
  }

  const near = NEIGHBOUR_RADIUS * extent;
  for (const p of pts) {
    let busy = 0;
    for (const q of pts) {
      if (q !== p && Math.hypot(q.x - p.x, q.y - p.y) < near) busy++;
    }
    p.score = busy / (CANDIDATES - 1) - RADIUS_WEIGHT * (p.r / extent);
  }

  pts.sort((a, b) => b.score - a.score);
  return pts[(Math.imul(n, 22695477) >>> 0) % SHORTLIST].bits;
}

// Chosen point and its trajectory, carried between frames so the target
// evolves continuously. Re-chosen when the cycle index advances.
let walkState = null;

/**
 * Where to aim, how wide a view to take, and the constant, for a given moment
 * of a given slot. This is the target only — the camera below decides how the
 * view actually gets there.
 */
export function juliaTarget(time, seed) {
  const th = time * C_RATE + seed * TAU;
  const cx = C_RADIUS * Math.cos(th);
  const cy = C_RADIUS * Math.sin(th);

  const cyc = time * ZOOM_RATE + seed * 7;
  const n = Math.floor(cyc);
  const f = cyc - n;

  // A new cycle index means a deliberate re-aim, so a fresh point is auditioned
  // rather than the old one tracked. The index turns over at f = 0, the widest
  // point of the zoom, so the flight across happens while pulled back and the
  // push-in lands on the new point.
  if (!walkState || walkState.seed !== seed || walkState.n !== n) {
    walkState = { seed, n, traj: null, bits: chooseBits(cx, cy, n) };
  }
  const p = walkToBoundary(cx, cy, walkState.bits, walkState.traj);
  walkState.traj = p.traj;

  return { cx, cy, x: p.x, y: p.y, view: viewAt(f), zb: zoomAt(f) };
}

// ---------------------------------------------------------------------------
// The camera.
//
// Rather than interpolating along a path — which pins the motion to a schedule
// and lurches whenever the target changes off-schedule — the view carries a
// velocity and is steered by a bounded acceleration. It cannot jump, because
// position only ever changes by velocity x dt and velocity only ever changes by
// at most MAX_ACCEL x dt. However abruptly the target moves, the view winds up,
// travels, and eases off on approach.
//
// Both limits are expressed in view-widths, so a move looks the same whether it
// happens at the wide end of the zoom or deep in the filigree. In world terms
// the camera is roughly eight times slower when zoomed in, which is exactly
// right — the same world distance is a far bigger gesture on screen.
// ---------------------------------------------------------------------------

const MAX_SPEED = 0.16;      // view-widths per second
const MAX_ACCEL = 0.10;      // view-widths per second squared
const ARRIVE_RADIUS = 0.9;   // start easing off inside this many view-widths
const MAX_STEP = 0.05;       // clamp dt, so a stalled frame cannot launch it

export class JuliaCamera {
  constructor() {
    this.x = 0;
    this.y = 0;
    this.vx = 0;
    this.vy = 0;
    this.ready = false;
  }

  /** Snap to a target. Used at a slot change, where there is nothing to fly from. */
  reset(target) {
    this.x = target.x;
    this.y = target.y;
    this.vx = 0;
    this.vy = 0;
    this.ready = true;
  }

  step(target, view, dt) {
    if (!this.ready) return this.reset(target);
    const h = Math.min(dt, MAX_STEP);

    const maxSpeed = MAX_SPEED * view;
    const maxAccel = MAX_ACCEL * view;
    const arrive = ARRIVE_RADIUS * view;

    const dx = target.x - this.x;
    const dy = target.y - this.y;
    const dist = Math.hypot(dx, dy);

    // Wanted velocity: full tilt when far off, tapering to nothing on arrival.
    // That taper is the deceleration — without it the camera runs at speed
    // until it is on top of the target and then stops dead.
    let wx = 0, wy = 0;
    if (dist > 1e-9) {
      const want = maxSpeed * Math.min(1, dist / arrive);
      wx = (dx / dist) * want;
      wy = (dy / dist) * want;
    }

    // Steer toward that velocity, but never faster than the acceleration limit.
    let ax = wx - this.vx;
    let ay = wy - this.vy;
    const need = Math.hypot(ax, ay);
    const budget = maxAccel * h;
    if (need > budget) {
      ax = (ax / need) * budget;
      ay = (ay / need) * budget;
    }
    this.vx += ax;
    this.vy += ay;

    const speed = Math.hypot(this.vx, this.vy);
    if (speed > maxSpeed) {
      this.vx = (this.vx / speed) * maxSpeed;
      this.vy = (this.vy / speed) * maxSpeed;
    }

    this.x += this.vx * h;
    this.y += this.vy * h;
    return this;
  }
}
