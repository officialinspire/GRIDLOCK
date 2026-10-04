/**
 * CPU strategy for MANAGE CITY and CAPTURE / DEVELOP. Pure: chooseCityAction() returns the
 * next action and changes nothing; applyCityAction() plays a decision through the normal
 * game APIs. Ask, apply, ask again, until the answer is "pave" / "end-turn" (Manage City) or
 * the capture choice is resolved.
 *
 *   { action: 'build', blockId, type }   build Level 1 on a vacant block
 *   { action: 'upgrade', blockId }       raise a building one level
 *   { action: 'vacant', blockId }        leave a just-captured block empty (Capture / Develop)
 *   { action: 'downgrade' | 'sell', blockId }   raise cash while in debt
 *   { action: 'bankruptcy' }             only when selling everything can't cover the debt
 *   { action: 'redevelop', blockId, mode }   open a sealed-bid auction for an abandoned block
 *   { action: 'takeover', blockId }      CITY era: take over a rival's block (core/takeover.js)
 *   { action: 'pave' }                   done managing: go pave a road (EXPANSION era)
 *   { action: 'end-turn' }               done managing, or out of City Actions (CITY era)
 *   { action: null, error }              nothing to decide now
 * Every decision also carries `reason` and, where relevant, `cost`, `score`, `net` (per turn)
 * and `cityValue` (the change).
 *
 * No economy formulas live here. Options are priced and scored from forecastDevelopment()
 * (the real build/upgrade run on a copy: cost with event prices, income with bonuses and
 * events, upkeep, City Value); debt options from quoteDowngrade()/quoteSale() plus the real
 * downgradeBlock()/sellDevelopment() on a copy read back with playerStats()/scorePlayer().
 * A purchase is only ever chosen when the quote says it is affordable and the cash left
 * covers the mayor's reserve (CPU.RESERVE, or the `reserve` option).
 *
 * Difficulty:
 *   easy    builds something sensible (any affordable option that raises net income) on most
 *           captures, now and then builds or upgrades in Manage City; keeps a small reserve
 *   normal  best (net income per turn × turns left + City Value change): adjacency bonuses,
 *           upkeep and the prices and income of active events are all in the forecast; keeps
 *           the reserve plus next turn's upkeep and repairs
 *   hard    the same, judged harder: active events count only for the rounds they have left,
 *           civic shelter for its developed neighbours and a district one block from complete
 *           add value, spending needs a minimum return per dollar, and the reserve covers next
 *           turn's charges even if income is badly cut (plus a possible Fire repair bill)
 *
 * Hard also reads the city's events: it waits out a price surcharge that is about to end
 * instead of paying it, counts boosts and discounts only while they last, builds civic shelter
 * when emergencies are likely (Urban Chaos, an emergency on now), and during a downturn
 * (Recession, Snowstorm) keeps extra cash for the lean rounds and buys nothing that would
 * leave its net income negative.
 *
 * Redevelopment: the value of an abandoned lot is the real auction run on a copy; a cleared
 * lot also counts the best building the mayor could put on it next turn, so it can tell
 * "restore the ruin" from "clear and rebuild". Hard bids only the reserve price when no rival
 * can afford it, and otherwise just enough to beat the richest eligible rival's cash (public
 * information), never above what the lot is worth to it or what its cash risk allows.
 *
 * Personalities (CPU.PERSONALITIES: Builder, Tycoon, Planner, Expansionist) weight what a
 * mayor already values: categories, upgrades, districts, civic shelter, abandoned land and its
 * cash reserve. The weights only ever scale options that are worth doing anyway, so they
 * change what a mayor prefers, never how well it plays.
 *
 * Randomness (Easy's choices, ties) comes from the CPU's own stream, never the game RNG.
 */
import { CPU, CITY_EVENTS, ECONOMY } from '../../config.js';
import { isCpu } from '../seats.js';
import {
  currentPlayer, getPlayer, playerStats, resolveCapture, startPaving, endCityTurn, outOfCityActions, actionsPerTurnFor,
  TURN_PHASES, PHASES, ERAS,
} from '../game.js';
import { blocksOwnedBy, getBlockById, neighbors } from '../board.js';
import { buildOnBlock, upgradeBlock, quoteBuild, quoteUpgrade, isDeveloped, MAX_LEVEL } from '../development.js';
import { CATEGORY_ORDER } from '../buildings.js';
import {
  distressStatus, declareBankruptcy, quoteDowngrade, quoteSale, downgradeBlock, sellDevelopment,
  quoteRedevelopment, eligibleRedevelopers, resolveRedevelopmentAuction, ACQUIRE_MODES,
} from '../finance.js';
import { quoteTakeover, takeoverBlock, takeoverCandidates } from '../takeover.js';
import { forecastDevelopment, blockDetails } from '../forecast.js';
import { scorePlayer } from '../scoring.js';
import { eventRules } from '../modes.js';
import { getEventDef } from '../events.js';
import { expectedTurnsLeft } from './roads.js';
import { stream, mix, defaultCpuSeed } from './random.js';
import { measure } from '../perf.js';
import { withMemo, remember, plannerOptimizations } from '../memo.js';

