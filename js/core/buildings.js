/**
 * Development categories: presentation only (names, blurbs, art per level).
 * All costs and income live in ECONOMY.DEVELOPMENT (config.js); rules live in
 * core/development.js. `sprite` references js/assets.js.
 */
import { ECONOMY } from '../config.js';

export const VACANT = 'vacant';

const lvl = (name, sprite) => Object.freeze({ name, sprite });

/** Display order in the build panel. */
export const CATEGORY_ORDER = Object.freeze(['residential', 'commercial', 'park', 'civic', 'industrial', 'landmark']);

export const CATEGORIES = Object.freeze({
  residential: Object.freeze({
    id: 'residential',
    label: 'Residential',
    icon: 'icons:home',
    blurb: 'Homes for your citizens.',
    levels: [lvl('House', 'buildings:house'), lvl('Rowhouses', 'buildings:rowhouses'), lvl('Apartments', 'buildings:apartments')],
  }),
  commercial: Object.freeze({
    id: 'commercial',
    label: 'Commercial',
    icon: 'icons:coins',
    blurb: 'Shops that bring in steady cash.',
    levels: [lvl('Corner Store', 'buildings:corner-store'), lvl('Market', 'buildings:market'), lvl('Office Tower', 'buildings:office')],
  }),
  park: Object.freeze({
    id: 'park',
    label: 'Park',
    icon: 'icons:tree',
    blurb: 'Cheap green space.',
    levels: [lvl('Community Garden', 'parks:garden'), lvl('Playground', 'parks:playground'), lvl('Fountain Square', 'parks:fountain')],
  }),
  civic: Object.freeze({
    id: 'civic',
    label: 'Civic',
    icon: 'icons:building',
    blurb: 'Public services for the city.',
    levels: [lvl('Library', 'civic:library'), lvl('School', 'civic:school'), lvl('City Hall', 'civic:city-hall')],
  }),
  industrial: Object.freeze({
    id: 'industrial',
    label: 'Industrial',
    icon: 'icons:gear',
    blurb: 'Big earners, not pretty.',
    levels: [lvl('Warehouse', 'civic:warehouse'), lvl('Substation', 'civic:substation'), lvl('Factory', 'civic:factory')],
  }),
  landmark: Object.freeze({
    id: 'landmark',
    label: 'Landmark',
    icon: 'icons:trophy',
    blurb: 'Expensive icons with top income.',
    levels: [lvl('Monument', 'civic:monument'), lvl('Museum', 'civic:museum'), lvl('Stadium', 'civic:stadium')],
  }),
});

export function getCategory(id) {
  return Object.hasOwn(CATEGORIES, id) ? CATEGORIES[id] : null;
}

/** Name + sprite for a category at a level (1-based), or null for vacant/unknown. */
export function levelArt(type, level) {
  return getCategory(type)?.levels[level - 1] ?? null;
}

/** "Residential · Lv 2 · Rowhouses" style label; "Vacant · Lv 0" for empty lots. */
export function describeDevelopment(block) {
  const art = levelArt(block.type, block.level);
  if (!art) return 'Vacant · Level 0';
  return `${getCategory(block.type).label} · Level ${block.level} · ${art.name}`;
}

// Catch config/catalogue drift early: every category needs economics and art for every level.
for (const id of CATEGORY_ORDER) {
  if (!ECONOMY.DEVELOPMENT.CATEGORIES[id]) throw new Error(`ECONOMY.DEVELOPMENT.CATEGORIES is missing "${id}"`);
  if (CATEGORIES[id].levels.length !== ECONOMY.DEVELOPMENT.MAX_LEVEL) {
    throw new Error(`Category "${id}" needs art for ${ECONOMY.DEVELOPMENT.MAX_LEVEL} levels`);
  }
}
