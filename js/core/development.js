/**
 * Block development rules: Vacant (Level 0) → build a category (Level 1) →
 * upgrade to MAX_LEVEL. Numbers come from ECONOMY.DEVELOPMENT; this module
 * derives per-level tables from them and owns every change to a block's
 * type / level / value / income.
 */
import { ECONOMY } from '../config.js';
import { getBlockById } from './board.js';
import { VACANT, CATEGORY_ORDER, getCategory } from './buildings.js';
import { debit, canAfford, TXN, isValidAmount } from './economy.js';
import { refreshBonuses } from './bonuses.js';
import { adjustedCost } from './events.js';
import { industryDiscount as industryDiscountFor } from './strategy.js';
import {
  currentPlayer, PHASES, TURN_PHASES, outOfCityActions, spendCityAction,
} from './game.js';

const DEV = ECONOMY.DEVELOPMENT;
export const MAX_LEVEL = DEV.MAX_LEVEL;

export const DEV_ERRORS = Object.freeze({
  GAME_OVER: 'game-over',
  NO_BLOCK: 'no-such-block',
  NOT_OWNER: 'not-owner',
  UNKNOWN_TYPE: 'unknown-type',
  ALREADY_DEVELOPED: 'already-developed',
  NOT_DEVELOPED: 'not-developed',
  MAX_LEVEL: 'max-level',
  INSUFFICIENT_FUNDS: 'insufficient-funds',
  WRONG_PHASE: 'wrong-turn-phase',
  NO_ACTIONS: 'no-city-actions', // CITY era: this turn's City Actions are spent
});

/* ---------------- derived tables ---------------- */

function wholeDollars(value, what) {
  const n = Math.round(value);
  if (!isValidAmount(n) || Math.abs(n - value) > 1e-9) {
    throw new Error(`ECONOMY.DEVELOPMENT: ${what} = ${value} is not a whole-dollar amount`);
  }
  return n;
}

/**
 * TABLE[type][level] = { cost, income, invested }
 *   cost     — price to reach `level` from `level - 1`
 *   income   — total income per turn at `level`
 *   invested — sum of costs from Level 1 to `level`
 */
export const TABLE = Object.freeze(Object.fromEntries(CATEGORY_ORDER.map((type) => {
  const base = DEV.CATEGORIES[type];
  const rows = { 0: Object.freeze({ cost: 0, income: ECONOMY.UNDEVELOPED_INCOME, invested: 0 }) };
  let invested = 0;
  for (let level = 1; level <= MAX_LEVEL; level++) {
    const m = DEV.LEVELS[level];
    if (!m) throw new Error(`ECONOMY.DEVELOPMENT.LEVELS is missing level ${level}`);
    const cost = wholeDollars(base.cost * m.cost, `${type} L${level} cost`);
    const income = wholeDollars(base.income * m.income, `${type} L${level} income`);
    invested += cost;
    rows[level] = Object.freeze({ cost, income, invested });
  }
  return [type, Object.freeze(rows)];
})));

export const isCategory = (type) => Object.hasOwn(TABLE, type);

export function levelStats(type, level) {
  if (type === VACANT || level === 0) return TABLE[CATEGORY_ORDER[0]][0];
  return (isCategory(type) && TABLE[type][level]) || null;
}

/* ---------------- block state ---------------- */

/**
 * Sets a block's development and refreshes its accounting values.
 * `constructionCosts` contains the actual price paid for each retained level.
 * Direct setup callers omit it and receive the normal list-price basis.
 */
export function applyDevelopment(block, type, level, { constructionCosts } = {}) {
  const stats = levelStats(type, level);
  if (!stats) throw new RangeError(`Invalid development ${type} L${level}`);
  const actualCosts = constructionCosts ?? (level === 0
    ? []
    : Array.from({ length: level }, (_, i) => TABLE[type][i + 1].cost));
  if (actualCosts.length !== level || actualCosts.some((cost) => !isValidAmount(cost))) {
    throw new RangeError(`Invalid construction cost basis for ${type} L${level}`);
  }
  block.type = level === 0 ? VACANT : type;
  block.level = level;
  block.income = stats.income;
  block.constructionCosts = [...actualCosts];
  block.investedCostBasis = actualCosts.reduce((sum, cost) => sum + cost, 0);
  block.marketValue = block.price + stats.invested;
  block.value = block.price + block.investedCostBasis;
  return block;
}

export const isDeveloped = (block) => block.level > 0 && isCategory(block.type);

/* ---------------- quotes ---------------- */

function baseCheck(game, block) {
  if (game.phase !== PHASES.PLAYING) return DEV_ERRORS.GAME_OVER;
  if (!block) return DEV_ERRORS.NO_BLOCK;
  // Only the owner may develop, and only on their own turn (hot-seat play).
  if (block.ownerSeat == null || block.ownerSeat !== currentPlayer(game).seat) return DEV_ERRORS.NOT_OWNER;
  const managing = game.turnPhase === TURN_PHASES.MANAGE_CITY;
  const resolvingCapture = game.turnPhase === TURN_PHASES.CAPTURE_DEVELOP
    && game.pendingCaptures[0] === block.id;
  if (!managing && !resolvingCapture) return DEV_ERRORS.WRONG_PHASE;
  return null;
}

