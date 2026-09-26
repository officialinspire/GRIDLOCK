/**
 * Game state + turn flow. The core loop is 4-player Dots & Boxes played with
 * roads: build one road per turn; enclosing a block claims it and earns
 * another road. The game ends when every block is claimed.
 */
import { MIN_PLAYERS, MAX_PLAYERS, PLAYER_PRESETS, MAX_NAME_LENGTH, ECONOMY } from '../config.js';
import {
  createBoard, blocksOwnedBy, isValidRoad, hasRoad, roadBlocks, isBlockEnclosed, totalRoads,
} from './board.js';
import {
  calculateIncome, propertyValue, netWorth, payCaptureReward, payTurnIncome, toAmount, bonusIncome,
  chargeUpkeep, upkeepFor, isInDistress,
} from './economy.js';
import { refreshBonuses } from './bonuses.js';
import { createEventState, onRoundStart, effectiveIncome, EVENT_POOL } from './events.js';
import { randomSeed } from './rng.js';

export const PHASES = Object.freeze({ PLAYING: 'playing', ENDED: 'ended' });

/** Reasons placeRoad() can reject a move. */
export const MOVE_ERRORS = Object.freeze({
  GAME_OVER: 'game-over',
  INVALID: 'invalid-road',
  TAKEN: 'road-taken',
  IN_DISTRESS: 'in-distress',
});

export function sanitizeName(name, fallback) {
  const clean = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
  return clean || fallback;
}

/**
 * @param {{ seats: Array<{seat:number, name?:string}>, seed?: number, eventPool?: object[] }} options
 *   `seats` lists the joined seats (1–4). Play order is always by seat number.
 *   `seed` makes city events reproducible (random by default).
 *   `eventPool` overrides CITY_EVENTS.POOL (e.g. [] for an event-free game in tests).
 *   Economy values come from ECONOMY in config.js.
 */
export function createGame({ seats, seed = randomSeed(), eventPool = EVENT_POOL } = {}) {
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

  const players = [...seats]
    .sort((a, b) => a.seat - b.seat)
    .map(({ seat, name }) => {
      const preset = PLAYER_PRESETS[seat - 1];
      return {
        seat,
        name: sanitizeName(name, preset.name),
        color: preset.color,
        symbol: preset.symbol,
        hex: preset.hex,
        cash: toAmount(ECONOMY.STARTING_CASH),
        bankruptcies: 0,
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
    eventPool,
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
  return game.turnStartIncome;
}

/**
 * Passes play to the next seat and begins their turn. Wrapping back to the
 * first seat starts a new round: expired city events are removed and one new
 * event is drawn *before* the first player's income is paid.
 * Returns { roundEnded, event: { expired, started } | null, turnIncome }.
 */
export function endTurn(game) {
  const summary = { roundEnded: false, event: null, turnIncome: null, turnUpkeep: null };
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
    extraTurn: false, roundEnded: false, event: null, turnIncome: null, turnUpkeep: null, gameEnded: false,
  };

  // Every road paved = every block enclosed. (Not "every block owned": abandoned
  // blocks after a bankruptcy may stay ownerless forever.)
  if (roadsBuilt(game) === totalRoads(board)) {
    game.phase = PHASES.ENDED;
    result.gameEnded = true;
  } else if (captured.length > 0) {
    result.extraTurn = true;
  } else {
    Object.assign(result, endTurn(game));
  }
  return result;
}

/**
 * Players ordered by blocks claimed (the Dots & Boxes score), then by net
 * worth. Tied players share a rank.
 */
export function standings(game) {
  const rows = game.players.map((p) => ({
    player: p,
    blocks: blocksOwnedBy(game.board, p.seat).length,
    worth: netWorth(game, p),
  }));
  rows.sort((a, b) => b.blocks - a.blocks || b.worth - a.worth);
  rows.forEach((row, i) => {
    const prev = rows[i - 1];
    row.rank = prev && prev.blocks === row.blocks && prev.worth === row.worth ? prev.rank : i + 1;
  });
  return rows;
}
