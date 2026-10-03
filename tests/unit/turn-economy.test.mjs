/**
 * Turn economy: a normal EXPANSION turn is one Development Action in Manage City plus the
 * required road; the CITY era keeps 2 City Actions. Develop Now on a just-captured block is a
 * free capture reward, bonus-road chains are unchanged, and the final mover gains no extra
 * management at the transition.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EXPANSION_ERA, CITY_ERA } from '../../js/config.js';
import { getBlock, getBlockById, allRoadIds } from '../../js/core/board.js';
import { applyDevelopment, buildOnBlock, upgradeBlock, quoteBuild, DEV_ERRORS } from '../../js/core/development.js';
import { refreshBonuses } from '../../js/core/bonuses.js';
import { TXN, charge } from '../../js/core/economy.js';
import {
  createGame, currentPlayer, getPlayer, placeRoad, startPaving, resolveCapture, endCityTurn, eraStatus, actionName,
  actionsPerTurnFor, outOfCityActions, usesCityAction, ERAS, PHASES, TURN_PHASES,
} from '../../js/core/game.js';
import {
  sellDevelopment, downgradeBlock, acquireAbandoned, resolveRedevelopmentAuction, quoteRedevelopment, FIN_ERRORS, ACQUIRE_MODES,
} from '../../js/core/finance.js';
import { forecastDevelopment } from '../../js/core/forecast.js';
import { chooseCityAction, applyCityAction } from '../../js/core/cpu/city.js';
import { chooseRoad } from '../../js/core/cpu/roads.js';
import { SAVE_KEY, SAVE_VERSION, saveActiveGame, loadActiveGame } from '../../js/core/persistence.js';
import { TUTORIAL_STEPS } from '../../js/core/tutorial.js';

const seats = (n = 4) => Array.from({ length: n }, (_, i) => ({ seat: i + 1 }));
const memoryStorage = () => {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
};
const snap = (g) => JSON.stringify({ board: g.board, players: g.players, city: g.city, ledger: g.ledger });

function place(game, list) {
  for (const [row, col, seat, type = 'vacant', level = 0] of list) {
    const b = getBlock(game.board, row, col);
    b.ownerSeat = seat;
    applyDevelopment(b, type, level);
  }
  refreshBonuses(game.board);
  return game;
}

/** Four calm mayors with cash to spend; seat 1 is in Manage City. */
function table(options = {}) {
  const game = createGame({ seats: seats(), seed: 9, eventPool: [], ...options });
  for (const p of game.players) p.cash = 40000;
  return game;
}

/* ---------------- one Development Action per EXPANSION turn ---------------- */

test('every EXPANSION Manage City starts with EXPANSION_ERA.ACTIONS_PER_TURN Development Actions', () => {
  assert.equal(EXPANSION_ERA.ACTIONS_PER_TURN, 1);
  const game = table();
  assert.deepEqual([game.city.actionsLeft, actionsPerTurnFor(game), actionName(game), actionName(game, 2)],
    [1, 1, 'Development Action', 'Development Actions']);
  const s = eraStatus(game);
  assert.deepEqual([s.actionsLeft, s.turnActions, s.actionName], [1, 1, 'Development Action']);
  assert.equal(usesCityAction(game), true);
  placeRoad(game, 'h-6-5'); // a quiet road: seat 2's turn
  assert.deepEqual([currentPlayer(game).seat, game.city.actionsLeft], [2, 1]);
  assert.equal(createGame({ seats: seats(), expansionActions: 3 }).city.actionsLeft, 3, 'configurable per game');
});