export const CITY_REASONS = Object.freeze({
  WAIT: 'wait-for-price', // Hard: a price surcharge ends soon; buying after it is better
  DEBT: 'debt', // raising cash to get out of distress
  BANKRUPT: 'bankrupt', // selling everything couldn't cover the debt
  DEVELOP: 'develop', // a build or upgrade worth its cost
  CONSERVE: 'conserve', // something is affordable, but only by dipping into the reserve
  NOT_WORTH_IT: 'not-worth-it', // affordable, but it wouldn't pay back before the city is done
  NO_CASH: 'no-cash', // nothing affordable
  RANDOM: 'random', // easy: an unplanned but sensible purchase
  NO_ACTIONS: 'no-actions', // this turn's Development Action (EXPANSION) or City Actions are spent
  TAKEOVER: 'takeover', // CITY era: a rival block worth taking over, with a clear margin
  PASS: 'pass', // easy: chose not to spend this time
});

/*
 * Each decision runs in a memo scope (core/memo.js): the same forecast, reading or valuation asked
 * for twice while one decision is made is computed once, and nothing outlives the decision.
 */
/** Copies are cheaper without the history, which no forecast reads. One view per game per decision. */
const slim = (game) => remember(game, 'slim', () => ({ ...game, ledger: [], log: [] }));
/**
 * The same view with today's events over (Hard's look beyond them). With no event on it is the
 * same view, so its forecasts are the ones already made.
 */
const calm = (game) => (game.events.active.length || !plannerOptimizations()
  ? remember(game, 'calm', () => ({ ...slim(game), events: { ...game.events, active: [] } }))
  : slim(game));
/** forecastDevelopment, once per view, block and building type in a decision. */
const forecast = (view, blockId, type) => remember(view, `forecast|${blockId}|${type ?? 'upgrade'}`,
  () => forecastDevelopment(view, blockId, type));
/** The turns left as this difficulty judges them (Hard looks ahead), once per decision. */
const turnsLeft = (game, level) => remember(game, `turns|${level === 'hard'}`,
  () => expectedTurnsLeft(game, { lookAhead: level === 'hard' }));
const fireDef = CITY_EVENTS.POOL.find((e) => e.id === 'fire');

/* ---------------- personality ---------------- */

/** A CPU mayor's personality profile, or null (plays without one: all weights 1). */
export const profileOf = (player) => CPU.PERSONALITIES[player?.personality] ?? null;
const weight = (profile, key) => profile?.[key] ?? 1;
const categoryWeight = (profile, type) => profile?.categories?.[type] ?? 1;

/** The default cash reserve for a mayor: by difficulty, adjusted by personality. */
export function defaultReserve(level, player) {
  return Math.round((CPU.RESERVE[level] ?? CPU.RESERVE.normal) * weight(profileOf(player), 'reserve'));
}

/* ---------------- reading the city's events ---------------- */

/** Active events cutting everyone's income (Recession, Snowstorm): [{ instance, def, multiplier }]. */
function downturns(game) {
  const out = [];
  for (const instance of game.events.active) {
    const def = getEventDef(instance.id);
    for (const mod of def?.income ?? []) if (mod.match?.all && mod.multiplier < 1) out.push({ instance, def, multiplier: mod.multiplier });
  }
  return out;
}

/**
 * How likely civic shelter is to matter, relative to a Standard game (1): the mode's chance
 * of an event each round × the share of the pool that civic buildings shield against, and
 * half as much again while such an emergency is on now. 0 when the mode has no events.
 */
function emergencyExposure(game) {
  const rules = eventRules(game);
  if (!rules.enabled) return 0;
  const pool = game.eventPool ?? CITY_EVENTS.POOL;
  const total = pool.reduce((n, e) => n + (e.weight ?? 0), 0);
  const shielded = pool.filter((e) => e.mitigation === 'civic').reduce((n, e) => n + (e.weight ?? 0), 0);
  const base = CITY_EVENTS.ROUND_PROBABILITY * (shielded / Math.max(1, CITY_EVENTS.POOL.reduce((n, e) => n + e.weight, 0)));
  const likely = total ? rules.probability * (shielded / total) : 0;
  const now = game.events.active.some((i) => getEventDef(i.id)?.mitigation === 'civic') ? 1.5 : 1;
  return base ? (likely / base) * now : 0;
}

