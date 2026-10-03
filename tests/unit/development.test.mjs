import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ECONOMY } from '../../js/config.js';
import { getBlock, getBlockById } from '../../js/core/board.js';
import { describeDevelopment } from '../../js/core/buildings.js';
import {
  TABLE, MAX_LEVEL, DEV_ERRORS, quoteBuild, quoteUpgrade, buildOnBlock, upgradeBlock,
  isDeveloped, levelStats,
} from '../../js/core/development.js';
import { TXN, isValidAmount, calculateIncome, propertyValue, upkeepFor } from '../../js/core/economy.js';
import { createGame, placeRoad, resolveCapture, currentPlayer, getPlayer, playerStats, PHASES, TURN_PHASES } from '../../js/core/game.js';

const four = () => createGame({ seats: [1, 2, 3, 4].map((seat) => ({ seat })), eventPool: [] });
const cash = (game, seat) => getPlayer(game, seat).cash;
const snapshot = (game) => JSON.stringify({ players: game.players, blocks: game.board.blocks, ledger: game.ledger });

/** P1 captures A1 (r0c0, suburbs) through real play. */
function p1CapturesA1() {
  const game = four();
  ['h-0-0', 'v-0-0', 'h-1-0'].forEach((id) => { game.board.roads[id] = 0; });
  const r = placeRoad(game, 'v-0-1');
  assert.deepEqual(r.captured, ['r0c0']);
  assert.equal(currentPlayer(game).seat, 1, 'P1 keeps the turn (bonus road)');
  return game; // P1 cash: 12,000 + 500
}

/* ---------------- config-driven tables ---------------- */

test('Level 1 matches the category spec', () => {
  const spec = {
    residential: [1000, 300],
    commercial: [1500, 500],
    park: [800, 150], // V1.2 balance pass: was 100 (Level 3 lost money every turn)
    civic: [2000, 325], // V1.2: was 250 (same)
    industrial: [1750, 600],
    landmark: [3000, 850], // V1.2: was 700 (paid back slower than Industrial at every level)
  };
  assert.deepEqual(Object.keys(TABLE).sort(), Object.keys(spec).sort());
  for (const [type, [cost, income]] of Object.entries(spec)) {
    assert.deepEqual(TABLE[type][1], { cost, income, invested: cost }, type);
  }
});

test('no build or upgrade is a trap: each step earns more per turn than the upkeep it adds', () => {
  for (const [type, rows] of Object.entries(TABLE)) {
    for (let lv = 1; lv <= MAX_LEVEL; lv++) {
      const extraIncome = rows[lv].income - rows[lv - 1].income;
      const extraUpkeep = Math.round(rows[lv].cost * ECONOMY.FINANCE.UPKEEP_PERCENT / 100);
      assert.ok(extraIncome > extraUpkeep, `${type} level ${lv}: +$${extraIncome} income vs +$${extraUpkeep} upkeep`);
    }
  }
});

test('levels 1–3 have increasing upgrade costs and income, all whole dollars', () => {
  assert.equal(MAX_LEVEL, 3);
  for (const [type, rows] of Object.entries(TABLE)) {
    assert.deepEqual(rows[0], { cost: 0, income: 0, invested: 0 });
    let invested = 0;
    for (let lv = 1; lv <= MAX_LEVEL; lv++) {
      const { cost, income } = rows[lv];
      const { cost: mc, income: mi } = ECONOMY.DEVELOPMENT.LEVELS[lv];
      const base = ECONOMY.DEVELOPMENT.CATEGORIES[type];
      assert.equal(cost, base.cost * mc, `${type} L${lv} cost from config`);
      assert.equal(income, base.income * mi, `${type} L${lv} income from config`);
      assert.ok(isValidAmount(cost) && isValidAmount(income));
      invested += cost;
      assert.equal(rows[lv].invested, invested);
      if (lv > 1) {
        assert.ok(cost > rows[lv - 1].cost, `${type} L${lv} costs more than L${lv - 1}`);
        assert.ok(income > rows[lv - 1].income, `${type} L${lv} earns more than L${lv - 1}`);
      }
    }
    assert.equal(rows[MAX_LEVEL + 1], undefined);
  }
  // Worked example: Residential 1000/300 → +1500/600 → +2000/900
  assert.deepEqual(TABLE.residential[2], { cost: 1500, income: 600, invested: 2500 });
  assert.deepEqual(TABLE.residential[3], { cost: 2000, income: 900, invested: 4500 });
  assert.equal(levelStats('residential', 9), null);
  assert.equal(levelStats('__proto__', 1), null);
});

