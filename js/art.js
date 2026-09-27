/**
 * Semantic art roles (layer 2 of the asset system).
 *
 * Gameplay/UI code asks for *what* it needs ("the owner's flag", "an unclaimed
 * lot", "props for a level-3 commercial block") and this module answers with a
 * sprite ref from js/assets.js. Re-skinning the game means editing this file,
 * not hunting through views. Development buildings per category/level live in
 * core/buildings.js (they're game data).
 */
import { PLAYER_PRESETS } from './config.js';

const colorOf = (seat) => PLAYER_PRESETS[seat - 1]?.color ?? 'red';

export const ART = Object.freeze({
  lot: Object.freeze({
    unclaimed: 'roads:lot-grass',
    owned: 'parks:empty-lot',
    abandoned: 'roads:lot-construction',
  }),

  road: Object.freeze({
    h: 'roads:segment-h',
    v: 'roads:segment-v',
    junction: 'roads:junction',
  }),

  /** Ownership markers by seat. */
  owner: Object.freeze({
    flag: (seat) => `markers:flag-${colorOf(seat)}`, // planted on claimed blocks
    post: (seat) => `markers:post-${colorOf(seat)}`, // small pennant post
    frame: (seat) => `markers:frame-${colorOf(seat)}`, // territory border
    seal: (seat) => `markers:seal-${colorOf(seat)}`, // vacant claimed lot
    chip: (seat) => `markers:chip-${colorOf(seat)}`, // HUD / results token
    ring: (seat) => `markers:ring-${colorOf(seat)}`, // empty seat
    pennant: (seat) => `markers:pennant-${colorOf(seat)}`, // setup card
  }),

  fx: Object.freeze({
    capture: 'effects:sparkle',
    build: 'effects:star-burst',
    bankrupt: 'effects:demolish',
  }),

  /** Lightweight cutout accents layered only on blocks inside an event footprint. */
  event: Object.freeze({
    'heavy-rain': ['effects:rain', 'effects:splash'],
    snowstorm: ['effects:snow'],
    fire: ['effects:boom', 'props:hydrant'],
    'power-outage': ['effects:alert'],
    'city-festival': ['effects:confetti'],
    'housing-boom': ['effects:boost'],
    'beautification-grant': ['effects:sparkle'],
    'economic-boom': ['effects:star-burst'],
    recession: ['effects:smoke'],
  }),

  /** Table decoration around the board (desktop only; never on the play grid). */
  tableDecor: Object.freeze([
    { sprite: 'props:tree-oak', spot: 'tl' },
    { sprite: 'props:streetlamp', spot: 'tr' },
    { sprite: 'props:car-red', spot: 'bl' },
    { sprite: 'props:bench', spot: 'br' },
  ]),

  /**
   * The downtown street on the start and title screens, left to right. `size` scales a piece
   * against the street's building height; `from` hides it on narrower screens (px), so a phone
   * shows the heart of downtown (City Hall in the middle) and a wide screen the whole street.
   */
  downtown: Object.freeze([
    { sprite: 'buildings:corner-store', size: 0.78, from: 1280 },
    { sprite: 'props:streetlamp', size: 0.62, prop: true, from: 1280 },
    { sprite: 'buildings:rowhouses', size: 0.9, from: 1100 },
    { sprite: 'buildings:apartments', size: 1.12, from: 900 },
    { sprite: 'props:tree-round', size: 0.5, prop: true, from: 900 },
    { sprite: 'buildings:cafe', size: 0.82, from: 700 },
    { sprite: 'civic:theater', size: 1.06, from: 520 },
    { sprite: 'props:streetlamp', size: 0.62, prop: true, from: 520 },
    { sprite: 'buildings:office', size: 1 },
    { sprite: 'civic:city-hall', size: 1.18 },
    { sprite: 'buildings:diner', size: 0.74 },
    { sprite: 'props:traffic-light', size: 0.62, prop: true, from: 520 },
    { sprite: 'buildings:shop', size: 0.86, from: 520 },
    { sprite: 'civic:museum', size: 1, from: 700 },
    { sprite: 'props:tree-pine', size: 0.56, prop: true, from: 900 },
    { sprite: 'buildings:market', size: 0.86, from: 900 },
    { sprite: 'civic:library', size: 0.98, from: 1100 },
    { sprite: 'props:bench', size: 0.3, prop: true, from: 1280 },
    { sprite: 'buildings:duplex', size: 0.84, from: 1280 },
  ]),
  /** Traffic on the downtown street: the far lane drives left, the near lane right (parked with reduced motion). */
  downtownTraffic: Object.freeze([
    { sprite: 'props:car-red', lane: 'far', at: 30 },
    { sprite: 'props:van-blue', lane: 'near', at: 8 },
    { sprite: 'props:bike', lane: 'near', at: 45 },
    { sprite: 'props:truck', lane: 'near', at: 72 },
  ]),
});

/**
 * City-building visual progression: street props that appear around a
 * developed block as it levels up. Index = level - 1; each level adds to the
 * previous. Kept to two small corner props so buildings stay readable.
 */
const PROGRESSION = Object.freeze({
  residential: ['props:tree-tall', 'props:mailbox'],
  commercial: ['props:streetlamp', 'props:trash-can'],
  park: ['props:bush-flowers', 'props:bench'],
  civic: ['props:hydrant', 'props:streetlamp'],
  industrial: ['props:power-pole', 'props:water-tower'],
  landmark: ['props:planter', 'props:tree-pine'],
});

/** Props for a block at `level` (Level 1: none, Level 2: one, Level 3: two). */
export function progressionProps(type, level) {
  const list = PROGRESSION[type];
  if (!list || level < 2) return [];
  return list.slice(0, Math.min(list.length, level - 1));
}

/** Every sprite ref this module can return (for tests). */
export function allArtRefs() {
  const refs = [];
  const walk = (v) => {
    if (typeof v === 'string') refs.push(v);
    else if (typeof v === 'function') [1, 2, 3, 4].forEach((s) => refs.push(v(s)));
    else if (Array.isArray(v)) v.forEach((x) => walk(x.sprite ?? x));
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(ART);
  Object.values(PROGRESSION).forEach((l) => refs.push(...l));
  return refs;
}
