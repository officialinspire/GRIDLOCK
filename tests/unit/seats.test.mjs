import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateSeats, applySeatPreset, defaultNames, presetFor, controllerOf, controllerLabel, SEAT_ERRORS,
} from '../../js/core/seats.js';
import { createGame } from '../../js/core/game.js';
import { saveActiveGame, loadActiveGame, SAVE_KEY } from '../../js/core/persistence.js';
import { replaySetup } from '../../js/core/challenge.js';
import { recordMatch, emptyCareer } from '../../js/core/career.js';
import { playthrough, loadApi } from './_playthrough.mjs';

const api = await loadApi();
const human = (seat, name) => ({ seat, ...(name && { name }), controller: 'human', difficulty: null });
const cpu = (seat, difficulty = 'normal') => ({ seat, controller: 'cpu', difficulty });
const memoryStorage = () => {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
};
/** A game's state without seat metadata: what the rules engine produced. */
const rulesState = (game) => JSON.stringify({
  ...game,
  players: game.players.map(({ name, controller, difficulty, ...rest }) => rest),
  results: game.results && { ...game.results, rows: game.results.rows.map(({ name, ...rest }) => rest) },
});

/* ---------------- setup validation ---------------- */

test('Standard needs exactly 4 seats; Custom 2–4, CPU seats included', () => {
  assert.equal(validateSeats({ gameType: 'standard', seats: [human(1), cpu(2), cpu(3), cpu(4)] }), null, 'Solo');
  assert.equal(validateSeats({ gameType: 'standard', seats: [human(1), human(2), human(3), human(4)] }), null, 'Local Friends');
  assert.equal(validateSeats({ gameType: 'standard', seats: [human(1), cpu(2), cpu(3)] }), SEAT_ERRORS.STANDARD_COUNT);
  assert.equal(validateSeats({ gameType: 'custom', seats: [human(1), cpu(3)] }), null, 'one human and one CPU');
  assert.equal(validateSeats({ gameType: 'custom', seats: [cpu(1, 'easy'), human(2), cpu(4, 'hard')] }), null);
  assert.equal(validateSeats({ gameType: 'custom', seats: [human(1)] }), SEAT_ERRORS.CUSTOM_COUNT);
  assert.equal(validateSeats({ gameType: 'custom', seats: [human(1), human(2), human(3), human(4), human(4)] }), SEAT_ERRORS.CUSTOM_COUNT);
});

test('seats, controllers and difficulties are checked', () => {
  assert.equal(validateSeats({ seats: [human(1), human(1)] }), SEAT_ERRORS.BAD_SEAT);
  assert.equal(validateSeats({ seats: [human(1), human(7)] }), SEAT_ERRORS.BAD_SEAT);
  assert.equal(validateSeats({ seats: [human(1), { seat: 2, controller: 'robot', difficulty: null }] }), SEAT_ERRORS.BAD_CONTROLLER);
  assert.equal(validateSeats({ seats: [human(1), cpu(2, 'impossible')] }), SEAT_ERRORS.BAD_DIFFICULTY);
  assert.equal(validateSeats({ seats: [human(1), { seat: 2, controller: 'human', difficulty: 'hard' }] }), SEAT_ERRORS.BAD_CONTROLLER);
  assert.equal(validateSeats({ seats: [cpu(1), cpu(2)] }), SEAT_ERRORS.NO_HUMAN, 'someone has to play');
  assert.equal(validateSeats({ seats: [{ seat: 1 }, { seat: 2 }] }), null, 'no controller = human (older callers)');
});

test('controller normalisation', () => {
  assert.deepEqual(controllerOf({ seat: 1 }), { controller: 'human', difficulty: null });
  assert.deepEqual(controllerOf({ seat: 1, controller: 'cpu' }), { controller: 'cpu', difficulty: 'normal' });
  assert.deepEqual(controllerOf(cpu(1, 'hard')), { controller: 'cpu', difficulty: 'hard' });
  assert.equal(controllerOf({ controller: 'cpu', difficulty: 'nightmare' }), null);
  assert.equal(controllerOf({ controller: 'alien' }), null);
  assert.equal(controllerLabel(cpu(2, 'easy')), 'CPU · Easy');
  assert.equal(controllerLabel(human(2)), null);
});

