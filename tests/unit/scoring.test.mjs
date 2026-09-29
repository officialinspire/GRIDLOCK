import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ECONOMY, CITY_ERA } from '../../js/config.js';
import { getBlock, allRoadIds } from '../../js/core/board.js';
import { applyDevelopment, buildOnBlock, TABLE } from '../../js/core/development.js';
import { refreshBonuses } from '../../js/core/bonuses.js';
import { calculateIncome } from '../../js/core/economy.js';
import {
  scorePlayer, rankScores, awardDistinctions, computeResults, computeMatchStats, DISTINCTIONS, TIEBREAKERS,
} from '../../js/core/scoring.js';
import {
  createGame, placeRoad, beginTurn, currentPlayer, getPlayer, standings, isCityComplete, validateRoad, PHASES, ERAS, MOVE_ERRORS,
} from '../../js/core/game.js';
import { TXN } from '../../js/core/economy.js';
import { playOutCity } from './_city.mjs';
import { distressStatus, declareBankruptcy, sellDevelopment } from '../../js/core/finance.js';

const calm = (n = 4, options = {}) => createGame({ seats: Array.from({ length: n }, (_, i) => ({ seat: i + 1 })), seed: 1, eventPool: [], ...options });

function own(game, row, col, seat, type = 'vacant', level = 0) {
  const b = getBlock(game.board, row, col);
  b.ownerSeat = seat;
  applyDevelopment(b, type, level);
  return b;
}

/** Minimal score object for ranking/award unit tests. */
const s = (seat, o = {}) => ({
  seat, cityValue: 0, prestige: 0, blocks: 0, developed: 0, cash: 0, totalLevels: 0, income: 0, greenery: 0, highest: null, ...o,
});

/* ---------------- City Value ---------------- */

test('City Value uses centralized cash, land, and building coefficients', () => {
  const game = calm();
  own(game, 0, 0, 1); // suburbs lot 1,000
  own(game, 2, 2, 1, 'commercial', 2); // downtown 2,000 + invested 1,500 + 2,250
  const sc = scorePlayer(game, getPlayer(game, 1));
  assert.equal(sc.cash, 12000);
  assert.equal(sc.landValue, ECONOMY.LAND_VALUE.suburbs + ECONOMY.LAND_VALUE.downtown);
  assert.equal(sc.buildingValue, TABLE.commercial[2].invested);
  // 100% cash + 70% land + 100% of construction spend; Commercial earns no Prestige.
  assert.deepEqual([sc.scoredCash, sc.scoredLand, sc.scoredBuildings, sc.prestige, sc.scoredPrestige], [12000, 2100, 3750, 0, 0]);
  assert.equal(sc.cityValue, 12000 + 2100 + 3750);
  assert.deepEqual([sc.blocks, sc.developed, sc.totalLevels], [2, 1, 2]);
  assert.equal(sc.income, calculateIncome(game.board, 1));
});

test('negative cash (debt) lowers City Value; abandoned blocks count for nobody', () => {
  const game = calm();
  own(game, 0, 0, 2, 'residential', 1);
  getPlayer(game, 2).cash = -500;
  assert.equal(scorePlayer(game, getPlayer(game, 2)).cityValue, -500 + 700 + 1000);
  const ruin = own(game, 1, 1, 3, 'park', 1);
  ruin.ownerSeat = null;
  ruin.abandoned = true;
  const sc = scorePlayer(game, getPlayer(game, 3));
  assert.deepEqual([sc.blocks, sc.landValue, sc.buildingValue], [0, 0, 0]);
});

test('highest development: level, then invested, then board order', () => {
  const game = calm();
  own(game, 0, 0, 1, 'park', 3);
  own(game, 0, 1, 1, 'landmark', 3); // same level, more invested → wins
  own(game, 0, 2, 1, 'landmark', 2);
  const hi = scorePlayer(game, getPlayer(game, 1)).highest;
  assert.deepEqual([hi.blockId, hi.label, hi.type, hi.level, hi.name, hi.category], ['r0c1', 'B1', 'landmark', 3, 'Stadium', 'Landmark']);
  assert.ok(hi.sprite);
  own(game, 3, 3, 2, 'park', 1);
  own(game, 3, 4, 2, 'park', 1); // identical → earlier block (row-major) wins
  assert.equal(scorePlayer(game, getPlayer(game, 2)).highest.blockId, 'r3c3');
  assert.equal(scorePlayer(game, getPlayer(game, 3)).highest, null);
});

