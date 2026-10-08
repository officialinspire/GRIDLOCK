/** Best-effort, anonymous game events. No SDK, storage, or network work on startup. */
import { APP_VERSION } from './config.js';

// A project token is public and can only send data; never put a personal API key here.
const TOKEN = 'phc_wpvFbvptidYWtnkJG8EdMMhaXn6s2ZDznzNUha5V4KRm';
const ENDPOINT = 'https://us.i.posthog.com/i/v0/e/';
const EVENTS = new Set([
  'game_opened', 'game_started', 'game_completed', 'game_over',
  'achievement_unlocked', 'error_encountered',
]);
const FIELDS = new Set(['score', 'high_score', 'round', 'difficulty', 'achievement', 'duration_seconds', 'mode', 'error_type', 'error_name', 'match_id', 'game_state', 'era', 'turn_phase']);
const seen = new Set();
let anonymousId;
let sequence = 0;
let getContext = () => ({});
let initialized = false;

function sessionId() {
  if (anonymousId) return anonymousId;
  try { anonymousId = globalThis.crypto?.randomUUID?.(); } catch { /* optional crypto */ }
  // Also works on older browsers; generated only inside trackGameEvent's safety guard.
  anonymousId ||= 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const n = Math.floor(Math.random() * 16);
    return (c === 'x' ? n : (n & 3) | 8).toString(16);
  });
  return anonymousId;
}

/** Read existing state only when an event occurs, without polling or writing saves. */
export function setAnalyticsContext(provider) {
  if (typeof provider === 'function') getContext = provider;
}

export function trackGameEvent(event, details = {}, once = null) {
  try {
    if (!EVENTS.has(event) || globalThis.navigator?.globalPrivacyControl === true || globalThis.navigator?.onLine === false) return;
    const key = once == null ? null : `${event}:${once}`;
    if (key && seen.has(key)) return;
    if (key) seen.add(key);
    const id = sessionId();
    const timestamp = new Date().toISOString(); // preserve occurrence time even if requests arrive out of order
    const properties = { brand: 'inspire', game: 'GRIDLOCK', game_version: APP_VERSION, $process_person_profile: false, $geoip_disable: true, $session_id: id, event_sequence: ++sequence };
    let context = {};
    try { context = getContext() ?? {}; } catch { /* context is optional */ }
    for (const [name, value] of Object.entries({ ...context, ...details })) {
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
          body: JSON.stringify({ api_key: TOKEN, distinct_id: id, event, properties, timestamp }),
        }).catch(() => {});
      } catch { /* analytics never affects the game */ }
    }, 0);
  } catch { /* analytics never affects the game */ }
}

export function initAnalytics() {
  try {
    if (initialized) return;
    initialized = true;
    // No raw messages, URLs, stacks, player names, or input values leave the browser.
    for (const [type, category] of [['error', 'uncaught_error'], ['unhandledrejection', 'unhandled_rejection']]) {
      try {
        globalThis.addEventListener?.(type, (event) => {
          try {
            const name = (event.error ?? event.reason)?.name;
            const error_name = ['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError'].includes(name) ? name : 'UnknownError';
            trackGameEvent('error_encountered', { error_type: category, error_name }, `${category}:${error_name}`);
          } catch { /* analytics never affects error handling */ }
        });
      } catch { /* error listeners are optional */ }
    }
    trackGameEvent('game_opened', {}, 'page-load');
  } catch { /* analytics never affects startup */ }
}
