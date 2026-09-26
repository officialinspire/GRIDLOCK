/**
 * Sprite-sheet manifest for the Grid Lock City papercraft art (layer 1 of 2).
 *
 * The original PNG sheets live untouched at the repo root. tools/build-assets.mjs
 * derives assets/generated/: a WebP of every sheet (served first, PNG as fallback)
 * and a transparent copy of props_decor.png (its checkerboard is baked in).
 *
 * Each sprite is a rectangle [x, y, width, height] in source-image pixels;
 * `spriteStyle()` turns that into percentage-based CSS so sprites scale with
 * their element. Coordinates were measured from each sheet's alpha channel.
 *
 * Gameplay code should use the semantic roles in js/art.js (layer 2) rather
 * than naming sheets/sprites directly.
 */

export const GENERATED_DIR = 'assets/generated';

/** 'title_menu decor.png' → 'title-menu-decor' (must match tools/build-assets.mjs). */
export const sheetSlug = (file) => file.replace(/\.png$/, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase();

/**
 * @param file   original sheet at the repo root
 * @param opts.png  override the PNG used (props: the keyed-out generated copy)
 */
const sheet = (file, w, h, sprites, opts = {}) => ({
  file,
  url: encodeURI(opts.png ?? file),
  webp: `${GENERATED_DIR}/${sheetSlug(file)}.webp`,
  w,
  h,
  sprites,
});

// Ownership markers are laid out as 4 colour columns × 8 marker rows.
const MARKER_COLS = { red: [100, 164], blue: [320, 176], yellow: [540, 172], green: [760, 176] };
const MARKER_ROWS = {
  flag: [48, 164],
  pennant: [228, 144],
  ring: [384, 172],
  chip: [564, 168],
  corner: [740, 164],
  frame: [916, 192],
  post: [1132, 176],
  seal: [1316, 184],
};
const markerSprites = {};
for (const [color, [x, w]] of Object.entries(MARKER_COLS)) {
  for (const [kind, [y, h]] of Object.entries(MARKER_ROWS)) {
    markerSprites[`${kind}-${color}`] = [x - 8, y, w + 16, h];
  }
}

export const SHEETS = {
  title: sheet('title_menu decor.png', 1536, 1024, {
    'ribbon-red': [24, 140, 404, 144],
    logo: [440, 56, 372, 232],
    'plate-blue': [832, 92, 316, 104],
    'plate-gold': [844, 204, 292, 92],
    'hanging-sign': [1192, 56, 324, 232],
    'ribbon-blue': [12, 376, 412, 136],
    rosette: [440, 336, 160, 208],
    shield: [612, 344, 148, 188],
    skyline: [1092, 344, 436, 196],
    'arrow-left': [408, 592, 184, 152],
    'arrow-right': [608, 596, 180, 152],
    'note-cream-taped': [804, 588, 188, 172],
    'note-yellow-taped': [996, 592, 172, 168],
    'pin-red': [1232, 604, 92, 148],
    'pin-blue': [1336, 594, 80, 156],
    'pin-yellow': [1424, 604, 92, 148],
    'clip-red': [44, 788, 148, 180],
    'clip-blue': [164, 788, 144, 180],
    ruler: [328, 840, 432, 88],
    'note-cream': [784, 800, 172, 160],
    'note-yellow': [968, 804, 168, 160],
    frame: [1164, 776, 356, 200],
  }),

  icons: sheet('UI icons.png', 1536, 1024, {
    play: [68, 68, 184, 208],
    pause: [304, 72, 180, 188],
    gear: [536, 64, 216, 212],
    sound: [796, 68, 228, 204],
    mute: [1056, 68, 216, 204],
    music: [1304, 68, 180, 192],
    home: [44, 300, 212, 200],
    back: [288, 312, 208, 184],
    restart: [540, 304, 200, 200],
    undo: [784, 320, 220, 168],
    info: [1048, 304, 200, 200],
    trophy: [1288, 304, 212, 196],
    star: [44, 528, 212, 200],
    building: [308, 524, 184, 208],
    road: [560, 528, 168, 200],
    tree: [796, 520, 188, 212],
    swap: [1032, 560, 232, 156],
    clock: [1288, 528, 204, 204],
    coins: [56, 748, 184, 212],
    crown: [284, 772, 220, 176],
    save: [544, 764, 200, 188],
    map: [780, 768, 224, 192],
    'zoom-in': [1048, 752, 216, 212],
    'zoom-out': [1276, 752, 212, 208],
  }),

  ui: sheet('UI buttons_panels.png', 1448, 1086, {
    'btn-cream': [88, 24, 292, 92],
    'btn-gold': [428, 24, 284, 92],
    'btn-plain': [760, 28, 268, 88],
    'btn-disabled': [1076, 24, 292, 92],
    'toggle-off': [136, 404, 184, 80],
    'toggle-on': [808, 404, 184, 80],
    'square-cream': [160, 492, 128, 124],
    'square-gold': [504, 492, 132, 124],
    'plaque-corners': [56, 620, 336, 136],
    'plaque-bolts': [424, 644, 300, 92],
    'plaque-red': [760, 652, 296, 84],
    'plaque-medal': [1092, 636, 312, 108],
    'seal-red': [148, 752, 152, 140],
    'ribbon-blue': [416, 768, 312, 116],
    'note-yellow': [832, 760, 160, 128],
    speech: [1128, 776, 228, 112],
    'panel-header': [76, 896, 296, 168],
    'card-tab': [428, 904, 296, 152],
    divider: [768, 956, 336, 40],
    'corner-flag': [1192, 928, 116, 108],
  }),

  markers: sheet('ownership markers.png', 1024, 1536, markerSprites),

  roads: sheet('roads_infrastructure.png', 1448, 1086, {
    'straight-h': [36, 92, 280, 204],
    'straight-v': [344, 44, 196, 292],
    'dead-end': [564, 72, 196, 264],
    cross: [788, 32, 336, 320],
    tee: [1152, 72, 268, 264],
    'curve-left': [40, 372, 224, 216],
    'curve-right': [288, 372, 220, 216],
    'alley-a': [532, 376, 160, 212],
    'alley-b': [732, 376, 152, 212],
    crosswalk: [928, 376, 228, 208],
    median: [1184, 372, 220, 212],
    rail: [44, 608, 448, 180],
    powerline: [524, 612, 380, 176],
    bridge: [932, 612, 484, 176],
    roundabout: [64, 804, 260, 244],
    'lot-grass': [396, 808, 284, 248],
    'lot-parking': [736, 804, 284, 252],
    'lot-construction': [1068, 804, 296, 252],
    // Board pieces: inner crops (inside the tile outline) so segments join seamlessly.
    'segment-h': [52, 110, 248, 172], // (getSpriteRect adds 4px padding)
    'segment-v': [360, 60, 164, 260],
    'junction': [888, 122, 136, 136],
  }),

  parks: sheet('parks_open spaces.png', 1448, 1086, {
    plaza: [28, 36, 328, 324],
    garden: [384, 32, 324, 328],
    playground: [736, 28, 336, 332],
    'basketball-court': [1100, 48, 328, 312],
    square: [28, 384, 328, 320],
    fountain: [388, 388, 316, 316],
    'parking-lot': [736, 392, 332, 312],
    'rooftop-garden': [1092, 376, 340, 328],
    'dog-park': [28, 724, 336, 324],
    'picnic-grove': [388, 720, 324, 328],
    skatepark: [736, 724, 332, 324],
    'empty-lot': [1096, 728, 328, 320],
  }),

  buildings: sheet('residential_commercial buildings.png', 1448, 1086, {
    house: [28, 112, 292, 288],
    duplex: [348, 96, 324, 304],
    rowhouses: [688, 88, 368, 312],
    apartments: [1068, 32, 348, 380],
    'corner-store': [24, 444, 320, 288],
    diner: [356, 468, 360, 252],
    'convenience-store': [728, 480, 356, 244],
    cafe: [1096, 432, 328, 296],
    office: [24, 744, 336, 320],
    shop: [368, 760, 296, 296],
    market: [684, 748, 380, 308],
    'gas-station': [1072, 816, 360, 248],
  }),

  // Civic sheet: shadows touch, so rects were measured by hand.
  civic: sheet('civic-buildings.png', 1448, 1086, {
    school: [8, 48, 314, 346],
    library: [330, 88, 274, 306],
    hospital: [608, 84, 264, 310],
    'fire-station': [878, 64, 284, 330],
    police: [1172, 100, 272, 294],
    'city-hall': [8, 400, 314, 352],
    warehouse: [330, 480, 274, 272],
    factory: [608, 400, 264, 352],
    substation: [878, 490, 272, 262],
    'parking-garage': [1154, 420, 290, 332],
    'train-station': [8, 800, 322, 258],
    theater: [336, 752, 272, 306],
    museum: [616, 760, 256, 298],
    stadium: [884, 760, 314, 298],
    monument: [1206, 752, 238, 306],
  }),

  // effects.png: 4 columns × 6 rows of effect bursts (grid-measured).
  effects: sheet('effects.png', 1024, 1536, {
    burst: [20, 30, 236, 240],
    demolish: [276, 30, 236, 240],
    dust: [532, 30, 236, 240],
    confetti: [788, 30, 236, 240],
    sparkle: [20, 275, 236, 240],
    boom: [276, 275, 236, 240],
    glow: [520, 275, 248, 240],
    alert: [788, 275, 236, 240],
    boost: [20, 520, 236, 230],
    'star-burst': [264, 520, 248, 230],
    smoke: [520, 520, 248, 230],
    streaks: [788, 520, 236, 230],
    rain: [20, 990, 236, 240],
    splash: [264, 990, 248, 240],
    snow: [520, 990, 248, 240],
    wind: [788, 990, 236, 240],
    leaves: [20, 1230, 236, 250],
    sunburst: [264, 1230, 248, 250],
  }),

  // props_decor.png has a baked-in checkerboard (no alpha channel); we render the
  // keyed-out copy from tools/build-assets.mjs. (The billboard names a real town,
  // so it is intentionally not mapped.)
  props: sheet('props_decor.png', 1448, 1086, {
    'tree-oak': [20, 20, 200, 216],
    'tree-tall': [240, 36, 112, 200],
    'tree-round': [364, 56, 156, 180],
    'tree-pine': [532, 16, 140, 220],
    'tree-slim': [688, 68, 92, 168],
    'bush-flowers': [792, 128, 128, 100],
    hedge: [940, 128, 164, 100],
    planter: [1120, 124, 184, 104],
    'bush-white': [1316, 116, 120, 112],
    bench: [36, 312, 212, 136],
    streetlamp: [280, 244, 72, 212],
    'traffic-light': [408, 252, 72, 204],
    mailbox: [528, 328, 88, 128],
    'trash-can': [648, 312, 96, 144],
    hydrant: [768, 324, 104, 136],
    fence: [900, 336, 248, 116],
    'brick-wall': [1160, 312, 264, 144],
    'bus-stop': [480, 492, 92, 236],
    'power-pole': [612, 476, 244, 240],
    'water-tower': [832, 464, 192, 236],
    antenna: [1036, 484, 156, 216],
    'rooftop-unit': [1188, 568, 248, 136],
    'car-red': [24, 744, 284, 168],
    'van-blue': [368, 736, 316, 176],
    truck: [744, 716, 360, 196],
    bike: [1164, 740, 260, 164],
    statue: [16, 908, 224, 180],
    fountain: [252, 924, 284, 164],
    'planter-large': [552, 956, 212, 132],
    playground: [792, 904, 320, 184],
    'basketball-court': [1132, 912, 304, 176],
  }, { png: `${GENERATED_DIR}/props-decor.png` }),
};

// Small bleed so black outlines at sprite edges aren't clipped.
const PAD = 4;

/** Returns the [x, y, w, h] rectangle for a sprite, or null if unknown. */
export function getSpriteRect(sheetKey, name) {
  const s = SHEETS[sheetKey];
  const r = s?.sprites[name];
  if (!r) return null;
  const x = Math.max(0, r[0] - PAD);
  const y = Math.max(0, r[1] - PAD);
  const w = Math.min(s.w - x, r[2] + PAD * 2);
  const h = Math.min(s.h - y, r[3] + PAD * 2);
  return [x, y, w, h];
}

/** Inline style declarations that crop a sprite out of its sheet responsively. */
export function spriteStyle(sheetKey, name) {
  const rect = getSpriteRect(sheetKey, name);
  if (!rect) return null;
  const s = SHEETS[sheetKey];
  const [x, y, w, h] = rect;
  const pos = (offset, size, total) => (total === size ? 0 : (offset / (total - size)) * 100);
  return {
    // WebP first (generated, ~5× smaller); PNG if image-set()/WebP is unsupported.
    fallbackImage: `url("${s.url}")`,
    backgroundImage: `image-set(url("${s.webp}") type("image/webp"), url("${s.url}") type("image/png"))`,
    backgroundSize: `${(s.w / w) * 100}% ${(s.h / h) * 100}%`,
    backgroundPosition: `${pos(x, w, s.w)}% ${pos(y, h, s.h)}%`,
    aspectRatio: `${w} / ${h}`,
  };
}

/** Parses a "sheet:name" reference. */
export function parseSpriteRef(ref) {
  const i = ref.indexOf(':');
  return i < 0 ? null : [ref.slice(0, i), ref.slice(i + 1)];
}

/** Applies a sprite to an existing element. */
export function applySprite(el, ref, label) {
  const parsed = Array.isArray(ref) ? ref : parseSpriteRef(ref);
  const style = parsed && spriteStyle(parsed[0], parsed[1]);
  if (!style) {
    console.warn(`[assets] unknown sprite "${ref}"`);
    return el;
  }
  el.classList.add('sprite');
  const { fallbackImage, backgroundImage, ...rest } = style;
  Object.assign(el.style, rest);
  el.style.backgroundImage = fallbackImage;
  el.style.backgroundImage = backgroundImage; // ignored by browsers without image-set(), keeping the PNG
  if (label) {
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', label);
  } else {
    el.setAttribute('aria-hidden', 'true');
  }
  return el;
}

/** Creates a new sprite element. */
export function createSprite(ref, { className = '', label, tag = 'span' } = {}) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  return applySprite(el, ref, label);
}

/** Hydrates every `[data-sprite]` element under `root`. */
export function hydrateSprites(root = document) {
  root.querySelectorAll('[data-sprite]').forEach((el) => {
    applySprite(el, el.dataset.sprite, el.dataset.label);
    el.removeAttribute('data-sprite');
  });
}

const preloaded = new Set();
const supportsWebp = typeof document !== 'undefined'
  && document.createElement('canvas').toDataURL('image/webp').startsWith('data:image/webp');

/** Starts downloading sprite sheets ahead of use (e.g. the build panel's art). */
export function preloadSheets(keys) {
  for (const key of keys) {
    const sheet = SHEETS[key];
    if (!sheet || preloaded.has(key)) continue;
    preloaded.add(key);
    const img = new Image();
    img.decoding = 'async';
    img.src = supportsWebp ? sheet.webp : sheet.url;
  }
}
