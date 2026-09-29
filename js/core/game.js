/**
 * Game state + turn flow. The core loop is 4-player Dots & Boxes played with
 * roads: build one road per turn; enclosing a block claims it and earns
 * another road. That is the EXPANSION era. Paving the final road starts the
 * CITY era (CITY_ERA in config.js): no more roads, a few City Actions per turn,
 * and the match ends after CITY_ERA.ROUNDS further full rounds.
 */
import {
  MIN_PLAYERS, MAX_PLAYERS, PLAYER_PRESETS, MAX_NAME_LENGTH, ECONOMY, DEFAULT_MODE, CITY_ERA,
} from '../config.js';
import { controllerOf, defaultNames, assignPersonalities } from './seats.js';
import { resolveRules } from './modes.js';
import {
  createBoard, blocksOwnedBy, isValidRoad, hasRoad, roadBlocks, isBlockEnclosed, totalRoads,
} from './board.js';
import {
  calculateIncome, propertyValue, payCaptureReward, payTurnIncome, toAmount, bonusIncome,
  chargeUpkeep, upkeepFor, isInDistress, charge, bankruptcyPenalty, recoveryCapital, TXN,
} from './economy.js';
import { refreshBonuses } from './bonuses.js';
import { prestigeFor } from './strategy.js';
import { createEventState, onRoundStart, effectiveIncome, takeRepairExpenses, EVENT_POOL } from './events.js';
import { randomSeed } from './rng.js';
import { computeResults } from './scoring.js';

export const PHASES = Object.freeze({ PLAYING: 'playing', ENDED: 'ended' });
/** Gameplay eras: road/capture play, then (once every road is paved) city management only. */
export const ERAS = Object.freeze({ EXPANSION: 'expansion', CITY: 'city' });
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
  ROADS_CLOSED: 'roads-closed', // the CITY era: every road is paved
  NOT_CITY_ERA: 'not-city-era', // endCityTurn() during EXPANSION (turns end by paving)
});

/**
 * City-era bookkeeping stored on the game (and its autosave). `rounds` and `actionsPerTurn` are
 * copied from CITY_ERA when the game is created; the rest is filled in when the era starts.
 */
export function createCityState(rounds = CITY_ERA.ROUNDS, actionsPerTurn = CITY_ERA.ACTIONS_PER_TURN) {
  if (!Number.isSafeInteger(rounds) || rounds < 0) throw new RangeError(`Invalid City rounds ${rounds}`);
  if (!Number.isSafeInteger(actionsPerTurn) || actionsPerTurn < 1) throw new RangeError(`Invalid City actions ${actionsPerTurn}`);
  return { rounds, actionsPerTurn, startRound: null, endRound: null, actionsLeft: 0, takeovers: 0 };
}

export function sanitizeName(name, fallback) {
  const clean = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
  return clean || fallback;
}

/**
 * @param {{ seats: Array<{seat:number, name?:string, controller?:'human'|'cpu', difficulty?:null|'easy'|'normal'|'hard'}>, seed?: number, mode?: string, eventPool?: object[], gameType?: string, eventProbability?: number, maxActiveEvents?: number }} options
 *   `seats` lists the joined seats (1–4). Play order is always by seat number. Each seat's
 *   controller (human, or cpu with a difficulty and personality; human by default) is stored on
 *   its player as metadata only: no rule depends on it (core/seats.js). CPU seats without a
 *   personality get one from the seed (assignPersonalities).
 *   `seed` makes city events reproducible (random by default).
 *   `mode` is a rule preset from GAME_MODES (standard | classic | chaos); its rules are
 *   copied onto the game as `game.rules`, which is all the rules engine reads.
 *   `eventPool` overrides CITY_EVENTS.POOL (e.g. [] for an event-free game in tests).
 *   `eventProbability` / `maxActiveEvents` override the mode's event pacing (tests).
 *   `cityRounds` / `cityActions` override CITY_ERA.ROUNDS / ACTIONS_PER_TURN (tests; 0 City
 *   rounds ends the match on the final road, as before the CITY era existed).
 *   Economy values come from ECONOMY in config.js.
 */