function pendingRepairs(game, seat) {
  return game.events.repairs.filter((r) => r.seat === seat).reduce((n, r) => n + r.amount, 0);
}

/** Cash that must still be in hand after buying what forecast `f` describes. */
function cashFloor(game, level, reserve, f) {
  if (level === 'easy') return reserve;
  const seat = currentPlayer(game).seat;
  const charges = f.after.upkeep + pendingRepairs(game, seat);
  if (level === 'normal') return reserve + charges;
  // Hard: survive next turn's charges even if income were cut (CPU.HARD_INCOME_CUT), and part
  // of a Fire repair (CPU.HARD_FIRE_BUFFER) when a Fire could hit one of its buildings.
  const exposed = eventRules(game).enabled && fireDef
    && blocksOwnedBy(game.board, seat).some((b) => isDeveloped(b) && fireDef.targets.categories.includes(b.type));
  const fire = exposed || fireDef?.targets.categories.includes(f.type) ? Math.round(fireDef.repairCost * CPU.HARD_FIRE_BUFFER) : 0;
  // During a downturn, also keep what the lean rounds after next will cost (charges beyond income).
  const slump = downturns(game);
  const lean = slump.length
    ? Math.max(0, eventPaydaysLeft(game, slump.map((d) => d.instance)) - 1) * Math.max(0, charges - f.after.income) : 0;
  return reserve + Math.max(0, charges + fire - Math.floor(f.after.income * (1 - CPU.HARD_INCOME_CUT))) + lean;
}

/* ---------------- Hard's extra judgement (all read from real transactions) ---------------- */

/** Income of this mayor's developed blocks that a build/upgrade newly shelters with civic protection. */
function shelteredIncome(game, blockId, type) {
  const sim = structuredClone(slim(game));
  const seat = currentPlayer(sim).seat;
  const covered = (g) => new Set(blocksOwnedBy(g.board, seat).filter((b) => isDeveloped(b) && b.protectedBy?.length).map((b) => b.id));
  const before = covered(sim);
  const done = type ? buildOnBlock(sim, blockId, type) : upgradeBlock(sim, blockId);
  if (!done.ok) return 0;
  return [...covered(sim)].filter((id) => !before.has(id) && id !== blockId)
    .reduce((n, id) => n + blockDetails(sim, id).normalIncome, 0);
}

/**
 * Hard: a Residential or Commercial build that leaves its connected group one block short of
 * a district is worth part of that district bonus (read from ECONOMY.BONUSES) for the turns left.
 */
function districtPotential(game, blockId, type, turns) {
  const rule = { residential: ECONOMY.BONUSES.RESIDENTIAL_DISTRICT, commercial: ECONOMY.BONUSES.COMMERCIAL_DISTRICT }[type];
  if (!rule || turns < 2) return 0;
  const sim = structuredClone(slim(game));
  if (!buildOnBlock(sim, blockId, type).ok) return 0;
  const start = getBlockById(sim.board, blockId);
  const seen = new Set([start.id]);
  const stack = [start];
  while (stack.length) {
    const b = stack.pop();
    for (const n of neighbors(sim.board, b)) {
      if (!seen.has(n.id) && n.ownerSeat === start.ownerSeat && n.type === type && isDeveloped(n)) {
        seen.add(n.id);
        stack.push(n);
      }
    }
  }
  if (seen.size !== rule.minSize - 1) return 0;
  const groupIncome = [...seen].reduce((n, id) => n + blockDetails(sim, id).normalIncome, 0);
  return Math.round(groupIncome * (rule.percent / 100) * CPU.DISTRICT_POTENTIAL * (turns - 1));
}

/**
 * Paydays still under today's events for something bought now: income is first paid at the
 * owner's next turn start (next round), so an event ending this round pays nothing extra
 * (0 when calm). `only` narrows it to some events.
 */
function eventPaydaysLeft(game, only = null) {
  const active = only ? game.events.active.filter((e) => only.includes(e)) : game.events.active;
  return Math.max(0, ...active.map((e) => e.endRound - game.round));
}

/* ---------------- options ---------------- */

/**
 * Every build (vacant blocks) or upgrade (developed blocks) on `blockIds` the forecast allows.
 * `buyableOnly`: only what can be bought this step (affordable, with an action to spend): a quote
 * that already says no skips the forecast, whose option would only be filtered out afterwards.
 */