test('a build, upgrade, sale, downgrade, purchase or auction each spends the Development Action; then all are refused', () => {
  const setup = () => {
    const game = place(table(), [[0, 0, 1, 'residential', 2], [0, 1, 1], [0, 2, 1], [3, 3, 2, 'commercial', 1]]);
    Object.assign(getBlock(game.board, 3, 3), { ownerSeat: null, abandoned: true, abandonedBy: 2 });
    refreshBonuses(game.board);
    return game;
  };
  const reserve = quoteRedevelopment(setup(), 'r3c3', ACQUIRE_MODES.RESTORE).reserve;
  const actions = {
    build: (g) => buildOnBlock(g, 'r0c1', 'park'),
    upgrade: (g) => upgradeBlock(g, 'r0c0'),
    downgrade: (g) => downgradeBlock(g, 'r0c0'),
    sell: (g) => sellDevelopment(g, 'r0c0'),
    acquire: (g) => acquireAbandoned(g, 'r3c3', ACQUIRE_MODES.RESTORE),
    auction: (g) => resolveRedevelopmentAuction(g, 'r3c3', ACQUIRE_MODES.RESTORE, [{ seat: 3, bid: reserve }]),
  };
  for (const [first, run] of Object.entries(actions)) {
    const game = setup();
    assert.equal(run(game).ok, true, first);
    assert.equal(game.city.actionsLeft, 0, `${first} spent it`);
    assert.equal(outOfCityActions(game), true);
    const before = snap(game);
    for (const [second, again] of Object.entries(actions)) assert.equal(again(game).ok, false, `${first} then ${second}`);
    // Anything still structurally possible is refused for want of an action.
    assert.equal(buildOnBlock(game, 'r0c2', 'park').error, DEV_ERRORS.NO_ACTIONS);
    if (getBlock(game.board, 0, 0).level > 0) assert.equal(sellDevelopment(game, 'r0c0').error, FIN_ERRORS.NO_ACTIONS);
    if (getBlock(game.board, 3, 3).abandoned) {
      assert.equal(acquireAbandoned(game, 'r3c3', ACQUIRE_MODES.RESTORE).error, FIN_ERRORS.NO_ACTIONS);
    }
    assert.equal(snap(game), before, 'refusals change nothing');
    // The road is still required, and always allowed.
    assert.equal(startPaving(game), true);
    assert.equal(placeRoad(game, 'h-6-5').ok, true);
    assert.equal(game.city.actionsLeft, 1, 'the next mayor starts fresh');
  }
});

test('paving ends Manage City: an unspent Development Action is lost, never carried into the road phases', () => {
  const game = place(table(), [[0, 0, 1]]);
  assert.equal(startPaving(game), true);
  assert.equal(game.city.actionsLeft, 0);
  assert.equal(buildOnBlock(game, 'r0c0', 'park').error, DEV_ERRORS.WRONG_PHASE);
  assert.equal(eraStatus(game).actionsLeft, 0);
});

test('selling to clear debt stays free in EXPANSION; the action is still there afterwards', () => {
  const game = place(table(), [[0, 0, 1, 'residential', 3], [0, 1, 1]]);
  charge(game, getPlayer(game, 1), getPlayer(game, 1).cash + 100, TXN.UPKEEP);
  assert.equal(downgradeBlock(game, 'r0c0').ok, true);
  assert.equal(game.city.actionsLeft, 1, 'debt recovery is free');
  assert.equal(buildOnBlock(game, 'r0c1', 'park').ok, true, 'and the turn\'s action can still be used');
  assert.equal(game.city.actionsLeft, 0);
});

/* ---------------- capture rewards and bonus roads ---------------- */

test('Develop Now is a free capture reward (double captures too), and bonus-road chains are unchanged', () => {
  const game = table();
  getPlayer(game, 1).cash = 40000;
  assert.equal(buildOnBlock(game, 'r0c0', 'park').ok, false, 'not owned yet');
  // Seat 1 spends its Development Action first, on a block it already owns.
  place(game, [[5, 5, 1]]);
  assert.equal(buildOnBlock(game, 'r5c5', 'park').ok, true);
  assert.equal(game.city.actionsLeft, 0);
  // Box in A1 and B1 so one road closes both (a double capture).
  for (const id of ['h-0-0', 'h-0-1', 'h-1-0', 'h-1-1', 'v-0-0', 'v-0-2']) game.board.roads[id] = 2;
  const r = placeRoad(game, 'v-0-1');
  assert.deepEqual([r.ok, r.captured, r.extraTurn, game.turnPhase], [true, ['r0c0', 'r0c1'], true, TURN_PHASES.CAPTURE_DEVELOP]);
  assert.equal(usesCityAction(game), false);
  assert.equal(quoteBuild(game, 'r0c0', 'residential').ok, true, 'no action needed');
  assert.equal(buildOnBlock(game, 'r0c0', 'residential').ok, true);
  resolveCapture(game, 'r0c0');
  assert.equal(buildOnBlock(game, 'r0c1', 'commercial').ok, true, 'the second capture too');
  resolveCapture(game, 'r0c1');
  assert.equal(game.city.actionsLeft, 0, 'free: no action spent or granted');
  // Bonus road as before: another capture keeps the chain going, a quiet road ends the turn.
  assert.equal(game.turnPhase, TURN_PHASES.BONUS_ROAD);
  for (const id of ['h-0-2', 'h-1-2']) game.board.roads[id] = 2; // C1 now has three sides
  const next = placeRoad(game, 'v-0-3');
  assert.deepEqual([next.captured, next.extraTurn, game.turnPhase], [['r0c2'], true, TURN_PHASES.CAPTURE_DEVELOP]);
  resolveCapture(game);
  assert.equal(game.turnPhase, TURN_PHASES.BONUS_ROAD);
  assert.equal(placeRoad(game, 'h-6-5').ok, true);
  assert.equal(currentPlayer(game).seat, 2);
});

