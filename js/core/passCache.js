/**
 * Caching for one read-only pass over the live game: a screen draw, where the board, HUD,
 * inspector, City view and tips all ask for the same derived readings (a block's event impacts, a
 * player's stats and score, the takeover candidates…).
 *
 *   readPass(game, fn)                 runs fn with a cache for `game`
 *   readCached(game, key, compute)     inside it: compute once per key; outside: just compute
 *
 * Invalidation, kept simple on purpose:
 *   - The cache lives for one pass. The next pass starts empty, so it always reads the game as it
 *     is now, including after direct edits (tests, debugging) that no version number would see.
 *   - Within the pass, every hit checks stateVersion(game): anything done through the game's
 *     actions (a road, a build, a sale, a turn, a round, an event, money moving) changes it, and
 *     the cache is dropped on the spot. A pass is not meant to change the game; this makes sure a
 *     change could never be read past.
 *   - Only `game` itself is cached: copies and simulations (the CPU planner's) always compute.
 */

/** Numbers that change with every action on the game (each action logs, moves money, or moves play on). */
function stateVersion(game) {
  return [game.log.length, game.ledger.length, game.round, game.turnIndex, game.turnPhase, game.phase,
    game.events.nextUid, game.events.active.length, game.city?.actionsLeft, game.city?.takeovers];
}

/** stateVersion(game) still equals `v` (compared field by field, without building a new one). */
function sameVersion(game, v) {
  return v[0] === game.log.length && v[1] === game.ledger.length && v[2] === game.round && v[3] === game.turnIndex
    && v[4] === game.turnPhase && v[5] === game.phase && v[6] === game.events.nextUid
    && v[7] === game.events.active.length && v[8] === game.city?.actionsLeft && v[9] === game.city?.takeovers;
}

let pass = null; // { game, version, values: Map(key → value) }

export function readPass(game, fn) {
  if (pass || !game) return fn(); // nested: part of the same pass
  pass = { game, version: stateVersion(game), values: new Map() };
  try {
    return fn();
  } finally {
    pass = null;
  }
}

export function readCached(game, key, compute) {
  if (!pass || game !== pass.game) return compute();
  if (!sameVersion(game, pass.version)) {
    pass.version = stateVersion(game);
    pass.values.clear();
  }
  if (pass.values.has(key)) return pass.values.get(key);
  const value = compute();
  pass.values.set(key, value);
  return value;
}
