/**
 * City event engine. Event data lives in CITY_EVENTS (config.js).
 *
 * Lifecycle (driven by game.js when a round ends):
 *   onRoundStart(game) → expireEvents() then draw + startEvent()
 * An event drawn at the start of round R with duration D is active for
 * rounds R … R+D-1 and removed at the start of round R+D.
 *
 * Effects are never written into blocks or balances. Income and costs are
 * derived on demand from game.events.active, so an expired event can't leave a
 * permanent change behind, and re-drawing an active event refreshes it instead
 * of stacking a second copy.
 */
import { CITY_EVENTS } from '../config.js';
import { getBlockById } from './board.js';
import { eventRules } from './modes.js';
import { isProtected } from './bonuses.js';
import { blockIncome } from './economy.js';
import { nextRandom } from './rng.js';
import { readCached } from './passCache.js';

const POOL = CITY_EVENTS.POOL;
const BY_ID = new Map(POOL.map((e) => [e.id, e]));

export const getEventDef = (id) => BY_ID.get(id) ?? null;
export const EVENT_POOL = POOL;

export function createEventState() {
  return { active: [], history: [], repairs: [], nextUid: 1 };
}

const clamp = (m) => Math.min(CITY_EVENTS.MAX_MULTIPLIER, Math.max(CITY_EVENTS.MIN_MULTIPLIER, m));
const developed = (b) => b.ownerSeat != null && b.level > 0;

/* ---------------- targeting ---------------- */

export function eligibleTargets(game, def) {
  if (!def.targets) return [];
  return game.board.blocks.filter((b) => developed(b) && def.targets.categories.includes(b.type));
}

/** Picks up to `max` targets, at most `perOwner` per player, using the game's seeded RNG. */
function pickTargets(game, def) {
  const pool = eligibleTargets(game, def);
  const picked = [];
  const perOwner = new Map();
  while (pool.length && picked.length < def.targets.max) {
    const [block] = pool.splice(Math.floor(nextRandom(game) * pool.length), 1);
    const n = perOwner.get(block.ownerSeat) ?? 0;
    if (n >= def.targets.perOwner) continue;
    perOwner.set(block.ownerSeat, n + 1);
    picked.push(block.id);
  }
  return picked;
}

/* ---------------- drawing ---------------- */

/** Events that can be drawn right now (weight > 0, and targeted events need a target). */
export function drawableEvents(game, pool = POOL) {
  return pool.filter((def) => def.weight > 0 && (!def.targets || eligibleTargets(game, def).length > 0));
}

/** Weighted draw using the game's seeded RNG. Returns an event definition or null. */
export function drawEvent(game, pool = POOL) {
  const options = drawableEvents(game, pool);
  const total = options.reduce((sum, def) => sum + def.weight, 0);
  if (total <= 0) return null;
  let roll = nextRandom(game) * total;
  for (const def of options) {
    roll -= def.weight;
    if (roll < 0) return def;
  }
  return options.at(-1);
}

/* ---------------- lifecycle ---------------- */

/** Starts an event this round. An already-active event with the same id is replaced (refreshed, not stacked). */
export function startEvent(game, defOrId) {
  const def = typeof defOrId === 'string' ? getEventDef(defOrId) : defOrId;
  if (!def) throw new RangeError(`Unknown city event ${defOrId}`);
  const state = game.events;
  state.active = state.active.filter((e) => e.id !== def.id);
  const instance = {
    uid: state.nextUid++,
    id: def.id,
    startRound: game.round,
    endRound: game.round + Math.max(1, def.duration + (eventRules(game).durationBonus ?? 0)) - 1,
    targets: def.targets ? pickTargets(game, def) : [],
  };
  state.active.push(instance);
  state.history.push({ ...instance });
  if (def.repairCost) {
    for (const id of instance.targets) {
      const block = getBlockById(game.board, id);
      if (block?.ownerSeat != null && !(def.mitigation === 'civic' && isProtected(block))) {
        state.repairs.push({ uid: instance.uid, eventId: def.id, block: id, seat: block.ownerSeat, amount: def.repairCost });
      }
    }
  }
  return instance;
}

/** Removes events whose last round has passed. Returns the expired instances. */
export function expireEvents(game) {
  const state = game.events;
  const expired = state.active.filter((e) => e.endRound < game.round);
  state.active = state.active.filter((e) => e.endRound >= game.round);
  return expired;
}

