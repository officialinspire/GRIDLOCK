import { test } from 'node:test';
import { scorePlayer } from '../../js/core/scoring.js';
import assert from 'node:assert/strict';

import { ECONOMY } from '../../js/config.js';
import { getBlock, getBlockById, allRoadIds } from '../../js/core/board.js';
import { applyDevelopment, buildOnBlock, upgradeBlock, TABLE, DEV_ERRORS } from '../../js/core/development.js';
import { refreshBonuses } from '../../js/core/bonuses.js';
import { startEvent, eligibleTargets, getEventDef, effectiveIncome } from '../../js/core/events.js';
import {
  TXN, blockUpkeep, upkeepFor, isInDistress, calculateIncome, propertyValue, charge,
} from '../../js/core/economy.js';
import {
  createGame, placeRoad, currentPlayer, getPlayer, playerStats, standings, MOVE_ERRORS, PHASES, ERAS, TURN_PHASES,
  endCityTurn, resolveCapture,
} from '../../js/core/game.js';
import { playOutCity } from './_city.mjs';
import {
  quoteDowngrade, quoteSale, downgradeBlock, sellDevelopment, liquidationValue, distressStatus,
  declareBankruptcy, quoteAcquire, acquireAbandoned, ownershipProblems, FIN_ERRORS, ACQUIRE_MODES,
  eligibleRedevelopers, resolveRedevelopmentAuction,
} from '../../js/core/finance.js';

const FIN = ECONOMY.FINANCE;
const seats = (n = 4) => Array.from({ length: n }, (_, i) => ({ seat: i + 1 }));
const calm = () => createGame({ seats: seats(), seed: 1, eventPool: [] });
const cash = (g, s) => getPlayer(g, s).cash;
const snap = (g) => JSON.stringify({ players: g.players, blocks: g.board.blocks, roads: g.board.roads, ledger: g.ledger });

function dev(game, row, col, seat, type, level = 1) {
  const b = getBlock(game.board, row, col);
  b.ownerSeat = seat;
  applyDevelopment(b, type, level);
  refreshBonuses(game.board);
  return b;
}

/** P1 plays a quiet road so P2's turn begins (income, then upkeep). */
const passToP2 = (game) => placeRoad(game, 'h-6-5');

/** P2 in distress: a park under Heavy Rain earns $0 but still owes upkeep. */
/* ---------------- upkeep ---------------- */

test('upkeep = land tax + % of invested development, charged after income at turn start', () => {
  const game = calm();
  const home = dev(game, 0, 0, 2, 'residential', 3); // suburbs land 1,000; invested 4,500
  const tax = 1000 * FIN.LAND_TAX_PERCENT / 100;
  assert.equal(blockUpkeep(home), tax + 4500 * FIN.UPKEEP_PERCENT / 100);
  const lot = getBlock(game.board, 0, 1);
  lot.ownerSeat = 2; // vacant: land tax only
  assert.equal(blockUpkeep(lot), tax);
  const expected = 2 * tax + 4500 * FIN.UPKEEP_PERCENT / 100;
  assert.equal(upkeepFor(game.board, 2), expected);
  assert.equal(playerStats(game, getPlayer(game, 2)).upkeep, expected);
  assert.equal(blockUpkeep(getBlock(game.board, 5, 5)), 0, 'unowned: nothing');

  const r = passToP2(game);
  assert.deepEqual(r.turnIncome, { seat: 2, amount: 900 });
  assert.deepEqual(r.turnUpkeep, { seat: 2, amount: expected, distress: false });
  assert.equal(cash(game, 2), 12000 + 900 - expected);
  assert.deepEqual(game.ledger.slice(-2).map((e) => [e.reason, e.delta]), [[TXN.TURN_INCOME, 900], [TXN.UPKEEP, -expected]]);
});

/* ---------------- distress ---------------- */

