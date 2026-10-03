/**
 * Gameplay eras: EXPANSION (roads and captures) → CITY (no roads, City Actions) → the end.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CITY_ERA, ECONOMY } from '../../js/config.js';
import { allRoadIds, getBlockById } from '../../js/core/board.js';
import { applyDevelopment, buildOnBlock, upgradeBlock, DEV_ERRORS } from '../../js/core/development.js';
import { refreshBonuses } from '../../js/core/bonuses.js';
import { TXN } from '../../js/core/economy.js';
import {
  createGame, placeRoad, currentPlayer, getPlayer, startPaving, resolveCapture, endCityTurn, enterCityEra,
  validateRoad, eraStatus, cityTurnsLeft, ERAS, PHASES, TURN_PHASES, MOVE_ERRORS,
} from '../../js/core/game.js';
import {
  sellDevelopment, downgradeBlock, declareBankruptcy, acquireAbandoned, resolveRedevelopmentAuction, FIN_ERRORS,
} from '../../js/core/finance.js';
import { saveActiveGame, loadActiveGame, SAVE_KEY } from '../../js/core/persistence.js';
import { isGenuineMatch } from '../../js/core/career.js';
import { playthrough, loadApi } from './_playthrough.mjs';
import { playOutCity } from './_city.mjs';

const api = await loadApi();
const seats = (n = 4) => Array.from({ length: n }, (_, i) => ({ seat: i + 1 }));
const memoryStorage = () => {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
};

/**
 * Every road but the last paved; every block owned (round-robin) except F6, which the last road
 * (v-5-6) captures. Seat 1 is to move. Options go to createGame.
 */
function almostComplete(options = {}) {
  const game = createGame({ seats: seats(options.n ?? 4), seed: 1, eventPool: [], ...options });
  const ids = allRoadIds(game.board);
  ids.slice(0, -1).forEach((id) => { game.board.roads[id] = 1; });
  game.board.blocks.slice(0, -1).forEach((b, i) => { b.ownerSeat = (i % game.players.length) + 1; });
  refreshBonuses(game.board);
  return { game, last: ids.at(-1) };
}

/** A game in the CITY era at seat 1's Manage City, with a developed block and cash to spend. */
function cityGame(options = {}) {
  const { game, last } = almostComplete(options);
  const r = placeRoad(game, last);
  assert.equal(r.cityEra, true);
  resolveCapture(game, 'r5c5');
  const me = currentPlayer(game);
  me.cash = 30000;
  const dev = getBlockById(game.board, 'r0c0'); // seat 1's
  applyDevelopment(dev, 'residential', 1);
  refreshBonuses(game.board);
  return game;
}

const snap = (game) => JSON.stringify({ board: game.board, players: game.players, city: game.city, ledger: game.ledger });

/* ---------------- configuration ---------------- */

test('CITY_ERA is configured in config.js: 4 full rounds, 2 City Actions per turn', () => {
  assert.equal(CITY_ERA.ROUNDS, 4);
  assert.equal(CITY_ERA.ACTIONS_PER_TURN, 2);
  const game = createGame({ seats: seats() });
  assert.equal(game.era, ERAS.EXPANSION);
  assert.deepEqual(game.city, { rounds: 4, actionsPerTurn: 2, startRound: null, endRound: null, actionsLeft: 0, takeovers: 0 });
  assert.deepEqual(eraStatus(game), { era: 'expansion', rounds: 4, round: 0, roundsLeft: 4, actionsLeft: null, actionsPerTurn: 2 });
  assert.equal(cityTurnsLeft(game), null);
  assert.throws(() => createGame({ seats: seats(), cityRounds: -1 }), RangeError);
  assert.throws(() => createGame({ seats: seats(), cityActions: 0 }), RangeError);
  assert.throws(() => createGame({ seats: seats(), cityRounds: 1.5 }), RangeError);
});