/* ---------------- ranking & ties ---------------- */

test('ranking: City Value, then Prestige, total levels, cash, blocks', () => {
  assert.deepEqual(TIEBREAKERS.map((t) => t.key), ['cityValue', 'prestige', 'totalLevels', 'cash', 'blocks']);
  const rows = rankScores([
    s(1, { cityValue: 100, blocks: 9, cash: 9000 }), // owning more, or more cash, loses to development
    s(2, { cityValue: 200 }),
    s(3, { cityValue: 100, totalLevels: 2 }),
    s(4, { cityValue: 100, prestige: 1 }),
    s(5, { cityValue: 100, blocks: 9, cash: 1 }),
  ]);
  assert.deepEqual(rows.map((r) => [r.seat, r.rank]), [[2, 1], [4, 2], [3, 3], [1, 4], [5, 5]]);
});

test('exact ties share a rank, listed in seat order, regardless of input order', () => {
  const tie = { cityValue: 500, prestige: 2, totalLevels: 3, cash: 100, blocks: 3 };
  const a = rankScores([s(4, tie), s(2, tie), s(3, { cityValue: 1 }), s(1, tie)]);
  const b = rankScores([s(1, tie), s(3, { cityValue: 1 }), s(2, tie), s(4, tie)]);
  assert.deepEqual(a.map((r) => [r.seat, r.rank]), [[1, 1], [2, 1], [4, 1], [3, 4]]);
  assert.deepEqual(b.map((r) => [r.seat, r.rank]), a.map((r) => [r.seat, r.rank]));
  // Blocks owned is the last tie-breaker.
  const c = rankScores([s(1, { ...tie, blocks: 2 }), s(2, tie)]);
  assert.deepEqual(c.map((r) => [r.seat, r.rank]), [[2, 1], [1, 2]]);
});

test('co-winners in a fresh game (everyone identical)', () => {
  const r = computeResults(calm());
  assert.deepEqual(r.winners, [1, 2, 3, 4]);
  assert.deepEqual(r.distinctions, []);
  assert.ok(r.rows.every((row) => row.rank === 1));
});

/* ---------------- distinctions ---------------- */

test('distinctions go to the best value; ties share; zero-value awards are skipped', () => {
  const awards = awardDistinctions([
    s(1, { blocks: 5, cash: 900, developed: 2, totalLevels: 3, income: 400, greenery: 0 }),
    s(2, { blocks: 5, cash: 100, developed: 2, totalLevels: 4, income: 0, greenery: 2 }),
    s(3, { blocks: 1, cash: 900, developed: 0, highest: { level: 3, invested: 9000, name: 'Stadium' } }),
    s(4, { blocks: 0 }),
  ]);
  const by = Object.fromEntries(awards.map((a) => [a.id, a]));
  assert.deepEqual(by['most-blocks'].seats, [1, 2]);
  assert.equal(by['most-blocks'].shared, true);
  assert.deepEqual(by['most-cash'].seats, [1, 3]);
  assert.deepEqual(by['most-developed'].seats, [2], 'tie on developed broken by total levels');
  assert.deepEqual(by.greenest.seats, [2]);
  assert.deepEqual(by['top-earner'].seats, [1]);
  assert.deepEqual(by.skyline.seats, [3]);
  assert.match(by.skyline.detail, /Stadium \(Lv 3\)/);

  const none = awardDistinctions([s(1), s(2)]);
  assert.deepEqual(none.map((a) => a.id), [], 'nothing to award at zero');
  const allTied = awardDistinctions([s(1, { cash: 5 }), s(2, { cash: 5 }), s(3, { cash: 5 })]);
  assert.deepEqual(allTied, [], 'an award everyone ties for distinguishes nobody');
  assert.equal(DISTINCTIONS.length, 7);
  const proud = awardDistinctions([s(1, { prestige: 4 }), s(2, { prestige: 9 })]).find((a) => a.id === 'most-prestige');
  assert.deepEqual([proud.seats, proud.detail], [[2], '9 Prestige']);
});