/* ---------------- captured blocks start vacant ---------------- */

test('a captured block starts Vacant Level 0 with land value and no income', () => {
  const game = p1CapturesA1();
  const a1 = getBlockById(game.board, 'r0c0');
  assert.equal(a1.ownerSeat, 1);
  assert.deepEqual({ type: a1.type, level: a1.level, value: a1.value, income: a1.income },
    { type: 'vacant', level: 0, value: ECONOMY.LAND_VALUE.suburbs, income: 0 });
  assert.equal(isDeveloped(a1), false);
  assert.equal(describeDevelopment(a1), 'Vacant · Level 0');
});

/* ---------------- purchases ---------------- */

test('development is legal during management and for the queued capture, but not during road phases', () => {
  const game = p1CapturesA1();
  assert.equal(game.turnPhase, TURN_PHASES.CAPTURE_DEVELOP);
  assert.equal(quoteBuild(game, 'r0c0', 'park').ok, true, 'captured block can be developed immediately');
  assert.equal(buildOnBlock(game, 'r0c0', 'park').ok, true);
  resolveCapture(game, 'r0c0');
  assert.equal(game.turnPhase, TURN_PHASES.BONUS_ROAD);
  assert.equal(quoteUpgrade(game, 'r0c0').error, DEV_ERRORS.WRONG_PHASE);
  placeRoad(game, 'h-6-5');
  assert.equal(game.turnPhase, TURN_PHASES.MANAGE_CITY);
});

test('building deducts cash immediately and the block stores type/level/value/income', () => {
  const game = p1CapturesA1();
  const q = quoteBuild(game, 'r0c0', 'commercial');
  assert.equal(q.ok, true);
  assert.deepEqual({ cost: q.cost, income: q.income, incomeGain: q.incomeGain }, { cost: 1500, income: 500, incomeGain: 500 });

  const r = buildOnBlock(game, 'r0c0', 'commercial');
  assert.deepEqual(r, { ok: true, block: 'r0c0', type: 'commercial', level: 1, cost: 1500, income: 500, value: 1000 + 1500 });
  assert.equal(cash(game, 1), 12500 - 1500);

  const a1 = getBlockById(game.board, 'r0c0');
  assert.deepEqual({ type: a1.type, level: a1.level, value: a1.value, income: a1.income },
    { type: 'commercial', level: 1, value: 2500, income: 500 });
  assert.equal(describeDevelopment(a1), 'Commercial · Level 1 · Corner Store');
  assert.deepEqual(game.ledger.at(-1), {
    seat: 1, delta: -1500, balance: 11000, reason: TXN.BUILD, round: 1, block: 'r0c0', type: 'commercial', level: 1,
  });
  assert.deepEqual(game.lastDevelopment, { block: 'r0c0', seat: 1, type: 'commercial', level: 1, fromLevel: 0 });

  // HUD stats reflect it.
  assert.deepEqual(playerStats(game, getPlayer(game, 1)), {
    cash: 11000, blocks: 1, income: 500, normalIncome: 500, eventDelta: 0,
    upkeep: Math.round(1000 * ECONOMY.FINANCE.LAND_TAX_PERCENT / 100) + Math.round(1500 * ECONOMY.FINANCE.UPKEEP_PERCENT / 100),
    net: 500 - Math.round(1000 * ECONOMY.FINANCE.LAND_TAX_PERCENT / 100) - Math.round(1500 * ECONOMY.FINANCE.UPKEEP_PERCENT / 100),
    distress: false, bankruptcies: 0,
    bonus: 0, property: 2500, netWorth: 13500, prestige: 0,
    bankruptcyPenalty: 0, nextRecoveryCapital: ECONOMY.FINANCE.RECOVERY.CAPITAL, recovering: false,
  });
});

