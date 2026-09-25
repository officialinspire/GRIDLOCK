/** Persisted user settings. Storage failures (private mode etc.) are non-fatal. */
import { DEFAULT_SETTINGS } from '../config.js';

const KEY = 'gridlock.settings.v1';

const ALLOWED = {
  rounds: [8, 12, 16],
  startingCash: [1000, 1500, 2000],
};

export function normalizeSettings(raw) {
  const out = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return out;
  for (const key of ['sound', 'music', 'reducedMotion', 'showCoords']) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key];
  }
  for (const [key, allowed] of Object.entries(ALLOWED)) {
    const n = Number(raw[key]);
    if (allowed.includes(n)) out[key] = n;
  }
  return out;
}

export function loadSettings(storage = globalThis.localStorage) {
  try {
    return normalizeSettings(JSON.parse(storage?.getItem(KEY) ?? 'null'));
  } catch {
    return normalizeSettings(null);
  }
}

export function saveSettings(settings, storage = globalThis.localStorage) {
  try {
    storage?.setItem(KEY, JSON.stringify(normalizeSettings(settings)));
    return true;
  } catch {
    return false;
  }
}
