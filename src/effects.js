// ---------------------------------------------------------------------------
// The effect library.
//
// Every effect is a GLSL ES 1.00 fragment shader sharing one prelude, so
// cropping, drift and the intensity envelope behave identically across the show.
//
// Shared uniforms (set for every effect, every frame):
//   u_tex        the cover art
//   u_resolution render target size in pixels
//   u_time       absolute seconds since load  (continuous noise, never resets)
//   u_songTime   seconds into the current slot
//   u_progress   0 -> 1 through the current slot
//   u_slotDur    slot length in seconds
//   u_intensity  global intensity multiplier from config
//   u_seed       per-slot random value, so a repeat never looks identical
//   u_bg         a tiny pre-blurred copy of the cover, for the surround
//   u_framing    (fit, breathe, backdropDim, backdropZoom)
// ---------------------------------------------------------------------------

const PRELUDE = `
precision highp float;

varying vec2 v_uv;

uniform sampler2D u_tex;
uniform sampler2D u_bg;
uniform vec2  u_resolution;
uniform float u_time;
uniform float u_songTime;
uniform float u_progress;
uniform float u_slotDur;
uniform float u_intensity;
uniform float u_seed;
uniform vec4  u_framing;

// Feedback effects only: last frame's output, and a flag that says to ignore it
// and start clean (first frame of a slot, or after a resize).
uniform sampler2D u_prev;
uniform float u_reset;

// Datamosh flow field: (amount, speed). See DATAMOSH_FLOW in config.js.
uniform vec2 u_flow;

const float TAU = 6.28318530718;

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

float noise2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i),                hash21(i + vec2(1.0, 0.0)), u.x),
             mix(hash21(i + vec2(0.0,1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int k = 0; k < 5; k++) {
    v += a * noise2(p);
    p = p * 2.02 + vec2(17.3, 9.1);
    a *= 0.5;
  }
  return v;
}

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 hueShift(vec3 c, float a) {
  const vec3 k = vec3(0.57735);
  float ca = cos(a);
  return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
}

mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }

float screenAspect() { return u_resolution.x / max(u_resolution.y, 1.0); }

// Screen space -> centred aspect-corrected space (y spans -0.5..0.5).
vec2 toCentred(vec2 uv) { return (uv - 0.5) * vec2(screenAspect(), 1.0); }

// Map screen UV to texture UV, containing the whole square inside the frame so
// nothing is ever cropped. The cover occupies u_framing.x of the short side and
// breathes slowly in scale. Coordinates outside 0..1 fall on the surround.
vec2 coverUV(vec2 uv) {
  float scale = u_framing.x * (1.0 + u_framing.y * sin(u_songTime * 0.11 + u_seed * TAU));
  return toCentred(uv) / scale + 0.5;
}

// The surround: a tiny pre-blurred copy of the same artwork, zoomed in, dimmed
// and slightly desaturated, with a soft shadow falling away from the cover.
vec3 backdrop(vec2 uv) {
  vec2 b = clamp((uv - 0.5) / u_framing.w + 0.5, 0.0, 1.0);
  vec3 c = texture2D(u_bg, b).rgb;
  c = mix(vec3(luma(c)), c, 0.85) * u_framing.z;
  float out_ = max(max(-uv.x, uv.x - 1.0), max(-uv.y, uv.y - 1.0));
  return c * mix(0.45, 1.0, smoothstep(0.0, 0.06, out_));
}

// Inside the square, the artwork; outside it, the blurred surround, with a
// one-pixel-ish feather so the cover reads as a crisp framed panel.
vec3 sampleRGB(vec2 uv) {
  vec3 fg = texture2D(u_tex, clamp(uv, 0.0, 1.0)).rgb;
  float out_ = max(max(-uv.x, uv.x - 1.0), max(-uv.y, uv.y - 1.0));
  return mix(fg, backdrop(uv), smoothstep(0.0, 0.004, out_));
}

// 1 inside the cover panel, 0 out on the surround. Effects that rearrange
// geometry wholesale multiply by this so they reshape the artwork without
// dragging the blurred surround into the middle of the frame.
float panelMask(vec2 uv) {
  float out_ = max(max(-uv.x, uv.x - 1.0), max(-uv.y, uv.y - 1.0));
  return 1.0 - smoothstep(0.0, 0.02, out_);
}

vec3 sampleChroma(vec2 uv, vec2 off) {
  return vec3(sampleRGB(uv + off).r, sampleRGB(uv).g, sampleRGB(uv - off).b);
}

// Rise over the first 5s, hold, ease back a little before the handoff, so each
// song opens on a near-clean image, builds, and settles.
float env() {
  return u_intensity
       * smoothstep(0.0, 5.0, u_songTime)
       * mix(0.70, 1.0, smoothstep(0.0, 6.0, u_slotDur - u_songTime));
}
`;

