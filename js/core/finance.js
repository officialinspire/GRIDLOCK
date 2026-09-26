/**
 * Financial failure & recovery. Numbers live in ECONOMY.FINANCE (config.js).
 *
 *   distress   cash < 0 (only upkeep can cause it). The player must sell or
 *              downgrade developments before they can pave or buy anything.
 *   sell       downgrade one level, or sell the whole development, refunding
 *              SALE_REFUND_PERCENT of the development cost removed.
 *   bankruptcy allowed only when selling everything still can't clear the debt.
 *              The debt is written off, every block the player owns becomes
 *              Abandoned (ownerless; development kept but inactive), and they
 *              restart with FRESH_START_CAPITAL (first FRESH_START_LIMIT times).
 *   abandoned  other players buy the land and either restore the ruin or clear
 *              it to rebuild. Former owners can't buy their own ruins back.
 *
 * Loop safety: bankruptcy leaves the player owning nothing, so they owe no
 * upkeep and can't fall back into distress until they buy again; they can't
 * re-buy their own ruins; and fresh-start capital is capped.
 */
import { ECONOMY } from '../config.js';
import { getBlockById, blocksOwnedBy } from './board.js';
import { refreshBonuses } from './bonuses.js';
import { TABLE, applyDevelopment, isDeveloped } from './development.js';
import {
  credit, debit, canAfford, investedIn, isInDistress, TXN,
} from './economy.js';
import { currentPlayer, PHASES } from './game.js';

const FIN = ECONOMY.FINANCE;

export const FIN_ERRORS = Object.freeze({
  GAME_OVER: 'game-over',
  NO_BLOCK: 'no-such-block',
  NOT_OWNER: 'not-owner',
  NOT_DEVELOPED: 'not-developed',
  NOT_IN_DISTRESS: 'not-in-distress',
  CAN_STILL_RECOVER: 'can-still-recover',
  NOT_ABANDONED: 'not-abandoned',
  FORMER_OWNER: 'former-owner',
  IN_DISTRESS: 'in-distress',
  INSUFFICIENT_FUNDS: 'insufficient-funds',
  BAD_MODE: 'bad-mode',
});

const pct = (amount, percent) => Math.round((amount * percent) / 100);

/* ---------------- selling / downgrading ---------------- */

function ownerCheck(game, block) {
  if (game.phase !== PHASES.PLAYING) return FIN_ERRORS.GAME_OVER;
  if (!block) return FIN_ERRORS.NO_BLOCK;
  if (block.ownerSeat == null || block.ownerSeat !== currentPlayer(game).seat) return FIN_ERRORS.NOT_OWNER;
  if (!isDeveloped(block)) return FIN_ERRORS.NOT_DEVELOPED;
  return null;
}

/** Downgrade one level (Level 1 → Vacant). Refund = % of that level's cost. */
export function quoteDowngrade(game, blockId) {
  const block = getBlockById(game.board, blockId);
  const error = ownerCheck(game, block);
  if (error) return { ok: false, error, refund: 0 };
  const removed = block.constructionCosts?.at(-1) ?? TABLE[block.type][block.level].cost;
  return { ok: true, fromLevel: block.level, toLevel: block.level - 1, removed, refund: pct(removed, FIN.SALE_REFUND_PERCENT) };
}

/** Sell the whole development (→ Vacant). Refund = % of everything invested. */
export function quoteSale(game, blockId) {
  const block = getBlockById(game.board, blockId);
  const error = ownerCheck(game, block);
  if (error) return { ok: false, error, refund: 0 };
  const removed = investedIn(block);
  return { ok: true, fromLevel: block.level, toLevel: 0, removed, refund: pct(removed, FIN.SALE_REFUND_PERCENT) };
}