test('upgrades go Level 1 → 2 → 3 with increasing costs, deducted immediately', () => {
  const game = p1CapturesA1();
  buildOnBlock(game, 'r0c0', 'residential'); // −1000 → 11,500
  assert.equal(cash(game, 1), 11500);

  const q2 = quoteUpgrade(game, 'r0c0');
  assert.deepEqual({ ok: q2.ok, level: q2.level, cost: q2.cost, income: q2.income, incomeGain: q2.incomeGain },
    { ok: true, level: 2, cost: 1500, income: 600, incomeGain: 300 });
  assert.equal(upgradeBlock(game, 'r0c0').ok, true);
  assert.deepEqual(game.lastDevelopment, {
    block: 'r0c0', seat: 1, type: 'residential', level: 2, fromLevel: 1,
  });
  assert.equal(cash(game, 1), 10000);
  let a1 = getBlockById(game.board, 'r0c0');
  assert.deepEqual([a1.level, a1.income, a1.value], [2, 600, 1000 + 2500]);
  assert.equal(describeDevelopment(a1), 'Residential · Level 2 · Rowhouses');

  const r3 = upgradeBlock(game, 'r0c0');
  assert.equal(r3.ok, true);
  assert.equal(r3.cost, 2000);
  assert.equal(game.lastDevelopment.fromLevel, 2, 'rapid upgrades retain the previous visual level');
  assert.equal(cash(game, 1), 8000);
  a1 = getBlockById(game.board, 'r0c0');
  assert.deepEqual([a1.type, a1.level, a1.income, a1.value], ['residential', 3, 900, 1000 + 4500]);

  // Max level.
  const before = snapshot(game);
  assert.equal(quoteUpgrade(game, 'r0c0').error, DEV_ERRORS.MAX_LEVEL);
  assert.deepEqual(upgradeBlock(game, 'r0c0'), { ok: false, error: DEV_ERRORS.MAX_LEVEL, shortfall: 0 });
  assert.equal(snapshot(game), before);

  assert.deepEqual(game.ledger.filter((e) => e.delta < 0).map((e) => [e.reason, e.delta, e.level]),
    [[TXN.BUILD, -1000, 1], [TXN.UPGRADE, -1500, 2], [TXN.UPGRADE, -2000, 3]]);
});

/* ---------------- insufficient funds ---------------- */

test('insufficient funds: nothing changes and the shortfall is reported', () => {
  const game = p1CapturesA1();
  getPlayer(game, 1).cash = 2999;
  const before = snapshot(game);

  const q = quoteBuild(game, 'r0c0', 'landmark');
  assert.equal(q.ok, false);
  assert.equal(q.error, DEV_ERRORS.INSUFFICIENT_FUNDS);
  assert.equal(q.shortfall, 1);
  assert.deepEqual(buildOnBlock(game, 'r0c0', 'landmark'), { ok: false, error: DEV_ERRORS.INSUFFICIENT_FUNDS, shortfall: 1 });
  assert.equal(snapshot(game), before, 'no cash spent, block untouched, nothing logged');

  // Exactly enough is fine and leaves $0, never negative.
  getPlayer(game, 1).cash = 3000;
  assert.equal(buildOnBlock(game, 'r0c0', 'landmark').ok, true);
  assert.equal(cash(game, 1), 0);

  // Can't afford the upgrade either.
  const q2 = quoteUpgrade(game, 'r0c0');
  assert.deepEqual([q2.ok, q2.error, q2.shortfall], [false, DEV_ERRORS.INSUFFICIENT_FUNDS, 4500]);
  assert.equal(upgradeBlock(game, 'r0c0').ok, false);
  assert.equal(cash(game, 1), 0);
  assert.equal(getBlockById(game.board, 'r0c0').level, 1);
});

test('cheap categories stay buildable when expensive ones are not', () => {
  const game = p1CapturesA1();
  getPlayer(game, 1).cash = 900;
  const ok = ['residential', 'commercial', 'park', 'civic', 'industrial', 'landmark']
    .filter((t) => quoteBuild(game, 'r0c0', t).ok);
  assert.deepEqual(ok, ['park']);
});

