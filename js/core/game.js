/**
 * Game state + turn flow. The core loop is 4-player Dots & Boxes played with
 * roads: build one road per turn; enclosing a block claims it and earns
 * another road. The game ends when every block is claimed.
 */
import { MIN_PLAYERS, MAX_PLAYERS, PLAYER_PRESETS, DEFAULT_SETTINGS, MAX_NAME_LENGTH } from '../config.js';
import {
  createBoard, blocksOwnedBy, isValidRoad, hasRoad, roadBlocks, isBlockEnclosed, totalRoads,
} from './board.js';
import { calculateIncome, payRoundIncome, propertyValue } from './economy.js';

export const PHASES = Object.freeze({ PLAYING: 'playing', ENDED: 'ended' });

/** Reasons placeRoad() can reject a move. */
export const MOVE_ERRORS = Object.freeze({
  GAME_OVER: 'game-over',
  INVALID: 'invalid-road',
  TAKEN: 'road-taken',
});

export function sanitizeName(name, fallback) {
  const clean = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
  return clean || fallback;
}

/**
 * @param {{ seats: Array<{seat:number, name?:string}>, settings?: object }} options
 *   `seats` lists the joined seats (1–4). Play order is always by seat number.
 */
export function createGame({ seats, settings = {} } = {}) {
  const opts = { ...DEFAULT_SETTINGS, ...settings };
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
        cash: Number(opts.startingCash),
      };
    });

  return {
    board: createBoard(),
    players,
    round: 1,
    turnIndex: 0,
    phase: PHASES.PLAYING,
    lastMove: null,
    log: [],
  };
}

export function currentPlayer(game) {
  return game.players[game.turnIndex];
}

export function getPlayer(game, seat) {
  return game.players.find((p) => p.seat === seat) ?? null;
}

export function playerStats(game, player) {
  return {
    cash: player.cash,
    blocks: blocksOwnedBy(game.board, player.seat).length,
    income: calculateIncome(game.board, player.seat),
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
  if (!isValidRoad(game.board, id)) return MOVE_ERRORS.INVALID;
  if (hasRoad(game.board, id)) return MOVE_ERRORS.TAKEN;
  return null;
}

/**
 * Passes play to the next seat. Wrapping back to the first seat closes the
 * round and pays income. Returns { roundEnded, income }.
 */
export function endTurn(game) {
  const summary = { roundEnded: false, income: null };
  game.turnIndex += 1;
  if (game.turnIndex >= game.players.length) {
    game.turnIndex = 0;
    summary.roundEnded = true;
    summary.income = payRoundIncome(game);
    game.log.push({ type: 'round-end', round: game.round, income: summary.income });
    game.round += 1;
  }
  return summary;
}

/**
 * Builds a road for the current player.
 * - Any block this road encloses is claimed by the builder (0, 1 or 2 blocks).
 * - Claiming at least one block grants another road (same player continues).
 * - Otherwise the turn passes to the next seat.
 * - Once every block is claimed the game ends.
 *
 * Returns { ok:false, error } for rejected moves, or
 * { ok:true, road, seat, captured:[blockIds], extraTurn, roundEnded, income, gameEnded }.
 */
export function placeRoad(game, id) {
  const error = validateRoad(game, id);
  if (error) return { ok: false, error };

  const { board } = game;
  const seat = currentPlayer(game).seat;
  board.roads[id] = seat;

  const captured = [];
  for (const block of roadBlocks(board, id)) {
    if (block.ownerSeat == null && isBlockEnclosed(board, block)) {
      block.ownerSeat = seat;
      captured.push(block.id);
    }
  }

  game.lastMove = { road: id, seat, captured };
  game.log.push({ type: 'road', road: id, seat, captured });

  const result = {
    ok: true, road: id, seat, captured,
    extraTurn: false, roundEnded: false, income: null, gameEnded: false,
  };

  if (board.blocks.every((b) => b.ownerSeat != null)) {
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
    worth: p.cash + propertyValue(game.board, p.seat),
  }));
  rows.sort((a, b) => b.blocks - a.blocks || b.worth - a.worth);
  rows.forEach((row, i) => {
    const prev = rows[i - 1];
    row.rank = prev && prev.blocks === row.blocks && prev.worth === row.worth ? prev.rank : i + 1;
  });
  return rows;
}
