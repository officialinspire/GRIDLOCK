/** Versioned, defensive persistence for an active local match. UI-only state is never saved. */
import { BOARD_ROWS, BOARD_COLS, MIN_PLAYERS, MAX_PLAYERS, APP_VERSION, EXPANSION_ERA } from '../config.js';
import { EVENT_POOL } from './events.js';
import { PHASES, TURN_PHASES, ERAS, createCityState } from './game.js';
import { DISTRICTS, blockId, isValidRoad, totalRoads } from './board.js';
import { VACANT, CATEGORY_ORDER } from './buildings.js';
import { MAX_LEVEL, levelStats } from './development.js';
import { refreshBonuses } from './bonuses.js';
import { getMode, resolveRules } from './modes.js';
import { controllerOf } from './seats.js';
import { measure } from './perf.js';

export const SAVE_KEY = 'gridlock.active-game';
/**
 * Save schema history:
 *   0  pre-release prototype (`state` instead of `game`, no repair queue)
 *   1  V1.1–V1.4.0 (later V1.x fields backfilled on load)
 *   2  V1.4.1: blocks carry `shieldSeat` (turn-precise takeover shields)
 *   3  EXPANSION turn economy: `city.expansionActions`, and `city.actionsLeft` counts the
 *      management actions left in either era
 */
export const SAVE_VERSION = 3;

const integer = (value) => Number.isSafeInteger(value);
const plainObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

/**
 * Version 1 saves were written by builds from V1.1 to V1.4.0; fields added during V1.x are
 * backfilled with the values that keep each save's rules exactly as they were.
 */
function backfillV1(game) {
  if (!plainObject(game)) return;
  // Saves from before rule presets existed were standard games.
  if (game.mode === undefined) {
    game.mode = 'standard';
    game.rules = resolveRules('standard', {
      eventProbability: game.eventProbability ?? undefined,
      maxActiveEvents: game.maxActiveEvents ?? undefined,
    });
    delete game.eventProbability;
    delete game.maxActiveEvents;
  }
  // Saves from before seat controllers existed were all-human tables.
  if (Array.isArray(game.players)) {
    for (const player of game.players) {
      if (plainObject(player) && player.controller === undefined) Object.assign(player, { controller: 'human', difficulty: null });
    }
  }
  // Saves from before the CITY era existed are always mid-EXPANSION (the match used to end
  // on the final road), so they continue with this build's City rules.
  if (game.era === undefined) {
    game.era = ERAS.EXPANSION;
    game.city = createCityState();
  }
  // Saves from before takeovers: nobody has taken one this turn.
  if (plainObject(game.city) && game.city.takeovers === undefined) game.city.takeovers = 0;
  // Saves from before takeover shields and recovery tracking: nothing shielded, no recent bankruptcy.
  if (Array.isArray(game.board?.blocks)) {
    for (const block of game.board.blocks) if (plainObject(block) && block.shieldedUntil === undefined) block.shieldedUntil = null;
  }
  if (Array.isArray(game.players)) {
    for (const player of game.players) if (plainObject(player) && player.lastBankruptcyRound === undefined) player.lastBankruptcyRound = null;
  }
}

/** One step per schema version: MIGRATIONS[v](save) returns the same save at version v + 1. */
const MIGRATIONS = Object.freeze({
  0: (raw) => {
    if (!plainObject(raw.state)) return null;
    const game = raw.state;
    game.events ??= { active: [], history: [], repairs: [], nextUid: 1 };
    game.events.repairs ??= [];
    game.players?.forEach((player) => { player.lastEconomicRound ??= game.round ?? 1; });
    return { version: 1, savedAt: raw.savedAt ?? 0, setup: raw.setup ?? null, game };
  },
  1: (raw) => {
    const { game } = raw;
    backfillV1(game);
    // Shields from V1.4.0 takeovers lasted whole rounds; they keep doing so (no shield seat).
    if (Array.isArray(game?.board?.blocks)) {
      for (const block of game.board.blocks) if (plainObject(block) && block.shieldSeat === undefined) block.shieldSeat = null;
    }
    return { ...raw, version: 2 };
  },
  2: (raw) => {
    const { game } = raw;
    // Before the EXPANSION turn economy, Manage City in EXPANSION was unlimited. A save made in
    // it gets this build's budget for the rest of the turn; anywhere past Manage City (paving,
    // a capture, a bonus road) the turn's management is over. CITY saves are unchanged.
    if (plainObject(game?.city)) {
      game.city.expansionActions ??= EXPANSION_ERA.ACTIONS_PER_TURN;
      if (game.era === ERAS.EXPANSION) {
        game.city.actionsLeft = game.turnPhase === TURN_PHASES.MANAGE_CITY ? game.city.expansionActions : 0;
      }
    }
    return { ...raw, version: 3 };
  },
});

