// ---------------------------------------------------------------------------
// CPU-side targeting for the Julia effect.
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
// choices rather than where it started. Recomputing it every frame against the
// current c keeps the target riding the boundary as the set morphs under it.
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

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * A point on the Julia set for c, picked out by a sign sequence derived from
 * `seedBits`. Different seeds land on different parts of the boundary.
 */
function boundaryPoint(cx, cy, seedBits) {
  let zx = 0, zy = 0;
  let bits = seedBits >>> 0;
  for (let i = 0; i < INVERSE_STEPS; i++) {
    const wx = zx - cx, wy = zy - cy;
    const r = Math.hypot(wx, wy);
    // Principal square root of w.
    let sx = Math.sqrt(Math.max(0, (r + wx) * 0.5));
    let sy = Math.sqrt(Math.max(0, (r - wx) * 0.5));
    if (wy < 0) sy = -sy;
    // Then take one branch or the other.
    bits = (Math.imul(bits, 1103515245) + 12345) >>> 0;
    if (bits & 0x10000) { sx = -sx; sy = -sy; }
    zx = sx;
    zy = sy;
  }
  return [zx, zy];
}

/**
 * The constant, the point to zoom at, and how wide a view to take, for a given
 * moment of a given slot.
 */
export function juliaTarget(time, seed) {
  const th = time * C_RATE + seed * TAU;
  const cx = C_RADIUS * Math.cos(th);
  const cy = C_RADIUS * Math.sin(th);

  const cyc = time * ZOOM_RATE + seed * 7;
  const n = Math.floor(cyc);
  const f = cyc - n;

  // Geometric, so the apparent zoom rate stays constant through the cycle.
  const zb = 0.5 - 0.5 * Math.cos(f * TAU);
  const view = VIEW_TIGHT * Math.pow(VIEW_WIDE / VIEW_TIGHT, 1 - zb);

  // Glide to the next point across the whole back half of the cycle, which is
  // exactly the stretch spent pulling out. The result reads as one continuous
  // move — settle on a point, pull back while travelling to the next, push in
  // on that one — rather than a jump. Squeeze this into a short window and it
  // becomes a lurch across the plane, however slow the zoom around it is.
  //
  // Continuous across the cycle boundary, because the blend finishes exactly on
  // the next cycle's point just as the index increments to it.
  const a = boundaryPoint(cx, cy, Math.imul(n, 2654435761));
  const b = boundaryPoint(cx, cy, Math.imul(n + 1, 2654435761));
  const t = smoothstep(0.55, 1.0, f);

  return {
    cx, cy,
    x: a[0] + (b[0] - a[0]) * t,
    y: a[1] + (b[1] - a[1]) * t,
    view,
    zb,
  };
}
