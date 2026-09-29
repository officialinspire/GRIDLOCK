import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GAME_MODES, DEFAULT_MODE, CITY_EVENTS, CITY_ERA } from '../../js/config.js';
import { MODE_IDS, resolveRules, modeName } from '../../js/core/modes.js';
import { saveActiveGame, loadActiveGame, SAVE_KEY } from '../../js/core/persistence.js';
import { playthrough, loadApi } from './_playthrough.mjs';

const api = await loadApi();
const { createGame } = api;
const seats = (n) => Array.from({ length: n }, (_, i) => ({ seat: i + 1 }));
const table = (n) => ({ seats: seats(n), gameType: n === 4 ? 'standard' : 'custom' });
const memoryStorage = () => {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
};

/**
 * Recorded with the same driver against the code before rule presets existed (V1.1,
 * commit 7cbd186): the round each city event started and the final City Values.
 * The driver only ever builds Residential, so these still hold after the V1.2 balance
 * pass (which changed Park, Civic and Landmark income only): the preset system itself
 * must not change a single roll or dollar. They were recorded before the CITY era existed, so
 * they replay with `cityRounds: 0` (the match ends on the final road). The City Values were
 * re-scored for the V1.4 formula (70% land, 100% buildings, Prestige); rolls and rounds are the
 * original recording.
 */
const V11_GOLDEN = [
  { seed: 2024, n: 4, rounds: 13, events: ['6:housing-boom', '7:snowstorm', '8:beautification-grant', '11:heavy-rain', '12:power-outage'],
    values: [[4, 31820], [1, 29060], [2, 22500], [3, 22500]] },
  { seed: 7, n: 3, rounds: 17, events: ['2:heavy-rain', '5:power-outage', '6:snowstorm', '7:beautification-grant', '8:heavy-rain', '10:snowstorm',
    '11:power-outage', '12:power-outage', '14:economic-boom', '15:heavy-rain', '16:fire'], values: [[3, 31860], [2, 31340], [1, 29700]] },
  { seed: 99, n: 2, rounds: 25, events: ['2:economic-boom', '3:beautification-grant', '4:economic-boom', '5:heavy-rain', '6:housing-boom',
    '7:heavy-rain', '8:beautification-grant', '9:snowstorm', '10:beautification-grant', '11:snowstorm', '12:beautification-grant',
    '13:beautification-grant', '15:snowstorm', '17:city-festival', '19:power-outage', '20:beautification-grant', '21:recession',
    '22:economic-boom', '23:housing-boom'], values: [[2, 47942], [1, 41576]] },
];

test('presets are plain configuration with a name and a one-line description', () => {
  assert.deepEqual(MODE_IDS, ['standard', 'classic', 'chaos']);
  assert.equal(DEFAULT_MODE, 'standard');
  for (const mode of Object.values(GAME_MODES)) {
    assert.ok(mode.name && mode.blurb.length > 20 && mode.blurb.length < 90, `${mode.id}: concise description`);
    assert.deepEqual(Object.keys(mode.events).sort(), ['durationBonus', 'enabled', 'maxActive', 'probability']);
  }
  assert.deepEqual(GAME_MODES.standard.events,
    { enabled: true, probability: CITY_EVENTS.ROUND_PROBABILITY, maxActive: CITY_EVENTS.MAX_ACTIVE, durationBonus: 0 });
  assert.throws(() => createGame({ ...table(4), mode: 'nightmare' }), RangeError);
});

test('the mode and its rules are stored on the game', () => {
  for (const id of MODE_IDS) {
    const game = createGame({ ...table(4), seed: 1, mode: id });
    assert.equal(game.mode, id);
    assert.deepEqual(game.rules, resolveRules(id));
    assert.equal(modeName(game), GAME_MODES[id].name);
  }
  assert.equal(createGame({ ...table(3), seed: 1 }).mode, 'standard', 'default');
});

test('STANDARD replays the recorded V1.1 games exactly (4-, 3- and 2-player games)', () => {
  for (const golden of V11_GOLDEN) {
    for (const mode of [undefined, 'standard']) {
      const run = playthrough(api, { ...table(golden.n), seed: golden.seed, mode, cityRounds: 0 });
      assert.deepEqual({ rounds: run.rounds, events: run.events, values: run.values },
        { rounds: golden.rounds, events: golden.events, values: golden.values }, `seed ${golden.seed}, mode ${mode}`);
      assert.ok(run.maxActive <= CITY_EVENTS.MAX_ACTIVE);
    }
  }
});

test('the CITY era extends the recorded games without changing their EXPANSION era', () => {
  for (const golden of V11_GOLDEN) {
    const run = playthrough(api, { ...table(golden.n), seed: golden.seed });
    assert.equal(run.game.phase, 'ended');
    assert.equal(run.rounds, golden.rounds + CITY_ERA.ROUNDS, `seed ${golden.seed}: ${CITY_ERA.ROUNDS} full City rounds`);
    const expansion = run.events.filter((e) => Number(e.split(':')[0]) <= golden.rounds);
    assert.deepEqual(expansion, golden.events, `seed ${golden.seed}: same rolls until the grid is complete`);
  }
});