export function createGame({
  seats, seed = randomSeed(), mode = DEFAULT_MODE, eventPool = EVENT_POOL, gameType = 'custom', eventProbability, maxActiveEvents,
  cityRounds = CITY_ERA.ROUNDS, cityActions = CITY_ERA.ACTIONS_PER_TURN,
} = {}) {
  const city = createCityState(cityRounds, cityActions);
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
  const players = assignPersonalities(seats, seed)
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
        lastBankruptcyRound: null, // round of the latest bankruptcy (recovery messaging)
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
    era: ERAS.EXPANSION,
    city,
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
    prestige: Math.max(0, prestigeFor(game.board, player.seat) - bankruptcyPenalty(player.bankruptcies).prestige), // as scored
    // Recovery: the final-score penalty so far and what another bankruptcy would pay out.
    bankruptcyPenalty: bankruptcyPenalty(player.bankruptcies).cityValue,
    nextRecoveryCapital: recoveryCapital(player.bankruptcies),
    recovering: player.lastBankruptcyRound != null && game.round - player.lastBankruptcyRound <= 1,
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
  if (game.era === ERAS.CITY) return MOVE_ERRORS.ROADS_CLOSED;
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
  if (game.era === ERAS.CITY) game.city.actionsLeft = game.city.actionsPerTurn;
  game.city.takeovers = 0; // hostile takeovers this turn (core/takeover.js)
  return game.turnStartIncome;
}

/** The deliberate boundary between managing property and committing to a road. */
export function startPaving(game) {
  if (game.phase !== PHASES.PLAYING || game.turnPhase !== TURN_PHASES.MANAGE_CITY) return false;
  if (game.era === ERAS.CITY) return false; // every road is paved
  if (isInDistress(currentPlayer(game))) return false;
  game.turnPhase = TURN_PHASES.PAVE_ROAD;
  return true;
}