function developmentOptions(game, blockIds, { buyableOnly = false } = {}) {
  const options = [];
  const view = slim(game);
  for (const blockId of blockIds) {
    const block = getBlockById(game.board, blockId);
    const types = block.level === 0 ? CATEGORY_ORDER : block.level < MAX_LEVEL ? [undefined] : [];
    for (const type of types) {
      if (buyableOnly && plannerOptimizations() && !(type ? quoteBuild(view, blockId, type) : quoteUpgrade(view, blockId)).ok) continue;
      const f = forecast(view, blockId, type);
      if (f.ok && f.actionAvailable) options.push({ blockId, type, f }); // only what it can do this step
    }
  }
  return options;
}

function scoreOption(game, level, option, turns, profile) {
  const { f, blockId, type } = option;
  const kind = type ?? getBlockById(game.board, blockId).type;
  // Personality: a weight on what the option is already worth (never turns a bad option good).
  const lean = (score) => (score > 0 ? score * categoryWeight(profile, kind) * (type ? 1 : weight(profile, 'upgrade')) : score);
  if (level === 'normal') return { ...option, score: lean(f.delta.net * turns + f.delta.cityValue) };
  // Hard: today's events only last so long; after that the block earns its event-free income.
  const calmForecast = forecast(calm(game), blockId, type);
  const paydays = eventPaydaysLeft(game);
  const eventTurns = Math.min(turns, paydays);
  // Upkeep follows what was actually paid, so today's surcharge (or discount) changes it for good.
  const upkeepGap = calmForecast.ok ? f.delta.upkeep - calmForecast.delta.upkeep : 0;
  const baseNet = calmForecast.ok ? calmForecast.delta.net - upkeepGap : f.delta.net;
  let score = f.delta.net * eventTurns + baseNet * (turns - eventTurns) + f.delta.cityValue;
  // A price surcharge that ends this round: buying next turn (one payday fewer) can be better.
  const surcharge = f.eventPrice.filter((i) => i.multiplier > 1);
  if (surcharge.length && calmForecast.ok && turns >= 3 && eventPaydaysLeft(game, surcharge.map((i) => i.instance)) === 0) {
    const later = calmForecast.delta.net * (turns - 1) + calmForecast.delta.cityValue;
    if (later > score) return { ...option, score: -Infinity, roi: -Infinity, waiting: true };
  }
  // Downturn: nothing that leaves net income negative while it lasts.
  if (downturns(game).length && f.after.net < 0) return { ...option, score: -Infinity, roi: -Infinity };
  if (kind === 'civic') {
    score += Math.round(shelteredIncome(game, blockId, type) * CPU.CIVIC_SHELTER_VALUE * emergencyExposure(game)
      * turns * weight(profile, 'shelter'));
  }
  if (type) score += Math.round(districtPotential(game, blockId, type, turns) * weight(profile, 'district'));
  const weighted = lean(score);
  return { ...option, score: weighted, roi: score / Math.max(1, f.cost) };
}

const describe = (o, reason) => ({
  action: o.type ? 'build' : 'upgrade',
  blockId: o.blockId,
  ...(o.type && { type: o.type }),
  reason,
  cost: o.f.cost,
  score: o.score ?? null,
  net: o.f.delta.net,
  cityValue: o.f.delta.cityValue,
});

/** Picks the best purchase for `blockIds`, or explains why none. */
function choosePurchase(game, level, blockIds, rand, reserve, { capture, profile }) {
  const all = developmentOptions(game, blockIds, { buyableOnly: true });
  const affordable = all.filter((o) => o.f.affordable);
  if (!affordable.length) return { reason: CITY_REASONS.NO_CASH };
  const kept = affordable.filter((o) => o.f.after.cash >= cashFloor(game, level, reserve, o.f));
  if (!kept.length) return { reason: CITY_REASONS.CONSERVE };

  if (level === 'easy') {
    const sensible = kept.filter((o) => o.f.delta.net > 0);
    const chance = capture ? CPU.EASY_BUILD_CHANCE : CPU.EASY_MANAGE_CHANCE;
    if (!sensible.length) return { reason: CITY_REASONS.NOT_WORTH_IT };
    if (rand() >= chance) return { reason: CITY_REASONS.PASS };
    // A random sensible pick, leaning towards the personality's favourite categories.
    const weights = sensible.map((o) => categoryWeight(profile, o.type ?? getBlockById(game.board, o.blockId).type));
    let roll = rand() * weights.reduce((a, b) => a + b, 0);
    const pick = sensible.find((o, i) => (roll -= weights[i]) < 0) ?? sensible.at(-1);
    return { pick: describe(pick, CITY_REASONS.RANDOM) };
  }

  const turns = turnsLeft(game, level);
  const judged = kept.map((o) => scoreOption(game, level, o, turns, profile));
  const scored = judged.filter((o) => o.score > 0 && (level !== 'hard' || o.roi >= CPU.HARD_MIN_ROI));
  if (!scored.length) return { reason: judged.some((o) => o.waiting) ? CITY_REASONS.WAIT : CITY_REASONS.NOT_WORTH_IT };
  const top = Math.max(...scored.map((o) => o.score));
  const ties = scored.filter((o) => o.score === top);
  return { pick: describe(ties[Math.floor(rand() * ties.length)], CITY_REASONS.DEVELOP) };
}

