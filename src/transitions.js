// ---------------------------------------------------------------------------
// The transition library.
//
// Each transition composites two already-rendered effect frames.
//
// Uniforms:
//   u_from, u_to   the outgoing and incoming effect frames
//   u_t            0 -> 1 across the transition
//   u_resolution   render target size in pixels
//   u_time, u_seed continuity with the effects
// ---------------------------------------------------------------------------

const PRELUDE = `
precision highp float;

varying vec2 v_uv;

uniform sampler2D u_from;
uniform sampler2D u_to;
uniform float u_t;
uniform vec2  u_resolution;
uniform float u_time;
uniform float u_seed;

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float noise2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i),                  hash21(i + vec2(1.0, 0.0)), u.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int k = 0; k < 4; k++) {
    v += a * noise2(p);
    p = p * 2.03 + vec2(11.7, 3.9);
    a *= 0.5;
  }
  return v;
}

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }

vec2 toCentred(vec2 uv) {
  return (uv - 0.5) * vec2(u_resolution.x / max(u_resolution.y, 1.0), 1.0);
}
vec2 fromCentred(vec2 p) {
  return p / vec2(u_resolution.x / max(u_resolution.y, 1.0), 1.0) + 0.5;
}

vec3 fromC(vec2 uv) { return texture2D(u_from, clamp(uv, 0.0, 1.0)).rgb; }
vec3 toC(vec2 uv)   { return texture2D(u_to,   clamp(uv, 0.0, 1.0)).rgb; }
`;

// --- Noise melt: an FBM-threshold dissolve with a pull toward the seam ------
const MELT = `
void main() {
  float n = fbm(v_uv * 4.0 + u_seed * 20.0);
  float t = u_t * 1.4 - 0.2;
  float e = smoothstep(n - 0.22, n + 0.22, t);

  // Both sides drag toward the dissolve front, so it melts rather than fades.
  float seam = 1.0 - abs(e * 2.0 - 1.0);
  vec2 pull = (vec2(fbm(v_uv * 6.0 + 3.1), fbm(v_uv * 6.0 + 9.7)) - 0.5) * 0.09 * seam;

  vec3 a = fromC(v_uv + pull);
  vec3 b = toC(v_uv - pull);
  vec3 col = mix(a, b, e);

  col += seam * 0.10 * vec3(0.9, 0.95, 1.0);
  gl_FragColor = vec4(col, 1.0);
}
`;

// --- Glitch tear: block rows shear apart, RGB splits, then it snaps together -
const TEAR = `
void main() {
  float t = u_t;
  float burst = sin(t * 3.14159265);          // peaks mid-transition
  float rowH = mix(90.0, 22.0, burst);
  float row = floor(v_uv.y * rowH);
  float tick = floor(u_time * 22.0);

  float h = hash21(vec2(row, tick + u_seed * 31.0));
  float shear = (h - 0.5) * 0.35 * burst * step(0.35, h + burst * 0.4);

  vec2 ua = v_uv + vec2(shear, 0.0);
  vec2 ub = v_uv - vec2(shear * 0.7, 0.0);

  float split = 0.012 * burst;
  vec3 a = vec3(fromC(ua + vec2(split, 0.0)).r, fromC(ua).g, fromC(ua - vec2(split, 0.0)).b);
  vec3 b = vec3(toC(ub - vec2(split, 0.0)).r,   toC(ub).g,   toC(ub + vec2(split, 0.0)).b);

  // Per-row cut rather than a uniform fade: rows flip over at staggered times.
  float rowT = clamp((t - hash21(vec2(row, u_seed * 7.0)) * 0.55) / 0.45, 0.0, 1.0);
  vec3 col = mix(a, b, smoothstep(0.0, 1.0, rowT));

  col += burst * 0.18 * (hash21(v_uv * u_resolution + tick) - 0.5);
  col = mix(col, vec3(luma(col)), burst * 0.25);

  gl_FragColor = vec4(col, 1.0);
}
`;

// --- Spin collapse: outgoing spins away, incoming spins in ------------------
const SPIN = `
void main() {
  float t = smoothstep(0.0, 1.0, u_t);
  vec2 p = toCentred(v_uv);

  float za = mix(1.0, 2.6, t);
  vec2 pa = rot(t * 2.4) * p * za;
  vec3 a = fromC(fromCentred(pa));

  float zb = mix(0.35, 1.0, t);
  vec2 pb = rot((t - 1.0) * 2.0) * p * zb;
  vec3 b = toC(fromCentred(pb));

  float col_t = smoothstep(0.25, 0.85, t);
  vec3 col = mix(a, b, col_t);

  // Bright pinch at the crossover.
  float flash = 1.0 - abs(t * 2.0 - 1.0);
  col += pow(flash, 2.5) * 0.22;
  col *= 1.0 - 0.30 * flash * smoothstep(0.2, 1.0, length(p));

  gl_FragColor = vec4(col, 1.0);
}
`;

// --- Luma wipe: the outgoing frame dissolves brightest-first ----------------
const LUMAWIPE = `
void main() {
  vec3 a = fromC(v_uv);
  vec3 b = toC(v_uv);

  float l = luma(a);
  l = mix(l, 1.0 - l, step(0.5, hash21(vec2(u_seed, 3.7))));  // sometimes darkest-first
  l += (fbm(v_uv * 7.0 + u_seed * 12.0) - 0.5) * 0.25;        // break up the banding

  float t = u_t * 1.5 - 0.25;
  float e = smoothstep(l - 0.20, l + 0.20, t);

  vec3 col = mix(a, b, e);
  float seam = 1.0 - abs(e * 2.0 - 1.0);
  col = mix(col, col + vec3(0.35, 0.28, 0.18) * seam, 0.8);

  gl_FragColor = vec4(col, 1.0);
}
`;

export const TRANSITIONS = {
  melt:     PRELUDE + MELT,
  tear:     PRELUDE + TEAR,
  spin:     PRELUDE + SPIN,
  lumawipe: PRELUDE + LUMAWIPE,
};

/** Which transition leads into each effect. */
export const TRANSITION_FOR_EFFECT = {
  julia:    'melt',
  ripple:   'melt',
  droste:   'melt',
  vhs:      'tear',
  datamosh: 'tear',
  kaleido:  'spin',
  halftone: 'lumawipe',
  slitscan: 'lumawipe',
};

export function transitionFor(effectName) {
  return TRANSITION_FOR_EFFECT[effectName] || 'melt';
}