test('Greenest City counts park levels', () => {
  const game = calm();
  own(game, 0, 0, 1, 'park', 3);
  own(game, 0, 1, 2, 'park', 1);
  own(game, 0, 2, 2, 'park', 1);
  const r = computeResults(game);
  const green = r.distinctions.find((d) => d.id === 'greenest');
  assert.deepEqual(green.seats, [1]);
  assert.equal(green.detail, '3 park levels');
});

/* ---------------- game completion ---------------- */

test('without a CITY era, final scoring settles every player to the same economic round boundary', () => {
  const game = calm(4, { cityRounds: 0 });
  // Give every player an identical suburb property and development before a
  // simulated round starts. P1 begins that round; P2–P4 have not yet done so.
  for (let seat = 1; seat <= 4; seat++) {
    own(game, 0, seat - 1, seat, 'residential', 1);
    getPlayer(game, seat).lastEconomicRound = 1;
  }
  refreshBonuses(game.board);
  game.round = 2;
  beginTurn(game);

  const ids = allRoadIds(game.board);
  ids.slice(0, -1).forEach((id) => { game.board.roads[id] = 0; });
  // Mark remaining lots as ruins so the last road has no capture reward side effect.
  game.board.blocks.forEach((block) => { if (block.ownerSeat == null) block.abandoned = true; });
  const result = placeRoad(game, ids.at(-1));

  assert.equal(result.gameEnded, true);
  assert.deepEqual(game.finalSettlement.players.map((entry) => entry.seat), [2, 3, 4]);
  assert.ok(game.players.every((player) => player.lastEconomicRound === 2));
  assert.deepEqual(game.players.map((player) => player.cash), [12170, 12170, 12170, 12170],
    'identical economies finish with identical cash regardless of final mover');
});

test('with a CITY era, every mayor gets the same number of turns whoever paves the final road', () => {
  const game = calm();
  for (let seat = 1; seat <= 4; seat++) {
    own(game, 0, seat - 1, seat, 'residential', 1);
    getPlayer(game, seat).lastEconomicRound = 1;
  }
  refreshBonuses(game.board);
  game.round = 2;
  beginTurn(game);
  const ids = allRoadIds(game.board);
  ids.slice(0, -1).forEach((id) => { game.board.roads[id] = 0; });
  game.board.blocks.forEach((block) => { if (block.ownerSeat == null) block.abandoned = true; });
  const result = placeRoad(game, ids.at(-1));
  assert.equal(result.gameEnded, false);
  assert.equal(result.cityEra, true);
  assert.equal(game.finalSettlement, undefined, 'no early settlement: the round is played out');
  playOutCity(game);
  assert.equal(game.phase, PHASES.ENDED);
  assert.equal(game.round, 2 + CITY_ERA.ROUNDS);
  assert.deepEqual(game.finalSettlement.players, [], 'every mayor already had a turn in the last round');
  const paydays = (seat) => game.ledger.filter((e) => e.seat === seat && e.reason === TXN.TURN_INCOME).length;
  // Round 2 (P1 in EXPANSION, P2–P4 as City turns) plus every full City round.
  assert.deepEqual(game.players.map((p) => paydays(p.seat)), Array(4).fill(1 + CITY_ERA.ROUNDS));
  assert.ok(new Set(game.players.map((p) => p.cash)).size === 1, 'identical economies finish with identical cash');
});

test('the game ends after the CITY era; results are frozen at that moment', () => {
  const game = calm();
  const ids = allRoadIds(game.board);
  ids.slice(0, -1).forEach((id) => { game.board.roads[id] = 0; });
  game.board.blocks.slice(0, -1).forEach((b, i) => { b.ownerSeat = (i % 4) + 1; });
  own(game, 0, 0, 1, 'commercial', 1);
  refreshBonuses(game.board);
  assert.equal(isCityComplete(game), false);
  const mover = currentPlayer(game).seat;

  const r = placeRoad(game, ids.at(-1));
  assert.equal(r.gameEnded, false, 'the final road no longer ends the match');
  assert.equal(r.cityEra, true);
  assert.equal(isCityComplete(game), true);
  assert.equal(game.era, ERAS.CITY);
  assert.equal(game.phase, PHASES.PLAYING);
  assert.equal(game.results, null);
  assert.equal(currentPlayer(game).seat, mover, 'the final mover resolves the capture and plays a City turn');
  assert.equal(validateRoad(game, ids[0]), MOVE_ERRORS.ROADS_CLOSED);
  assert.ok(game.ledger.some((e) => e.seat === mover && e.reason === TXN.CAPTURE), 'final capture reward paid');

  playOutCity(game);
  assert.equal(game.phase, PHASES.ENDED);
  assert.ok(game.results);
  const moverRow = game.results.rows.find((x) => x.seat === mover);
  assert.equal(moverRow.cash, getPlayer(game, mover).cash, 'results use the cash at the end of the CITY era');

  // Later changes (e.g. poking at state while viewing the board) don't change the result.
  const frozen = JSON.stringify(game.results);
  getPlayer(game, 2).cash = 999999;
  assert.equal(JSON.stringify(game.results), frozen);
  assert.equal(standings(game)[0].seat, game.results.rows[0].seat);
  assert.equal(game.results.rows.length, 4);
  assert.deepEqual(game.results.winners, game.results.rows.filter((x) => x.rank === 1).map((x) => x.seat));
});