test('cash below $0 puts the player in distress; they can\'t pave or buy', () => {
  // Idle land + a rained-out park: income can't cover upkeep.
  const game = calm();
  dev(game, 3, 3, 2, 'park', 3); // income 300 → 0 under Heavy Rain
  for (const c of [0, 1, 2, 3, 4, 5]) getBlock(game.board, 5, c).ownerSeat = 2; // 6 vacant suburbs lots
  startEvent(game, 'heavy-rain');
  getPlayer(game, 2).cash = 30;
  const upkeep = upkeepFor(game.board, 2);
  const r = passToP2(game);
  assert.equal(r.turnIncome.amount, 0);
  assert.deepEqual(r.turnUpkeep, { seat: 2, amount: upkeep, distress: true });
  assert.equal(cash(game, 2), 30 - upkeep);
  assert.equal(currentPlayer(game).seat, 2);
  assert.equal(playerStats(game, getPlayer(game, 2)).distress, true);

  const before = snap(game);
  assert.deepEqual(placeRoad(game, 'h-0-0'), { ok: false, error: MOVE_ERRORS.IN_DISTRESS });
  assert.equal(buildOnBlock(game, 'r5c0', 'park').error, DEV_ERRORS.INSUFFICIENT_FUNDS);
  assert.equal(snap(game), before, 'nothing changed');
});

test('downgrading refunds 50% of the removed level; selling refunds 50% of everything invested', () => {
  const game = calm();
  const b = dev(game, 0, 0, 1, 'commercial', 3); // costs 1500 + 2250 + 3000
  const dq = quoteDowngrade(game, 'r0c0');
  assert.deepEqual([dq.fromLevel, dq.toLevel, dq.removed, dq.refund], [3, 2, 3000, 1500]);
  assert.equal(downgradeBlock(game, 'r0c0').refund, 1500);
  assert.deepEqual([b.type, b.level, b.income], ['commercial', 2, TABLE.commercial[2].income]);
  assert.equal(cash(game, 1), 13500);

  game.city.actionsLeft = 1; // a fresh Manage City: refunds are under test here, not the action budget
  const sq = quoteSale(game, 'r0c0');
  assert.deepEqual([sq.removed, sq.refund], [3750, 1875]);
  assert.equal(sellDevelopment(game, 'r0c0').ok, true);
  assert.deepEqual([b.type, b.level, b.income, b.value, b.ownerSeat], ['vacant', 0, 0, b.price, 1]);
  assert.equal(cash(game, 1), 13500 + 1875);
  assert.deepEqual(game.ledger.map((e) => [e.reason, e.delta]), [[TXN.SALE, 1500], [TXN.SALE, 1875]]);

  assert.equal(quoteSale(game, 'r0c0').error, FIN_ERRORS.NOT_DEVELOPED);
  // Level 1 downgrade → vacant.
  dev(game, 0, 1, 1, 'park');
  game.city.actionsLeft = 1;
  assert.equal(downgradeBlock(game, 'r0c1').level, 0);
  assert.equal(getBlock(game.board, 0, 1).type, 'vacant');
});

test('only the owner can sell, on their turn', () => {
  const game = calm();
  dev(game, 0, 0, 2, 'park');
  assert.equal(quoteSale(game, 'r0c0').error, FIN_ERRORS.NOT_OWNER);
  assert.equal(downgradeBlock(game, 'r0c0').error, FIN_ERRORS.NOT_OWNER);
  assert.equal(sellDevelopment(game, 'nope').error, FIN_ERRORS.NO_BLOCK);
});

test('selling out of distress recovers the player and unblocks paving', () => {
  const game = calm();
  dev(game, 3, 3, 2, 'park', 3);
  dev(game, 0, 0, 2, 'residential'); // sells for 500
  passToP2(game);
  getPlayer(game, 2).cash = -400; // (set directly; the distress trigger is tested above)
  const st = distressStatus(game);
  assert.deepEqual([st.inDistress, st.debt, st.canRecover, st.canDeclare], [true, 400, true, false]);
  assert.equal(declareBankruptcy(game).error, FIN_ERRORS.CAN_STILL_RECOVER, 'must sell first');

  const r = sellDevelopment(game, 'r0c0');
  assert.equal(r.refund, 500);
  assert.equal(r.recovered, true);
  assert.equal(cash(game, 2), 100);
  assert.equal(placeRoad(game, 'h-0-0').ok, true);
});

