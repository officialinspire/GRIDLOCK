/**
 * CPU strategy for MANAGE CITY and CAPTURE / DEVELOP. Pure: chooseCityAction() returns the
 * next action and changes nothing; applyCityAction() plays a decision through the normal
 * game APIs. Ask, apply, ask again, until the answer is "pave" (Manage City) or the capture
 * choice is resolved.
 *
 *   { action: 'build', blockId, type }   build Level 1 on a vacant block
 *   { action: 'upgrade', blockId }       raise a building one level
 *   { action: 'vacant', blockId }        leave a just-captured block empty (Capture / Develop)
 *   { action: 'downgrade' | 'sell', blockId }   raise cash while in debt
 *   { action: 'bankruptcy' }             only when selling everything can't cover the debt
 *   { action: 'pave' }                   done managing: go pave a road
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
 * Randomness (Easy's choices, ties) comes from the CPU's own stream, never the game RNG.
 */
import { CPU, CITY_EVENTS, ECONOMY } from '../../config.js';
import { currentPlayer, playerStats, resolveCapture, startPaving, TURN_PHASES, PHASES } from '../game.js';
import { blocksOwnedBy, getBlockById, neighbors } from '../board.js';
import { buildOnBlock, upgradeBlock, isDeveloped, MAX_LEVEL } from '../development.js';
import { CATEGORY_ORDER } from '../buildings.js';
import { distressStatus, declareBankruptcy, quoteDowngrade, quoteSale, downgradeBlock, sellDevelopment } from '../finance.js';
import { forecastDevelopment, blockDetails } from '../forecast.js';
import { scorePlayer } from '../scoring.js';
import { eventRules } from '../modes.js';
import { expectedTurnsLeft } from './roads.js';
import { stream, mix, defaultCpuSeed } from './random.js';

export const CITY_REASONS = Object.freeze({
  DEBT: 'debt', // raising cash to get out of distress
  BANKRUPT: 'bankrupt', // selling everything couldn't cover the debt
  DEVELOP: 'develop', // a build or upgrade worth its cost
  CONSERVE: 'conserve', // something is affordable, but only by dipping into the reserve
  NOT_WORTH_IT: 'not-worth-it', // affordable, but it wouldn't pay back before the city is done
  NO_CASH: 'no-cash', // nothing affordable
  RANDOM: 'random', // easy: an unplanned but sensible purchase
  PASS: 'pass', // easy: chose not to spend this time
});

/** Copies are cheaper without the history, which no forecast reads. */
const slim = (game) => ({ ...game, ledger: [], log: [] });
const fireDef = CITY_EVENTS.POOL.find((e) => e.id === 'fire');

function pendingRepairs(game, seat) {
  return game.events.repairs.filter((r) => r.seat === seat).reduce((n, r) => n + r.amount, 0);
}