/* ---------------- owner-only & validity ---------------- */

test('only the owner can develop, and only on their own turn', () => {
  const game = p1CapturesA1();
  // Unclaimed block.
  assert.equal(buildOnBlock(game, 'r3c3', 'park').error, DEV_ERRORS.NOT_OWNER);

  // P1 passes the turn; P2 tries to develop P1's block.
  placeRoad(game, 'h-6-5');
  assert.equal(currentPlayer(game).seat, 2);
  const before = snapshot(game);
  assert.equal(quoteBuild(game, 'r0c0', 'park').error, DEV_ERRORS.NOT_OWNER);
  assert.equal(buildOnBlock(game, 'r0c0', 'park').error, DEV_ERRORS.NOT_OWNER);
  assert.equal(snapshot(game), before);

  // P1's own block can't be developed on P2's turn either.
  getBlockById(game.board, 'r0c0').ownerSeat = 1;
  assert.equal(buildOnBlock(game, 'r0c0', 'park').error, DEV_ERRORS.NOT_OWNER);

  // P2 can develop their own block.
  getBlock(game.board, 5, 5).ownerSeat = 2;
  assert.equal(buildOnBlock(game, 'r5c5', 'park').ok, true);
  assert.equal(cash(game, 2), 12000 - 800);
});

test('invalid requests are rejected without side effects', () => {
  const game = p1CapturesA1();
  const before = snapshot(game);
  assert.equal(buildOnBlock(game, 'r0c0', 'casino').error, DEV_ERRORS.UNKNOWN_TYPE);
  assert.equal(buildOnBlock(game, 'r0c0', '__proto__').error, DEV_ERRORS.UNKNOWN_TYPE);
  assert.equal(buildOnBlock(game, 'r0c0', 'vacant').error, DEV_ERRORS.UNKNOWN_TYPE);
  assert.equal(buildOnBlock(game, 'zzz', 'park').error, DEV_ERRORS.NO_BLOCK);
  assert.equal(upgradeBlock(game, 'r0c0').error, DEV_ERRORS.NOT_DEVELOPED, 'vacant blocks build, not upgrade');
  assert.equal(snapshot(game), before);

  buildOnBlock(game, 'r0c0', 'park');
  assert.equal(buildOnBlock(game, 'r0c0', 'civic').error, DEV_ERRORS.ALREADY_DEVELOPED, 'type is locked once built');
});

test('no development after the game ends', () => {
  const game = p1CapturesA1();
  game.phase = PHASES.ENDED;
  assert.equal(buildOnBlock(game, 'r0c0', 'park').error, DEV_ERRORS.GAME_OVER);
  assert.equal(cash(game, 1), 12500);
});

/* ---------------- income flow ---------------- */

test('developed income is paid at the start of the owner\'s next turn', () => {
  const game = p1CapturesA1();
  buildOnBlock(game, 'r0c0', 'industrial'); // −1750, income 600
  upgradeBlock(game, 'r0c0'); // −2625, income 1200
  assert.equal(cash(game, 1), 12500 - 1750 - 2625);
  assert.equal(calculateIncome(game.board, 1), 1200);
  assert.equal(propertyValue(game.board, 1), 1000 + 1750 + 2625);

  placeRoad(game, 'h-6-5'); // P1 bonus road ends turn → P2
  placeRoad(game, 'h-6-4'); // → P3
  placeRoad(game, 'h-6-3'); // → P4
  const upkeep = upkeepFor(game.board, 1); // land tax + development upkeep
  assert.equal(upkeep, Math.round(1000 * ECONOMY.FINANCE.LAND_TAX_PERCENT / 100)
    + Math.round((1750 + 2625) * ECONOMY.FINANCE.UPKEEP_PERCENT / 100));
  const r = placeRoad(game, 'h-6-2'); // → P1's turn begins
  assert.deepEqual(r.turnIncome, { seat: 1, amount: 1200 });
  assert.deepEqual(r.turnUpkeep, { seat: 1, amount: upkeep, distress: false });
  assert.equal(cash(game, 1), 12500 - 1750 - 2625 + 1200 - upkeep);
});
