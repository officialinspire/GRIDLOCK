/**
 * Cooperative scheduling for work that comes in steps (the CPU driver's planning and moves).
 * No DOM of its own; the browser defaults can be replaced (tests use a fake clock and frames).
 *
 *   const { afterPaint, nextTask, soon } = createCooperativeScheduler();
 *   afterPaint(fn)  runs fn in a fresh task once the browser has painted (the next animation
 *                   frame, then a task), so the screen, taps and the pause button get their turn
 *   nextTask(fn)    runs fn in a fresh task at once (a MessageChannel message: no timer clamping)
 *   soon(fn, { cheap })  nextTask for cheap work while the current slice of the frame (SLICE_MS
 *                   since the last paint) lasts, else afterPaint: quick steps share a frame,
 *                   expensive ones get a paint before them
 * All return a function that cancels. When frames don't come (a hidden tab), afterPaint falls
 * back to a timer, so the work still goes on.
 */
export const SLICE_MS = 8;
export const FALLBACK_MS = 100;

/** Fresh macrotasks through one MessageChannel, created on first use (setTimeout 0 where missing). */
function messageTask() {
  let channel = null;
  const queue = [];
  return (fn) => {
    if (typeof MessageChannel !== 'function') return void setTimeout(fn, 0);
    if (!channel) {
      channel = new MessageChannel();
      channel.port1.onmessage = () => queue.shift()?.();
    }
    queue.push(fn);
    channel.port2.postMessage(null);
  };
}

export function createCooperativeScheduler({
  now = () => performance.now(),
  requestFrame = (fn) => requestAnimationFrame(fn),
  cancelFrame = (id) => cancelAnimationFrame(id),
  task = messageTask(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  sliceMs = SLICE_MS,
  fallbackMs = FALLBACK_MS,
} = {}) {
  let paintedAt = -Infinity; // when the current slice began: the last resume after a paint

  function nextTask(fn) {
    let done = false;
    task(() => {
      if (done) return;
      done = true;
      fn();
    });
    return () => { done = true; };
  }

  function afterPaint(fn) {
    let done = false;
    let frame = null;
    let fallback = null;
    const stop = () => {
      done = true;
      if (frame != null) cancelFrame(frame);
      if (fallback != null) clearTimer(fallback);
      frame = null;
      fallback = null;
    };
    const run = () => {
      if (done) return;
      stop();
      paintedAt = now();
      fn();
    };
    frame = requestFrame(() => {
      frame = null;
      task(run); // after the paint that follows this frame
    });
    fallback = setTimer(run, fallbackMs);
    return stop;
  }

  function soon(fn, { cheap = false } = {}) {
    return cheap && now() - paintedAt < sliceMs ? nextTask(fn) : afterPaint(fn);
  }

  return { afterPaint, nextTask, soon };
}
