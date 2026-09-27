import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forecastDevelopment, blockContribution, blockDetails } from '../../js/core/forecast.js';
import { createGame, placeRoad, currentPlayer, getPlayer, playerStats, TURN_PHASES } from '../../js/core/game.js';
import { getBlock, getBlockById } from '../../js/core/board.js';
import { buildOnBlock, upgradeBlock, applyDevelopment, DEV_ERRORS, MAX_LEVEL } from '../../js/core/development.js';
import { refreshBonuses } from '../../js/core/bonuses.js';
import { startEvent, costImpacts, costMultiplier, blockImpacts, effectiveBlockIncome } from '../../js/core/events.js';
import { TXN, blockUpkeep } from '../../js/core/economy.js';
import { scorePlayer } from '../../js/core/scoring.js';
import { CATEGORY_ORDER } from '../../js/core/buildings.js';
import { playthrough, loadApi } from './_playthrough.mjs';

const api = await loadApi();
const seats = (n = 4) => Array.from({ length: n }, (_, i) => ({ seat: i + 1 }));

/** P4 captures A1 through real play and is now deciding what to build there. */
function captured({ eventPool = [] } = {}) {
  const game = createGame({ seats: seats(), seed: 3, eventPool });
  for (const id of ['h-0-0', 'v-0-0', 'h-1-0', 'v-0-1']) assert.ok(placeRoad(game, id).ok);
  assert.equal(game.turnPhase, TURN_PHASES.CAPTURE_DEVELOP);
  return game;
}

/** Runs the real transaction on a copy and reads the outcome the way the game does. */
function actual(game, blockId, type) {
  const real = structuredClone(game);
  const seat = currentPlayer(real).seat;
  const ledgerBefore = real.ledger.length;
  const result = type ? buildOnBlock(real, blockId, type) : upgradeBlock(real, blockId);
  const player = getPlayer(real, seat);
  const stats = playerStats(real, player);
  const bonuses = real.board.blocks.filter((b) => b.ownerSeat === seat)
    .flatMap((b) => (b.bonuses ?? []).map((bonus) => `${b.id}:${bonus.id}:${bonus.amount}`)).sort();
  return {
    real, result, seat,
    paid: -real.ledger.slice(ledgerBefore).reduce((n, e) => n + e.delta, 0),
    cash: player.cash,
    income: stats.income,
    upkeep: stats.upkeep,
    cityValue: scorePlayer(real, player).cityValue,
    bonuses,
  };
}

function assertMatches(game, blockId, type, where) {
  const f = forecastDevelopment(game, blockId, type);
  const a = actual(game, blockId, type);
  if (!a.result.ok) {
    assert.equal(f.ok && f.affordable, false, `${where}: forecast agrees it can't be done`);
    return f;
  }
  assert.equal(f.ok, true, where);
  assert.equal(f.cost, a.paid, `${where}: cost = amount actually debited`);
  assert.equal(f.after.cash, a.cash, `${where}: cash after`);
  assert.equal(f.after.income, a.income, `${where}: income per turn (events applied)`);
  assert.equal(f.after.upkeep, a.upkeep, `${where}: upkeep per turn`);
  assert.equal(f.after.net, a.income - a.upkeep, `${where}: net per turn`);
  assert.equal(f.after.cityValue, a.cityValue, `${where}: City Value`);
  const forecastBonuses = f.after.bonuses.map((b) => `${b.block}:${b.id}:${b.amount}`).sort();
  assert.deepEqual(forecastBonuses, a.bonuses, `${where}: bonuses after`);
  const realBlock = getBlockById(a.real.board, blockId);
  assert.equal(f.after.block.income, effectiveBlockIncome(a.real, realBlock), `${where}: this block's income`);
  assert.equal(f.after.block.upkeep, blockUpkeep(realBlock), `${where}: this block's upkeep`);
  return f;
}

test('build forecasts match the real transaction for every category', () => {
  const game = captured();
  const before = JSON.stringify(game);
  for (const type of CATEGORY_ORDER) {
    const f = assertMatches(game, 'r0c0', type, type);
    assert.equal(f.affordable, true);
    assert.equal(f.delta.income, f.after.income - f.before.income);
    assert.equal(f.delta.cityValue, f.after.cityValue - f.before.cityValue);
  }
  assert.equal(JSON.stringify(game), before, 'forecasting never changes the real game');
});

test('forecast income and upkeep are exactly what the next turn start pays and charges', () => {
  const game = captured();
  const f = forecastDevelopment(game, 'r0c0', 'commercial');
  buildOnBlock(game, 'r0c0', 'commercial');
  const seat = currentPlayer(game).seat;
  // Bonus road, then everyone else paves quietly until it's P4's turn again.
  for (const id of ['h-6-5', 'h-6-4', 'h-6-3', 'h-6-2']) assert.ok(placeRoad(game, id).ok);
  assert.equal(currentPlayer(game).seat, seat);
  const turnStart = game.ledger.filter((e) => e.seat === seat && e.round === game.round);
  assert.equal(turnStart.find((e) => e.reason === TXN.TURN_INCOME).delta, f.after.income, 'income paid');
  assert.equal(-turnStart.find((e) => e.reason === TXN.UPKEEP).delta, f.after.upkeep, 'upkeep charged');
});

