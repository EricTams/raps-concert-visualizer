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
//   u_dt         seconds since the previous frame
// ---------------------------------------------------------------------------

import { MAX_TRACKS } from './chamber.js';

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

// Seconds since the previous frame. Feedback effects need it: anything that
// decays has to decay per second, not per frame, or its timing changes with
// the frame rate and with the adaptive render scale.
uniform float u_dt;

// Feedback effects only: last frame's output, and a flag that says to ignore it
// and start clean (first frame of a slot, or after a resize).
uniform sampler2D u_prev;
uniform float u_reset;

// Datamosh flow field: (amount, speed). See DATAMOSH_FLOW in config.js.
uniform vec2 u_flow;

// Julia effect: (c.x, c.y, centre.x, centre.y) and (view width, zoom phase).
// Both are solved on the CPU — see src/julia.js.
uniform vec4 u_julia;
uniform vec2 u_juliaView;

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
// Deep in the zoom, points near the boundary take many iterations to escape.
// Too low a cap and they are mistaken for interior and left untouched, which
// eats exactly the filigree the zoom exists to show.
const int ITER = 96;

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

  // The constant and the point to zoom at are both solved on the CPU: the
  // target is a genuine point of the Julia set, found by inverse iteration, so
  // the view is always aimed at boundary structure rather than at whatever
  // happens to be at some fixed coordinate. See src/julia.js.
  vec2 c = u_julia.xy;
  vec2 z = (uv - 0.5) * u_juliaView.x + u_julia.zw;

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

  // Escape times are low and change slowly at the wide end of the zoom, which
  // on its own gives a few enormous flat bands and a very mild frame. Narrow
  // the bands as the view widens so the density of structure on screen stays
  // roughly constant across the whole zoom cycle.
  float bandWidth = mix(0.55, 1.6, u_juliaView.y);
  float phase = mu / bandWidth;

  vec3 col = treat(src, floor(phase));

  // A continuous grade under the discrete bands, driven by the same escape
  // count. The bands give hard fractal edges; this gives the smooth colour
  // flow between them that makes the contours read as depth rather than as
  // flat stencils. Hue turns through the escape count and brightness swells
  // within each band, so the two structures reinforce rather than fight.
  col = hueShift(col, sin(phase * 0.5 + u_time * 0.25) * 0.55);
  col *= 0.86 + 0.28 * fract(phase);

  col = mix(src, col, escaped);
  gl_FragColor = vec4(mix(src, clamp(col, 0.0, 1.0), E), 1.0);
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
// one RGB channel swap. Nothing fades and nothing pulses — a square simply
// overwrites whatever was under it, so the frame accumulates a mosaic of
// overlapping channel-swapped regions at many scales. About a third of the
// swaps are the identity, which hands a patch back to its true colours.
//
// A swap is a rearrangement plus an inversion mask: a channel can land in its
// new slot as itself or as its own complement, so 200 red arriving in green
// reads as either 200 or 55. That is the difference between a swap that only
// ever recolours and one that can also flip a region into negative.
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

// An id is a rearrangement in the high bits and a three-bit inversion mask in
// the low three: id / 8 is which channel goes where, and the bottom three bits
// say which of the destination channels arrive complemented.
vec3 permute(vec3 c, float id) {
  float w = floor(id / 8.0);
  vec3 s = c;
  if      (w < 1.5) s = (w < 0.5) ? c : c.rbg;
  else if (w < 3.5) s = (w < 2.5) ? c.grb : c.gbr;
  else              s = (w < 4.5) ? c.brg : c.bgr;

  // Complement after the rearrange, so a set bit names the channel you SEE
  // inverted rather than the one it was taken from.
  vec3 flip = mod(floor(id / vec3(1.0, 2.0, 4.0)), 2.0);
  return mix(s, 1.0 - s, flip);
}

// How many squares exist at once. With the respawn period below, this is also
// what sets how fast the mosaic accumulates — every slot that ends starts a new
// square somewhere, and nothing ever un-claims an area except a later square
// landing on it. Fewer slots on longer periods means the artwork underneath
// stays readable for longer before the blocks have covered it.
const int STAMPS = 9;

