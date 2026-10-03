/**
 * Bankruptcy & recovery across both eras: bankruptcy disrupts, it never eliminates a mayor or
 * ends the match. Covers repeated bankruptcy, recovery state, ruins, redevelopment, takeover of
 * a redeveloped ruin and final scoring.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ECONOMY } from '../../js/config.js';
import { getBlock, getBlockById, allRoadIds } from '../../js/core/board.js';
import { applyDevelopment, buildOnBlock } from '../../js/core/development.js';
import { refreshBonuses } from '../../js/core/bonuses.js';
import { TXN, isInDistress, recoveryCapital, bankruptcyPenalty, charge, credit } from '../../js/core/economy.js';
import {
  createGame, currentPlayer, getPlayer, playerStats, placeRoad, enterCityEra, endCityTurn, PHASES, ERAS, TURN_PHASES,
} from '../../js/core/game.js';
import {
  declareBankruptcy, distressStatus, acquireAbandoned, eligibleRedevelopers, ownershipProblems, FIN_ERRORS,
} from '../../js/core/finance.js';
import { quoteTakeover, takeoverBlock, TAKEOVER_ERRORS } from '../../js/core/takeover.js';
import { saveActiveGame, loadActiveGame } from '../../js/core/persistence.js';
import { chooseCityAction, applyCityAction } from '../../js/core/cpu/city.js';
import { playOutCity } from './_city.mjs';

const FIN = ECONOMY.FINANCE;
const memoryStorage = () => {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
};

function place(game, list) {
  for (const [row, col, seat, type = 'vacant', level = 0] of list) {
    const b = getBlock(game.board, row, col);
    b.ownerSeat = seat;
    applyDevelopment(b, type, level);
  }
  refreshBonuses(game.board);
  return game;
}

/** Three mayors. `city`: every road paved and the CITY era under way at seat 1's turn. */
function table({ city = true, seats = [{ seat: 1 }, { seat: 2 }, { seat: 3 }] } = {}) {
  const game = createGame({ seats, seed: 11, eventPool: [] });
  if (city) {
    for (const id of allRoadIds(game.board)) game.board.roads[id] = 1;
    assert.equal(enterCityEra(game), true);
  }
  return game;
}

/** Seat 2 owns a Corner Store at C3 and three suburb lots; it will be deep in debt at its next turn. */
function doomedSeat2(game) {
  place(game, [[2, 2, 2, 'commercial', 1], [4, 0, 2], [4, 1, 2], [5, 5, 2]]);
  setCash(game, 2, -8000); // a crushing bill arrives before its turn
  return game;
}

/** Moves a player's cash to `target` through the ledger (a bill or a windfall), so books balance. */
function setCash(game, seat, target) {
  const p = getPlayer(game, seat);
  if (target < p.cash) charge(game, p, p.cash - target, TXN.UPKEEP);
  else credit(game, p, target - p.cash, TXN.SALE);
}

const ledgerReconciles = (game) => game.players.every((p) =>
  p.cash === ECONOMY.STARTING_CASH + game.ledger.filter((e) => e.seat === p.seat).reduce((n, e) => n + e.delta, 0));

/* ---------------- configuration ---------------- */

test('recovery capital shrinks but has a floor; the penalty grows with each bankruptcy', () => {
  assert.deepEqual([0, 1, 2, 3, 9].map(recoveryCapital), [2000, 1000, 500, 500, 500]);
  assert.ok(FIN.RECOVERY.MIN_CAPITAL > 0, 'never a permanent $0');
  assert.deepEqual([0, 1, 2, 3].map((n) => bankruptcyPenalty(n).cityValue), [0, 1000, 3000, 6000]);
  assert.deepEqual([0, 1, 2].map((n) => bankruptcyPenalty(n).prestige), [0, 2, 4]);
  assert.equal(FIN.FRESH_START_LIMIT, undefined, 'no hard exhaustion any more');
});

/* ---------------- EXPANSION ---------------- */

test('EXPANSION: a bankrupt mayor finishes the turn by paving and keeps getting turns', () => {
  const game = table({ city: false });
  place(game, [[0, 0, 2, 'residential', 1]]);
  placeRoad(game, 'h-6-0'); // seat 1 → seat 2
  const p2 = currentPlayer(game);
  assert.equal(p2.seat, 2);
  setCash(game, 2, -5000);
  assert.equal(placeRoad(game, 'h-6-1').error, 'in-distress');
  const r = declareBankruptcy(game);
  assert.equal(r.ok, true);
  assert.equal(p2.cash, FIN.RECOVERY.CAPITAL);
  assert.equal(game.turnPhase, TURN_PHASES.MANAGE_CITY, 'same turn, same phase');
  assert.equal(placeRoad(game, 'h-6-1').ok, true, 'paves as normal');
  assert.equal(currentPlayer(game).seat, 3);
  placeRoad(game, 'h-6-2'); // seat 3 → seat 1
  placeRoad(game, 'h-6-3'); // seat 1 → seat 2 again
  assert.equal(currentPlayer(game).seat, 2, 'the bankrupt mayor is still in the rotation');
  assert.equal(isInDistress(p2), false, 'no upkeep on nothing: no fall back into debt');
  assert.equal(game.phase, PHASES.PLAYING);
  assert.ok(ledgerReconciles(game));
});