test('upgrade forecasts match the real transaction at every level', () => {
  const game = captured();
  buildOnBlock(game, 'r0c0', 'residential');
  getPlayer(game, 4).cash = 100000; // enough for every level
  for (let level = 1; level < MAX_LEVEL; level++) {
    assertMatches(game, 'r0c0', undefined, `upgrade from ${level}`);
    upgradeBlock(game, 'r0c0');
  }
  assert.equal(forecastDevelopment(game, 'r0c0').error, DEV_ERRORS.MAX_LEVEL);
});

test('active events: price and income modifiers are listed and included', () => {
  const game = captured({ eventPool: undefined });
  startEvent(game, 'housing-boom'); // residential: income ×1.5, cost ×1.25
  const f = assertMatches(game, 'r0c0', 'residential', 'housing boom');
  assert.equal(f.cost, Math.round(f.baseCost * costMultiplier(game, 'residential')));
  assert.ok(f.cost > f.baseCost, 'dearer during the boom');
  assert.deepEqual(f.eventPrice.map((i) => i.def.id), costImpacts(game, 'residential').map((i) => i.def.id));
  assert.deepEqual(f.eventPrice.map((i) => i.def.id), ['housing-boom']);
  assert.deepEqual(f.eventIncome.map((i) => i.def.id), ['housing-boom'], 'the new home would be boosted');
  assert.ok(f.after.block.income > f.after.block.normalIncome, 'boosted income shown against normal');
  const park = forecastDevelopment(game, 'r0c0', 'park');
  assert.deepEqual([park.eventPrice, park.eventIncome], [[], []], 'unaffected categories show no modifiers');
});

test('bonuses a build would activate are determined, on this and neighbouring blocks', () => {
  const game = captured();
  // P4 also owns B1 and C1 as homes: a third adjacent home completes a residential district.
  for (const col of [1, 2]) {
    const b = getBlock(game.board, 0, col);
    b.ownerSeat = 4;
    applyDevelopment(b, 'residential', 1);
  }
  refreshBonuses(game.board);
  const f = assertMatches(game, 'r0c0', 'residential', 'third home');
  assert.ok(f.activated.length > 0, 'something activates');
  assert.ok(f.activated.some((b) => b.block === 'r0c0'), 'on the new home');
  assert.ok(f.activated.some((b) => b.block !== 'r0c0'), 'and on its neighbours');
  assert.equal(f.delta.income, f.after.income - f.before.income);
  const lone = forecastDevelopment(game, 'r0c0', 'industrial');
  assert.ok(!lone.activated.some((b) => /Residential district/.test(b.label)), 'a factory completes no residential district');
});

test('unaffordable builds still show what they would do; impossible ones say why', () => {
  const game = captured();
  getPlayer(game, 4).cash = 100;
  const f = forecastDevelopment(game, 'r0c0', 'landmark');
  assert.equal(f.ok, true);
  assert.equal(f.affordable, false);
  assert.ok(f.shortfall > 0);
  assert.ok(f.after.income > f.before.income, 'income forecast independent of cash');
  assert.equal(f.after.cash, null);
  assert.equal(f.delta.cityValue, null);
  const other = forecastDevelopment(game, 'r5c5', 'park');
  assert.equal(other.ok, false);
  assert.equal(other.error, DEV_ERRORS.NOT_OWNER);
});

test('City Value contribution is the scoring formula with and without the block', () => {
  const game = captured();
  buildOnBlock(game, 'r0c0', 'civic');
  const owner = getPlayer(game, 4);
  const withBlock = scorePlayer(game, owner).cityValue;
  const lost = structuredClone(game);
  getBlockById(lost.board, 'r0c0').ownerSeat = null;
  assert.equal(blockContribution(game, 'r0c0'), withBlock - scorePlayer(lost, getPlayer(lost, 4)).cityValue);
  assert.ok(blockContribution(game, 'r0c0') > 0);
  assert.equal(blockContribution(game, 'r5c5'), null, 'unowned');
  const d = blockDetails(game, 'r0c0');
  assert.equal(d.net, d.income - d.upkeep);
  assert.deepEqual(d.eventIncome, blockImpacts(game, getBlockById(game.board, 'r0c0')));
});

test('sweep: forecasts match real transactions across seeds, presets and game stages', () => {
  let checked = 0;
  for (const mode of ['standard', 'classic', 'chaos']) {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      for (const roads of [20, 40, 60]) {
        const { game } = playthrough(api, { seats: seats(seed % 3 + 2), seed, mode }, { stopAfterRoads: roads });
        if (game.phase !== 'playing') continue;
        if (game.turnPhase === TURN_PHASES.PAVE_ROAD || game.turnPhase === TURN_PHASES.BONUS_ROAD) continue;
        if (currentPlayer(game).cash < 0) continue;
        for (const block of game.board.blocks.filter((b) => b.ownerSeat === currentPlayer(game).seat)) {
          const options = block.level === 0 ? CATEGORY_ORDER : [undefined];
          for (const type of options) {
            assertMatches(game, block.id, type, `${mode} seed ${seed} @${roads} ${block.id} ${type ?? 'upgrade'}`);
            checked++;
          }
        }
      }
    }
  }
  assert.ok(checked > 100, `checked ${checked} forecasts`);
});
