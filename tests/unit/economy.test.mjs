import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ECONOMY } from '../../js/config.js';
import { getBlock, allRoadIds } from '../../js/core/board.js';
import { applyDevelopment, TABLE } from '../../js/core/development.js';
import {
  credit, debit, toAmount, isValidAmount, canAfford, formatCash, formatDelta,
  blockIncome, calculateIncome, propertyValue, netWorth, MONEY_ERRORS, TXN,
} from '../../js/core/economy.js';
import {
  createGame, placeRoad, currentPlayer, getPlayer, playerStats, PHASES,
} from '../../js/core/game.js';

const four = () => createGame({ seats: [1, 2, 3, 4].map((seat) => ({ seat })) });
const cash = (game, seat) => getPlayer(game, seat).cash;
const preset = (game, ids) => ids.forEach((id) => { game.board.roads[id] = 0; });

/** Claim + develop a block directly, bypassing turn/cost rules (setup helper). */
function develop(game, row, col, seat, type, level = 1) {
  const block = getBlock(game.board, row, col);
  block.ownerSeat = seat;
  return applyDevelopment(block, type, level);
}

/* ---------------- constants ---------------- */

test('economy constants are centralized and sane', () => {
  assert.equal(ECONOMY.STARTING_CASH, 12000);
  assert.equal(ECONOMY.CAPTURE_REWARD, 500);
  assert.equal(ECONOMY.UNDEVELOPED_INCOME, 0);
  assert.ok(Object.isFrozen(ECONOMY));
  for (const v of [ECONOMY.STARTING_CASH, ECONOMY.CAPTURE_REWARD, ...Object.values(ECONOMY.LAND_VALUE)]) {
    assert.ok(isValidAmount(v), `bad constant ${v}`);
  }
  // Land values come from config too.
  const game = four();
  assert.equal(getBlock(game.board, 0, 0).price, ECONOMY.LAND_VALUE.suburbs);
  assert.equal(getBlock(game.board, 1, 1).price, ECONOMY.LAND_VALUE.midtown);
  assert.equal(getBlock(game.board, 2, 2).price, ECONOMY.LAND_VALUE.downtown);
});

test('every player starts with $12,000', () => {
  const game = four();
  assert.deepEqual(game.players.map((p) => p.cash), [12000, 12000, 12000, 12000]);
  assert.deepEqual(playerStats(game, game.players[0]), {
    cash: 12000, blocks: 0, income: 0, property: 0, netWorth: 12000,
  });
});

/* ---------------- money safety ---------------- */

test('amounts must be finite, non-negative whole dollars', () => {
  for (const bad of [NaN, Infinity, -Infinity, -1, 0.5, '500', null, undefined, {}, 2 ** 60]) {
    assert.equal(isValidAmount(bad), false, String(bad));
    assert.throws(() => toAmount(bad), RangeError, String(bad));
  }
  assert.equal(toAmount(0), 0);
  assert.equal(toAmount(500), 500);
});

test('credit/debit never produce NaN or negative balances', () => {
  const game = four();
  const p = game.players[0];
  assert.throws(() => credit(game, p, NaN, 'x'), RangeError);
  assert.throws(() => credit(game, p, -100, 'x'), RangeError);
  assert.throws(() => debit(game, p, NaN, 'x'), RangeError);
  assert.throws(() => debit(game, p, '100', 'x'), RangeError);
  assert.equal(p.cash, 12000, 'failed calls leave cash untouched');

  assert.deepEqual(debit(game, p, 12001, TXN.BUILD), { ok: false, error: MONEY_ERRORS.INSUFFICIENT_FUNDS });
  assert.equal(p.cash, 12000);
  assert.equal(debit(game, p, 12000, TXN.BUILD).ok, true);
  assert.equal(p.cash, 0);
  assert.deepEqual(debit(game, p, 1, TXN.BUILD), { ok: false, error: MONEY_ERRORS.INSUFFICIENT_FUNDS });
  assert.equal(p.cash, 0);

  // A corrupted balance is detected instead of propagating.
  p.cash = NaN;
  assert.throws(() => credit(game, p, 100, 'x'), RangeError);
  p.cash = -5;
  assert.throws(() => debit(game, p, 0, 'x'), RangeError);
  p.cash = 0;

  assert.equal(canAfford(p, 0), true);
  assert.equal(canAfford(p, 1), false);
  assert.equal(canAfford(p, NaN), false);
  assert.equal(canAfford({ cash: NaN }, 0), false);
});

