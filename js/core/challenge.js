/**
 * Replayable cities. A game's seed drives every city-event roll (core/rng.js), so the
 * seed + rule preset + seats at the table are all it takes to deal the same city again.
 * Challenge links carry exactly those three: ?seed=123&mode=chaos&seats=124.
 * Pure functions: no DOM, safe to unit test.
 */
import { GAME_MODES, DEFAULT_MODE, PLAYER_PRESETS, MIN_PLAYERS, MAX_PLAYERS } from '../config.js';

export const MAX_SEED = 0xffffffff;
/** Query parameters a challenge link owns (anything else, e.g. ?debug, is left alone). */
export const CHALLENGE_PARAMS = Object.freeze(['seed', 'mode', 'seats']);

/** "123", " #123 ", 123 → 123; anything else (blank, negative, decimals, > 32 bits) → null. */
export function parseSeed(raw) {
  if (typeof raw === 'number') return Number.isInteger(raw) && raw >= 0 && raw <= MAX_SEED ? raw : null;
  if (typeof raw !== 'string') return null;
  const text = raw.trim().replace(/^#/, '');
  if (!/^\d{1,10}$/.test(text)) return null;
  const n = Number(text);
  return n <= MAX_SEED ? n : null;
}

export const formatSeed = (seed) => String(seed >>> 0);

/** "124" → [1, 2, 4]; null unless it names 2–4 distinct valid seats. */
export function parseSeats(raw) {
  if (typeof raw !== 'string' || !/^[1-9]{2,4}$/.test(raw)) return null;
  const seats = [...new Set([...raw].map(Number))].sort((a, b) => a - b);
  if (seats.length !== raw.length || seats.length < MIN_PLAYERS || seats.length > MAX_PLAYERS) return null;
  return seats.every((s) => PLAYER_PRESETS.some((p) => p.seat === s)) ? seats : null;
}

/**
 * Reads a challenge from a query string. Returns null when there is no ?seed at all,
 * { invalid: true } for a malformed seed, else { seed, mode, seats } where an unknown
 * mode or seat list comes back as null (the setup screen keeps its own choice).
 */
export function readChallenge(search) {
  const params = new URLSearchParams(search);
  if (!params.has('seed')) return null;
  const seed = parseSeed(params.get('seed'));
  if (seed == null) return { invalid: true };
  const mode = params.get('mode');
  return { seed, mode: Object.hasOwn(GAME_MODES, mode ?? '') ? mode : null, seats: parseSeats(params.get('seats')) };
}

/** The same address with the challenge parameters removed; other parameters are kept verbatim. */
export function withoutChallenge(href) {
  const url = new URL(href);
  const keep = url.search.slice(1).split('&').filter((part) => {
    if (!part) return false;
    const key = part.split('=')[0];
    try { return !CHALLENGE_PARAMS.includes(decodeURIComponent(key.replace(/\+/g, ' '))); } catch { return true; }
  });
  url.search = keep.length ? `?${keep.join('&')}` : '';
  return url.href;
}

/**
 * Shareable link for a game (or a setup with a seed). Built from the page's own address
 * minus its query and hash, so nothing else in the current URL (e.g. ?debug) leaks out.
 */
export function challengeUrl({ seed, mode = DEFAULT_MODE, seats }, pageHref) {
  const url = new URL(pageHref);
  url.search = '';
  url.hash = '';
  url.searchParams.set('seed', formatSeed(seed));
  url.searchParams.set('mode', mode);
  url.searchParams.set('seats', seats.map((s) => s.seat ?? s).sort((a, b) => a - b).join(''));
  return url.href;
}

/** A setup that deals the exact same city as `game`: same seed, rules, seats and names. */
export function replaySetup(game, setup = {}) {
  const seats = game.players.map(({ seat, name }) => ({ seat, name }));
  return {
    ...setup,
    seats,
    mode: game.mode ?? DEFAULT_MODE,
    gameType: setup.gameType === 'standard' && seats.length === MAX_PLAYERS ? 'standard' : 'custom',
    seed: game.seed,
  };
}