function commitSale(game, block, quote, kind) {
  const player = currentPlayer(game);
  const type = block.type;
  applyDevelopment(block, quote.toLevel === 0 ? 'vacant' : type, quote.toLevel, {
    constructionCosts: (block.constructionCosts ?? []).slice(0, quote.toLevel),
  });
  refreshBonuses(game.board);
  credit(game, player, quote.refund, TXN.SALE, { block: block.id, type, fromLevel: quote.fromLevel, toLevel: quote.toLevel });
  game.lastDevelopment = { block: block.id, seat: player.seat, type: block.type, level: block.level, sold: true };
  game.log.push({ type: kind, seat: player.seat, block: block.id, category: type, fromLevel: quote.fromLevel, toLevel: quote.toLevel, refund: quote.refund });
  return { ok: true, block: block.id, refund: quote.refund, level: block.level, recovered: !isInDistress(player) };
}

export function downgradeBlock(game, blockId) {
  const quote = quoteDowngrade(game, blockId);
  if (!quote.ok) return quote;
  return commitSale(game, getBlockById(game.board, blockId), quote, 'downgrade');
}

export function sellDevelopment(game, blockId) {
  const quote = quoteSale(game, blockId);
  if (!quote.ok) return quote;
  return commitSale(game, getBlockById(game.board, blockId), quote, 'sale');
}

/** Cash a player could raise by selling every development they own. */
export function liquidationValue(board, seat) {
  return blocksOwnedBy(board, seat)
    .filter(isDeveloped)
    .reduce((sum, b) => sum + pct(investedIn(b), FIN.SALE_REFUND_PERCENT), 0);
}

/* ---------------- bankruptcy ---------------- */

/** Summary for the distress UI. */
export function distressStatus(game, player = currentPlayer(game)) {
  const liquidation = liquidationValue(game.board, player.seat);
  const debt = player.cash < 0 ? -player.cash : 0;
  return {
    inDistress: isInDistress(player),
    debt,
    liquidation,
    canRecover: debt > 0 && liquidation >= debt,
    canDeclare: debt > 0 && liquidation < debt,
    freshStart: player.bankruptcies < FIN.FRESH_START_LIMIT ? FIN.FRESH_START_CAPITAL : 0,
  };
}

/**
 * Declares the current player bankrupt. Only allowed when they're in distress
 * and selling everything couldn't cover the debt.
 */
export function declareBankruptcy(game) {
  if (game.phase !== PHASES.PLAYING) return { ok: false, error: FIN_ERRORS.GAME_OVER };
  const player = currentPlayer(game);
  const status = distressStatus(game, player);
  if (!status.inDistress) return { ok: false, error: FIN_ERRORS.NOT_IN_DISTRESS };
  if (!status.canDeclare) return { ok: false, error: FIN_ERRORS.CAN_STILL_RECOVER };

  // Every block the player owns becomes Abandoned: ownerless, development kept but inactive.
  const abandoned = [];
  for (const block of blocksOwnedBy(game.board, player.seat)) {
    block.ownerSeat = null;
    block.abandoned = true;
    block.abandonedBy = player.seat;
    abandoned.push(block.id);
  }
  refreshBonuses(game.board);

  // Write off the debt, then grant fresh-start capital (capped).
  credit(game, player, status.debt, TXN.DEBT_WRITE_OFF);
  const capital = status.freshStart;
  credit(game, player, capital, TXN.FRESH_START);
  player.bankruptcies += 1;

  game.log.push({ type: 'bankruptcy', seat: player.seat, round: game.round, debt: status.debt, abandoned, capital });
  game.lastBankruptcy = { seat: player.seat, round: game.round, abandoned, debt: status.debt, capital };
  return { ok: true, seat: player.seat, abandoned, debtForgiven: status.debt, capital };
}

/* ---------------- abandoned blocks ---------------- */

export const ACQUIRE_MODES = Object.freeze({ RESTORE: 'restore', REBUILD: 'rebuild' });