/* ---------------- CITY era and the transition ---------------- */

/** Every road but the last paved; F6 (r5c5) is captured by the last road, v-5-6. */
function almostComplete() {
  const game = table();
  const ids = allRoadIds(game.board);
  ids.slice(0, -1).forEach((id) => { game.board.roads[id] = 1; });
  game.board.blocks.slice(0, -1).forEach((b, i) => { b.ownerSeat = (i % 4) + 1; });
  refreshBonuses(game.board);
  return { game, last: ids.at(-1) };
}

test('CITY keeps 2 City Actions per turn', () => {
  assert.equal(CITY_ERA.ACTIONS_PER_TURN, 2);
  const { game, last } = almostComplete();
  placeRoad(game, last);
  resolveCapture(game);
  endCityTurn(game); // → seat 2's first City turn
  assert.deepEqual([game.era, game.city.actionsLeft, actionName(game)], [ERAS.CITY, 2, 'City Action']);
  for (const id of ['r0c1', 'r0c5']) assert.equal(buildOnBlock(game, id, 'park').ok, true); // seat 2's blocks
  assert.equal(buildOnBlock(game, 'r1c3', 'park').error, DEV_ERRORS.NO_ACTIONS);
});

test('the final mover gets no extra management: Develop Now on the final capture, then End Turn', () => {
  for (const usedFirst of [false, true]) {
    const { game, last } = almostComplete();
    if (usedFirst) assert.equal(buildOnBlock(game, 'r0c0', 'park').ok, true);
    const r = placeRoad(game, last);
    assert.deepEqual([r.cityEra, game.turnPhase, game.city.actionsLeft], [true, TURN_PHASES.CAPTURE_DEVELOP, 0]);
    assert.equal(buildOnBlock(game, 'r5c5', 'commercial').ok, true, 'the capture reward stays free');
    resolveCapture(game, 'r5c5');
    assert.deepEqual([game.turnPhase, game.city.actionsLeft], [TURN_PHASES.MANAGE_CITY, 0]);
    const before = snap(game);
    assert.equal(upgradeBlock(game, 'r5c5').error, DEV_ERRORS.NO_ACTIONS);
    assert.equal(buildOnBlock(game, 'r4c0', 'park').error, DEV_ERRORS.NO_ACTIONS);
    assert.equal(snap(game), before);
    // Its whole turn was worth at most one Development Action plus the free capture.
    const managed = game.ledger.filter((e) => e.seat === 1 && [TXN.BUILD, TXN.UPGRADE].includes(e.reason) && e.block !== 'r5c5');
    assert.equal(managed.length, usedFirst ? 1 : 0);
    // Seats after it this round, and everyone next round, get full City turns.
    for (let i = 0; i < 4; i++) {
      assert.ok(endCityTurn(game).ok);
      assert.equal(game.city.actionsLeft, 2);
    }
    assert.equal(currentPlayer(game).seat, 1);
  }
});

/* ---------------- forecasts ---------------- */

test('forecasts say whether a build spends an action, and still forecast when none are left', () => {
  const game = place(table(), [[0, 0, 1], [0, 1, 1]]);
  const f = forecastDevelopment(game, 'r0c0', 'park');
  assert.deepEqual([f.ok, f.usesAction, f.actionAvailable, f.affordable], [true, true, true, true]);
  buildOnBlock(game, 'r0c1', 'park');
  const before = snap(game);
  const spent = forecastDevelopment(game, 'r0c0', 'park');
  assert.deepEqual([spent.ok, spent.actionAvailable, spent.delta.income > 0], [true, false, true], 'shown for next turn');
  assert.equal(snap(game), before, 'forecasting changes nothing');
  assert.equal(game.city.actionsLeft, 0);

  for (const id of ['h-5-5', 'h-6-5', 'v-5-5']) game.board.roads[id] = 2;
  placeRoad(game, 'v-5-6'); // seat 1 captures F6
  const free = forecastDevelopment(game, 'r5c5', 'residential');
  assert.deepEqual([free.ok, free.usesAction, free.actionAvailable], [true, false, true], 'Develop Now is free');
});

/* ---------------- CPU ---------------- */

