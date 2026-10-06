/**
 * Hostile redevelopment: taking over a rival's block in the CITY era. Numbers live in
 * ECONOMY.TAKEOVER (config.js); the strengths (controlStrength, developmentPressure) are pure
 * reads in core/strategy.js. Abandoned-property auctions stay in core/finance.js; this module
 * reuses the same money helpers (debit/credit with a ledger reason) and ownership refresh.
 *
 * Rules:
 *   - CITY era, in the attacker's Manage City, never while the attacker is in debt.
 *   - Only an owned, active rival block, not shielded by a recent takeover.
 *   - Pressure must be greater than the block's control.
 *   - Costs one City Action; at most PER_TURN takeovers per player turn.
 *   - The attacker pays PREMIUM_PERCENT of the block's market value; the defender receives the
 *     market value; the premium is lost to redevelopment and transaction costs.
 *   - The development moves with the block. It is then shielded until SHIELD_ROUNDS full rounds
 *     have passed (the rest of this round and the next one, by default).
 *   - A block bought out of abandonment (core/finance.js) is shielded until its new owner has
 *     completed ACQUIRE_SHIELD_TURNS turns of their own (shieldOwnersTurns below).
 *
 * Shield state on a block: `shieldedUntil` (a round) and `shieldSeat`. With no shieldSeat the
 * block is protected through the end of round shieldedUntil; with one, only until that seat
 * finishes its turn in round shieldedUntil.
 */
import { ECONOMY } from '../config.js';
import { getBlockById } from './board.js';
import { refreshBonuses } from './bonuses.js';
import { credit, debit, canAfford, isInDistress, TXN } from './economy.js';
import {
  currentPlayer, getPlayer, outOfCityActions, spendCityAction, PHASES, TURN_PHASES, ERAS,
} from './game.js';
import { controlStrength, developmentPressure } from './strategy.js';
import { measure } from './perf.js';
import { readCached } from './passCache.js';

const T = ECONOMY.TAKEOVER;

export const TAKEOVER_ERRORS = Object.freeze({
  GAME_OVER: 'game-over',
  NO_BLOCK: 'no-such-block',
  NOT_RIVAL: 'not-rival-block',
  NOT_CITY_ERA: 'not-city-era',
  WRONG_PHASE: 'wrong-turn-phase',
  IN_DISTRESS: 'in-distress',
  ONE_PER_TURN: 'one-takeover-per-turn',
  SHIELDED: 'recently-taken-over',
  CONTROL_HOLDS: 'control-holds',
  NO_ACTIONS: 'no-city-actions',
  INSUFFICIENT_FUNDS: 'insufficient-funds',
});

/** Why a takeover isn't possible, in words (build panel, inspector, CPU notes). */
export const TAKEOVER_REASONS = Object.freeze({
  [TAKEOVER_ERRORS.GAME_OVER]: 'The game is over.',
  [TAKEOVER_ERRORS.NO_BLOCK]: 'That block does not exist.',
  [TAKEOVER_ERRORS.NOT_RIVAL]: 'Only a rival\'s owned block can be taken over.',
  [TAKEOVER_ERRORS.NOT_CITY_ERA]: 'Takeovers open in the City era, once every road is paved.',
  [TAKEOVER_ERRORS.WRONG_PHASE]: 'Take over blocks during your City turn.',
  [TAKEOVER_ERRORS.IN_DISTRESS]: 'Clear your debt before a takeover.',
  [TAKEOVER_ERRORS.ONE_PER_TURN]: `Only ${T.PER_TURN} takeover per turn.`,
  [TAKEOVER_ERRORS.SHIELDED]: 'Recently changed hands: protected from takeovers for now.',
  [TAKEOVER_ERRORS.CONTROL_HOLDS]: 'Not enough pressure: your adjacent development must beat the owner\'s control.',
  [TAKEOVER_ERRORS.NO_ACTIONS]: 'No City Actions left this turn.',
  [TAKEOVER_ERRORS.INSUFFICIENT_FUNDS]: 'Not enough cash for the takeover.',
});

const pct = (amount, percent) => Math.round((amount * percent) / 100);

