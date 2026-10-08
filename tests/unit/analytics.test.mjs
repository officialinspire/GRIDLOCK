import assert from 'node:assert/strict';
import { test } from 'node:test';
import { trackGameEvent } from '../../js/analytics.js';

test('analytics is deferred, allowlisted, anonymous, and deduplicated', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (...args) => { calls.push(args); return Promise.resolve({ ok: true }); };
  try {
    trackGameEvent('game_completed', {
      mode: 'standard', score: 123, round: 6,
      name: 'Private mayor', seed: 'private-city', stack: 'private-stack',
    }, 'test-match');
    trackGameEvent('game_completed', { score: 999 }, 'test-match');
    trackGameEvent('unapproved_event', { score: 100 });
    assert.equal(calls.length, 0, 'network work must not run on the gameplay stack');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls.length, 1);
    const [url, options] = calls[0];
    assert.equal(url, 'https://us.i.posthog.com/i/v0/e/');
    assert.equal(options.credentials, 'omit');
    const payload = JSON.parse(options.body);
    assert.equal(payload.event, 'game_completed');
    assert.ok(Number.isFinite(Date.parse(payload.timestamp)));
    assert.equal(payload.properties.brand, 'inspire');
    assert.equal(payload.properties.$process_person_profile, false);
    assert.equal(payload.properties.$geoip_disable, true);
    assert.equal(payload.properties.score, 123);
    assert.equal(payload.properties.round, 6);
    assert.ok(payload.distinct_id);
    assert.equal(payload.properties.$session_id, payload.distinct_id);
    assert.equal(payload.properties.event_sequence, 1);
    assert.equal(payload.properties.name, undefined);
    assert.equal(payload.properties.seed, undefined);
    assert.equal(payload.properties.stack, undefined);
  } finally { globalThis.fetch = originalFetch; }
});

test('blocked crypto, context, storage, and duplicate initialization are safe', async () => {
  const keys = ['crypto', 'localStorage', 'sessionStorage', 'addEventListener', 'fetch'];
  const descriptors = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  const listeners = new Map();
  const calls = [];
  const throwing = () => { throw new Error('blocked'); };
  try {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, get: throwing });
    for (const key of ['localStorage', 'sessionStorage']) Object.defineProperty(globalThis, key, { configurable: true, get: throwing });
    globalThis.addEventListener = (type, fn) => { assert.ok(!listeners.has(type), 'one listener per type'); listeners.set(type, fn); };
    globalThis.fetch = (_url, options) => { calls.push(JSON.parse(options.body)); return Promise.resolve({ ok: true }); };
    const analytics = await import('../../js/analytics.js?blocked-environment');
    analytics.setAnalyticsContext(throwing);
    assert.doesNotThrow(() => { analytics.initAnalytics(); analytics.initAnalytics(); });
    analytics.setAnalyticsContext(() => ({ mode: 'classic', round: 4, match_id: 2, game_state: 'playing', name: 'Private mayor' }));
    const event = { error: new TypeError('Private message'), filename: 'https://private.example/' };
    listeners.get('error')(event);
    listeners.get('error')(event);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls.length, 2, 'one open and one categorized error');
    assert.equal(calls[0].distinct_id, calls[1].distinct_id);
    assert.match(calls[0].distinct_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(calls[1].properties.error_name, 'TypeError');
    assert.equal(calls[1].properties.mode, 'classic');
    assert.equal(calls[1].properties.round, 4);
    assert.equal(calls[1].properties.match_id, 2);
    assert.equal(calls[1].properties.event_sequence, 2);
    assert.ok(!JSON.stringify(calls).includes('Private'));
    assert.ok(!JSON.stringify(calls).includes('private.example'));
  } finally {
    keys.forEach((key, i) => { if (descriptors[i]) Object.defineProperty(globalThis, key, descriptors[i]); else delete globalThis[key]; });
  }
});

test('privacy opt-out and offline mode send no requests', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => { calls++; return Promise.resolve({ ok: true }); };
  try {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { globalPrivacyControl: true } });
    trackGameEvent('game_started', {}, 'privacy-test');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: false } });
    trackGameEvent('game_started', {}, 'offline-test');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor); else delete globalThis.navigator;
  }
});

test('analytics failures cannot throw into gameplay', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network unavailable'); };
  try {
    assert.doesNotThrow(() => trackGameEvent('error_encountered', {}, 'test-error'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    globalThis.fetch = () => Promise.reject(new Error('network unavailable'));
    assert.doesNotThrow(() => trackGameEvent('error_encountered', {}, 'test-rejection'));
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally { globalThis.fetch = originalFetch; }
});
