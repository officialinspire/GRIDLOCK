/**
 * Career statistics, streaks and achievements for this device (pure logic; no DOM).
 * The 100 achievement definitions live in core/achievements.js.
 *
 * - Only genuine play counts: every road was paved through play (move log), money reconciles
 *   with the ledger, and every owned or developed block can be traced to a logged capture,
 *   build or purchase. Games staged by tests or the ?debug hook fail these checks and are never
 *   recorded or rewarded.
 * - Career totals, records and streaks count genuinely *completed* matches. Achievements marked
 *   `live` also unlock mid-match, the moment a person earns them (unlockLive), while the play so
 *   far is genuine; every rule runs again when the match is recorded.
 * - Stored separately from the active-game save, versioned. Version 1 records (V1.2–V1.4) are
 *   migrated; corrupt or unknown data loads as a fresh career (never throws) and the raw data is
 *   kept aside, not lost.
 * - Hot-seat play: table-wide totals, plus per-mayor records keyed by name. Only human seats
 *   count: CPU mayors never add to the totals, records, streaks or achievements.
 */
import { ECONOMY, GAME_MODES } from '../config.js';
import { CATEGORY_ORDER } from './buildings.js';
import { allRoadIds, totalRoads, neighbors } from './board.js';
import { components, BONUS } from './bonuses.js';
import { controlStrength, isActive } from './strategy.js';
import { isCpu } from './seats.js';
import { ACHIEVEMENTS, mayorKey } from './achievements.js';
import { periodsOf, STREAK_KINDS } from './calendar.js';

export { ACHIEVEMENTS, GOALS } from './achievements.js';

/** The top building level (ECONOMY.DEVELOPMENT.MAX_LEVEL), for the level badges. */
const TOP_LEVEL = ECONOMY.DEVELOPMENT.MAX_LEVEL;

/** Storage key (named before schema 2; kept so existing records carry over). */
export const CAREER_KEY = 'gridlock.career.v1';
export const CAREER_BACKUP_KEY = 'gridlock.career.corrupt';
/**
 * Schema versions:
 *   1  V1.2–V1.4: totals, categories, mayors (played/won/best), achievements, recent matches
 *   2  V1.5: + takeover and play-day totals, mayor win streaks and wins per rule set, daily /
 *      weekly / monthly play streaks and today's match count (100 achievements)
 */
export const CAREER_VERSION = 2;
const MAX_MAYORS = 60;
const MAX_RECENT = 25;
const MODE_IDS = Object.keys(GAME_MODES);

const emptyStreak = () => ({ current: 0, best: 0, last: null });
const emptyModes = () => Object.fromEntries(MODE_IDS.map((m) => [m, 0]));

export function emptyCareer() {
  return {
    version: CAREER_VERSION,
    totals: {
      matches: 0, blocksCaptured: 0, developments: 0, bankruptcies: 0, eventsSurvived: 0, takeovers: 0, daysPlayed: 0,
      longestChain: { count: 0, by: null }, highestCityValue: { value: 0, by: null },
    },
    categories: Object.fromEntries(CATEGORY_ORDER.map((c) => [c, 0])),
    mayors: {},
    achievements: {},
    recent: [],
    streaks: Object.fromEntries(STREAK_KINDS.map((k) => [k, emptyStreak()])),
    today: { day: null, matches: 0 },
  };
}

/* ---------------- validation / persistence ---------------- */

const count = (v) => Number.isSafeInteger(v) && v >= 0;
const plain = (v) => v && typeof v === 'object' && !Array.isArray(v);
const text = (v) => typeof v === 'string' && v.length <= 40;
const nameOrNull = (v) => v === null || text(v);
const periodOrNull = (v) => v === null || Number.isSafeInteger(v);
const V1_TOTALS = ['matches', 'blocksCaptured', 'developments', 'bankruptcies', 'eventsSurvived'];