test('every money change is written to the ledger', () => {
  const game = four();
  const p = game.players[1];
  const e = credit(game, p, 250, 'test', { note: 'hi' });
  assert.deepEqual(e, { seat: 2, delta: 250, balance: 12250, reason: 'test', round: 1, note: 'hi' });
  assert.equal(credit(game, p, 0, 'test'), null, '$0 credits are not logged');
  debit(game, p, 50, TXN.BUILD);
  assert.deepEqual(game.ledger.map((x) => x.delta), [250, -50]);
});

test('formatting is safe for bad input', () => {
  assert.equal(formatCash(12000), '$12,000');
  assert.equal(formatCash(NaN), '$0');
  assert.equal(formatDelta(500), '+$500');
  assert.equal(formatDelta(-1500), '−$1,500');
});

/* ---------------- income & property ---------------- */

test('vacant blocks generate no income; developed blocks pay their stored income', () => {
  const game = four();
  const lot = getBlock(game.board, 0, 0);
  lot.ownerSeat = 1;
  assert.deepEqual([lot.type, lot.level, lot.income, lot.value], ['vacant', 0, 0, ECONOMY.LAND_VALUE.suburbs]);
  assert.equal(blockIncome(lot), 0);
  assert.equal(calculateIncome(game.board, 1), 0);

  develop(game, 0, 1, 1, 'commercial');
  assert.equal(calculateIncome(game.board, 1), 500);

  // A corrupted stored income counts as $0 rather than NaN.
  const bad = develop(game, 0, 2, 1, 'park');
  bad.income = NaN;
  assert.equal(blockIncome(bad), 0);
  assert.equal(calculateIncome(game.board, 1), 500);
});

test('net property value = land + building cost; net worth adds cash', () => {
  const game = four();
  getBlock(game.board, 0, 0).ownerSeat = 2; // vacant suburbs lot
  develop(game, 2, 2, 2, 'landmark', 2); // downtown landmark, level 2
  const expected = ECONOMY.LAND_VALUE.suburbs + ECONOMY.LAND_VALUE.downtown + TABLE.landmark[2].invested;
  assert.equal(propertyValue(game.board, 2), expected);
  assert.equal(netWorth(game, getPlayer(game, 2)), 12000 + expected);
  assert.equal(playerStats(game, getPlayer(game, 2)).property, expected);
});

/* ---------------- capture rewards ---------------- */

test('capturing a block awards $500 to the capturer only', () => {
  const game = four();
  preset(game, ['h-0-0', 'v-0-0', 'h-1-0']);
  const r = placeRoad(game, 'v-0-1'); // P1 closes A1
  assert.equal(r.reward, 500);
  assert.equal(cash(game, 1), 12500);
  assert.deepEqual([2, 3, 4].map((s) => cash(game, s)), [12000, 12000, 12000]);
  assert.deepEqual(game.ledger.at(-1), {
    seat: 1, delta: 500, balance: 12500, reason: TXN.CAPTURE, round: 1, blocks: ['r0c0'],
  });
});

test('a double capture pays $500 per block', () => {
  const game = four();
  preset(game, ['h-1-1', 'h-2-1', 'v-1-1', 'h-1-2', 'h-2-2', 'v-1-3']);
  const r = placeRoad(game, 'v-1-2');
  assert.equal(r.captured.length, 2);
  assert.equal(r.reward, 1000);
  assert.equal(cash(game, 1), 13000);
});

test('non-capturing roads cost and pay nothing', () => {
  const game = four();
  const r = placeRoad(game, 'h-3-3');
  assert.equal(r.reward, 0);
  assert.deepEqual(game.players.map((p) => p.cash), [12000, 12000, 12000, 12000]);
  assert.equal(game.ledger.length, 0);
});

/* ---------------- 4-player turn/income flow ---------------- */

