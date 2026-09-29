/**
 * Adjacency / district bonuses and civic protection.
 *
 * refreshBonuses(board) recomputes everything from scratch from the board's
 * ownership + development state and writes the results onto each block:
 *   block.bonuses      [{ id, label, percent, amount }]
 *   block.bonusIncome  sum of bonus amounts (whole dollars)
 *   block.protectedBy  ids of civic blocks whose radius covers this block
 *   block.prestige / prestigeNotes / control   strategic effects (core/strategy.js), for display
 *
 * Guarantees (see tests/unit/bonuses.test.mjs):
 * - Pure recompute: calling it twice gives the same result; stale bonuses vanish.
 * - Bonuses are % of BASE income (block.income), never of other bonuses.
 * - Each bonus type applies at most once per block.
 * - Connected groups use an iterative flood fill with a visited set (no recursion).
 *
 * Numbers live in ECONOMY.BONUSES (config.js).
 */
import { ECONOMY } from '../config.js';
import { neighbors } from './board.js';
import { blockPrestige, controlStrength } from './strategy.js';

const CFG = ECONOMY.BONUSES;

export const BONUS = Object.freeze({
  RESIDENTIAL_DISTRICT: 'residential-district',
  COMMERCIAL_DISTRICT: 'commercial-district',
  PARK_ADJACENCY: 'park-adjacency',
  MIXED_USE: 'mixed-use',
});

export const BONUS_LABELS = Object.freeze({
  [BONUS.RESIDENTIAL_DISTRICT]: 'Residential district',
  [BONUS.COMMERCIAL_DISTRICT]: 'Commercial district',
  [BONUS.PARK_ADJACENCY]: 'Next to park',
  [BONUS.MIXED_USE]: 'Mixed-use cluster',
});

const MIXED_TYPES = new Set(['residential', 'commercial', 'park']);

const developed = (b) => b.ownerSeat != null && b.level > 0;

/**
 * Connected components of blocks matching `include`, joined only between
 * blocks with the same owner. Iterative BFS; every block visited at most once.
 */
export function components(board, include) {
  const seen = new Set();
  const groups = [];
  for (const start of board.blocks) {
    if (seen.has(start.id) || !include(start)) continue;
    const group = [];
    const queue = [start];
    seen.add(start.id);
    while (queue.length) {
      const block = queue.shift();
      group.push(block);
      for (const next of neighbors(board, block)) {
        if (seen.has(next.id) || !include(next) || next.ownerSeat !== start.ownerSeat) continue;
        seen.add(next.id);
        queue.push(next);
      }
    }
    groups.push(group);
  }
  return groups;
}

const amountOf = (base, percent) => Math.round((base * percent) / 100);

function addBonus(acc, block, id, percent, detail) {
  const list = acc.get(block.id);
  if (list.some((b) => b.id === id)) return; // at most once per type
  if (percent <= 0) return;
  list.push({ id, label: BONUS_LABELS[id], percent, amount: amountOf(block.income, percent), ...detail });
}

/** Civic blocks within their level's radius of each block (Manhattan distance, self included). */
export function computeProtection(board) {
  const cfg = CFG.CIVIC_PROTECTION;
  const out = new Map(board.blocks.map((b) => [b.id, []]));
  for (const civic of board.blocks) {
    if (!developed(civic) || civic.type !== 'civic') continue;
    const radius = cfg.radiusByLevel[civic.level] ?? 0;
    for (const block of board.blocks) {
      const d = Math.abs(block.row - civic.row) + Math.abs(block.col - civic.col);
      if (d > radius) continue;
      if (cfg.sameOwnerOnly && block.ownerSeat !== civic.ownerSeat) continue;
      out.get(block.id).push(civic.id);
    }
  }
  return out;
}

/** Computes bonuses without mutating the board. Returns Map(blockId → bonus list). */
export function computeBonuses(board) {
  const acc = new Map(board.blocks.map((b) => [b.id, []]));

  // Same-type districts.
  for (const [type, id, cfg] of [
    ['residential', BONUS.RESIDENTIAL_DISTRICT, CFG.RESIDENTIAL_DISTRICT],
    ['commercial', BONUS.COMMERCIAL_DISTRICT, CFG.COMMERCIAL_DISTRICT],
  ]) {
    for (const group of components(board, (b) => developed(b) && b.type === type)) {
      if (group.length < cfg.minSize) continue;
      for (const block of group) addBonus(acc, block, id, cfg.percent, { size: group.length });
    }
  }

  // Parks next to Residential.
  const park = CFG.PARK_ADJACENCY;
  for (const block of board.blocks) {
    if (!developed(block) || block.type !== 'residential') continue;
    const parks = neighbors(board, block).filter((n) =>
      developed(n) && n.type === 'park' && (!park.sameOwnerOnly || n.ownerSeat === block.ownerSeat));
    const counted = Math.min(parks.length, park.maxParks);
    if (counted > 0) addBonus(acc, block, BONUS.PARK_ADJACENCY, counted * park.percentPerPark, { parks: counted });
  }

  // Mixed-use: a connected Residential/Commercial/Park cluster containing all three.
  for (const group of components(board, (b) => developed(b) && MIXED_TYPES.has(b.type))) {
    const types = new Set(group.map((b) => b.type));
    if (types.size < MIXED_TYPES.size) continue;
    for (const block of group) addBonus(acc, block, BONUS.MIXED_USE, CFG.MIXED_USE.percent, { size: group.length });
  }

  return acc;
}

/**
 * Recomputes bonuses + protection and stores them on every block.
 * Call after any ownership or development change.
 */
export function refreshBonuses(board) {
  const bonuses = computeBonuses(board);
  const protection = computeProtection(board);
  for (const block of board.blocks) {
    const list = bonuses.get(block.id);
    block.bonuses = list;
    block.bonusIncome = list.reduce((sum, b) => sum + b.amount, 0);
    block.protectedBy = protection.get(block.id);
  }
  // Strategic effects (core/strategy.js), stored for display after everything above is settled.
  for (const block of board.blocks) {
    const prestige = blockPrestige(board, block);
    block.prestige = prestige.points;
    block.prestigeNotes = prestige.notes;
    block.control = controlStrength(board, block).control;
  }
  return board;
}

/** Whether this block is inside a civic protection radius for emergency mitigation. */
export const isProtected = (block) => (block.protectedBy?.length ?? 0) > 0;

export function bonusIncomeFor(board, seat) {
  return board.blocks
    .filter((b) => b.ownerSeat === seat)
    .reduce((sum, b) => sum + (Number.isSafeInteger(b.bonusIncome) && b.bonusIncome > 0 ? b.bonusIncome : 0), 0);
}