function redevelopmentPrice(block, mode) {
  const land = pct(block.price, FIN.REDEVELOP_LAND_PERCENT);
  const restore = mode === ACQUIRE_MODES.RESTORE ? pct(investedIn(block), FIN.RESTORE_PERCENT) : 0;
  return { land, restore, reserve: land + restore };
}

export function quoteRedevelopment(game, blockId, mode) {
  const block = getBlockById(game.board, blockId);
  if (!block?.abandoned || block.ownerSeat != null) return { ok: false, error: FIN_ERRORS.NOT_ABANDONED };
  if (!Object.values(ACQUIRE_MODES).includes(mode)) return { ok: false, error: FIN_ERRORS.BAD_MODE };
  if (mode === ACQUIRE_MODES.RESTORE && !isDeveloped(block)) return { ok: false, error: FIN_ERRORS.NOT_DEVELOPED };
  return { ok: true, ...redevelopmentPrice(block, mode) };
}

/** Players allowed to contest a ruin; former owners and distressed players sit out. */
export function eligibleRedevelopers(game, block) {
  return game.players.filter((player) =>
    (FIN.FORMER_OWNER_MAY_BUY || block.abandonedBy !== player.seat) && !isInDistress(player));
}

/**
 * Price to take over an abandoned block:
 *   rebuild  land only (the ruin is cleared to Vacant)
 *   restore  land + RESTORE_PERCENT of the ruin's invested cost (development reactivated)
 */
export function quoteAcquire(game, blockId, mode) {
  const block = getBlockById(game.board, blockId);
  const base = { ok: false, mode, cost: 0, land: 0, restore: 0, shortfall: 0 };
  if (game.phase !== PHASES.PLAYING) return { ...base, error: FIN_ERRORS.GAME_OVER };
  if (!block) return { ...base, error: FIN_ERRORS.NO_BLOCK };
  if (!block.abandoned || block.ownerSeat != null) return { ...base, error: FIN_ERRORS.NOT_ABANDONED };
  if (!Object.values(ACQUIRE_MODES).includes(mode)) return { ...base, error: FIN_ERRORS.BAD_MODE };
  if (mode === ACQUIRE_MODES.RESTORE && !isDeveloped(block)) return { ...base, error: FIN_ERRORS.NOT_DEVELOPED };
  const player = currentPlayer(game);
  if (!FIN.FORMER_OWNER_MAY_BUY && block.abandonedBy === player.seat) return { ...base, error: FIN_ERRORS.FORMER_OWNER };
  if (isInDistress(player)) return { ...base, error: FIN_ERRORS.IN_DISTRESS };

  const { land, restore, reserve: cost } = redevelopmentPrice(block, mode);
  const quote = { ...base, cost, land, restore };
  if (!canAfford(player, cost)) return { ...quote, error: FIN_ERRORS.INSUFFICIENT_FUNDS, shortfall: cost - player.cash };
  return { ...quote, ok: true };
}

/**
 * Resolve a fast sealed-bid redevelopment contest. Invalid, unaffordable and
 * former-owner bids are reported but cannot win. Highest bid wins; configured
 * seat order resolves ties deterministically.
 */
