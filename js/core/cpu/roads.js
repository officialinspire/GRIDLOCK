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
 *           capture reward); may stop a chain two blocks early (a "double-deal") to keep control.
 *           An Expansionist personality weighs the captures it expects to get back more.
 */
import { ECONOMY, CPU } from '../../config.js';
import { allRoadIds, roadBlocks, blockRoadIds, hasRoad } from '../board.js';
import { validateRoad, currentPlayer } from '../game.js';
import { stream, defaultCpuSeed } from './random.js';

export { defaultCpuSeed };

export const CPU_REASONS = Object.freeze({
  CAPTURE: 'capture', // completes one or more blocks
  SAFE: 'safe', // gives nobody a block
  SACRIFICE: 'sacrifice', // every road gives something away: the cheapest giveaway
  DOUBLE_DEAL: 'double-deal', // declines the last two blocks of a chain to keep control
  RANDOM: 'random', // easy: an unplanned but harmless road
  RISKY: 'risky', // easy: an unplanned road that hands over a block
});


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
  if (!isSafe(pos, road) && safe.length && rand() < CPU.EASY_CAUTION) road = safe[Math.floor(rand() * safe.length)];
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
 * leave (CPU.HARD_FOLLOW_UP of it: in full at a two-player table, less where others move in between).
 */
function endTurnScore(pos, road, follow) {
  const reply = replyTurn(play(pos, road).pos, true);
  return -reply.value + follow * takeAll(reply.pos, true).value;
}

/**
 * Hard, endgame at a table of three or more: once no safe roads are left the rest of the board
 * goes chain by chain, each mayor taking what they're offered and then giving away as little as
 * they can, so which chain lands on whom depends on every sacrifice from here. Plays that out
 * (every mayor, us included, playing sensibly: no double-deals) and scores what we collect
 * against the average rival.
 *
 * Fast enough for a phone: every road that opens the same chain leads to the same position
 * once the next mayor has taken it, so the play-outs from our candidate roads soon meet; each
 * position is played out once per decision (`memo`).
 */
function createRollout(players) {
  const memo = new Map();
  /** The next mayor's reply to `road`: what they take and the position they're left in. */
  const reply = (pos, road) => {
    const taken = takeAll(play(pos, road).pos, true);
    return { value: taken.value, pos: taken.pos };
  };
  /**
   * From a position with nothing to capture: what each mayor collects from here, by seats after
   * the one to move (0 = the mover, who must give something away; 1 = the next mayor…).
   */
  const collect = (pos) => {
    const free = freeRoads(pos);
    const key = free.join();
    if (memo.has(key)) return memo.get(key);
    let out = Array(players).fill(0);
    const safe = free.find((r) => isSafe(pos, r));
    let best = null;
    if (safe) best = { value: 0, pos: play(pos, safe).pos };
    else {
      for (const road of free) {
        const r = reply(pos, road);
        if (!best || r.value < best.value) best = r;
      }
    }
    if (best) {
      const rest = collect(best.pos); // relative to the next mayor
      out = out.map((_, k) => rest[(k - 1 + players) % players]);
      out[1 % players] += best.value;
    }
    memo.set(key, out);
    return out;
  };
  /** Our score for ending our turn with `road` from `pos`. */
  return (pos, road) => {
    const r = reply(pos, road);
    const rest = collect(r.pos); // relative to the next mayor: we are players − 1 seats after them
    const totals = rest.map((v, k) => (k === 0 ? v + r.value : v));
    const mine = totals[players - 1];
    return mine - (totals.reduce((x, y) => x + y, 0) - mine) / (players - 1);
  };
}

