/**
 * Career schema 2 (V1.5): daily / weekly / monthly play streaks, habits, per-mayor win streaks and
 * rule-set wins, migration of version 1 records, and achievements unlocked live during play.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAREER_KEY, CAREER_BACKUP_KEY, emptyCareer, loadCareer, saveCareer, recordMatch, summarizeMatch, unlockLive, liveFacts,
} from '../../js/core/career.js';
import { ACHIEVEMENTS, LIVE_FACTS, getAchievement, progressOf, streakNow, MAX_POINTS, pointsOf } from '../../js/core/achievements.js';
import { dayIndex, weekOfDay, periodsOf } from '../../js/core/calendar.js';
import { playthrough, loadApi } from './_playthrough.mjs';

const api = await loadApi();
const rule = (id) => getAchievement(id).test;
const humans = (n) => Array.from({ length: n }, (_, i) => ({ seat: i + 1, name: `Mayor ${i + 1}` }));
const play = (seed, seats = humans(2), mode = 'classic') => playthrough(api, { seats, seed, mode, gameType: 'custom' }).game;
/** Local time, as the device would see it (October 2026: the 3rd is a Saturday). */
const at = (month, day, hour = 14) => new Date(2026, month - 1, day, hour).getTime();
const memoryStorage = (initial = {}) => {
  const map = new Map(Object.entries(initial));
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), map };
};

test('calendar periods: local days, Monday weeks, months', () => {
  assert.equal(dayIndex(at(10, 4)) - dayIndex(at(10, 3)), 1);
  assert.equal(dayIndex(at(10, 4, 0)), dayIndex(at(10, 4, 23)), 'one day from midnight to midnight');
  assert.equal(weekOfDay(dayIndex(at(10, 4))), weekOfDay(dayIndex(at(9, 28))), 'Sunday ends the Monday week');
  assert.equal(weekOfDay(dayIndex(at(10, 5))), weekOfDay(dayIndex(at(10, 4))) + 1, 'Monday starts the next');
  assert.equal(periodsOf(at(11, 2)).month - periodsOf(at(10, 31)).month, 1);
  assert.equal(periodsOf(at(10, 3)).weekday, 6);
});

test('play streaks: days, weeks and months in a row; a gap starts again; the best is kept', () => {
  const game = play(31);
  let career = emptyCareer();
  const earned = new Map();
  // The same match recorded on different dates (forgetting it each time, so it counts again).
  const record = (when) => {
    const result = recordMatch({ ...career, recent: [] }, game, when);
    assert.equal(result.recorded, true);
    for (const u of result.unlocked) earned.set(u.id, when);
    career = result.career;
    return result;
  };
  record(at(10, 3)); // Saturday
  assert.deepEqual(career.streaks.day, { current: 1, best: 1, last: dayIndex(at(10, 3)) });
  record(at(10, 4)); // Sunday
  assert.equal(career.streaks.day.current, 2);
  assert.ok(earned.has('daily-2') && earned.has('weekend-warrior'), 'two days in a row, Saturday then Sunday');
  assert.equal(career.streaks.week.current, 1, 'still the same week');
  record(at(10, 5)); // Monday: a new week
  assert.deepEqual([career.streaks.day.current, career.streaks.week.current], [3, 2]);
  assert.ok(earned.has('daily-3') && earned.has('weekly-2'));
  record(at(10, 5, 18));
  assert.equal(career.streaks.day.current, 3, 'a second match the same day keeps the streak where it was');
  assert.equal(career.today.matches, 2);
  assert.ok(!earned.has('marathon'));
  record(at(10, 5, 21));
  assert.equal(earned.get('marathon'), at(10, 5, 21), 'three matches in one day');
  record(at(10, 8)); // Thursday: two days missed
  assert.deepEqual(career.streaks.day, { current: 1, best: 3, last: dayIndex(at(10, 8)) });
  assert.equal(career.today.matches, 1, 'a new day starts the count again');
  record(at(11, 2)); // a new month
  assert.deepEqual([career.streaks.month.current, career.streaks.week.current], [2, 1]);
  assert.ok(earned.has('monthly-2'));
  assert.ok(!earned.has('night-owl'));
  record(at(11, 3, 2)); // 2 a.m.
  assert.ok(earned.has('night-owl'));
  assert.equal(career.streaks.day.current, 2);
  assert.equal(career.totals.daysPlayed, 6, 'Oct 3, 4, 5, 8, Nov 2, 3');
  assert.equal(career.totals.matches, 8);

  // What the Statistics screen shows: a streak lapses once a whole period passes without play.
  assert.equal(streakNow(career, 'day', at(11, 4)), 2, 'still alive the next day');
  assert.equal(streakNow(career, 'day', at(11, 5)), 0, 'broken after a day off');
  assert.equal(streakNow(career, 'month', at(12, 20)), 2);
  assert.equal(streakNow(career, 'month', at(1, 5) + 365 * 864e5), 0);
  assert.deepEqual(progressOf(getAchievement('daily-7'), career, at(11, 4)), [2, 7]);
  assert.deepEqual(progressOf(getAchievement('marathon'), career, at(11, 3, 9)), [1, 3]);
  assert.deepEqual(progressOf(getAchievement('veteran'), career), [8, 10]);
  assert.equal(progressOf(getAchievement('mayor-of-the-year'), career), null, 'one-match goals have no progress bar');
});

