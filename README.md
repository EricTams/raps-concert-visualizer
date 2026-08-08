# Raptor & The Screechers — Concert Visualizer

A self-running shader visualizer for a live set. Open the page and it starts
immediately: each album cover holds for about a minute under its own GPU effect,
then transitions to the next, shuffled and looping for as long as you leave it up.

No clicks, no permissions, no audio, no dependencies.

**Live:** https://erictams.github.io/raps-concert-visualizer/

## Running the show

1. Open the page on the machine driving the projector, ideally a few minutes early
   so the covers are cached.
2. Press **F** (or double-click) for fullscreen.
3. Leave it alone.

The mouse cursor hides itself after two seconds, and the page asks the OS to keep
the display awake for the length of the set.

### Keys

**Press `Tab` for an on-screen cheat sheet** listing every cover and shader with
its key, and what's currently playing. Press `Tab` again to dismiss it.

| Key | Does |
| --- | --- |
| `Tab` | Toggle the cheat sheet / debug panel |
| `→` / `Space` / click | Move to the next cover now, with a proper transition |
| `←` | Go back one |
| `1`–`8` | Jump to that cover |
| `Q W E R T Y U I O` | Switch the shader live — julia, vhs, kaleido, datamosh, ripple, droste, halftone, slitscan, chamber |
| `0` | Release the shader override, back to what the setlist assigns |
| `[` / `]` | Intensity down / up |
| `P` | Hold on this cover — freezes the countdown, the effect keeps moving |
| `F` / double-click | Fullscreen |
| `H` | Small corner overlay (off by default, so nothing is on screen for the audience) |

### URL options

Append to the address, e.g. `?dur=90&intensity=0.7`.

| Option | Does |
| --- | --- |
| `dur=90` | Seconds per cover (default 60) |
| `trans=5` | Transition length in seconds (default 3) |
| `intensity=0.7` | Scales every effect down or up (default 1.0) |
| `order=fixed` | Play the setlist in `config.js` order instead of shuffling |
| `fx=vhs` | Lock every cover to one effect — useful for previewing |
| `hud=1` | Start with the info overlay visible |
| `capture=1` | Keep the GL drawing buffer, so screenshots and screen recorders capture the canvas instead of black. Development only — it can cost a copy per frame |

## Changing things

Everything you'd want to adjust is in [`config.js`](config.js): the setlist, how
long each cover holds, which effect each one gets, how the art is framed, and the
global intensity.

Effects available: `julia`, `vhs`, `kaleido`, `datamosh`, `ripple`, `droste`,
`halftone`, `slitscan`, `chamber`. Set an entry's `fx` to `null` to have one
picked at random.

### Adding or replacing a cover

Drop the full-size original in `assets-src/`, then generate the served copy:

```
sips -Z 1440 -s format jpeg -s formatOptions 88 assets-src/New_Cover.png --out images/new-cover.jpg
```

and add a line to `SETLIST` in `config.js`.

## How it works

- `src/gl.js` — WebGL context, program compilation, framebuffers.
- `src/effects.js` — the nine effect shaders, sharing one prelude that handles
  framing, the blurred surround, and the intensity envelope.
- `src/transitions.js` — the four transition shaders, chosen by which effect is
  arriving.
- `src/julia.js` — solves the Julia effect's constant and camera on the CPU.
- `src/chamber.js` — the particle simulation behind the `chamber` effect.
- `src/show.js` — asset loading, the shuffle, the clock, and the controls.

The square artwork is contained inside the wide frame so nothing is ever cropped;
the space either side is filled with a heavily blurred, dimmed copy of the same
image. `droste` is the deliberate exception — it magnifies past the edge of the
cover and runs edge to edge, because containing the artwork leaves its recursion
as a small detail in the middle of the screen, and blurred bars only exist to
fill space a full-bleed image does not leave. Each frame is one draw straight to the screen, or three during a transition
(outgoing effect, incoming effect, composite). If the machine can't hold frame
rate, the render resolution steps down automatically rather than stuttering.

**Feedback effects.** `datamosh` renders into a buffer that survives between
frames, so its square stamps accumulate instead of being recomputed each frame.
Any effect named in `FEEDBACK_EFFECTS` gets a ping-pong pair of buffers, a
`u_prev` sampler holding the last frame, and a `u_reset` flag raised on the first
frame of a slot and after a resize — so accumulation never bleeds from one cover
into the next. There are two such pairs, one per side of a transition, so a
feedback effect can run on both covers at once without their histories mixing.
The slow framing breathe is held still for these effects, otherwise older stamps
would drift out of register with the artwork under them.

By default the buffer is copied straight to the screen, which works because
datamosh's buffer *is* the frame. An effect named in `RESOLVE_EFFECTS` supplies
its own second pass to run instead of that copy, for when the buffer holds
something that is not a picture.

**The bubble chamber.** `chamber` treats the cover as the illuminated volume of
a particle detector. The physics is a real simulation on the CPU
([`src/chamber.js`](src/chamber.js)) — a magnetic field bending each path,
ionisation bleeding momentum away until the path winds up into a spiral,
multiple scattering roughening it, delta rays flicking off the stiff tracks,
unstable particles coming apart in flight into forks and stars. Nothing is ever
created inside the frame: every primary is launched from outside it, so every
vertex on the plate traces back to something that entered. Collisions are not
detected but *scheduled* — a vertex and a moment are chosen first, and the pair
is launched from off-frame on arcs that put them both there at that instant.

Its feedback buffer holds a distortion field rather than an image: how far the
artwork is dragged at each pixel, which way its hue is turned, and how much
track has been laid down there. The resolve pass samples the untouched cover
through that field. So particles *smudge* the picture along their paths instead
of painting on it, and because the artwork is never fed back into itself it
never degrades — the only thing that accumulates, and the only thing that heals,
is the distortion. When the field decays to zero the frame is the clean cover
again, pixel for pixel.

## Development

ES modules need to be served over HTTP, not opened as a file:

```
python3 -m http.server 8000
```

then open http://localhost:8000/?dur=8&hud=1 to walk the whole show quickly.
