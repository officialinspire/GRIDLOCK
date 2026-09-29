/**
 * Strategic category effects (core/strategy.js): Prestige and the industrial discount, plus how
 * they reach scoring, forecasts and the CPU. Takeover strengths and rules: takeover.test.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ECONOMY } from '../../js/config.js';
import { getBlock, getBlockById } from '../../js/core/board.js';
import { applyDevelopment, buildOnBlock, upgradeBlock, quoteBuild, quoteUpgrade, TABLE } from '../../js/core/development.js';
import { refreshBonuses } from '../../js/core/bonuses.js';
import { TXN } from '../../js/core/economy.js';
import { createGame, currentPlayer, getPlayer, playerStats, TURN_PHASES, ERAS } from '../../js/core/game.js';
import { scorePlayer, computeResults } from '../../js/core/scoring.js';
import { forecastDevelopment, blockDetails } from '../../js/core/forecast.js';
import {
  blockPrestige, prestigeFor, industryDiscount, CATEGORY_EFFECTS, PRESTIGE_NOTES,
} from '../../js/core/strategy.js';
import { CATEGORY_ORDER } from '../../js/core/buildings.js';

const S = ECONOMY.STRATEGY;
const calm = (n = 2, seats) => createGame({ seats: seats ?? Array.from({ length: n }, (_, i) => ({ seat: i + 1 })), seed: 1, eventPool: [] });

/** Sets ownership/development directly (row, col, seat, type, level) and refreshes derived data. */
function place(game, list) {
  for (const [row, col, seat, type = 'vacant', level = 0] of list) {
    const b = getBlock(game.board, row, col);
    b.ownerSeat = seat;
    applyDevelopment(b, type, level);
  }
  refreshBonuses(game.board);
  return game;
}
const at = (game, row, col) => getBlock(game.board, row, col);

/* ---------------- configuration ---------------- */

test('strategic effects are data in config.js, and every category explains itself', () => {
  assert.ok(Object.isFrozen(S) && Object.isFrozen(S.PRESTIGE.perLevel));
  assert.deepEqual(Object.keys(S.PRESTIGE.perLevel).sort(), [...CATEGORY_ORDER].sort());
  for (const type of CATEGORY_ORDER) assert.ok(CATEGORY_EFFECTS[type]?.length > 20, type);
  // Park and Landmark earn Prestige, Landmark far more; the rest earn none on their own.
  assert.ok(S.PRESTIGE.perLevel.landmark > S.PRESTIGE.perLevel.park && S.PRESTIGE.perLevel.park > 0);
  assert.equal(S.PRESTIGE.perLevel.residential, 0);
});

/* ---------------- Prestige ---------------- */

test('Prestige: Landmark and Park per level, Civic too, Residential/Commercial none', () => {
  const game = place(calm(), [
    [0, 0, 1, 'landmark', 2], [0, 2, 1, 'park', 3], [0, 4, 1, 'civic', 1], [2, 0, 1, 'residential', 3], [2, 2, 1, 'commercial', 3],
  ]);
  assert.equal(at(game, 0, 0).prestige, 2 * S.PRESTIGE.perLevel.landmark);
  assert.equal(at(game, 0, 2).prestige, 3 * S.PRESTIGE.perLevel.park);
  assert.equal(at(game, 0, 4).prestige, S.PRESTIGE.perLevel.civic);
  assert.equal(at(game, 2, 0).prestige, 0);
  assert.equal(at(game, 2, 2).prestige, 0);
  assert.equal(prestigeFor(game.board, 1), 2 * 3 + 3 * 1 + 1);
  assert.equal(prestigeFor(game.board, 2), 0);
});

test('Parks add Prestige to adjacent own blocks, up to the cap', () => {
  const game = place(calm(), [
    [1, 1, 1, 'residential', 1], [0, 1, 1, 'park', 1], [1, 0, 1, 'park', 1], [1, 2, 1, 'park', 1], [2, 1, 2, 'park', 1],
  ]);
  const home = blockPrestige(game.board, at(game, 1, 1));
  assert.deepEqual(home.notes.map((n) => [n.id, n.points]), [[PRESTIGE_NOTES.PARK_NEIGHBOUR, S.PRESTIGE.parkNeighbourMax * S.PRESTIGE.parkNeighbour]],
    'three own parks, capped; the rival park does not count');
  // Vacant land never gets Prestige.
  place(game, [[1, 1, 1]]);
  assert.equal(at(game, 1, 1).prestige, 0);
});

