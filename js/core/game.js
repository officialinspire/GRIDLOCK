/**
 * Game state + turn flow. The core loop is 4-player Dots & Boxes played with
 * roads: build one road per turn; enclosing a block claims it and earns
 * another road. The game ends when every block is claimed.
 */
import { MIN_PLAYERS, MAX_PLAYERS, PLAYER_PRESETS, MAX_NAME_LENGTH, ECONOMY, DEFAULT_MODE } from '../config.js';
import { controllerOf, defaultNames } from './seats.js';
import { resolveRules } from './modes.js';
import {
  createBoard, blocksOwnedBy, isValidRoad, hasRoad, roadBlocks, isBlockEnclosed, totalRoads,
} from './board.js';
import {
  calculateIncome, propertyValue, payCaptureReward, payTurnIncome, toAmount, bonusIncome,
  chargeUpkeep, upkeepFor, isInDistress, charge, TXN,
} from './economy.js';
import { refreshBonuses } from './bonuses.js';
import { createEventState, onRoundStart, effectiveIncome, takeRepairExpenses, EVENT_POOL } from './events.js';
import { randomSeed } from './rng.js';
import { computeResults } from './scoring.js';

export const PHASES = Object.freeze({ PLAYING: 'playing', ENDED: 'ended' });
export const TURN_PHASES = Object.freeze({
  MANAGE_CITY: 'manage-city',
  PAVE_ROAD: 'pave-road',
  CAPTURE_DEVELOP: 'capture-develop',
  BONUS_ROAD: 'bonus-road',
});

/** Reasons placeRoad() can reject a move. */
export const MOVE_ERRORS = Object.freeze({
  GAME_OVER: 'game-over',
  INVALID: 'invalid-road',
  TAKEN: 'road-taken',
  IN_DISTRESS: 'in-distress',
  WRONG_PHASE: 'wrong-turn-phase',
});

export function sanitizeName(name, fallback) {
  const clean = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
  return clean || fallback;
}

/**
 * @param {{ seats: Array<{seat:number, name?:string, controller?:'human'|'cpu', difficulty?:null|'easy'|'normal'|'hard'}>, seed?: number, mode?: string, eventPool?: object[], gameType?: string, eventProbability?: number, maxActiveEvents?: number }} options
 *   `seats` lists the joined seats (1–4). Play order is always by seat number. Each seat's
 *   controller (human, or cpu with a difficulty; human by default) is stored on its player
 *   as metadata only: no rule depends on it (core/seats.js).
 *   `seed` makes city events reproducible (random by default).
 *   `mode` is a rule preset from GAME_MODES (standard | classic | chaos); its rules are
 *   copied onto the game as `game.rules`, which is all the rules engine reads.
 *   `eventPool` overrides CITY_EVENTS.POOL (e.g. [] for an event-free game in tests).
 *   `eventProbability` / `maxActiveEvents` override the mode's event pacing (tests).
 *   Economy values come from ECONOMY in config.js.
 */
export function createGame({ seats, seed = randomSeed(), mode = DEFAULT_MODE, eventPool = EVENT_POOL, gameType = 'custom', eventProbability, maxActiveEvents } = {}) {
  const rules = resolveRules(mode, { eventProbability, maxActiveEvents });
  if (gameType === 'standard' && seats?.length !== MAX_PLAYERS) {
    throw new RangeError('Standard Game requires exactly 4 players');
  }
  if (!Array.isArray(seats) || seats.length < MIN_PLAYERS || seats.length > MAX_PLAYERS) {
    throw new RangeError(`A game needs ${MIN_PLAYERS}–${MAX_PLAYERS} players`);
  }
  const seen = new Set();
  for (const s of seats) {
    if (!PLAYER_PRESETS.some((p) => p.seat === s.seat) || seen.has(s.seat)) {
      throw new RangeError(`Invalid or duplicate seat ${s.seat}`);
    }
    seen.add(s.seat);
  }

  for (const s of seats) {
    if (!controllerOf(s)) throw new RangeError(`Invalid controller for seat ${s.seat}`);
  }
  const fallbackNames = defaultNames(seats);
  const players = [...seats]
    .sort((a, b) => a.seat - b.seat)
    .map((s) => {
      const { seat, name } = s;
      const preset = PLAYER_PRESETS[seat - 1];
      return {
        seat,
        name: sanitizeName(name, fallbackNames.get(seat)),
        // Who makes this seat's moves; the rules never look at it.
        ...controllerOf(s),
        color: preset.color,
        symbol: preset.symbol,
        hex: preset.hex,
        cash: toAmount(ECONOMY.STARTING_CASH),
        bankruptcies: 0,
        lastEconomicRound: 0,
      };
    });

  const game = {
    board: createBoard(),
    players,
    round: 1,
    turnIndex: 0,
    phase: PHASES.PLAYING,
    lastMove: null,
    lastDevelopment: null,
    log: [],
    ledger: [],
    turnStartIncome: null,
    turnStartUpkeep: null,
    seed: seed >>> 0,
    rngState: seed >>> 0,
    events: createEventState(),
    results: null,
    eventPool,
    turnPhase: TURN_PHASES.MANAGE_CITY,
    pendingCaptures: [],
    mode,
    rules,
  };
  beginTurn(game);
  return game;
}

