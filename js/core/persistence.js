/** Versioned, defensive persistence for an active local match. UI-only state is never saved. */
import { BOARD_ROWS, BOARD_COLS, MIN_PLAYERS, MAX_PLAYERS } from '../config.js';
import { EVENT_POOL } from './events.js';
import { PHASES, TURN_PHASES } from './game.js';
import { isValidRoad } from './board.js';

export const SAVE_KEY = 'gridlock.active-game';
export const SAVE_VERSION = 1;

const integer = (value) => Number.isSafeInteger(value);
const plainObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

function migrate(raw) {
  if (raw?.version === SAVE_VERSION) return raw;
  // Pre-release save prototype used `state` and had no repair queue.
  if (raw?.version === 0 && plainObject(raw.state)) {
    const game = raw.state;
    game.events ??= { active: [], history: [], repairs: [], nextUid: 1 };
    game.events.repairs ??= [];
    game.players?.forEach((player) => { player.lastEconomicRound ??= game.round ?? 1; });
    return { version: SAVE_VERSION, savedAt: raw.savedAt ?? 0, setup: raw.setup ?? null, game };
  }
  return null;
}

function validBlock(block) {
  return plainObject(block) && typeof block.id === 'string' && integer(block.row) && integer(block.col)
    && integer(block.price) && integer(block.ownerSeat ?? 0) && integer(block.level)
    && typeof block.type === 'string' && integer(block.value) && integer(block.income)
    && Array.isArray(block.bonuses) && Array.isArray(block.protectedBy)
    && Array.isArray(block.constructionCosts);
}

function validGame(game) {
  if (!plainObject(game) || game.phase !== PHASES.PLAYING) return false;
  if (!Array.isArray(game.players) || game.players.length < MIN_PLAYERS || game.players.length > MAX_PLAYERS) return false;
  const seats = new Set();
  for (const player of game.players) {
    if (!plainObject(player) || !integer(player.seat) || player.seat < 1 || player.seat > MAX_PLAYERS
      || seats.has(player.seat) || !integer(player.cash) || typeof player.name !== 'string'
      || typeof player.color !== 'string' || typeof player.symbol !== 'string' || typeof player.hex !== 'string'
      || !integer(player.bankruptcies) || !integer(player.lastEconomicRound)) return false;
    seats.add(player.seat);
  }
  if (!plainObject(game.board) || game.board.rows !== BOARD_ROWS || game.board.cols !== BOARD_COLS
    || !Array.isArray(game.board.blocks) || game.board.blocks.length !== BOARD_ROWS * BOARD_COLS
    || !game.board.blocks.every(validBlock) || !plainObject(game.board.roads)) return false;
  if (!integer(game.round) || game.round < 1 || !integer(game.turnIndex)
    || game.turnIndex < 0 || game.turnIndex >= game.players.length) return false;
  if (!Object.values(TURN_PHASES).includes(game.turnPhase) || !Array.isArray(game.pendingCaptures)) return false;
  if (!plainObject(game.events) || !Array.isArray(game.events.active) || !Array.isArray(game.events.history)
    || !Array.isArray(game.events.repairs) || !integer(game.events.nextUid)) return false;
  const blockIds = new Set(game.board.blocks.map((block) => block.id));
  if (blockIds.size !== game.board.blocks.length) return false;
  if (game.board.blocks.some((block) => block.ownerSeat != null && !seats.has(block.ownerSeat))) return false;
  if (Object.entries(game.board.roads).some(([id, seat]) => !isValidRoad(game.board, id) || !seats.has(seat))) return false;
  if (game.pendingCaptures.some((id) => !blockIds.has(id))) return false;
  const eventIds = new Set(EVENT_POOL.map((event) => event.id));
  if (game.events.active.some((event) => !plainObject(event) || !eventIds.has(event.id)
    || !integer(event.uid) || !integer(event.startRound) || !integer(event.endRound) || !Array.isArray(event.targets))) return false;
  if (game.events.repairs.some((repair) => !plainObject(repair) || !seats.has(repair.seat)
    || !blockIds.has(repair.block) || !integer(repair.amount) || repair.amount < 0)) return false;
  if (!integer(game.seed) || !integer(game.rngState) || !Array.isArray(game.ledger) || !Array.isArray(game.log)) return false;
  return true;
}

function setupFrom(game, setup) {
  return {
    gameType: setup?.gameType === 'standard' ? 'standard' : 'custom',
    seats: game.players.map(({ seat, name }) => ({ seat, name })),
  };
}

export function saveActiveGame(game, setup, storage = globalThis.localStorage) {
  if (!validGame(game)) return false;
  try {
    const snapshot = {
      ...game,
      // Feedback/animation pointers and open UI are intentionally ephemeral.
      lastMove: null,
      lastDevelopment: null,
      lastBankruptcy: null,
      turnStartIncome: null,
      turnStartUpkeep: null,
      turnStartRepair: null,
    };
    delete snapshot.eventPool;
    storage?.setItem(SAVE_KEY, JSON.stringify({
      version: SAVE_VERSION,
      savedAt: Date.now(),
      setup: setupFrom(game, setup),
      game: snapshot,
    }));
    return true;
  } catch {
    return false;
  }
}

export function loadActiveGame(storage = globalThis.localStorage) {
  try {
    const migrated = migrate(JSON.parse(storage?.getItem(SAVE_KEY) ?? 'null'));
    if (!migrated || !validGame(migrated.game)) return null;
    migrated.game.eventPool = EVENT_POOL;
    return migrated;
  } catch {
    return null;
  }
}

export function clearActiveGame(storage = globalThis.localStorage) {
  try {
    storage?.removeItem(SAVE_KEY);
    return true;
  } catch {
    return false;
  }
}