/** Brings a stored save up to SAVE_VERSION, or returns null (unknown/newer version, wrong shape). */
export function migrateSave(raw) {
  let save = raw;
  while (plainObject(save) && save.version !== SAVE_VERSION) {
    const step = integer(save.version) && Object.hasOwn(MIGRATIONS, save.version) ? MIGRATIONS[save.version] : null;
    if (!step) return null;
    save = step(save);
  }
  return plainObject(save) && plainObject(save.game) ? save : null;
}

const BLOCK_TYPES = new Set([VACANT, ...CATEGORY_ORDER]);

/** A block's shape, district, and accounting all agree with the rules in config.js. */
function validBlock(block) {
  if (!plainObject(block) || !integer(block.row) || !integer(block.col)
    || block.row < 0 || block.row >= BOARD_ROWS || block.col < 0 || block.col >= BOARD_COLS) return false;
  if (!integer(block.level) || block.level < 0 || block.level > MAX_LEVEL || !BLOCK_TYPES.has(block.type)
    || (block.level === 0) !== (block.type === VACANT)) return false;
  const stats = levelStats(block.type, block.level); // list-price income/investment from ECONOMY.DEVELOPMENT
  const ring = Math.min(block.row, block.col, BOARD_ROWS - 1 - block.row, BOARD_COLS - 1 - block.col);
  const expectedDistrict = ring === 0 ? 'suburbs' : ring === 1 ? 'midtown' : 'downtown';
  return Boolean(stats) && block.id === blockId(block.row, block.col)
    && block.district === expectedDistrict && block.price === DISTRICTS[expectedDistrict].price
    && integer(block.ownerSeat ?? 0)
    && integer(block.value) && block.marketValue === block.price + stats.invested && integer(block.investedCostBasis)
    && block.income === stats.income && integer(block.bonusIncome) && block.bonusIncome >= 0
    && Array.isArray(block.bonuses) && Array.isArray(block.protectedBy)
    && Array.isArray(block.constructionCosts)
    && block.constructionCosts.length === block.level
    && block.constructionCosts.every((cost) => integer(cost) && cost >= 0)
    && block.constructionCosts.reduce((sum, cost) => sum + cost, 0) === block.investedCostBasis
    && block.value === block.price + block.investedCostBasis
    && typeof block.abandoned === 'boolean' && integer(block.abandonedBy ?? 0)
    && (block.shieldedUntil == null || integer(block.shieldedUntil))
    && (block.shieldSeat == null || (integer(block.shieldSeat) && integer(block.shieldedUntil)));
}

/**
 * Era state: EXPANSION until every road is paved, then CITY with a consistent round window; in
 * either era, no more management actions left than the era's turn grants.
 */
function validEra(game) {
  const { city } = game;
  if (!plainObject(city) || !integer(city.rounds) || city.rounds < 0
    || !integer(city.actionsPerTurn) || city.actionsPerTurn < 1
    || !integer(city.expansionActions) || city.expansionActions < 1) return false;
  const complete = Object.keys(game.board.roads).length === totalRoads(game.board);
  if (game.era === ERAS.EXPANSION) {
    // Development Actions: only Manage City has any left (paving forfeits the rest).
    return !complete && integer(city.actionsLeft) && city.actionsLeft >= 0 && city.actionsLeft <= city.expansionActions
      && (game.turnPhase === TURN_PHASES.MANAGE_CITY || city.actionsLeft === 0);
  }
  if (game.era !== ERAS.CITY || !complete || city.rounds < 1) return false;
  return integer(city.startRound) && integer(city.endRound) && integer(city.actionsLeft)
    && integer(city.takeovers) && city.takeovers >= 0
    && city.endRound === city.startRound + city.rounds - 1 && game.round >= city.startRound - 1 && game.round <= city.endRound
    && city.actionsLeft >= 0 && city.actionsLeft <= city.actionsPerTurn
    && game.turnPhase !== TURN_PHASES.PAVE_ROAD && game.turnPhase !== TURN_PHASES.BONUS_ROAD;
}

/** A saved rules snapshot must have the shape the event engine reads. */
function validRules(rules) {
  const events = rules?.events;
  return plainObject(rules) && plainObject(events) && typeof events.enabled === 'boolean'
    && typeof events.probability === 'number' && events.probability >= 0 && events.probability <= 1
    && integer(events.maxActive) && events.maxActive >= 0 && integer(events.durationBonus) && events.durationBonus >= 0;
}

