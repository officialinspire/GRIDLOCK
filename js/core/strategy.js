/**
 * Strategic category effects: Prestige, takeover control (defence) and development pressure
 * (attack), and the industrial construction discount. Numbers live in ECONOMY.STRATEGY and
 * ECONOMY.TAKEOVER (config.js); the takeover rules themselves are in core/takeover.js.
 *
 * Every function here is a pure, deterministic read of the board: only developed, owned,
 * active (not abandoned) blocks produce effects, and nothing depends on iteration luck.
 * refreshBonuses (core/bonuses.js) stores each block's Prestige and control strength on it for
 * the UI; scoring and the rules call these functions directly, so they can never go stale.
 *
 *   Residential  defends nearby own blocks against takeovers
 *   Commercial   extra takeover pressure on adjacent rival blocks (core/takeover.js)
 *   Park         Prestige, +Prestige for adjacent own blocks (and its Residential income bonus)
 *   Civic        Prestige, takeover defence nearby (and its event protection)
 *   Industrial   cheaper construction next door; −Prestige next to Residential unless a Park buffers it
 *   Landmark     major Prestige, strong takeover defence nearby
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
  residential: `Defends nearby blocks against takeovers: +${ECONOMY.TAKEOVER.CONTROL.defence.residential} control per level`,
  commercial: `Takeover pressure on adjacent rival blocks: +${ECONOMY.TAKEOVER.PRESSURE.commercialPerLevel} per level (City era)`,
  park: `+${S.PRESTIGE.perLevel.park} Prestige per level, +${S.PRESTIGE.parkNeighbour} to each adjacent own block; boosts homes`,
  civic: `+${S.PRESTIGE.perLevel.civic} Prestige per level, +${ECONOMY.TAKEOVER.CONTROL.defence.civic} control per level nearby; shields emergencies`,
  industrial: `Top income; builds next door cost ${S.INDUSTRY.costDiscountPercent}% less; −Prestige beside homes unless a park buffers it`,
  landmark: `+${S.PRESTIGE.perLevel.landmark} Prestige per level, +${ECONOMY.TAKEOVER.CONTROL.defence.landmark} control per level nearby`,
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

/* ---------------- takeover strengths (rules in core/takeover.js) ---------------- */

const T = ECONOMY.TAKEOVER;

/**
 * controlStrength of an owned block: how hard it is to take over.
 * { control, parts: { base, level, defence, support } }; 0 for unowned or abandoned blocks.
 *   base     ownership
 *   level    its own building level
 *   defence  its owner's Residential / Civic / Landmark levels nearby (itself included)
 *   support  its owner's developed blocks across a road from it
 */
export function controlStrength(board, block) {
  const parts = { base: 0, level: 0, defence: 0, support: 0 };
  if (block.ownerSeat == null || block.abandoned) return { control: 0, parts };
  parts.base = T.CONTROL.base;
  if (isActive(block)) parts.level = T.CONTROL.perLevel * block.level;
  for (const source of nearbyBlocks(board, block)) {
    if (isActive(source) && source.ownerSeat === block.ownerSeat) parts.defence += (T.CONTROL.defence[source.type] ?? 0) * source.level;
  }
  parts.support = neighbors(board, block)
    .filter((n) => isActive(n) && n.ownerSeat === block.ownerSeat).length * T.CONTROL.supportPerAdjacent;
  return { control: parts.base + parts.level + parts.defence + parts.support, parts };
}

/**
 * developmentPressure `seat` puts on `block`: its developed blocks across a road from it, each
 * worth PRESSURE.perAdjacent, Commercial ones also PRESSURE.commercialPerLevel × level.
 * { pressure, parts: { adjacent, commercial } }; 0 on the seat's own or unowned blocks.
 */
export function developmentPressure(board, seat, block) {
  const parts = { adjacent: 0, commercial: 0 };
  if (block.ownerSeat == null || block.abandoned || block.ownerSeat === seat) return { pressure: 0, parts };
  for (const source of neighbors(board, block)) {
    if (!isActive(source) || source.ownerSeat !== seat) continue;
    parts.adjacent += T.PRESSURE.perAdjacent;
    if (source.type === 'commercial') parts.commercial += T.PRESSURE.commercialPerLevel * source.level;
  }
  return { pressure: parts.adjacent + parts.commercial, parts };
}

/** True when `seat`'s pressure on `block` beats its control (every other takeover rule aside). */
export function pressureBeatsControl(board, seat, block) {
  const { pressure } = developmentPressure(board, seat, block);
  return pressure > 0 && pressure > controlStrength(board, block).control;
}

/* ---------------- industry ---------------- */

/** % off a build/upgrade on `block` for `seat`: adjacent to one of its developed Industrial blocks. */
export function industryDiscount(board, seat, block) {
  const next = neighbors(board, block).some((n) => isActive(n) && n.type === 'industrial' && n.ownerSeat === seat);
  return next ? S.INDUSTRY.costDiscountPercent : 0;
}