/**
 * Read-only: how a CPU mayor judges every build/upgrade on `blockIds` (default: all its blocks,
 * or the pending capture) right now. [{ blockId, type, cost, affordable, keepsReserve, score,
 * roi, waiting }], best first; `waiting` marks an option Hard is holding off on until a price
 * surcharge ends. Handy for tests and for explaining a bot's choice.
 */
export function evaluatePurchases(game, options = {}) {
  return withMemo(() => judgePurchases(game, options));
}

function judgePurchases(game, { difficulty, reserve, blockIds }) {
  const me = currentPlayer(game);
  const level = difficulty ?? me.difficulty ?? 'normal';
  const profile = profileOf(me);
  const keep = reserve ?? defaultReserve(level, me);
  const ids = blockIds ?? (game.turnPhase === TURN_PHASES.CAPTURE_DEVELOP && game.pendingCaptures.length
    ? [game.pendingCaptures[0]] : blocksOwnedBy(game.board, me.seat).map((b) => b.id));
  const turns = turnsLeft(game, level);
  return developmentOptions(game, ids).map((o) => {
    const judged = level === 'easy' ? { ...o, score: o.f.delta.net } : scoreOption(game, level, o, turns, profile);
    return {
      blockId: o.blockId, type: o.type ?? getBlockById(game.board, o.blockId).type, upgrade: !o.type,
      cost: o.f.cost, affordable: o.f.affordable,
      keepsReserve: o.f.affordable && o.f.after.cash >= cashFloor(game, level, keep, o.f),
      score: judged.score, roi: judged.roi ?? null, waiting: Boolean(judged.waiting),
    };
  }).sort((a, b) => b.score - a.score);
}

/* ---------------- debt ---------------- */

/** What a sale or downgrade costs this mayor: net income per turn and City Value, from a real copy. */
function debtOptions(game) {
  const seat = currentPlayer(game).seat;
  const player = currentPlayer(game);
  const stats = playerStats(game, player);
  const netBefore = stats.income - stats.upkeep;
  const valueBefore = scorePlayer(game, player).cityValue;
  const options = [];
  for (const block of blocksOwnedBy(game.board, seat).filter(isDeveloped)) {
    for (const [action, quote, run] of [['downgrade', quoteDowngrade, downgradeBlock], ['sell', quoteSale, sellDevelopment]]) {
      const q = quote(game, block.id);
      if (!q.ok) continue;
      if (action === 'sell' && block.level === 1) continue; // same as a downgrade
      const sim = structuredClone(slim(game));
      if (!run(sim, block.id).ok) continue;
      const after = currentPlayer(sim);
      const s = playerStats(sim, after);
      options.push({
        action, blockId: block.id, refund: q.refund,
        netLoss: netBefore - (s.income - s.upkeep),
        valueLoss: valueBefore - scorePlayer(sim, after).cityValue,
      });
    }
  }
  return options;
}

function chooseDebtAction(game, level, rand) {
  const status = distressStatus(game);
  if (status.canDeclare) return { action: 'bankruptcy', reason: CITY_REASONS.BANKRUPT, debt: status.debt };
  const options = debtOptions(game);
  if (level === 'easy') {
    const downgrades = options.filter((o) => o.action === 'downgrade');
    const o = downgrades[Math.floor(rand() * downgrades.length)];
    return { action: o.action, blockId: o.blockId, reason: CITY_REASONS.DEBT, refund: o.refund };
  }
  const turns = turnsLeft(game, level);
  const cost = (o) => (level === 'normal'
    ? o.netLoss / Math.max(1, o.refund)
    : (o.netLoss * turns + o.valueLoss) / Math.max(1, Math.min(o.refund, status.debt)));
  const best = options.reduce((a, b) => (cost(b) < cost(a) ? b : a));
  return { action: best.action, blockId: best.blockId, reason: CITY_REASONS.DEBT, refund: best.refund };
}

