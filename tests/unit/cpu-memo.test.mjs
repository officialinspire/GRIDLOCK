import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createGame, placeRoad, currentPlayer, PHASES, TURN_PHASES } from '../../js/core/game.js';
import { chooseRoad } from '../../js/core/cpu/roads.js';
import { chooseCityAction, applyCityAction, evaluatePurchases, cpuBids } from '../../js/core/cpu/city.js';
import { forecastDevelopment } from '../../js/core/forecast.js';
import { blocksOwnedBy } from '../../js/core/board.js';
import { PERSONALITIES } from '../../js/core/seats.js';
import { withMemo, remember, setPlannerOptimizations } from '../../js/core/memo.js';

test('the memo keeps one value per owner and key for one decision only', () => {
  const owner = {};
  let n = 0;
  const next = () => ++n;
  assert.equal(remember(owner, 'k', next), 1);
  assert.equal(remember(owner, 'k', next), 2, 'outside a decision: computed every time');
  withMemo(() => {
    assert.equal(remember(owner, 'k', next), 3);
    assert.equal(remember(owner, 'k', next), 3, 'remembered within the decision');
    assert.equal(remember({}, 'k', next), 4, 'another owner (another game state) is separate');
    assert.equal(remember(owner, 'j', next), 5, 'another key is separate');
    withMemo(() => assert.equal(remember(owner, 'k', next), 3, 'a nested entry point belongs to the same decision'));
  });
  withMemo(() => assert.equal(remember(owner, 'k', next), 6, 'the next decision starts empty'));
  assert.throws(() => withMemo(() => { remember(owner, 'k', next); throw new Error('boom'); }), /boom/);
  assert.equal(remember(owner, 'k', next), 8, 'a decision that threw leaves nothing behind');
});

/** A CPU decision as the optimized planner makes it (memo, shortcuts) and as the plain one does. */
function decideBothWays(fn) {
  const memoized = fn();
  setPlannerOptimizations(false);
  try {
    return { memoized, plain: fn() };
  } finally {
    setPlannerOptimizations(true);
  }
}

/** Freezes every object reachable from `value`: in strict-mode code, any write to it throws. */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

// Easy/Normal/Hard, all four personalities, events on, and a debt shock that drives distress,
// bankruptcy and redevelopment auctions (whose bids re-value the same lot within one decision).
const TABLES = [
  { mode: 'standard', seed: 31, seats: PERSONALITIES.map((personality) => ({ difficulty: 'hard', personality })) },
  { mode: 'chaos', seed: 32, seats: [{ difficulty: 'easy' }, { difficulty: 'normal' }, { difficulty: 'hard' }] },
  { mode: 'standard', seed: 33, seats: [{ difficulty: 'normal' }, { difficulty: 'hard' }], shock: { seat: 1, round: 6, debt: 6000 } },
];

// Plain = no memo, no shortcuts and full structuredClone simulations; optimized = slim shared copies.
// Every decision is also made on a deep-frozen copy of the game: a simulation that wrote through a
// shared part (roads, events, a block's arrays, the city) would throw.
test('optimized CPU decisions are exactly the plain planner\'s, and never write to the game', () => {
  for (const { mode, seed, seats, shock } of TABLES) {
    const game = createGame({
      mode, seed,
      seats: seats.map((s, i) => ({ seat: i + 1, controller: 'cpu', difficulty: s.difficulty, personality: s.personality ?? null })),
    });
    let decisions = 0;
    let auctions = 0;
    let shocked = false;
    for (let step = 0; game.phase === PHASES.PLAYING; step++) {
      assert.ok(step < 5000, `${mode}/${seed}: runaway game`);
      if (shock && !shocked && game.round >= shock.round && game.turnPhase === TURN_PHASES.MANAGE_CITY && currentPlayer(game).seat === shock.seat) {
        currentPlayer(game).cash = -shock.debt;
        shocked = true;
      }
      if (game.turnPhase === TURN_PHASES.PAVE_ROAD || game.turnPhase === TURN_PHASES.BONUS_ROAD) {
        const d = chooseRoad(game);
        if (d.road) placeRoad(game, d.road);
        continue;
      }
      const { memoized, plain } = decideBothWays(() => chooseCityAction(game));
      assert.deepEqual(memoized, plain, `${mode}/${seed} step ${step}: same decision`);
      const frozen = deepFreeze(structuredClone(game));
      assert.deepEqual(chooseCityAction(frozen), memoized, `${mode}/${seed} step ${step}: decided without writing to the game`);
      decisions++;
      if (decisions % 5 === 0) {
        const judged = decideBothWays(() => evaluatePurchases(game));
        assert.deepEqual(judged.memoized, judged.plain, `${mode}/${seed} step ${step}: same purchase evaluation`);
        assert.deepEqual(evaluatePurchases(frozen), judged.memoized, `${mode}/${seed} step ${step}: evaluated without writing`);
        // A Build-panel forecast on the whole game (history included), outside any decision.
        const block = blocksOwnedBy(game.board, currentPlayer(game).seat).find((b) => b.level < 3 && !b.abandoned);
        if (block) {
          const type = block.level === 0 ? 'park' : undefined;
          const f = decideBothWays(() => forecastDevelopment(game, block.id, type));
          assert.deepEqual(f.memoized, f.plain, `${mode}/${seed} step ${step}: same forecast`);
          assert.deepEqual(forecastDevelopment(frozen, block.id, type), f.memoized, `${mode}/${seed} step ${step}: forecast without writing`);
        }
      }
      if (memoized.action === 'redevelop') {
        auctions++;
        const bids = decideBothWays(() => cpuBids(game, memoized.blockId, memoized.mode));
        assert.deepEqual(bids.memoized, bids.plain, `${mode}/${seed} step ${step}: same sealed bids`);
        assert.deepEqual(cpuBids(frozen, memoized.blockId, memoized.mode), bids.memoized, `${mode}/${seed} step ${step}: bids without writing`);
      }
      if (memoized.action) applyCityAction(game, memoized);
    }
    assert.ok(decisions > 50, `${mode}/${seed}: ${decisions} city decisions checked`);
    if (shock) assert.ok(auctions > 0 || game.players.some((p) => p.bankruptcies > 0), 'the debt shock reached distress');
  }
});
