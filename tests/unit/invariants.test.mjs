/**
 * V1 hardening fuzz: thousands of random but legal-ish actions (paving, building,
 * upgrading, selling, bankruptcy, buying ruins, bad inputs) across many seeds,
 * with every event active. After EVERY step we re-derive the rules from scratch
 * and compare them with the stored state.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ECONOMY } from '../../js/config.js';
import { allRoadIds, roadBlocks, isBlockEnclosed, blocksOwnedBy, builtSides } from '../../js/core/board.js';
import { TABLE, buildOnBlock, upgradeBlock, isDeveloped } from '../../js/core/development.js';
import { computeBonuses, computeProtection } from '../../js/core/bonuses.js';
import { CATEGORY_ORDER } from '../../js/core/buildings.js';
import { effectiveIncome } from '../../js/core/events.js';
import { TXN } from '../../js/core/economy.js';
import { createGame, placeRoad, currentPlayer, PHASES, MOVE_ERRORS } from '../../js/core/game.js';
import {
  distressStatus, declareBankruptcy, sellDevelopment, downgradeBlock, acquireAbandoned, ownershipProblems,
} from '../../js/core/finance.js';
import { computeResults } from '../../js/core/scoring.js';

function checkInvariants(game, ctx) {
  const where = `seed ${ctx.seed} step ${ctx.step}`;
  const { board } = game;
  const seats = game.players.map((p) => p.seat);

  // Money: whole dollars; ledger reconciles exactly.
  for (const p of game.players) {
    assert.ok(Number.isSafeInteger(p.cash), `${where}: cash ${p.cash}`);
    const sum = game.ledger.filter((e) => e.seat === p.seat).reduce((n, e) => n + e.delta, 0);
    assert.equal(p.cash, ECONOMY.STARTING_CASH + sum, `${where}: ledger seat ${p.seat}`);
  }
  // During play only the current player can be in debt. Final settlement may
  // charge several not-yet-settled players immediately before scoring.
  if (game.phase === PHASES.PLAYING) {
    for (const p of game.players) if (p !== currentPlayer(game)) assert.ok(p.cash >= 0, `${where}: seat ${p.seat} in debt off-turn`);
  }

  // Ownership.
  assert.deepEqual(ownershipProblems(game), [], where);
  for (const b of board.blocks) {
    if (b.ownerSeat != null || b.abandoned) assert.ok(isBlockEnclosed(board, b), `${where}: ${b.id} owned but not enclosed`);
    if (b.ownerSeat == null && !b.abandoned) assert.equal(b.level, 0, `${where}: unowned ${b.id} developed`);
    // Stored development numbers match the tables.
    const listInvestment = b.level > 0 ? TABLE[b.type][b.level].invested : 0;
    assert.equal(b.marketValue, b.price + listInvestment, `${where}: ${b.id} market value`);
    assert.equal(b.investedCostBasis, b.constructionCosts.reduce((sum, cost) => sum + cost, 0), `${where}: ${b.id} cost basis`);
    assert.equal(b.value, b.price + b.investedCostBasis, `${where}: ${b.id} scoring value`);
    assert.equal(b.income, b.level > 0 ? TABLE[b.type][b.level].income : 0, `${where}: ${b.id} income`);
    if (b.level === 0) assert.equal(b.type, 'vacant');
    else assert.ok(CATEGORY_ORDER.includes(b.type));
  }
  // Every enclosed, non-abandoned block has an owner (captures never missed).
  for (const b of board.blocks) if (isBlockEnclosed(board, b) && !b.abandoned) assert.notEqual(b.ownerSeat, null, `${where}: ${b.id} enclosed but unclaimed`);

  // Bonuses/protection stored on blocks are never stale.
  const fresh = computeBonuses(board);
  const prot = computeProtection(board);
  for (const b of board.blocks) {
    assert.deepEqual(b.bonuses, fresh.get(b.id), `${where}: stale bonuses on ${b.id}`);
    assert.deepEqual(b.protectedBy, prot.get(b.id), `${where}: stale protection on ${b.id}`);
  }

  // Events: only live, unique, known.
  const ids = game.events.active.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, `${where}: duplicate events`);
  for (const e of game.events.active) assert.ok(e.startRound <= game.round && game.round <= e.endRound, `${where}: stale event`);

  // Turn pointer.
  assert.ok(game.turnIndex >= 0 && game.turnIndex < game.players.length);
  assert.ok(seats.includes(currentPlayer(game).seat));
  for (const p of game.players) assert.ok(Number.isSafeInteger(effectiveIncome(game, p.seat)));
}

function playFuzz(seed, nPlayers) {
  const game = createGame({ seats: Array.from({ length: nPlayers }, (_, i) => ({ seat: i + 1 })), seed });
  let r = seed * 7919;
  const rand = () => ((r = (r * 16807) % 2147483647) / 2147483647);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const ctx = { seed, step: 0 };
  let captures = 0, chains = 0, bankruptcies = 0, rotations = 0;

  while (game.phase === PHASES.PLAYING) {
    ctx.step++;
    assert.ok(ctx.step < 5000, `seed ${seed}: runaway`);
    const me = currentPlayer(game);
    const mine = blocksOwnedBy(game.board, me.seat);

    if (me.cash < 0) {
      // Distress: paving is refused until resolved.
      const free = allRoadIds(game.board).find((id) => !(id in game.board.roads));
      assert.deepEqual(placeRoad(game, free), { ok: false, error: MOVE_ERRORS.IN_DISTRESS });
      const st = distressStatus(game, me);
      if (st.canDeclare) {
        assert.equal(declareBankruptcy(game).ok, true);
        bankruptcies++;
        assert.equal(blocksOwnedBy(game.board, me.seat).length, 0);
      } else {
        const dev = mine.filter(isDeveloped);
        const res = rand() < 0.5 ? downgradeBlock(game, pick(dev).id) : sellDevelopment(game, pick(dev).id);
        assert.equal(res.ok, true);
      }
      checkInvariants(game, ctx);
      continue;
    }

    // Random side actions (may legitimately fail; must never corrupt state).
    const roll = rand();
    if (roll < 0.25 && mine.length) buildOnBlock(game, pick(mine).id, pick(CATEGORY_ORDER));
    else if (roll < 0.4 && mine.length) upgradeBlock(game, pick(mine).id);
    else if (roll < 0.45 && mine.length) sellDevelopment(game, pick(mine).id);
    else if (roll < 0.55) {
      const ruin = game.board.blocks.filter((b) => b.abandoned);
      if (ruin.length) acquireAbandoned(game, pick(ruin).id, rand() < 0.5 ? 'restore' : 'rebuild');
    } else if (roll < 0.6) {
      // Garbage input never throws or changes anything.
      const before = JSON.stringify(game);
      for (const bad of ['', 'x-1-1', 'h-99-0', '__proto__', null, undefined, 'v--1-0']) {
        assert.equal(placeRoad(game, bad).ok, false);
        assert.equal(buildOnBlock(game, bad, 'park').ok, false);
      }
      assert.equal(JSON.stringify(game), before, `seed ${seed}: bad input mutated state`);
    } else if (roll < 0.62) {
      // Shock bill via the mandatory-charge path, to force distress/bankruptcy sometimes.
      game.ledger.push({ seat: me.seat, delta: -(15000 + Math.floor(rand() * 20000)), balance: 0, reason: TXN.UPKEEP, round: game.round });
      me.cash += game.ledger.at(-1).delta;
      game.ledger.at(-1).balance = me.cash;
      checkInvariants(game, ctx);
      continue;
    }
    checkInvariants(game, ctx);

    // Pave: prefer a road that completes a box sometimes, to exercise chains.
    const free = allRoadIds(game.board).filter((id) => !(id in game.board.roads));
    const closing = free.filter((id) => roadBlocks(game.board, id)
      .some((b) => b.ownerSeat == null && !b.abandoned && builtSides(game.board, b) === 3));
    const id = closing.length && rand() < 0.7 ? pick(closing) : pick(free);
    const seatBefore = me.seat;
    const idxBefore = game.turnIndex;
    const res = placeRoad(game, id);
    assert.equal(res.ok, true);
    if (res.captured.length) {
      captures += res.captured.length;
      if (!res.gameEnded) {
        assert.equal(currentPlayer(game).seat, seatBefore, 'capture grants another road');
        chains++;
      }
      assert.equal(res.reward, res.captured.length * ECONOMY.CAPTURE_REWARD);
    } else if (!res.gameEnded) {
      assert.equal(game.turnIndex, (idxBefore + 1) % game.players.length, 'rotation to next seat');
      rotations++;
    }
    checkInvariants(game, ctx);
  }

  // Endgame.
  assert.equal(Object.keys(game.board.roads).length, allRoadIds(game.board).length);
  const results = computeResults(game);
  assert.deepEqual(game.results, results, 'frozen results match a fresh computation at the end');
  for (const row of game.results.rows) assert.equal(row.cityValue, row.scoredCash + row.scoredLand + row.scoredBuildings);
  return { captures, chains, bankruptcies, rotations };
}


test('fuzz: every rule holds after every step (2–4 players, events on)', () => {
  const totals = { captures: 0, chains: 0, bankruptcies: 0, rotations: 0 };
  for (let seed = 1; seed <= 45; seed++) {
    const s = playFuzz(seed, 2 + (seed % 3));
    for (const k of Object.keys(totals)) totals[k] += s[k];
  }
  // Make sure the fuzz really exercised the systems.
  assert.ok(totals.chains > 200, `chains ${totals.chains}`);
  assert.ok(totals.bankruptcies > 5, `bankruptcies ${totals.bankruptcies}`);
  assert.ok(totals.rotations > 1000, `rotations ${totals.rotations}`);
});