test('CPU mayors manage at most one action per EXPANSION turn and two per City turn, with no illegal moves or stalls', () => {
  for (const [seed, difficulties] of [[3, ['easy', 'normal', 'hard', 'hard']], [8, ['hard', 'normal', 'hard']], [21, ['normal', 'easy']]]) {
    const game = createGame({ seed, seats: difficulties.map((difficulty, i) => ({ seat: i + 1, controller: 'cpu', difficulty })) });
    const managed = new Map(); // `${round}:${seat}` → management actions taken in Manage City
    let steps = 0;
    while (game.phase === PHASES.PLAYING) {
      assert.ok(++steps < 6000, `seed ${seed}: runaway`);
      const me = currentPlayer(game);
      const key = `${game.round}:${me.seat}:${game.era}`;
      const managing = game.turnPhase === TURN_PHASES.MANAGE_CITY && me.cash >= 0;
      let result;
      let decision;
      if (game.turnPhase === TURN_PHASES.PAVE_ROAD || game.turnPhase === TURN_PHASES.BONUS_ROAD) {
        decision = chooseRoad(game);
        result = placeRoad(game, decision.road);
      } else {
        decision = chooseCityAction(game);
        result = applyCityAction(game, decision);
        if (managing && !['pave', 'end-turn'].includes(decision.action)) managed.set(key, (managed.get(key) ?? 0) + 1);
      }
      assert.equal(result.ok, true, `seed ${seed}: illegal ${decision.action ?? 'road'} (${result.error})`);
    }
    for (const [key, n] of managed) {
      const limit = key.endsWith(ERAS.CITY) ? CITY_ERA.ACTIONS_PER_TURN : EXPANSION_ERA.ACTIONS_PER_TURN;
      assert.ok(n <= limit, `seed ${seed} ${key}: ${n} management actions`);
    }
    assert.ok([...managed.keys()].some((k) => k.endsWith(ERAS.EXPANSION)), 'bots do develop in EXPANSION');
  }
});

/* ---------------- saves ---------------- */

test('the Development Action survives a reload (no refill), and impossible budgets are refused', () => {
  const game = place(table(), [[0, 0, 1], [0, 1, 1]]);
  buildOnBlock(game, 'r0c0', 'park');
  const storage = memoryStorage();
  assert.equal(saveActiveGame(game, null, storage), true);
  const back = loadActiveGame(storage).game;
  assert.equal(back.city.actionsLeft, 0);
  assert.equal(buildOnBlock(back, 'r0c1', 'park').error, DEV_ERRORS.NO_ACTIONS);

  const raw = JSON.parse(storage.getItem(SAVE_KEY));
  for (const corrupt of [
    (g) => { g.city.actionsLeft = 2; }, // more than an EXPANSION turn grants
    (g) => { g.city.actionsLeft = -1; },
    (g) => { g.turnPhase = TURN_PHASES.PAVE_ROAD; g.city.actionsLeft = 1; }, // left over after paving
    (g) => { g.city.expansionActions = 0; },
    (g) => { delete g.city.expansionActions; },
  ]) {
    const bad = structuredClone(raw);
    corrupt(bad.game);
    storage.setItem(SAVE_KEY, JSON.stringify(bad));
    assert.equal(loadActiveGame(storage), null, corrupt.toString());
  }
});

test('schema 2 saves migrate: EXPANSION Manage City gets this turn\'s Development Action, later phases none, CITY unchanged', () => {
  assert.equal(SAVE_VERSION, 3);
  const asV2 = (game) => {
    const storage = memoryStorage();
    assert.equal(saveActiveGame(game, null, storage), true);
    const raw = JSON.parse(storage.getItem(SAVE_KEY));
    raw.version = 2;
    delete raw.game.city.expansionActions;
    raw.game.city.actionsLeft = game.era === ERAS.CITY ? game.city.actionsLeft : 0; // schema 2 never counted EXPANSION
    storage.setItem(SAVE_KEY, JSON.stringify(raw));
    return loadActiveGame(storage);
  };
  const managing = asV2(table());
  assert.equal(managing.version, SAVE_VERSION);
  assert.deepEqual([managing.game.city.expansionActions, managing.game.city.actionsLeft], [1, 1]);

  const paving = table();
  startPaving(paving);
  assert.equal(asV2(paving).game.city.actionsLeft, 0);

  const { game: city, last } = almostComplete();
  placeRoad(city, last);
  resolveCapture(city);
  endCityTurn(city);
  buildOnBlock(city, 'r0c1', 'park');
  const back = asV2(city).game;
  assert.deepEqual([back.era, back.city.actionsLeft, back.city.expansionActions], [ERAS.CITY, 1, 1]);
});

/* ---------------- tutorial ---------------- */

test('the tutorial explains the one-per-turn Development Action and the free Develop Now', () => {
  const tip = (id) => TUTORIAL_STEPS.find((s) => s.id === id).text;
  assert.match(tip('manage'), /one Development Action/);
  assert.match(tip('develop'), /free/);
});
