/**
 * Strategic forecasts for the Build panel and inspector, with no formulas of their own.
 *
 * A forecast runs the real transaction (buildOnBlock / upgradeBlock) on a throwaway
 * copy of the game, then reads "before" and "after" with the same functions the game
 * uses everywhere: playerStats (income with events, upkeep), scorePlayer (City Value),
 * effectiveBlockIncome, blockUpkeep, blockImpacts / costImpacts (events) and the
 * bonuses the real refreshBonuses wrote. So a forecast is exactly what will happen.
 */
import { getBlockById } from './board.js';
import { currentPlayer, getPlayer, playerStats } from './game.js';
import { quoteBuild, quoteUpgrade, buildOnBlock, upgradeBlock, DEV_ERRORS } from './development.js';
import { effectiveBlockIncome, blockImpacts, costImpacts } from './events.js';
import { blockUpkeep, blockIncome } from './economy.js';
import { scorePlayer } from './scoring.js';
import { blockPrestige, controlStrength } from './strategy.js';
import { usesCityAction } from './game.js';
import { quoteTakeover, shieldStatus } from './takeover.js';
import { measure } from './perf.js';
import { remember, plannerOptimizations } from './memo.js';

/*
 * Inside a CPU decision (core/memo.js) the readings below are remembered per game view: a player's
 * stats, bonuses and score, a block's details and the "before" side of every forecast are the same
 * for all the options the planner prices on that view. Outside one they are simply computed.
 */
export const scoreOf = (game, player) => remember(game, `score|${player.seat}`, () => scorePlayer(game, player));
export const statsOf = (game, player) => remember(game, `stats|${player.seat}`, () => playerStats(game, player));
const detailsOf = (game, blockId) => remember(game, `details|${blockId}`, () => blockDetails(game, blockId));

/**
 * A throwaway copy of `game` to run one real transaction on (a forecast, a CPU what-if). Every
 * transaction it is used for (build, upgrade, sale, downgrade, redevelopment auction, takeover)
 * only assigns: cash and ownership, a block's development and shields, every block's bonuses
 * (refreshBonuses rewrites them all, with new arrays), the city's action counts, the ledger and
 * the log. So those are copied (players, city, each block, fresh empty history) and the rest is
 * shared, never written: roads, events, event definitions, rules. Much cheaper than a deep copy
 * of the whole game; with the planner optimizations off (tests), a full structuredClone.
 */
export function simulationCopy(game) {
  if (!plannerOptimizations()) return structuredClone({ ...game, ledger: [], log: [] });
  return {
    ...game,
    ledger: [],
    log: [],
    players: game.players.map((player) => ({ ...player })),
    city: { ...game.city },
    board: { ...game.board, blocks: game.board.blocks.map((block) => ({ ...block })) },
  };
}

/** How much a block adds to its owner's City Value (the scoring formula with and without it). */
export function blockContribution(game, blockId) {
  const block = getBlockById(game.board, blockId);
  const owner = block?.ownerSeat != null ? getPlayer(game, block.ownerSeat) : null;
  if (!owner) return null;
  return scoreOf(game, owner).cityValue - scorePlayer(game, owner, { exclude: blockId }).cityValue;
}

/** Everything the inspector shows about one block right now. */
export function blockDetails(game, blockId) {
  return measure('blockDetails', () => readBlock(game, blockId));
}

function readBlock(game, blockId) {
  const block = getBlockById(game.board, blockId);
  if (!block) return null;
  const income = effectiveBlockIncome(game, block);
  const upkeep = block.ownerSeat != null ? blockUpkeep(block) : 0;
  const prestige = blockPrestige(game.board, block);
  const me = currentPlayer(game);
  return {
    income, // what it pays at its owner's next turn start (events applied)
    normalIncome: blockIncome(block), // base + bonuses, without events
    upkeep,
    net: income - upkeep,
    prestige: prestige.points, // this block's Prestige for its owner (core/strategy.js)
    prestigeNotes: prestige.notes,
    control: controlStrength(game.board, block).control, // takeover defence (0 when unowned)
    shieldedUntil: block.shieldedUntil ?? null, // last round of a takeover shield (see shield)
    shield: shieldStatus(game, block), // null, or { untilRound, seat }: protected now (seat: until their turn ends)
    // For a rival's block: the current player's takeover quote (pressure, cost, reason if refused).
    takeover: me && block.ownerSeat != null && !block.abandoned && block.ownerSeat !== me.seat ? quoteTakeover(game, blockId) : null,
    contribution: blockContribution(game, blockId),
    bonuses: (block.bonuses ?? []).map((b) => ({ ...b })),
    eventIncome: blockImpacts(game, block),
    eventPrice: block.type !== 'vacant' ? costImpacts(game, block.type) : [],
  };
}