// How often each destination channel arrives as its complement. Independent
// per channel, so this is also what makes a full negative — all three flipped
// at once — the rare corner: at 0.35 roughly one swap in twenty-three, against
// better than one in four that flips nothing. Worth keeping low. A negative
// block is bright wherever the artwork is dark, and on a mostly-black cover a
// big one is a white flash in the audience's eyes rather than an effect.
const float FLIP_CHANCE = 0.35;

// The id rides in the buffer's alpha channel: six rearrangements times eight
// masks is 48 values, spread across 64 slots so 8-bit rounding can never tip
// one into its neighbour.
float encodeId(float w) { return (w + 0.5) / 64.0; }
float decodeId(float a) { return floor(a * 64.0); }

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
    float period = mix(2.6, 1.0, hash11(fi * 3.7 + u_seed));
    float phase = u_time / period + fi * 0.37;
    vec2 key = vec2(floor(phase), fi * 17.0 + u_seed * 91.0);
    float life = fract(phase);

    vec2 c = (hash22(key) - 0.5) * vec2(screenAspect() * 1.04, 1.04);

    // Sizes biased small so big squares stay occasional events.
    float full = mix(0.05, 0.62, pow(hash21(key + 3.1), 2.2)) * E;
    // Growth is a fraction of the slot's own period, so a square spends most of
    // its life opening rather than sitting at full size. That reads as an edge
    // creeping outward — the thing you actually watch — instead of a block that
    // is simply there by the time you look at it.
    float size = full * (0.18 + 0.82 * smoothstep(0.0, 0.72, life));

    vec2 d = abs(p - c);
    float inside = step(max(d.x, d.y), size * 0.5);

    float pick = hash21(key + 7.7);
    float perm = (pick < 0.34) ? 0.0 : min(5.0, floor(1.0 + (pick - 0.34) / 0.66 * 5.0));

    // Each destination channel decides on its own whether to arrive inverted.
    // The identity is exempt: it is the effect's rest state, the thing that
    // hands a patch back to the real artwork, and a patch that comes back
    // negative has not been handed back.
    vec3 roll = vec3(hash22(key + 5.3), hash21(key + 11.9));
    vec3 flip = step(roll, vec3(FLIP_CHANCE)) * step(0.5, perm);
    float which = perm * 8.0 + dot(flip, vec3(1.0, 2.0, 4.0));

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
//
// The cover contains a smaller copy of itself, which contains a smaller copy,
// without end — and the view magnifies continuously through it.
//
// Over one loop the view grows by exactly the nesting ratio, at which point
// every copy has grown into the place of the one outside it and the frame is
// identical to where it started. So the zoom runs forever with no cut, no
// reset and no seam.
//
// This is the one effect that abandons the framing the rest of the show keeps.
// There is no contained square and no blurred surround: the outermost copy is
// magnified until it covers the whole frame, and the recursion runs edge to
// edge. Fitting the cover inside a panel leaves the nesting as a small detail
// in the middle of the screen, which is what made this read as mild, and the
// blurred bars are only there to fill space a full-bleed image does not leave.
const DROSTE = `
// The recursion has to be truncated somewhere. Rather than burying the seam
// under levels too small to see — at this ratio the ninth is already eighteen
// pixels wide and the eleventh is five — the innermost copy fades in as it
// grows, so the loop closes exactly and nine levels is plenty.
const int LEVELS = 9;
const float RATIO = 0.52;      // each nested copy, relative to its parent
// Standing magnification. Sized so the outermost copy covers the whole 16:9
// frame even at the widest point of the loop and even at full spin and drift —
// otherwise the corners fall outside the artwork and the dimmed surround
// creeps back in as dark wedges, which is exactly what this mode is avoiding.
const float BASE_ZOOM = 2.20;
const float LOOP = 15.0;       // seconds to magnify by exactly 1 / RATIO
const float TWIST = 0.22;      // radians of rotation per level
const float HUE_STEP = 0.30;   // hue turn per level

// Independent breathing periods, in seconds, deliberately sharing no common
// factor — so the motions drift in and out of phase with one another and the
// composition never settles into a recognisable repeat.
//
// These are all GLOBAL: they move the whole nested stack together. Anything
// that varied per level would have to stay locked to k to keep the recursion
// seamless, but a motion applied to every level at once is free to breathe
// however it likes, because it cannot disturb the level-index handover.
const float BREATH_ZOOM  = 23.0;
const float BREATH_SPIN  = 37.0;
const float BREATH_DRIFTX = 29.0;
const float BREATH_DRIFTY = 43.0;

void main() {
  float E = env();
  vec2 uv = coverUV(v_uv);
  vec3 src = sampleRGB(uv);
  float sd = u_seed * TAU;

  // Zoom phase. The warp term is periodic over the loop and vanishes at both
  // ends, so the push-in surges and eases within each pass while still
  // advancing exactly one level per loop — which is what keeps it seamless.
  // Its depth is itself modulated, so no two passes surge the same way.
  float f = fract(u_time / LOOP + u_seed);
  float zt = f + 0.13 * sin(f * TAU)
                * (0.6 + 0.4 * sin(u_time / BREATH_ZOOM * TAU + sd));

  // Spin and drift of the whole tunnel, each on its own clock.
  // Kept modest: every extra degree of spin and unit of drift pushes the frame
  // corners further out, and BASE_ZOOM has to grow to match, which costs
  // resolution in the artwork for motion nobody asked for.
  float spin = 0.18 * sin(u_time / BREATH_SPIN * TAU + sd);
  vec2 drift = 0.040 * vec2(sin(u_time / BREATH_DRIFTX * TAU + sd),
                            cos(u_time / BREATH_DRIFTY * TAU + sd * 1.7));

  vec2 p = rot(spin) * (uv - 0.5) + drift;

  // One pow, then step down by RATIO per level, rather than a pow per level.
  float s = pow(1.0 / RATIO, zt) * BASE_ZOOM;

  vec3 dro = src;
  for (int i = 0; i < LEVELS; i++) {
    // The level index shifts by one over a loop, so everything that varies per
    // level is driven by (i - zt) rather than by i. That is what closes the
    // loop: at zt = 1 each level holds exactly the scale, angle and hue its
    // outer neighbour held at zt = 0.
    float k = float(i) - zt;

    vec2 q = rot(TWIST * k) * p / s;
    float edge = max(abs(q.x), abs(q.y));

    // Depth arrives a level at a time as the effect comes up, so it grows into
    // the recursion instead of snapping to full depth the moment the envelope
    // opens. Keyed on k, not i, so it stays seamless during the ramp.
    // Fade the innermost copy in as it grows. This is what actually closes the
    // loop rather than hiding its failure to close: at the wrap the deepest
    // level sits at zero opacity, which is an exact match for the nothing that
    // was there the frame before. Keyed on k, so it is seamless by
    // construction instead of by being too small to notice.
    float deepFade = 1.0 - smoothstep(float(LEVELS) - 2.0, float(LEVELS) - 1.0, k);

    float inside = (1.0 - smoothstep(0.487, 0.5, edge))
                 * smoothstep(0.0, 0.35, E - max(0.0, k) * 0.055)
                 * deepFade;

    // Skip the fetches entirely for any pixel this copy does not cover. A
    // fragment shader runs the whole loop for every pixel, so without this the
    // innermost copies — a few dozen pixels each — are charged for the entire
    // screen, and each extra level of depth costs as much as the first.
    // Neighbouring fragments are almost always on the same side of a copy's
    // edge, so the branch is coherent and effectively free.
    if (inside > 0.0) {
      // Deep copies are minified brutally: the whole cover squeezed into a few
      // dozen pixels and resampled with no mip chain, which fizzes as it moves.
      // Below a threshold, read the small pre-blurred copy instead. It is
      // already about the right size, so the only visible difference at that
      // scale is that it stops sparkling.
      vec3 c = mix(sampleRGB(q + 0.5),
                   texture2D(u_bg, clamp(q + 0.5, 0.0, 1.0)).rgb,
                   1.0 - smoothstep(0.02, 0.07, s));
      c = hueShift(c, HUE_STEP * k);
      c *= clamp(1.0 - 0.06 * k, 0.6, 1.0);   // each copy a touch deeper in shadow
      dro = mix(dro, c, inside);
    }
    s *= RATIO;
  }

  dro *= 1.0 - 0.22 * smoothstep(0.35, 0.95, length(toCentred(v_uv)));

  // No panel mask: this one runs to the edges of the screen.
  gl_FragColor = vec4(mix(src, dro, E), 1.0);
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
  // display instead of vanishing on a high-DPI one. The count is what breathes,
  // and it swings a long way: at the coarse end the dots are big enough to read
  // as a pattern in their own right rather than as a texture on the artwork.
  float cell = u_resolution.y / mix(22.0, 165.0, 0.5 + 0.5 * sin(t * 0.5));
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

// --- 9. Bubble chamber ----------------------------------------------------
//
// The cover art as the illuminated volume of a particle detector, with charged
// particles crossing it and dragging the picture along behind them.
//
// The physics is on the CPU, in src/chamber.js — a real simulation, with a
// magnetic field bending each path, ionisation bleeding momentum away until the
// path winds up into a spiral, multiple scattering roughening it, delta rays
// flicking off the stiff tracks, unstable particles coming apart in flight, and
// pairs launched on arcs that put them at the same point at the same moment.
// Per frame the shader is handed one short segment per particle. That is all it
// knows: it has never seen a trajectory.
//
// THE FEEDBACK BUFFER DOES NOT HOLD A PICTURE. It holds a distortion field —
// how far the artwork is dragged at each pixel, which way its hue is turned,
// and how much track has been laid down there:
//
//   rg  displacement, signed, +/- DISP
//   b   the hue of the track that last marked this pixel
//   a   exposure: how hard it was marked
//
// Two passes. The first one is the chamber: it decays the field toward zero and
// lets the particles write into it. The second is the camera: it samples the
// UNTOUCHED artwork through the field and produces the frame. So the picture is
// never fed back into itself and never degrades — resample a stored image every
// frame for a minute and it turns to mush, however carefully you do it. Here
// the only thing that accumulates is the distortion, and the only thing that
// heals is the distortion.
//
// Which makes the self-healing exact rather than approximate. The field decays
// on two timescales — the smear slides back into register over a few seconds,
// the coloured track fades over ten — and when it reaches zero the frame is the
// clean cover again, pixel for pixel, because it always was.
const CHAMBER_CONST = `
// Filled by the CPU simulation. Slot i holds the piece of track particle i
// covered during THIS frame, in centred space.
uniform vec4 u_tracks[${MAX_TRACKS}];      // (ax, ay, bx, by)
uniform vec4 u_trackStyle[${MAX_TRACKS}];  // (hue, halfWidth, ionisation, -)
                                           // halfWidth 0 = empty slot