// --- 1. Julia escape-time bands -------------------------------------------
//
// The fractal never replaces the artwork — it only decides what happens WHERE.
// Every pixel still comes from the cover; the escape-time count selects which
// treatment that pixel gets, so the set's filigree appears as banded regions of
// posterising, channel rotation and inversion laid over a picture that stays
// entirely readable underneath. Points that never escape are left completely
// alone, so the interior bulbs read as windows onto the clean art.
const JULIA = `
const int ITER = 72;

// Every treatment keeps the picture visible. Band 0 is untouched, so a sixth of
// the bands are always clean however dense the filigree gets.
//
// All of these hold roughly the source brightness. A straight inversion looks
// great on a bright cover and turns a mostly-black one into a sheet of white —
// which on a projector is a flash in the audience's eyes, not an effect. Band 3
// inverts the colour but keeps the luminance, and band 4 lifts shadows instead
// of blowing highlights, so the filigree stays visible over dark artwork.
vec3 treat(vec3 c, float band) {
  float w = mod(band, 6.0);
  float l = luma(c);
  if (w < 1.0) return c;
  if (w < 2.0) return floor(c * 4.0 + 0.5) / 4.0;
  if (w < 3.0) return c.gbr;
  if (w < 4.0) return clamp(vec3(2.0 * l) - c, 0.0, 1.0);
  if (w < 5.0) return clamp(c + vec3(0.30, 0.10, 0.42) * (1.0 - l), 0.0, 1.0);
  return clamp((c - 0.5) * 1.9 + 0.5, 0.0, 1.0);
}

void main() {
  float E = env();
  vec2 uv = coverUV(v_uv);
  vec3 src = sampleRGB(uv);

  // The constant walks the classic |c| = 0.7885 circle, which passes through a
  // whole family of Julia topologies — fat connected blobs through to dendrites
  // — so the set morphs continuously across the slot with no keyframes.
  float th = u_time * 0.045 + u_seed * TAU;
  vec2 c = 0.7885 * vec2(cos(th), sin(th));

  vec2 z = (uv - 0.5) * 3.0;

  float mu = 0.0;
  float escaped = 0.0;
  for (int i = 0; i < ITER; i++) {
    z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
    float r2 = dot(z, z);
    if (r2 > 256.0) {
      // Continuous iteration count, so band edges don't stair-step with the
      // integer loop counter.
      mu = float(i) + 1.0 - log2(0.5 * log(r2));
      escaped = 1.0;
      break;
    }
  }

  vec3 col = mix(src, treat(src, floor(mu / 1.15)), escaped);
  gl_FragColor = vec4(mix(src, col, E), 1.0);
}
`;

// --- 2. VHS tracking ------------------------------------------------------
const VHS = `
void main() {
  float E = env();
  float t = u_time;
  vec2 uv = v_uv;

  // Occasional vertical roll.
  float rollT = floor(t * 0.5 + u_seed * 7.0);
  float roll = step(0.90, hash11(rollT)) * fract(t * 0.5);
  uv.y = fract(uv.y + roll * E);

  // Per-scanline-band horizontal displacement.
  float band = floor(uv.y * 90.0);
  float bn = hash21(vec2(band, floor(t * 14.0)));
  float jitter = step(0.93, bn) * (bn - 0.93) * 14.0 * 0.06 * E;
  float fine = (hash21(vec2(band, floor(t * 30.0))) - 0.5) * 0.004 * E;
  uv.x += jitter + fine + sin(uv.y * 8.0 + t * 1.7) * 0.004 * E;

  vec2 tuv = coverUV(uv);
  float split = (0.005 + 0.012 * step(0.93, bn)) * E;
  vec3 col = vec3(sampleRGB(tuv + vec2(split, 0.0)).r,
                  sampleRGB(tuv).g,
                  sampleRGB(tuv - vec2(split, 0.0)).b);

  // Slight tape colour bleed and desaturation.
  col = mix(col, vec3(luma(col)) * vec3(1.05, 1.0, 0.95), 0.18 * E);

  float scan = 0.86 + 0.14 * sin(v_uv.y * u_resolution.y * 1.2 + t * 40.0);
  col *= mix(1.0, scan, 0.5 * E);

  float grain = hash21(v_uv * u_resolution + fract(t) * 133.0);
  col += (grain - 0.5) * 0.10 * E;

  // Head-switching noise strip along the bottom edge.
  float strip = smoothstep(0.035, 0.0, v_uv.y) * step(0.55, hash11(floor(t * 3.0) + u_seed));
  col = mix(col, vec3(grain), strip * 0.8 * E);

  float r = length(toCentred(v_uv) * vec2(1.05, 1.3));
  col *= 1.0 - 0.30 * E * pow(clamp(r, 0.0, 1.0), 2.2);

  gl_FragColor = vec4(col, 1.0);
}
`;