export function resolveRedevelopmentAuction(game, blockId, mode, bids) {
  const block = getBlockById(game.board, blockId);
  if (game.phase !== PHASES.PLAYING) return { ok: false, error: FIN_ERRORS.GAME_OVER };
  if (!block?.abandoned || block.ownerSeat != null) return { ok: false, error: FIN_ERRORS.NOT_ABANDONED };
  if (!Object.values(ACQUIRE_MODES).includes(mode)) return { ok: false, error: FIN_ERRORS.BAD_MODE };
  if (mode === ACQUIRE_MODES.RESTORE && !isDeveloped(block)) return { ok: false, error: FIN_ERRORS.NOT_DEVELOPED };
  const { land, restore, reserve } = redevelopmentPrice(block, mode);
  const increment = FIN.REDEVELOPMENT.MIN_BID_INCREMENT;
  const rejected = [];
  const valid = [];
  const seen = new Set();
  for (const offer of Array.isArray(bids) ? bids : []) {
    const player = game.players.find((p) => p.seat === offer?.seat);
    const bid = offer?.bid;
    let error = null;
    if (!player || seen.has(player.seat)) error = FIN_ERRORS.BAD_MODE;
    else if (!FIN.FORMER_OWNER_MAY_BUY && block.abandonedBy === player.seat) error = FIN_ERRORS.FORMER_OWNER;
    else if (isInDistress(player)) error = FIN_ERRORS.IN_DISTRESS;
    else if (!Number.isSafeInteger(bid) || bid < reserve || (bid - reserve) % increment !== 0) error = FIN_ERRORS.BAD_MODE;
    else if (!canAfford(player, bid)) error = FIN_ERRORS.INSUFFICIENT_FUNDS;
    seen.add(player?.seat);
    if (error) rejected.push({ seat: offer?.seat, bid, error });
    else valid.push({ player, bid });
  }
  if (!valid.length) return { ok: false, error: FIN_ERRORS.INSUFFICIENT_FUNDS, reserve, land, restore, rejected };
  const seatOrder = FIN.REDEVELOPMENT.TIE_BREAKER === 'highest-seat' ? -1 : 1;
  valid.sort((a, b) => b.bid - a.bid || seatOrder * (a.player.seat - b.player.seat));
  const winner = valid[0];
  debit(game, winner.player, winner.bid, TXN.ACQUIRE, { block: block.id, mode, auction: true });
  block.ownerSeat = winner.player.seat;
  block.abandoned = false;
  block.abandonedBy = null;
  if (mode === ACQUIRE_MODES.REBUILD) applyDevelopment(block, 'vacant', 0);
  refreshBonuses(game.board);
  game.lastDevelopment = { block: block.id, seat: winner.player.seat, type: block.type, level: block.level, acquired: mode };
  game.log.push({ type: 'redevelopment-auction', seat: winner.player.seat, block: block.id, mode, bid: winner.bid });
  return { ok: true, block: block.id, mode, winnerSeat: winner.player.seat, cost: winner.bid, reserve, land, restore, rejected };
}

/** Buys an abandoned block for the current player and restores or clears it. */
export function acquireAbandoned(game, blockId, mode) {
  const quote = quoteAcquire(game, blockId, mode);
  if (!quote.ok) return quote;
  const block = getBlockById(game.board, blockId);
  const player = currentPlayer(game);
  const paid = debit(game, player, quote.cost, TXN.ACQUIRE, { block: block.id, mode });
  if (!paid.ok) return { ...quote, ok: false, error: FIN_ERRORS.INSUFFICIENT_FUNDS };

  block.ownerSeat = player.seat;
  block.abandoned = false;
  block.abandonedBy = null;
  if (mode === ACQUIRE_MODES.REBUILD) applyDevelopment(block, 'vacant', 0);
  refreshBonuses(game.board);
  game.lastDevelopment = { block: block.id, seat: player.seat, type: block.type, level: block.level, acquired: mode };
  game.log.push({ type: 'acquire', seat: player.seat, block: block.id, mode, cost: quote.cost });
  return { ok: true, block: block.id, mode, cost: quote.cost, type: block.type, level: block.level };
}

/* ---------------- invariants (used by tests) ---------------- */

/** Every block's ownership is consistent: owners exist, abandoned blocks are ownerless. */
export function ownershipProblems(game) {
  const seats = new Set(game.players.map((p) => p.seat));
  const problems = [];
  for (const b of game.board.blocks) {
    if (b.ownerSeat != null && !seats.has(b.ownerSeat)) problems.push(`${b.id}: unknown owner ${b.ownerSeat}`);
    if (b.abandoned && b.ownerSeat != null) problems.push(`${b.id}: abandoned but owned`);
    if (!b.abandoned && b.abandonedBy != null) problems.push(`${b.id}: stale abandonedBy`);
  }
  return problems;
}