/** Cash that must still be in hand after buying what forecast `f` describes. */
function cashFloor(game, level, reserve, f) {
  if (level === 'easy') return reserve;
  const seat = currentPlayer(game).seat;
  const charges = f.after.upkeep + pendingRepairs(game, seat);
  if (level === 'normal') return reserve + charges;
  // Hard: survive next turn's charges even if income were halved, and a Fire on a building.
  const exposed = eventRules(game).enabled && fireDef
    && blocksOwnedBy(game.board, seat).some((b) => isDeveloped(b) && fireDef.targets.categories.includes(b.type));
  const fire = exposed || fireDef?.targets.categories.includes(f.type) ? fireDef.repairCost : 0;
  return reserve + Math.max(0, charges + fire - Math.floor(f.after.income / 2));
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

/** Rounds the currently active city events still have to run (0 when calm). */
function eventRoundsLeft(game) {
  return Math.max(0, ...game.events.active.map((e) => e.endRound - game.round + 1));
}

/* ---------------- options ---------------- */

/** Every build (vacant blocks) or upgrade (developed blocks) on `blockIds` the forecast allows. */
function developmentOptions(game, blockIds) {
  const options = [];
  for (const blockId of blockIds) {
    const block = getBlockById(game.board, blockId);
    const types = block.level === 0 ? CATEGORY_ORDER : block.level < MAX_LEVEL ? [undefined] : [];
    for (const type of types) {
      const f = forecastDevelopment(slim(game), blockId, type);
      if (f.ok) options.push({ blockId, type, f });
    }
  }
  return options;
}

function scoreOption(game, level, option, turns) {
  const { f, blockId, type } = option;
  if (level === 'normal') return { ...option, score: f.delta.net * turns + f.delta.cityValue };
  // Hard: today's events only last so long; after that the block earns its event-free income.
  const calm = forecastDevelopment({ ...slim(game), events: { ...game.events, active: [] } }, blockId, type);
  const eventTurns = Math.min(turns, eventRoundsLeft(game));
  const baseNet = calm.ok ? calm.delta.net : f.delta.net;
  let score = f.delta.net * eventTurns + baseNet * (turns - eventTurns) + f.delta.cityValue;
  const kind = type ?? getBlockById(game.board, blockId).type;
  if (kind === 'civic' && eventRules(game).enabled) score += Math.round(shelteredIncome(game, blockId, type) * CPU.CIVIC_SHELTER_VALUE * turns);
  if (type) score += districtPotential(game, blockId, type, turns);
  return { ...option, score, roi: score / Math.max(1, f.cost) };
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
function choosePurchase(game, level, blockIds, rand, reserve, { capture }) {
  const all = developmentOptions(game, blockIds);
  const affordable = all.filter((o) => o.f.affordable);
  if (!affordable.length) return { reason: CITY_REASONS.NO_CASH };
  const kept = affordable.filter((o) => o.f.after.cash >= cashFloor(game, level, reserve, o.f));
  if (!kept.length) return { reason: CITY_REASONS.CONSERVE };

  if (level === 'easy') {
    const sensible = kept.filter((o) => o.f.delta.net > 0);
    const chance = capture ? CPU.EASY_BUILD_CHANCE : CPU.EASY_MANAGE_CHANCE;
    if (!sensible.length) return { reason: CITY_REASONS.NOT_WORTH_IT };
    if (rand() >= chance) return { reason: CITY_REASONS.PASS };
    return { pick: describe(sensible[Math.floor(rand() * sensible.length)], CITY_REASONS.RANDOM) };
  }

  const turns = expectedTurnsLeft(game, { lookAhead: level === 'hard' });
  const scored = kept.map((o) => scoreOption(game, level, o, turns))
    .filter((o) => o.score > 0 && (level !== 'hard' || o.roi >= CPU.HARD_MIN_ROI));
  if (!scored.length) return { reason: CITY_REASONS.NOT_WORTH_IT };
  const top = Math.max(...scored.map((o) => o.score));
  const ties = scored.filter((o) => o.score === top);
  return { pick: describe(ties[Math.floor(rand() * ties.length)], CITY_REASONS.DEVELOP) };
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
  const turns = expectedTurnsLeft(game, { lookAhead: level === 'hard' });
  const cost = (o) => (level === 'normal'
    ? o.netLoss / Math.max(1, o.refund)
    : (o.netLoss * turns + o.valueLoss) / Math.max(1, Math.min(o.refund, status.debt)));
  const best = options.reduce((a, b) => (cost(b) < cost(a) ? b : a));
  return { action: best.action, blockId: best.blockId, reason: CITY_REASONS.DEBT, refund: best.refund };
}

/* ---------------- entry points ---------------- */

/**
 * The next thing the current (CPU) mayor should do in Manage City or Capture / Develop.
 * Options: difficulty (default: the seat's own), seed (default: public facts + progress this
 * turn), reserve (dollars to keep after any purchase; default CPU.RESERVE[difficulty]).
 */
export function chooseCityAction(game, { difficulty, seed, reserve } = {}) {
  if (game.phase !== PHASES.PLAYING) return { action: null, error: 'game-over' };
  const me = currentPlayer(game);
  const level = difficulty ?? me.difficulty ?? 'normal';
  const keep = reserve ?? CPU.RESERVE[level] ?? CPU.RESERVE.normal;
  // Each step this turn (a build, a sale) changes the log, so a fresh draw per decision.
  const rand = stream(seed ?? mix(defaultCpuSeed(game), game.log.length));

  if (game.turnPhase === TURN_PHASES.CAPTURE_DEVELOP && game.pendingCaptures.length) {
    const blockId = game.pendingCaptures[0];
    const { pick, reason } = choosePurchase(game, level, [blockId], rand, keep, { capture: true });
    return pick ?? { action: 'vacant', blockId, reason };
  }
  if (game.turnPhase !== TURN_PHASES.MANAGE_CITY) return { action: null, error: 'wrong-turn-phase' };
  if (me.cash < 0) return chooseDebtAction(game, level, rand);
  const owned = blocksOwnedBy(game.board, me.seat).map((b) => b.id);
  const { pick, reason } = choosePurchase(game, level, owned, rand, keep, { capture: false });
  return pick ?? { action: 'pave', reason };
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
    case 'pave': return { ok: startPaving(game) };
    default: return { ok: false, error: decision?.error ?? 'no-action' };
  }
}