test('CLASSIC: roads, captures and development, never a city event', () => {
  for (const n of [4, 3, 2]) {
    const run = playthrough(api, { ...table(n), seed: 2024, mode: 'classic' });
    assert.deepEqual(run.events, [], `${n} players: no events`);
    assert.equal(run.game.events.history.length, 0);
    assert.equal(run.maxActive, 0);
    assert.ok(run.game.board.blocks.every((b) => b.ownerSeat != null || b.abandoned), 'every block claimed');
    assert.ok(run.game.board.blocks.some((b) => b.level > 0), 'development happens');
    // Identical to an event-free standard game: events are the only difference.
    const calm = playthrough(api, { ...table(n), seed: 2024, eventPool: [] });
    assert.deepEqual(run.values, calm.values);
    assert.equal(run.rounds, calm.rounds);
  }
  // No "calm round" either: without events there is nothing to be calm about.
  const game = createGame({ ...table(4), seed: 5, mode: 'classic' });
  for (const id of ['h-0-0', 'h-0-1', 'h-0-2']) api.placeRoad(game, id);
  const turn = api.placeRoad(game, 'h-0-3');
  assert.equal(turn.roundEnded, true);
  assert.deepEqual([turn.event.started, turn.event.calm], [null, false]);
});

test('URBAN CHAOS: a city event every round, each lasting longer, up to three at once', () => {
  for (const [seed, n] of [[2024, 4], [7, 3], [99, 2]]) {
    const run = playthrough(api, { ...table(n), seed, mode: 'chaos' });
    const rounds = run.events.map((e) => Number(e.split(':')[0]));
    // Every round after the first starts one (the final round only if play reached it).
    const expected = Array.from({ length: run.rounds - 1 }, (_, i) => i + 2);
    assert.deepEqual(rounds.filter((r) => r < run.rounds), expected.filter((r) => r < run.rounds), `seed ${seed}: every round`);
    assert.equal(run.maxActive, 3, `seed ${seed}: three events overlap, never more`);
    for (const e of run.game.events.history ?? []) assert.ok(e.endRound - e.startRound >= 1, 'every event lasts at least two rounds');
    const standard = playthrough(api, { ...table(n), seed });
    assert.ok(run.events.length > standard.events.length, `seed ${seed}: busier than standard`);
  }
});

test('each preset is deterministic for a seed', () => {
  for (const mode of MODE_IDS) {
    const a = playthrough(api, { ...table(4), seed: 31337, mode });
    const b = playthrough(api, { ...table(4), seed: 31337, mode });
    assert.deepEqual([a.events, a.values, a.rounds], [b.events, b.values, b.rounds], mode);
  }
});

test('Custom 2–4 players works with every preset', () => {
  for (const mode of MODE_IDS) {
    for (const n of [2, 3, 4]) {
      const run = playthrough(api, { seats: seats(n), gameType: 'custom', seed: 11, mode });
      assert.equal(run.values.length, n, `${mode}, ${n} players`);
    }
  }
});

test('autosave keeps the mode: a restored game plays on exactly like the original', () => {
  for (const mode of MODE_IDS) {
    const full = playthrough(api, { ...table(4), seed: 424242, mode });
    const storage = memoryStorage();
    const part = playthrough(api, { ...table(4), seed: 424242, mode }, { stopAfterRoads: 30 });
    assert.equal(saveActiveGame(part.game, { ...table(4), mode }, storage), true);
    const restored = loadActiveGame(storage);
    assert.equal(restored.game.mode, mode);
    assert.deepEqual(restored.game.rules, resolveRules(mode));
    assert.equal(restored.setup.mode, mode, 'rematch keeps the mode');
    const rest = playthrough(api, null, { game: restored.game });
    assert.deepEqual(rest.values, full.values, `${mode}: same result after save/restore`);
    assert.equal(rest.rounds, full.rounds);
  }
});

test('older saves (before presets) restore as standard; corrupt mode data is rejected', () => {
  const storage = memoryStorage();
  const game = createGame({ ...table(4), seed: 3 });
  saveActiveGame(game, table(4), storage);
  const raw = JSON.parse(storage.getItem(SAVE_KEY));
  delete raw.game.mode;
  delete raw.game.rules;
  storage.setItem(SAVE_KEY, JSON.stringify(raw));
  const legacy = loadActiveGame(storage);
  assert.equal(legacy.game.mode, 'standard');
  assert.deepEqual(legacy.game.rules, resolveRules('standard'));

  for (const corrupt of [{ mode: 'nightmare' }, { rules: { events: { enabled: 'yes', probability: 2, maxActive: -1 } } }]) {
    const bad = JSON.parse(JSON.stringify(raw));
    Object.assign(bad.game, { mode: 'chaos', rules: resolveRules('chaos') }, corrupt);
    storage.setItem(SAVE_KEY, JSON.stringify(bad));
    assert.equal(loadActiveGame(storage), null, JSON.stringify(corrupt));
  }
});