function validMayor(m, v1) {
  if (!plain(m) || !text(m.name) || !count(m.played) || !count(m.won) || m.won > m.played || !Number.isSafeInteger(m.best)) return false;
  if (v1) return true;
  if (!count(m.streak) || !count(m.bestStreak) || m.streak > m.bestStreak || m.bestStreak > m.won) return false;
  return plain(m.modeWins) && MODE_IDS.every((k) => count(m.modeWins[k])) && MODE_IDS.reduce((n, k) => n + m.modeWins[k], 0) <= m.won;
}

/**
 * A stored career as this version writes it, or null if it isn't exactly the shape of
 * version 2 or (migrated here) version 1.
 */
export function validateCareer(raw) {
  if (!plain(raw) || ![1, CAREER_VERSION].includes(raw.version)) return null;
  const v1 = raw.version === 1;
  const t = raw.totals;
  if (!plain(t) || ![...V1_TOTALS, ...(v1 ? [] : ['takeovers', 'daysPlayed'])].every((k) => count(t[k]))) return null;
  if (!plain(t.longestChain) || !count(t.longestChain.count) || !nameOrNull(t.longestChain.by)) return null;
  if (!plain(t.highestCityValue) || !Number.isSafeInteger(t.highestCityValue.value) || !nameOrNull(t.highestCityValue.by)) return null;
  if (!plain(raw.categories) || !CATEGORY_ORDER.every((c) => count(raw.categories[c]))) return null;
  if (!plain(raw.mayors) || Object.keys(raw.mayors).length > MAX_MAYORS) return null;
  if (!Object.values(raw.mayors).every((m) => validMayor(m, v1))) return null;
  if (!plain(raw.achievements)) return null;
  const ids = new Set(ACHIEVEMENTS.map((a) => a.id));
  for (const [id, a] of Object.entries(raw.achievements)) {
    if (!ids.has(id) || !plain(a) || !text(a.by) || !count(a.at)) return null;
  }
  if (!Array.isArray(raw.recent) || raw.recent.length > MAX_RECENT || !raw.recent.every((id) => typeof id === 'string')) return null;
  if (!v1) {
    if (!plain(raw.streaks)) return null;
    for (const kind of STREAK_KINDS) {
      const s = raw.streaks[kind];
      if (!plain(s) || !count(s.current) || !count(s.best) || s.current > s.best || !periodOrNull(s.last)) return null;
    }
    if (!plain(raw.today) || !periodOrNull(raw.today.day) || !count(raw.today.matches)) return null;
  }
  const clean = emptyCareer();
  return {
    ...clean,
    totals: {
      ...clean.totals,
      ...Object.fromEntries(Object.keys(clean.totals).filter((k) => count(t[k])).map((k) => [k, t[k]])),
      longestChain: { count: t.longestChain.count, by: t.longestChain.by },
      highestCityValue: { value: t.highestCityValue.value, by: t.highestCityValue.by },
    },
    categories: Object.fromEntries(CATEGORY_ORDER.map((c) => [c, raw.categories[c]])),
    mayors: Object.fromEntries(Object.entries(raw.mayors).map(([k, m]) => [k, {
      name: m.name, played: m.played, won: m.won, best: m.best,
      // Version 1 kept no streaks or wins per rule set: they start from this version.
      streak: v1 ? 0 : m.streak,
      bestStreak: v1 ? 0 : m.bestStreak,
      modeWins: v1 ? emptyModes() : Object.fromEntries(MODE_IDS.map((mode) => [mode, m.modeWins[mode]])),
    }])),
    achievements: Object.fromEntries(Object.entries(raw.achievements).map(([k, a]) => [k, { by: a.by, at: a.at }])),
    recent: [...raw.recent],
    streaks: v1 ? clean.streaks : Object.fromEntries(STREAK_KINDS.map((k) => [k, { ...raw.streaks[k] }])),
    today: v1 ? clean.today : { day: raw.today.day, matches: raw.today.matches },
  };
}

/**
 * Loads the career. Missing → fresh. Version 1 → migrated. Corrupt/unsupported → fresh too, with
 * the raw text copied to CAREER_BACKUP_KEY (once) so it isn't silently lost. Never throws.
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

/** A deep, validated copy to change (a fresh career if the input isn't a valid one). */
const copyOf = (career) => validateCareer(JSON.parse(JSON.stringify(career))) ?? emptyCareer();