/** Called once at the start of every round after the first. Returns { expired, started }. */
export function onRoundStart(game, pool = POOL) {
  const expired = expireEvents(game);
  // Pacing comes from the game's mode (game.rules); modes without events never draw or report calm rounds.
  const { enabled, probability, maxActive } = eventRules(game);
  if (!enabled) return { expired, started: null, calm: false };
  const atCapacity = game.events.active.length >= maxActive;
  const def = !atCapacity && nextRandom(game) < probability ? drawEvent(game, pool) : null;
  const started = def ? startEvent(game, def) : null;
  return { expired, started, calm: !started };
}

/** Consume repair expenses due to a player at their next turn start. */
export function takeRepairExpenses(game, seat) {
  const due = game.events.repairs.filter((repair) => repair.seat === seat);
  game.events.repairs = game.events.repairs.filter((repair) => repair.seat !== seat);
  return due;
}

export const roundsLeft = (game, instance) => instance.endRound - game.round + 1;

/* ---------------- effects ---------------- */

function matches(match, block, instance) {
  if (match.all) return true;
  if (match.targets) return instance.targets.includes(block.id);
  if (match.categories) return match.categories.includes(block.type);
  return false;
}

/**
 * Every active modifier touching a block:
 * [{ instance, def, multiplier, mitigated }]. Mitigated entries don't apply.
 */
export function blockImpacts(game, block) {
  return readCached(game, `impacts|${block.id}`, () => impactsOn(game, block));
}

function impactsOn(game, block) {
  const out = [];
  if (!developed(block)) return out;
  for (const instance of game.events.active) {
    const def = getEventDef(instance.id);
    if (!def) continue;
    for (const mod of def.income ?? []) {
      if (!matches(mod.match, block, instance)) continue;
      const mitigated = def.mitigation === 'civic' && isProtected(block);
      out.push({ instance, def, multiplier: mod.multiplier, mitigated });
    }
  }
  return out;
}

/** Combined (clamped) income multiplier for a block from all active events. */
export function incomeMultiplier(game, block) {
  const m = blockImpacts(game, block)
    .filter((i) => !i.mitigated)
    .reduce((acc, i) => acc * i.multiplier, 1);
  return clamp(m);
}

/** Net board presentation after every active modifier and civic shield is combined. */
export function blockEventState(game, block) {
  const impacts = blockImpacts(game, block);
  if (!impacts.length) return { state: null, lead: null };
  const live = impacts.filter((impact) => !impact.mitigated);
  if (!live.length) return { state: 'shielded', lead: impacts[0] };
  const multiplier = incomeMultiplier(game, block);
  if (multiplier < 1) return { state: 'hurt', lead: live.find((impact) => impact.multiplier < 1) ?? live[0] };
  if (multiplier > 1) return { state: 'boost', lead: live.find((impact) => impact.multiplier > 1) ?? live[0] };
  return { state: null, lead: null };
}

/** Income a block actually pays this turn: (base + bonuses) × event multiplier, whole dollars. */
export function effectiveBlockIncome(game, block) {
  return Math.round(blockIncome(block) * incomeMultiplier(game, block));
}

/** Total a player collects at the start of their turn, with events applied. */
export function effectiveIncome(game, seat) {
  return game.board.blocks
    .filter((b) => b.ownerSeat === seat)
    .reduce((sum, b) => sum + effectiveBlockIncome(game, b), 0);
}

/** Every active event changing build/upgrade prices for a category: [{ instance, def, multiplier }]. */
export function costImpacts(game, category) {
  const out = [];
  for (const instance of game.events.active) {
    const def = getEventDef(instance.id);
    for (const mod of def?.costs ?? []) {
      if (mod.categories.includes(category)) out.push({ instance, def, multiplier: mod.multiplier });
    }
  }
  return out;
}

/** Combined (clamped) build/upgrade cost multiplier for a category. */
export function costMultiplier(game, category) {
  return clamp(costImpacts(game, category).reduce((m, impact) => m * impact.multiplier, 1));
}

/** A base cost adjusted by active events, rounded to whole dollars. */
export const adjustedCost = (game, category, baseCost) => Math.round(baseCost * costMultiplier(game, category));

/**
 * Blocks an event currently touches, for the event card and board highlights.
 * Returns { affected: [blockId], mitigated: [blockId] }.
 */
export function eventFootprint(game, instance) {
  const affected = [];
  const mitigated = [];
  for (const block of game.board.blocks) {
    const hit = blockImpacts(game, block).find((i) => i.instance.uid === instance.uid);
    if (!hit) continue;
    (hit.mitigated ? mitigated : affected).push(block.id);
  }
  // Targets that aren't developed any more still show on the card.
  for (const id of instance.targets) {
    if (!affected.includes(id) && !mitigated.includes(id) && getBlockById(game.board, id)) affected.push(id);
  }
  return { affected, mitigated };
}
