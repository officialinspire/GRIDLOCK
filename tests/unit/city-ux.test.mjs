/**
 * City-era UX polish: the CITY VIEW influence map, Net / turn, the new settings (City view, CPU
 * playback) and CPU playback pacing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CPU, DEFAULT_SETTINGS } from '../../js/config.js';
import { getBlock, allRoadIds } from '../../js/core/board.js';
import { applyDevelopment } from '../../js/core/development.js';
import { refreshBonuses } from '../../js/core/bonuses.js';
import { createGame, getPlayer, playerStats, enterCityEra } from '../../js/core/game.js';
import { influenceMap, takeoverBlock } from '../../js/core/takeover.js';
import { normalizeSettings } from '../../js/core/settings.js';
import { stepDelay } from '../../js/ui/cpuDriver.js';

function place(game, list) {
  for (const [row, col, seat, type = 'vacant', level = 0] of list) {
    const b = getBlock(game.board, row, col);
    b.ownerSeat = seat;
    applyDevelopment(b, type, level);
  }
  refreshBonuses(game.board);
  return game;
}

/** Two mayors in the CITY era: seat 1's shops press on seat 2's House (C3); D6 is a ruin. */
function city() {
  const game = createGame({ seats: [{ seat: 1 }, { seat: 2 }], seed: 3, eventPool: [] });
  for (const id of allRoadIds(game.board)) game.board.roads[id] = 1;
  enterCityEra(game);
  for (const p of game.players) p.cash = 50000;
  place(game, [[2, 2, 2, 'residential', 1], [2, 3, 1, 'commercial', 2], [1, 2, 1, 'commercial', 1], [5, 3, 2, 'park', 1]]);
  Object.assign(getBlock(game.board, 5, 3), { ownerSeat: null, abandoned: true, abandonedBy: 2 });
  refreshBonuses(game.board);
  return game;
}

/* ---------------- CITY VIEW ---------------- */

test('the influence map: takeover targets, at-risk blocks, shields and ruins, from each mayor\'s side', () => {
  const game = city();
  assert.deepEqual(influenceMap(game, 1), { targets: ['r2c2'], atRisk: [], shielded: [], abandoned: ['r5c3'] });
  assert.deepEqual(influenceMap(game, 2), { targets: [], atRisk: ['r2c2'], shielded: [], abandoned: ['r5c3'] }, 'the same House, seen by its owner');
  assert.equal(takeoverBlock(game, 'r2c2').ok, true);
  const after = influenceMap(game, 1);
  assert.deepEqual([after.targets, after.shielded], [[], ['r2c2']], 'just taken: protected, not a target');
});

test('the influence map in EXPANSION: no takeovers yet, ruins still shown; it never changes the game', () => {
  const game = createGame({ seats: [{ seat: 1 }, { seat: 2 }], seed: 3, eventPool: [] });
  place(game, [[2, 2, 2, 'residential', 1], [2, 3, 1, 'commercial', 3]]);
  Object.assign(getBlock(game.board, 0, 0), { abandoned: true, abandonedBy: 2 });
  const before = JSON.stringify(game.board);
  assert.deepEqual(influenceMap(game, 1), { targets: [], atRisk: [], shielded: [], abandoned: ['r0c0'] });
  assert.equal(JSON.stringify(game.board), before);
});

/* ---------------- Net / turn ---------------- */

test('Net / turn is income minus upkeep, with the gross figures alongside', () => {
  const game = city();
  for (const seat of [1, 2]) {
    const s = playerStats(game, getPlayer(game, seat));
    assert.equal(s.net, s.income - s.upkeep);
  }
  const s1 = playerStats(game, getPlayer(game, 1));
  assert.ok(s1.income > 0 && s1.upkeep > 0 && s1.net < s1.income);
});

/* ---------------- settings ---------------- */

test('City view and CPU playback settings: off / full by default, unknown values ignored', () => {
  assert.deepEqual([DEFAULT_SETTINGS.cityView, DEFAULT_SETTINGS.cpuPlayback], [false, 'full']);
  assert.deepEqual([normalizeSettings({}).cityView, normalizeSettings({}).cpuPlayback], [false, 'full'], 'older saved settings');
  const s = normalizeSettings({ cityView: true, cpuPlayback: 'instant' });
  assert.deepEqual([s.cityView, s.cpuPlayback], [true, 'instant']);
  const bad = normalizeSettings({ cityView: 'yes', cpuPlayback: 'warp' });
  assert.deepEqual([bad.cityView, bad.cpuPlayback], [false, 'full']);
});

/* ---------------- CPU playback ---------------- */

test('CPU playback pacing: Full paces every step; Brief only major ones; Instant runs routine steps at once', () => {
  const routine = { text: 'Paving a road' };
  const major = { text: 'Claiming C3', major: true };
  for (const cpuSpeed of ['relaxed', 'normal', 'fast']) {
    const think = CPU.THINK_MS[cpuSpeed];
    assert.equal(stepDelay({ cpuSpeed, cpuPlayback: 'full' }, routine), think);
    assert.equal(stepDelay({ cpuSpeed, cpuPlayback: 'full' }, major), think);
    assert.equal(stepDelay({ cpuSpeed, cpuPlayback: 'brief' }, major), think);
    assert.equal(stepDelay({ cpuSpeed, cpuPlayback: 'brief' }, routine), CPU.PLAYBACK_ROUTINE_MS.brief);
    assert.equal(stepDelay({ cpuSpeed, cpuPlayback: 'instant' }, routine), 0);
    assert.equal(stepDelay({ cpuSpeed, cpuPlayback: 'instant' }, major), Math.min(think, CPU.THINK_MS.fast));
  }
  assert.ok(CPU.PLAYBACK_ROUTINE_MS.brief < CPU.THINK_MS.fast, 'Brief routine steps are quicker than any thinking pause');
  assert.equal(stepDelay({ cpuSpeed: 'normal' }, routine), CPU.THINK_MS.normal, 'settings saved before playback existed: Full');
});