export function currentPlayer(game) {
  return game.players[game.turnIndex];
}

export function getPlayer(game, seat) {
  return game.players.find((p) => p.seat === seat) ?? null;
}

/** Everything the HUD shows for a player. `income` is paid at the start of their next turn. */
export function playerStats(game, player) {
  const property = propertyValue(game.board, player.seat);
  const owned = blocksOwnedBy(game.board, player.seat);
  const normal = calculateIncome(game.board, player.seat); // base + bonuses
  const income = effectiveIncome(game, player.seat); // with active city events
  return {
    cash: player.cash,
    blocks: owned.length,
    income,
    normalIncome: normal,
    eventDelta: income - normal,
    upkeep: upkeepFor(game.board, player.seat),
    distress: isInDistress(player),
    bankruptcies: player.bankruptcies,
    bonus: owned.reduce((sum, b) => sum + bonusIncome(b), 0),
    property,
    netWorth: player.cash + property,
  };
}

export function roadsBuilt(game) {
  return Object.keys(game.board.roads).length;
}

export function roadsRemaining(game) {
  return totalRoads(game.board) - roadsBuilt(game);
}

/** Can the current player build this road right now? Returns an error code or null. */
export function validateRoad(game, id) {
  if (game.phase !== PHASES.PLAYING) return MOVE_ERRORS.GAME_OVER;
  if (isInDistress(currentPlayer(game))) return MOVE_ERRORS.IN_DISTRESS;
  if (![TURN_PHASES.MANAGE_CITY, TURN_PHASES.PAVE_ROAD, TURN_PHASES.BONUS_ROAD].includes(game.turnPhase)) {
    return MOVE_ERRORS.WRONG_PHASE;
  }
  if (!isValidRoad(game.board, id)) return MOVE_ERRORS.INVALID;
  if (hasRoad(game.board, id)) return MOVE_ERRORS.TAKEN;
  return null;
}

/**
 * Starts the current player's turn: pays income from their developed blocks.
 * Bonus roads after a capture are part of the same turn and don't call this.
 * Returns { seat, amount }.
 */
export function beginTurn(game) {
  const player = currentPlayer(game);
  const amount = payTurnIncome(game, player, effectiveIncome(game, player.seat));
  game.turnStartIncome = { seat: player.seat, amount };
  // Upkeep is charged after income. It is the only thing that can push cash below $0
  // (financial distress — resolved via core/finance.js before the player can pave).
  game.turnStartUpkeep = { seat: player.seat, amount: chargeUpkeep(game, player), distress: isInDistress(player) };
  const repairs = takeRepairExpenses(game, player.seat);
  const repairAmount = repairs.reduce((sum, repair) => sum + repair.amount, 0);
  charge(game, player, repairAmount, TXN.EVENT_REPAIR, { blocks: repairs.map((repair) => repair.block) });
  game.turnStartRepair = { seat: player.seat, amount: repairAmount, distress: isInDistress(player) };
  player.lastEconomicRound = game.round;
  game.turnPhase = TURN_PHASES.MANAGE_CITY;
  game.pendingCaptures = [];
  return game.turnStartIncome;
}

/** The deliberate boundary between managing property and committing to a road. */
export function startPaving(game) {
  if (game.phase !== PHASES.PLAYING || game.turnPhase !== TURN_PHASES.MANAGE_CITY) return false;
  if (isInDistress(currentPlayer(game))) return false;
  game.turnPhase = TURN_PHASES.PAVE_ROAD;
  return true;
}

/** Resolve the next captured block after building now or intentionally leaving it vacant. */
export function resolveCapture(game, blockId = game.pendingCaptures[0]) {
  if (game.turnPhase !== TURN_PHASES.CAPTURE_DEVELOP || game.pendingCaptures[0] !== blockId) return false;
  game.pendingCaptures.shift();
  if (!game.pendingCaptures.length) game.turnPhase = TURN_PHASES.BONUS_ROAD;
  return true;
}

/**
 * Bring every player to the same round boundary before final scoring. Players
 * whose turn already began this round are untouched; remaining players receive
 * exactly the income and upkeep they would have received at that turn start.
 */
export function settleFinalEconomy(game) {
  const settlements = [];
  for (const player of game.players) {
    if ((player.lastEconomicRound ?? 0) >= game.round) continue;
    const income = payTurnIncome(game, player, effectiveIncome(game, player.seat));
    const upkeep = chargeUpkeep(game, player);
    const repairs = takeRepairExpenses(game, player.seat);
    const repair = repairs.reduce((sum, item) => sum + item.amount, 0);
    charge(game, player, repair, TXN.EVENT_REPAIR, { blocks: repairs.map((item) => item.block) });
    player.lastEconomicRound = game.round;
    settlements.push({ seat: player.seat, income, upkeep, repair, distress: isInDistress(player) });
  }
  game.finalSettlement = { round: game.round, players: settlements };
  return game.finalSettlement;
}