test('EXPANSION turns are unchanged: unlimited management, then pave; no City turn to end', () => {
  const game = createGame({ seats: seats(), seed: 4, eventPool: [] });
  for (const id of ['h-0-0', 'v-0-0', 'h-1-0']) placeRoad(game, id);
  placeRoad(game, 'v-0-1'); // seat 4 claims A1
  resolveCapture(game);
  placeRoad(game, 'h-0-5'); // bonus road; the turn passes to seat 1
  const b = getBlockById(game.board, 'r0c0');
  b.ownerSeat = 1;
  for (const id of ['r0c1', 'r0c2', 'r1c1']) getBlockById(game.board, id).ownerSeat = 1;
  refreshBonuses(game.board);
  assert.equal(currentPlayer(game).seat, 1);
  // Four developments in one Manage City: no action limit before the grid is complete.
  for (const id of ['r0c0', 'r0c1', 'r0c2', 'r1c1']) assert.equal(buildOnBlock(game, id, 'park').ok, true);
  assert.equal(game.city.actionsLeft, 0, 'untouched in EXPANSION');
  assert.deepEqual(endCityTurn(game), { ok: false, error: MOVE_ERRORS.NOT_CITY_ERA });
  assert.equal(startPaving(game), true);
});

/* ---------------- the transition ---------------- */

test('paving the final road starts the CITY era instead of ending the match', () => {
  const { game, last } = almostComplete();
  const round = game.round;
  const r = placeRoad(game, last);
  assert.equal(r.ok, true);
  assert.equal(r.gameEnded, false);
  assert.equal(r.cityEra, true);
  assert.equal(r.extraTurn, false, 'no bonus road: there are none left');
  assert.equal(game.phase, PHASES.PLAYING);
  assert.equal(game.results, null);
  assert.equal(game.era, ERAS.CITY);
  assert.deepEqual(game.city, { rounds: 4, actionsPerTurn: 2, startRound: round + 1, endRound: round + 4, actionsLeft: 2, takeovers: 0 });
  assert.ok(game.log.some((e) => e.type === 'era' && e.era === 'city'));
  // The final capture keeps its Develop Now choice (free), then the mover's City turn.
  assert.equal(currentPlayer(game).seat, 1);
  assert.equal(game.turnPhase, TURN_PHASES.CAPTURE_DEVELOP);
  getPlayer(game, 1).cash = 20000;
  assert.equal(buildOnBlock(game, 'r5c5', 'commercial').ok, true);
  assert.equal(game.city.actionsLeft, 2, 'developing the final capture is free');
  resolveCapture(game, 'r5c5');
  assert.equal(game.turnPhase, TURN_PHASES.MANAGE_CITY);
  assert.deepEqual(eraStatus(game), { era: 'city', rounds: 4, round: 0, roundsLeft: 4, actionsLeft: 2, actionsPerTurn: 2 });
});

test('no roads can be placed during the CITY era', () => {
  const game = cityGame();
  const before = snap(game);
  for (const id of ['h-0-0', 'v-5-6', 'x-1-1', '']) {
    assert.deepEqual(placeRoad(game, id), { ok: false, error: MOVE_ERRORS.ROADS_CLOSED });
  }
  assert.equal(validateRoad(game, 'h-0-0'), MOVE_ERRORS.ROADS_CLOSED);
  assert.equal(startPaving(game), false);
  assert.equal(game.turnPhase, TURN_PHASES.MANAGE_CITY);
  assert.equal(snap(game), before);
});

test('with 0 City rounds the final road still ends the match at once', () => {
  const { game, last } = almostComplete({ cityRounds: 0 });
  const r = placeRoad(game, last);
  assert.equal(r.gameEnded, true);
  assert.equal(r.cityEra, false);
  assert.equal(game.era, ERAS.EXPANSION);
  assert.equal(game.phase, PHASES.ENDED);
  assert.ok(game.results);
  assert.equal(enterCityEra(game), false);
});

/* ---------------- City Actions ---------------- */

