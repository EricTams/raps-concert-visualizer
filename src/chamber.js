// ---------------------------------------------------------------------------
// BUBBLE CHAMBER
//
// A charged-particle simulation, run on the CPU, for the `chamber` effect.
//
// A bubble chamber is a tank of superheated liquid sitting in a strong magnetic
// field. A charged particle crossing it boils a trail of bubbles along its path,
// and the field bends that path into an arc — one way for positive charge, the
// other for negative. As the particle ionises the liquid it loses momentum, the
// arc tightens, and the track winds up into the spiral that makes these
// photographs worth looking at.
//
// Every visible feature of one of those plates falls out of three rules, and
// this file is those three rules:
//
//   1. r = p / (qB)            the field bends the path
//   2. dp/ds = -LOSS           ionisation bleeds momentum away
//   3. dE/dx ~ 1/beta^2        a slow particle ionises harder, so its track
//                              is thicker and denser than a fast one's
//
// Rules 1 and 2 together give dr/dtheta = -LOSS * r: the radius falls
// exponentially with turned angle, which is the definition of an equiangular
// spiral. Nobody draws the spiral here. It is what a particle does.
//
// The shader only ever sees, per particle per frame, the short segment of track
// it covered during that frame. The whole trajectory is held by the feedback
// buffer in src/effects.js, which is also what heals it away again.
// ---------------------------------------------------------------------------

/** Slots in the uniform arrays, and so the ceiling on simultaneous particles. */
export const MAX_TRACKS = 28;

const TAU = Math.PI * 2;

// --- Units -----------------------------------------------------------------
//
// Working space is the shader's centred space: the frame is one unit tall,
// origin at the middle, x running to +/- aspect/2.
//
// Momentum is measured directly as the radius of curvature it buys, so the
// field strength is 1 by definition and `r` below IS the momentum. Everything
// the simulation does to a particle, it does by changing r.

// Radius lost per unit of path travelled. This single number sets how many
// times a track winds before it stops: turns = ln(r0 / R_STOP) / (LOSS * 2pi).
const LOSS = 0.10;

// Below this the particle has stopped and the track ends.
//
// Set by what can be drawn, not by physics. Let a particle spiral down to a
// radius near its own track width and the last turns land on top of each other,
// so the end of every spiral is a solid disc of beading rather than a curl.
// Stopping it while the innermost turn is still several pixels across is the
// difference between a spiral and a blob.
const R_STOP = 0.010;

// Momentum at which the particle is running at half the speed of the fastest
// ones. beta = r / (r + R_BETA) stands in for v/c: near 1 for a stiff track,
// small for one about to stop.
const R_BETA = 0.055;

// Path length per second at beta = 1.
const SPEED = 0.30;

// Multiple scattering. A real track is not smooth — it is deflected by every
// nucleus it passes, by an angle that grows as the particle slows (Highland:
// theta ~ sqrt(ds) / (beta * p)). This is what stops the spirals looking like
// something drawn with a compass.
const SCATTER = 0.0045;

// Delta rays: a fast particle occasionally knocks an electron clean out of an
// atom, and that electron curls up into a little spiral of its own hanging off
// the parent track. Expected number per unit of path.
const DELTA_RATE = 0.55;

// Half-width of a minimum-ionising track, in frame heights.
const TRACK_WIDTH = 0.0027;

// Seconds between events, and how long any one particle is allowed to live.
const EVENT_GAP = [1.1, 3.2];
const MAX_AGE = 50;

// How often a stiff track is an unstable particle rather than a stable one, and
// how far it gets before it comes apart.
const DECAY_CHANCE = 0.55;
const DECAY_PATH = [0.20, 1.30];

// False colour. Bubble chamber plates are black and white; the colour on the
// famous prints was added afterwards, one hue per track, to tell them apart.
// These are spaced round the wheel so neighbouring tracks never read as the
// same particle.
const HUES = [0.53, 0.88, 0.13, 0.33, 0.06, 0.75, 0.97, 0.44, 0.63, 0.20];

