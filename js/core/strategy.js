/**
 * Strategic category effects: Prestige, control (defence), pressure (attack) and the
 * industrial construction discount. Numbers live in ECONOMY.STRATEGY (config.js).
 *
 * Every function here is a pure, deterministic read of the board: only developed, owned,
 * active (not abandoned) blocks produce effects, and nothing depends on iteration luck.
 * refreshBonuses (core/bonuses.js) stores each block's Prestige and control on the block for
 * the UI; scoring and the rules call these functions directly, so they can never go stale.
 *
 *   Residential  control for nearby own blocks
 *   Commercial   pressure on nearby rival blocks (takeovers, core/finance.js)
 *   Park         Prestige, +Prestige for adjacent own blocks (and its Residential income bonus)
 *   Civic        Prestige, control nearby (and its event protection)
 *   Industrial   cheaper construction next door; −Prestige next to Residential unless a Park buffers it
 *   Landmark     major Prestige, strong control nearby
 */
import { ECONOMY } from '../config.js';
import { neighbors } from './board.js';

const S = ECONOMY.STRATEGY;

export const PRESTIGE_NOTES = Object.freeze({
  BUILDING: 'building',
  PARK_NEIGHBOUR: 'park-neighbour',
  INDUSTRIAL_NUISANCE: 'industrial-nuisance',
});

export const PRESTIGE_LABELS = Object.freeze({
  [PRESTIGE_NOTES.BUILDING]: 'Building',
  [PRESTIGE_NOTES.PARK_NEIGHBOUR]: 'Next to park',
  [PRESTIGE_NOTES.INDUSTRIAL_NUISANCE]: 'Industry next to homes',
});

/** Short, player-facing summary of each category's strategic effects (build panel, How to Play). */
export const CATEGORY_EFFECTS = Object.freeze({
  residential: `Defends nearby blocks: +${S.CONTROL.perLevel.residential} control per level`,
  commercial: `Pressure on nearby rival blocks: +${S.PRESSURE.perLevel.commercial} per level (takeovers)`,
  park: `+${S.PRESTIGE.perLevel.park} Prestige per level, +${S.PRESTIGE.parkNeighbour} to each adjacent own block; boosts homes`,
  civic: `+${S.PRESTIGE.perLevel.civic} Prestige per level, +${S.CONTROL.perLevel.civic} control nearby; shields emergencies`,
  industrial: `Top income; builds next door cost ${S.INDUSTRY.costDiscountPercent}% less; −Prestige beside homes unless a park buffers it`,
  landmark: `+${S.PRESTIGE.perLevel.landmark} Prestige per level, +${S.CONTROL.perLevel.landmark} control per level nearby`,
});

/** Developed, owned and active: the only blocks that produce effects. */
export const isActive = (block, exclude = null) =>
  block.ownerSeat != null && !block.abandoned && block.level > 0 && block.type !== 'vacant' && block.id !== exclude;

const distance = (a, b) => Math.abs(a.row - b.row) + Math.abs(a.col - b.col);

/** Blocks within the effect radius of `block`, itself included (board order). */
export function nearbyBlocks(board, block, radius = S.RADIUS) {
  return board.blocks.filter((b) => distance(b, block) <= radius);
}

/* ---------------- Prestige ---------------- */

/**
 * Prestige of one block for its owner: { points, notes: [{ id, label, points }] }.
 * `exclude` scores as if that block were not owned (City Value contribution).
 */
export function blockPrestige(board, block, { exclude = null } = {}) {
  const cfg = S.PRESTIGE;
  const notes = [];
  if (!isActive(block, exclude)) return { points: 0, notes };
  const add = (id, points) => { if (points) notes.push({ id, label: PRESTIGE_LABELS[id], points }); };
  add(PRESTIGE_NOTES.BUILDING, (cfg.perLevel[block.type] ?? 0) * block.level);
  const adjacent = neighbors(board, block).filter((n) => isActive(n, exclude));
  const ownParks = adjacent.filter((n) => n.type === 'park' && n.ownerSeat === block.ownerSeat);
  add(PRESTIGE_NOTES.PARK_NEIGHBOUR, Math.min(ownParks.length, cfg.parkNeighbourMax) * cfg.parkNeighbour);
  if (block.type === 'industrial' && !ownParks.length && adjacent.some((n) => n.type === 'residential')) {
    add(PRESTIGE_NOTES.INDUSTRIAL_NUISANCE, -cfg.industrialPenaltyPerLevel * block.level);
  }
  return { points: notes.reduce((sum, n) => sum + n.points, 0), notes };
}

/** A player's Prestige: the sum over their blocks, never below 0. */
export function prestigeFor(board, seat, { exclude = null } = {}) {
  const total = board.blocks
    .filter((b) => b.ownerSeat === seat)
    .reduce((sum, b) => sum + blockPrestige(board, b, { exclude }).points, 0);
  return Math.max(0, total);
}

/* ---------------- control & pressure ---------------- */

/** Control (defence) of an owned block: { control, notes: [{ block, type, points }] }; 0 when unowned. */
export function blockControl(board, block) {
  if (block.ownerSeat == null || block.abandoned) return { control: 0, notes: [] };
  const notes = [];
  for (const source of nearbyBlocks(board, block)) {
    if (!isActive(source) || source.ownerSeat !== block.ownerSeat) continue;
    const points = (S.CONTROL.perLevel[source.type] ?? 0) * source.level;
    if (points) notes.push({ block: source.id, label: source.label, type: source.type, points });
  }
  return { control: S.CONTROL.base + notes.reduce((sum, n) => sum + n.points, 0), notes };
}

/** Pressure `seat` puts on `block`: its developed pressure buildings (Commercial) nearby. */
export function pressureOn(board, seat, block) {
  let pressure = 0;
  for (const source of nearbyBlocks(board, block)) {
    if (!isActive(source) || source.ownerSeat !== seat) continue;
    pressure += (S.PRESSURE.perLevel[source.type] ?? 0) * source.level;
  }
  return pressure;
}

/** True when `seat` could take `block` over on pressure alone (price, phase and cash aside). */
export function canPressure(board, seat, block) {
  if (block.ownerSeat == null || block.abandoned || block.ownerSeat === seat) return false;
  return pressureOn(board, seat, block) > blockControl(board, block).control;
}

/* ---------------- industry ---------------- */

/** % off a build/upgrade on `block` for `seat`: adjacent to one of its developed Industrial blocks. */
export function industryDiscount(board, seat, block) {
  const next = neighbors(board, block).some((n) => isActive(n) && n.type === 'industrial' && n.ownerSeat === seat);
  return next ? S.INDUSTRY.costDiscountPercent : 0;
}