/** True while a block that recently changed hands can't be taken over. */
export function isShielded(game, block) {
  const until = block.shieldedUntil;
  if (until == null || game.round > until) return false;
  if (game.round < until || block.shieldSeat == null) return true;
  // Last shielded round: protected until the shield seat has finished its turn in it.
  const ownerTurn = game.players.findIndex((p) => p.seat === block.shieldSeat);
  return game.turnIndex <= ownerTurn;
}

/**
 * Shields `block` for `seat` (its new owner) until they have completed `turns` turns of their
 * own after the current one. Sets shieldedUntil to the round of the last of those turns and
 * shieldSeat to `seat`; 0 turns clears the shield. Returns the block.
 */
export function shieldOwnersTurns(game, block, seat, turns = T.ACQUIRE_SHIELD_TURNS) {
  const ownerTurn = game.players.findIndex((p) => p.seat === seat);
  if (!Number.isSafeInteger(turns) || turns <= 0 || ownerTurn < 0) {
    block.shieldedUntil = null;
    block.shieldSeat = null;
    return block;
  }
  // Their next turn is later this round if they sit after the current mayor, else next round.
  const nextTurnRound = game.round + (ownerTurn > game.turnIndex ? 0 : 1);
  block.shieldedUntil = nextTurnRound + turns - 1;
  block.shieldSeat = seat;
  return block;
}

/** Shield state for the inspector: null, or { untilRound, seat } (seat null: the whole round). */
export function shieldStatus(game, block) {
  return isShielded(game, block) ? { untilRound: block.shieldedUntil, seat: block.shieldSeat ?? null } : null;
}

/** Takeovers the current player has made this turn. */
export const takeoversThisTurn = (game) => game.city?.takeovers ?? 0;

/**
 * Everything about taking `blockId` over for the current player, with the first reason it's
 * refused: { ok, error?, reason?, blockId, owner, marketValue, premium, cost, pressure,
 * pressureParts, control, controlParts, shieldedUntil, shortfall }. The figures are filled in
 * for any rival block, so the UI can show them next to the reason.
 */
export function quoteTakeover(game, blockId) {
  return readCached(game, `takeover|${blockId}`, () => quoteFor(game, blockId));
}

function quoteFor(game, blockId) {
  const block = getBlockById(game.board, blockId);
  const quote = {
    ok: false, blockId, owner: null, marketValue: 0, premium: 0, cost: 0,
    pressure: 0, pressureParts: null, control: 0, controlParts: null, shieldedUntil: null, shortfall: 0,
  };
  const refuse = (error) => ({ ...quote, error, reason: TAKEOVER_REASONS[error] });
  if (game.phase !== PHASES.PLAYING) return refuse(TAKEOVER_ERRORS.GAME_OVER);
  if (!block) return refuse(TAKEOVER_ERRORS.NO_BLOCK);
  const player = currentPlayer(game);
  if (block.ownerSeat == null || block.abandoned || block.ownerSeat === player.seat) return refuse(TAKEOVER_ERRORS.NOT_RIVAL);

  const { pressure, parts: pressureParts } = developmentPressure(game.board, player.seat, block);
  const { control, parts: controlParts } = controlStrength(game.board, block);
  const marketValue = block.marketValue;
  const cost = pct(marketValue, T.PREMIUM_PERCENT);
  Object.assign(quote, {
    owner: block.ownerSeat, marketValue, cost, premium: cost - marketValue,
    pressure, pressureParts, control, controlParts, shieldedUntil: block.shieldedUntil ?? null,
  });

  if (game.era !== ERAS.CITY) return refuse(TAKEOVER_ERRORS.NOT_CITY_ERA);
  if (game.turnPhase !== TURN_PHASES.MANAGE_CITY) return refuse(TAKEOVER_ERRORS.WRONG_PHASE);
  if (isInDistress(player)) return refuse(TAKEOVER_ERRORS.IN_DISTRESS);
  if (takeoversThisTurn(game) >= T.PER_TURN) return refuse(TAKEOVER_ERRORS.ONE_PER_TURN);
  if (isShielded(game, block)) return refuse(TAKEOVER_ERRORS.SHIELDED);
  if (pressure <= control) return refuse(TAKEOVER_ERRORS.CONTROL_HOLDS);
  if (outOfCityActions(game)) return refuse(TAKEOVER_ERRORS.NO_ACTIONS);
  if (!canAfford(player, cost)) return { ...refuse(TAKEOVER_ERRORS.INSUFFICIENT_FUNDS), shortfall: cost - player.cash };
  return { ...quote, ok: true };
}