test('match stats summarize chains, districts, blocks, events, and bankruptcies', () => {
  const game = calm();
  own(game, 0, 0, 2, 'commercial', 2);
  own(game, 0, 1, 2, 'commercial', 1);
  own(game, 0, 2, 2, 'commercial', 1);
  own(game, 5, 5, 1, 'landmark', 3);
  game.log.push(
    { type: 'road', seat: 2, captured: ['r0c0'] },
    { type: 'road', seat: 2, captured: ['r0c1', 'r0c2'] },
    { type: 'road', seat: 2, captured: [] },
    { type: 'road', seat: 1, captured: ['r5c5'] },
  );
  game.events.history.push({ id: 'heavy-rain' }, { id: 'city-festival' });
  game.players[0].bankruptcies = 1;
  const stats = computeMatchStats(game);
  assert.deepEqual(stats.longestCaptureChain, { seat: 2, count: 3 });
  assert.deepEqual(stats.biggestDistrict, { seat: 2, type: 'commercial', size: 3 });
  assert.deepEqual(stats.bestSingleBlock, { seat: 1, label: 'F6', value: 14500 });
  assert.equal(stats.eventsSurvived, 2);
  assert.equal(stats.bankruptcies, 1);
});

test('full random games: 4 ranked rows, consistent totals, deterministic from the seed', () => {
  const play = (seed) => {
    const game = createGame({ seats: [1, 2, 3, 4].map((seat) => ({ seat })), seed });
    const pool = allRoadIds(game.board);
    let r = seed;
    const rand = () => ((r = (r * 16807) % 2147483647) / 2147483647);
    const develop = () => {
      const me = currentPlayer(game);
      const vacant = game.board.blocks.find((b) => b.ownerSeat === me.seat && b.level === 0 && !b.abandoned);
      if (vacant && rand() < 0.5) buildOnBlock(game, vacant.id, ['residential', 'commercial', 'park', 'civic', 'industrial', 'landmark'][Math.floor(rand() * 6)]);
    };
    while (game.era === ERAS.EXPANSION) {
      const me = currentPlayer(game);
      while (me.cash < 0) {
        if (distressStatus(game, me).canDeclare) declareBankruptcy(game);
        else sellDevelopment(game, game.board.blocks.find((b) => b.ownerSeat === me.seat && b.level > 0).id);
      }
      develop();
      placeRoad(game, pool.splice(Math.floor(rand() * pool.length), 1)[0]);
    }
    playOutCity(game, { turn: develop });
    return game;
  };
  for (let seed = 1; seed <= 20; seed++) {
    const game = play(seed);
    const res = game.results;
    assert.equal(res.rows.length, 4);
    assert.ok(res.winners.length >= 1);
    for (const row of res.rows) {
      assert.equal(row.cityValue, row.scoredCash + row.scoredLand + row.scoredBuildings + row.scoredPrestige);
      assert.ok(row.developed <= row.blocks);
    }
    const owned = res.rows.reduce((n, row) => n + row.blocks, 0);
    assert.equal(owned, game.board.blocks.filter((b) => b.ownerSeat != null).length);
    for (let i = 1; i < res.rows.length; i++) assert.ok(res.rows[i - 1].cityValue >= res.rows[i].cityValue);
    assert.equal(JSON.stringify(play(seed).results), JSON.stringify(res), 'same seed → same results');
  }
});
