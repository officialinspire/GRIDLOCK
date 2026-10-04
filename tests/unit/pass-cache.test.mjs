import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readPass, readCached } from '../../js/core/passCache.js';
import { createGame, placeRoad, currentPlayer, playerStats, PHASES, TURN_PHASES } from '../../js/core/game.js';
import { chooseRoad } from '../../js/core/cpu/roads.js';
import { chooseCityAction, applyCityAction } from '../../js/core/cpu/city.js';
import { blockImpacts, startEvent } from '../../js/core/events.js';
import { scorePlayer } from '../../js/core/scoring.js';
import { blockDetails } from '../../js/core/forecast.js';
import { influenceMap, takeoverCandidates, quoteTakeover } from '../../js/core/takeover.js';
import { buildOnBlock } from '../../js/core/development.js';
import { applyDevelopment } from '../../js/core/development.js';

const twoSeats = (seed = 7) => createGame({ seed, seats: [{ seat: 1 }, { seat: 2 }] });

test('a pass computes each reading once; outside one, and for other objects, it always computes', () => {
  const game = twoSeats();
  const other = twoSeats();
  let n = 0;
  const next = () => ++n;
  assert.equal(readCached(game, 'k', next), 1);
  assert.equal(readCached(game, 'k', next), 2, 'no pass: computed every time');
  readPass(game, () => {
    assert.equal(readCached(game, 'k', next), 3);
    assert.equal(readCached(game, 'k', next), 3, 'remembered within the pass');
    assert.equal(readCached(game, 'j', next), 4, 'another key');
    assert.equal(readCached(other, 'k', next), 5, 'another game (a copy, a simulation) is never cached');
    assert.equal(readCached(other, 'k', next), 6);
    readPass(game, () => assert.equal(readCached(game, 'k', next), 3, 'a nested pass is the same pass'));
  });
  readPass(game, () => assert.equal(readCached(game, 'k', next), 7, 'the next pass starts empty'));
  assert.throws(() => readPass(game, () => { readCached(game, 'k', next); throw new Error('boom'); }), /boom/);
  assert.equal(readCached(game, 'k', next), 9, 'a pass that threw leaves nothing behind');
});

test('real readings are shared within a pass and equal a fresh computation', () => {
  const game = twoSeats();
  const me = currentPlayer(game);
  readPass(game, () => {
    const stats = playerStats(game, me);
    assert.equal(playerStats(game, me), stats, 'same object: computed once');
    assert.equal(scorePlayer(game, me), scorePlayer(game, me));
    assert.equal(influenceMap(game, 1), influenceMap(game, 1));
    assert.notEqual(scorePlayer(game, me, { exclude: 'r0c0' }), scorePlayer(game, me, { exclude: 'r0c0' }), 'excluded scores are not cached');
  });
  readPass(game, () => assert.deepEqual(playerStats(game, me), playerStats(structuredClone(game), structuredClone(me))));
});

test('an action taken during a pass changes the state version: nothing from before it is served', () => {
  const game = twoSeats(11);
  // Give seat 1 a block to develop, and the cash to do it.
  const block = game.board.blocks[0];
  block.ownerSeat = currentPlayer(game).seat;
  currentPlayer(game).cash = 50_000;
  readPass(game, () => {
    const before = playerStats(game, currentPlayer(game));
    const impactsBefore = blockImpacts(game, block);
    assert.equal(buildOnBlock(game, block.id, 'commercial').ok, true); // logs, debits, spends an action
    const after = playerStats(game, currentPlayer(game));
    assert.notEqual(after, before, 'recomputed after the build');
    assert.ok(after.cash < before.cash, 'the price was paid');
    assert.equal(after.cash, currentPlayer(game).cash);
    assert.ok(after.income > before.income, 'the new building pays');
    // An event that now hits the developed block: the version moves (events.nextUid), impacts are fresh.
    assert.equal(impactsBefore.length, 0);
    startEvent(game, 'recession');
    assert.ok(blockImpacts(game, block).length > 0, 'the recession hits the new building');
    assert.deepEqual(blockImpacts(game, block), blockImpacts(structuredClone(game), structuredClone(block)));
  });
});

test('a direct edit between passes (tests, debugging) is always read afresh by the next pass', () => {
  const game = twoSeats(13);
  const block = game.board.blocks[7];
  block.ownerSeat = 2;
  applyDevelopment(block, 'residential', 1);
  readPass(game, () => assert.deepEqual(influenceMap(game, 1).shielded, []));
  block.shieldedUntil = game.round; // no action, no version change
  readPass(game, () => assert.deepEqual(influenceMap(game, 1).shielded, [block.id], 'the shield is seen'));
  currentPlayer(game).cash = 123; // no ledger entry
  readPass(game, () => assert.equal(playerStats(game, currentPlayer(game)).cash, 123));
});

/** Every cached reading for the game as it is now. */
function readings(game) {
  const out = { stats: [], scores: [], influence: [], candidates: takeoverCandidates(game), impacts: [], details: [], quotes: [] };
  for (const p of game.players) {
    out.stats.push(playerStats(game, p));
    out.scores.push(scorePlayer(game, p));
    out.influence.push(influenceMap(game, p.seat));
  }
  for (const b of game.board.blocks) {
    out.impacts.push(blockImpacts(game, b));
    out.details.push(blockDetails(game, b.id));
    if (b.ownerSeat != null) out.quotes.push(quoteTakeover(game, b.id));
  }
  return out;
}

test('over whole CPU games, every pass reads exactly what a fresh computation does (no stale economy, events or takeovers)', () => {
  for (const [mode, seed, levels] of [['chaos', 41, ['hard', 'normal', 'hard', 'easy']], ['standard', 42, ['hard', 'hard']]]) {
    const game = createGame({ mode, seed, seats: levels.map((difficulty, i) => ({ seat: i + 1, controller: 'cpu', difficulty })) });
    let steps = 0;
    let city = false;
    while (game.phase === PHASES.PLAYING) {
      assert.ok(++steps < 5000, 'runaway');
      // Read twice inside one pass (the second time from the cache) and compare with a fresh copy.
      const [first, second] = readPass(game, () => [readings(game), readings(game)]);
      assert.deepEqual(second, first);
      if (steps % 3 === 0) assert.deepEqual(first, readings(structuredClone(game)), `${mode} step ${steps}: fresh`);
      if (game.turnPhase === TURN_PHASES.PAVE_ROAD || game.turnPhase === TURN_PHASES.BONUS_ROAD) {
        const d = chooseRoad(game);
        if (d.road) placeRoad(game, d.road);
      } else {
        const d = chooseCityAction(game);
        if (d.action) applyCityAction(game, d);
      }
      city ||= game.era === 'city';
    }
    assert.ok(city, `${mode}: reached the City era (takeovers possible)`);
  }
});