test('each City turn has 2 City Actions: builds and upgrades spend them, then are refused', () => {
  const game = cityGame();
  const vacant = getBlockById(game.board, 'r0c4'); // seat 1's, vacant
  assert.equal(vacant.ownerSeat, 1);
  assert.equal(upgradeBlock(game, 'r0c0').ok, true);
  assert.equal(game.city.actionsLeft, 1);
  assert.equal(buildOnBlock(game, 'r0c4', 'park').ok, true);
  assert.equal(game.city.actionsLeft, 0);
  const before = snap(game);
  assert.equal(upgradeBlock(game, 'r0c0').error, DEV_ERRORS.NO_ACTIONS);
  assert.equal(upgradeBlock(game, 'r0c4').error, DEV_ERRORS.NO_ACTIONS);
  assert.equal(sellDevelopment(game, 'r0c0').error, FIN_ERRORS.NO_ACTIONS);
  assert.equal(snap(game), before, 'refused actions change nothing');
  // Ending the turn hands the next mayor a full set.
  const r = endCityTurn(game);
  assert.equal(r.ok, true);
  assert.equal(currentPlayer(game).seat, 2);
  assert.equal(game.city.actionsLeft, 2);
});

test('voluntary sales cost a City Action; selling out of debt and bankruptcy never do', () => {
  const game = cityGame();
  assert.equal(downgradeBlock(game, 'r0c0').ok, true);
  assert.equal(game.city.actionsLeft, 1, 'a voluntary sale is an action');
  applyDevelopment(getBlockById(game.board, 'r0c0'), 'industrial', 3);
  refreshBonuses(game.board);
  game.city.actionsLeft = 0;
  const me = currentPlayer(game);
  me.cash = -100;
  assert.equal(downgradeBlock(game, 'r0c0').ok, true, 'recovering from distress needs no action');
  assert.equal(game.city.actionsLeft, 0);
  assert.ok(me.cash >= 0);
  // Bankruptcy is also free, and the turn can then end.
  me.cash = -1_000_000;
  assert.equal(endCityTurn(game).error, MOVE_ERRORS.IN_DISTRESS);
  assert.equal(declareBankruptcy(game).ok, true);
  assert.equal(endCityTurn(game).ok, true);
});

test('redevelopment costs a City Action: buying a ruin or opening an auction', () => {
  const game = cityGame();
  const ruin = getBlockById(game.board, 'r2c2');
  const ruin2 = getBlockById(game.board, 'r3c3');
  for (const b of [ruin, ruin2]) Object.assign(b, { ownerSeat: null, abandoned: true, abandonedBy: 2 });
  refreshBonuses(game.board);
  assert.equal(acquireAbandoned(game, 'r2c2', 'rebuild').ok, true);
  assert.equal(game.city.actionsLeft, 1);
  const auction = resolveRedevelopmentAuction(game, 'r3c3', 'rebuild', [{ seat: 3, bid: 2100 }, { seat: 1, bid: 2000 }]);
  assert.equal(auction.ok, true);
  assert.equal(auction.winnerSeat, 3, 'another mayor may win it…');
  assert.equal(game.city.actionsLeft, 0, '…but opening it was the current mayor\'s action');
  Object.assign(ruin2, { ownerSeat: null, abandoned: true, abandonedBy: 2 });
  assert.equal(acquireAbandoned(game, 'r3c3', 'rebuild').error, FIN_ERRORS.NO_ACTIONS);
  assert.equal(resolveRedevelopmentAuction(game, 'r3c3', 'rebuild', [{ seat: 3, bid: 2100 }]).error, FIN_ERRORS.NO_ACTIONS);
});

test('endCityTurn is refused mid-capture, in debt, in EXPANSION and after the end', () => {
  const { game, last } = almostComplete();
  assert.equal(endCityTurn(game).error, MOVE_ERRORS.NOT_CITY_ERA);
  placeRoad(game, last);
  assert.equal(endCityTurn(game).error, MOVE_ERRORS.WRONG_PHASE, 'resolve the final capture first');
  resolveCapture(game);
  currentPlayer(game).cash = -5;
  assert.equal(endCityTurn(game).error, MOVE_ERRORS.IN_DISTRESS);
  currentPlayer(game).cash = 5;
  playOutCity(game);
  assert.equal(endCityTurn(game).error, MOVE_ERRORS.GAME_OVER);
});

/* ---------------- economy during the CITY era ---------------- */