/** Between lo and hi, biased toward lo — `bias` above 1 pulls harder. */
function mixPow(lo, hi, u, bias) {
  return lo + (hi - lo) * Math.pow(u, bias);
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Chamber {
  constructor() {
    this.particles = [];
    // (ax, ay, bx, by) — the piece of track covered this frame.
    this.segments = new Float32Array(MAX_TRACKS * 4);
    // (hue, halfWidth, ionisation, spare) — halfWidth 0 marks an empty slot.
    this.styles = new Float32Array(MAX_TRACKS * 4);
    this.reset(0);
  }

  /** Start a fresh exposure. Called on the first frame of a slot. */
  reset(seed) {
    this.rand = mulberry32(Math.floor(seed * 0xffffff) ^ 0x9e3779b9);
    this.particles.length = 0;
    this.segments.fill(0);
    this.styles.fill(0);
    this.hueCursor = Math.floor(this.rand() * HUES.length);
    this.pending = [];
    // Two events already in flight, so a slot does not open on an empty plate.
    this.nextEvent = -1.6;
    this.time = 0;
  }

  _room() {
    return MAX_TRACKS - this.particles.length;
  }

  _r(lo, hi) {
    return lo + (hi - lo) * this.rand();
  }

  /** Roughly normal, mean 0, unit variance — three uniforms is close enough. */
  _gauss() {
    return (this.rand() + this.rand() + this.rand() - 1.5) * 1.155;
  }

  _hue() {
    this.hueCursor = (this.hueCursor + 3) % HUES.length;
    return HUES[this.hueCursor] + this._r(-0.02, 0.02);
  }

  _add(x, y, dir, r, q, hue) {
    if (this.particles.length >= MAX_TRACKS) return null;
    const p = {
      x, y, dir, r, q, hue,
      px: x, py: y,
      age: 0, s: 0, sinceDelta: 0,
      // Path length at which this one comes apart and what it comes apart into,
      // and the meeting it is heading for. A stable particle has none of them.
      decayAt: Infinity,
      fate: null,
      meeting: null,
      // Nothing is culled for being out of frame until it has been inside it,
      // because every primary is launched from outside.
      entered: false,
    };
    this.particles.push(p);
    return p;
  }

  /**
   * Distance from a point to the edge of the frame along a heading. Used to
   * put primaries outside it, and only ever along the chord — a stiff track's
   * arc bulges off that by well under the margin it is given.
   */
  _toEdge(x, y, dir, halfW, halfH) {
    const ca = Math.cos(dir);
    const sa = Math.sin(dir);
    let t = 1e9;
    if (ca > 1e-6) t = Math.min(t, (halfW - x) / ca);
    else if (ca < -1e-6) t = Math.min(t, (-halfW - x) / ca);
    if (sa > 1e-6) t = Math.min(t, (halfH - y) / sa);
    else if (sa < -1e-6) t = Math.min(t, (-halfH - y) / sa);
    return t;
  }

  /**
   * Decide what an incoming particle is going to do, and how far into the
   * chamber it gets before doing it. Stiff tracks only: a soft one curls up and
   * stops long before it would get the chance, and a kink in something already
   * spiralling tightly is unreadable.
   */
  _makeUnstable(p, dist) {
    if (!p || p.r < 0.22) return p;
    const roll = this.rand();
    if (roll > DECAY_CHANCE) return p;
    p.fate = roll < DECAY_CHANCE * 0.32 ? 'star' : 'decay';
    // Aimed to happen while it is crossing the artwork, not the moment it
    // arrives and not after it has left.
    p.decayAt = dist !== undefined
      ? dist * this._r(0.55, 1.15)
      : this._r(DECAY_PATH[0], DECAY_PATH[1]);
    return p;
  }

  /**
   * The track ends here and its products carry on from the same point — either
   * a decay in flight, a fork of two or three, or a star where it struck a
   * nucleus and that came apart too.
   *
   * The daughters share out the parent's momentum, and the share each one gets
   * decides how far off the parent's line it comes: a daughter carrying most of
   * it barely deviates, one carrying little is thrown out sideways and curls up
   * almost at once. That is only conservation of momentum, and it is what makes
   * a decay read as a fork in one track rather than as several tracks that
   * happen to touch. It is also where the spirals come from — nothing enters
   * the chamber soft enough to curl, so every tight curl on the plate is
   * something's daughter.
   *
   * Some of the momentum always goes missing, carried off by a neutral daughter
   * that boils no bubbles and so leaves no track. The visible prongs never quite
   * balance, and noticing that they did not is how the neutrino was found.
   */
  _decay(p) {
    const star = p.fate === 'star';
    const kids = star
      ? 4 + Math.floor(this.rand() * 3)
      : this.rand() < 0.28 ? 1 : this.rand() < 0.68 ? 2 : 3;
    const visible = this._r(0.45, 0.92);

    let left = 1;
    for (let k = 0; k < kids; k++) {
      // Lopsided on purpose. An even split gives prongs that all curve the
      // same, which reads as a decoration; one stiff prong carrying on and the
      // rest thrown off soft is what a real vertex looks like.
      const frac = k === kids - 1 ? left : left * Math.pow(this._r(0.25, 0.95), 1.7);
      left -= frac;

      const spread = star
        ? this._r(0.35, 1.5)
        : this._r(0.10, 1.15) * (1 - frac * 0.8);
      const side = star ? (k / kids) * TAU : (this.rand() < 0.5 ? 1 : -1) * spread;

      // Two prongs go one each way, which draws the opposed pair of curls that
      // is the most recognisable thing on any of these plates.
      const q = kids === 2 ? (k === 0 ? p.q : -p.q)
              : k === 0 ? p.q
              : this.rand() < 0.5 ? 1 : -1;

      const child = this._add(
        p.x, p.y,
        p.dir + (star ? side + this._r(-0.3, 0.3) : side),
        Math.max(0.014, p.r * visible * frac),
        q,
        this._hue()
      );
      // A daughter can be unstable in its turn, so a track occasionally forks,
      // and one of the forks forks again.
      if (child && child.r > 0.35 && this.rand() < 0.35) {
        child.fate = 'decay';
        child.decayAt = child.s + this._r(DECAY_PATH[0], DECAY_PATH[1]);
      }
    }
  }

  // --- Events --------------------------------------------------------------
  //
  // Nothing is ever created inside the frame. Every primary is launched from
  // outside it and aimed across the artwork, and every vertex on the plate is
  // something that entered coming apart, striking something, or meeting its
  // opposite. So the whole picture traces back to the beam, which is both how a
  // chamber actually works and the difference between a plate and a screensaver.

  /** One particle in from off-frame, aimed across the cover. */
  _spawnEntry(aspect, half) {
    const halfW = aspect * 0.5;

    // Aim at a point on the artwork, then walk backwards along that heading
    // until outside the frame and start there.
    const tx = this._r(-half * 0.8, half * 0.8);
    const ty = this._r(-half * 0.8, half * 0.8);
    const dir = this.rand() * TAU;
    const back = this._toEdge(tx, ty, dir + Math.PI, halfW, 0.5) + 0.05;

    // Biased stiff. Anything soft enough to curl on its own would do it at the
    // edge of the frame before reaching anything worth looking at; the curls
    // come from what these turn into once they are across the cover.
    const r = mixPow(0.35, 9.0, this.rand(), 2.4);

    const p = this._add(
      tx - Math.cos(dir) * back,
      ty - Math.sin(dir) * back,
      dir, r,
      this.rand() < 0.5 ? 1 : -1,
      this._hue()
    );
    this._makeUnstable(p, back);
  }

  /**
   * Two particles converging on a point, where they annihilate into a spray.
   *
   * Nothing is detected and nothing collides: the vertex and the moment are
   * chosen first, and the two tracks are launched from off-frame on paths that
   * put them there together. Which takes one piece of geometry. A charged
   * particle travels an arc, not a chord, so aiming it straight at the target
   * misses — it has to be launched off to one side by half the angle it will
   * turn through on the way, and for radius r across a chord of length c that
   * is asin(c / 2r). Give both the same momentum and the same distance to
   * cover, opposite charges, and they sweep mirrored arcs into the same point
   * at the same instant.
   */
  _spawnMeeting(aspect, half) {
    if (this._room() < 7) return;

    const halfW = aspect * 0.5;
    const vx = this._r(-half * 0.6, half * 0.6);
    const vy = this._r(-half * 0.55, half * 0.55);
    const axis = this.rand() * TAU;

    // The same distance for both, or they do not arrive together — so it has to
    // be far enough to put whichever has the shorter run out of the frame.
    const dist = Math.max(
      this._toEdge(vx, vy, axis, halfW, 0.5),
      this._toEdge(vx, vy, axis + Math.PI, halfW, 0.5)
    ) + 0.06;

    // Stiff enough that the arc into the vertex stays inside a quarter turn,
    // which keeps its bulge off the chord small enough not to swing wide.
    const r = this._r(1.3, 4.5) + dist;
    const halfTurn = Math.asin(Math.min(1, dist / (2 * r)));
    const beta = r / (r + R_BETA);

    const meeting = {
      x: vx, y: vy,
      at: this.time + (2 * halfTurn * r) / (SPEED * beta),
      done: false,
    };

    for (let k = 0; k < 2; k++) {
      const a = axis + Math.PI * k;
      const x = vx + Math.cos(a) * dist;
      const y = vy + Math.sin(a) * dist;
      const q = k === 0 ? 1 : -1;
      const p = this._add(
        x, y,
        Math.atan2(vy - y, vx - x) - q * halfTurn,
        r, q, this._hue()
      );
      if (p) p.meeting = meeting;
    }
    this.pending.push(meeting);
  }

  /** Fire a meeting: both parents stop, and the products spray out. */
  _annihilate(meeting) {
    meeting.done = true;

    // Use where the tracks actually got to, not where they were aimed, so the
    // vertex sits exactly on the ends of the two incoming tracks.
    let sx = 0, sy = 0, n = 0;
    for (const p of this.particles) {
      if (p.meeting === meeting) { sx += p.x; sy += p.y; n++; p.dead = true; }
    }
    if (n === 0) return;
    const vx = sx / n;
    const vy = sy / n;

    const prongs = 3 + Math.floor(this.rand() * 4);
    const spin = this.rand() * TAU;
    for (let i = 0; i < prongs; i++) {
      this._add(
        vx, vy,
        spin + (i / prongs) * TAU + this._r(-0.35, 0.35),
        mixPow(0.016, 0.55, this.rand(), 1.8),
        this.rand() < 0.5 ? 1 : -1,
        this._hue()
      );
    }
  }

  _spawnEvent(aspect, half) {
    if (this.rand() < 0.22) this._spawnMeeting(aspect, half);
    else this._spawnEntry(aspect, half);
  }

  // --- Integration ---------------------------------------------------------

  /**
   * Advance every particle by `dt` seconds and refill the uniform arrays.
   * Only the piece of track covered during this frame is handed to the shader;
   * the rest of the trajectory already lives in the feedback buffer.
   */
  step(dt, aspect, half) {
    this.time += dt;

    while (this.time >= this.nextEvent) {
      this._spawnEvent(aspect, half);
      this.nextEvent += this._r(EVENT_GAP[0], EVENT_GAP[1]);
    }

    // Any convergence whose moment has arrived.
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const m = this.pending[i];
      if (this.time >= m.at) {
        if (!m.done) this._annihilate(m);
        this.pending.splice(i, 1);
      }
    }

    const halfW = aspect * 0.5 + 0.12;
    const live = this.particles;

    // Cached, so daughters born this frame wait until the next one to move.
    const n = live.length;
    for (let i = 0; i < n; i++) {
      const p = live[i];
      if (p.dead) continue;
      p.px = p.x;
      p.py = p.y;
      p.age += dt;

      const beta = p.r / (p.r + R_BETA);
      const ds = SPEED * beta * dt;

      // Two half-steps with the turn applied around the midpoint, so the chord
      // sits on the arc instead of inside it. At these step sizes the error is
      // far below a pixel, but tight curls are the whole point of the effect
      // and they are exactly where a naive Euler step visibly cuts corners.
      const sub = 2;
      const dsub = ds / sub;
      for (let k = 0; k < sub; k++) {
        const turn = (p.q * dsub) / Math.max(p.r, R_STOP);
        p.dir += turn * 0.5;
        p.x += Math.cos(p.dir) * dsub;
        p.y += Math.sin(p.dir) * dsub;
        p.dir += turn * 0.5;
        p.dir += Math.min(0.4, (SCATTER * Math.sqrt(dsub)) / (beta * Math.max(p.r, 0.008))) * this._gauss();
        p.r -= LOSS * dsub;
      }
      p.s += ds;
      if (!p.entered && Math.abs(p.x) < halfW && Math.abs(p.y) < 0.62) p.entered = true;

      // It came apart in flight: this track ends here and its daughters carry
      // on from the same point.
      if (p.s >= p.decayAt) {
        p.dead = true;
        this._decay(p);
        continue;
      }

      // Delta rays only come off tracks with enough momentum to make one, and
      // they go forward — the knocked-out electron inherits the parent's
      // direction of travel, which is why real ones always lean downstream.
      p.sinceDelta += ds;
      if (p.r > 0.25 && this._room() > 2 && p.sinceDelta > 0.02) {
        p.sinceDelta = 0;
        if (this.rand() < DELTA_RATE * 0.02) {
          const side = this.rand() < 0.5 ? 1 : -1;
          this._add(
            p.x,
            p.y,
            p.dir + side * this._r(0.7, 1.4),
            this._r(0.016, 0.06),
            -1,
            this._hue()
          );
        }
      }
    }

    for (let i = live.length - 1; i >= 0; i--) {
      const p = live[i];
      // Out of frame only counts once it has been in frame — everything starts
      // outside — and never for one still on its way to a meeting, whose arc
      // may swing wide of the chord it was aimed along.
      const gone = p.entered && !(p.meeting && !p.meeting.done) &&
        (p.x < -halfW || p.x > halfW || p.y < -0.75 || p.y > 0.75);
      if (p.dead || gone || p.r <= R_STOP || p.age > MAX_AGE) {
        // A particle that never made its meeting cancels it, rather than
        // leaving the other half of the pair to arrive at an empty vertex.
        if (p.meeting && !p.meeting.done && !p.dead) p.meeting.done = true;
        live.splice(i, 1);
      }
    }

    // --- Hand the frame's segments to the shader ---------------------------

    const seg = this.segments;
    const sty = this.styles;
    for (let i = 0; i < MAX_TRACKS; i++) {
      const o = i * 4;
      if (i >= live.length) {
        sty[o + 1] = 0;
        continue;
      }
      const p = live[i];
      const beta = p.r / (p.r + R_BETA);

      // Bethe-Bloch, near enough: deposit per unit path goes as 1/beta^2. This
      // is the rule that makes the end of a spiral fat and bright while the
      // beam track that spawned it stays a hairline.
      const ion = Math.min(6, 1 / (beta * beta));

      seg[o] = p.px;
      seg[o + 1] = p.py;
      seg[o + 2] = p.x;
      seg[o + 3] = p.y;

      sty[o] = p.hue - Math.floor(p.hue);
      sty[o + 1] = TRACK_WIDTH * (0.9 + 0.32 * (ion - 1));
      sty[o + 2] = (ion - 1) / 5;
      sty[o + 3] = 0;
    }
  }
}
