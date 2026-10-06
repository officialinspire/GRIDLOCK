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
 *              restart with recovery capital (FINANCE.RECOVERY: shrinking each
 *              time, never $0). Each bankruptcy adds a growing final-score
 *              penalty (FINANCE.BANKRUPTCY_PENALTY). The match always goes on.
 *   abandoned  other players buy the land and either restore the ruin or clear
 *              it to rebuild. Former owners can't buy their own ruins back. The
 *              new owner's block is shielded from takeovers until they have
 *              completed their next turn (TAKEOVER.ACQUIRE_SHIELD_TURNS).
 *
 * Turn phases: voluntary sales/downgrades and redevelopment (purchases and
 * auctions) happen only in the current mayor's Manage City and, in the CITY era,
 * cost one City Action. Debt recovery (selling while in distress) and
 * bankruptcy are mandatory, so they are free and never phase-gated.
 *
 * Hostile takeovers of owned blocks are a separate system: core/takeover.js.
 *
 * Loop safety: bankruptcy leaves the player owning nothing, so they owe no
 * upkeep (queued repair bills are dropped too) and can't fall back into distress
 * until they buy again; they can't re-buy their own ruins; recovery capital
 * shrinks and the score penalty grows with every bankruptcy.
 */
import { ECONOMY } from '../config.js';
import { getBlockById, blocksOwnedBy } from './board.js';
import { refreshBonuses } from './bonuses.js';
import { TABLE, applyDevelopment, isDeveloped } from './development.js';
import {
  credit, debit, canAfford, investedIn, isInDistress, recoveryCapital, bankruptcyPenalty, TXN,
} from './economy.js';
import {
  currentPlayer, PHASES, TURN_PHASES, outOfCityActions, spendCityAction,
} from './game.js';
import { shieldOwnersTurns } from './takeover.js';

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
  NO_ACTIONS: 'no-city-actions', // CITY era: this turn's City Actions are spent
  WRONG_PHASE: 'wrong-turn-phase', // voluntary finance actions need Manage City
  BAD_BID: 'bad-bid', // not a whole-dollar bid at the reserve plus a multiple of the increment, or a second bid
  NOT_BIDDER: 'not-a-bidder', // no such mayor at the table
  NO_BIDS: 'no-valid-bids', // an auction everyone passed (or nobody could pay): nothing happens
});

/**
 * A voluntary finance action (sale, downgrade, redevelopment) for the current mayor: only in
 * Manage City, and in the CITY era only with a City Action left. Returns an error code or null.
 */
function voluntaryCheck(game) {
  if (game.turnPhase !== TURN_PHASES.MANAGE_CITY) return FIN_ERRORS.WRONG_PHASE;
  if (outOfCityActions(game)) return FIN_ERRORS.NO_ACTIONS;
  return null;
}

const pct = (amount, percent) => Math.round((amount * percent) / 100);

/* ---------------- selling / downgrading ---------------- */

function ownerCheck(game, block) {
  if (game.phase !== PHASES.PLAYING) return FIN_ERRORS.GAME_OVER;
  if (!block) return FIN_ERRORS.NO_BLOCK;
  if (block.ownerSeat == null || block.ownerSeat !== currentPlayer(game).seat) return FIN_ERRORS.NOT_OWNER;
  if (!isDeveloped(block)) return FIN_ERRORS.NOT_DEVELOPED;
  // Selling to clear debt is mandatory: free, in any phase. A voluntary sale is a Manage City
  // action and, in the CITY era, costs a City Action.
  if (isInDistress(currentPlayer(game))) return null;
  return voluntaryCheck(game);
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
  if (!isInDistress(player)) spendCityAction(game);
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
    // What declaring bankruptcy now would mean: recovery capital, and the final-score penalty
    // added by this bankruptcy (cumulative penalties grow with each one).
    recoveryCapital: recoveryCapital(player.bankruptcies),
    penaltyAfter: bankruptcyPenalty(player.bankruptcies + 1),
    penaltyAdded: {
      cityValue: bankruptcyPenalty(player.bankruptcies + 1).cityValue - bankruptcyPenalty(player.bankruptcies).cityValue,
      prestige: bankruptcyPenalty(player.bankruptcies + 1).prestige - bankruptcyPenalty(player.bankruptcies).prestige,
    },
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
    block.shieldedUntil = null; // a ruin is auctioned, never taken over
    block.shieldSeat = null;
    abandoned.push(block.id);
  }
  refreshBonuses(game.board);
  // Nothing left to repair: drop any queued event repair bills so they can't restart the debt.
  game.events.repairs = game.events.repairs.filter((repair) => repair.seat !== player.seat);

  // Write off the debt, then grant recovery capital (shrinking with each bankruptcy, never $0).
  credit(game, player, status.debt, TXN.DEBT_WRITE_OFF);
  const capital = status.recoveryCapital;
  credit(game, player, capital, TXN.FRESH_START);
  player.bankruptcies += 1;
  player.lastBankruptcyRound = game.round;

  // The player stays in the game: same turn, same phase (Manage City), now solvent.
  const penalty = bankruptcyPenalty(player.bankruptcies);
  const nextCapital = recoveryCapital(player.bankruptcies);
  const entry = {
    type: 'bankruptcy', seat: player.seat, round: game.round, era: game.era, count: player.bankruptcies,
    debt: status.debt, abandoned, capital, penalty, nextCapital,
  };
  game.log.push(entry);
  game.lastBankruptcy = { ...entry };
  return { ok: true, seat: player.seat, abandoned, debtForgiven: status.debt, capital, count: player.bankruptcies, penalty, nextCapital };
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
  const notNow = voluntaryCheck(game);
  if (notNow) return { ...base, error: notNow };

  const { land, restore, reserve: cost } = redevelopmentPrice(block, mode);
  const quote = { ...base, cost, land, restore };
  if (!canAfford(player, cost)) return { ...quote, error: FIN_ERRORS.INSUFFICIENT_FUNDS, shortfall: cost - player.cash };
  return { ...quote, ok: true };
}

