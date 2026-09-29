/**
 * Strategic category effects (core/strategy.js): Prestige, control, pressure, takeovers and the
 * industrial discount, plus how they reach scoring, forecasts and the CPU.
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
import { quoteTakeover, takeoverBlock, FIN_ERRORS, ownershipProblems } from '../../js/core/finance.js';
import {
  blockPrestige, prestigeFor, blockControl, pressureOn, canPressure, industryDiscount, CATEGORY_EFFECTS, PRESTIGE_NOTES,
} from '../../js/core/strategy.js';
import { chooseCityAction, applyCityAction } from '../../js/core/cpu/city.js';
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
  assert.ok(Object.isFrozen(S) && Object.isFrozen(S.PRESTIGE.perLevel) && Object.isFrozen(S.CONTROL.perLevel));
  assert.deepEqual(Object.keys(S.PRESTIGE.perLevel).sort(), [...CATEGORY_ORDER].sort());
  for (const type of CATEGORY_ORDER) assert.ok(CATEGORY_EFFECTS[type]?.length > 20, type);
  // Park and Landmark earn Prestige, Landmark far more; the rest earn none on their own.
  assert.ok(S.PRESTIGE.perLevel.landmark > S.PRESTIGE.perLevel.park && S.PRESTIGE.perLevel.park > 0);
  assert.equal(S.PRESTIGE.perLevel.residential, 0);
  // Landmark defends the most; Commercial is the only pressure.
  assert.ok(S.CONTROL.perLevel.landmark > S.CONTROL.perLevel.residential);
  assert.deepEqual(Object.keys(S.PRESSURE.perLevel), ['commercial']);
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

/* ---------------- control & pressure ---------------- */

test('control: base plus nearby own Residential, Civic and Landmark levels', () => {
  const game = place(calm(), [
    [2, 2, 1], [2, 3, 1, 'residential', 2], [1, 2, 1, 'civic', 1], [3, 2, 1, 'landmark', 1], [2, 1, 2, 'residential', 3], [4, 4, 1, 'residential', 3],
  ]);
  const { control, notes } = blockControl(game.board, at(game, 2, 2));
  assert.equal(control, S.CONTROL.base + 2 * S.CONTROL.perLevel.residential + S.CONTROL.perLevel.civic + S.CONTROL.perLevel.landmark);
  assert.deepEqual(notes.map((n) => n.type).sort(), ['civic', 'landmark', 'residential'], 'rival and far blocks do not help');
  assert.equal(at(game, 2, 2).control, control, 'stored for display');
  // A Residential block defends itself too.
  assert.equal(blockControl(game.board, at(game, 4, 4)).control, S.CONTROL.base + 3 * S.CONTROL.perLevel.residential);
  assert.equal(blockControl(game.board, at(game, 5, 5)).control, 0, 'unowned');
});

test('pressure: a player\'s nearby Commercial levels on a rival block', () => {
  const game = place(calm(), [[2, 2, 1], [2, 3, 2, 'commercial', 2], [1, 2, 2, 'commercial', 1], [2, 1, 1, 'commercial', 3], [5, 5, 2, 'commercial', 3]]);
  assert.equal(pressureOn(game.board, 2, at(game, 2, 2)), 3 * S.PRESSURE.perLevel.commercial);
  assert.equal(canPressure(game.board, 2, at(game, 2, 2)), true, `3 > control ${at(game, 2, 2).control}`);
  assert.equal(canPressure(game.board, 1, at(game, 2, 2)), false, 'never your own block');
});

/* ---------------- takeovers ---------------- */

/** Seat 1 (to move) has two Market-level shops beside seat 2's house. */
function takeoverTable() {
  const game = place(calm(), [[2, 2, 2, 'residential', 1], [2, 3, 1, 'commercial', 2], [1, 2, 1, 'commercial', 2]]);
  assert.equal(currentPlayer(game).seat, 1);
  assert.equal(game.turnPhase, TURN_PHASES.MANAGE_CITY);
  return game;
}

test('takeover: pressure beats control, the owner is paid the premium, development moves', () => {
  const game = takeoverTable();
  const house = at(game, 2, 2);
  const q = quoteTakeover(game, 'r2c2');
  assert.equal(q.ok, true, q.error);
  assert.deepEqual([q.pressure, q.control, q.owner], [4, 2, 2]);
  assert.equal(q.cost, Math.round(((house.price + house.investedCostBasis) * S.TAKEOVER.pricePercent) / 100));
  const [buyer, seller] = [getPlayer(game, 1).cash, getPlayer(game, 2).cash];
  const r = takeoverBlock(game, 'r2c2');
  assert.equal(r.ok, true);
  assert.equal(house.ownerSeat, 1);
  assert.deepEqual([house.type, house.level], ['residential', 1], 'the building comes with it');
  assert.equal(getPlayer(game, 1).cash, buyer - q.cost);
  assert.equal(getPlayer(game, 2).cash, seller + q.cost);
  assert.deepEqual(game.ledger.slice(-2).map((e) => [e.seat, e.reason, e.delta]), [[1, TXN.TAKEOVER, -q.cost], [2, TXN.TAKEOVER, q.cost]]);
  assert.equal(game.log.at(-1).type, 'takeover');
  assert.deepEqual(ownershipProblems(game), []);
  assert.equal(quoteTakeover(game, 'r2c2').error, FIN_ERRORS.NOT_RIVAL, 'now it is yours');
});