/**
 * Passes play to the next seat and begins their turn. Wrapping back to the
 * first seat starts a new round: expired city events are removed and one new
 * event is drawn *before* the first player's income is paid.
 * Returns { roundEnded, event: { expired, started } | null, turnIncome }.
 */
export function endTurn(game) {
  const summary = { roundEnded: false, event: null, turnIncome: null, turnUpkeep: null, turnRepair: null };
  game.turnIndex += 1;
  if (game.turnIndex >= game.players.length) {
    game.turnIndex = 0;
    summary.roundEnded = true;
    game.log.push({ type: 'round-end', round: game.round });
    game.round += 1;
    summary.event = onRoundStart(game, game.eventPool);
    if (summary.event.started) game.log.push({ type: 'event', round: game.round, event: summary.event.started.id });
  }
  summary.turnIncome = beginTurn(game);
  summary.turnUpkeep = game.turnStartUpkeep;
  summary.turnRepair = game.turnStartRepair;
  return summary;
}

/**
 * Builds a road for the current player.
 * - Any block this road encloses is claimed by the builder (0, 1 or 2 blocks).
 * - Claiming at least one block grants another road (same player continues).
 * - Otherwise the turn passes to the next seat.
 * - Once every road is paved (all blocks enclosed) the game ends.
 *
 * - Each claimed block pays ECONOMY.CAPTURE_REWARD to the builder.
 *
 * Returns { ok:false, error } for rejected moves, or
 * { ok:true, road, seat, captured:[blockIds], reward, extraTurn, roundEnded, turnIncome, gameEnded }.
 */
export function placeRoad(game, id) {
  // Reject malformed/taken moves without advancing a phase or resolving a
  // capture choice. This keeps failed input completely side-effect free.
  if (game.phase !== PHASES.PLAYING) return { ok: false, error: MOVE_ERRORS.GAME_OVER };
  if (isInDistress(currentPlayer(game))) return { ok: false, error: MOVE_ERRORS.IN_DISTRESS };
  if (!isValidRoad(game.board, id)) return { ok: false, error: MOVE_ERRORS.INVALID };
  if (hasRoad(game.board, id)) return { ok: false, error: MOVE_ERRORS.TAKEN };
  // Programmatic callers from before turn phases existed mean “leave captured
  // blocks vacant and continue”. The UI always resolves each choice explicitly.
  while (game.turnPhase === TURN_PHASES.CAPTURE_DEVELOP && game.pendingCaptures.length) resolveCapture(game);
  if (game.turnPhase === TURN_PHASES.MANAGE_CITY) startPaving(game);
  const error = validateRoad(game, id);
  if (error) return { ok: false, error };

  const { board } = game;
  const seat = currentPlayer(game).seat;
  board.roads[id] = seat;

  const captured = [];
  for (const block of roadBlocks(board, id)) {
    if (block.ownerSeat == null && !block.abandoned && isBlockEnclosed(board, block)) {
      block.ownerSeat = seat;
      captured.push(block.id);
    }
  }

  if (captured.length) refreshBonuses(board); // ownership changed
  const reward = captured.length ? payCaptureReward(game, currentPlayer(game), captured) : 0;

  game.lastMove = { road: id, seat, captured, reward };
  game.log.push({ type: 'road', road: id, seat, captured, reward });

  const result = {
    ok: true, road: id, seat, captured, reward,
    extraTurn: false, roundEnded: false, event: null, turnIncome: null, turnUpkeep: null, turnRepair: null, gameEnded: false,
  };

  // Every road paved = every block enclosed. (Not "every block owned": abandoned
  // blocks after a bankruptcy may stay ownerless forever.)
  if (isCityComplete(game)) {
    // Resolve the unfinished portion of the current economic round so the final
    // mover cannot decide which players miss income/upkeep, then freeze results.
    settleFinalEconomy(game);
    game.phase = PHASES.ENDED;
    game.results = computeResults(game);
    result.gameEnded = true;
  } else if (captured.length > 0) {
    result.extraTurn = true;
    game.pendingCaptures = [...captured];
    game.turnPhase = TURN_PHASES.CAPTURE_DEVELOP;
  } else {
    Object.assign(result, endTurn(game));
  }
  return result;
}

/**
 * Current standings (see core/scoring.js): ranked by City Value, then blocks,
 * developed blocks and cash; exact ties share a rank. Rows are the scoring rows
 * plus `player` (the player object) and `worth` (= City Value) for convenience.
 */
export function standings(game) {
  const results = game.results ?? computeResults(game);
  return results.rows.map((row) => ({ ...row, player: getPlayer(game, row.seat), worth: row.cityValue }));
}

/** True when every city block is enclosed (all roads paved) — the standard end. */
export function isCityComplete(game) {
  return roadsBuilt(game) === totalRoads(game.board);
}
