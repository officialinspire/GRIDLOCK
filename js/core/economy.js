/**
 * Economy rules: cash formatting, affordability and per-round income.
 * Numbers are first-pass placeholders for the foundation phase.
 */
import { blocksOwnedBy } from './board.js';
import { getBuilding } from './buildings.js';

/** Flat income every owned block pays each round, before buildings. */
export const BLOCK_BASE_INCOME = 50;

const cashFormat = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

export function formatCash(amount) {
  return cashFormat.format(amount);
}

export function blockIncome(block) {
  if (block.ownerSeat == null) return 0;
  const building = block.buildingId ? getBuilding(block.buildingId) : null;
  return BLOCK_BASE_INCOME + (building?.income ?? 0);
}

export function calculateIncome(board, seat) {
  return blocksOwnedBy(board, seat).reduce((sum, block) => sum + blockIncome(block), 0);
}

/** Total land + building value a player owns (used for scoring later). */
export function propertyValue(board, seat) {
  return blocksOwnedBy(board, seat).reduce((sum, block) => {
    const building = block.buildingId ? getBuilding(block.buildingId) : null;
    return sum + block.price + (building?.cost ?? 0);
  }, 0);
}

export function canAfford(player, cost) {
  return player.cash >= cost;
}

/** Pays every player their round income. Returns { seat: amount }. */
export function payRoundIncome(game) {
  const paid = {};
  for (const player of game.players) {
    const amount = calculateIncome(game.board, player.seat);
    player.cash += amount;
    paid[player.seat] = amount;
  }
  return paid;
}
