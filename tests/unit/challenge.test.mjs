import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSeed, formatSeed, parseSeats, readChallenge, withoutChallenge, challengeUrl, replaySetup, MAX_SEED,
} from '../../js/core/challenge.js';
import { createGame } from '../../js/core/game.js';
import { MODE_IDS } from '../../js/core/modes.js';
import { playthrough, loadApi } from './_playthrough.mjs';

const api = await loadApi();
const seats = (list) => list.map((seat) => ({ seat }));
const PAGE = 'https://officialinspire.github.io/GRIDLOCK/';

/** Every city event a game started, in order, with its round, length and targets. */
const eventSequence = (game) => game.events.history.map((e) => `${e.startRound}-${e.endRound}:${e.id}[${e.targets.join(',')}]`);

test('seeds: whole numbers 0 – 2^32-1, from text or numbers', () => {
  assert.equal(parseSeed('123'), 123);
  assert.equal(parseSeed(' #0042 '), 42);
  assert.equal(parseSeed(0), 0);
  assert.equal(parseSeed(String(MAX_SEED)), MAX_SEED);
  for (const bad of ['', '  ', '-1', '1.5', '1e3', 'abc', '12a', String(MAX_SEED + 1), '99999999999', null, undefined, -1, 2.5, MAX_SEED + 1, NaN]) {
    assert.equal(parseSeed(bad), null, `rejects ${JSON.stringify(bad)}`);
  }
  assert.equal(formatSeed(4294967295), '4294967295');
});

test('seat lists: 2–4 distinct real seats', () => {
  assert.deepEqual(parseSeats('1234'), [1, 2, 3, 4]);
  assert.deepEqual(parseSeats('42'), [2, 4]);
  for (const bad of ['1', '11', '12345', '15', '1a', '', null]) assert.equal(parseSeats(bad), null, `rejects ${bad}`);
});

test('challenge links carry seed, mode and seats only, never ?debug', () => {
  const game = createGame({ seats: seats([1, 3, 4]), seed: 987654321, mode: 'chaos' });
  const link = challengeUrl({ seed: game.seed, mode: game.mode, seats: game.players }, `${PAGE}?seed=1&debug#board`);
  assert.equal(link, `${PAGE}?seed=987654321&mode=chaos&seats=134`);
  assert.deepEqual(readChallenge(new URL(link).search), { seed: 987654321, mode: 'chaos', seats: [1, 3, 4] });
});

test('reading links: absent, invalid and partial challenges', () => {
  assert.equal(readChallenge(''), null);
  assert.equal(readChallenge('?debug'), null);
  assert.deepEqual(readChallenge('?seed=nope'), { invalid: true });
  assert.deepEqual(readChallenge('?seed=5&debug'), { seed: 5, mode: null, seats: null }, 'bare ?seed= links still work');
  assert.deepEqual(readChallenge('?seed=5&mode=hardcore&seats=9'), { seed: 5, mode: null, seats: null }, 'unknown parts are ignored');
  assert.deepEqual(readChallenge('?seed=5&mode=__proto__'), { seed: 5, mode: null, seats: null });
});

test('the address bar loses only the challenge parameters', () => {
  assert.equal(withoutChallenge(`${PAGE}?seed=5&mode=classic&seats=12&debug`), `${PAGE}?debug`);
  assert.equal(withoutChallenge(`${PAGE}?debug&seed=5&x=a%20b`), `${PAGE}?debug&x=a%20b`, 'others kept verbatim');
  assert.equal(withoutChallenge(`${PAGE}?seed=5`), PAGE);
  assert.equal(withoutChallenge(`${PAGE}index.html?seed=5#x`), `${PAGE}index.html#x`);
});

test('Replay Same City keeps the seed, rules, seats and names', () => {
  const game = createGame({ seats: [{ seat: 2, name: 'Ada' }, { seat: 4, name: 'Bo' }], seed: 77, mode: 'classic', gameType: 'custom' });
  const setup = replaySetup(game, { gameType: 'custom', settings: { sound: true } });
  assert.deepEqual(setup, {
    settings: { sound: true }, gameType: 'custom', mode: 'classic', seed: 77,
    seats: [{ seat: 2, name: 'Ada' }, { seat: 4, name: 'Bo' }],
  });
  const again = createGame(setup);
  assert.deepEqual(again, createGame(setup), 'a replay setup always deals the same starting city');
  assert.equal(again.seed, 77);
  assert.equal(replaySetup(createGame({ seats: seats([1, 2, 3, 4]), seed: 1 }), { gameType: 'standard' }).gameType, 'standard');
});

test('same seed + mode + seats + moves ⇒ the same city events, for every preset', () => {
  for (const mode of MODE_IDS) {
    for (const [seed, table] of [[19, [1, 2, 3, 4]], [2024, [1, 3]], [MAX_SEED, [2, 3, 4]]]) {
      const options = { seats: seats(table), seed, mode };
      const first = playthrough(api, options);
      const second = playthrough(api, replaySetup(first.game, { gameType: 'custom' }));
      assert.deepEqual(eventSequence(second.game), eventSequence(first.game), `${mode} seed ${seed}`);
      assert.deepEqual(second.values, first.values, `${mode} seed ${seed}: identical final scores`);
      assert.equal(second.game.rngState, first.game.rngState, `${mode} seed ${seed}: RNG consumed identically`);
      if (mode === 'classic') assert.deepEqual(eventSequence(first.game), [], 'Classic never rolls events');
      else assert.ok(eventSequence(first.game).length > 0, `${mode} seed ${seed} has events to compare`);
    }
  }
});

test('the replay survives a challenge link round trip', () => {
  const first = playthrough(api, { seats: seats([1, 2, 4]), seed: 31337, mode: 'chaos' });
  const link = challengeUrl({ seed: first.game.seed, mode: first.game.mode, seats: first.game.players }, PAGE);
  const { seed, mode, seats: joined } = readChallenge(new URL(link).search);
  const friend = playthrough(api, { seats: seats(joined), seed, mode });
  assert.deepEqual(eventSequence(friend.game), eventSequence(first.game));
});

test('different seeds or modes deal different event sequences', () => {
  const run = (seed, mode) => eventSequence(playthrough(api, { seats: seats([1, 2, 3, 4]), seed, mode }).game);
  const bySeed = new Set([1, 2, 3, 4, 5].map((seed) => JSON.stringify(run(seed, 'chaos'))));
  assert.equal(bySeed.size, 5, 'five seeds, five different cities');
  assert.notDeepEqual(run(8, 'standard'), run(8, 'chaos'), 'the preset is part of the replay');
});