// --- 3. Kaleidoscope ------------------------------------------------------
const KALEIDO = `
// Folds within the artwork itself rather than across the screen, so the cover
// stays a clean panel on its surround while its contents become a mandala.
void main() {
  float E = env();
  vec2 uv = coverUV(v_uv);
  vec2 p = uv - 0.5;
  float t = u_time * 0.10 + u_seed * 13.0;

  float segs = floor(mix(4.0, 8.0, 0.5 + 0.5 * sin(t * 0.37)));
  float seg = TAU / segs;
  float a = atan(p.y, p.x) + t * 0.25;
  float r = length(p) * (0.90 + 0.12 * sin(t * 0.9));

  a = abs(mod(a, seg) - seg * 0.5);
  vec2 k = rot(t * 0.18) * vec2(cos(a), sin(a)) * r;

  float m = panelMask(uv) * E * 0.85;
  vec2 fuv = mix(uv, k + 0.5, m);

  vec3 col = sampleChroma(fuv, vec2(0.004, 0.0) * E);
  col = hueShift(col, (a * 0.25 + t * 0.12) * E);
  col *= 1.0 + 0.10 * E * sin(r * 26.0 - t * 3.0);

  gl_FragColor = vec4(col, 1.0);
}
`;

// --- 4. Datamosh blocks ---------------------------------------------------
//
// A feedback effect: it renders into a buffer that survives between frames.
//
// The whole artwork drifts along a flow field, live, every frame. On top of
// that, squares of assorted sizes spawn and grow, each claiming its area for
// one RGB channel permutation. Nothing fades and nothing pulses — a square
// simply overwrites whatever was under it, so the frame accumulates a mosaic
// of overlapping channel-swapped regions at many scales. About a third of the
// permutations are the identity, which hands a patch back to its true colours.
//
// What persists between frames is the permutation MAP, not the pixels: the
// buffer's alpha channel holds which swap applies where, and the colour is
// recomputed each frame from the moving artwork. Storing composited pixels
// instead would freeze every region until a stamp happened to land on it,
// which stops the picture reading as moving at all.
const DATAMOSH = `
// Only three octaves, sampled over a wide epsilon. The potential has to be
// SMOOTH: take the gradient of the full five-octave fbm over a small epsilon
// and the finest octaves dominate it, which marbles the artwork into
// turbulent filigree rather than drifting it.
float flowNoise(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int k = 0; k < 3; k++) {
    v += a * noise2(p);
    p = p * 2.0 + vec2(5.7, 2.3);
    a *= 0.5;
  }
  return v;
}

// A divergence-free drift taken as the curl of a noise potential, so the
// artwork shears and swirls instead of bunching up or tearing holes. Forward
// differences, so three potential samples rather than four.
//
// Because stamps persist, each square freezes the flow at the moment it landed.
// Neighbouring patches therefore disagree about where the image is, and that
// disagreement is the point — it is what real datamoshing looks like.
vec2 curlFlow(vec2 p) {
  vec2 drift = vec2(u_time * u_flow.y, u_time * -u_flow.y * 0.7);
  float e = 0.08;
  float n0 = flowNoise(p + drift);
  float nx = flowNoise(p + vec2(e, 0.0) + drift);
  float ny = flowNoise(p + vec2(0.0, e) + drift);

  vec2 f = vec2(ny - n0, -(nx - n0)) / e;
  return f / (1.0 + length(f));   // soft saturate: keeps relative speed, bounds it
}

vec3 permute(vec3 c, float w) {
  if (w < 0.5) return c;
  if (w < 1.5) return c.rbg;
  if (w < 2.5) return c.grb;
  if (w < 3.5) return c.gbr;
  if (w < 4.5) return c.brg;
  return c.bgr;
}

const int STAMPS = 12;

// The permutation id rides in the buffer's alpha channel. Six values spread
// across eight slots, so 8-bit rounding can never tip one into its neighbour.
float encodeId(float w) { return (w + 0.5) / 8.0; }
float decodeId(float a) { return floor(a * 8.0); }

void main() {
  float E = env();
  vec2 uv = coverUV(v_uv);

  // Fade the flow out toward the panel edge, so the cover stays a crisp
  // rectangle on its surround while its contents move inside it.
  float inset = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  float atten = smoothstep(0.0, 0.14, inset);

  vec2 flow = curlFlow(uv * 1.6) * u_flow.x * atten * E;
  vec3 src = sampleRGB(uv + flow);   // the moving artwork, resampled every frame

  // Nothing claimed yet, or the effect has not faded in: show the art as-is.
  if (u_reset > 0.5 || E < 0.02) {
    gl_FragColor = vec4(src, encodeId(0.0));
    return;
  }

  float id = decodeId(texture2D(u_prev, v_uv).a);
  vec2 p = toCentred(v_uv);

  for (int i = 0; i < STAMPS; i++) {
    float fi = float(i);

    // Each slot respawns on its own period, so they never march in step.
    float period = mix(1.5, 0.5, hash11(fi * 3.7 + u_seed));
    float phase = u_time / period + fi * 0.37;
    vec2 key = vec2(floor(phase), fi * 17.0 + u_seed * 91.0);
    float life = fract(phase);

    vec2 c = (hash22(key) - 0.5) * vec2(screenAspect() * 1.04, 1.04);

    // Sizes biased small so big squares stay occasional events.
    float full = mix(0.05, 0.62, pow(hash21(key + 3.1), 2.2)) * E;
    float size = full * (0.18 + 0.82 * smoothstep(0.0, 0.55, life));

    vec2 d = abs(p - c);
    float inside = step(max(d.x, d.y), size * 0.5);

    float pick = hash21(key + 7.7);
    float which = (pick < 0.34) ? 0.0 : min(5.0, floor(1.0 + (pick - 0.34) / 0.66 * 5.0));

    id = mix(id, which, inside);
  }

  gl_FragColor = vec4(permute(src, id), encodeId(id));
}
`;

