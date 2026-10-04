/**
 * Coalesces render requests into one draw. No DOM of its own: the game view supplies `draw` and,
 * for each request, whether it may wait for the next animation frame.
 *
 *   request()                 draw at the end of the current task (a microtask): every request
 *                             made during one action collapses into one draw, done before the
 *                             browser paints or handles the next event
 *   request({ frame: true })  draw at the next animation frame: requests from several tasks in
 *                             one frame (a burst of quick CPU steps) become one draw per frame
 *   flush()                   draw now if a draw is pending (something must read the fresh screen)
 *   cancel()                  drop a pending draw (the game it was for is gone)
 *
 * A plain request upgrades a pending frame draw to the end of the task. A request made while
 * drawing waits for the next frame, so a draw can never re-trigger itself in a tight loop.
 */
export function createRenderScheduler(draw, {
  requestFrame = (fn) => requestAnimationFrame(fn),
  cancelFrame = (id) => cancelAnimationFrame(id),
  queueTask = (fn) => queueMicrotask(fn),
} = {}) {
  let pending = false; // a draw is owed
  let soon = false; // ...at the end of this task (otherwise at the next frame)
  let frame = null;
  let drawing = false;

  const dropFrame = () => {
    if (frame != null) cancelFrame(frame);
    frame = null;
  };
  const run = () => {
    if (!pending) return false;
    pending = false;
    soon = false;
    dropFrame();
    drawing = true;
    try {
      draw();
    } finally {
      drawing = false;
    }
    return true;
  };

  return {
    request({ frame: nextFrame = false } = {}) {
      pending = true;
      if (!nextFrame && !drawing) {
        if (!soon) {
          soon = true;
          queueTask(() => { if (soon) run(); });
        }
      } else if (!soon && frame == null) {
        frame = requestFrame(() => {
          frame = null;
          run();
        });
      }
    },
    flush: run,
    cancel() {
      pending = false;
      soon = false;
      dropFrame();
    },
    get pending() {
      return pending;
    },
  };
}