/* ---------------- presets and names ---------------- */

test('table presets: Solo, Local Friends and Mixed', () => {
  const four = [1, 2, 3, 4].map((seat) => ({ seat, name: '' }));
  assert.deepEqual(applySeatPreset('solo', four).map((s) => [s.controller, s.difficulty]),
    [['human', null], ['cpu', 'normal'], ['cpu', 'normal'], ['cpu', 'normal']], 'Solo = 1 human + 3 CPU');
  assert.deepEqual(applySeatPreset('solo', [human(2), cpu(3, 'hard'), human(4)]).map((s) => [s.seat, s.controller, s.difficulty]),
    [[2, 'human', null], [3, 'cpu', 'hard'], [4, 'cpu', 'normal']], 'first joined seat is the human; chosen difficulty kept');
  assert.ok(applySeatPreset('friends', [cpu(1), cpu(2, 'easy'), human(3)]).every((s) => s.controller === 'human' && s.difficulty === null));
  assert.deepEqual(applySeatPreset('mixed', [cpu(1, 'easy'), human(2), cpu(3, 'hard')]).map((s) => s.controller), ['cpu', 'human', 'cpu']);
  assert.equal(presetFor([human(1), cpu(2), cpu(3), cpu(4)]), 'solo');
  assert.equal(presetFor([human(1), human(2)]), 'friends');
  assert.equal(presetFor([cpu(1), human(2), cpu(3)]), 'mixed');
});

test('CPU seats are named Mayor Bot 1, 2, 3 in seat order; humans keep Player N', () => {
  assert.deepEqual([...defaultNames([cpu(4), human(1), cpu(2), cpu(3)])],
    [[1, 'Player 1'], [2, 'Mayor Bot 1'], [3, 'Mayor Bot 2'], [4, 'Mayor Bot 3']]);
  const game = createGame({ seats: [human(1, 'Ada'), cpu(2, 'easy'), { ...cpu(3, 'hard'), name: 'Robo' }, cpu(4)], seed: 1, gameType: 'standard' });
  assert.deepEqual(game.players.map((p) => [p.name, p.controller, p.difficulty]),
    [['Ada', 'human', null], ['Mayor Bot 1', 'cpu', 'easy'], ['Robo', 'cpu', 'hard'], ['Mayor Bot 3', 'cpu', 'normal']], 'naming one bot doesn\'t renumber the others');
});

/* ---------------- core: metadata only ---------------- */

test('createGame stores controllers and rejects bad ones; seats without one are human', () => {
  const plain = createGame({ seats: [{ seat: 1 }, { seat: 2 }], seed: 5 });
  assert.deepEqual(plain.players.map((p) => [p.name, p.controller, p.difficulty]), [['Player 1', 'human', null], ['Player 2', 'human', null]]);
  assert.throws(() => createGame({ seats: [human(1), { seat: 2, controller: 'robot' }] }), RangeError);
  assert.throws(() => createGame({ seats: [human(1), cpu(2, 'impossible')] }), RangeError);
});

test('human-only games are exactly as before: explicit human controllers change nothing', () => {
  for (const [seed, table] of [[2024, [1, 2, 3, 4]], [7, [1, 3, 4]], [99, [2, 4]]]) {
    const implicit = playthrough(api, { seats: table.map((seat) => ({ seat })), seed });
    const explicit = playthrough(api, { seats: table.map((seat) => human(seat)), seed });
    assert.equal(JSON.stringify(explicit.game), JSON.stringify(implicit.game), `seed ${seed}`);
  }
});

test('the rules ignore controllers: a mixed table plays the same moves to the same result', () => {
  for (const seed of [3, 11, 42]) {
    const people = playthrough(api, { seats: [1, 2, 3, 4].map((seat) => human(seat)), seed, gameType: 'standard' });
    const mixed = playthrough(api, { seats: [human(1), cpu(2, 'easy'), human(3), cpu(4, 'hard')], seed, gameType: 'standard' });
    assert.equal(rulesState(mixed.game), rulesState(people.game), `seed ${seed}`);
    assert.deepEqual(mixed.values, people.values);
  }
});

/* ---------------- persistence, rematch, replay ---------------- */

