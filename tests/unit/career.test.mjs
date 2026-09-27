import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACHIEVEMENTS, CAREER_KEY, CAREER_BACKUP_KEY, CAREER_VERSION, emptyCareer, validateCareer, loadCareer, saveCareer,
  isGenuineMatch, summarizeMatch, recordMatch, favoriteCategory,
} from '../../js/core/career.js';
import { SAVE_KEY } from '../../js/core/persistence.js';
import { CATEGORY_ORDER } from '../../js/core/buildings.js';
import { playthrough, loadApi } from './_playthrough.mjs';

const api = await loadApi();
const seats = (n) => Array.from({ length: n }, (_, i) => ({ seat: i + 1, name: `Mayor ${i + 1}` }));
const play = (seed, n = 4, mode = 'standard') => playthrough(api, { seats: seats(n), seed, mode, gameType: n === 4 ? 'standard' : 'custom' }).game;
const memoryStorage = (initial = {}) => {
  const map = new Map(Object.entries(initial));
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), map };
};

/** Finishes a game the way debug/test staging does: roads written straight onto the board. */
function stagedFinish(seed) {
  const { game } = playthrough(api, { seats: seats(4), seed }, { stopAfterRoads: 20 });
  const ids = api.allRoadIds(game.board).filter((id) => !(id in game.board.roads));
  ids.slice(0, -1).forEach((id) => { game.board.roads[id] = 1; });
  api.placeRoad(game, ids.at(-1)); // the last road is played for real, so the game ends
  return game;
}

test('twelve achievements, each with a name, a short description and a badge icon', () => {
  assert.equal(ACHIEVEMENTS.length, 12);
  assert.equal(new Set(ACHIEVEMENTS.map((a) => a.id)).size, 12);
  for (const a of ACHIEVEMENTS) {
    assert.ok(a.name && a.text.length < 60 && /^(icons|title):/.test(a.icon), a.id);
    assert.equal(typeof a.test, 'function');
  }
});

test('only genuinely completed matches count', () => {
  const real = play(2024);
  assert.equal(real.phase, 'ended');
  assert.equal(isGenuineMatch(real), true);

  const unfinished = playthrough(api, { seats: seats(4), seed: 2024 }, { stopAfterRoads: 40 }).game;
  assert.equal(isGenuineMatch(unfinished), false, 'match in progress');

  const staged = stagedFinish(5);
  assert.equal(staged.phase, 'ended', 'staging can end a game…');
  assert.equal(isGenuineMatch(staged), false, '…but roads written onto the board are not a real match');

  const cash = play(2024);
  cash.players[0].cash += 5000; // money edited behind the ledger's back
  assert.equal(isGenuineMatch(cash), false);

  // A vacant owned block whose capture is erased from the log: ownership no longer traces to play.
  const owned = play(2024);
  const touched = new Set([...owned.log, ...owned.ledger].map((e) => e.block).filter(Boolean));
  const block = owned.board.blocks.find((b) => b.ownerSeat != null && !touched.has(b.id));
  assert.ok(block, 'fixture has a vacant owned block');
  owned.log = owned.log.map((e) => (e.type === 'road' ? { ...e, captured: e.captured.filter((id) => id !== block.id) } : e));
  assert.equal(isGenuineMatch(owned), false, 'ownership with no logged capture or purchase');

  const built = play(2024);
  built.board.blocks.find((b) => b.ownerSeat != null && b.level === 0 && !built.log.some((e) => e.block === b.id)).level = 2;
  assert.equal(isGenuineMatch(built), false, 'development with no logged build');

  assert.equal(isGenuineMatch(null), false);
  assert.equal(isGenuineMatch({ phase: 'ended' }), false, 'garbage never throws');
});

test('recording a match: totals, per-mayor records, favourite category', () => {
  const game = play(2024);
  const summary = summarizeMatch(game);
  const { career, recorded, unlocked } = recordMatch(emptyCareer(), game, 1000);
  assert.equal(recorded, true);
  const t = career.totals;
  assert.equal(t.matches, 1);
  assert.equal(t.blocksCaptured, summary.players.reduce((n, p) => n + p.captured, 0));
  assert.equal(t.blocksCaptured, game.log.filter((e) => e.type === 'road').reduce((n, e) => n + e.captured.length, 0));
  assert.equal(t.developments, game.log.filter((e) => e.type === 'build' || e.type === 'upgrade').length);
  assert.equal(t.eventsSurvived, game.events.history.length);
  assert.equal(t.bankruptcies, game.players.reduce((n, p) => n + p.bankruptcies, 0));
  const top = [...game.results.rows].sort((a, b) => b.cityValue - a.cityValue)[0];
  assert.deepEqual(t.highestCityValue, { value: top.cityValue, by: top.name });
  assert.equal(t.longestChain.count, game.results.matchStats.longestCaptureChain.count, 'same chain rule as the results screen');

  for (const row of game.results.rows) {
    const m = career.mayors[row.name.toLowerCase()];
    assert.deepEqual(m, { name: row.name, played: 1, won: game.results.winners.includes(row.seat) ? 1 : 0, best: row.cityValue });
  }
  assert.equal(favoriteCategory(career), 'residential', 'the driver only builds homes');
  assert.equal(favoriteCategory(emptyCareer()), null);
  assert.ok(unlocked.some((u) => u.id === 'first-ribbon'));
  assert.ok(unlocked.some((u) => u.id === 'mayor-of-the-year' && game.results.rows.find((r) => r.name === u.by).rank === 1));
});