/* ---------------- redevelopment (abandoned blocks) ---------------- */

/**
 * What winning `blockId` at its reserve price is worth to `seat`: the real auction run on a
 * copy with only that bid, read back as (net income per turn × turns left + City Value change).
 * For "clear & rebuild" (Normal/Hard) the empty lot is also worth the best building the mayor
 * could put on it on its next turn (forecast on the same copy). Returns null when the seat
 * can't take part.
 */
function redevelopmentSurplus(game, seat, blockId, mode, turns, level = 'normal') {
  // Asked again by the mayor's own sealed bid in the same decision: valued once.
  return remember(game, `surplus|${seat}|${blockId}|${mode}|${turns}|${level}`,
    () => surplusOnCopy(game, seat, blockId, mode, turns, level));
}

function surplusOnCopy(game, seat, blockId, mode, turns, level) {
  const q = quoteRedevelopment(game, blockId, mode);
  if (!q.ok) return null;
  const sim = structuredClone(slim(game));
  const before = getPlayer(sim, seat);
  const statsBefore = playerStats(sim, before);
  const valueBefore = scorePlayer(sim, before).cityValue;
  if (!resolveRedevelopmentAuction(sim, blockId, mode, [{ seat, bid: q.reserve }]).ok) return null;
  const after = getPlayer(sim, seat);
  const statsAfter = playerStats(sim, after);
  const net = (statsAfter.income - statsAfter.upkeep) - (statsBefore.income - statsBefore.upkeep);
  let surplus = net * turns + scorePlayer(sim, after).cityValue - valueBefore;
  if (mode === ACQUIRE_MODES.REBUILD && level !== 'easy' && turns > 1) {
    // Imagine its own next Manage City on the copy: what would it build there?
    sim.turnIndex = sim.players.findIndex((p) => p.seat === seat);
    sim.turnPhase = TURN_PHASES.MANAGE_CITY;
    sim.pendingCaptures = [];
    sim.city.actionsLeft = actionsPerTurnFor(sim); // a fresh Manage City (the auction spent this one)
    let best = 0;
    for (const type of CATEGORY_ORDER) {
      const f = forecastDevelopment(sim, blockId, type);
      if (f.ok && f.affordable) best = Math.max(best, f.delta.net * (turns - 1) + f.delta.cityValue);
    }
    surplus += best;
  }
  return { reserve: q.reserve, surplus };
}

/** How much of its surplus a CPU mayor will bid above the reserve price (before personality). */
const BID_SHARE = { easy: 0, normal: 0.5, hard: 0.8 };

/**
 * A CPU seat's sealed bid for an abandoned block in a redevelopment auction, or null to pass.
 * Bids never exceed what the mayor can pay while keeping its cash reserve (Hard: plus next
 * turn's charges), never exceed what the lot is worth to it, and are whole multiples of the
 * minimum increment above the reserve price (as the auction requires).
 *   easy    the reserve price, half the time
 *   normal  the reserve price plus half the lot's surplus value to it
 *   hard    the reserve price when no rival could pay it; otherwise just enough to beat the
 *           richest eligible rival's whole cash (bids must be affordable), up to 80% of the surplus
 */
export function chooseRedevelopmentBid(game, seat, blockId, mode, options = {}) {
  return withMemo(() => bidFor(game, seat, blockId, mode, options));
}

function bidFor(game, seat, blockId, mode, { difficulty, reserve }) {
  const player = getPlayer(game, seat);
  const block = getBlockById(game.board, blockId);
  if (!player || !block) return null;
  const eligible = eligibleRedevelopers(game, block);
  if (!eligible.some((p) => p.seat === seat)) return null;
  const level = difficulty ?? player.difficulty ?? 'normal';
  const profile = profileOf(player);
  const keep = reserve ?? defaultReserve(level, player);
  const turns = turnsLeft(game, level);
  const value = redevelopmentSurplus(game, seat, blockId, mode, turns, level);
  if (!value) return null;
  // Cash risk: Hard also keeps next turn's upkeep and repair bills in hand.
  const stats = playerStats(game, player);
  const risk = level === 'hard' ? stats.upkeep + pendingRepairs(game, seat) : 0;
  const budget = player.cash - keep - risk;
  if (budget < value.reserve) return null;
  if (level === 'easy') {
    const rand = stream(mix(defaultCpuSeed(game), game.log.length, seat, blockId.length, mode.length));
    return rand() < 0.5 ? value.reserve : null;
  }
  if (value.surplus <= 0) return null;
  const step = ECONOMY.FINANCE.REDEVELOPMENT.MIN_BID_INCREMENT;
  const onGrid = (amount) => value.reserve + Math.floor((amount - value.reserve) / step) * step;
  const share = Math.min(1, BID_SHARE[level] * weight(profile, 'redevelop'));
  const most = Math.min(budget, value.reserve + value.surplus * share);
  if (level === 'hard') {
    const rivals = eligible.filter((p) => p.seat !== seat && p.cash >= value.reserve);
    if (!rivals.length) return value.reserve; // uncontested: no need to pay more
    const richest = Math.max(...rivals.map((p) => p.cash));
    // Nobody can bid more than their cash: one step above the richest rival wins outright.
    const winning = value.reserve + (Math.floor((richest - value.reserve) / step) + 1) * step;
    return onGrid(Math.min(most, winning));
  }
  return onGrid(most);
}

