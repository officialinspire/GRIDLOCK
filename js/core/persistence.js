/** Versioned, defensive persistence for an active local match. UI-only state is never saved. */
import { BOARD_ROWS, BOARD_COLS, MIN_PLAYERS, MAX_PLAYERS, ECONOMY } from '../config.js';
import { EVENT_POOL } from './events.js';
import { PHASES, TURN_PHASES, ERAS, createCityState } from './game.js';
import { DISTRICTS, blockId, isValidRoad, totalRoads } from './board.js';
import { CATEGORY_ORDER } from './buildings.js';
import { refreshBonuses } from './bonuses.js';
import { getMode, resolveRules } from './modes.js';
import { controllerOf } from './seats.js';

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
  const categories = new Set(['vacant', ...CATEGORY_ORDER]);
  const category = ECONOMY.DEVELOPMENT.CATEGORIES[block.type];
  const level = ECONOMY.DEVELOPMENT.LEVELS[block.level];
  const expectedIncome = block.level === 0 ? ECONOMY.UNDEVELOPED_INCOME : category?.income * level?.income;
  const expectedMarket = block.price + (block.level === 0 ? 0
    : Array.from({ length: block.level }, (_, index) => category?.cost * ECONOMY.DEVELOPMENT.LEVELS[index + 1]?.cost)
      .reduce((sum, cost) => sum + cost, 0));
  const expectedDistrict = Math.min(block.row, block.col, BOARD_ROWS - 1 - block.row, BOARD_COLS - 1 - block.col) === 0
    ? 'suburbs'
    : Math.min(block.row, block.col, BOARD_ROWS - 1 - block.row, BOARD_COLS - 1 - block.col) === 1 ? 'midtown' : 'downtown';
  return plainObject(block) && block.id === blockId(block.row, block.col)
    && integer(block.row) && block.row >= 0 && block.row < BOARD_ROWS
    && integer(block.col) && block.col >= 0 && block.col < BOARD_COLS
    && block.district === expectedDistrict && block.price === DISTRICTS[expectedDistrict].price
    && integer(block.ownerSeat ?? 0) && integer(block.level) && block.level >= 0 && block.level <= 3
    && categories.has(block.type) && ((block.level === 0) === (block.type === 'vacant'))
    && integer(block.value) && block.marketValue === expectedMarket && integer(block.investedCostBasis)
    && block.income === expectedIncome && integer(block.bonusIncome) && block.bonusIncome >= 0
    && Array.isArray(block.bonuses) && Array.isArray(block.protectedBy)
    && Array.isArray(block.constructionCosts)
    && block.constructionCosts.length === block.level
    && block.constructionCosts.every((cost) => integer(cost) && cost >= 0)
    && block.constructionCosts.reduce((sum, cost) => sum + cost, 0) === block.investedCostBasis
    && block.value === block.price + block.investedCostBasis
    && typeof block.abandoned === 'boolean' && integer(block.abandonedBy ?? 0)
    && (block.shieldedUntil == null || integer(block.shieldedUntil));
}

/**
 * Era state: EXPANSION until every road is paved, then CITY with a consistent round window and
 * no more City Actions than a turn grants.
 */
function validEra(game) {
  const { city } = game;
  if (!plainObject(city) || !integer(city.rounds) || city.rounds < 0
    || !integer(city.actionsPerTurn) || city.actionsPerTurn < 1) return false;
  const complete = Object.keys(game.board.roads).length === totalRoads(game.board);
  if (game.era === ERAS.EXPANSION) return !complete;
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
    // Saves from before rule presets existed were standard games.
    if (plainObject(migrated?.game) && migrated.game.mode === undefined) {
      migrated.game.mode = 'standard';
      migrated.game.rules = resolveRules('standard', {
        eventProbability: migrated.game.eventProbability ?? undefined,
        maxActiveEvents: migrated.game.maxActiveEvents ?? undefined,
      });
      delete migrated.game.eventProbability;
      delete migrated.game.maxActiveEvents;
    }
    // Saves from before seat controllers existed were all-human tables.
    if (Array.isArray(migrated?.game?.players)) {
      for (const player of migrated.game.players) {
        if (plainObject(player) && player.controller === undefined) Object.assign(player, { controller: 'human', difficulty: null });
      }
    }
    // Saves from before the CITY era existed are always mid-EXPANSION (the match used to end
    // on the final road), so they continue with this build's City rules.
    if (plainObject(migrated?.game) && migrated.game.era === undefined) {
      migrated.game.era = ERAS.EXPANSION;
      migrated.game.city = createCityState();
    }
    // Saves from before takeovers: nobody has taken one this turn.
    if (plainObject(migrated?.game?.city) && migrated.game.city.takeovers === undefined) migrated.game.city.takeovers = 0;
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