test('a match is never counted twice, and staged games award nothing', () => {
  const game = play(7, 3);
  const once = recordMatch(emptyCareer(), game);
  const twice = recordMatch(once.career, game);
  assert.equal(twice.recorded, false);
  assert.equal(twice.career.totals.matches, 1);

  const staged = recordMatch(emptyCareer(), stagedFinish(9), 1);
  assert.equal(staged.recorded, false);
  assert.deepEqual(staged.unlocked, []);
  assert.deepEqual(staged.career, emptyCareer(), 'no stats, no achievements');
});

test('achievements: earned once, credited to the right mayor, following each rule', () => {
  let career = emptyCareer();
  const earned = new Map();
  const games = [[2024, 4, 'standard'], [7, 3, 'classic'], [99, 2, 'chaos'], [11, 2, 'standard'], [12, 3, 'chaos'],
    [13, 4, 'classic'], [14, 2, 'standard'], [15, 3, 'standard'], [16, 2, 'classic'], [17, 4, 'chaos']];
  for (const [seed, n, mode] of games) {
    const game = play(seed, n, mode);
    const match = summarizeMatch(game);
    const result = recordMatch(career, game, seed);
    for (const u of result.unlocked) {
      assert.ok(!earned.has(u.id), `${u.id} earned only once`);
      earned.set(u.id, u);
      const def = ACHIEVEMENTS.find((a) => a.id === u.id);
      const player = match.players.find((p) => p.name === u.by);
      assert.ok(def.test(player, match, result.career), `${u.id} credited to someone who met it`);
    }
    career = result.career;
  }
  assert.equal(career.totals.matches, 10);
  for (const id of ['first-ribbon', 'mayor-of-the-year', 'storm-chaser', 'purist', 'veteran']) assert.ok(earned.has(id), `${id} earned`);
  assert.equal(career.achievements.veteran.at, 17, 'the 10th match unlocked Veteran');
  if (career.totals.bankruptcies === 0) assert.ok(!earned.has('comeback'), 'Comeback Kid needs a bankruptcy');
});

test('achievement rules on hand-made match facts', () => {
  const base = { won: false, cityValue: 20000, blocks: 5, captured: 5, longestChain: 1, developments: 2, maxLevel: 1, bankruptcies: 0, categories: {} };
  const rule = (id) => ACHIEVEMENTS.find((a) => a.id === id).test;
  const m = { mode: 'standard', tie: false };
  const c = { totals: { matches: 1 } };
  assert.equal(rule('chain-reaction')({ ...base, longestChain: 3 }, m, c), true);
  assert.equal(rule('chain-reaction')({ ...base, longestChain: 2 }, m, c), false);
  assert.equal(rule('land-baron')({ ...base, blocks: 10 }, m, c), true);
  assert.equal(rule('skyline')({ ...base, maxLevel: 3 }, m, c), true);
  assert.equal(rule('master-builder')({ ...base, developments: 8 }, m, c), true);
  assert.equal(rule('big-city')({ ...base, cityValue: 39999 }, m, c), false);
  assert.equal(rule('comeback')({ ...base, won: true, bankruptcies: 1 }, m, c), true);
  assert.equal(rule('comeback')({ ...base, won: false, bankruptcies: 1 }, m, c), false);
  assert.equal(rule('storm-chaser')(base, { ...m, mode: 'chaos' }, c), true);
  assert.equal(rule('purist')({ ...base, won: true }, { ...m, mode: 'classic' }, c), true);
  assert.equal(rule('purist')({ ...base, won: true }, m, c), false);
  assert.equal(rule('photo-finish')({ ...base, won: true }, { ...m, tie: true }, c), true);
  assert.equal(rule('veteran')(base, m, { totals: { matches: 9 } }), false);
});

test('storage: versioned, separate from the active-game save, round-trips', () => {
  assert.notEqual(CAREER_KEY, SAVE_KEY);
  const storage = memoryStorage();
  assert.deepEqual(loadCareer(storage), { career: emptyCareer(), corrupt: false }, 'missing → fresh');
  const { career } = recordMatch(emptyCareer(), play(2024), 5);
  assert.equal(saveCareer(career, storage), true);
  assert.equal(JSON.parse(storage.getItem(CAREER_KEY)).version, CAREER_VERSION);
  assert.deepEqual(loadCareer(storage), { career, corrupt: false });
  assert.equal(storage.map.has(SAVE_KEY), false, 'the active-game save is untouched');
});

test('corrupt or unsupported data fails safely and is kept aside', () => {
  const good = recordMatch(emptyCareer(), play(2024), 5).career;
  const variants = [
    '{not json',
    'null',
    JSON.stringify({ ...good, version: 99 }),
    JSON.stringify({ ...good, totals: { ...good.totals, matches: -1 } }),
    JSON.stringify({ ...good, totals: { ...good.totals, blocksCaptured: 'many' } }),
    JSON.stringify({ ...good, achievements: { 'made-up': { by: 'X', at: 1 } } }),
    JSON.stringify({ ...good, mayors: { x: { name: 'X', played: 1, won: 2, best: 0 } } }),
    JSON.stringify({ ...good, categories: { ...good.categories, park: NaN } }),
    JSON.stringify({ ...good, recent: 'all' }),
  ];
  for (const raw of variants) {
    const storage = memoryStorage({ [CAREER_KEY]: raw });
    const { career, corrupt } = loadCareer(storage);
    assert.deepEqual(career, emptyCareer(), raw.slice(0, 40));
    assert.equal(corrupt, true);
    assert.equal(storage.getItem(CAREER_BACKUP_KEY), raw, 'raw data backed up, not lost');
  }
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.deepEqual(loadCareer(broken).career, emptyCareer());
  assert.equal(saveCareer(good, broken), false);
  assert.equal(validateCareer(emptyCareer()) !== null, true);
  assert.deepEqual(Object.keys(emptyCareer().categories), CATEGORY_ORDER);
});