/**
 * Takes `blockId` over for the current player. Returns the refused quote, or
 * { ok:true, block, from, cost, marketValue, premium, pressure, control, type, level, shieldedUntil }.
 */
export function takeoverBlock(game, blockId) {
  const quote = quoteTakeover(game, blockId);
  if (!quote.ok) return quote;
  const block = getBlockById(game.board, blockId);
  const attacker = currentPlayer(game);
  const defender = getPlayer(game, quote.owner);
  const paid = debit(game, attacker, quote.cost, TXN.TAKEOVER, { block: block.id, from: defender.seat, premium: quote.premium });
  if (!paid.ok) return { ...quote, ok: false, error: TAKEOVER_ERRORS.INSUFFICIENT_FUNDS, reason: TAKEOVER_REASONS[TAKEOVER_ERRORS.INSUFFICIENT_FUNDS] };
  credit(game, defender, quote.marketValue, TXN.TAKEOVER, { block: block.id, to: attacker.seat });
  spendCityAction(game);
  game.city.takeovers = takeoversThisTurn(game) + 1;

  block.ownerSeat = attacker.seat;
  block.shieldedUntil = game.round + T.SHIELD_ROUNDS;
  block.shieldSeat = null; // whole rounds
  refreshBonuses(game.board);

  game.lastDevelopment = { block: block.id, seat: attacker.seat, type: block.type, level: block.level, takeover: defender.seat };
  game.log.push({
    type: 'takeover', round: game.round, seat: attacker.seat, from: defender.seat, block: block.id, label: block.label,
    category: block.type, level: block.level,
    cost: quote.cost, marketValue: quote.marketValue, premium: quote.premium, pressure: quote.pressure, control: quote.control,
  });
  return {
    ok: true, block: block.id, from: defender.seat, cost: quote.cost, marketValue: quote.marketValue, premium: quote.premium,
    pressure: quote.pressure, control: quote.control, type: block.type, level: block.level, shieldedUntil: block.shieldedUntil,
  };
}

/** Rival blocks the current player's pressure beats right now, with their quotes (any may still be refused). */
export function takeoverCandidates(game) {
  return readCached(game, 'takeover-candidates', () => candidatesFor(game));
}

function candidatesFor(game) {
  const me = currentPlayer(game);
  return game.board.blocks
    .filter((b) => b.ownerSeat != null && !b.abandoned && b.ownerSeat !== me.seat)
    .map((b) => quoteTakeover(game, b.id))
    .filter((q) => q.pressure > q.control);
}

/**
 * The CITY VIEW overlay for `seat` (normally the person at the device): block ids by what they
 * mean for that mayor right now. Each block lands in at most one list, in this order:
 *   abandoned  ruins up for redevelopment (either era)
 *   shielded   recently changed hands: no takeover for now (isShielded)
 *   targets    CITY era: rival blocks whose control this mayor's pressure beats (takeover candidates;
 *              one per turn and a City Action may still stand in the way)
 *   atRisk     CITY era: this mayor's own blocks some rival's pressure beats
 */
export function influenceMap(game, seat = currentPlayer(game)?.seat) {
  return measure('influenceMap', () => readCached(game, `influence|${seat}`, () => mapInfluence(game, seat)));
}

function mapInfluence(game, seat) {
  const out = { targets: [], atRisk: [], shielded: [], abandoned: [] };
  const city = game.era === ERAS.CITY && game.phase === PHASES.PLAYING;
  const rivals = game.players.map((p) => p.seat).filter((s) => s !== seat);
  for (const block of game.board.blocks) {
    if (block.abandoned) { out.abandoned.push(block.id); continue; }
    if (block.ownerSeat == null) continue;
    if (isShielded(game, block)) { out.shielded.push(block.id); continue; }
    if (!city) continue;
    const { control } = controlStrength(game.board, block);
    if (block.ownerSeat !== seat) {
      if (developmentPressure(game.board, seat, block).pressure > control) out.targets.push(block.id);
    } else if (rivals.some((r) => developmentPressure(game.board, r, block).pressure > control)) {
      out.atRisk.push(block.id);
    }
  }
  return out;
}