function validGame(game) {
  if (!plainObject(game) || game.phase !== PHASES.PLAYING) return false;
  if (!getMode(game.mode) || !validRules(game.rules)) return false;
  if (!Array.isArray(game.players) || game.players.length < MIN_PLAYERS || game.players.length > MAX_PLAYERS) return false;
  const seats = new Set();
  for (const player of game.players) {
    if (!plainObject(player) || !integer(player.seat) || player.seat < 1 || player.seat > MAX_PLAYERS
      || seats.has(player.seat) || !integer(player.cash) || typeof player.name !== 'string'
      || typeof player.color !== 'string' || typeof player.symbol !== 'string' || typeof player.hex !== 'string'
      || !integer(player.bankruptcies) || !integer(player.lastEconomicRound)
      || (player.lastBankruptcyRound != null && !integer(player.lastBankruptcyRound))
      || !controllerOf(player)) return false;
    seats.add(player.seat);
  }
  if (!plainObject(game.board) || game.board.rows !== BOARD_ROWS || game.board.cols !== BOARD_COLS
    || !Array.isArray(game.board.blocks) || game.board.blocks.length !== BOARD_ROWS * BOARD_COLS
    || !game.board.blocks.every(validBlock) || !plainObject(game.board.roads)) return false;
  if (!integer(game.round) || game.round < 1 || !integer(game.turnIndex)
    || game.turnIndex < 0 || game.turnIndex >= game.players.length) return false;
  if (!Object.values(TURN_PHASES).includes(game.turnPhase) || !Array.isArray(game.pendingCaptures)) return false;
  if (!validEra(game)) return false;
  if (!plainObject(game.events) || !Array.isArray(game.events.active) || !Array.isArray(game.events.history)
    || !Array.isArray(game.events.repairs) || !integer(game.events.nextUid)) return false;
  const blockIds = new Set(game.board.blocks.map((block) => block.id));
  if (blockIds.size !== game.board.blocks.length) return false;
  if (game.board.blocks.some((block) => block.ownerSeat != null && !seats.has(block.ownerSeat))) return false;
  if (game.board.blocks.some((block) => block.abandonedBy != null && !seats.has(block.abandonedBy))) return false;
  if (game.board.blocks.some((block) => block.shieldSeat != null && !seats.has(block.shieldSeat))) return false;
  if (game.board.blocks.some((block) => block.abandoned
    ? block.ownerSeat != null || block.abandonedBy == null
    : block.abandonedBy != null)) return false;
  if (Object.entries(game.board.roads).some(([id, seat]) => !isValidRoad(game.board, id) || !seats.has(seat))) return false;
  if (game.pendingCaptures.some((id) => !blockIds.has(id))) return false;
  if (game.turnPhase === TURN_PHASES.CAPTURE_DEVELOP) {
    const seat = game.players[game.turnIndex].seat;
    if (!game.pendingCaptures.length || game.pendingCaptures.some((id) => game.board.blocks.find((b) => b.id === id)?.ownerSeat !== seat)) return false;
  } else if (game.pendingCaptures.length) return false;
  const eventIds = new Set(EVENT_POOL.map((event) => event.id));
  if (game.events.active.some((event) => !plainObject(event) || !eventIds.has(event.id)
    || !integer(event.uid) || !integer(event.startRound) || !integer(event.endRound) || !Array.isArray(event.targets))) return false;
  if (game.events.repairs.some((repair) => !plainObject(repair) || !seats.has(repair.seat)
    || !blockIds.has(repair.block) || !integer(repair.amount) || repair.amount < 0)) return false;
  if (!integer(game.seed) || !integer(game.rngState) || !Array.isArray(game.ledger) || !Array.isArray(game.log)) return false;
  if (game.log.some((entry) => !plainObject(entry)
    || (entry.type === 'road' && (!seats.has(entry.seat) || !Array.isArray(entry.captured)
      || entry.captured.some((id) => !blockIds.has(id)) || !isValidRoad(game.board, entry.road))))) return false;
  return true;
}

function setupFrom(game, setup) {
  return {
    gameType: setup?.gameType === 'standard' && game.players.length === MAX_PLAYERS ? 'standard' : 'custom',
    mode: game.mode,
    seats: game.players.map(({ seat, name, controller, difficulty, personality }) => ({
      seat, name, controller, difficulty, ...(controller === 'cpu' && { personality: personality ?? null }),
    })),
  };
}

/**
 * Writes the active game. True only when a valid game was written to storage: such a save is
 * one loadActiveGame() accepts, so the UI may offer Continue without reading it back.
 */
export function saveActiveGame(game, setup, storage = globalThis.localStorage) {
  return measure('saveActiveGame', () => writeSave(game, setup, storage));
}

function writeSave(game, setup, storage) {
  if (!storage || !validGame(game)) return false;
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
    storage.setItem(SAVE_KEY, JSON.stringify({
      version: SAVE_VERSION,
      appVersion: APP_VERSION,
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
  return measure('loadActiveGame', () => readSave(storage));
}

function readSave(storage) {
  try {
    const migrated = migrateSave(JSON.parse(storage?.getItem(SAVE_KEY) ?? 'null'));
    if (!migrated || !validGame(migrated.game)) return null;
    // Derived adjacency/protection data is rebuilt instead of trusting storage.
    refreshBonuses(migrated.game.board);
    migrated.setup = setupFrom(migrated.game, migrated.setup);
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
