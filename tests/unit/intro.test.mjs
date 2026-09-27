import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIntro, GUARD_MS, STALL_MS, MAX_MS } from '../../js/ui/intro.js';

/** A fake <video> and Skip button, manual timers and clock. */
function setup({ play = () => Promise.resolve() } = {}) {
  const listeners = {};
  const video = {
    attrs: {}, paused: true, currentTime: 0, muted: false, volume: 1, plays: [],
    getAttribute(k) { return this.attrs[k] ?? null; },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(type, fn) { listeners[type] = fn; },
    play() { this.plays.push(this.muted); const r = play(this); if (!(r instanceof Promise) || r) this.paused = false; return r; },
    pause() { this.paused = true; },
  };
  const skipListeners = {};
  const skipButton = { addEventListener(type, fn) { skipListeners[type] = fn; } };
  let clock = 0;
  const timers = new Map();
  let id = 0;
  const done = [];
  const intro = createIntro({
    video, skipButton, src: 'intro.mp4', onDone: (reason) => done.push(reason), now: () => clock,
    timers: { setTimeout: (fn, ms) => { timers.set(++id, { fn, at: clock + ms }); return id; }, clearTimeout: (i) => timers.delete(i) },
  });
  const advance = (ms) => {
    clock += ms;
    for (const [i, t] of [...timers]) if (t.at <= clock) { timers.delete(i); t.fn(); }
  };
  return { intro, video, listeners, skip: () => skipListeners.click(), advance, done };
}

test('intro: plays the video (src set only when played) and ends when it ends', () => {
  const t = setup();
  assert.equal(t.video.getAttribute('src'), null, 'not fetched before it is needed');
  assert.equal(t.intro.play({ muted: false, volume: 0.5 }), true);
  assert.equal(t.video.getAttribute('src'), 'intro.mp4');
  assert.equal(t.video.volume, 0.5);
  t.video.currentTime = 1;
  t.listeners.ended();
  assert.deepEqual(t.done, ['ended']);
  t.listeners.ended();
  assert.deepEqual(t.done, ['ended'], 'ends exactly once');
});

test('intro: Skip is ignored just after the start tap, then ends it', () => {
  const t = setup();
  t.intro.play();
  t.video.currentTime = 0.2;
  t.skip();
  assert.deepEqual(t.done, [], 'the tap that started it cannot skip it');
  t.advance(GUARD_MS);
  t.skip();
  assert.deepEqual(t.done, ['skipped']);
  assert.equal(t.video.paused, true);
});

test('intro: never traps the player (refused, error, stall, time cap, hidden tab)', async () => {
  const refusedWithSound = setup({ play: (v) => (v.muted ? Promise.resolve() : Promise.reject(Object.assign(new Error('no'), { name: 'NotAllowedError' }))) });
  refusedWithSound.intro.play();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(refusedWithSound.video.plays, [false, true], 'refused with sound: plays muted instead');
  assert.deepEqual(refusedWithSound.done, []);

  const unsupported = setup({ play: () => Promise.reject(Object.assign(new Error('no'), { name: 'NotSupportedError' })) });
  unsupported.intro.play();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(unsupported.done, ['failed']);

  const broken = setup();
  broken.intro.play();
  broken.listeners.error();
  assert.deepEqual(broken.done, ['error']);

  const stuck = setup();
  stuck.intro.play();
  stuck.video.paused = true; // never actually started
  stuck.advance(STALL_MS);
  assert.deepEqual(stuck.done, ['stalled']);

  const slow = setup();
  slow.intro.play();
  slow.video.currentTime = 1; // playing, but runs long
  slow.advance(MAX_MS);
  assert.deepEqual(slow.done, ['timeout']);

  const hidden = setup();
  hidden.intro.play();
  assert.equal(hidden.intro.finish('hidden'), true);
  assert.deepEqual(hidden.done, ['hidden']);
  assert.equal(hidden.intro.active, false);
});
