/**
 * Economy rules. All numbers come from ECONOMY in config.js.
 *
 * Money safety: every change to a player's cash goes through credit()/debit(),
 * which accept only finite, non-negative whole-dollar amounts and never let a
 * balance drop below zero or become NaN. Each change is logged in game.ledger.
 */
import { ECONOMY } from '../config.js';
import { blocksOwnedBy } from './board.js';

export const MONEY_ERRORS = Object.freeze({
  INSUFFICIENT_FUNDS: 'insufficient-funds',
});

/** Why a ledger entry happened. */
export const TXN = Object.freeze({
  CAPTURE: 'capture',
  TURN_INCOME: 'turn-income',
  BUILD: 'build',
  UPGRADE: 'upgrade',
});

const cashFormat = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

export function formatCash(amount) {
  return cashFormat.format(Number.isFinite(amount) ? amount : 0);
}

/** Signed format for deltas: "+$500" / "−$1,000". */
export function formatDelta(amount) {
  return `${amount < 0 ? '−' : '+'}${formatCash(Math.abs(amount))}`;
}

export function isValidAmount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Validates an amount, throwing on NaN / Infinity / negatives / fractions / non-numbers. */
export function toAmount(value) {
  if (!isValidAmount(value)) throw new RangeError(`Invalid money amount: ${String(value)}`);
  return value;
}

export function isValidBalance(player) {
  return isValidAmount(player?.cash);
}

function record(game, player, delta, reason, meta) {
  const entry = { seat: player.seat, delta, balance: player.cash, reason, round: game.round, ...meta };
  game.ledger.push(entry);
  return entry;
}

/** Adds money. Returns the ledger entry (or null for a $0 credit). */
export function credit(game, player, amount, reason, meta = {}) {
  toAmount(amount);
  if (!isValidBalance(player)) throw new RangeError(`Corrupt balance for seat ${player?.seat}`);
  if (amount === 0) return null;
  const next = player.cash + amount;
  toAmount(next); // guards against overflow past MAX_SAFE_INTEGER
  player.cash = next;
  return record(game, player, amount, reason, meta);
}

/**
 * Removes money if the player can afford it. Never goes negative.
 * Returns { ok: true, entry } or { ok: false, error }.
 */
export function debit(game, player, amount, reason, meta = {}) {
  toAmount(amount);
  if (!isValidBalance(player)) throw new RangeError(`Corrupt balance for seat ${player?.seat}`);
  if (amount > player.cash) return { ok: false, error: MONEY_ERRORS.INSUFFICIENT_FUNDS };
  if (amount === 0) return { ok: true, entry: null };
  player.cash -= amount;
  return { ok: true, entry: record(game, player, -amount, reason, meta) };
}

export function canAfford(player, cost) {
  return isValidAmount(cost) && isValidBalance(player) && player.cash >= cost;
}

/**
 * Recurring income a block pays its owner at the start of each of their turns.
 * Reads the income stored on the block by core/development.js; a corrupted
 * value counts as $0 rather than poisoning totals with NaN.
 */
export function blockIncome(block) {
  if (block.ownerSeat == null) return 0;
  return isValidAmount(block.income) ? block.income : 0;
}

/** Income the player will collect at the start of their next turn. */
export function calculateIncome(board, seat) {
  return blocksOwnedBy(board, seat).reduce((sum, block) => sum + blockIncome(block), 0);
}

/** Stored block value: land price + everything invested in development. */
export function blockValue(block) {
  return isValidAmount(block.value) ? block.value : block.price;
}

/** Net property value: land + development of everything a player owns. */
export function propertyValue(board, seat) {
  return blocksOwnedBy(board, seat).reduce((sum, block) => sum + blockValue(block), 0);
}

export function netWorth(game, player) {
  return player.cash + propertyValue(game.board, player.seat);
}

/** Pays the capture reward for each claimed block. Returns the total paid. */
export function payCaptureReward(game, player, blockIds) {
  const total = ECONOMY.CAPTURE_REWARD * blockIds.length;
  credit(game, player, total, TXN.CAPTURE, { blocks: [...blockIds] });
  return total;
}

/** Pays a player's developed-block income as their turn begins. Returns the amount. */
export function payTurnIncome(game, player) {
  const amount = calculateIncome(game.board, player.seat);
  credit(game, player, amount, TXN.TURN_INCOME);
  return amount;
}