/**
 * Why the current mayor can't open bidding on `blockId` right now (null: they can). The same
 * checks resolution makes, so an auction that opens can always be settled: opening changes
 * nothing, and an auction everyone passes settles with no effect (no action spent), so it can
 * never leave a turn stuck.
 */
export function auctionOpenError(game, blockId, mode) {
  const block = getBlockById(game.board, blockId);
  if (game.phase !== PHASES.PLAYING) return FIN_ERRORS.GAME_OVER;
  if (!block?.abandoned || block.ownerSeat != null) return FIN_ERRORS.NOT_ABANDONED;
  if (!Object.values(ACQUIRE_MODES).includes(mode)) return FIN_ERRORS.BAD_MODE;
  if (mode === ACQUIRE_MODES.RESTORE && !isDeveloped(block)) return FIN_ERRORS.NOT_DEVELOPED;
  // Opening an auction is the current mayor's Manage City action (a City Action in the CITY
  // era), whoever wins it, and like any purchase it waits until their debt is cleared.
  if (isInDistress(currentPlayer(game))) return FIN_ERRORS.IN_DISTRESS;
  return voluntaryCheck(game);
}

/**
 * Everyone who may bid on `blockId`, in turn order starting from the current mayor (the opener
 * bids first if eligible): former owners and mayors in debt sit out.
 */
export function auctionBidders(game, blockId) {
  const block = getBlockById(game.board, blockId);
  if (!block) return [];
  const eligible = new Set(eligibleRedevelopers(game, block).map((p) => p.seat));
  const n = game.players.length;
  return Array.from({ length: n }, (_, k) => game.players[(game.turnIndex + k) % n]).filter((p) => eligible.has(p.seat));
}

/** Why `bid` from `seat` can't count (null: it's valid). `bid` null or undefined is a pass, always allowed. */
export function validateAuctionBid(game, blockId, mode, seat, bid) {
  const block = getBlockById(game.board, blockId);
  const player = game.players.find((p) => p.seat === seat);
  if (!block) return FIN_ERRORS.NO_BLOCK;
  if (!player) return FIN_ERRORS.NOT_BIDDER;
  if (bid == null) return null;
  if (!FIN.FORMER_OWNER_MAY_BUY && block.abandonedBy === player.seat) return FIN_ERRORS.FORMER_OWNER;
  if (isInDistress(player)) return FIN_ERRORS.IN_DISTRESS;
  const { reserve } = redevelopmentPrice(block, mode);
  if (!Number.isSafeInteger(bid) || bid < reserve || (bid - reserve) % FIN.REDEVELOPMENT.MIN_BID_INCREMENT !== 0) return FIN_ERRORS.BAD_BID;
  if (!canAfford(player, bid)) return FIN_ERRORS.INSUFFICIENT_FUNDS;
  return null;
}

/**
 * One mayor's private bidding terms: { ok, error?, reserve, land, restore, increment, cash,
 * maxBid, canBid, canPass }. maxBid is the largest valid bid they can afford (null if they
 * can't meet the reserve, when passing is their only choice). Passing is always allowed.
 */