/**
 * The price of a build/upgrade: the list price with active city events applied (eventCost),
 * then the builder's industrial discount (core/strategy.js) when an own Industrial block is
 * adjacent. Returns { cost, actualCost, eventCost, industryDiscount }.
 */
function constructionPrice(game, block, type, listCost, seat) {
  const eventCost = adjustedCost(game, type, listCost); // active city events can change prices
  const industryDiscount = industryDiscountFor(game.board, seat, block);
  const cost = industryDiscount ? Math.round((eventCost * (100 - industryDiscount)) / 100) : eventCost;
  return { cost, actualCost: cost, eventCost, industryDiscount };
}

/**
 * What building `type` on a vacant block would cost and pay.
 * Returns { ok, error?, type, level: 1, cost, income, incomeGain, shortfall }.
 */
export function quoteBuild(game, blockId, type) {
  const block = getBlockById(game.board, blockId);
  const quote = { ok: false, type, level: 1, cost: 0, income: 0, incomeGain: 0, shortfall: 0 };
  const err = baseCheck(game, block)
    ?? (!isCategory(type) ? DEV_ERRORS.UNKNOWN_TYPE : null)
    ?? (isDeveloped(block) ? DEV_ERRORS.ALREADY_DEVELOPED : null);
  if (err) return { ...quote, error: err };

  const next = TABLE[type][1];
  const player = currentPlayer(game);
  const price = constructionPrice(game, block, type, next.cost, player.seat);
  Object.assign(quote, { ...price, baseCost: next.cost, income: next.income, incomeGain: next.income - block.income });
  const { cost } = price;
  // Priced first so the panel can still show what it would cost next turn.
  if (outOfCityActions(game)) return { ...quote, error: DEV_ERRORS.NO_ACTIONS };
  if (!canAfford(player, cost)) {
    return { ...quote, error: DEV_ERRORS.INSUFFICIENT_FUNDS, shortfall: cost - player.cash };
  }
  return { ...quote, ok: true };
}

/** What upgrading a developed block one level would cost and pay. */
export function quoteUpgrade(game, blockId) {
  const block = getBlockById(game.board, blockId);
  const quote = { ok: false, type: block?.type, level: (block?.level ?? 0) + 1, cost: 0, income: 0, incomeGain: 0, shortfall: 0 };
  const err = baseCheck(game, block)
    ?? (!isDeveloped(block) ? DEV_ERRORS.NOT_DEVELOPED : null)
    ?? (block.level >= MAX_LEVEL ? DEV_ERRORS.MAX_LEVEL : null);
  if (err) return { ...quote, error: err };

  const next = TABLE[block.type][block.level + 1];
  const player = currentPlayer(game);
  const price = constructionPrice(game, block, block.type, next.cost, player.seat);
  Object.assign(quote, { ...price, baseCost: next.cost, income: next.income, incomeGain: next.income - block.income });
  const { cost } = price;
  // Priced first so the panel can still show what it would cost next turn.
  if (outOfCityActions(game)) return { ...quote, error: DEV_ERRORS.NO_ACTIONS };
  if (!canAfford(player, cost)) {
    return { ...quote, error: DEV_ERRORS.INSUFFICIENT_FUNDS, shortfall: cost - player.cash };
  }
  return { ...quote, ok: true };
}

/* ---------------- actions ---------------- */

function commit(game, block, quote, reason) {
  const player = currentPlayer(game);
  const fromLevel = block.level;
  const paid = debit(game, player, quote.cost, reason, { block: block.id, type: quote.type, level: quote.level });
  // quote already checked affordability; this guards against state changing in between.
  if (!paid.ok) return { ok: false, error: DEV_ERRORS.INSUFFICIENT_FUNDS };
  applyDevelopment(block, quote.type, quote.level, {
    constructionCosts: [...(block.constructionCosts ?? []), quote.actualCost],
  });
  refreshBonuses(game.board); // development changed
  spendCityAction(game); // CITY era Manage City only
  game.lastDevelopment = { block: block.id, seat: player.seat, type: block.type, level: block.level, fromLevel };
  game.log.push({ type: reason, seat: player.seat, block: block.id, category: quote.type, level: quote.level, cost: quote.cost });
  return { ok: true, block: block.id, type: block.type, level: block.level, cost: quote.cost, income: block.income, value: block.value };
}

/** Builds Level 1 of `type` on a vacant block owned by the current player. Cash is deducted immediately. */
export function buildOnBlock(game, blockId, type) {
  const quote = quoteBuild(game, blockId, type);
  if (!quote.ok) return { ok: false, error: quote.error, shortfall: quote.shortfall };
  return commit(game, getBlockById(game.board, blockId), quote, TXN.BUILD);
}

/** Upgrades a developed block one level. Cash is deducted immediately. */
export function upgradeBlock(game, blockId) {
  const quote = quoteUpgrade(game, blockId);
  if (!quote.ok) return { ok: false, error: quote.error, shortfall: quote.shortfall };
  return commit(game, getBlockById(game.board, blockId), quote, TXN.UPGRADE);
}