test('takeover is refused when control holds, off-phase, in debt, unaffordable, or out of City Actions', () => {
  const game = takeoverTable();
  place(game, [[3, 2, 2, 'residential', 3]]); // seat 2 fortifies: control 2 + 3 = 5 > pressure 4
  const before = JSON.stringify(game.board);
  assert.equal(takeoverBlock(game, 'r2c2').error, FIN_ERRORS.CONTROL_HOLDS);
  assert.equal(JSON.stringify(game.board), before);

  const g2 = takeoverTable();
  getPlayer(g2, 1).cash = 10;
  assert.equal(quoteTakeover(g2, 'r2c2').error, FIN_ERRORS.INSUFFICIENT_FUNDS);
  getPlayer(g2, 1).cash = -10;
  assert.equal(quoteTakeover(g2, 'r2c2').error, FIN_ERRORS.IN_DISTRESS);
  getPlayer(g2, 1).cash = 50000;
  g2.turnPhase = TURN_PHASES.PAVE_ROAD;
  assert.equal(quoteTakeover(g2, 'r2c2').error, FIN_ERRORS.WRONG_PHASE);
  g2.turnPhase = TURN_PHASES.MANAGE_CITY;
  assert.equal(quoteTakeover(g2, 'r5c5').error, FIN_ERRORS.NOT_RIVAL, 'unowned land is captured, not taken over');

  // CITY era: a takeover is a City Action.
  g2.era = ERAS.CITY;
  g2.city.actionsLeft = 1;
  assert.equal(takeoverBlock(g2, 'r2c2').ok, true);
  assert.equal(g2.city.actionsLeft, 0);
  place(g2, [[4, 4, 2]]);
  assert.equal(quoteTakeover(g2, 'r4c4').error, FIN_ERRORS.CONTROL_HOLDS);
});

test('the inspector and forecasts show Prestige, control and pressure', () => {
  const game = takeoverTable();
  const d = blockDetails(game, 'r2c2');
  assert.deepEqual([d.control, d.pressure, d.contestable, d.prestige], [2, 4, true, 0]);
  assert.equal(blockDetails(game, 'r2c3').pressure, null, 'no pressure on your own block');
  place(game, [[0, 0, 1]]);
  const f = forecastDevelopment(game, 'r0c0', 'landmark');
  assert.equal(f.delta.prestige, S.PRESTIGE.perLevel.landmark);
  assert.equal(f.delta.cityValue, S.PRESTIGE.perLevel.landmark * ECONOMY.SCORING.PRESTIGE,
    'construction counts in full, so a build changes City Value by exactly its Prestige');
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

test('a Normal/Hard CPU takes over a block when it pays, and the move is legal', () => {
  const game = place(calm(2, [{ seat: 1, controller: 'cpu', difficulty: 'hard' }, { seat: 2 }]), [
    [2, 2, 2, 'landmark', 1], [2, 3, 1, 'commercial', 3], [1, 2, 1, 'commercial', 3],
  ]);
  getPlayer(game, 1).cash = 60000;
  const d = chooseCityAction(game, { seed: 1 });
  assert.deepEqual([d.action, d.blockId], ['takeover', 'r2c2'], JSON.stringify(d));
  assert.equal(applyCityAction(game, d).ok, true);
  assert.equal(getBlockById(game.board, 'r2c2').ownerSeat, 1);
  // Easy never takes over.
  const easy = place(calm(2, [{ seat: 1, controller: 'cpu', difficulty: 'easy' }, { seat: 2 }]), [
    [2, 2, 2, 'landmark', 1], [2, 3, 1, 'commercial', 3], [1, 2, 1, 'commercial', 3],
  ]);
  for (let seed = 0; seed < 10; seed++) assert.notEqual(chooseCityAction(easy, { seed }).action, 'takeover');
});

test('CPU forecasts carry Prestige: a Landmark adds more City Value than a Residential build', () => {
  const game = place(calm(2, [{ seat: 1, controller: 'cpu', difficulty: 'hard' }, { seat: 2 }]), [[3, 3, 1]]);
  getPlayer(game, 1).cash = 30000;
  const hard = forecastDevelopment(game, 'r3c3', 'landmark');
  const home = forecastDevelopment(game, 'r3c3', 'residential');
  assert.ok(hard.delta.cityValue > home.delta.cityValue, 'the forecast carries the Prestige');
});