test('income, upkeep and city events carry on through the CITY era', () => {
  const { game, last } = almostComplete({ mode: 'chaos', eventPool: undefined });
  applyDevelopment(getBlockById(game.board, 'r0c0'), 'commercial', 2);
  refreshBonuses(game.board);
  placeRoad(game, last);
  const ledgerStart = game.ledger.length;
  const eventsStart = game.events.history.length;
  playOutCity(game);
  const city = game.ledger.slice(ledgerStart);
  for (const p of game.players) {
    // Every City turn start: the rest of the round the grid was finished in (not the final
    // mover, seat 1, whose turn had already begun), then every City round.
    const turns = CITY_ERA.ROUNDS + (p.seat === 1 ? 0 : 1);
    assert.equal(city.filter((e) => e.seat === p.seat && e.reason === TXN.UPKEEP).length, turns, `seat ${p.seat}: upkeep`);
  }
  assert.ok(city.some((e) => e.reason === TXN.TURN_INCOME && e.seat === 1), 'income keeps flowing');
  assert.equal(game.events.history.length - eventsStart, CITY_ERA.ROUNDS, 'Urban Chaos: an event every City round');
  for (const p of game.players) {
    const sum = game.ledger.filter((e) => e.seat === p.seat).reduce((n, e) => n + e.delta, 0);
    assert.equal(p.cash, ECONOMY.STARTING_CASH + sum, 'ledger reconciles');
  }
});

/* ---------------- final game completion ---------------- */

test('the match ends after exactly 4 full City rounds, every mayor playing each one', () => {
  for (const n of [2, 3, 4]) {
    const { game, last } = almostComplete({ n });
    const seen = [];
    placeRoad(game, last);
    const start = game.city.startRound;
    playOutCity(game, { turn: (g) => seen.push([g.round, currentPlayer(g).seat, eraStatus(g).roundsLeft]) });
    assert.equal(game.phase, PHASES.ENDED, `${n} players`);
    assert.equal(game.round, start + CITY_ERA.ROUNDS - 1, 'no round beyond the last City round');
    const full = seen.filter(([round]) => round >= start);
    assert.equal(full.length, CITY_ERA.ROUNDS * n, `${n} players: every seat, every City round`);
    for (const seat of game.players.map((p) => p.seat)) {
      assert.equal(full.filter(([, s]) => s === seat).length, CITY_ERA.ROUNDS);
    }
    // The rest of the round in which the grid was finished: the final mover, then the other seats.
    assert.deepEqual(seen.filter(([round]) => round < start).map(([, s]) => s), game.players.map((p) => p.seat));
    assert.deepEqual([...new Set(full.map(([, , left]) => left))], [4, 3, 2, 1], 'rounds left counts down');
    assert.ok(game.results, 'results are computed at the end');
    assert.deepEqual(game.finalSettlement.players, [], 'a full round needs no settlement');
    assert.ok(game.log.at(-1).type === 'game-end' && game.log.at(-1).era === 'city');
    assert.equal(eraStatus(game).roundsLeft, 0);
    assert.equal(cityTurnsLeft(game), 0);
  }
});

test('the last City turn returns gameEnded and freezes the results', () => {
  const game = cityGame({ cityRounds: 1 });
  let r;
  for (let turns = 0; turns < 10 && game.phase === PHASES.PLAYING; turns++) r = endCityTurn(game);
  assert.equal(r.ok, true);
  assert.equal(r.gameEnded, true);
  assert.equal(r.turnIncome, null, 'nobody starts another turn');
  assert.equal(game.round, game.city.endRound);
  const frozen = JSON.stringify(game.results);
  getPlayer(game, 2).cash = 999999;
  assert.equal(JSON.stringify(game.results), frozen);
});

test('City rounds and actions are configurable per game', () => {
  const game = cityGame({ cityRounds: 2, cityActions: 3 });
  assert.equal(game.city.actionsLeft, 3);
  for (const id of ['r0c0', 'r0c0', 'r0c0']) upgradeBlock(game, id);
  assert.equal(game.city.actionsLeft, 1, 'Level 3 is the cap: two upgrades, one action left');
  playOutCity(game);
  assert.equal(game.round, game.city.startRound + 1);
});

