/** Rule presets (GAME_MODES in config.js) resolved into the rules a game carries. */
import { GAME_MODES, DEFAULT_MODE } from '../config.js';

export const MODE_IDS = Object.freeze(Object.keys(GAME_MODES));

export function getMode(id) {
  return GAME_MODES[id] ?? null;
}

/**
 * The rules snapshot stored on a game (and in its autosave): a plain copy of the mode's
 * rules, with optional per-game overrides (tests use them to force or cap events).
 * @param {string} modeId
 * @param {{ eventProbability?: number, maxActiveEvents?: number }} [overrides]
 */
export function resolveRules(modeId = DEFAULT_MODE, { eventProbability, maxActiveEvents } = {}) {
  const mode = getMode(modeId);
  if (!mode) throw new RangeError(`Unknown game mode ${modeId}`);
  return {
    events: {
      ...mode.events,
      ...(eventProbability !== undefined && { probability: eventProbability, enabled: mode.events.enabled || eventProbability > 0 }),
      ...(maxActiveEvents !== undefined && { maxActive: maxActiveEvents }),
    },
  };
}

/** Event rules for a game; games saved before modes existed play by the standard rules. */
export function eventRules(game) {
  return game.rules?.events ?? GAME_MODES[DEFAULT_MODE].events;
}

/** Display name for a game's mode. */
export const modeName = (game) => (getMode(game?.mode) ?? GAME_MODES[DEFAULT_MODE]).name;