test('Industry beside homes loses Prestige, unless an own Park buffers it', () => {
  const game = place(calm(), [[2, 2, 1, 'industrial', 2], [2, 3, 2, 'residential', 1]]);
  const factory = at(game, 2, 2);
  assert.equal(factory.prestige, -S.PRESTIGE.industrialPenaltyPerLevel * 2, 'anyone\'s homes count');
  assert.equal(factory.prestigeNotes[0].id, PRESTIGE_NOTES.INDUSTRIAL_NUISANCE);
  assert.equal(prestigeFor(game.board, 1), 0, 'a player\'s total never goes below zero');
  place(game, [[2, 1, 1, 'park', 1]]);
  assert.equal(factory.prestige, S.PRESTIGE.parkNeighbour, 'buffered by the park, which also lends it Prestige');
  // No homes nearby: no penalty.
  const quiet = place(calm(), [[5, 5, 1, 'industrial', 3]]);
  assert.equal(at(quiet, 5, 5).prestige, 0);
});

test('Prestige scores in City Value, is a tie-breaker, and abandoned blocks lose it', () => {
  const game = place(calm(), [[0, 0, 1, 'landmark', 1]]);
  const sc = scorePlayer(game, getPlayer(game, 1));
  assert.equal(sc.prestige, S.PRESTIGE.perLevel.landmark);
  assert.equal(sc.scoredPrestige, sc.prestige * ECONOMY.SCORING.PRESTIGE);
  assert.equal(sc.cityValue, sc.scoredCash + sc.scoredLand + sc.scoredBuildings + sc.scoredPrestige);
  assert.equal(playerStats(game, getPlayer(game, 1)).prestige, sc.prestige, 'the HUD shows the scored number');
  // Excluding the block (City Value contribution) removes its Prestige too.
  assert.equal(scorePlayer(game, getPlayer(game, 1), { exclude: 'r0c0' }).prestige, 0);
  Object.assign(at(game, 0, 0), { ownerSeat: null, abandoned: true, abandonedBy: 1 });
  refreshBonuses(game.board);
  assert.equal(prestigeFor(game.board, 1), 0);
});

test('development beats owning more blocks: a smaller, built-up city wins', () => {
  const game = calm();
  // Seat 1: three vacant suburb lots. Seat 2: two suburb lots it paid to build a Landmark and a Park on.
  place(game, [[0, 0, 1], [0, 1, 1], [0, 2, 1], [5, 0, 2, 'landmark', 1], [5, 1, 2, 'park', 1]]);
  getPlayer(game, 2).cash -= TABLE.landmark[1].cost + TABLE.park[1].cost;
  const r = computeResults(game);
  // Seat 1: $12,000 + 70% × $3,000 = $14,100. Seat 2: $8,200 + 70% × $2,000 + $3,800 built
  // + 5 Prestige ($750) = $14,150. (Under the old 100% land / 75% buildings it lost, $13,050 to $15,000.)
  assert.deepEqual(r.rows.map((x) => [x.seat, x.cityValue]), [[2, 14150], [1, 14100]]);
  assert.ok(r.rows[0].blocks < r.rows[1].blocks);
});

/* ---------------- industry ---------------- */

test('industry: builds and upgrades next to your own factory cost less', () => {
  const game = place(calm(), [[2, 2, 1, 'industrial', 1], [2, 3, 1], [2, 1, 2], [4, 4, 1], [1, 2, 1, 'residential', 1]]);
  const q = quoteBuild(game, 'r2c3', 'commercial');
  assert.equal(q.industryDiscount, S.INDUSTRY.costDiscountPercent);
  assert.equal(q.cost, Math.round(TABLE.commercial[1].cost * (100 - S.INDUSTRY.costDiscountPercent) / 100));
  assert.equal(quoteBuild(game, 'r4c4', 'commercial').cost, TABLE.commercial[1].cost, 'not adjacent: list price');
  assert.equal(quoteUpgrade(game, 'r1c2').industryDiscount, S.INDUSTRY.costDiscountPercent, 'upgrades too');
  assert.equal(industryDiscount(game.board, 2, at(game, 2, 1)), 0, 'a rival\'s factory gives you nothing');
  const cash = getPlayer(game, 1).cash;
  const r = buildOnBlock(game, 'r2c3', 'commercial');
  assert.equal(getPlayer(game, 1).cash, cash - q.cost);
  assert.equal(at(game, 2, 3).investedCostBasis, q.cost, 'cost basis is what was paid');
  assert.equal(r.cost, q.cost);
  assert.equal(upgradeBlock(game, 'r1c2').cost, Math.round(TABLE.residential[2].cost * 0.9));
});

/* ---------------- CPU ---------------- */

test('CPU forecasts carry Prestige: a Landmark adds more City Value than a Residential build', () => {
  const game = place(calm(2, [{ seat: 1, controller: 'cpu', difficulty: 'hard' }, { seat: 2 }]), [[3, 3, 1]]);
  getPlayer(game, 1).cash = 30000;
  const hard = forecastDevelopment(game, 'r3c3', 'landmark');
  const home = forecastDevelopment(game, 'r3c3', 'residential');
  assert.ok(hard.delta.cityValue > home.delta.cityValue, 'the forecast carries the Prestige');
});