test('mayor records: win streaks and wins per rule set (Hat Trick, Triple Crown, Re-elected)', () => {
  let career = emptyCareer();
  const games = [[41, 'classic'], [42, 'standard'], [43, 'chaos'], [44, 'classic'], [45, 'standard'], [46, 'chaos'], [47, 'classic']]
    .map(([seed, mode]) => play(seed, humans(2), mode));
  const earned = new Map();
  for (const [i, game] of games.entries()) {
    const result = recordMatch(career, game, at(10, 1 + i));
    for (const u of result.unlocked) earned.set(u.id, u.by);
    career = result.career;
    for (const row of game.results.rows) {
      const m = career.mayors[row.name.toLowerCase()];
      const won = game.results.winners.includes(row.seat);
      if (won) assert.ok(m.streak >= 1);
      else assert.equal(m.streak, 0, 'a loss ends the win streak');
      assert.ok(m.bestStreak >= m.streak);
      assert.equal(Object.values(m.modeWins).reduce((a, b) => a + b, 0), m.won);
    }
  }
  for (const [id, by] of earned) {
    const def = getAchievement(id);
    const m = career.mayors[by.toLowerCase()];
    if (id === 'hat-trick') assert.ok(m.bestStreak >= 3);
    if (id === 'triple-crown') assert.ok(Object.values(m.modeWins).every((n) => n > 0));
    if (id === 're-elected') assert.ok(m.won >= 5);
    assert.ok(def, id);
  }
  const best = Math.max(...Object.values(career.mayors).map((m) => m.bestStreak));
  assert.equal(earned.has('hat-trick'), best >= 3);
  // Hand-made records: the rules read the earner's own mayor record.
  const c = { mayors: { ann: { name: 'Ann', won: 5, streak: 3, bestStreak: 3, modeWins: { standard: 1, classic: 2, chaos: 2 } } } };
  assert.equal(rule('hat-trick')({ name: 'Ann' }, {}, c), true);
  assert.equal(rule('triple-crown')({ name: 'ANN ' }, {}, c), true, 'names match as the career keys them');
  assert.equal(rule('re-elected')({ name: 'Ann' }, {}, c), true);
  assert.equal(rule('dynasty')({ name: 'Ann' }, {}, c), false);
  assert.equal(rule('hat-trick')({ name: 'Bob' }, {}, c), false);
});

test('Déjà Vu: the same city seed completed twice (any rules)', () => {
  const first = recordMatch(emptyCareer(), play(77, humans(2), 'classic'), at(10, 1));
  assert.ok(!first.unlocked.some((u) => u.id === 'deja-vu'));
  const again = recordMatch(first.career, play(77, humans(2), 'standard'), at(10, 2));
  assert.equal(again.recorded, true);
  assert.ok(again.unlocked.some((u) => u.id === 'deja-vu'));
});

