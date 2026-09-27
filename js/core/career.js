/**
 * Career statistics and achievements for this device (pure logic; no DOM).
 *
 * - Only genuine completed matches count: every road was paved through play (move
 *   log), money reconciles with the ledger, and every owned or developed block can be
 *   traced to a logged capture, build or purchase. Games staged by tests or the
 *   ?debug hook fail these checks and are never recorded.
 * - Stored separately from the active-game save, versioned. Corrupt or unknown data
 *   loads as a fresh career (never throws); the raw data is kept aside, not lost.
 * - Hot-seat play: table-wide totals, plus per-mayor records keyed by name.
 */
import { ECONOMY, GAME_MODES } from '../config.js';
import { CATEGORY_ORDER } from './buildings.js';
import { allRoadIds, totalRoads } from './board.js';

export const CAREER_KEY = 'gridlock.career.v1';
export const CAREER_BACKUP_KEY = 'gridlock.career.corrupt';
export const CAREER_VERSION = 1;
const MAX_MAYORS = 60;
const MAX_RECENT = 25;

/**
 * Achievements: `test(player, match, career)` runs for each mayor after a match
 * (career = totals including that match). Earned once per device, with who and when.
 */
export const ACHIEVEMENTS = Object.freeze([
  { id: 'first-ribbon', name: 'Ribbon Cutting', text: 'Complete your first match.', icon: 'title:rosette', test: () => true },
  { id: 'mayor-of-the-year', name: 'Mayor of the Year', text: 'Win a match.', icon: 'icons:trophy', test: (p) => p.won },
  { id: 'chain-reaction', name: 'Chain Reaction', text: 'Capture 3 blocks in one chain.', icon: 'icons:road', test: (p) => p.longestChain >= 3 },
  { id: 'land-baron', name: 'Land Baron', text: 'Finish a match owning 10 or more blocks.', icon: 'icons:map', test: (p) => p.blocks >= 10 },
  { id: 'skyline', name: 'Skyline', text: 'Raise a building to Level 3.', icon: 'icons:building', test: (p) => p.maxLevel >= 3 },
  { id: 'master-builder', name: 'Master Builder', text: 'Build or upgrade 8 times in one match.', icon: 'icons:star', test: (p) => p.developments >= 8 },
  { id: 'big-city', name: 'Big City', text: 'Finish with a City Value of $40,000 or more.', icon: 'icons:coins', test: (p) => p.cityValue >= 40000 },
  { id: 'comeback', name: 'Comeback Kid', text: 'Win a match after declaring bankruptcy.', icon: 'icons:restart', test: (p) => p.won && p.bankruptcies > 0 },
  { id: 'storm-chaser', name: 'Storm Chaser', text: 'Complete an Urban Chaos match.', icon: 'icons:clock', test: (p, m) => m.mode === 'chaos' },
  { id: 'purist', name: 'Purist', text: 'Win a Classic match.', icon: 'icons:crown', test: (p, m) => p.won && m.mode === 'classic' },
  { id: 'photo-finish', name: 'Photo Finish', text: 'Share first place in a tie.', icon: 'icons:swap', test: (p, m) => p.won && m.tie },
  { id: 'veteran', name: 'Veteran Mayor', text: 'Complete 10 matches on this device.', icon: 'title:shield', test: (p, m, c) => c.totals.matches >= 10 },
]);

export function emptyCareer() {
  return {
    version: CAREER_VERSION,
    totals: {
      matches: 0, blocksCaptured: 0, developments: 0, bankruptcies: 0, eventsSurvived: 0,
      longestChain: { count: 0, by: null }, highestCityValue: { value: 0, by: null },
    },
    categories: Object.fromEntries(CATEGORY_ORDER.map((c) => [c, 0])),
    mayors: {},
    achievements: {},
    recent: [],
  };
}

/* ---------------- validation / persistence ---------------- */

const count = (v) => Number.isSafeInteger(v) && v >= 0;
const plain = (v) => v && typeof v === 'object' && !Array.isArray(v);
const text = (v) => typeof v === 'string' && v.length <= 40;
const nameOrNull = (v) => v === null || text(v);

