/**
 * Debounced autosave scheduling for active play. No DOM: the game view supplies `save` (write
 * the game in progress) and decides which moments must be saved at once.
 *
 *   schedule()  a change to keep: saved AUTOSAVE_DELAY_MS after the last change of a quick run
 *               (a capture chain, a stretch of CPU steps), and never more than
 *               AUTOSAVE_MAX_WAIT_MS after the first, so a long run still saves as it goes
 *   flush()     saves now if a save is pending (the page is being hidden, reloaded or left)
 *   saveNow()   saves now whether or not one is pending, replacing it (quit, app update, new game)
 *   cancel()    drops a pending save unwritten (the save is about to be cleared: game over, abandon)
 *
 * Each save writes the whole game as it is when the save runs, so coalescing changes never loses
 * one: the latest state includes them all.
 */
export const AUTOSAVE_DELAY_MS = 300;
export const AUTOSAVE_MAX_WAIT_MS = 1000;

export function createAutosave(save, {
  delay = AUTOSAVE_DELAY_MS,
  maxWait = AUTOSAVE_MAX_WAIT_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  now = () => Date.now(),
} = {}) {
  let timer = null;
  let firstChangeAt = null; // when the oldest unsaved change was scheduled

  const reset = () => {
    if (timer != null) clearTimer(timer);
    timer = null;
    firstChangeAt = null;
  };
  const run = () => {
    reset();
    save();
  };

  return {
    schedule() {
      const t = now();
      firstChangeAt ??= t;
      if (timer != null) clearTimer(timer);
      timer = setTimer(run, Math.max(0, Math.min(delay, firstChangeAt + maxWait - t)));
    },
    flush() {
      if (timer == null) return false;
      run();
      return true;
    },
    saveNow: run,
    cancel: reset,
    get pending() {
      return timer != null;
    },
  };
}
