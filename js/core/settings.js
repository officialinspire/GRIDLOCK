/** Persisted user settings. Storage failures (private mode etc.) are non-fatal. */
import { DEFAULT_SETTINGS } from '../config.js';

const KEY = 'gridlock.settings.v1';

export const BOOLEAN_SETTINGS = Object.freeze(['sound', 'ambience', 'confirmTaps', 'reducedMotion', 'showCoords', 'quickHandoff']);
export const VOLUME_SETTINGS = Object.freeze(['masterVolume', 'sfxVolume', 'ambienceVolume']);

/** Fills gaps with defaults (older saves keep working), keeps booleans, clamps volumes to whole 0–100. */
export function normalizeSettings(raw) {
  const out = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return out;
  for (const key of BOOLEAN_SETTINGS) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key];
  }
  for (const key of VOLUME_SETTINGS) {
    const value = typeof raw[key] === 'string' && raw[key].trim() !== '' ? Number(raw[key]) : raw[key];
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = Math.round(Math.min(100, Math.max(0, value)));
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