/** A stored career, or null if it's not exactly the shape this version writes. */
export function validateCareer(raw) {
  if (!plain(raw) || raw.version !== CAREER_VERSION) return null;
  const t = raw.totals;
  if (!plain(t) || !['matches', 'blocksCaptured', 'developments', 'bankruptcies', 'eventsSurvived'].every((k) => count(t[k]))) return null;
  if (!plain(t.longestChain) || !count(t.longestChain.count) || !nameOrNull(t.longestChain.by)) return null;
  if (!plain(t.highestCityValue) || !Number.isSafeInteger(t.highestCityValue.value) || !nameOrNull(t.highestCityValue.by)) return null;
  if (!plain(raw.categories) || !CATEGORY_ORDER.every((c) => count(raw.categories[c]))) return null;
  if (!plain(raw.mayors) || Object.keys(raw.mayors).length > MAX_MAYORS) return null;
  for (const m of Object.values(raw.mayors)) {
    if (!plain(m) || !text(m.name) || !count(m.played) || !count(m.won) || m.won > m.played || !Number.isSafeInteger(m.best)) return null;
  }
  if (!plain(raw.achievements)) return null;
  const ids = new Set(ACHIEVEMENTS.map((a) => a.id));
  for (const [id, a] of Object.entries(raw.achievements)) {
    if (!ids.has(id) || !plain(a) || !text(a.by) || !count(a.at)) return null;
  }
  if (!Array.isArray(raw.recent) || raw.recent.length > MAX_RECENT || !raw.recent.every((id) => typeof id === 'string')) return null;
  const clean = emptyCareer();
  return {
    ...clean,
    totals: { ...t, longestChain: { ...t.longestChain }, highestCityValue: { ...t.highestCityValue } },
    categories: Object.fromEntries(CATEGORY_ORDER.map((c) => [c, raw.categories[c]])),
    mayors: Object.fromEntries(Object.entries(raw.mayors).map(([k, m]) => [k, { name: m.name, played: m.played, won: m.won, best: m.best }])),
    achievements: Object.fromEntries(Object.entries(raw.achievements).map(([k, a]) => [k, { by: a.by, at: a.at }])),
    recent: [...raw.recent],
  };
}

/**
 * Loads the career. Missing → fresh. Corrupt/unsupported → fresh too, with the raw text
 * copied to CAREER_BACKUP_KEY (once) so it isn't silently lost. Never throws.
 */
export function loadCareer(storage = globalThis.localStorage) {
  let raw = null;
  try {
    raw = storage?.getItem(CAREER_KEY) ?? null;
    if (raw == null) return { career: emptyCareer(), corrupt: false };
    const career = validateCareer(JSON.parse(raw));
    if (career) return { career, corrupt: false };
  } catch {
    // unreadable storage or invalid JSON: fall through
  }
  try {
    if (raw != null && storage?.getItem(CAREER_BACKUP_KEY) == null) storage.setItem(CAREER_BACKUP_KEY, raw);
  } catch {
    // backup is best effort
  }
  return { career: emptyCareer(), corrupt: raw != null };
}

export function saveCareer(career, storage = globalThis.localStorage) {
  try {
    storage?.setItem(CAREER_KEY, JSON.stringify(career));
    return true;
  } catch {
    return false;
  }
}

/* ---------------- genuine match check ---------------- */

