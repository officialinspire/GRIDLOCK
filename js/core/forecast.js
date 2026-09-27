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

/** How much a block adds to its owner's City Value (the scoring formula with and without it). */
export function blockContribution(game, blockId) {
  const block = getBlockById(game.board, blockId);
  const owner = block?.ownerSeat != null ? getPlayer(game, block.ownerSeat) : null;
  if (!owner) return null;
  return scorePlayer(game, owner).cityValue - scorePlayer(game, owner, { exclude: blockId }).cityValue;
}

/** Everything the inspector shows about one block right now. */
export function blockDetails(game, blockId) {
  const block = getBlockById(game.board, blockId);
  if (!block) return null;
  const income = effectiveBlockIncome(game, block);
  const upkeep = block.ownerSeat != null ? blockUpkeep(block) : 0;
  return {
    income, // what it pays at its owner's next turn start (events applied)
    normalIncome: blockIncome(block), // base + bonuses, without events
    upkeep,
    net: income - upkeep,
    contribution: blockContribution(game, blockId),
    bonuses: (block.bonuses ?? []).map((b) => ({ ...b })),
    eventIncome: blockImpacts(game, block),
    eventPrice: block.type !== 'vacant' ? costImpacts(game, block.type) : [],
  };
}

/** A player's per-turn position and City Value, read with the game's own functions. */
function position(game, seat, blockId) {
  const player = getPlayer(game, seat);
  const stats = playerStats(game, player);
  const bonuses = [];
  for (const b of game.board.blocks) {
    if (b.ownerSeat !== seat) continue;
    for (const bonus of b.bonuses ?? []) bonuses.push({ block: b.id, blockLabel: b.label, ...bonus });
  }
  return {
    cash: player.cash,
    income: stats.income,
    upkeep: stats.upkeep,
    net: stats.income - stats.upkeep,
    cityValue: scorePlayer(game, player).cityValue,
    block: blockDetails(game, blockId),
    bonuses,
  };
}

const bonusKey = (b) => `${b.block}:${b.id}`;

/**
 * Forecast building `type` on a vacant block, or upgrading it when `type` is omitted.
 * Returns { ok:false, error } if the move isn't possible for a reason other than cash;
 * otherwise { ok:true, affordable, shortfall, cost, baseCost, level, type, before, after,
 * delta: { income, upkeep, net, cityValue }, activated, eventPrice, eventIncome }.
 * When the player can't afford it, income/upkeep/bonuses are still forecast (they don't
 * depend on cash) and cash/City Value after are null.
 */
export function forecastDevelopment(game, blockId, type) {
  const upgrade = type == null;
  const quote = upgrade ? quoteUpgrade(game, blockId) : quoteBuild(game, blockId, type);
  if (!quote.ok && quote.error !== DEV_ERRORS.INSUFFICIENT_FUNDS) return { ok: false, error: quote.error, quote };

  const seat = currentPlayer(game).seat;
  const sim = structuredClone(game);
  if (!quote.ok) getPlayer(sim, seat).cash += quote.shortfall; // forecast the build itself, not the budget
  const result = upgrade ? upgradeBlock(sim, blockId) : buildOnBlock(sim, blockId, type);
  if (!result.ok) return { ok: false, error: result.error, quote };

  const before = position(game, seat, blockId);
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
    },
    // Bonuses this build switches on, on this block or on the player's other blocks.
    activated: after.bonuses.filter((b) => !had.has(bonusKey(b))),
    eventPrice: costImpacts(game, result.type),
    eventIncome: after.block.eventIncome,
  };
}