/** Resolve the next captured block after building now or intentionally leaving it vacant. */
export function resolveCapture(game, blockId = game.pendingCaptures[0]) {
  if (game.turnPhase !== TURN_PHASES.CAPTURE_DEVELOP || game.pendingCaptures[0] !== blockId) return false;
  game.pendingCaptures.shift();
  // No bonus road once the grid is complete: the final mover carries on with their City turn.
  if (!game.pendingCaptures.length) game.turnPhase = game.era === ERAS.CITY ? TURN_PHASES.MANAGE_CITY : TURN_PHASES.BONUS_ROAD;
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

/** Settles the round, then freezes the results: the match is over. */
function finishGame(game) {
  settleFinalEconomy(game);
  game.phase = PHASES.ENDED;
  game.results = computeResults(game);
  game.log.push({ type: 'game-end', round: game.round, era: game.era });
}

/**
 * EXPANSION → CITY, when the final road is paved. The rest of this round is played as City
 * turns (the final mover's included); the era's full rounds are the `city.rounds` after it.
 * With 0 City rounds the match ends right here, as it did before eras existed.
 * Returns true if the CITY era began (false: the game ended).
 */
export function enterCityEra(game) {
  if (game.phase !== PHASES.PLAYING || game.era === ERAS.CITY) return false;
  if (game.city.rounds <= 0) {
    finishGame(game);
    return false;
  }
  game.era = ERAS.CITY;
  game.city.startRound = game.round + 1;
  game.city.endRound = game.round + game.city.rounds;
  game.city.actionsLeft = game.city.actionsPerTurn;
  game.log.push({ type: 'era', era: ERAS.CITY, round: game.round });
  return true;
}

/** True when a build/upgrade/sale/redevelopment right now would spend one of the turn's City Actions. */
export function usesCityAction(game) {
  return game.phase === PHASES.PLAYING && game.era === ERAS.CITY && game.turnPhase === TURN_PHASES.MANAGE_CITY;
}

/** True when the current mayor has no City Actions left this turn (always false in EXPANSION). */
export function outOfCityActions(game) {
  return usesCityAction(game) && game.city.actionsLeft <= 0;
}

/** Spends one City Action after a successful action (no-op when none is needed). */
export function spendCityAction(game) {
  if (usesCityAction(game)) game.city.actionsLeft = Math.max(0, game.city.actionsLeft - 1);
}

/**
 * Era summary for the HUD and the CPU:
 *   era, rounds (full City rounds), round (1-based City round; 0 during the rest of the round in
 *   which the grid was finished, and in EXPANSION), roundsLeft (full City rounds not yet finished,
 *   including the current one), actionsLeft / actionsPerTurn (this turn; null in EXPANSION).
 */
export function eraStatus(game) {
  const { city } = game;
  if (game.era !== ERAS.CITY) {
    return { era: ERAS.EXPANSION, rounds: city.rounds, round: 0, roundsLeft: city.rounds, actionsLeft: null, actionsPerTurn: city.actionsPerTurn };
  }
  const round = Math.max(0, game.round - city.startRound + 1);
  return {
    era: ERAS.CITY,
    rounds: city.rounds,
    round,
    roundsLeft: game.phase === PHASES.ENDED ? 0 : Math.min(city.rounds, city.endRound - game.round + 1),
    actionsLeft: city.actionsLeft,
    actionsPerTurn: city.actionsPerTurn,
  };
}

/**
 * How many more of their own turn starts (income paydays) a mayor gets in the CITY era after the
 * current turn. Null in EXPANSION (roads decide it there; see cpu/roads.js).
 */
export function cityTurnsLeft(game) {
  if (game.era !== ERAS.CITY || game.phase !== PHASES.PLAYING) return game.phase === PHASES.PLAYING ? null : 0;
  return Math.max(0, game.city.endRound - game.round);
}

/**
 * Passes play to the next seat and begins their turn. Wrapping back to the
 * first seat starts a new round: expired city events are removed and one new
 * event is drawn *before* the first player's income is paid.
 * Returns { roundEnded, event: { expired, started } | null, turnIncome }.
 */
export function endTurn(game) {
  const summary = { roundEnded: false, event: null, turnIncome: null, turnUpkeep: null, turnRepair: null, gameEnded: false };
  game.turnIndex += 1;
  if (game.turnIndex >= game.players.length) {
    game.turnIndex = 0;
    summary.roundEnded = true;
    game.log.push({ type: 'round-end', round: game.round });
    // The last seat of the last City round has played: the match is over.
    if (game.era === ERAS.CITY && game.round >= game.city.endRound) {
      finishGame(game);
      summary.gameEnded = true;
      return summary;
    }
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
 * CITY era: the current mayor is done managing (City Actions left over are lost). Passes play
 * on exactly as a turn-ending road would, and ends the match after the final City round.
 * Returns { ok:false, error } or { ok:true, seat, roundEnded, event, turnIncome, turnUpkeep, turnRepair, gameEnded }.
 */
export function endCityTurn(game) {
  if (game.phase !== PHASES.PLAYING) return { ok: false, error: MOVE_ERRORS.GAME_OVER };
  if (game.era !== ERAS.CITY) return { ok: false, error: MOVE_ERRORS.NOT_CITY_ERA };
  const player = currentPlayer(game);
  if (isInDistress(player)) return { ok: false, error: MOVE_ERRORS.IN_DISTRESS };
  if (game.turnPhase !== TURN_PHASES.MANAGE_CITY) return { ok: false, error: MOVE_ERRORS.WRONG_PHASE };
  game.lastMove = null;
  game.log.push({ type: 'city-turn', seat: player.seat, round: game.round, unused: game.city.actionsLeft });
  return { ok: true, seat: player.seat, ...endTurn(game) };
}

/**
 * Builds a road for the current player.
 * - Any block this road encloses is claimed by the builder (0, 1 or 2 blocks).
 * - Claiming at least one block grants another road (same player continues).
 * - Otherwise the turn passes to the next seat.
 * - Once every road is paved (all blocks enclosed) the CITY era begins: the builder resolves
 *   any capture it made, then carries on with a City turn (no bonus road). With 0 City
 *   rounds configured, the game ends instead.
 *
 * - Each claimed block pays ECONOMY.CAPTURE_REWARD to the builder.
 *
 * Returns { ok:false, error } for rejected moves, or
 * { ok:true, road, seat, captured:[blockIds], reward, extraTurn, roundEnded, turnIncome, gameEnded, cityEra }.
 */
export function placeRoad(game, id) {
  // Reject malformed/taken moves without advancing a phase or resolving a
  // capture choice. This keeps failed input completely side-effect free.
  if (game.phase !== PHASES.PLAYING) return { ok: false, error: MOVE_ERRORS.GAME_OVER };
  if (game.era === ERAS.CITY) return { ok: false, error: MOVE_ERRORS.ROADS_CLOSED };
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
    cityEra: false,
  };

  // Every road paved = every block enclosed. (Not "every block owned": abandoned
  // blocks after a bankruptcy may stay ownerless forever.)
  if (isCityComplete(game)) {
    if (enterCityEra(game)) {
      result.cityEra = true;
      // The final capture still gets its Develop Now choice; then the City turn goes on.
      game.pendingCaptures = [...captured];
      game.turnPhase = captured.length ? TURN_PHASES.CAPTURE_DEVELOP : TURN_PHASES.MANAGE_CITY;
    } else {
      // 0 City rounds: settleFinalEconomy() resolved the unfinished portion of the round so the
      // final mover cannot decide which players miss income/upkeep, and the results are frozen.
      result.gameEnded = true;
    }
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

/** True when every city block is enclosed (all roads paved): the end of the EXPANSION era. */
export function isCityComplete(game) {
  return roadsBuilt(game) === totalRoads(game.board);
}