/** Sealed bids from every eligible CPU seat (humans bid through the auction panel). */
export function cpuBids(game, blockId, mode) {
  return measure('cpuBids', () => withMemo(() => sealedBids(game, blockId, mode)));
}

function sealedBids(game, blockId, mode) {
  const block = getBlockById(game.board, blockId);
  if (!block) return [];
  return eligibleRedevelopers(game, block).filter(isCpu)
    .map((p) => ({ seat: p.seat, bid: chooseRedevelopmentBid(game, p.seat, blockId, mode) }))
    .filter((b) => b.bid != null);
}

/**
 * Normal/Hard, Manage City: the abandoned block (and whether to restore it or clear and
 * rebuild) most worth opening an auction for, if any.
 */
function chooseRedevelopment(game, level, reserve, profile) {
  if (level === 'easy') return null;
  const me = currentPlayer(game);
  const turns = turnsLeft(game, level);
  let best = null;
  for (const block of game.board.blocks.filter((b) => b.abandoned && b.ownerSeat == null)) {
    if (!eligibleRedevelopers(game, block).some((p) => p.seat === me.seat)) continue;
    for (const mode of [ACQUIRE_MODES.RESTORE, ACQUIRE_MODES.REBUILD]) {
      const value = redevelopmentSurplus(game, me.seat, block.id, mode, turns, level);
      if (!value || value.surplus <= 0 || me.cash - value.reserve < reserve) continue;
      // Only open bidding it will take part in: its own sealed bid (same reserve, same cash
      // risk rules) must be valid, or the auction would settle with no bids and the bot would
      // ask to open it again.
      if (chooseRedevelopmentBid(game, me.seat, block.id, mode, { difficulty: level, reserve }) == null) continue;
      const score = value.surplus * weight(profile, 'redevelop');
      if (!best || score > best.score) {
        best = { action: 'redevelop', blockId: block.id, mode, reason: CITY_REASONS.DEVELOP, cost: value.reserve, score };
      }
    }
  }
  return best;
}

/* ---------------- hostile takeovers (CITY era, core/takeover.js) ---------------- */

/**
 * What taking `blockId` over is worth to the current mayor: the real takeover run on a copy,
 * read back as (net income per turn × turns left + City Value change), plus the cash and upkeep
 * it would leave. Null when the rules refuse it.
 */
function takeoverValue(game, blockId, turns) {
  const q = quoteTakeover(game, blockId);
  if (!q.ok) return null;
  const sim = structuredClone(slim(game));
  const seat = currentPlayer(sim).seat;
  const before = getPlayer(sim, seat);
  const statsBefore = playerStats(sim, before);
  const valueBefore = scorePlayer(sim, before).cityValue;
  if (!takeoverBlock(sim, blockId).ok) return null;
  const after = getPlayer(sim, seat);
  const statsAfter = playerStats(sim, after);
  const net = (statsAfter.income - statsAfter.upkeep) - (statsBefore.income - statsBefore.upkeep);
  return {
    cost: q.cost, surplus: net * turns + scorePlayer(sim, after).cityValue - valueBefore,
    cashAfter: after.cash, upkeepAfter: statsAfter.upkeep,
  };
}

/**
 * Normal/Hard, CITY era Manage City: the rival block most worth taking over, judged
 * conservatively (CPU.TAKEOVER): enough paydays left, a clear return on the price, and cash to
 * spare afterwards. Easy never tries. Null when nothing qualifies.
 */