test('autosave and Continue keep every seat controller, and the rematch setup too', () => {
  const storage = memoryStorage();
  const setup = { gameType: 'custom', mode: 'chaos', seats: [human(1, 'Ada'), cpu(3, 'hard'), cpu(4, 'easy')] };
  const game = createGame({ ...setup, seed: 8 });
  assert.equal(saveActiveGame(game, setup, storage), true);
  const restored = loadActiveGame(storage);
  assert.deepEqual(restored.game.players.map((p) => [p.seat, p.name, p.controller, p.difficulty]),
    [[1, 'Ada', 'human', null], [3, 'Mayor Bot 1', 'cpu', 'hard'], [4, 'Mayor Bot 2', 'cpu', 'easy']]);
  assert.deepEqual(restored.setup.seats, [
    { seat: 1, name: 'Ada', controller: 'human', difficulty: null },
    { seat: 3, name: 'Mayor Bot 1', controller: 'cpu', difficulty: 'hard' },
    { seat: 4, name: 'Mayor Bot 2', controller: 'cpu', difficulty: 'easy' },
  ]);
  // Play Again starts from the saved setup (a fresh seed); the table is the same.
  const rematch = createGame({ ...restored.setup, seed: undefined });
  assert.deepEqual(rematch.players.map((p) => [p.name, p.controller, p.difficulty]),
    restored.game.players.map((p) => [p.name, p.controller, p.difficulty]));
});

test('saves from before controllers load as all-human; corrupt controllers are rejected', () => {
  const storage = memoryStorage();
  const game = createGame({ seats: [human(1), cpu(2)], seed: 3 });
  saveActiveGame(game, null, storage);
  const raw = JSON.parse(storage.getItem(SAVE_KEY));
  for (const p of raw.game.players) { delete p.controller; delete p.difficulty; }
  storage.setItem(SAVE_KEY, JSON.stringify(raw));
  assert.deepEqual(loadActiveGame(storage).game.players.map((p) => [p.controller, p.difficulty]), [['human', null], ['human', null]]);

  raw.game.players[1].controller = 'cpu';
  raw.game.players[1].difficulty = 'godlike';
  storage.setItem(SAVE_KEY, JSON.stringify(raw));
  assert.equal(loadActiveGame(storage), null, 'an invalid difficulty is not trusted');
});

test('Replay Same City keeps the controllers', () => {
  const game = createGame({ seats: [cpu(1, 'hard'), human(2, 'Bo')], seed: 12, mode: 'classic' });
  const again = createGame(replaySetup(game, { gameType: 'custom' }));
  assert.deepEqual(again.players.map((p) => [p.seat, p.name, p.controller, p.difficulty]),
    [[1, 'Mayor Bot 1', 'cpu', 'hard'], [2, 'Bo', 'human', null]]);
  assert.equal(again.seed, 12);
});

/* ---------------- results and career ---------------- */

test('results rank CPU seats like anyone else; the career only counts the humans', () => {
  const { game } = playthrough(api, { seats: [human(1, 'Ada'), cpu(2), cpu(3, 'hard'), cpu(4, 'easy')], seed: 21, gameType: 'standard' });
  assert.equal(game.phase, 'ended');
  assert.equal(game.results.rows.length, 4, 'every seat is scored');
  const { career, unlocked, recorded } = recordMatch(emptyCareer(), game, 1000);
  assert.equal(recorded, true);
  assert.deepEqual(Object.values(career.mayors).map((m) => m.name), ['Ada'], 'no per-mayor record for bots');
  const adaCaptured = game.log.filter((e) => e.type === 'road' && e.seat === 1).reduce((n, e) => n + e.captured.length, 0);
  assert.equal(career.totals.blocksCaptured, adaCaptured, "only Ada's captures count");
  assert.ok(unlocked.every((u) => u.by === 'Ada'), 'bots never earn your badges');
  assert.equal(career.totals.matches, 1);

  // An all-human table is recorded exactly as before: every seat counts.
  const people = playthrough(api, { seats: [1, 2, 3, 4].map((seat) => human(seat)), seed: 21, gameType: 'standard' }).game;
  const all = recordMatch(emptyCareer(), people, 1000).career;
  assert.equal(Object.keys(all.mayors).length, 4);
  assert.equal(all.totals.blocksCaptured, people.log.filter((e) => e.type === 'road').reduce((n, e) => n + e.captured.length, 0));
});
