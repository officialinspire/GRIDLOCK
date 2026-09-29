/**
 * Hostile redevelopment (core/takeover.js) and its strengths (core/strategy.js).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ECONOMY } from '../../js/config.js';
import { getBlock, getBlockById, allRoadIds } from '../../js/core/board.js';
import { applyDevelopment } from '../../js/core/development.js';
import { refreshBonuses } from '../../js/core/bonuses.js';
import { TXN } from '../../js/core/economy.js';
import {
  createGame, currentPlayer, getPlayer, enterCityEra, endCityTurn, TURN_PHASES, ERAS,
} from '../../js/core/game.js';
import { controlStrength, developmentPressure, pressureBeatsControl } from '../../js/core/strategy.js';
import {
  quoteTakeover, takeoverBlock, takeoverCandidates, isShielded, TAKEOVER_ERRORS, TAKEOVER_REASONS,
} from '../../js/core/takeover.js';
import { ownershipProblems } from '../../js/core/finance.js';
import { blockDetails } from '../../js/core/forecast.js';
import { saveActiveGame, loadActiveGame, SAVE_KEY } from '../../js/core/persistence.js';
import { chooseCityAction, applyCityAction } from '../../js/core/cpu/city.js';

const T = ECONOMY.TAKEOVER;
const memoryStorage = () => {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
};

/** Sets ownership/development directly: [row, col, seat, type, level]. */
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
const snap = (game) => JSON.stringify({ board: game.board, players: game.players, city: game.city, ledger: game.ledger, log: game.log });

/** Two mayors, every road paved; `city` false leaves it in EXPANSION. Seat 1 is in Manage City. */
function table({ city = true, seats, cityRounds } = {}) {
  const game = createGame({ seats: seats ?? [{ seat: 1 }, { seat: 2 }], seed: 3, eventPool: [], cityRounds });
  if (city) {
    for (const id of allRoadIds(game.board)) game.board.roads[id] = 1;
    assert.equal(enterCityEra(game), true);
  }
  for (const p of game.players) p.cash = 50000;
  return game;
}

/** Seat 2's House at C3 (control 3) beside seat 1's Market (5 pressure) and Corner Store (3). */
function duel(options) {
  return place(table(options), [[2, 2, 2, 'residential', 1], [2, 3, 1, 'commercial', 2], [1, 2, 1, 'commercial', 1]]);
}

/* ---------------- strengths ---------------- */

test('controlStrength: ownership + level + nearby Residential/Civic/Landmark defence + adjacent support', () => {
  const game = place(table(), [
    [2, 2, 2, 'residential', 2], [2, 1, 2, 'civic', 1], [3, 2, 2, 'landmark', 1], [1, 2, 1, 'commercial', 1], [4, 4, 2, 'residential', 3],
  ]);
  const c = controlStrength(game.board, at(game, 2, 2));
  assert.deepEqual(c.parts, {
    base: T.CONTROL.base,
    level: 2 * T.CONTROL.perLevel,
    defence: 2 * T.CONTROL.defence.residential + T.CONTROL.defence.civic + T.CONTROL.defence.landmark,
    support: 2 * T.CONTROL.supportPerAdjacent, // the civic and landmark next door; the rival shop doesn't help
  });
  assert.equal(c.control, T.CONTROL.base + 2 + 5 + 2);
  assert.equal(at(game, 2, 2).control, c.control, 'stored for display');
  assert.equal(controlStrength(game.board, at(game, 0, 0)).control, 0, 'unowned');
  place(game, [[0, 0, 2]]);
  assert.deepEqual(controlStrength(game.board, at(game, 0, 0)).parts, { base: T.CONTROL.base, level: 0, defence: 0, support: 0 }, 'a bare lot');
});

test('developmentPressure: adjacent developed attacker blocks, Commercial counting extra', () => {
  const game = place(table(), [[2, 2, 2], [2, 3, 1, 'commercial', 2], [1, 2, 1, 'park', 1], [2, 1, 1], [4, 4, 1, 'commercial', 3]]);
  const p = developmentPressure(game.board, 1, at(game, 2, 2));
  assert.deepEqual(p.parts, { adjacent: 2 * T.PRESSURE.perAdjacent, commercial: 2 * T.PRESSURE.commercialPerLevel },
    'the vacant lot and the far shop add nothing');
  assert.equal(p.pressure, 2 * T.PRESSURE.perAdjacent + 2 * T.PRESSURE.commercialPerLevel);
  assert.equal(developmentPressure(game.board, 2, at(game, 2, 2)).pressure, 0, 'never on your own block');
  assert.equal(pressureBeatsControl(game.board, 1, at(game, 2, 2)), true, `${p.pressure} > ${at(game, 2, 2).control}`);
});

/* ---------------- a takeover ---------------- */

