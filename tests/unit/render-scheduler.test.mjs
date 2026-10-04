import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRenderScheduler } from '../../js/ui/renderScheduler.js';

/** Animation frames that run only when the test says a frame has come. */
function fakeFrames() {
  let nextId = 1;
  const queued = new Map();
  return {
    requestFrame: (fn) => { const id = nextId++; queued.set(id, fn); return id; },
    cancelFrame: (id) => { queued.delete(id); },
    tick() {
      const due = [...queued.values()];
      queued.clear();
      for (const fn of due) fn();
    },
    get queued() { return queued.size; },
  };
}

const endOfTask = () => new Promise((resolve) => { setTimeout(resolve, 0); });

function setup(draw = () => {}) {
  const frames = fakeFrames();
  const draws = [];
  const scheduler = createRenderScheduler(() => { draws.push('draw'); draw(scheduler); }, frames);
  return { frames, draws, scheduler };
}

test('every request in one action is one draw, at the end of that action', async () => {
  const { draws, frames, scheduler } = setup();
  scheduler.request(); // e.g. handleRoad
  scheduler.request(); // …then showCaptureChoice
  scheduler.request();
  assert.equal(draws.length, 0, 'nothing drawn mid-action');
  assert.equal(scheduler.pending, true);
  await endOfTask();
  assert.equal(draws.length, 1);
  assert.equal(scheduler.pending, false);
  frames.tick();
  await endOfTask();
  assert.equal(draws.length, 1, 'and never again for the same requests');
});

test('frame requests from several tasks are one draw at the next frame', async () => {
  const { draws, frames, scheduler } = setup();
  for (let step = 0; step < 4; step++) { // a burst of quick CPU steps, one task each
    scheduler.request({ frame: true });
    await endOfTask();
  }
  assert.equal(draws.length, 0, 'waits for the frame');
  assert.equal(frames.queued, 1, 'one frame requested, not four');
  frames.tick();
  assert.equal(draws.length, 1);
  frames.tick();
  assert.equal(draws.length, 1);
});

test('a plain request upgrades a pending frame draw to the end of the task', async () => {
  const { draws, frames, scheduler } = setup();
  scheduler.request({ frame: true });
  scheduler.request(); // control came back to a person: draw now, not at the frame
  assert.equal(frames.queued, 1);
  await endOfTask();
  assert.equal(draws.length, 1);
  assert.equal(frames.queued, 0, 'the frame request was dropped');
  frames.tick();
  assert.equal(draws.length, 1);
});

test('a frame request never delays a draw already due at the end of the task', async () => {
  const { draws, frames, scheduler } = setup();
  scheduler.request();
  scheduler.request({ frame: true });
  assert.equal(frames.queued, 0);
  await endOfTask();
  assert.equal(draws.length, 1);
});

test('flush draws a pending request now, and only then', async () => {
  const { draws, frames, scheduler } = setup();
  assert.equal(scheduler.flush(), false, 'nothing pending: nothing drawn');
  scheduler.request();
  assert.equal(scheduler.flush(), true); // a tip that points at the HUD needs this turn's screen
  assert.equal(draws.length, 1);
  await endOfTask();
  assert.equal(draws.length, 1, 'the end-of-task draw was already done');
  scheduler.request({ frame: true });
  assert.equal(scheduler.flush(), true);
  frames.tick();
  assert.equal(draws.length, 2, 'the frame draw was already done');
});

test('cancel drops a pending draw', async () => {
  const { draws, frames, scheduler } = setup();
  scheduler.request();
  scheduler.request({ frame: true });
  scheduler.cancel(); // leaving the game
  await endOfTask();
  frames.tick();
  assert.equal(draws.length, 0);
  scheduler.request();
  await endOfTask();
  assert.equal(draws.length, 1, 'and requests work again afterwards');
});

test('a draw that asks for another draw waits for the next frame (no render loop)', async () => {
  const { draws, frames, scheduler } = setup((s) => s.request());
  scheduler.request();
  await endOfTask();
  assert.equal(draws.length, 1, 'not redrawn in the same task');
  frames.tick();
  assert.equal(draws.length, 2, 'once per frame at most');
  frames.tick();
  assert.equal(draws.length, 3);
});

test('a draw that throws leaves the scheduler usable', async () => {
  let fail = true;
  const frames = fakeFrames();
  let draws = 0;
  const scheduler = createRenderScheduler(() => { draws++; if (fail) throw new Error('boom'); }, frames);
  scheduler.request();
  assert.throws(() => scheduler.flush(), /boom/);
  assert.equal(scheduler.pending, false);
  fail = false;
  scheduler.request();
  await endOfTask();
  assert.equal(draws, 2);
});