/* ---------------- genuine play check ---------------- */

/**
 * True while a game has only ever been changed through play (see header), finished or not:
 * every paved road is logged once with the seat the board records, every balance is the starting
 * cash plus its ledger, and every owned or developed block traces back to a logged capture,
 * build or purchase.
 */
export function isGenuinePlay(game) {
  try {
    if (!game?.board || !Array.isArray(game.log) || !Array.isArray(game.ledger) || !GAME_MODES[game.mode ?? 'standard']) return false;
    const { board } = game;
    const roads = game.log.filter((e) => e.type === 'road');
    const ids = new Set(roads.map((e) => e.road));
    if (ids.size !== roads.length || Object.keys(board.roads).length !== roads.length) return false;
    if (roads.some((e) => board.roads[e.road] !== e.seat)) return false;
    for (const p of game.players) {
      const sum = game.ledger.filter((e) => e.seat === p.seat).reduce((n, e) => n + e.delta, 0);
      if (p.cash !== ECONOMY.STARTING_CASH + sum) return false;
    }
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

/** True only for a match that really finished through play: genuine, every road paved, results frozen. */
export function isGenuineMatch(game) {
  try {
    if (game?.phase !== 'ended' || !game.results) return false;
    const paved = new Set(game.log.filter((e) => e.type === 'road').map((e) => e.road));
    return allRoadIds(game.board).every((id) => paved.has(id)) && paved.size === totalRoads(game.board) && isGenuinePlay(game);
  } catch {
    return false;
  }
}

/* ---------------- facts ---------------- */

const blankPlay = () => ({
  captured: 0, longestChain: 0, doubleCaptures: 0, roads: 0, finalRoad: false,
  developments: 0, maxLevel: 0, categories: {}, topLandmark: false,
  takeovers: 0, takeoversLost: 0, mostFromOneRival: 0, evictions: 0, payback: false, reclaimed: false,
  sales: 0, topLevelSales: 0, bankruptcies: 0, neverInDebt: true,
  acquired: 0, contestedWins: 0, restored: 0, vulture: false, idleCityTurns: 0,
});

/**
 * What each seat has done so far, read in order from the move log and the ledger (works
 * mid-match too). Map seat → facts:
 *   captured, longestChain (single-turn capture run), doubleCaptures (roads closing two blocks),
 *   roads, finalRoad (paved the city's last road), developments (builds + upgrades), maxLevel,
 *   categories (builds per category), topLandmark (a Landmark raised to the top level),
 *   takeovers, takeoversLost, mostFromOneRival, evictions (Residential taken over), payback (took
 *   a block from a mayor who had taken one of theirs), reclaimed (took back a block taken from
 *   them), sales (sales + downgrades), topLevelSales, bankruptcies, neverInDebt (balance never
 *   below $0), acquired (abandoned blocks bought, at auction or outright), contestedWins
 *   (auctions won against another bid), restored (restore mode), vulture (bought land another
 *   mayor abandoned), idleCityTurns (City turns ended with every City Action unspent).
 */
function playFacts(game) {
  const facts = new Map(game.players.map((p) => [p.seat, blankPlay()]));
  const blank = blankPlay(); // sink for entries without a known seat
  const of = (seat) => facts.get(seat) ?? blank;
  let runSeat = null;
  let run = 0;
  let lastRoad = null;
  const takers = new Map(); // victim seat → seats that took a block from them
  const lost = new Map(); // victim seat → blocks taken from them
  const taken = new Map(); // `${taker}>${victim}` → count
  const abandonedBy = new Map(); // block → seat whose bankruptcy abandoned it
  const fullBudget = game.city?.actionsPerTurn ?? 0;
  for (const e of game.log) {
    const me = of(e.seat);
    switch (e.type) {
      case 'road': {
        me.roads += 1;
        lastRoad = e.seat;
        const n = e.captured.length;
        if (n) {
          me.captured += n;
          if (n >= 2) me.doubleCaptures += 1;
          run = e.seat === runSeat ? run + n : n;
          runSeat = e.seat;
          me.longestChain = Math.max(me.longestChain, run);
        } else {
          runSeat = null;
          run = 0;
        }
        break;
      }
      case 'build':
      case 'upgrade':
        me.developments += 1;
        me.maxLevel = Math.max(me.maxLevel, e.level ?? 0);
        if (e.type === 'build') me.categories[e.category] = (me.categories[e.category] ?? 0) + 1;
        if (e.category === 'landmark' && e.level >= TOP_LEVEL) me.topLandmark = true;
        break;
      case 'sale':
      case 'downgrade':
        me.sales += 1;
        if (e.fromLevel >= TOP_LEVEL) me.topLevelSales += 1;
        break;
      case 'takeover': {
        me.takeovers += 1;
        of(e.from).takeoversLost += 1;
        const key = `${e.seat}>${e.from}`;
        taken.set(key, (taken.get(key) ?? 0) + 1);
        me.mostFromOneRival = Math.max(me.mostFromOneRival, taken.get(key));
        if (e.category === 'residential') me.evictions += 1;
        if (takers.get(e.seat)?.has(e.from)) me.payback = true;
        if (lost.get(e.seat)?.has(e.block)) me.reclaimed = true;
        if (!takers.has(e.from)) takers.set(e.from, new Set());
        takers.get(e.from).add(e.seat);
        if (!lost.has(e.from)) lost.set(e.from, new Set());
        lost.get(e.from).add(e.block);
        break;
      }
      case 'bankruptcy':
        me.bankruptcies += 1;
        for (const id of e.abandoned ?? []) abandonedBy.set(id, e.seat);
        break;
      case 'redevelopment-auction':
      case 'acquire':
        me.acquired += 1;
        if (e.type === 'redevelopment-auction' && e.bids >= 2) me.contestedWins += 1;
        if (e.mode === 'restore') me.restored += 1;
        if (abandonedBy.has(e.block) && abandonedBy.get(e.block) !== e.seat) me.vulture = true;
        break;
      case 'city-turn':
        if (fullBudget > 0 && e.unused >= fullBudget) me.idleCityTurns += 1;
        break;
      default:
        break;
    }
  }
  if (lastRoad != null && Object.keys(game.board.roads).length === totalRoads(game.board)) of(lastRoad).finalRoad = true;
  for (const e of game.ledger) if (e.balance < 0) of(e.seat).neverInDebt = false;
  return facts;
}

/** The board's districts, each a list of its blocks. */
function districtsOf(board) {
  const districts = new Map();
  for (const b of board.blocks) districts.set(b.district, [...(districts.get(b.district) ?? []), b]);
  return [...districts.values()];
}

const holds = (b, seat) => b.ownerSeat === seat && !b.abandoned;

/** Whole districts a seat owns right now. */
const districtsOwned = (board, seat) => districtsOf(board).filter((blocks) => blocks.every((b) => holds(b, seat))).length;

/**
 * A mayor's end-of-match city, read from the frozen board, log and ledger (deterministic):
 * mixed-use, building types, Level 3 factories, civic shelter, the largest park network, whole
 * districts, income, Prestige, levels, the weakest control, vacant lots, a factory beside a
 * rival's home, and holding the one block that keeps a rival from a whole district.
 */
function boardFacts(game, row) {
  const { board } = game;
  const seat = row.seat;
  const owned = board.blocks.filter((b) => holds(b, seat));
  const developed = owned.filter((b) => b.level > 0 && b.type !== 'vacant');
  const parks = components(board, (b) => holds(b, seat) && b.level > 0 && b.type === 'park');
  const districts = districtsOf(board);
  const owners = (blocks) => new Set(blocks.map((b) => (b.abandoned ? null : b.ownerSeat)));
  const wholes = districtsOwned(board, seat);
  return {
    mixedUse: developed.some((b) => (b.bonuses ?? []).some((x) => x.id === BONUS.MIXED_USE)),
    categoryTypes: new Set(developed.map((b) => b.type)).size,
    industrialL3: developed.filter((b) => b.type === 'industrial' && b.level === TOP_LEVEL).length,
    sheltered: owned.filter((b) => (b.protectedBy ?? []).length > 0).length,
    parkNetwork: Math.max(0, ...parks.map((group) => group.length)),
    districtsOwned: wholes,
    fullDistrict: wholes > 0,
    income: row.income,
    prestige: row.prestige,
    totalLevels: row.totalLevels,
    minControl: owned.length ? Math.min(...owned.map((b) => controlStrength(board, b).control)) : 0,
    vacantLots: owned.length - developed.length,
    badNeighbour: developed.some((b) => b.type === 'industrial'
      && neighbors(board, b).some((n) => isActive(n) && n.ownerSeat !== seat && n.type === 'residential')),
    holdout: districts.some((blocks) => {
      const mine = blocks.filter((b) => holds(b, seat));
      if (mine.length !== 1 || blocks.length < 3) return false;
      const rest = owners(blocks.filter((b) => b !== mine[0]));
      const [rival] = rest;
      return rest.size === 1 && rival != null && rival !== seat;
    }),
  };
}

/** Facts about a finished match that stats and achievements are computed from. */
export function summarizeMatch(game) {
  const play = playFacts(game);
  const winners = new Set(game.results.winners);
  const rows = game.results.rows;
  const players = rows.map((row) => {
    const player = game.players.find((p) => p.seat === row.seat);
    const rival = Math.max(...rows.filter((r) => r.seat !== row.seat).map((r) => r.cityValue));
    return {
      seat: row.seat,
      name: row.name,
      cpu: isCpu(player),
      difficulty: isCpu(player) ? player.difficulty ?? null : null,
      won: winners.has(row.seat),
      rank: row.rank,
      cityValue: row.cityValue,
      margin: Number.isFinite(rival) ? row.cityValue - rival : 0,
      cash: row.cash,
      blocks: row.blocks,
      developed: row.developed,
      ...play.get(row.seat),
      bankruptcies: row.bankruptcies,
      ...boardFacts(game, row),
    };
  });
  return {
    id: `${game.seed}:${game.mode ?? 'standard'}:${game.round}:${game.ledger.length}:${rows.map((r) => r.cityValue).join('/')}`,
    seed: game.seed,
    mode: game.mode ?? 'standard',
    tie: winners.size > 1,
    cityEra: game.era === 'city',
    eventsSurvived: game.events.history.length,
    humans: players.filter((p) => !p.cpu).length,
    players,
  };
}

/**
 * Each person's facts mid-match (the LIVE_FACTS in core/achievements.js): the play so far plus
 * the whole districts they own right now. CPU seats are left out.
 */
export function liveFacts(game) {
  const play = playFacts(game);
  return game.players.filter((p) => !isCpu(p)).map((p) => {
    const wholes = districtsOwned(game.board, p.seat);
    return { seat: p.seat, name: p.name, cpu: false, difficulty: null, ...play.get(p.seat), districtsOwned: wholes, fullDistrict: wholes > 0 };
  });
}

/* ---------------- unlocking ---------------- */

/** Unlocks each not-yet-earned achievement in `defs` for the first of `people` it fits. */
function unlock(career, defs, people, match, now) {
  const unlocked = [];
  for (const a of defs) {
    if (career.achievements[a.id]) continue;
    const earner = people.find((p) => a.test(p, match, career));
    if (!earner) continue;
    career.achievements[a.id] = { by: earner.name.slice(0, 40), at: now };
    unlocked.push({ id: a.id, name: a.name, by: earner.name });
  }
  return unlocked;
}

/**
 * Live achievements earned so far in a match still being played. Returns { career, unlocked }
 * (the same career when nothing new unlocked). Only while the play is genuine; only people.
 * Credit goes to the mayor on turn first (they just moved), then seat order.
 */
export function unlockLive(career, game, now = Date.now()) {
  try {
    if (game?.phase !== 'playing') return { career, unlocked: [] };
    const todo = ACHIEVEMENTS.filter((a) => a.live && !career.achievements[a.id]);
    if (!todo.length || !isGenuinePlay(game)) return { career, unlocked: [] };
    const onTurn = game.players[game.turnIndex]?.seat;
    const people = liveFacts(game).sort((a, b) => Number(b.seat === onTurn) - Number(a.seat === onTurn) || a.seat - b.seat);
    const match = { live: true, mode: game.mode ?? 'standard' };
    if (!todo.some((a) => people.some((p) => a.test(p, match, career)))) return { career, unlocked: [] };
    const next = copyOf(career);
    return { career: next, unlocked: unlock(next, todo, people, match, now) };
  } catch {
    return { career, unlocked: [] };
  }
}

/* ---------------- recording ---------------- */

/** Moves a play streak on to `period` (unchanged if it already counted this period). */
function extendStreak(s, period) {
  if (s.last === period) return;
  s.current = s.last === period - 1 ? s.current + 1 : 1;
  s.last = period;
  s.best = Math.max(s.best, s.current);
}

/**
 * Adds a genuine match to the career. Returns { career, unlocked, recorded, match }.
 * A match is never counted twice (by its id), and non-genuine games are ignored. `now` dates the
 * match for the daily / weekly / monthly streaks (local time).
 */
export function recordMatch(career, game, now = Date.now()) {
  if (!isGenuineMatch(game)) return { career, unlocked: [], recorded: false };
  const summary = summarizeMatch(game);
  if (career.recent.includes(summary.id)) return { career, unlocked: [], recorded: false };

  const next = copyOf(career);
  const clock = { ...periodsOf(now), previousDay: next.streaks.day.last };
  const match = { ...summary, clock, seenSeed: next.recent.some((id) => id.split(':')[0] === String(game.seed)) };
  const t = next.totals;
  t.matches += 1;
  t.eventsSurvived += match.eventsSurvived;
  // The career belongs to the people at the table: CPU seats' play, records and badges don't count.
  const people = match.players.filter((p) => !p.cpu);
  for (const p of people) {
    t.blocksCaptured += p.captured;
    t.developments += p.developments;
    t.bankruptcies += p.bankruptcies;
    t.takeovers += p.takeovers;
    if (p.longestChain > t.longestChain.count) t.longestChain = { count: p.longestChain, by: p.name };
    if (p.cityValue > t.highestCityValue.value) t.highestCityValue = { value: p.cityValue, by: p.name };
    for (const [category, n] of Object.entries(p.categories)) if (category in next.categories) next.categories[category] += n;
    const key = mayorKey(p.name);
    const m = next.mayors[key] ?? { name: p.name.slice(0, 40), played: 0, won: 0, best: 0, streak: 0, bestStreak: 0, modeWins: emptyModes() };
    m.played += 1;
    m.best = Math.max(m.best, p.cityValue);
    if (p.won) {
      m.won += 1;
      m.streak += 1;
      m.bestStreak = Math.max(m.bestStreak, m.streak);
      if (match.mode in m.modeWins) m.modeWins[match.mode] += 1;
    } else {
      m.streak = 0;
    }
    next.mayors[key] = m;
  }
  // Keep the most active mayors if the table grows very large.
  const mayors = Object.entries(next.mayors).sort(([, a], [, b]) => b.played - a.played).slice(0, MAX_MAYORS);
  next.mayors = Object.fromEntries(mayors);
  next.recent = [...next.recent, match.id].slice(-MAX_RECENT);

  // Play streaks: a completed match keeps today, this week and this month going.
  if (next.streaks.day.last !== clock.day) t.daysPlayed += 1;
  for (const kind of STREAK_KINDS) extendStreak(next.streaks[kind], clock[kind]);
  next.today = next.today.day === clock.day ? { day: clock.day, matches: next.today.matches + 1 } : { day: clock.day, matches: 1 };

  // Winners first, then seat order, so the credit is deterministic.
  const order = [...people].sort((x, y) => Number(y.won) - Number(x.won) || x.seat - y.seat);
  const unlocked = unlock(next, ACHIEVEMENTS, order, match, now);
  return { career: next, unlocked, recorded: true, match };
}

/** Most-built development category over the career, or null before any building. */
export function favoriteCategory(career) {
  let best = null;
  for (const c of CATEGORY_ORDER) if (career.categories[c] > 0 && (!best || career.categories[c] > career.categories[best])) best = c;
  return best;
}