test('a takeover: pressure beats control, 125% paid, the defender gets market value, development moves', () => {
  const game = duel();
  const house = at(game, 2, 2);
  const q = quoteTakeover(game, 'r2c2');
  assert.equal(q.ok, true, q.reason);
  assert.deepEqual([q.pressure, q.control, q.owner], [8, 3, 2]);
  assert.equal(q.marketValue, house.marketValue);
  assert.equal(q.cost, Math.round((house.marketValue * T.PREMIUM_PERCENT) / 100));
  assert.equal(q.premium, q.cost - q.marketValue);
  const [a, d] = [getPlayer(game, 1).cash, getPlayer(game, 2).cash];

  const r = takeoverBlock(game, 'r2c2');
  assert.equal(r.ok, true);
  assert.equal(house.ownerSeat, 1);
  assert.deepEqual([house.type, house.level, house.investedCostBasis], ['residential', 1, 1000], 'development preserved');
  assert.equal(getPlayer(game, 1).cash, a - q.cost);
  assert.equal(getPlayer(game, 2).cash, d + q.marketValue, 'the premium goes to nobody');
  assert.deepEqual(game.ledger.slice(-2).map((e) => [e.seat, e.reason, e.delta]),
    [[1, TXN.TAKEOVER, -q.cost], [2, TXN.TAKEOVER, q.marketValue]]);
  assert.equal(game.city.actionsLeft, game.city.actionsPerTurn - 1, 'one City Action');
  assert.equal(game.city.takeovers, 1);
  assert.equal(house.shieldedUntil, game.round + T.SHIELD_ROUNDS);
  assert.deepEqual(ownershipProblems(game), []);
  const log = game.log.at(-1);
  assert.deepEqual(
    [log.type, log.seat, log.from, log.block, log.label, log.cost, log.marketValue, log.premium, log.pressure, log.control, log.round],
    ['takeover', 1, 2, 'r2c2', 'C3', q.cost, q.marketValue, q.premium, 8, 3, game.round], 'logged in full');
});

test('at most one takeover per turn; the counter resets next turn', () => {
  const game = place(duel(), [[3, 3, 2]]); // a bare lot next to the Market too
  assert.equal(quoteTakeover(game, 'r3c3').ok, true);
  assert.equal(takeoverBlock(game, 'r2c2').ok, true);
  assert.equal(quoteTakeover(game, 'r3c3').error, TAKEOVER_ERRORS.ONE_PER_TURN);
  assert.ok(endCityTurn(game).ok);
  assert.equal(game.city.takeovers, 0);
});

test('a block just taken over is protected until the next full round is done', () => {
  const game = duel();
  const round = game.round;
  assert.equal(takeoverBlock(game, 'r2c2').ok, true);
  // Seat 2 builds shops around it to strike back.
  place(game, [[3, 2, 2, 'commercial', 3], [2, 1, 2, 'commercial', 3]]);
  assert.ok(endCityTurn(game).ok);
  assert.equal(currentPlayer(game).seat, 2);
  const blocked = quoteTakeover(game, 'r2c2');
  assert.equal(blocked.error, TAKEOVER_ERRORS.SHIELDED);
  assert.equal(blocked.reason, TAKEOVER_REASONS[TAKEOVER_ERRORS.SHIELDED]);
  assert.ok(blocked.pressure > blocked.control, 'it would otherwise fall');
  assert.ok(endCityTurn(game).ok);
  assert.ok(endCityTurn(game).ok); // round + 1, seat 2: still protected
  assert.equal(game.round, round + 1);
  assert.equal(isShielded(game, at(game, 2, 2)), true);
  assert.equal(quoteTakeover(game, 'r2c2').error, TAKEOVER_ERRORS.SHIELDED);
  assert.ok(endCityTurn(game).ok);
  assert.ok(endCityTurn(game).ok); // round + 2: fair game again
  assert.equal(isShielded(game, at(game, 2, 2)), false);
  assert.equal(quoteTakeover(game, 'r2c2').ok, true);
});

/* ---------------- refusals ---------------- */

test('takeovers are refused with a reason, and a refusal changes nothing', () => {
  const cases = [
    ['EXPANSION era', () => duel({ city: false }), TAKEOVER_ERRORS.NOT_CITY_ERA],
    ['in debt', (g) => { getPlayer(g, 1).cash = -1; }, TAKEOVER_ERRORS.IN_DISTRESS],
    ['out of City Actions', (g) => { g.city.actionsLeft = 0; }, TAKEOVER_ERRORS.NO_ACTIONS],
    ['not in Manage City', (g) => { g.turnPhase = TURN_PHASES.CAPTURE_DEVELOP; g.pendingCaptures = ['r0c0']; }, TAKEOVER_ERRORS.WRONG_PHASE],
    ['control holds', (g) => place(g, [[3, 2, 2, 'landmark', 3]]), TAKEOVER_ERRORS.CONTROL_HOLDS], // control 10 vs 8
    ['unaffordable', (g) => { getPlayer(g, 1).cash = 100; }, TAKEOVER_ERRORS.INSUFFICIENT_FUNDS],
  ];
  for (const [label, setup, error] of cases) {
    let game = duel();
    const made = setup(game);
    if (made?.board) game = made;
    const before = snap(game);
    const r = takeoverBlock(game, 'r2c2');
    assert.equal(r.ok, false, label);
    assert.equal(r.error, error, label);
    assert.equal(r.reason, TAKEOVER_REASONS[error], label);
    assert.ok(r.pressure > 0 && r.control > 0 && r.cost > 0, `${label}: figures still shown`);
    assert.equal(snap(game), before, `${label}: nothing changed`);
  }
  const game = duel();
  getPlayer(game, 1).cash = 100;
  assert.equal(quoteTakeover(game, 'r2c2').shortfall, quoteTakeover(game, 'r2c2').cost - 100);
  for (const id of ['r2c3', 'r0c0', 'nope']) {
    assert.ok([TAKEOVER_ERRORS.NOT_RIVAL, TAKEOVER_ERRORS.NO_BLOCK].includes(quoteTakeover(game, id).error), id);
  }
  Object.assign(at(game, 2, 2), { ownerSeat: null, abandoned: true, abandonedBy: 2 });
  assert.equal(quoteTakeover(game, 'r2c2').error, TAKEOVER_ERRORS.NOT_RIVAL, 'abandoned lots go to auction instead');
});

