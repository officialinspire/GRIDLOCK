/**
 * Who sits in each seat: a person ("human") or the computer ("cpu", with a difficulty).
 * Pure data and validation, no DOM. The rules engine never reads these fields: a seat's
 * controller only decides who makes its moves, never what the moves are allowed to be.
 */
import { PLAYER_PRESETS, MIN_PLAYERS, MAX_PLAYERS } from '../config.js';

export const CONTROLLERS = Object.freeze(['human', 'cpu']);
export const DIFFICULTIES = Object.freeze(['easy', 'normal', 'hard']);
export const DEFAULT_DIFFICULTY = 'normal';
export const DIFFICULTY_LABELS = Object.freeze({ easy: 'Easy', normal: 'Normal', hard: 'Hard' });

/** Table presets on the New Game screen. */
export const SEAT_PRESETS = Object.freeze({
  solo: Object.freeze({ id: 'solo', name: 'Solo', blurb: 'You against computer mayors (1 human, the rest CPU).' }),
  friends: Object.freeze({ id: 'friends', name: 'Local Friends', blurb: 'Everyone at the table plays, passing the device.' }),
  mixed: Object.freeze({ id: 'mixed', name: 'Mixed', blurb: 'Choose Human or CPU for each seat.' }),
});
export const DEFAULT_SEAT_PRESET = 'friends';

export const SEAT_ERRORS = Object.freeze({
  STANDARD_COUNT: 'Standard Game needs all 4 seats.',
  CUSTOM_COUNT: `Custom Game needs ${MIN_PLAYERS}–${MAX_PLAYERS} seats.`,
  BAD_SEAT: 'Unknown or repeated seat.',
  BAD_CONTROLLER: 'Each seat must be Human or CPU.',
  BAD_DIFFICULTY: 'CPU seats need Easy, Normal or Hard.',
  NO_HUMAN: 'At least one seat must be Human.',
});

/**
 * The controller fields a seat or player carries. Anything without a controller (games and
 * saves from before controllers existed, older tests) is a human seat.
 * Returns null for values that aren't a valid controller/difficulty pair.
 */
export function controllerOf(seat) {
  const controller = seat?.controller ?? 'human';
  if (controller === 'human') return seat?.difficulty == null ? { controller, difficulty: null } : null;
  if (controller !== 'cpu') return null;
  const difficulty = seat.difficulty ?? DEFAULT_DIFFICULTY;
  return DIFFICULTIES.includes(difficulty) ? { controller, difficulty } : null;
}

export const isCpu = (seat) => seat?.controller === 'cpu';

/** Default names: humans keep "Player N"; CPU seats are "Mayor Bot 1", "Mayor Bot 2", … in seat order. */
export function defaultNames(seats) {
  let bots = 0;
  return new Map([...seats].sort((a, b) => a.seat - b.seat).map((s) => [s.seat,
    isCpu(s) ? `Mayor Bot ${++bots}` : PLAYER_PRESETS[s.seat - 1]?.name ?? `Player ${s.seat}`]));
}

/** "CPU · Hard" style label, or null for a human. */
export function controllerLabel(seat) {
  return isCpu(seat) ? `CPU · ${DIFFICULTY_LABELS[seat.difficulty] ?? DIFFICULTY_LABELS[DEFAULT_DIFFICULTY]}` : null;
}

/**
 * Controllers for the joined seats under a preset. Solo: the first joined seat is human and
 * every other seat CPU (keeping any difficulty already chosen). Local Friends: all human.
 * Mixed: whatever each seat already says.
 */
export function applySeatPreset(preset, seats) {
  const sorted = [...seats].sort((a, b) => a.seat - b.seat);
  return sorted.map((s, i) => {
    if (preset === 'friends') return { ...s, controller: 'human', difficulty: null };
    if (preset === 'solo') {
      return i === 0 ? { ...s, controller: 'human', difficulty: null }
        : { ...s, controller: 'cpu', difficulty: DIFFICULTIES.includes(s.difficulty) ? s.difficulty : DEFAULT_DIFFICULTY };
    }
    return { ...s, ...(controllerOf(s) ?? { controller: 'human', difficulty: null }) };
  });
}

/** Which preset a table matches (for showing a restored or rematched setup). */
export function presetFor(seats) {
  const cpus = seats.filter(isCpu).length;
  if (cpus === 0) return 'friends';
  const first = [...seats].sort((a, b) => a.seat - b.seat)[0];
  return cpus === seats.length - 1 && !isCpu(first) ? 'solo' : 'mixed';
}

/**
 * Setup validation for New Game: seat count for the game type, valid distinct seats,
 * valid controllers, and at least one person at the table. Returns an error or null.
 */
export function validateSeats({ gameType = 'custom', seats } = {}) {
  if (!Array.isArray(seats)) return SEAT_ERRORS.CUSTOM_COUNT;
  if (gameType === 'standard' && seats.length !== MAX_PLAYERS) return SEAT_ERRORS.STANDARD_COUNT;
  if (seats.length < MIN_PLAYERS || seats.length > MAX_PLAYERS) return SEAT_ERRORS.CUSTOM_COUNT;
  const seen = new Set();
  for (const s of seats) {
    if (!PLAYER_PRESETS.some((p) => p.seat === s?.seat) || seen.has(s.seat)) return SEAT_ERRORS.BAD_SEAT;
    seen.add(s.seat);
    if (!CONTROLLERS.includes(s.controller ?? 'human')) return SEAT_ERRORS.BAD_CONTROLLER;
    if (!controllerOf(s)) return s.controller === 'cpu' ? SEAT_ERRORS.BAD_DIFFICULTY : SEAT_ERRORS.BAD_CONTROLLER;
  }
  if (!seats.some((s) => !isCpu(s))) return SEAT_ERRORS.NO_HUMAN;
  return null;
}