const float DISP  = 0.055;  // full-scale displacement the rg channels encode
const float TURN  = 1.1;    // radians of hue rotation at full exposure
const float LIFT  = 1.05;   // how far a track brightens or darkens what it crossed

const float HEAL_SMEAR = 5.5;   // seconds for the artwork to slide back into place
const float HEAL_TRACK = 11.0;  // seconds for the coloured track to fade out

const float DRAG  = 0.85;   // how much of its own motion a particle lends the plate
const float REACH = 2.2;    // width of the wake, in track widths

const float FID_PITCH = 0.1075;   // spacing of the fiducial crosses
const float FID_ARM   = 0.0092;   // half-length of one arm

float segDist(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-9), 0.0, 1.0);
  return length(pa - ba * h);
}

// Saturated false colour for a track, from its hue in turns. Bubble chamber
// plates are black and white; the colour on the famous prints was added
// afterwards, one hue per track, so you could tell them apart.
vec3 trackTint(float h) {
  vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return mix(vec3(1.0), k, 0.88);
}

// How far into the cover panel this pixel sits. The chamber's liquid is the
// artwork: let the drag reach the panel edge and it hauls the picture out over
// the surround, and the cover stops being a framed picture at all.
float insetHold(vec2 cuv) {
  float inset = min(min(cuv.x, 1.0 - cuv.x), min(cuv.y, 1.0 - cuv.y));
  return smoothstep(0.0, 0.09, inset);
}
`;

// Pass 1 — the chamber. Decays the field, then lets the particles write into it.
// Never reads the artwork at all.
const CHAMBER = CHAMBER_CONST + `
void main() {
  float E = env();
  float px = 1.0 / u_resolution.y;
  vec2 p = toCentred(v_uv);

  // A field of nothing: no displacement, no exposure.
  if (u_reset > 0.5) { gl_FragColor = vec4(0.5, 0.5, 0.5, 0.0); return; }

  vec4 f = texture2D(u_prev, v_uv);
  vec2 disp = (f.rg - 0.5) * (2.0 * DISP);
  float hue = f.b;
  float expo = f.a;

  // The healing. Everything the chamber does to the plate is undone at these
  // two rates, always, whether or not anything is happening on top.
  disp *= exp(-u_dt / HEAL_SMEAR);
  expo *= exp(-u_dt / HEAL_TRACK);

  vec2 cuv = coverUV(v_uv);
  float held = insetHold(cuv);
  // Tracks cross the whole frame and still register out on the surround, but
  // only the liquid inside the chamber gets stirred.
  float lit = mix(0.45, 1.0, panelMask(cuv)) * E;

  for (int i = 0; i < ${MAX_TRACKS}; i++) {
    vec4 st = u_trackStyle[i];
    if (st.y > 0.0) {
      vec4 sg = u_tracks[i];
      float w = max(st.y, px * 0.85);
      float d = segDist(p, sg.xy, sg.zw);

      // A particle does not draw on the plate, it drags it. Each frame this
      // pixel takes up the distance the particle actually travelled, scaled by
      // how close it passed — so the artwork accumulates exactly as much
      // displacement as the time it spent underneath the thing dragging it.
      float grip = exp(-d / (w * REACH));
      disp += (sg.zw - sg.xy) * grip * DRAG * E * held;

      // Beading: a track is a string of bubbles, not a line. Hashed on screen
      // position rather than on distance along the track, so it stays put in
      // the frame as the particle draws through it — and on a grid that scales
      // with the track, so the beads always read as beads instead of turning
      // into a fixed mosaic wherever a curl tightens below the cell size.
      float cell = hash21(floor(p / (w * 2.2)));
      float bubbles = 0.62 + 0.38 * smoothstep(0.26, 0.44, cell);
      float cov = (1.0 - smoothstep(w * 0.6, w * 1.35, d)) * bubbles;
      float mark = max(cov, grip * 0.55) * lit;

      // The hue channel is not a quantity and does not decay — it only records
      // whose track this is, and stops mattering once the exposure fades.
      hue = mix(hue, fract(st.x), clamp(mark * mark * 1.7, 0.0, 1.0));
      expo = max(expo, mark * (0.64 + 0.36 * st.z));
    }
  }

  disp = clamp(disp, -DISP, DISP);

  // Half a bit of dither. Without it the exponential heal stalls: an 8-bit
  // value multiplied by 0.998 rounds straight back to itself, so the plate
  // would keep every track forever. Gated on there being something to decay,
  // which leaves untouched artwork perfectly still and makes zero an absorbing
  // state rather than something the noise wanders around.
  float act = clamp(255.0 * max(expo, length(disp) / DISP), 0.0, 1.0);
  float dither = (hash21(v_uv * u_resolution + fract(u_time) * 137.0) - 0.5) / 255.0 * act;

  gl_FragColor = clamp(vec4(disp / (2.0 * DISP) + 0.5, hue, expo) + dither, 0.0, 1.0);
}
`;

// Pass 2 — the camera. Reads the field and samples the untouched artwork
// through it. Nothing here is ever fed back.
const CHAMBER_RESOLVE = CHAMBER_CONST + `
uniform sampler2D u_src;