test('the inspector and candidate list show pressure vs control and the takeover quote', () => {
  const game = duel();
  const d = blockDetails(game, 'r2c2');
  assert.deepEqual([d.control, d.takeover.pressure, d.takeover.ok, d.takeover.cost], [3, 8, true, quoteTakeover(game, 'r2c2').cost]);
  assert.equal(blockDetails(game, 'r2c3').takeover, null, 'your own block');
  assert.deepEqual(takeoverCandidates(game).map((q) => q.blockId), ['r2c2']);
});

/* ---------------- saving ---------------- */

test('takeover state survives autosave; corrupt takeover state is rejected', () => {
  const game = place(duel(), [[3, 3, 2]]);
  takeoverBlock(game, 'r2c2');
  const storage = memoryStorage();
  assert.equal(saveActiveGame(game, { seats: [{ seat: 1 }, { seat: 2 }] }, storage), true);
  const back = loadActiveGame(storage).game;
  assert.equal(back.city.takeovers, 1);
  assert.equal(getBlockById(back.board, 'r2c2').shieldedUntil, game.round + T.SHIELD_ROUNDS);
  assert.equal(quoteTakeover(back, 'r3c3').error, TAKEOVER_ERRORS.ONE_PER_TURN, 'still one per turn after a reload');
  const raw = JSON.parse(storage.getItem(SAVE_KEY));
  for (const corrupt of [(g) => { g.city.takeovers = -1; }, (g) => { g.board.blocks[14].shieldedUntil = 'soon'; }]) {
    const bad = structuredClone(raw);
    corrupt(bad.game);
    storage.setItem(SAVE_KEY, JSON.stringify(bad));
    assert.equal(loadActiveGame(storage), null, corrupt.toString());
  }
});

/* ---------------- CPU ---------------- */

/** A CPU at seat 1 whose two Office Towers press on seat 2's Monument (control 4, pressure 14). */
function cpuDuel(difficulty, cityRounds) {
  const game = table({ seats: [{ seat: 1, controller: 'cpu', difficulty }, { seat: 2 }], cityRounds });
  return place(game, [[2, 2, 2, 'landmark', 1], [2, 3, 1, 'commercial', 3], [1, 2, 1, 'commercial', 3]]);
}

test('CPU takeovers are conservative: only with a clear return over the rounds left', () => {
  for (const difficulty of ['normal', 'hard']) {
    // Plenty of City rounds left: the Monument pays for its 125% price.
    const long = cpuDuel(difficulty, 8);
    assert.equal(quoteTakeover(long, 'r2c2').ok, true);
    const d = chooseCityAction(long, { seed: 1 });
    assert.deepEqual([d.action, d.blockId, d.reason], ['takeover', 'r2c2', 'takeover'], difficulty);
    assert.equal(applyCityAction(long, d).ok, true);
    assert.equal(at(long, 2, 2).ownerSeat, 1);
    assert.notEqual(chooseCityAction(long, { seed: 1 }).action, 'takeover', `${difficulty}: one per turn`);
    // Four rounds left: the premium would barely pay back, so it passes.
    const short = cpuDuel(difficulty, 4);
    assert.equal(quoteTakeover(short, 'r2c2').ok, true);
    assert.notEqual(chooseCityAction(short, { seed: 1 }).action, 'takeover', `${difficulty}: not worth the premium`);
  }
  // Easy never tries; nor does anyone before the CITY era.
  const easy = cpuDuel('easy', 8);
  for (let seed = 0; seed < 10; seed++) assert.notEqual(chooseCityAction(easy, { seed }).action, 'takeover');
  const early = place(table({ city: false, seats: [{ seat: 1, controller: 'cpu', difficulty: 'hard' }, { seat: 2 }] }),
    [[2, 2, 2, 'landmark', 1], [2, 3, 1, 'commercial', 3], [1, 2, 1, 'commercial', 3]]);
  assert.equal(early.era, ERAS.EXPANSION);
  assert.notEqual(chooseCityAction(early, { seed: 1 }).action, 'takeover');
});
