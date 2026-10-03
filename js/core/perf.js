/**
 * Development-only performance timing. Off by default; no game rule depends on it.
 *
 * DEBUG_PERF is false unless the page URL has ?perf (index.html?perf, or ?debug&perf) or a Node
 * process runs with DEBUG_PERF=1 (tools, tests). While it is false, measure() only calls the
 * function: no clock reads, no bookkeeping and no logging, so gameplay is unchanged.
 *
 * While it is on:
 *   - each measured call is timed with performance.now() and added to per-label stats;
 *   - a single call taking SLOW_MS or longer is logged as it happens ("[perf] render 23.4 ms");
 *   - perfReport() prints every label as a table, most total time first (in the browser:
 *     window.__GRIDLOCK_PERF__.report(), and .reset() to start counting again).
 * Labels nest: render includes renderBoard, CPU planning includes forecastDevelopment.
 */

function flagFromEnvironment() {
  try {
    if (new URLSearchParams(globalThis.location?.search ?? '').has('perf')) return true;
  } catch { /* no page URL */ }
  const env = globalThis.process?.env?.DEBUG_PERF;
  return Boolean(env) && env !== '0' && env !== 'false';
}

export let DEBUG_PERF = flagFromEnvironment();

/** A single call at least this slow (ms) is logged right away: half a 60 Hz frame. */
export const SLOW_MS = 8;

const stats = new Map();

/** Turns timing on or off at run time (e.g. from a profiling script). */
export function setDebugPerf(on) {
  DEBUG_PERF = Boolean(on);
}

/** Runs fn() and returns its result; with DEBUG_PERF on, also times it under `label`. */
export function measure(label, fn) {
  if (!DEBUG_PERF) return fn();
  const start = performance.now();
  try {
    return fn();
  } finally {
    record(label, performance.now() - start);
  }
}

function record(label, ms) {
  let s = stats.get(label);
  if (!s) stats.set(label, (s = { label, calls: 0, totalMs: 0, maxMs: 0, lastMs: 0 }));
  s.calls += 1;
  s.totalMs += ms;
  s.lastMs = ms;
  if (ms > s.maxMs) s.maxMs = ms;
  if (ms >= SLOW_MS) console.log(`[perf] ${label} ${ms.toFixed(1)} ms`);
}

/** Stats per label so far, most total time first: [{ label, calls, totalMs, meanMs, maxMs, lastMs }]. */
export function perfStats() {
  return [...stats.values()]
    .map((s) => ({ ...s, meanMs: s.totalMs / s.calls }))
    .sort((a, b) => b.totalMs - a.totalMs);
}

/** Logs perfStats() as a table (ms to 0.01) and returns the rows. */
export function perfReport({ log = true } = {}) {
  const round = (ms) => Math.round(ms * 100) / 100;
  const rows = perfStats().map(({ label, calls, totalMs, meanMs, maxMs, lastMs }) => ({
    label, calls, totalMs: round(totalMs), meanMs: round(meanMs), maxMs: round(maxMs), lastMs: round(lastMs),
  }));
  if (log) console.table(rows);
  return rows;
}

export function perfReset() {
  stats.clear();
}
