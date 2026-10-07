/** Best-effort, anonymous game events. No SDK, storage, or network work on startup. */
import { APP_VERSION } from './config.js';

// A project token is public and can only send data; never put a personal API key here.
const TOKEN = 'phc_wpvFbvptidYWtnkJG8EdMMhaXn6s2ZDznzNUha5V4KRm';
const ENDPOINT = 'https://us.i.posthog.com/i/v0/e/';
const EVENTS = new Set([
  'game_opened', 'game_started', 'game_completed', 'game_over',
  'achievement_unlocked', 'error_encountered',
]);
const FIELDS = new Set(['score', 'high_score', 'round', 'difficulty', 'achievement', 'duration_seconds', 'mode', 'error_type']);
const seen = new Set();
const anonymousId = globalThis.crypto?.randomUUID?.() ?? `gridlock-${Math.random().toString(36).slice(2)}`;
let initialized = false;

export function trackGameEvent(event, details = {}, once = null) {
  try {
    if (!EVENTS.has(event) || globalThis.navigator?.globalPrivacyControl === true || globalThis.navigator?.onLine === false) return;
    const key = once == null ? null : `${event}:${once}`;
    if (key && seen.has(key)) return;
    if (key) seen.add(key);
    const properties = { brand: 'inspire', game: 'GRIDLOCK', game_version: APP_VERSION, $process_person_profile: false };
    for (const [name, value] of Object.entries(details)) {
      if (!FIELDS.has(name)) continue;
      if (typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' && value.length <= 60) properties[name] = value;
    }
    // A zero-delay task leaves gameplay and startup free to continue before any network work.
    globalThis.setTimeout(() => {
      try {
        if (typeof globalThis.fetch !== 'function') return;
        void globalThis.fetch(ENDPOINT, {
          method: 'POST', mode: 'cors', credentials: 'omit', keepalive: true,
          referrerPolicy: 'no-referrer', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_key: TOKEN, distinct_id: anonymousId, event, properties }),
        }).catch(() => {});
      } catch { /* analytics never affects the game */ }
    }, 0);
  } catch { /* analytics never affects the game */ }
}

export function initAnalytics() {
  if (initialized || typeof globalThis.addEventListener !== 'function') return;
  initialized = true;
  // No raw messages, URLs, stacks, player names, or input values leave the browser.
  globalThis.addEventListener('error', () => trackGameEvent('error_encountered', { error_type: 'uncaught_error' }, 'uncaught-error'));
  globalThis.addEventListener('unhandledrejection', () => trackGameEvent('error_encountered', { error_type: 'unhandled_rejection' }, 'unhandled-rejection'));
  trackGameEvent('game_opened', {}, 'page-load');
}