function chooseTakeover(game, level, reserve, profile) {
  if (level === 'easy' || game.era !== ERAS.CITY) return null;
  const turns = turnsLeft(game, level);
  if (turns < CPU.TAKEOVER.MIN_TURNS) return null;
  let best = null;
  for (const q of takeoverCandidates(game)) {
    if (!q.ok) continue;
    const value = takeoverValue(game, q.blockId, turns);
    if (!value || value.surplus < value.cost * CPU.TAKEOVER.MIN_RETURN) continue;
    if (value.cashAfter < reserve + value.upkeepAfter * CPU.TAKEOVER.CASH_TURNS) continue;
    const score = value.surplus * weight(profile, 'redevelop');
    if (!best || score > best.score) best = { action: 'takeover', blockId: q.blockId, reason: CITY_REASONS.TAKEOVER, cost: value.cost, score };
  }
  return best;
}

/* ---------------- entry points ---------------- */

/**
 * The next thing the current (CPU) mayor should do in Manage City or Capture / Develop.
 * Options: difficulty (default: the seat's own), seed (default: public facts + progress this
 * turn), reserve (dollars to keep after any purchase; default CPU.RESERVE[difficulty] adjusted
 * by the seat's personality).
 */
export function chooseCityAction(game, options = {}) {
  return measure('chooseCityAction', () => withMemo(() => pickCityAction(game, options)));
}

function pickCityAction(game, { difficulty, seed, reserve }) {
  if (game.phase !== PHASES.PLAYING) return { action: null, error: 'game-over' };
  const me = currentPlayer(game);
  const level = difficulty ?? me.difficulty ?? 'normal';
  const profile = profileOf(me);
  const keep = reserve ?? defaultReserve(level, me);
  // Each step this turn (a build, a sale) changes the log, so a fresh draw per decision.
  const rand = stream(seed ?? mix(defaultCpuSeed(game), game.log.length));

  if (game.turnPhase === TURN_PHASES.CAPTURE_DEVELOP && game.pendingCaptures.length) {
    const blockId = game.pendingCaptures[0];
    const { pick, reason } = choosePurchase(game, level, [blockId], rand, keep, { capture: true, profile });
    return pick ?? { action: 'vacant', blockId, reason };
  }
  if (game.turnPhase !== TURN_PHASES.MANAGE_CITY) return { action: null, error: 'wrong-turn-phase' };
  if (me.cash < 0) return chooseDebtAction(game, level, rand);
  // Done managing: pave (EXPANSION) or end the turn (CITY, where roads are closed).
  const done = game.era === ERAS.CITY ? 'end-turn' : 'pave';
  if (outOfCityActions(game)) return { action: done, reason: CITY_REASONS.NO_ACTIONS };
  const owned = blocksOwnedBy(game.board, me.seat).map((b) => b.id);
  const { pick, reason } = choosePurchase(game, level, owned, rand, keep, { capture: false, profile });
  // The best of a build/upgrade, a redevelopment auction and a takeover (Easy: builds only).
  const options = [pick, chooseRedevelopment(game, level, keep, profile), chooseTakeover(game, level, keep, profile)].filter(Boolean);
  if (!options.length) return { action: done, reason };
  return options.reduce((a, b) => ((b.score ?? 0) > (a.score ?? 0) ? b : a));
}

/** Plays a decision from chooseCityAction() through the normal game APIs. */
export function applyCityAction(game, decision) {
  switch (decision?.action) {
    case 'build': {
      // As in the UI: building on a just-captured block settles its Develop Now choice.
      const capturing = game.turnPhase === TURN_PHASES.CAPTURE_DEVELOP && game.pendingCaptures[0] === decision.blockId;
      const result = buildOnBlock(game, decision.blockId, decision.type);
      if (result.ok && capturing) resolveCapture(game, decision.blockId);
      return result;
    }
    case 'upgrade': return upgradeBlock(game, decision.blockId);
    case 'vacant': return { ok: resolveCapture(game, decision.blockId) };
    case 'downgrade': return downgradeBlock(game, decision.blockId);
    case 'sell': return sellDevelopment(game, decision.blockId);
    case 'bankruptcy': return declareBankruptcy(game);
    // Every eligible CPU seat bids; people add theirs as decision.humanBids (the auction panel).
    case 'redevelop': return resolveRedevelopmentAuction(game, decision.blockId, decision.mode,
      [...cpuBids(game, decision.blockId, decision.mode), ...(decision.humanBids ?? [])]);
    case 'takeover': return takeoverBlock(game, decision.blockId);
    case 'pave': return { ok: startPaving(game) };
    case 'end-turn': return endCityTurn(game);
    default: return { ok: false, error: decision?.error ?? 'no-action' };
  }
}
