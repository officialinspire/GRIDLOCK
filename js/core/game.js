/**
 * Game state + turn/round flow. Advanced actions (buying, building, events)
 * plug in here in later phases.
 */
import { MIN_PLAYERS, MAX_PLAYERS, PLAYER_PRESETS, START_CORNERS, DEFAULT_SETTINGS, MAX_NAME_LENGTH } from '../config.js';
import { createBoard, getBlock, setOwner, blocksOwnedBy } from './board.js';
import { STARTER_BUILDING_ID } from './buildings.js';
import { calculateIncome, payRoundIncome } from './economy.js';

export const PHASES = Object.freeze({ PLAYING: 'playing', ENDED: 'ended' });

export function sanitizeName(name, fallback) {
  const clean = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
  return clean || fallback;
}

/**
 * @param {{ seats: Array<{seat:number, name?:string}>, settings?: object }} options
 *   `seats` lists the joined seats (1–4) in play order.
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

  const board = createBoard();
  const players = seats.map(({ seat, name }) => {
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

  // Each seat starts with its corner block and a starter house.
  for (const player of players) {
    const corner = START_CORNERS[player.seat - 1];
    const block = getBlock(board, corner.row, corner.col);
    setOwner(board, block, player.seat);
    block.buildingId = STARTER_BUILDING_ID;
  }

  return {
    board,
    players,
    round: 1,
    maxRounds: Number(opts.rounds),
    turnIndex: 0,
    phase: PHASES.PLAYING,
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

/**
 * Passes play to the next player. When the last player ends their turn the
 * round closes: income is paid and the round counter advances (or the game ends).
 * Returns a summary describing what happened.
 */
export function endTurn(game) {
  if (game.phase !== PHASES.PLAYING) return { roundEnded: false, gameEnded: true };

  const summary = { roundEnded: false, gameEnded: false, income: null };
  game.turnIndex += 1;

  if (game.turnIndex >= game.players.length) {
    summary.roundEnded = true;
    summary.income = payRoundIncome(game);
    game.log.push({ type: 'round-end', round: game.round, income: summary.income });
    game.turnIndex = 0;

    if (game.round >= game.maxRounds) {
      game.phase = PHASES.ENDED;
      summary.gameEnded = true;
    } else {
      game.round += 1;
    }
  }
  return summary;
}