export function auctionTerms(game, blockId, mode, seat) {
  const block = getBlockById(game.board, blockId);
  const player = game.players.find((p) => p.seat === seat);
  if (!block || !player || !Object.values(ACQUIRE_MODES).includes(mode)) {
    return { ok: false, error: !player ? FIN_ERRORS.NOT_BIDDER : !block ? FIN_ERRORS.NO_BLOCK : FIN_ERRORS.BAD_MODE };
  }
  const { land, restore, reserve } = redevelopmentPrice(block, mode);
  const increment = FIN.REDEVELOPMENT.MIN_BID_INCREMENT;
  const barred = (!FIN.FORMER_OWNER_MAY_BUY && block.abandonedBy === seat) ? FIN_ERRORS.FORMER_OWNER
    : isInDistress(player) ? FIN_ERRORS.IN_DISTRESS : null;
  const maxBid = !barred && player.cash >= reserve ? reserve + Math.floor((player.cash - reserve) / increment) * increment : null;
  return {
    ok: !barred, ...(barred && { error: barred }), reserve, land, restore, increment, cash: player.cash,
    maxBid, canBid: maxBid != null, canPass: true,
  };
}

/**
 * Resolve a fast sealed-bid redevelopment contest. Invalid, unaffordable and
 * former-owner bids are reported but cannot win. Highest bid wins; configured
 * seat order resolves ties deterministically (`tied` says it did). With no valid
 * bid nothing happens ({ ok:false, error: NO_BIDS }) and no action is spent.
 */
export function resolveRedevelopmentAuction(game, blockId, mode, bids) {
  const block = getBlockById(game.board, blockId);
  const notOpen = auctionOpenError(game, blockId, mode);
  if (notOpen) return { ok: false, error: notOpen };
  const { land, restore, reserve } = redevelopmentPrice(block, mode);
  const rejected = [];
  const valid = [];
  const seen = new Set();
  for (const offer of Array.isArray(bids) ? bids : []) {
    const player = game.players.find((p) => p.seat === offer?.seat);
    const bid = offer?.bid;
    if (bid == null && player && !seen.has(player.seat)) { seen.add(player.seat); continue; } // a pass
    const error = !player ? FIN_ERRORS.NOT_BIDDER
      : seen.has(player.seat) ? FIN_ERRORS.BAD_BID
        : validateAuctionBid(game, blockId, mode, player.seat, bid);
    seen.add(player?.seat);
    if (error) rejected.push({ seat: offer?.seat, bid, error });
    else valid.push({ player, bid });
  }
  if (!valid.length) return { ok: false, error: FIN_ERRORS.NO_BIDS, reserve, land, restore, rejected };
  const seatOrder = FIN.REDEVELOPMENT.TIE_BREAKER === 'highest-seat' ? -1 : 1;
  valid.sort((a, b) => b.bid - a.bid || seatOrder * (a.player.seat - b.player.seat));
  const winner = valid[0];
  const tied = valid.filter((v) => v.bid === winner.bid).length > 1;
  spendCityAction(game);
  debit(game, winner.player, winner.bid, TXN.ACQUIRE, { block: block.id, mode, auction: true });
  block.ownerSeat = winner.player.seat;
  block.abandoned = false;
  block.abandonedBy = null;
  if (mode === ACQUIRE_MODES.REBUILD) applyDevelopment(block, 'vacant', 0);
  shieldOwnersTurns(game, block, winner.player.seat);
  refreshBonuses(game.board);
  game.lastDevelopment = { block: block.id, seat: winner.player.seat, type: block.type, level: block.level, acquired: mode };
  game.log.push({ type: 'redevelopment-auction', seat: winner.player.seat, block: block.id, mode, bid: winner.bid, bids: valid.length });
  return {
    ok: true, block: block.id, mode, winnerSeat: winner.player.seat, cost: winner.bid, reserve, land, restore, rejected,
    shieldedUntil: block.shieldedUntil, tied, bidCount: valid.length,
  };
}

/** Buys an abandoned block for the current player and restores or clears it. */
export function acquireAbandoned(game, blockId, mode) {
  const quote = quoteAcquire(game, blockId, mode);
  if (!quote.ok) return quote;
  const block = getBlockById(game.board, blockId);
  const player = currentPlayer(game);
  const paid = debit(game, player, quote.cost, TXN.ACQUIRE, { block: block.id, mode });
  if (!paid.ok) return { ...quote, ok: false, error: FIN_ERRORS.INSUFFICIENT_FUNDS };
  spendCityAction(game);

  block.ownerSeat = player.seat;
  block.abandoned = false;
  block.abandonedBy = null;
  if (mode === ACQUIRE_MODES.REBUILD) applyDevelopment(block, 'vacant', 0);
  shieldOwnersTurns(game, block, player.seat);
  refreshBonuses(game.board);
  game.lastDevelopment = { block: block.id, seat: player.seat, type: block.type, level: block.level, acquired: mode };
  game.log.push({ type: 'acquire', seat: player.seat, block: block.id, mode, cost: quote.cost });
  return { ok: true, block: block.id, mode, cost: quote.cost, type: block.type, level: block.level, shieldedUntil: block.shieldedUntil };
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