test('version 1 records (V1.2–V1.4) migrate: nothing earned is lost', () => {
  const recorded = recordMatch(emptyCareer(), play(2024, humans(4), 'standard'), at(10, 6)).career;
  const v1 = {
    version: 1,
    totals: Object.fromEntries(['matches', 'blocksCaptured', 'developments', 'bankruptcies', 'eventsSurvived', 'longestChain', 'highestCityValue']
      .map((k) => [k, recorded.totals[k]])),
    categories: recorded.categories,
    mayors: Object.fromEntries(Object.entries(recorded.mayors).map(([k, m]) => [k, { name: m.name, played: m.played, won: m.won, best: m.best }])),
    achievements: Object.fromEntries(Object.entries(recorded.achievements).filter(([id]) => id === 'first-ribbon' || id === 'veteran')),
    recent: recorded.recent,
  };
  v1.achievements.veteran = { by: 'Mayor 2', at: 5 };
  const storage = memoryStorage({ [CAREER_KEY]: JSON.stringify(v1) });
  const { career, corrupt } = loadCareer(storage);
  assert.equal(corrupt, false);
  assert.equal(career.version, 2);
  assert.equal(career.totals.matches, recorded.totals.matches);
  assert.deepEqual(career.totals.longestChain, recorded.totals.longestChain);
  assert.deepEqual([career.totals.takeovers, career.totals.daysPlayed], [0, 0], 'new totals start at zero');
  assert.deepEqual(career.achievements.veteran, { by: 'Mayor 2', at: 5 });
  for (const [k, m] of Object.entries(career.mayors)) {
    assert.deepEqual(m, { ...v1.mayors[k], streak: 0, bestStreak: 0, modeWins: { standard: 0, classic: 0, chaos: 0 } });
  }
  assert.deepEqual(career.streaks.day, { current: 0, best: 0, last: null });
  assert.equal(storage.getItem(CAREER_BACKUP_KEY), null, 'a valid old record is not "corrupt"');
  // Saved again as version 2, and still read back exactly.
  saveCareer(career, storage);
  assert.equal(JSON.parse(storage.getItem(CAREER_KEY)).version, 2);
  assert.deepEqual(loadCareer(storage).career, career);
  // A version 1 record must still be exactly version 1's shape.
  const bad = memoryStorage({ [CAREER_KEY]: JSON.stringify({ ...v1, mayors: { x: { name: 'X', played: 1, won: 2, best: 0 } } }) });
  assert.equal(loadCareer(bad).corrupt, true);
});

/** Plays a match road by road with `seats`, checking live achievements after every step. */
function liveRun(seed, seats, mode = 'standard') {
  let game = null;
  let career = emptyCareer();
  const unlocks = [];
  for (let roads = 1; ; roads++) {
    game = playthrough(api, { seats, seed, mode, gameType: seats.length === 4 ? 'standard' : 'custom' }, { stopAfterRoads: roads, game: game ?? undefined }).game;
    const before = liveFacts(game);
    const result = unlockLive(career, game, roads);
    for (const u of result.unlocked) unlocks.push({ ...u, roads, facts: before.find((p) => p.name === u.by) });
    career = result.career;
    if (game.phase !== 'playing') break;
  }
  return { game, career, unlocks };
}

