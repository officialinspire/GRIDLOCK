import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateCpu, playCpuGame, tableFor, TABLES } from '../../tools/cpu-simulate.mjs';
import { ownershipProblems } from '../../js/core/finance.js';

// Small, deterministic sweeps of real all-CPU games (the full report: npm run simulate:cpu).

test('the CPU simulator is deterministic and every game is legal, finished and stall-free', () => {
  const tables = ['three-way', 'debt-shock', 'all-normal-4p'];
  const a = simulateCpu({ games: 12, seed: 5, tables });
  assert.deepEqual(simulateCpu({ games: 12, seed: 5, tables }).standard.byDifficulty, a.standard.byDifficulty, 'same arguments, same games');
  const r = a.standard.robustness;
  assert.equal(r.illegal, 0, `illegal CPU decisions: ${JSON.stringify(r.illegalSamples)}`);
  assert.equal(r.stalls, 0, `stalls: ${JSON.stringify(r.stallSamples)}`);
  assert.equal(r.unfinished, 0);
  assert.ok(r.decisions > 1000);
});

test('each table cycles through every seating order', () => {
  for (const [id, plan] of Object.entries(TABLES)) {
    const ids = [id];
    const seen = new Set(Array.from({ length: plan.length }, (_, i) => JSON.stringify(tableFor(i, ids).seats)));
    assert.equal(seen.size, plan.length, id);
  }
  assert.equal(TABLES['three-way'].length, 6);
  assert.equal(TABLES['normal-v-hard-4p'].length, 6);
});

test('a debt shock drives the bots through distress, bankruptcy and redevelopment, legally', () => {
  let bankrupt = 0;
  let auctions = 0;
  for (let i = 0; i < 6; i++) {
    const run = playCpuGame({ seed: 70 + i, seats: [{ difficulty: 'normal' }, { difficulty: 'hard' }, { difficulty: 'easy' }],
      shock: { seat: 1, round: 14, debt: 12000 } });
    assert.deepEqual([run.illegal, run.stalls], [[], []]);
    assert.equal(run.game.phase, 'ended');
    assert.deepEqual(ownershipProblems(run.game), []);
    bankrupt += run.game.log.filter((e) => e.type === 'bankruptcy').length;
    auctions += run.auctionsOpened.length;
  }
  assert.ok(bankrupt > 0, 'someone goes bankrupt');
  assert.ok(auctions > 0, 'abandoned land gets redeveloped');
});

test('a stalled game is reported, not looped forever', () => {
  const run = playCpuGame({ seed: 1, seats: [{ difficulty: 'normal' }, { difficulty: 'normal' }], maxSteps: 10 });
  assert.equal(run.stalls[0].kind, 'runaway');
  assert.equal(run.decisions, 10);
});