/* ---------------- CITY ---------------- */

test('CITY: bankruptcy is free, the turn ends normally, and the mayor plays every later City turn', () => {
  const game = doomedSeat2(table());
  assert.ok(endCityTurn(game).ok);
  const p2 = currentPlayer(game);
  assert.equal(p2.seat, 2);
  assert.equal(endCityTurn(game).error, 'in-distress', 'debt first');
  const actions = game.city.actionsLeft;
  const r = declareBankruptcy(game);
  assert.equal(r.ok, true);
  assert.equal(game.city.actionsLeft, actions, 'bankruptcy costs no City Action');
  assert.equal(game.era, ERAS.CITY);
  assert.equal(game.phase, PHASES.PLAYING, 'never ends the match');
  const log = game.log.at(-1);
  assert.deepEqual([log.type, log.seat, log.era, log.count, log.capital, log.nextCapital], ['bankruptcy', 2, 'city', 1, 2000, 1000]);
  assert.deepEqual(log.penalty, bankruptcyPenalty(1));
  assert.deepEqual(log.abandoned.sort(), ['r2c2', 'r4c0', 'r4c1', 'r5c5']);
  // Recovery state is visible: HUD stats say so this round and next.
  const stats = playerStats(game, p2);
  assert.deepEqual([stats.recovering, stats.bankruptcyPenalty, stats.nextRecoveryCapital], [true, 1000, 1000]);
  assert.ok(endCityTurn(game).ok);

  const turns = [];
  playOutCity(game, { turn: (g) => turns.push(currentPlayer(g).seat) });
  assert.equal(game.phase, PHASES.ENDED);
  assert.equal(turns.filter((s) => s === 2).length, game.city.rounds, 'seat 2 played every City round');
  assert.equal(playerStats(game, p2).recovering, false, 'recovery wears off');
  const row = game.results.rows.find((x) => x.seat === 2);
  assert.equal(row.bankruptcyPenalty, 1000);
  assert.equal(row.cityValue, row.scoredCash + row.scoredLand + row.scoredBuildings + row.scoredPrestige - 1000);
  assert.ok(ledgerReconciles(game));
});

test('ruins stay visible, go dark, drop their repairs and shields, and only go to auction', () => {
  const game = doomedSeat2(table());
  const store = getBlock(game.board, 2, 2);
  store.shieldedUntil = game.round + 1; // pretend it was just taken over
  game.events.repairs.push({ uid: 1, eventId: 'fire', block: 'r2c2', seat: 2, amount: 400 });
  endCityTurn(game);
  declareBankruptcy(game);
  assert.deepEqual([store.type, store.level, store.abandoned, store.ownerSeat, store.shieldedUntil], ['commercial', 1, true, null, null]);
  assert.equal(store.prestige, 0);
  assert.equal(store.control, 0);
  assert.deepEqual(game.events.repairs, [], 'no repair bill left to restart the debt');
  assert.equal(quoteTakeover(game, 'r2c2').error, TAKEOVER_ERRORS.NOT_RIVAL, 'ruins are auctioned, not taken over');
  assert.deepEqual(eligibleRedevelopers(game, store).map((p) => p.seat), [1, 3], 'the former owner sits out');
  assert.equal(acquireAbandoned(game, 'r2c2', 'restore').error, FIN_ERRORS.FORMER_OWNER);
  assert.deepEqual(ownershipProblems(game), []);
});

test('repeated bankruptcy in the CITY era: always solvent again, never out of the game', () => {
  const game = table();
  const p2 = getPlayer(game, 2);
  const capitals = [];
  for (let round = 0; round < game.city.rounds; round++) {
    endCityTurn(game); // → seat 2
    assert.equal(currentPlayer(game).seat, 2);
    // Buy a lot back into the city, then get hit with a bill it can't cover.
    const lot = game.board.blocks.find((b) => b.ownerSeat == null && !b.abandoned);
    if (lot) place(game, [[lot.row, lot.col, 2]]);
    setCash(game, 2, -3000);
    assert.equal(distressStatus(game, p2).recoveryCapital, recoveryCapital(p2.bankruptcies));
    const r = declareBankruptcy(game);
    assert.equal(r.ok, true);
    capitals.push(r.capital);
    assert.ok(p2.cash > 0, 'never a $0 soft-lock');
    assert.ok(endCityTurn(game).ok);
    if (game.phase === PHASES.ENDED) break;
    endCityTurn(game); // seat 3 → seat 1
    if (game.phase === PHASES.ENDED) break;
  }
  assert.deepEqual(capitals, [2000, 1000, 500, 500].slice(0, capitals.length));
  assert.ok(capitals.length >= 3);
  if (game.phase === PHASES.PLAYING) playOutCity(game);
  const row = game.results.rows.find((x) => x.seat === 2);
  assert.equal(row.bankruptcyPenalty, bankruptcyPenalty(p2.bankruptcies).cityValue);
  assert.ok(ledgerReconciles(game));
});