test('income is paid at the start of each player\'s own turn, from developed blocks only', () => {
  const game = four();
  // Seat 2 owns a developed house + an empty lot; seat 3 owns only an empty lot.
  develop(game, 5, 5, 2, 'residential');
  getBlock(game.board, 5, 4).ownerSeat = 2;
  getBlock(game.board, 5, 3).ownerSeat = 3;
  const houseIncome = ECONOMY.DEVELOPMENT.CATEGORIES.residential.income;

  const r1 = placeRoad(game, 'h-0-0'); // P1 → P2's turn begins
  assert.deepEqual(r1.turnIncome, { seat: 2, amount: houseIncome });
  assert.equal(cash(game, 2), 12000 + houseIncome);
  assert.equal(cash(game, 1), 12000, 'P1 is not paid when P2 starts');

  const r2 = placeRoad(game, 'h-0-1'); // → P3: owns only undeveloped land
  assert.deepEqual(r2.turnIncome, { seat: 3, amount: 0 });
  assert.equal(cash(game, 3), 12000);

  placeRoad(game, 'h-0-2'); // → P4
  const r4 = placeRoad(game, 'h-0-3'); // → P1, round 2
  assert.equal(r4.roundEnded, true);
  assert.equal(game.round, 2);
  placeRoad(game, 'h-0-4'); // → P2 again: paid a second time
  assert.equal(cash(game, 2), 12000 + 2 * houseIncome);

  const incomeEntries = game.ledger.filter((e) => e.reason === TXN.TURN_INCOME);
  assert.deepEqual(incomeEntries.map((e) => [e.seat, e.delta]), [[2, houseIncome], [2, houseIncome]]);
});

test('bonus roads after a capture do not pay turn income again', () => {
  const game = four();
  develop(game, 5, 5, 1, 'commercial');
  const marketIncome = ECONOMY.DEVELOPMENT.CATEGORIES.commercial.income;

  preset(game, ['h-0-0', 'v-0-0', 'h-1-0']);
  const r = placeRoad(game, 'v-0-1'); // P1 captures → bonus road, same turn
  assert.equal(r.extraTurn, true);
  assert.equal(r.turnIncome, null);
  assert.equal(cash(game, 1), 12500, 'reward only, no income mid-turn');

  placeRoad(game, 'h-5-5'); // P1's bonus road closes nothing (F6 still open) → P2
  assert.equal(currentPlayer(game).seat, 2);
  assert.equal(cash(game, 1), 12500, 'still no income for the bonus road');

  placeRoad(game, 'h-3-0'); // P2 → P3
  placeRoad(game, 'h-3-1'); // P3 → P4
  const back = placeRoad(game, 'h-3-2'); // P4 → P1's next turn begins
  assert.deepEqual(back.turnIncome, { seat: 1, amount: marketIncome });
  assert.equal(cash(game, 1), 12500 + marketIncome);
});

test('full 4-player games keep every balance valid and reconcile with the ledger', () => {
  let seed = 11;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let g = 0; g < 20; g++) {
    const game = four();
    // Develop a few blocks mid-game so turn income flows too.
    const pool = allRoadIds(game.board);
    let developed = false;
    while (game.phase === PHASES.PLAYING) {
      // Once someone has captured a block, put a building on it so turn income flows.
      const owned = !developed && game.board.blocks.find((b) => b.ownerSeat != null);
      if (owned) { applyDevelopment(owned, 'industrial', 3); developed = true; }
      const [id] = pool.splice(Math.floor(rand() * pool.length), 1);
      assert.equal(placeRoad(game, id).ok, true);
      for (const p of game.players) assert.ok(isValidAmount(p.cash), `seat ${p.seat} cash ${p.cash}`);
    }
    assert.ok(game.ledger.some((e) => e.reason === TXN.TURN_INCOME), 'turn income was exercised');
    for (const p of game.players) {
      const fromLedger = game.ledger.filter((e) => e.seat === p.seat).reduce((n, e) => n + e.delta, 0);
      assert.equal(p.cash, ECONOMY.STARTING_CASH + fromLedger, `ledger reconciles for seat ${p.seat}`);
    }
    const rewards = game.ledger.filter((e) => e.reason === TXN.CAPTURE).reduce((n, e) => n + e.delta, 0);
    assert.equal(rewards, 36 * ECONOMY.CAPTURE_REWARD, 'every block paid exactly one reward');
  }
});
