// ---------------------------------------------------------------------------
// SHOW CONFIGURATION
//
// This is the only file you need to edit. Everything else is machinery.
// ---------------------------------------------------------------------------

// How long each cover stays on screen, in seconds (includes its transition tail).
export const SLOT_SECONDS = 60;

// How long the crossfade into the next cover takes, in seconds.
export const TRANSITION_SECONDS = 3;

// THE SETLIST.
//
// By default the show plays these in random order, reshuffling forever.
// To lock it to this exact order instead, load the page with ?order=fixed
// and reorder the lines below to match your setlist.
//
// `fx` names the shader effect this cover gets. Available effects:
//   julia   vhs  kaleido  datamosh  ripple  droste  halftone  slitscan  chamber
// Set fx to null to have one picked at random each cycle.
export const SETLIST = [
  { file: 'images/moneh-cover.jpg',                  title: 'Moneh',                     fx: 'julia'    },
  { file: 'images/true-view.jpg',                    title: 'True View',                 fx: 'droste'   },
  { file: 'images/show-of-hands-cover.jpg',          title: 'Show of Hands',             fx: 'vhs'      },
  { file: 'images/stop-and-smell-the-roses.jpg',     title: 'Stop and Smell the Roses',  fx: 'ripple'   },
  { file: 'images/do-you-take-rays-points-cover.jpg', title: "Do You Take Ray's Points?", fx: 'datamosh' },
  { file: 'images/total-leadership-cover.jpg',       title: 'Total Leadership',          fx: 'kaleido'  },
  { file: 'images/belated-birthday-cover.jpg',       title: 'Belated Birthday',          fx: 'halftone' },
  { file: 'images/what-have-we-learnt.jpg',          title: 'What Have We Learnt',       fx: 'slitscan' },
];

// Slow pan/zoom applied under every effect, so the cropped top and bottom of the
// square art drift into view over the course of a slot.
// How the square artwork sits inside a wide projector frame.
//
// The whole cover stays visible — nothing is cropped. The space either side is
// filled with a heavily blurred, dimmed copy of the same image, so the screen is
// full but the art is never cut into.
export const FRAMING = {
  // Fraction of the frame's short side the cover occupies. 1.0 touches the top
  // and bottom edges; lower values leave a margin all the way round.
  fit: 0.94,
  // Amplitude of the slow scale breathing, as a fraction of `fit`.
  breathe: 0.035,
  // Brightness of the blurred surround. 0 = black bars, 1 = as bright as the art.
  backdropDim: 0.5,
  // How far the blurred surround is zoomed in. Higher = softer, less detailed.
  backdropZoom: 1.7,
};

// The flow field the datamosh effect drags the artwork along.
// Override live without editing anything: ?flow=0.2&flowspeed=0.09
export const DATAMOSH_FLOW = {
  // How far the artwork drifts, as a fraction of its width. This is the dial
  // that matters — 0.04 is a slow sway, 0.12 a visible slosh, 0.3 a churn.
  amount: 0.084,
  // How fast the field itself rearranges. Too high and it shimmers rather
  // than flows, because the direction reverses before the eye tracks it.
  speed: 0.055,
};

// Global intensity multiplier for every effect. Turn down if it reads as too busy
// on a big projector, up if it looks tame in the room.
export const INTENSITY = 1.0;