/* ---------------- bankruptcy ---------------- */

function p2Insolvent() {
  const game = calm();
  dev(game, 2, 2, 2, 'residential');
  dev(game, 2, 3, 2, 'residential');
  dev(game, 2, 4, 2, 'residential'); // district — neighbours lose it on bankruptcy
  getBlock(game.board, 5, 5).ownerSeat = 2; // vacant land
  dev(game, 1, 2, 3, 'park'); // another player's block stays untouched
  passToP2(game);
  getPlayer(game, 2).cash = -5000; // liquidation 1,500 < 5,000
  return game;
}

test('bankruptcy is only allowed when selling everything can\'t cover the debt', () => {
  const game = calm();
  assert.equal(declareBankruptcy(game).error, FIN_ERRORS.NOT_IN_DISTRESS);
  const g = p2Insolvent();
  assert.equal(liquidationValue(g.board, 2), 1500);
  assert.equal(distressStatus(g).canDeclare, true);
});

test('bankruptcy abandons every block, keeps roads, writes off debt and grants recovery capital', () => {
  const game = p2Insolvent();
  const roads = JSON.stringify(game.board.roads);
  const r = declareBankruptcy(game);
  assert.equal(r.ok, true);
  assert.deepEqual(r.abandoned.sort(), ['r2c2', 'r2c3', 'r2c4', 'r5c5']);
  assert.equal(r.debtForgiven, 5000);
  assert.equal(r.capital, FIN.RECOVERY.CAPITAL);
  assert.deepEqual(r.penalty, { cityValue: FIN.BANKRUPTCY_PENALTY.CITY_VALUE, prestige: FIN.BANKRUPTCY_PENALTY.PRESTIGE });

  const p2 = getPlayer(game, 2);
  assert.equal(p2.cash, 2000);
  assert.equal(p2.bankruptcies, 1);
  assert.equal(isInDistress(p2), false);
  assert.equal(JSON.stringify(game.board.roads), roads, 'roads remain');
  assert.deepEqual(game.ledger.slice(-2).map((e) => [e.reason, e.delta]), [[TXN.DEBT_WRITE_OFF, 5000], [TXN.FRESH_START, 2000]]);

  for (const id of r.abandoned) {
    const b = getBlockById(game.board, id);
    assert.deepEqual([b.ownerSeat, b.abandoned, b.abandonedBy], [null, true, 2]);
    assert.equal(b.bonusIncome, 0, 'inactive');
  }
  assert.equal(getBlock(game.board, 2, 2).type, 'residential', 'development stays visible');
  assert.equal(getBlock(game.board, 2, 2).level, 1);
  assert.equal(getBlock(game.board, 1, 2).ownerSeat, 3, 'other players untouched');
  assert.deepEqual(ownershipProblems(game), []);
  assert.equal(game.players.length, 4, 'player stays in the game');

  // Abandoned blocks earn and cost nothing, and count for nobody.
  assert.equal(calculateIncome(game.board, 2), 0);
  assert.equal(upkeepFor(game.board, 2), 0);
  assert.equal(propertyValue(game.board, 2), 0);
  assert.equal(playerStats(game, p2).blocks, 0);
  assert.deepEqual(eligibleTargets(game, getEventDef('fire')).map((b) => b.id), [], 'events ignore ruins');

  // P2 carries on with their turn.
  assert.equal(currentPlayer(game).seat, 2);
  assert.equal(placeRoad(game, 'h-0-0').ok, true);
});

