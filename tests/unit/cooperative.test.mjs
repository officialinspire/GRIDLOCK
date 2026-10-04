import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createCooperativeScheduler, FALLBACK_MS, SLICE_MS } from '../../js/ui/cooperative.js';

/** A fake browser: animation frames, fresh tasks and timers, all run by hand. */
function fakeBrowser() {
  let t = 0;
  let ids = 1;
  const frames = new Map();
  const tasks = [];
  const timers = new Map();
  return {
    now: () => t,
    spend(ms) { t += ms; }, // work done inside the current task
    requestFrame: (fn) => { const id = ids++; frames.set(id, fn); return id; },
    cancelFrame: (id) => frames.delete(id),
    task: (fn) => tasks.push(fn),
    setTimer: (fn, ms) => { const id = ids++; timers.set(id, { fn, at: t + ms }); return id; },
    clearTimer: (id) => timers.delete(id),
    runTasks() { while (tasks.length) tasks.shift()(); },
    frame() { t += 16; const due = [...frames.values()]; frames.clear(); for (const fn of due) fn(); },
    advance(ms) {
      const end = t + ms;
      for (const [id, x] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (x.at > end) continue;
        timers.delete(id);
        t = x.at;
        x.fn();
      }
      t = end;
    },
    get pendingFrames() { return frames.size; },
    get pendingTimers() { return timers.size; },
  };
}

test('afterPaint: a fresh task once the browser has painted, never inside the call', () => {
  const b = fakeBrowser();
  const { afterPaint } = createCooperativeScheduler(b);
  const ran = [];
  afterPaint(() => ran.push('plan'));
  b.runTasks();
  assert.deepEqual(ran, [], 'not before the frame (the move before it is painted first)');
  b.frame();
  assert.deepEqual(ran, [], 'not inside the frame callback either');
  b.runTasks();
  assert.deepEqual(ran, ['plan']);
  assert.equal(b.pendingTimers, 0, 'the fallback timer is cleared');
});

test('a bot step is plan (after a paint) → move (next task) → paint → plan…, never one long block', () => {
  const b = fakeBrowser();
  const { afterPaint, nextTask } = createCooperativeScheduler(b);
  const ran = [];
  const plan = (n) => () => { ran.push(`plan ${n}`); nextTask(() => { ran.push(`move ${n}`); if (n < 3) afterPaint(plan(n + 1)); }); };
  afterPaint(plan(1));
  b.frame();
  b.runTasks();
  assert.deepEqual(ran, ['plan 1', 'move 1'], 'the move follows its plan in a task of its own');
  b.runTasks();
  assert.deepEqual(ran, ['plan 1', 'move 1'], 'the next plan waits for the move to be painted');
  b.frame();
  b.runTasks();
  b.frame();
  b.runTasks();
  assert.deepEqual(ran, ['plan 1', 'move 1', 'plan 2', 'move 2', 'plan 3', 'move 3']);
});

test('in a hidden tab (no frames) a fallback timer keeps things going, once', () => {
  const b = fakeBrowser();
  const { afterPaint } = createCooperativeScheduler(b);
  const ran = [];
  afterPaint(() => ran.push('x'));
  b.advance(FALLBACK_MS - 1);
  assert.deepEqual(ran, []);
  b.advance(1);
  assert.deepEqual(ran, ['x']);
  assert.equal(b.pendingFrames, 0, 'the frame request is dropped');
  b.frame();
  b.runTasks();
  assert.deepEqual(ran, ['x'], 'never twice');
});

test('cancelled work never runs (a stale plan, a pause, a new game)', () => {
  const b = fakeBrowser();
  const { afterPaint, nextTask } = createCooperativeScheduler(b);
  const ran = [];
  afterPaint(() => ran.push('painted'))();
  assert.equal(b.pendingFrames, 0);
  assert.equal(b.pendingTimers, 0);
  nextTask(() => ran.push('task'))();
  b.frame();
  b.runTasks();
  b.advance(FALLBACK_MS * 2);
  assert.deepEqual(ran, []);
});

test('soon: cheap work shares the frame while the slice lasts; expensive work waits for a paint', () => {
  const b = fakeBrowser();
  const { afterPaint, soon } = createCooperativeScheduler(b);
  const ran = [];
  afterPaint(() => ran.push('start')); // the slice begins after this paint
  b.frame();
  b.runTasks();
  soon(() => ran.push('cheap 1'), { cheap: true });
  b.runTasks();
  assert.deepEqual(ran, ['start', 'cheap 1'], 'quick planning follows at once (a fast desktop)');
  soon(() => ran.push('expensive'));
  b.runTasks();
  assert.deepEqual(ran, ['start', 'cheap 1'], 'planning that was slow last time waits for a paint (a phone)');
  b.frame();
  b.runTasks();
  assert.deepEqual(ran.at(-1), 'expensive');
  b.spend(SLICE_MS); // the slice is used up
  soon(() => ran.push('cheap 2'), { cheap: true });
  b.runTasks();
  assert.equal(ran.at(-1), 'expensive', 'even cheap work waits once the slice is spent');
  b.frame();
  b.runTasks();
  assert.equal(ran.at(-1), 'cheap 2');
});