/** A player's per-turn position and City Value, read with the game's own functions. */
function position(game, seat, blockId) {
  const player = getPlayer(game, seat);
  const stats = statsOf(game, player);
  const bonuses = remember(game, `bonuses|${seat}`, () => {
    const out = [];
    for (const b of game.board.blocks) {
      if (b.ownerSeat !== seat) continue;
      for (const bonus of b.bonuses ?? []) out.push({ block: b.id, blockLabel: b.label, ...bonus });
    }
    return out;
  });
  const score = scoreOf(game, player);
  return {
    cash: player.cash,
    income: stats.income,
    upkeep: stats.upkeep,
    net: stats.income - stats.upkeep,
    cityValue: score.cityValue,
    prestige: score.prestige,
    block: detailsOf(game, blockId),
    bonuses,
  };
}

const bonusKey = (b) => `${b.block}:${b.id}`;

/**
 * Forecast building `type` on a vacant block, or upgrading it when `type` is omitted.
 * Returns { ok:false, error } if the move isn't possible for a reason other than cash or the
 * turn's management actions; otherwise { ok:true, affordable, shortfall, actionAvailable,
 * usesAction, cost, baseCost, level, type, before, after, delta: { income, upkeep, net,
 * cityValue, prestige }, industryDiscount, activated, eventPrice, eventIncome }.
 *   usesAction       the build spends one of the turn's management actions (false for Develop
 *                    Now on a just-captured block, a free capture reward)
 *   actionAvailable  false when this Manage City has no management actions left (the forecast
 *                    shows what it would do next turn)
 * When the player can't afford it, income/upkeep/bonuses are still forecast (they don't
 * depend on cash) and cash/City Value after are null.
 */
export function forecastDevelopment(game, blockId, type) {
  return measure('forecastDevelopment', () => forecast(game, blockId, type));
}

function forecast(game, blockId, type) {
  const upgrade = type == null;
  const requote = (g) => (upgrade ? quoteUpgrade(g, blockId) : quoteBuild(g, blockId, type));
  let quote = requote(game);
  const usesAction = usesCityAction(game);
  // Out of actions: price it as if this Manage City still had one (it's shown, not done), on a
  // view with one more action, so the game itself is never touched.
  const actionAvailable = quote.error !== DEV_ERRORS.NO_ACTIONS;
  if (!actionAvailable) quote = requote({ ...game, city: { ...game.city, actionsLeft: game.city.actionsLeft + 1 } });
  if (!quote.ok && quote.error !== DEV_ERRORS.INSUFFICIENT_FUNDS) return { ok: false, error: quote.error, quote };

  const seat = currentPlayer(game).seat;
  const sim = simulationCopy(game);
  if (!actionAvailable) sim.city.actionsLeft += 1;
  if (!quote.ok) getPlayer(sim, seat).cash += quote.shortfall; // forecast the build itself, not the budget
  const result = upgrade ? upgradeBlock(sim, blockId) : buildOnBlock(sim, blockId, type);
  if (!result.ok) return { ok: false, error: result.error, quote };

  const before = remember(game, `position|${seat}|${blockId}`, () => position(game, seat, blockId));
  const after = position(sim, seat, blockId);
  if (!quote.ok) {
    after.cash = null;
    after.cityValue = null;
  }
  const had = new Set(before.bonuses.map(bonusKey));
  return {
    ok: true,
    affordable: quote.ok,
    shortfall: quote.shortfall,
    actionAvailable,
    usesAction,
    cost: result.cost,
    baseCost: quote.baseCost,
    level: result.level,
    type: result.type,
    before,
    after,
    delta: {
      income: after.income - before.income,
      upkeep: after.upkeep - before.upkeep,
      net: after.net - before.net,
      cityValue: after.cityValue == null ? null : after.cityValue - before.cityValue,
      prestige: after.prestige - before.prestige,
    },
    industryDiscount: quote.industryDiscount ?? 0,
    // Bonuses this build switches on, on this block or on the player's other blocks.
    activated: after.bonuses.filter((b) => !had.has(bonusKey(b))),
    eventPrice: costImpacts(game, result.type),
    eventIncome: after.block.eventIncome,
  };
}
