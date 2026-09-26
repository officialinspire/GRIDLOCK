/**
 * Economy rules. All numbers come from ECONOMY in config.js.
 *
 * Money safety: every change to a player's cash goes through credit()/debit()/
 * charge(), which accept only finite, non-negative whole-dollar amounts and
 * never produce NaN. Voluntary spending (debit) can't overdraw; only mandatory
 * charges (upkeep) can push a balance below $0, which puts the player into
 * financial distress (core/finance.js). Each change is logged in game.ledger.
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
  UPKEEP: 'upkeep',
  SALE: 'sale',
  DEBT_WRITE_OFF: 'debt-write-off',
  FRESH_START: 'fresh-start',
  ACQUIRE: 'acquire',
});

const cashFormat = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

export function formatCash(amount) {
  return cashFormat.format(Number.isFinite(amount) ? amount : 0);
}

/** Short money for tight HUDs: $950, $12.5k, $1.2M. */
export function formatCashShort(amount) {
  const n = Number.isFinite(amount) ? amount : 0;
  const sign = n < 0 ? '−' : '';
  const a = Math.abs(n);
  if (a < 1000) return `${sign}$${a}`;
  if (a < 1e6) return `${sign}$${(a / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${sign}$${(a / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
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

/** Balances are whole dollars; negative only while in financial distress. */
export function isValidBalance(player) {
  return typeof player?.cash === 'number' && Number.isSafeInteger(player.cash);
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
  if (!Number.isSafeInteger(next)) throw new RangeError('Balance overflow');
  player.cash = next;
  return record(game, player, amount, reason, meta);
}

/**
 * Mandatory charge (upkeep): always applied, may take the balance below $0.
 * Returns the ledger entry (or null for $0).
 */
export function charge(game, player, amount, reason, meta = {}) {
  toAmount(amount);
  if (!isValidBalance(player)) throw new RangeError(`Corrupt balance for seat ${player?.seat}`);
  if (amount === 0) return null;
  const next = player.cash - amount;
  if (!Number.isSafeInteger(next)) throw new RangeError('Balance overflow');
  player.cash = next;
  return record(game, player, -amount, reason, meta);
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
  return isValidAmount(cost) && isValidBalance(player) && player.cash >= 0 && player.cash >= cost;
}

/** Financial distress = negative cash. Derived, so it can never go stale. */
export const isInDistress = (player) => isValidBalance(player) && player.cash < 0;

/** Development cost sunk into a block (value minus land). */
export function investedIn(block) {
  const v = blockValue(block) - block.price;
  return v > 0 ? v : 0;
}

/** Upkeep an owned, active block costs at the start of its owner's turn: land tax + development upkeep. */
export function blockUpkeep(block) {
  if (block.ownerSeat == null || block.abandoned) return 0;
  const { LAND_TAX_PERCENT, UPKEEP_PERCENT } = ECONOMY.FINANCE;
  return Math.round((block.price * LAND_TAX_PERCENT) / 100) + Math.round((investedIn(block) * UPKEEP_PERCENT) / 100);
}

export function upkeepFor(board, seat) {
  return blocksOwnedBy(board, seat).reduce((sum, b) => sum + blockUpkeep(b), 0);
}

/** Charges a player's upkeep as their turn begins (after income). Returns the amount. */
export function chargeUpkeep(game, player) {
  const amount = upkeepFor(game.board, player.seat);
  charge(game, player, amount, TXN.UPKEEP);
  return amount;
}

/** Base income for the block's development level (no bonuses). */
export function baseIncome(block) {
  if (block.ownerSeat == null) return 0;
  return isValidAmount(block.income) ? block.income : 0;
}

/** Adjacency/district bonus income stored by core/bonuses.js. */
export function bonusIncome(block) {
  if (block.ownerSeat == null) return 0;
  return isValidAmount(block.bonusIncome) ? block.bonusIncome : 0;
}

/**
 * Recurring income a block pays its owner at the start of each of their turns:
 * base + bonuses. Corrupted values count as $0 rather than poisoning totals with NaN.
 */
export function blockIncome(block) {
  return baseIncome(block) + bonusIncome(block);
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

/**
 * Pays a player's turn income. `amount` is computed by the caller (game.js uses
 * events.effectiveIncome so active city events apply). Returns the amount.
 */
export function payTurnIncome(game, player, amount = calculateIncome(game.board, player.seat)) {
  credit(game, player, amount, TXN.TURN_INCOME);
  return amount;
}
