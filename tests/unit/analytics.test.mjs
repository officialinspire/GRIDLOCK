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
    assert.equal(payload.properties.brand, 'inspire');
    assert.equal(payload.properties.$process_person_profile, false);
    assert.equal(payload.properties.score, 123);
    assert.equal(payload.properties.round, 6);
    assert.ok(payload.distinct_id);
    assert.equal(payload.properties.name, undefined);
    assert.equal(payload.properties.seed, undefined);
    assert.equal(payload.properties.stack, undefined);
  } finally { globalThis.fetch = originalFetch; }
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
