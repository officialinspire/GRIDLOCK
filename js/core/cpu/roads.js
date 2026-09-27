/**
 * CPU road placement: which road should the current (CPU) seat pave? Pure and deterministic.
 *
 *   chooseRoad(game, { difficulty, seed }) → { road, reason, captures, score, difficulty, candidates }
 *                                          | { road: null, error }
 *
 * - Returns a decision only: it never mutates the game. The caller plays it with placeRoad().
 * - Legality comes from the game's own validateRoad(); board geometry from board.js
 *   (roadBlocks, blockRoadIds). Look-ahead runs on a copy of the paved roads.
 * - It sees what a player at the table sees: the board, who owns what, and the land values.
 *   It never reads game.rngState or the event pool and never calls nextRandom(), so it can't
 *   predict (or disturb) city events. Its own choices between equal moves use a separate
 *   seeded stream: `seed` if given, else one derived from public facts (the city seed shown
 *   in the pause menu, the seat, and how many roads are down). Same position + seed → same road.
 *
 * Difficulty:
 *   easy    takes a capture when one is there; otherwise a random road, usually (not always)
 *           steering clear of handing over a three-sided block
 *   normal  best capture first (double captures and the chain behind it count); otherwise a
 *           safe road; if none, the road that gives the next mayor the fewest blocks
 *   hard    normal's instincts plus look-ahead: plays out its own capture run, the next mayor's
 *           reply and its own follow-up, weighing blocks by what they're worth (land value +
 *           capture reward); may stop a chain two blocks early (a "double-deal") to keep control
 */
import { ECONOMY } from '../../config.js';
import { allRoadIds, roadBlocks, blockRoadIds, hasRoad } from '../board.js';
import { validateRoad, currentPlayer, roadsBuilt } from '../game.js';

export const CPU_REASONS = Object.freeze({
  CAPTURE: 'capture', // completes one or more blocks
  SAFE: 'safe', // gives nobody a block
  SACRIFICE: 'sacrifice', // every road gives something away: the cheapest giveaway
  DOUBLE_DEAL: 'double-deal', // declines the last two blocks of a chain to keep control
  RANDOM: 'random', // easy: an unplanned but harmless road
  RISKY: 'risky', // easy: an unplanned road that hands over a block
});

/** Chance an Easy mayor rethinks a road that would leave a three-sided block. */
const EASY_CAUTION = 0.7;

/* ---------------- seeded choice stream (never the game's RNG) ---------------- */

