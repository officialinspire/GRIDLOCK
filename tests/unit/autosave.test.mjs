import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAutosave, AUTOSAVE_DELAY_MS, AUTOSAVE_MAX_WAIT_MS } from '../../js/ui/autosave.js';

/** A manual clock: timers fire only when advance() passes their time. */
function fakeClock() {
  let t = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => t,
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
      }
      t = end;
    },
    get timers() { return timers.size; },
  };
}

function setup() {
  const clock = fakeClock();
  const saves = [];
  const autosave = createAutosave(() => saves.push(clock.now()), clock);
  return { clock, saves, autosave };
}

test('the debounce window is about 250–400 ms and long runs still save within a second', () => {
  assert.ok(AUTOSAVE_DELAY_MS >= 250 && AUTOSAVE_DELAY_MS <= 400);
  assert.ok(AUTOSAVE_MAX_WAIT_MS > AUTOSAVE_DELAY_MS && AUTOSAVE_MAX_WAIT_MS <= 1000);
});

test('a quick run of changes is one save, shortly after the last of them', () => {
  const { clock, saves, autosave } = setup();
  for (let i = 0; i < 5; i++) {
    autosave.schedule();
    clock.advance(50); // a capture chain: road, capture, develop, bonus road…
  }
  assert.deepEqual(saves, [], 'nothing written mid-run');
  assert.equal(autosave.pending, true);
  clock.advance(AUTOSAVE_DELAY_MS);
  assert.deepEqual(saves, [200 + AUTOSAVE_DELAY_MS], 'one write, a delay after the last change');
  assert.equal(autosave.pending, false);
  clock.advance(5000);
  assert.equal(saves.length, 1, 'and nothing more');
});

test('changes further apart than the delay are each saved', () => {
  const { clock, saves, autosave } = setup();
  autosave.schedule();
  clock.advance(AUTOSAVE_DELAY_MS + 50); // e.g. CPU steps at the normal speed
  autosave.schedule();
  clock.advance(AUTOSAVE_DELAY_MS + 50);
  assert.equal(saves.length, 2);
});

test('a run that never pauses (Skip, Instant playback) still saves every AUTOSAVE_MAX_WAIT_MS', () => {
  const { clock, saves, autosave } = setup();
  for (let i = 0; i < 40; i++) {
    autosave.schedule();
    clock.advance(100);
  }
  assert.ok(saves.length >= Math.floor(4000 / AUTOSAVE_MAX_WAIT_MS) - 1, `saved during the run (${saves})`);
  saves.reduce((prev, at) => {
    assert.ok(at - prev <= AUTOSAVE_MAX_WAIT_MS + 100, `gap ${at - prev} ms`);
    return at;
  }, 0);
});

test('flush writes a pending save at once (page hidden or reloaded), and only if one is pending', () => {
  const { clock, saves, autosave } = setup();
  assert.equal(autosave.flush(), false, 'nothing pending: nothing written');
  autosave.schedule();
  clock.advance(10);
  assert.equal(autosave.flush(), true);
  assert.deepEqual(saves, [10]);
  clock.advance(AUTOSAVE_DELAY_MS * 3);
  assert.equal(saves.length, 1, 'the flushed save is not written again');
  assert.equal(clock.timers, 0);
});

test('saveNow writes at once and replaces a pending save', () => {
  const { clock, saves, autosave } = setup();
  autosave.saveNow();
  assert.deepEqual(saves, [0], 'writes even with nothing pending (quit, app update, new game)');
  autosave.schedule();
  clock.advance(100);
  autosave.saveNow();
  clock.advance(AUTOSAVE_DELAY_MS * 3);
  assert.deepEqual(saves, [0, 100]);
});

test('cancel drops a pending save (game over and abandon clear the save instead)', () => {
  const { clock, saves, autosave } = setup();
  autosave.schedule();
  autosave.cancel();
  clock.advance(AUTOSAVE_DELAY_MS * 3);
  assert.deepEqual(saves, [], 'a cleared save is never brought back');
  assert.equal(autosave.flush(), false);
  autosave.schedule(); // and scheduling works normally afterwards
  clock.advance(AUTOSAVE_DELAY_MS);
  assert.deepEqual(saves, [AUTOSAVE_DELAY_MS * 3 + AUTOSAVE_DELAY_MS]);
});

test('the max wait counts from the first unsaved change, not from an earlier save', () => {
  const { clock, saves, autosave } = setup();
  autosave.schedule();
  clock.advance(AUTOSAVE_DELAY_MS); // saved
  clock.advance(5000);
  autosave.schedule();
  clock.advance(AUTOSAVE_DELAY_MS - 1);
  assert.equal(saves.length, 1, 'a fresh change gets the full delay');
  clock.advance(1);
  assert.equal(saves.length, 2);
});