// Fiducial crosses, etched on the chamber window. Every real chamber has a grid
// of them: they are the reference the tracks get measured against when the
// plate is scanned, and they are the detail that says apparatus rather than
// wallpaper. They are part of the picture, so they smear with everything else.
float fiducials(vec2 p, float px) {
  vec2 f = abs(fract(p / FID_PITCH + 0.5) - 0.5) * FID_PITCH;
  float th = max(0.0010, px);
  float a = (1.0 - smoothstep(th, th + px, f.x)) * (1.0 - smoothstep(FID_ARM, FID_ARM + px, f.y));
  float b = (1.0 - smoothstep(th, th + px, f.y)) * (1.0 - smoothstep(FID_ARM, FID_ARM + px, f.x));
  return max(a, b);
}

// The clean plate: what the frame is when the field has healed to nothing.
vec3 plate(vec2 uv, float px, float E) {
  vec2 cuv = coverUV(uv);
  vec3 art = sampleRGB(cuv);

  // Flatten the artwork slightly, so a thin coloured track still reads across a
  // busy cover instead of disappearing into it.
  art = mix(art, mix(art, vec3(luma(art)), 0.20) * 0.90 + 0.04, 0.38 * E);

  // Dark on light art, light on dark, so the crosses never vanish.
  float f = fiducials(toCentred(uv), px) * panelMask(cuv);
  vec3 mark = luma(art) > 0.42 ? vec3(0.06) : vec3(0.80);
  art = mix(art, mark, f * 0.34 * E);

  return art * (1.0 - 0.24 * smoothstep(0.32, 0.95, length(toCentred(uv))));
}

