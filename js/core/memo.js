/**
 * Per-decision memoization for the CPU planner.
 *
 * withMemo(fn) runs one CPU decision (chooseCityAction, a sealed bid, evaluatePurchases). Inside
 * it, remember(owner, key, compute) computes each (owner, key) once: `owner` is the object the
 * result is read from (the game, a slimmed view of it, a simulated copy) and `key` names what was
 * computed from it, e.g. 'forecast|r2c3|park'. The memo is created when the decision starts and
 * dropped when it ends, so nothing is ever reused once the game has changed; a decision reads a
 * game nobody changes meanwhile, and an owner must not change after anything was remembered for it.
 * Owners are held weakly, so simulated copies are freed as soon as the planner drops them.
 *
 * Outside a decision (the Build panel, the inspector) remember() simply computes.
 */
import { DEBUG_PERF, count } from './perf.js';

let scope = null; // WeakMap: owner → Map(key → value), for the decision being made
let enabled = true;

/**
 * Turns the planner's optimizations off or on: this memo, and the shortcuts the planner takes
 * because of it (core/cpu/city.js). Tests compare every decision made both ways.
 */
export function setPlannerOptimizations(on) {
  enabled = Boolean(on);
}

export const plannerOptimizations = () => enabled;

export function withMemo(fn) {
  if (scope || !enabled) return fn(); // a nested entry point is part of the same decision
  scope = new WeakMap();
  try {
    return fn();
  } finally {
    scope = null;
  }
}

export function remember(owner, key, compute) {
  if (!scope) return compute();
  let entries = scope.get(owner);
  if (!entries) scope.set(owner, (entries = new Map()));
  if (entries.has(key)) {
    if (DEBUG_PERF) count(`memo hit: ${key.split('|')[0]}`);
    return entries.get(key);
  }
  const value = compute();
  entries.set(key, value);
  return value;
}