function mix(...parts) {
  let h = 0x9e3779b9;
  for (const p of parts) {
    h = Math.imul(h ^ (p >>> 0), 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
  }
  return h >>> 0;
}

function stream(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The default AI seed: public facts only (city seed, seat, roads down). */
export function defaultCpuSeed(game) {
  return mix(game.seed ?? 0, currentPlayer(game)?.seat ?? 0, roadsBuilt(game));
}

/* ---------------- a position: the roads and which blocks can still be claimed ---------------- */

const geometryCache = new Map();
function geometry(board) {
  const key = `${board.rows}x${board.cols}`;
  if (!geometryCache.has(key)) {
    const roads = allRoadIds(board);
    geometryCache.set(key, {
      roads,
      blocksOf: new Map(roads.map((id) => [id, roadBlocks(board, id).map((b) => b.id)])),
      roadsOf: new Map(board.blocks.map((b) => [b.id, blockRoadIds(b)])),
    });
  }
  return geometryCache.get(key);
}

function positionOf(game) {
  const { board } = game;
  const geo = geometry(board);
  return {
    geo,
    roads: new Set(Object.keys(board.roads)),
    // Unowned, not abandoned: the blocks a road can still claim.
    open: new Set(board.blocks.filter((b) => b.ownerSeat == null && !b.abandoned).map((b) => b.id)),
    worth: new Map(board.blocks.map((b) => [b.id, ECONOMY.CAPTURE_REWARD + b.price])),
  };
}

const sides = (pos, blockId) => pos.geo.roadsOf.get(blockId).reduce((n, r) => n + (pos.roads.has(r) ? 1 : 0), 0);
const freeRoads = (pos) => pos.geo.roads.filter((r) => !pos.roads.has(r));

/** Blocks this road would claim. */
function completes(pos, road) {
  return pos.geo.blocksOf.get(road).filter((b) => pos.open.has(b) && sides(pos, b) === 3);
}

/** A road that claims nothing and leaves no open block on three sides. */
function isSafe(pos, road) {
  return pos.geo.blocksOf.get(road).every((b) => !pos.open.has(b) || sides(pos, b) < 2);
}

function play(pos, road) {
  const captured = completes(pos, road);
  const next = { ...pos, roads: new Set(pos.roads).add(road), open: new Set(pos.open) };
  for (const b of captured) next.open.delete(b);
  return { pos: next, captured };
}

const closers = (pos) => freeRoads(pos).filter((r) => completes(pos, r).length);
const valueOf = (pos, blocks, weighted) => blocks.reduce((n, b) => n + (weighted ? pos.worth.get(b) : 1), 0);

/**
 * Takes every capture on offer. Returns what was taken and the position after. Incremental:
 * after each capture only the blocks beside the new road can have become three-sided.
 * (The order captures are taken in doesn't change the total.)
 */
function takeAll(pos, weighted) {
  const local = { ...pos, roads: new Set(pos.roads), open: new Set(pos.open) };
  let value = 0;
  const blocks = [];
  const queue = [...local.open].filter((b) => sides(local, b) === 3);
  while (queue.length) {
    const block = queue.shift();
    if (!local.open.has(block) || sides(local, block) !== 3) continue;
    const road = local.geo.roadsOf.get(block).find((r) => !local.roads.has(r));
    const captured = completes(local, road);
    local.roads.add(road);
    for (const b of captured) {
      local.open.delete(b);
      value += weighted ? local.worth.get(b) : 1;
      blocks.push(b);
    }
    for (const b of local.geo.blocksOf.get(road)) if (local.open.has(b) && sides(local, b) === 3) queue.push(b);
  }
  return { value, blocks, pos: local };
}

/** What the next mayor takes if `road` (claiming nothing) is paved now. */
function giveaway(pos, road, weighted) {
  return takeAll(play(pos, road).pos, weighted).value;
}

/** The move a sensible mayor makes once their captures are done: safe, else the cheapest giveaway. */
function closingMove(pos, weighted) {
  const free = freeRoads(pos);
  if (!free.length) return null;
  const safe = free.find((r) => isSafe(pos, r));
  if (safe) return safe;
  let best = null;
  for (const r of free) {
    const lost = giveaway(pos, r, weighted);
    if (!best || lost < best.lost) best = { road: r, lost };
  }
  return best.road;
}

/**
 * The next mayor's turn after ours: they take everything offered, then make their closing
 * move. Returns what they took and the position they leave behind.
 */
function replyTurn(pos, weighted) {
  const taken = takeAll(pos, weighted);
  const road = closingMove(taken.pos, weighted);
  return { value: taken.value, pos: road ? play(taken.pos, road).pos : taken.pos };
}

/* ---------------- choosing ---------------- */

/** Picks uniformly among the options sharing the best score (options already in a stable order). */
function pickBest(scored, rand) {
  const top = Math.max(...scored.map((s) => s.score));
  const ties = scored.filter((s) => s.score >= top - 1e-9);
  return ties[Math.floor(rand() * ties.length)];
}

function decideEasy(pos, legal, rand) {
  const captures = legal.filter((r) => completes(pos, r).length);
  if (captures.length) return { road: captures[Math.floor(rand() * captures.length)], reason: CPU_REASONS.CAPTURE, score: 0 };
  let road = legal[Math.floor(rand() * legal.length)];
  const safe = legal.filter((r) => isSafe(pos, r));
  if (!isSafe(pos, road) && safe.length && rand() < EASY_CAUTION) road = safe[Math.floor(rand() * safe.length)];
  return { road, reason: isSafe(pos, road) ? CPU_REASONS.RANDOM : CPU_REASONS.RISKY, score: 0 };
}

function decideNormal(pos, legal, rand) {
  const captures = legal.filter((r) => completes(pos, r).length);
  if (captures.length) {
    // Blocks this road claims plus the run it opens up (doubles and simple chains).
    const scored = captures.map((road) => {
      const step = play(pos, road);
      return { road, score: step.captured.length + takeAll(step.pos, false).value };
    });
    return { ...pickBest(scored, rand), reason: CPU_REASONS.CAPTURE };
  }
  const safe = legal.filter((r) => isSafe(pos, r));
  if (safe.length) return { road: safe[Math.floor(rand() * safe.length)], reason: CPU_REASONS.SAFE, score: 0 };
  const scored = legal.map((road) => ({ road, score: -giveaway(pos, road, false) }));
  return { ...pickBest(scored, rand), reason: CPU_REASONS.SACRIFICE };
}

/**
 * Hard: the value of finishing our turn from `pos` with `road` (a road that claims nothing):
 * minus what the next mayor then takes, plus what we can expect back from the position they
 * leave (in full at a two-player table; half otherwise, since other mayors move in between).
 */
function endTurnScore(pos, road, follow) {
  const reply = replyTurn(play(pos, road).pos, true);
  return -reply.value + follow * takeAll(reply.pos, true).value;
}

/** Hard: best score for the rest of our turn from `pos` (we may still be capturing). */
function bestContinuation(pos, follow) {
  const options = closers(pos);
  const ahead = options.length ? takeAll(pos, true) : null;
  let best = -Infinity;
  if (options.length) {
    // Keep capturing: which capture first doesn't change the total, so one branch suffices.
    const road = options[0];
    const step = play(pos, road);
    best = valueOf(pos, step.captured, true) + bestContinuation(step.pos, follow);
  }
  // Stop here: with nothing left to capture we must; with exactly two blocks left in the run
  // and no safe roads anywhere, leaving them can buy control of the next (longer) chain.
  const noSafe = !freeRoads(pos).some((r) => isSafe(pos, r) && !completes(pos, r).length);
  if (!options.length || (ahead.blocks.length === 2 && noSafe)) {
    for (const road of freeRoads(pos)) {
      if (completes(pos, road).length) continue;
      best = Math.max(best, endTurnScore(pos, road, follow));
    }
    if (best === -Infinity) best = 0; // board complete
  }
  return best;
}

function decideHard(pos, legal, rand, players) {
  const follow = players === 2 ? 1 : 0.5;
  const captures = legal.filter((r) => completes(pos, r).length);
  if (captures.length) {
    const scored = captures.map((road) => {
      const step = play(pos, road);
      return { road, score: valueOf(pos, step.captured, true) + bestContinuation(step.pos, follow), reason: CPU_REASONS.CAPTURE };
    });
    // Declining the rest of the run (a double-deal) competes with taking it.
    const ahead = takeAll(pos, true);
    const noSafe = !legal.some((r) => isSafe(pos, r));
    if (ahead.blocks.length === 2 && noSafe) {
      for (const road of legal) {
        if (completes(pos, road).length) continue;
        scored.push({ road, score: endTurnScore(pos, road, follow), reason: CPU_REASONS.DOUBLE_DEAL });
      }
    }
    return pickBest(scored, rand);
  }
  const scored = legal.map((road) => ({
    road,
    score: endTurnScore(pos, road, follow),
    reason: isSafe(pos, road) ? CPU_REASONS.SAFE : CPU_REASONS.SACRIFICE,
  }));
  return pickBest(scored, rand);
}

/**
 * The road the current player should pave. `difficulty` is easy | normal | hard (default: the
 * seat's own difficulty, else normal). Returns { road: null, error } when no road can be paved
 * right now (not a paving phase, in debt, game over).
 */
export function chooseRoad(game, { difficulty, seed } = {}) {
  const level = difficulty ?? currentPlayer(game)?.difficulty ?? 'normal';
  const legal = allRoadIds(game.board).filter((id) => !validateRoad(game, id));
  if (!legal.length) {
    const unpaved = allRoadIds(game.board).find((id) => !hasRoad(game.board, id));
    return { road: null, error: unpaved ? validateRoad(game, unpaved) : 'no-road' };
  }
  const pos = positionOf(game);
  const rand = stream(seed ?? defaultCpuSeed(game));
  const decide = level === 'easy' ? decideEasy : level === 'hard' ? decideHard : decideNormal;
  const choice = decide(pos, legal, rand, game.players.length);
  return {
    road: choice.road,
    reason: choice.reason,
    captures: completes(pos, choice.road).length,
    score: choice.score,
    difficulty: level,
    candidates: legal.length,
  };
}