test('repeated bankruptcy: recovery capital shrinks but never hits $0, and the score penalty grows', () => {
  const game = calm();
  passToP2(game);
  const p2 = getPlayer(game, 2);
  const results = [];
  for (let i = 0; i < 5; i++) {
    p2.cash = -100;
    const r = declareBankruptcy(game);
    results.push([r.capital, r.penalty.cityValue, r.penalty.prestige]);
    assert.equal(isInDistress(p2), false, 'every bankruptcy ends distress');
    assert.equal(p2.cash, r.capital, 'no permanent $0 soft-lock');
  }
  const { CITY_VALUE: V, PRESTIGE: P } = FIN.BANKRUPTCY_PENALTY;
  assert.deepEqual(results, [[2000, V, P], [1000, 3 * V, 2 * P], [500, 6 * V, 3 * P], [500, 10 * V, 4 * P], [500, 15 * V, 5 * P]]);
  assert.equal(p2.bankruptcies, 5);
  // Farming can't pay: each extra bankruptcy's penalty outgrows the capital it hands out.
  assert.ok(5 * V > FIN.RECOVERY.MIN_CAPITAL);
  const row = scorePlayer(game, p2);
  assert.equal(row.bankruptcyPenalty, 15 * V);
  assert.equal(row.cityValue, row.scoredCash + row.scoredLand + row.scoredBuildings + row.scoredPrestige - 15 * V);
  assert.equal(game.log.filter((e) => e.type === 'bankruptcy').at(-1).count, 5);
});

test('a bankrupt player owes no upkeep afterwards, so they can\'t loop back into distress', () => {
  const game = p2Insolvent();
  declareBankruptcy(game);
  placeRoad(game, 'h-0-0'); // P2 → P3
  placeRoad(game, 'h-0-1'); // P3 → P4
  placeRoad(game, 'h-0-2'); // P4 → P1
  const r = placeRoad(game, 'h-0-3'); // P1 → P2's next turn
  assert.deepEqual(r.turnUpkeep, { seat: 2, amount: 0, distress: false });
  assert.equal(cash(game, 2), 2000);
});

/* ---------------- abandoned blocks ---------------- */

function withRuins() {
  const game = p2Insolvent();
  declareBankruptcy(game);
  placeRoad(game, 'h-0-0'); // → P3's turn
  return game;
}