void main() {
  float E = env();
  float px = 1.0 / u_resolution.y;

  vec4 f = texture2D(u_src, v_uv);
  vec2 disp = (f.rg - 0.5) * (2.0 * DISP);
  float hue = f.b;
  float expo = f.a;

  vec2 duv = disp / vec2(screenAspect(), 1.0);

  // A smudge, not a slide. Average the artwork all the way along the
  // displacement instead of only at its far end, so the picture is pulled AND
  // blurred along the track the way wet ink goes under a finger — and so the
  // wake tapers into undisturbed cover instead of ending on a hard edge.
  vec3 art;
  if (length(duv) > px) {
    art = vec3(0.0);
    float wsum = 0.0;
    for (int k = 0; k < 5; k++) {
      float t = float(k) / 4.0;
      float wgt = 1.0 - 0.5 * t;
      art += plate(v_uv - duv * t, px, E) * wgt;
      wsum += wgt;
    }
    art /= wsum;
  } else {
    art = plate(v_uv, px, E);
  }

  // The stain. Each track turns the hue of what it passed over in the direction
  // its own false colour sits on the wheel, as far as its exposure took it.
  art = hueShift(art, (hue - 0.5) * (2.0 * TURN) * expo);
  art = clamp(mix(vec3(luma(art)), art, 1.0 + 0.5 * expo), 0.0, 1.0);

  // And lifts or sinks it. Hue alone reads as a plate someone tinted; a track
  // that also darkens or brightens what it crossed reads as one that was
  // exposed. Driven off a different harmonic of the same hue, so which way a
  // track goes is not predictable from its colour.
  float lift = LIFT * sin((hue + 0.17) * TAU * 2.0) * expo;
  art = clamp(art * (1.0 + lift) + 0.07 * lift, 0.0, 1.0);

  vec3 tint = trackTint(hue);

  // The bubbles themselves are the top end of the same exposure. Still the
  // artwork underneath — but a bubble scatters the flash straight back at the
  // camera, so the line reads bright even where the cover behind it is black.
  float bead = smoothstep(0.44, 0.86, expo);
  art = mix(art, clamp(art * 1.3 + tint * 0.13, 0.0, 1.0), bead);
  art = clamp(art + tint * expo * expo * 0.04, 0.0, 1.0);

  gl_FragColor = vec4(art, 1.0);
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
  chamber:  PRELUDE + CHAMBER,
};

export const EFFECT_NAMES = Object.keys(EFFECTS);

/**
 * Effects that render into a buffer surviving between frames. They receive
 * `u_prev` and `u_reset`, and the framing is held still for them so old
 * content stays registered with new.
 */
export const FEEDBACK_EFFECTS = new Set(['datamosh', 'chamber']);

/**
 * Feedback effects whose buffer holds something that is not an image.
 *
 * The default handling copies the buffer straight to the screen, which only
 * works because datamosh's buffer happens to be the frame. `chamber` stores a
 * distortion field instead, so it needs a second pass to turn that field into
 * a picture — given here, and run in place of the copy. It is handed the field
 * as `u_src` along with every uniform the effect itself gets.
 */
export const RESOLVE_EFFECTS = {
  chamber: PRELUDE + CHAMBER_RESOLVE,
};
