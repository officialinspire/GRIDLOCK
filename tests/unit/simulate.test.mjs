import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulate, playGame, tableFor } from '../../tools/simulate.mjs';
import { ECONOMY } from '../../js/config.js';
import { ownershipProblems } from '../../js/core/finance.js';
import { totalRoads } from '../../js/core/board.js';
import { MODE_IDS } from '../../js/core/modes.js';

test('the balance simulator is deterministic', () => {
  const a = simulate({ games: 24, seed: 7 });
  const b = simulate({ games: 24, seed: 7 });
  assert.deepEqual(a, b, 'same arguments, same report');
  assert.notDeepEqual(simulate({ games: 24, seed: 8 }), a, 'a different seed plays different games');
  for (const mode of MODE_IDS) {
    assert.equal(a[mode].games, 24);
    assert.ok(a[mode].rounds.mean > 0);
  }
});

test('every simulated game is a legal, complete game (all mayor types, all presets)', () => {
  let checked = 0;
  for (const mode of MODE_IDS) {
    for (let i = 0; i < 20; i++) {
      const personas = tableFor(i);
      const game = playGame({ seed: 100 + i, mode, personas });
      const where = `${mode} game ${i} (${personas.join(', ')})`;
      assert.equal(game.phase, 'ended', where);
      assert.equal(Object.keys(game.board.roads).length, totalRoads(game.board), `${where}: every road paved`);
      assert.deepEqual(ownershipProblems(game), [], `${where}: ownership consistent`);
      for (const p of game.players) {
        const sum = game.ledger.filter((e) => e.seat === p.seat).reduce((n, e) => n + e.delta, 0);
        assert.equal(p.cash, ECONOMY.STARTING_CASH + sum, `${where}: seat ${p.seat} ledger reconciles`);
        assert.ok(Number.isSafeInteger(p.cash), where);
      }
      if (mode === 'classic') assert.equal(game.events.history.length, 0, `${where}: no events in Classic`);
      checked++;
    }
  }
  assert.equal(checked, 60);
});

test('seating cycles through every order, so no mayor type owns a seat', () => {
  const seen = new Map();
  for (let i = 0; i < 240; i++) {
    const table = tableFor(i);
    const key = [...table].sort().join('+');
    if (!seen.has(key)) seen.set(key, new Set());
    seen.get(key).add(table.join());
  }
  assert.equal(seen.get('casual+planner+saver').size, 6, 'all six orders of a three-way table');
  assert.equal(seen.get('planner+saver').size, 2);
});