test('live achievements unlock during genuine play: people only, once each, by a rule that holds', () => {
  const seats = [{ seat: 1, name: 'Ada' }, { seat: 2, controller: 'cpu', difficulty: 'hard' }, { seat: 3, name: 'Bo' }, { seat: 4, controller: 'cpu', difficulty: 'easy' }];
  const { game, career, unlocks } = liveRun(2024, seats);
  assert.ok(unlocks.length >= 3, `${unlocks.map((u) => u.id)}`);
  assert.equal(new Set(unlocks.map((u) => u.id)).size, unlocks.length, 'each once');
  for (const u of unlocks) {
    const def = getAchievement(u.id);
    assert.equal(def.live, true, `${u.id} is a live achievement`);
    assert.ok(['Ada', 'Bo'].includes(u.by), `${u.id}: credited to a person, not a bot (${u.by})`);
    assert.ok(def.test(u.facts, { live: true }, emptyCareer()), `${u.id}: its rule held for ${u.by}`);
    assert.deepEqual(career.achievements[u.id], { by: u.by, at: u.roads });
  }
  assert.ok(unlocks.some((u) => u.id === 'groundbreaking'));
  // Once the match is over, recording takes over: no live unlocks after the end.
  assert.equal(game.phase, 'ended');
  assert.deepEqual(unlockLive(emptyCareer(), game).unlocked, []);
  // Recording the match afterwards keeps every live unlock as it was and adds the rest.
  const recorded = recordMatch(career, game, at(10, 6));
  for (const u of unlocks) assert.deepEqual(recorded.career.achievements[u.id], career.achievements[u.id]);
  assert.ok(!recorded.unlocked.some((u) => career.achievements[u.id]), 'nothing is unlocked twice');
});

test('live facts match the recorded facts at the end of a match', () => {
  const game = play(2024, humans(4), 'standard');
  const final = summarizeMatch(game).players;
  for (const live of liveFacts(game)) {
    const p = final.find((x) => x.seat === live.seat);
    for (const key of LIVE_FACTS) assert.deepEqual(live[key], p[key], `${live.name}.${key}`);
  }
});

test('live rules read only live facts, and nothing of the match but its mode', () => {
  const p = summarizeMatch(play(2024, humans(4), 'standard')).players[0];
  const guard = (target, allowed, what) => new Proxy(target, {
    get(t, key) {
      if (typeof key === 'string' && !allowed.includes(key)) throw new Error(`${what}.${key} is not known mid-match`);
      return t[key];
    },
  });
  for (const a of ACHIEVEMENTS.filter((x) => x.live)) {
    assert.doesNotThrow(() => a.test(guard(p, LIVE_FACTS, 'p'), guard({ live: true, mode: 'standard' }, ['live', 'mode'], 'm'), emptyCareer()), a.id);
  }
  assert.ok(ACHIEVEMENTS.filter((a) => a.live).length >= 30);
});

test('staged play and unfinished staging unlock nothing live', () => {
  const { game } = playthrough(api, { seats: humans(2), seed: 5, gameType: 'custom' }, { stopAfterRoads: 60 });
  assert.ok(liveFacts(game).some((p) => p.captured > 0), 'someone has captured by now');
  assert.ok(unlockLive(emptyCareer(), game).unlocked.length > 0, 'genuine so far');
  const staged = structuredClone(game);
  const open = api.allRoadIds(staged.board).find((id) => !(id in staged.board.roads));
  staged.board.roads[open] = 1; // a road written onto the board, not played
  assert.deepEqual(unlockLive(emptyCareer(), staged).unlocked, []);
  const cash = structuredClone(game);
  cash.players[0].cash += 1000; // money behind the ledger's back
  assert.deepEqual(unlockLive(emptyCareer(), cash).unlocked, []);
  assert.deepEqual(unlockLive(emptyCareer(), null).unlocked, [], 'garbage never throws');
  // Everything live already earned: nothing to do.
  const all = emptyCareer();
  for (const a of ACHIEVEMENTS) all.achievements[a.id] = { by: 'X', at: 1 };
  const same = unlockLive(all, game);
  assert.equal(same.career, all);
});

test('tiers and points: a score out of the maximum', () => {
  assert.equal(MAX_POINTS, ACHIEVEMENTS.reduce((n, a) => n + pointsOf(a), 0));
  const tiers = new Set(ACHIEVEMENTS.map((a) => a.tier));
  assert.deepEqual([...tiers].sort(), ['bronze', 'gold', 'platinum', 'silver']);
  assert.ok(ACHIEVEMENTS.filter((a) => a.secret).every((a) => a.group === 'mischief' || a.group === 'streaks'), 'secrets are the mischief and odd-hour ones');
});