/* ---------------- the full chain ---------------- */

test('bankruptcy → redevelopment → takeover → final scoring, all in one match', () => {
  const game = doomedSeat2(table());
  place(game, [[2, 3, 1, 'commercial', 3], [1, 2, 1, 'commercial', 3]]); // seat 1's towers beside C3
  for (const p of [1, 3]) setCash(game, p, 30000);
  assert.ok(endCityTurn(game).ok); // seat 1 → seat 2 (in debt)

  // 1. Bankruptcy: C3's Corner Store becomes a ruin.
  assert.equal(declareBankruptcy(game).ok, true);
  assert.ok(endCityTurn(game).ok); // → seat 3

  // 2. Redevelopment: seat 3 buys and restores the ruin (a City Action).
  const bought = acquireAbandoned(game, 'r2c2', 'restore');
  assert.equal(bought.ok, true);
  assert.equal(game.city.actionsLeft, game.city.actionsPerTurn - 1);
  const store = getBlockById(game.board, 'r2c2');
  assert.deepEqual([store.ownerSeat, store.abandoned, store.type, store.level], [3, false, 'commercial', 1]);
  assert.ok(endCityTurn(game).ok); // → seat 1, next round

  // 3. Takeover: seat 1's towers out-press seat 3's new store, but only once seat 3 has had
  //    its next turn (the redevelopment shield).
  assert.equal(quoteTakeover(game, 'r2c2').error, TAKEOVER_ERRORS.SHIELDED);
  for (let i = 0; i < 3; i++) assert.ok(endCityTurn(game).ok); // seats 1, 2 and 3 → seat 1
  const q = quoteTakeover(game, 'r2c2');
  assert.equal(q.ok, true, q.reason);
  const taken = takeoverBlock(game, 'r2c2');
  assert.equal(taken.ok, true);
  assert.equal(store.ownerSeat, 1);
  assert.deepEqual(game.ledger.filter((e) => e.reason === TXN.TAKEOVER).map((e) => e.seat), [1, 3]);

  // 4. Final scoring: the match plays out, everyone ranked, the penalty applied.
  playOutCity(game);
  assert.equal(game.phase, PHASES.ENDED);
  assert.equal(game.results.rows.length, 3, 'nobody eliminated');
  const kinds = game.log.map((e) => e.type);
  for (const k of ['bankruptcy', 'acquire', 'takeover', 'game-end']) assert.ok(kinds.includes(k), k);
  assert.ok(kinds.indexOf('bankruptcy') < kinds.indexOf('acquire') && kinds.indexOf('acquire') < kinds.indexOf('takeover'));
  const p2row = game.results.rows.find((x) => x.seat === 2);
  assert.equal(p2row.bankruptcies, 1);
  assert.equal(p2row.bankruptcyPenalty, bankruptcyPenalty(1).cityValue);
  assert.deepEqual(ownershipProblems(game), []);
  assert.ok(ledgerReconciles(game));
});

/* ---------------- CPU & saving ---------------- */

test('a CPU mayor in debt in the CITY era declares, then carries on and ends its turn', () => {
  const game = doomedSeat2(table({ seats: [{ seat: 1 }, { seat: 2, controller: 'cpu', difficulty: 'hard' }, { seat: 3 }] }));
  endCityTurn(game);
  const seen = [];
  for (let step = 0; step < 10 && currentPlayer(game).seat === 2; step++) {
    const d = chooseCityAction(game);
    seen.push(d.action);
    assert.equal(applyCityAction(game, d).ok, true, d.action);
  }
  assert.equal(seen[0], 'bankruptcy');
  assert.equal(seen.at(-1), 'end-turn');
  assert.equal(currentPlayer(game).seat, 3, 'the turn passed on');
});

test('recovery state survives autosave', () => {
  const game = doomedSeat2(table());
  endCityTurn(game);
  declareBankruptcy(game);
  const storage = memoryStorage();
  assert.equal(saveActiveGame(game, { seats: [{ seat: 1 }, { seat: 2 }, { seat: 3 }] }, storage), true);
  const back = loadActiveGame(storage).game;
  const p2 = getPlayer(back, 2);
  assert.deepEqual([p2.bankruptcies, p2.lastBankruptcyRound, p2.cash], [1, game.round, FIN.RECOVERY.CAPITAL]);
  assert.equal(playerStats(back, p2).recovering, true);
  assert.ok(endCityTurn(back).ok, 'the restored turn continues');
});

test('buying back into the city after bankruptcy works like for anyone', () => {
  const game = doomedSeat2(table());
  endCityTurn(game);
  declareBankruptcy(game);
  const p2 = currentPlayer(game);
  place(game, [[0, 0, 2]]); // a lot captured/bought later
  assert.equal(buildOnBlock(game, 'r0c0', 'park').ok, true, 'recovery capital is spendable at once');
  assert.equal(p2.cash, FIN.RECOVERY.CAPITAL - ECONOMY.DEVELOPMENT.CATEGORIES.park.cost);
});