/** Hard: best score for the rest of our turn from `pos` (we may still be capturing). */
function bestContinuation(pos, endScore, doubleDeal = true) {
  const options = closers(pos);
  const ahead = options.length ? takeAll(pos, true) : null;
  let best = -Infinity;
  if (options.length) {
    // Keep capturing: which capture first doesn't change the total, so one branch suffices.
    const road = options[0];
    const step = play(pos, road);
    best = valueOf(pos, step.captured, true) + bestContinuation(step.pos, endScore, doubleDeal);
  }
  // Stop here: with nothing left to capture we must; with exactly two blocks left in the run
  // and no safe roads anywhere, leaving them can buy control of the next (longer) chain.
  const noSafe = !freeRoads(pos).some((r) => isSafe(pos, r) && !completes(pos, r).length);
  if (!options.length || (doubleDeal && ahead.blocks.length === 2 && noSafe)) {
    for (const road of freeRoads(pos)) {
      if (completes(pos, road).length) continue;
      best = Math.max(best, endScore(pos, road));
    }
    if (best === -Infinity) best = 0; // board complete
  }
  return best;
}

function decideHard(pos, legal, rand, players, followUp = 1) {
  // Follow-up captures by table size (CPU.HARD_FOLLOW_UP: others move in between at bigger
  // tables); an Expansionist weighs them more (CPU.PERSONALITIES followUp).
  const follow = (CPU.HARD_FOLLOW_UP[players] ?? CPU.HARD_FOLLOW_UP[4]) * followUp;
  const doubleDeal = players <= CPU.HARD_DOUBLE_DEAL_MAX_PLAYERS;
  const noSafe = !legal.some((r) => isSafe(pos, r));
  const nearEnd = legal.filter((r) => isSafe(pos, r)).length <= CPU.HARD_ROLLOUT_SAFE_ROADS;
  // Endgame at a bigger table: play the chains out (CPU.HARD_ENDGAME_ROLLOUT); otherwise one reply ahead.
  const rollout = nearEnd && players > 2 && CPU.HARD_ENDGAME_ROLLOUT ? createRollout(players) : null;
  const endScore = rollout
    ? (p, road) => rollout(p, road) * followUp
    : (p, road) => endTurnScore(p, road, follow);
  const captures = legal.filter((r) => completes(pos, r).length);
  if (captures.length) {
    const scored = captures.map((road) => {
      const step = play(pos, road);
      return { road, score: valueOf(pos, step.captured, true) + bestContinuation(step.pos, endScore, doubleDeal), reason: CPU_REASONS.CAPTURE };
    });
    // Declining the rest of the run (a double-deal) competes with taking it.
    const ahead = takeAll(pos, true);
    if (doubleDeal && ahead.blocks.length === 2 && noSafe) {
      for (const road of legal) {
        if (completes(pos, road).length) continue;
        scored.push({ road, score: endScore(pos, road), reason: CPU_REASONS.DOUBLE_DEAL });
      }
    }
    return pickBest(scored, rand);
  }
  const scored = legal.map((road) => ({
    road,
    score: endScore(pos, road),
    reason: isSafe(pos, road) ? CPU_REASONS.SAFE : CPU_REASONS.SACRIFICE,
  }));
  return pickBest(scored, rand);
}

/**
 * How many more of their own turn starts (income paydays) the current mayor can expect,
 * judged from the board alone. Rough: the unpaved roads shared out, about one in two taken
 * as a turn-ending move. Look-ahead: once the safe roads run out the rest of the board goes
 * in a few long capture chains, so safe moves still to play (about half the safe roads)
 * plus one per likely chain, shared out.
 */
export function expectedTurnsLeft(game, { lookAhead = false } = {}) {
  const pos = positionOf(game);
  const free = freeRoads(pos);
  const players = game.players.length;
  if (!lookAhead) return Math.floor(free.length / players / 2);
  const safe = free.filter((r) => isSafe(pos, r)).length;
  return Math.floor((safe / 2 + Math.ceil(pos.open.size / 4)) / players);
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
  const followUp = CPU.PERSONALITIES[currentPlayer(game)?.personality]?.followUp ?? 1;
  const choice = decide(pos, legal, rand, game.players.length, followUp);
  return {
    road: choice.road,
    reason: choice.reason,
    captures: completes(pos, choice.road).length,
    score: choice.score,
    difficulty: level,
    candidates: legal.length,
  };
}