// --- 5. Ripple caustics ---------------------------------------------------
const RIPPLE = `
void main() {
  float E = env();
  vec2 p = toCentred(v_uv);
  float t = u_time * 0.9 + u_seed * 17.0;

  float h = 0.0;
  vec2 grad = vec2(0.0);
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    vec2 c = 0.42 * vec2(sin(t * 0.21 + fi * 2.1), cos(t * 0.17 + fi * 1.3));
    vec2 d = p - c;
    float r = length(d) + 1e-4;
    float phase = r * 17.0 - t * 2.0 + fi * 1.9;
    float fall = exp(-r * 1.3);
    h += sin(phase) * fall;
    grad += (d / r) * cos(phase) * 17.0 * fall;
  }

  vec2 refr = grad * 0.00045 * E;
  vec2 uv = coverUV(v_uv + refr);
  vec3 col = sampleChroma(uv, refr * 0.5);

  col += pow(max(h, 0.0) * 0.5, 3.0) * 0.20 * E * vec3(0.70, 0.85, 1.0);
  col *= 1.0 + 0.09 * E * h;

  gl_FragColor = vec4(col, 1.0);
}
`;

// --- 6. Droste tunnel -----------------------------------------------------
const DROSTE = `
// The cover contains successively smaller, slowly rotating copies of itself.
void main() {
  float E = env();
  vec2 uv = coverUV(v_uv);
  vec2 p = uv - 0.5;
  float t = u_time * 0.08 + u_seed * 11.0;
  float m = panelMask(uv) * E;

  vec3 col = sampleRGB(uv);
  for (int i = 1; i < 4; i++) {
    float fi = float(i);
    float sc = pow(0.56, fi) * (1.0 + 0.10 * sin(t * 2.0 + fi));
    vec2 q = rot(t * 0.30 * fi * m) * p / mix(1.0, sc, m);

    float edge = max(abs(q.x), abs(q.y));
    float inside = 1.0 - smoothstep(0.492, 0.5, edge);

    vec3 c = hueShift(sampleRGB(q + 0.5), fi * 0.35 * m);
    col = mix(col, c, inside * m * 0.88);
  }

  col *= 1.0 - 0.25 * E * smoothstep(0.30, 0.90, length(toCentred(v_uv)));

  gl_FragColor = vec4(col, 1.0);
}
`;