test('contested redevelopment handles multiple bidders, ties, funds, and former owners', () => {
  const game = withRuins();
  const block = getBlock(game.board, 2, 2);
  const reserve = quoteAcquire(game, block.id, ACQUIRE_MODES.RESTORE).cost;
  assert.deepEqual(eligibleRedevelopers(game, block).map((p) => p.seat), [1, 3, 4], 'former owner excluded');
  getPlayer(game, 4).cash = reserve - 1;
  const result = resolveRedevelopmentAuction(game, block.id, ACQUIRE_MODES.RESTORE, [
    { seat: 2, bid: reserve + 1000 }, // former owner
    { seat: 4, bid: reserve + 500 }, // insufficient funds
    { seat: 3, bid: reserve + 200 },
    { seat: 1, bid: reserve + 200 }, // tie: lowest seat wins
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.winnerSeat, 1);
  assert.equal(block.ownerSeat, 1);
  assert.equal(cash(game, 1), 12000 - reserve - 200);
  assert.deepEqual(result.rejected.map((bid) => bid.error).sort(),
    [FIN_ERRORS.FORMER_OWNER, FIN_ERRORS.INSUFFICIENT_FUNDS].sort());
});

test('redevelopment contest fails cleanly when nobody can meet the reserve', () => {
  const game = withRuins();
  const block = getBlock(game.board, 2, 2);
  const reserve = quoteAcquire(game, block.id, ACQUIRE_MODES.RESTORE).cost;
  getPlayer(game, 3).cash = reserve - 1;
  const before = snap(game);
  const result = resolveRedevelopmentAuction(game, block.id, ACQUIRE_MODES.RESTORE, [
    { seat: 2, bid: reserve },
    { seat: 3, bid: reserve },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.error, FIN_ERRORS.INSUFFICIENT_FUNDS);
  assert.equal(snap(game), before);
});

test('another player can restore a ruin: land + 40% of invested', () => {
  const game = withRuins();
  assert.equal(currentPlayer(game).seat, 3);
  const b = getBlock(game.board, 2, 2);
  const q = quoteAcquire(game, 'r2c2', ACQUIRE_MODES.RESTORE);
  assert.equal(q.land, Math.round(b.price * FIN.REDEVELOP_LAND_PERCENT / 100));
  assert.equal(q.restore, Math.round(1000 * FIN.RESTORE_PERCENT / 100));
  assert.equal(q.cost, q.land + q.restore);

  const before = cash(game, 3);
  const r = acquireAbandoned(game, 'r2c2', ACQUIRE_MODES.RESTORE);
  assert.equal(r.ok, true);
  assert.deepEqual([b.ownerSeat, b.abandoned, b.abandonedBy, b.type, b.level], [3, false, null, 'residential', 1]);
  assert.equal(cash(game, 3), before - q.cost);
  assert.equal(b.income, 300, 'restored block earns again');
  assert.ok(calculateIncome(game.board, 3) >= 300 + TABLE.park[1].income);
  assert.deepEqual(game.ledger.at(-1), { seat: 3, delta: -q.cost, balance: before - q.cost, reason: TXN.ACQUIRE, round: game.round, block: 'r2c2', mode: 'restore' });
  assert.deepEqual(ownershipProblems(game), []);
});

test('rebuild clears the ruin to Vacant for the land price; then build anything', () => {
  const game = withRuins();
  const q = quoteAcquire(game, 'r2c3', ACQUIRE_MODES.REBUILD);
  assert.equal(q.restore, 0);
  assert.equal(acquireAbandoned(game, 'r2c3', ACQUIRE_MODES.REBUILD).ok, true);
  const b = getBlock(game.board, 2, 3);
  assert.deepEqual([b.ownerSeat, b.type, b.level, b.value], [3, 'vacant', 0, b.price]);
  assert.equal(buildOnBlock(game, 'r2c3', 'commercial').error, DEV_ERRORS.NO_ACTIONS, 'the purchase was this turn\'s action');
  game.city.actionsLeft = 1; // its next Manage City
  assert.equal(buildOnBlock(game, 'r2c3', 'commercial').ok, true);
});

test('acquisition guards: former owner, not abandoned, funds, mode, distress', () => {
  const game = withRuins();
  assert.equal(quoteAcquire(game, 'r1c2', 'restore').error, FIN_ERRORS.NOT_ABANDONED);
  assert.equal(quoteAcquire(game, 'r2c2', 'burn').error, FIN_ERRORS.BAD_MODE);
  assert.equal(quoteAcquire(game, 'r5c5', 'restore').error, FIN_ERRORS.NOT_DEVELOPED, 'vacant ruins can only be rebuilt');
  assert.equal(quoteAcquire(game, 'r5c5', 'rebuild').ok, true);

  getPlayer(game, 3).cash = 100;
  const q = quoteAcquire(game, 'r2c2', 'restore');
  assert.equal(q.error, FIN_ERRORS.INSUFFICIENT_FUNDS);
  assert.equal(q.shortfall, q.cost - 100);
  const before = snap(game);
  assert.equal(acquireAbandoned(game, 'r2c2', 'restore').ok, false);
  assert.equal(snap(game), before);

  getPlayer(game, 3).cash = -1;
  assert.equal(quoteAcquire(game, 'r2c2', 'rebuild').error, FIN_ERRORS.IN_DISTRESS);

  // The bankrupt player can't buy their own ruins back.
  const g = p2Insolvent();
  declareBankruptcy(g);
  assert.equal(quoteAcquire(g, 'r2c2', 'rebuild').error, FIN_ERRORS.FORMER_OWNER);
});

test('roads never capture ruins, and the game still ends once every road is paved', () => {
  const game = p2Insolvent();
  // Enclose P2's blocks first so they're "captured" state, then bankrupt.
  declareBankruptcy(game);
  const remaining = allRoadIds(game.board).filter((id) => !(id in game.board.roads));
  let guard = 0;
  while (game.era === ERAS.EXPANSION) {
    const me = currentPlayer(game);
    if (me.cash < 0) { me.cash = 0; } // not under test here
    const r = placeRoad(game, remaining.shift());
    assert.equal(r.ok, true);
    for (const id of r.captured) assert.equal(getBlockById(game.board, id).abandoned, false, 'ruins never captured');
    assert.ok(++guard <= 84);
  }
  playOutCity(game);
  assert.equal(game.phase, PHASES.ENDED);
  const ruins = game.board.blocks.filter((b) => b.abandoned);
  assert.equal(ruins.length, 4, 'nobody bought them');
  assert.ok(ruins.every((b) => b.ownerSeat == null));
  assert.equal(standings(game).reduce((n, r) => n + r.blocks, 0), 36 - 4);
});

/* ---------------- fuzz: no loops, no orphans ---------------- */

test('harsh random games always terminate with consistent ownership and ledgers', () => {
  const harsh = ['fire', 'heavy-rain', 'power-outage', 'snowstorm', 'recession'].map(getEventDef);
  const types = ['residential', 'commercial', 'park', 'civic', 'industrial', 'landmark'];
  let bankruptcies = 0;
  let distressSeen = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const game = createGame({ seats: seats(), seed, eventPool: harsh });
    const pool = allRoadIds(game.board);
    let r = seed;
    const rand = () => ((r = (r * 16807) % 2147483647) / 2147483647);
    let steps = 0;
    while (game.phase === PHASES.PLAYING) {
      assert.ok(++steps < 2000, `seed ${seed}: runaway loop`);
      while (game.era === ERAS.CITY && game.turnPhase === TURN_PHASES.CAPTURE_DEVELOP) resolveCapture(game);
      const me = currentPlayer(game);
      // Occasional shock bill (through the real mandatory-charge path) to exercise distress.
      if (me.cash >= 0 && rand() < 0.08) charge(game, me, Math.floor(rand() * 20000), TXN.UPKEEP);
      if (me.cash < 0) {
        distressSeen++;
        const st = distressStatus(game, me);
        if (st.canDeclare) {
          assert.equal(declareBankruptcy(game).ok, true);
          bankruptcies++;
          assert.ok(me.cash >= 0);
        } else {
          const sellable = game.board.blocks.find((b) => b.ownerSeat === me.seat && b.level > 0);
          assert.equal(sellDevelopment(game, sellable.id).ok, true);
        }
        continue;
      }
      // Over-expand: often leave land idle, sink cash into upgrades, grab ruins.
      for (const b of game.board.blocks) {
        if (b.ownerSeat === me.seat && b.level === 0 && rand() < 0.15) buildOnBlock(game, b.id, types[Math.floor(rand() * 6)]);
        if (b.ownerSeat === me.seat && b.level > 0) upgradeBlock(game, b.id);
        if (b.abandoned && rand() < 0.5) acquireAbandoned(game, b.id, rand() < 0.5 ? 'restore' : 'rebuild');
      }
      if (game.era === ERAS.CITY) {
        assert.equal(endCityTurn(game).ok, true);
      } else {
        const [id] = pool.splice(Math.floor(rand() * pool.length), 1);
        assert.equal(placeRoad(game, id).ok, true);
      }
      assert.deepEqual(ownershipProblems(game), []);
      for (const p of game.players) assert.ok(Number.isSafeInteger(p.cash));
    }
    for (const p of game.players) {
      const sum = game.ledger.filter((e) => e.seat === p.seat).reduce((n, e) => n + e.delta, 0);
      assert.equal(p.cash, ECONOMY.STARTING_CASH + sum, `seed ${seed}: ledger reconciles`);
    }
  }
  assert.ok(distressSeen > 20, `the fuzz exercised distress (${distressSeen})`);
  assert.ok(bankruptcies > 0, 'the fuzz actually exercised bankruptcy');
});