/** True only for a match that really finished through play (see header). */
export function isGenuineMatch(game) {
  try {
    if (game?.phase !== 'ended' || !game.results || !GAME_MODES[game.mode ?? 'standard']) return false;
    const { board } = game;
    // Every road paved through placeRoad, exactly once, by the seat the board records.
    const roads = game.log.filter((e) => e.type === 'road');
    const ids = new Set(roads.map((e) => e.road));
    if (roads.length !== totalRoads(board) || ids.size !== roads.length) return false;
    if (!allRoadIds(board).every((id) => ids.has(id))) return false;
    if (roads.some((e) => board.roads[e.road] !== e.seat)) return false;
    // Money: every balance is exactly the starting cash plus its ledger.
    for (const p of game.players) {
      const sum = game.ledger.filter((e) => e.seat === p.seat).reduce((n, e) => n + e.delta, 0);
      if (p.cash !== ECONOMY.STARTING_CASH + sum) return false;
    }
    // Every owned or developed block traces back to a logged capture, build or purchase.
    const captured = new Set(roads.flatMap((e) => e.captured));
    const touched = new Set([...game.log, ...game.ledger].map((e) => e.block).filter(Boolean));
    for (const b of board.blocks) {
      if (b.ownerSeat != null && !captured.has(b.id) && !touched.has(b.id)) return false;
      if (b.level > 0 && !touched.has(b.id)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/* ---------------- match summary ---------------- */

/** Longest single-turn capture chain per seat, from the move log. */
function chainsBySeat(log) {
  const best = new Map();
  let seat = null;
  let run = 0;
  for (const e of log) {
    if (e.type !== 'road') continue;
    if (e.captured.length) {
      run = e.seat === seat ? run + e.captured.length : e.captured.length;
      seat = e.seat;
      best.set(seat, Math.max(best.get(seat) ?? 0, run));
    } else {
      seat = null;
      run = 0;
    }
  }
  return best;
}

/** Facts about a finished match that stats and achievements are computed from. */
export function summarizeMatch(game) {
  const chains = chainsBySeat(game.log);
  const winners = new Set(game.results.winners);
  const roads = game.log.filter((e) => e.type === 'road');
  const players = game.results.rows.map((row) => {
    const mine = (type) => game.log.filter((e) => e.type === type && e.seat === row.seat);
    const builds = mine('build');
    return {
      seat: row.seat,
      name: row.name,
      won: winners.has(row.seat),
      cityValue: row.cityValue,
      blocks: row.blocks,
      captured: roads.filter((e) => e.seat === row.seat).reduce((n, e) => n + e.captured.length, 0),
      longestChain: chains.get(row.seat) ?? 0,
      developments: builds.length + mine('upgrade').length,
      maxLevel: Math.max(0, ...[...builds, ...mine('upgrade')].map((e) => e.level)),
      categories: builds.reduce((acc, e) => ({ ...acc, [e.category]: (acc[e.category] ?? 0) + 1 }), {}),
      bankruptcies: row.bankruptcies,
    };
  });
  return {
    id: `${game.seed}:${game.mode ?? 'standard'}:${game.round}:${game.ledger.length}:${game.results.rows.map((r) => r.cityValue).join('/')}`,
    mode: game.mode ?? 'standard',
    tie: winners.size > 1,
    eventsSurvived: game.events.history.length,
    players,
  };
}

/* ---------------- recording ---------------- */

const mayorKey = (name) => name.trim().toLowerCase().slice(0, 40);

/**
 * Adds a genuine match to the career. Returns { career, unlocked, recorded }.
 * A match is never counted twice (by its id), and non-genuine games are ignored.
 */
export function recordMatch(career, game, now = Date.now()) {
  if (!isGenuineMatch(game)) return { career, unlocked: [], recorded: false };
  const match = summarizeMatch(game);
  if (career.recent.includes(match.id)) return { career, unlocked: [], recorded: false };

  const next = validateCareer(JSON.parse(JSON.stringify(career))) ?? emptyCareer();
  const t = next.totals;
  t.matches += 1;
  t.eventsSurvived += match.eventsSurvived;
  for (const p of match.players) {
    t.blocksCaptured += p.captured;
    t.developments += p.developments;
    t.bankruptcies += p.bankruptcies;
    if (p.longestChain > t.longestChain.count) t.longestChain = { count: p.longestChain, by: p.name };
    if (p.cityValue > t.highestCityValue.value) t.highestCityValue = { value: p.cityValue, by: p.name };
    for (const [category, n] of Object.entries(p.categories)) if (category in next.categories) next.categories[category] += n;
    const key = mayorKey(p.name);
    const m = next.mayors[key] ?? { name: p.name.slice(0, 40), played: 0, won: 0, best: 0 };
    m.played += 1;
    if (p.won) m.won += 1;
    m.best = Math.max(m.best, p.cityValue);
    next.mayors[key] = m;
  }
  // Keep the most active mayors if the table grows very large.
  const mayors = Object.entries(next.mayors).sort(([, a], [, b]) => b.played - a.played).slice(0, MAX_MAYORS);
  next.mayors = Object.fromEntries(mayors);
  next.recent = [...next.recent, match.id].slice(-MAX_RECENT);

  const unlocked = [];
  for (const a of ACHIEVEMENTS) {
    if (next.achievements[a.id]) continue;
    // Winners first, then seat order, so the credit is deterministic.
    const earner = [...match.players].sort((x, y) => Number(y.won) - Number(x.won) || x.seat - y.seat)
      .find((p) => a.test(p, match, next));
    if (earner) {
      next.achievements[a.id] = { by: earner.name.slice(0, 40), at: now };
      unlocked.push({ id: a.id, name: a.name, by: earner.name });
    }
  }
  return { career: next, unlocked, recorded: true };
}

/** Most-built development category over the career, or null before any building. */
export function favoriteCategory(career) {
  let best = null;
  for (const c of CATEGORY_ORDER) if (career.categories[c] > 0 && (!best || career.categories[c] > career.categories[best])) best = c;
  return best;
}