// --- 7. Halftone duotone --------------------------------------------------
const HALFTONE = `
void main() {
  float E = env();
  vec2 uv = coverUV(v_uv);
  vec3 src = sampleRGB(uv);
  float t = u_time * 0.25 + u_seed * 5.0;

  // Cell size follows the render height so the dots read the same on any
  // display instead of vanishing on a high-DPI one.
  float cell = u_resolution.y / mix(80.0, 165.0, 0.5 + 0.5 * sin(t * 0.5));
  vec2 g = rot(t * 0.35) * (v_uv * u_resolution) / cell;
  float d = length(fract(g) - 0.5) * 2.0;

  float l = luma(src);
  // Dot radius grows with brightness, with a hard edge for a screen-print look.
  float ink = smoothstep(d - 0.10, d + 0.10, l * 1.5 - 0.05 + 0.06 * sin(t * 2.0));

  vec3 dark  = mix(vec3(0.04, 0.03, 0.09), src * 0.30, 0.30);
  vec3 light = mix(vec3(1.00, 0.94, 0.82), src * 1.15 + 0.20, 0.35);
  vec3 ht = mix(dark, light, ink);

  vec3 post = floor(src * 4.0 + 0.5) / 4.0;
  vec3 col = mix(src, mix(post, ht, 0.80), E);

  gl_FragColor = vec4(col, 1.0);
}
`;

// --- 8. Slit-scan smear ---------------------------------------------------
const SLITSCAN = `
void main() {
  float E = env();

  // One cycle smears all the way out and all the way back. A raised cosine
  // rather than a sawtooth, so the frame unwinds to the original instead of
  // snapping to it, and the turnaround at full smear has zero velocity.
  float cyc = u_time * 0.17 + u_seed * 4.0;
  float n = floor(cyc);
  float ramp = 0.5 - 0.5 * cos(fract(cyc) * TAU);

  // Axis and direction are drawn once per cycle, so they only ever change at
  // the instant the smear is fully undone and the switch is invisible.
  float horiz = step(0.5, hash11(n + u_seed * 13.0));
  float dir = (hash11(n + 41.0) < 0.5) ? -1.0 : 1.0;

  float axis = mix(v_uv.y, v_uv.x, horiz);
  float lag = (axis - 0.5) * 1.6 * ramp * dir;

  vec3 col = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 5; i++) {
    float f = float(i) / 4.0;
    float d = lag * (0.35 + 0.65 * f) * 0.13 * E;
    vec2 o = mix(vec2(d, 0.0), vec2(0.0, d), horiz);
    float w = 1.0 - f * 0.55;
    col += sampleRGB(coverUV(v_uv + o)) * w;
    wsum += w;
  }
  col /= wsum;

  float sp = lag * 0.012 * E;
  vec2 so = mix(vec2(sp, 0.0), vec2(0.0, sp), horiz);
  col.r = sampleRGB(coverUV(v_uv + so)).r;
  col.b = sampleRGB(coverUV(v_uv - so)).b;

  col = mix(col, clamp((col - 0.5) * 1.22 + 0.5, 0.0, 1.0), 0.55 * E);

  gl_FragColor = vec4(col, 1.0);
}
`;

/** name -> full fragment shader source. Order defines the `?fx=N` indices. */
export const EFFECTS = {
  julia:    PRELUDE + JULIA,
  vhs:      PRELUDE + VHS,
  kaleido:  PRELUDE + KALEIDO,
  datamosh: PRELUDE + DATAMOSH,
  ripple:   PRELUDE + RIPPLE,
  droste:   PRELUDE + DROSTE,
  halftone: PRELUDE + HALFTONE,
  slitscan: PRELUDE + SLITSCAN,
};

export const EFFECT_NAMES = Object.keys(EFFECTS);

/**
 * Effects that render into a buffer surviving between frames. They receive
 * `u_prev` and `u_reset`, and the framing is held still for them so old
 * content stays registered with new.
 */
export const FEEDBACK_EFFECTS = new Set(['datamosh']);