test('full games through the real rules: genuine, complete, and deterministic', () => {
  const a = playthrough(api, { seats: seats(4), seed: 77, gameType: 'standard' });
  const b = playthrough(api, { seats: seats(4), seed: 77, gameType: 'standard' });
  assert.equal(a.game.phase, 'ended');
  assert.equal(a.game.era, 'city');
  assert.equal(isGenuineMatch(a.game), true, 'a match with a CITY era is a genuine match');
  assert.deepEqual([a.values, a.rounds, a.events], [b.values, b.rounds, b.events]);
  const expansionOnly = playthrough(api, { seats: seats(4), seed: 77, gameType: 'standard', cityRounds: 0 });
  assert.equal(a.rounds, expansionOnly.rounds + CITY_ERA.ROUNDS);
});

/* ---------------- autosave ---------------- */

test('autosave mid-CITY era restores and plays on exactly like the original', () => {
  const full = playthrough(api, { seats: seats(4), seed: 2024, gameType: 'standard' });
  const part = playthrough(api, { seats: seats(4), seed: 2024, gameType: 'standard' }, { stopAfterRoads: 84 });
  assert.equal(part.game.era, 'city');
  // Play a few City turns before saving, with an action spent in the saved turn.
  for (let i = 0; i < 5; i++) endCityTurn(part.game);
  const storage = memoryStorage();
  assert.equal(saveActiveGame(part.game, { seats: seats(4), gameType: 'standard' }, storage), true);
  const restored = loadActiveGame(storage);
  assert.ok(restored);
  assert.equal(restored.game.era, ERAS.CITY);
  assert.deepEqual(restored.game.city, part.game.city);
  const replay = playthrough(api, { seats: seats(4), seed: 2024, gameType: 'standard' }, { stopAfterRoads: 84 });
  for (let i = 0; i < 5; i++) endCityTurn(replay.game);
  const a = playthrough(api, null, { game: restored.game });
  const b = playthrough(api, null, { game: replay.game });
  assert.deepEqual(a.values, b.values);
  assert.equal(a.rounds, full.rounds);
});

test('saves from before eras load as EXPANSION; inconsistent era state is rejected', () => {
  const storage = memoryStorage();
  const game = createGame({ seats: seats(4), seed: 3 });
  saveActiveGame(game, { seats: seats(4) }, storage);
  const raw = JSON.parse(storage.getItem(SAVE_KEY));
  raw.version = 1; // a V1.3 save: written before eras existed
  delete raw.game.era;
  delete raw.game.city;
  storage.setItem(SAVE_KEY, JSON.stringify(raw));
  const legacy = loadActiveGame(storage);
  assert.equal(legacy.game.era, ERAS.EXPANSION);
  assert.deepEqual(legacy.game.city, { rounds: CITY_ERA.ROUNDS, actionsPerTurn: CITY_ERA.ACTIONS_PER_TURN, startRound: null, endRound: null, actionsLeft: 0, takeovers: 0 });

  const city = cityGame();
  const good = memoryStorage();
  assert.equal(saveActiveGame(city, { seats: seats(4) }, good), true);
  const cityRaw = JSON.parse(good.getItem(SAVE_KEY));
  assert.ok(loadActiveGame(good));
  const corruptions = [
    (g) => { g.city.actionsLeft = 3; },
    (g) => { g.city.actionsLeft = -1; },
    (g) => { g.city.endRound = g.city.startRound + 9; },
    (g) => { g.era = 'utopia'; },
    (g) => { g.era = ERAS.EXPANSION; }, // every road paved, yet still EXPANSION
    (g) => { delete g.board.roads['h-0-0']; }, // CITY with an open road
    (g) => { g.turnPhase = TURN_PHASES.PAVE_ROAD; },
    (g) => { g.city = null; },
  ];
  for (const corrupt of corruptions) {
    const bad = structuredClone(cityRaw);
    corrupt(bad.game);
    good.setItem(SAVE_KEY, JSON.stringify(bad));
    assert.equal(loadActiveGame(good), null, corrupt.toString());
  }
});
