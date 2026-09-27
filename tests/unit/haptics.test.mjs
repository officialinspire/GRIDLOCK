import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHaptics, PATTERNS } from '../../js/ui/haptics.js';
import { isTapThrough, GUARD_MS } from '../../js/ui/touchGuard.js';
import { normalizeSettings } from '../../js/core/settings.js';
import { DEFAULT_SETTINGS } from '../../js/config.js';

function device({ vibrate = true, coarse = true, activated = true, visible = true, throws = false } = {}) {
  const calls = [];
  const nav = {
    userActivation: { hasBeenActive: activated },
    ...(vibrate ? { vibrate: (p) => { if (throws) throw new Error('blocked'); calls.push(p); return true; } } : {}),
  };
  const h = createHaptics({
    nav,
    matchMedia: (q) => ({ matches: q === '(pointer: coarse)' && coarse }),
    isVisible: () => visible,
  });
  return { h, calls };
}

test('patterns: every action has its own feel, all short and valid', () => {
  const seen = new Set();
  for (const [name, pattern] of Object.entries(PATTERNS)) {
    assert.ok(Array.isArray(pattern) && pattern.length % 2 === 1, `${name}: buzz/pause/…/buzz`);
    assert.ok(pattern.every((ms) => Number.isInteger(ms) && ms > 0 && ms <= 200), `${name}: gentle durations`);
    assert.ok(pattern.reduce((a, b) => a + b, 0) <= 500, `${name}: over within half a second`);
    assert.ok(!seen.has(pattern.join()), `${name} is distinct`);
    seen.add(pattern.join());
  }
  const total = (name) => PATTERNS[name].filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0);
  assert.ok(total('arm') < total('pave') && total('pave') < total('capture') && total('capture') < total('chain'), 'arm < pave < capture < chain');
  assert.ok(total('win') > total('capture') && total('event') > total('capture'), 'major moments are strongest');
});

test('buzzes on touch devices with vibration, with the right pattern', () => {
  const { h, calls } = device();
  assert.equal(h.supported(), true);
  assert.equal(h.buzz('arm'), true);
  h.buzz('pave');
  h.buzz('capture', { intensity: 1 });
  h.buzz('capture', { intensity: 3 });
  h.buzz('error');
  assert.deepEqual(calls, [PATTERNS.arm, PATTERNS.pave, PATTERNS.capture, PATTERNS.chain, PATTERNS.error]);
});

test('desktop and iPhone: never vibrates (no coarse pointer, or no Vibration API)', () => {
  for (const opts of [{ coarse: false }, { vibrate: false }]) {
    const { h, calls } = device(opts);
    assert.equal(h.supported(), false);
    for (const name of Object.keys(PATTERNS)) assert.equal(h.buzz(name), false);
    assert.deepEqual(calls, []);
  }
});

test('respects the setting, user activation, visibility, and fails silently', () => {
  let d = device();
  d.h.configure({ haptics: false });
  assert.equal(d.h.buzz('pave'), false);
  d.h.configure({ haptics: true });
  assert.equal(d.h.buzz('pave'), true);

  d = device({ activated: false });
  assert.equal(d.h.buzz('pave'), false, 'no vibration before the first interaction');
  d.h.noteInteraction();
  assert.equal(d.h.buzz('pave'), true);

  d = device({ visible: false });
  assert.equal(d.h.buzz('pave'), false, 'not while the page is in the background');

  d = device({ throws: true });
  assert.doesNotThrow(() => assert.equal(d.h.buzz('pave'), false));
  assert.equal(device().h.buzz('no-such-pattern'), false);
});

test('haptics setting: on by default, persisted as a boolean, older saves unaffected', () => {
  assert.equal(DEFAULT_SETTINGS.haptics, true);
  assert.equal(normalizeSettings({ haptics: false }).haptics, false);
  assert.equal(normalizeSettings({ haptics: 'no' }).haptics, true);
  assert.equal(normalizeSettings({ confirmTaps: false }).haptics, true, 'saves from before haptics existed');
});

test('tap-through guard: only fast touch taps on a fresh dialog, or on the board after one closes', () => {
  const base = { pointerType: 'touch', keyboard: false, now: 1000, dialogOpenedAt: null, onBoard: false, lastDialogClosedAt: -Infinity };
  // A dialog that just opened under the finger.
  assert.equal(isTapThrough({ ...base, dialogOpenedAt: 1000 - GUARD_MS + 50 }), true);
  assert.equal(isTapThrough({ ...base, dialogOpenedAt: 1000 - GUARD_MS - 1 }), false, 'deliberate taps pass');
  // The board right after a dialog closed.
  assert.equal(isTapThrough({ ...base, onBoard: true, lastDialogClosedAt: 1000 - 100 }), true);
  assert.equal(isTapThrough({ ...base, onBoard: true, lastDialogClosedAt: 1000 - GUARD_MS - 1 }), false);
  assert.equal(isTapThrough({ ...base, onBoard: false, lastDialogClosedAt: 1000 - 100 }), false, 'only the board');
  // Mouse, pen and keyboard are never affected (desktop unchanged).
  for (const other of [{ pointerType: 'mouse' }, { pointerType: 'pen' }, { keyboard: true }]) {
    assert.equal(isTapThrough({ ...base, ...other, dialogOpenedAt: 1000 }), false);
    assert.equal(isTapThrough({ ...base, ...other, onBoard: true, lastDialogClosedAt: 999 }), false);
  }
});
