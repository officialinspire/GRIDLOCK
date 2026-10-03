#!/usr/bin/env node
/**
 * Deterministic balance simulator: plays hundreds of complete games through the real
 * rules engine (js/core) with scripted mayors, then reports game length, bankruptcies,
 * what gets built, final cash / City Value spread, city events, seat-order bias and
 * capture chains. Games run to the real end: the EXPANSION era's roads, then the CITY era's
 * rounds (City Actions only; each mayor ends its City turn when done investing).
 *
 *   npm run simulate -- [--games 600] [--seed 1] [--mode standard|classic|chaos|all] [--json]
 *
 * Determinism: a game's own seed drives city events (core/rng.js) and a separate
 * mulberry32 stream, derived from the same seed, drives every bot decision. The same
 * arguments always print the same report.
 *
 * Mayors (personas), mixed across tables and rotated through seat order:
 *   planner   dots-and-boxes aware (takes captures, avoids handing out blocks, sacrifices
 *             the shortest chain) and develops by forecast: the real transaction's net
 *             income per turn × turns left + its City Value change (core/forecast.js)
 *   casual    mostly safe roads with the odd blunder; builds a random affordable
 *             category on most captures and upgrades now and then
 *   saver     the planner's roads, but never builds (does hoarding beat developing?)
 *   spender   the planner's roads; spends every dollar on the highest-income build or
 *             upgrade it can afford, with no reserve (can distress and bankruptcy happen?)
 */
import {
  createGame, placeRoad, currentPlayer, resolveCapture, endCityTurn, cityTurnsLeft, TURN_PHASES, PHASES, ERAS,
} from '../js/core/game.js';
import { blocksOwnedBy, allRoadIds, roadBlocks, blockRoadIds, totalRoads } from '../js/core/board.js';
import { buildOnBlock, upgradeBlock, isDeveloped, MAX_LEVEL } from '../js/core/development.js';
import { distressStatus, declareBankruptcy, downgradeBlock } from '../js/core/finance.js';
import { forecastDevelopment } from '../js/core/forecast.js';
import { CATEGORY_ORDER } from '../js/core/buildings.js';
import { MODE_IDS } from '../js/core/modes.js';

/* ---------------- deterministic helpers ---------------- */

export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rand, list) => list[Math.floor(rand() * list.length)];

/* ---------------- roads: a small dots-and-boxes model ---------------- */

/** Sides built around a block, from the live board. */
const sides = (board, block) => blockRoadIds(block).reduce((n, id) => n + (id in board.roads ? 1 : 0), 0);
const claimable = (block) => block.ownerSeat == null && !block.abandoned;

/** Roads that would enclose a claimable block right now. */
function closingRoads(board, free) {
  return free.filter((id) => roadBlocks(board, id).some((b) => claimable(b) && sides(board, b) === 3));
}

/** A road is safe when it leaves no claimable block on three sides for the next mayor. */
function safeRoads(board, free) {
  return free.filter((id) => roadBlocks(board, id).every((b) => !claimable(b) || sides(board, b) < 2));
}

/** How many blocks the next mayor could chain-capture after `id` is paved (greedy). */
function giveaway(board, id) {
  const roads = new Set(Object.keys(board.roads));
  roads.add(id);
  const count = (b) => blockRoadIds(b).reduce((n, r) => n + (roads.has(r) ? 1 : 0), 0);
  const taken = new Set();
  let captured = 0;
  for (let guard = 0; guard < 100; guard++) {
    const block = board.blocks.find((b) => claimable(b) && !taken.has(b.id) && count(b) === 3);
    if (!block) break;
    const road = blockRoadIds(block).find((r) => !roads.has(r));
    roads.add(road);
    for (const b of roadBlocks(board, road)) {
      if (claimable(b) && !taken.has(b.id) && count(b) === 4) { taken.add(b.id); captured++; }
    }
  }
  return captured;
}

function chooseRoad(game, persona, rand) {
  const { board } = game;
  const free = allRoadIds(board).filter((id) => !(id in board.roads));
  if (persona === 'casual' && rand() < 0.08) return pick(rand, free); // the odd blunder
  const closing = closingRoads(board, free);
  if (closing.length) return pick(rand, closing);
  const safe = safeRoads(board, free);
  if (safe.length) return pick(rand, safe);
  if (persona === 'casual') return pick(rand, free);
  let best = null;
  for (const id of free) {
    const lost = giveaway(board, id);
    if (!best || lost < best.lost || (lost === best.lost && rand() < 0.5)) best = { id, lost };
  }
  return best.id;
}

/* ---------------- money ---------------- */

/**
 * Own turns this mayor can still expect. Once safe roads run out, the rest of the board
 * goes in a few long capture chains, so turns left ≈ safe moves still to play (about half
 * the safe roads, since each one tends to spoil another) plus one per chain, per mayor.
 */
function turnsLeft(game) {
  const city = cityTurnsLeft(game);
  if (city != null) return city; // CITY era: known exactly
  const { board } = game;
  const free = allRoadIds(board).filter((id) => !(id in board.roads));
  const safe = safeRoads(board, free).length;
  const open = board.blocks.filter(claimable).length;
  const chains = Math.ceil(open / 4);
  return Math.max(0, Math.floor((safe / 2 + chains) / game.players.length));
}

/** Forecast on a slim copy: the ledger and log don't affect outcomes, only copy time. */
const forecast = (game, blockId, type) => forecastDevelopment({ ...game, ledger: [], log: [] }, blockId, type);

/** Planner: the build or upgrade with the best (net per turn × turns left + City Value change). */
function bestInvestment(game, blockIds) {
  const me = currentPlayer(game);
  const horizon = turnsLeft(game);
  let best = null;
  for (const id of blockIds) {
    const block = game.board.blocks.find((b) => b.id === id);
    const options = block.level === 0 ? CATEGORY_ORDER : block.level < MAX_LEVEL ? [undefined] : [];
    for (const type of options) {
      const f = forecast(game, id, type);
      if (!f.ok || !f.affordable || !f.actionAvailable) continue; // no Development/City Action left
      // Keep enough cash to cover upkeep and a Fire repair after this purchase.
      if (f.after.cash < f.after.upkeep * 2 + 400) continue;
      const score = f.delta.net * horizon + f.delta.cityValue;
      if (score > 0 && (!best || score > best.score)) best = { id, type, score };
    }
  }
  return best && me ? best : null;
}

function invest(game, persona, rand, blockIds) {
  if (persona === 'saver') return;
  for (let guard = 0; guard < 20; guard++) {
    if (persona === 'planner') {
      const best = bestInvestment(game, blockIds);
      if (!best) return;
      const done = best.type ? buildOnBlock(game, best.id, best.type) : upgradeBlock(game, best.id);
      if (!done.ok) return;
    } else if (persona === 'spender') {
      const options = [];
      for (const id of blockIds) {
        const block = game.board.blocks.find((b) => b.id === id);
        if (block.level === 0) for (const type of CATEGORY_ORDER) options.push({ id, type });
        else if (block.level < MAX_LEVEL) options.push({ id });
      }
      const affordable = options.map((o) => ({ ...o, f: forecast(game, o.id, o.type) })).filter((o) => o.f.ok && o.f.affordable && o.f.actionAvailable)
        .sort((a, b) => b.f.delta.income - a.f.delta.income);
      if (!affordable.length) return;
      const top = affordable[0];
      if (!(top.type ? buildOnBlock(game, top.id, top.type) : upgradeBlock(game, top.id)).ok) return;
    } else {
      const me = currentPlayer(game);
      const vacant = blockIds.map((id) => game.board.blocks.find((b) => b.id === id)).filter((b) => b.level === 0);
      const developed = blockIds.map((id) => game.board.blocks.find((b) => b.id === id)).filter((b) => isDeveloped(b) && b.level < MAX_LEVEL);
      if (vacant.length && rand() < 0.75) {
        const type = pick(rand, CATEGORY_ORDER);
        if (!buildOnBlock(game, vacant[0].id, type).ok) return;
      } else if (developed.length && me.cash > 4000 && rand() < 0.35) {
        if (!upgradeBlock(game, pick(rand, developed).id).ok) return;
      } else return;
    }
  }
}

/** Distress: sell the least useful level until solvent, or declare bankruptcy when that can't work. */
function resolveDistress(game) {
  for (let guard = 0; guard < 40 && currentPlayer(game).cash < 0; guard++) {
    const status = distressStatus(game);
    if (status.canDeclare) return declareBankruptcy(game);
    const block = blocksOwnedBy(game.board, currentPlayer(game).seat).filter(isDeveloped)
      .sort((a, b) => a.income - b.income || a.level - b.level)[0];
    downgradeBlock(game, block.id);
  }
  return null;
}

/* ---------------- one game ---------------- */

export function playGame({ seed, mode, personas }) {
  const rand = rng(seed ^ 0x9e3779b9);
  const seats = personas.map((_, i) => ({ seat: i + 1 }));
  const game = createGame({ seats, seed, mode });
  const personaOf = (seat) => personas[seat - 1];
  let steps = 0;
  while (game.phase === PHASES.PLAYING) {
    if (++steps > 5000) throw new Error(`seed ${seed}: runaway game`);
    const me = currentPlayer(game);
    const persona = personaOf(me.seat);
    if (me.cash < 0) { resolveDistress(game); continue; }
    if (game.turnPhase === TURN_PHASES.CAPTURE_DEVELOP) {
      while (game.turnPhase === TURN_PHASES.CAPTURE_DEVELOP && game.pendingCaptures.length) {
        const id = game.pendingCaptures[0];
        invest(game, persona, rand, [id]);
        if (game.pendingCaptures[0] === id) resolveCapture(game, id);
      }
    }
    // (After the final road's captures, the CITY era carries on straight into Manage City.)
    if (game.turnPhase === TURN_PHASES.MANAGE_CITY) {
      invest(game, persona, rand, blocksOwnedBy(game.board, me.seat).map((b) => b.id));
    }
    const result = game.era === ERAS.CITY ? endCityTurn(game) : placeRoad(game, chooseRoad(game, persona, rand));
    if (!result.ok) throw new Error(`seed ${seed}: move refused (${result.error})`);
  }
  return game;
}

/* ---------------- statistics ---------------- */

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length || 1;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  const sd = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
  return { mean: Math.round(mean * 10) / 10, sd: Math.round(sd), min: sorted[0] ?? 0, p10: q(0.1), median: q(0.5), p90: q(0.9), max: sorted.at(-1) ?? 0 };
}

const TABLE_PLAN = [
  ['planner', 'planner', 'planner', 'planner'],
  ['planner', 'planner', 'planner'],
  ['planner', 'planner'],
  ['planner', 'casual', 'planner', 'casual'],
  ['planner', 'saver', 'planner', 'saver'],
  ['casual', 'casual', 'casual', 'casual'],
  ['planner', 'casual', 'saver'],
  ['planner', 'saver'],
  ['planner', 'spender', 'planner', 'spender'],
  ['spender', 'spender', 'spender'],
];

function permutations(list) {
  if (list.length <= 1) return [list];
  return list.flatMap((item, i) => permutations([...list.slice(0, i), ...list.slice(i + 1)]).map((rest) => [item, ...rest]));
}
const SEATINGS = TABLE_PLAN.map((plan) => [...new Map(permutations(plan).map((p) => [p.join(), p])).values()]);

/** The table for game `i`: a persona mix from TABLE_PLAN, cycling through every seating order. */
export function tableFor(i) {
  const orders = SEATINGS[i % TABLE_PLAN.length];
  return orders[Math.floor(i / TABLE_PLAN.length) % orders.length];
}

export function simulate({ games = 600, seed = 1, modes = MODE_IDS } = {}) {
  const report = {};
  for (const mode of modes) {
    const acc = {
      games: 0, rounds: [], roads: [], bankruptGames: 0, bankruptcies: [], byPersonaBankrupt: {},
      builds: Object.fromEntries(CATEGORY_ORDER.map((c) => [c, 0])), upgrades: Object.fromEntries(CATEGORY_ORDER.map((c) => [c, 0])),
      finalLevels: Object.fromEntries(CATEGORY_ORDER.map((c) => [c, 0])),
      cash: [], cityValue: [], margin: [], marginPct: [], negativeCash: 0, abandonedLeft: [],
      events: {}, eventsPerGame: [], calmRounds: 0, roundsWithDraw: 0,
      seatWins: {}, seatGames: {}, personaWins: {}, personaSeats: {},
      chains: {}, longestChain: [], vacantAtEnd: [], byTable: {}, captureTiming: [0, 0, 0, 0], captureRounds: [], ownTurnsAfterCapture: [],
    };
    for (let i = 0; i < games; i++) {
      const personas = tableFor(i);
      const gameSeed = (seed * 1_000_003 + i * 7919) >>> 0;
      const game = playGame({ seed: gameSeed, mode, personas });
      acc.games++;
      acc.rounds.push(game.round);
      const bankrupt = game.log.filter((e) => e.type === 'bankruptcy');
      acc.bankruptcies.push(bankrupt.length);
      if (bankrupt.length) acc.bankruptGames++;
      for (const b of bankrupt) acc.byPersonaBankrupt[personas[b.seat - 1]] = (acc.byPersonaBankrupt[personas[b.seat - 1]] ?? 0) + 1;
      for (const e of game.log) {
        if (e.type === 'build') acc.builds[e.category]++;
        if (e.type === 'upgrade') acc.upgrades[e.category]++;
      }
      for (const b of game.board.blocks) if (b.ownerSeat != null && isDeveloped(b)) acc.finalLevels[b.type] += b.level;
      acc.vacantAtEnd.push(game.board.blocks.filter((b) => b.ownerSeat != null && b.level === 0).length);
      acc.abandonedLeft.push(game.board.blocks.filter((b) => b.abandoned).length);
      const rows = game.results.rows;
      for (const r of rows) {
        acc.cash.push(r.cash);
        acc.cityValue.push(r.cityValue);
        if (r.cash < 0) acc.negativeCash++;
      }
      const top = rows[0].cityValue;
      const last = rows.at(-1).cityValue;
      acc.margin.push(top - (rows[1]?.cityValue ?? top));
      acc.marginPct.push(Math.round(((top - last) / Math.max(1, top)) * 100));
      for (const h of game.events.history) acc.events[h.id] = (acc.events[h.id] ?? 0) + 1;
      acc.eventsPerGame.push(game.events.history.length);
      acc.roundsWithDraw += game.round - 1;
      // Seat-order bias: only tables of identical mayors, so persona strength can't masquerade as seat.
      const uniform = new Set(personas).size === 1;
      const n = personas.length;
      for (const [idx, persona] of personas.entries()) {
        const key = `${n}p`;
        acc.personaSeats[persona] = (acc.personaSeats[persona] ?? 0) + 1;
        if (uniform) {
          acc.seatGames[key] ??= Array(n).fill(0);
          acc.seatGames[key][idx]++;
        }
      }
      const tableKey = [...personas].sort().join('+');
      const t = (acc.byTable[tableKey] ??= { games: 0, wins: {}, value: {}, seats: {} });
      t.games++;
      for (const r of rows) {
        const persona = personas[r.seat - 1];
        t.value[persona] = (t.value[persona] ?? 0) + r.cityValue;
        t.seats[persona] = (t.seats[persona] ?? 0) + 1;
      }
      const share = 1 / game.results.winners.length;
      for (const seat of game.results.winners) t.wins[personas[seat - 1]] = (t.wins[personas[seat - 1]] ?? 0) + share;
      for (const seat of game.results.winners) {
        const persona = personas[seat - 1];
        acc.personaWins[persona] = (acc.personaWins[persona] ?? 0) + share;
        if (uniform) {
          const key = `${n}p`;
          acc.seatWins[key] ??= Array(n).fill(0);
          acc.seatWins[key][seat - 1] += share;
        }
      }
      // When blocks are captured (quarter of the roads paved) and how many own turn starts follow.
      let paved = 0;
      const roadTotal = totalRoads(game.board);
      for (const e of game.log) {
        if (e.type !== 'road') continue;
        paved++;
        for (let k = 0; k < e.captured.length; k++) acc.captureTiming[Math.min(3, Math.floor(((paved - 1) / roadTotal) * 4))]++;
      }
      for (const e of game.log.filter((x) => x.type === 'road' && x.captured.length)) {
        const at = game.log.indexOf(e);
        const later = game.log.slice(at).filter((x) => x.type === 'round-end').length;
        for (let k = 0; k < e.captured.length; k++) acc.ownTurnsAfterCapture.push(later);
      }
      // Capture chains: consecutive capturing roads by one mayor.
      let run = 0;
      let longest = 0;
      for (const e of [...game.log, { type: 'road', captured: [] }]) {
        if (e.type !== 'road') continue;
        if (e.captured.length) run += e.captured.length;
        else if (run) { acc.chains[run] = (acc.chains[run] ?? 0) + 1; longest = Math.max(longest, run); run = 0; }
      }
      acc.longestChain.push(longest);
    }
    const totalBuilds = Object.values(acc.builds).reduce((s, v) => s + v, 0) || 1;
    const totalEvents = Object.values(acc.events).reduce((s, v) => s + v, 0);
    report[mode] = {
      games: acc.games,
      rounds: summarize(acc.rounds),
      bankruptcy: {
        gamesWithBankruptcy: pct(acc.bankruptGames, acc.games),
        perGame: summarize(acc.bankruptcies).mean,
        byPersona: acc.byPersonaBankrupt,
      },
      builds: Object.fromEntries(CATEGORY_ORDER.map((c) => [c, { builds: acc.builds[c], share: pct(acc.builds[c], totalBuilds), upgrades: acc.upgrades[c], finalLevels: acc.finalLevels[c] }])),
      vacantOwnedAtEnd: summarize(acc.vacantAtEnd).mean,
      abandonedAtEnd: summarize(acc.abandonedLeft).mean,
      finalCash: summarize(acc.cash),
      playersEndingInDebt: pct(acc.negativeCash, acc.cash.length),
      finalCityValue: summarize(acc.cityValue),
      winnerMargin: summarize(acc.margin),
      firstToLastGapPct: summarize(acc.marginPct),
      events: {
        perGame: summarize(acc.eventsPerGame).mean,
        perRound: acc.roundsWithDraw ? Math.round((totalEvents / acc.roundsWithDraw) * 100) / 100 : 0,
        byId: Object.fromEntries(Object.entries(acc.events).sort((a, b) => b[1] - a[1]).map(([id, n]) => [id, pct(n, totalEvents)])),
      },
      seatWinRate: Object.fromEntries(Object.entries(acc.seatWins).map(([k, wins]) => [k, wins.map((w, i) => pct(w, acc.seatGames[k][i]))])),
      personaWinRate: Object.fromEntries(Object.entries(acc.personaWins).map(([p, w]) => [p, pct(w, acc.personaSeats[p])])),
      byTable: Object.fromEntries(Object.entries(acc.byTable).map(([k, t]) => [k, Object.fromEntries(Object.keys(t.seats).map((p) => [p,
        { winRate: pct(t.wins[p] ?? 0, t.seats[p]), avgCityValue: Math.round(t.value[p] / t.seats[p]) }]))])),
      personaWinRateNote: 'wins per seat played (ties split); baseline depends on table size',
      captureChains: Object.fromEntries(Object.entries(acc.chains).sort((a, b) => a[0] - b[0]).map(([len, n]) => [len, n])),
      longestChain: summarize(acc.longestChain),
      captureTimingByQuarter: acc.captureTiming.map((n) => pct(n, acc.captureTiming.reduce((a, b) => a + b, 0))),
      incomeTurnsAfterCapture: summarize(acc.ownTurnsAfterCapture),
    };
  }
  return report;
}

const pct = (n, d) => (d ? `${Math.round((n / d) * 1000) / 10}%` : '—');

/* ---------------- CLI ---------------- */

function printReport(report) {
  for (const [mode, r] of Object.entries(report)) {
    console.log(`\n=== ${mode.toUpperCase()} · ${r.games} games ===`);
    console.log(`Rounds/game          mean ${r.rounds.mean}  median ${r.rounds.median}  range ${r.rounds.min}–${r.rounds.max}`);
    console.log(`Bankruptcy           ${r.bankruptcy.gamesWithBankruptcy} of games · ${r.bankruptcy.perGame}/game · by mayor ${JSON.stringify(r.bankruptcy.byPersona)}`);
    console.log('Builds               ' + Object.entries(r.builds).map(([c, b]) => `${c} ${b.share} (${b.builds}+${b.upgrades}↑)`).join(' · '));
    console.log(`Owned vacant at end  ${r.vacantOwnedAtEnd}/game · abandoned at end ${r.abandonedAtEnd}/game`);
    console.log(`Final cash           mean $${r.finalCash.mean}  p10 $${r.finalCash.p10}  median $${r.finalCash.median}  p90 $${r.finalCash.p90} · in debt ${r.playersEndingInDebt}`);
    console.log(`Final City Value     mean $${r.finalCityValue.mean}  sd $${r.finalCityValue.sd}  p10 $${r.finalCityValue.p10}  p90 $${r.finalCityValue.p90}`);
    console.log(`Winner's margin      median $${r.winnerMargin.median} · first→last gap median ${r.firstToLastGapPct.median}%`);
    console.log(`Events               ${r.events.perGame}/game · ${r.events.perRound}/round · ${JSON.stringify(r.events.byId)}`);
    console.log(`Seat win rate        ${JSON.stringify(r.seatWinRate)} (identical mayors only)`);
    console.log(`Mayor win rate       ${JSON.stringify(r.personaWinRate)}`);
    for (const [table, byP] of Object.entries(r.byTable)) {
      console.log(`  ${table.padEnd(34)} ` + Object.entries(byP).map(([p, v]) => `${p}: wins ${v.winRate}, avg $${v.avgCityValue}`).join(' · '));
    }
    console.log(`Capture timing       by quarter of roads paved ${r.captureTimingByQuarter.join(' / ')} · income turns left after a capture: mean ${r.incomeTurnsAfterCapture.mean}, median ${r.incomeTurnsAfterCapture.median}`);
    console.log(`Capture chains       ${JSON.stringify(r.captureChains)} · longest per game median ${r.longestChain.median}, max ${r.longestChain.max}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : fallback;
  };
  const mode = arg('mode', 'all');
  const started = Date.now();
  const report = simulate({ games: Number(arg('games', 600)), seed: Number(arg('seed', 1)), modes: mode === 'all' ? MODE_IDS : [mode] });
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
  console.error(`\n(${((Date.now() - started) / 1000).toFixed(1)}s)`);
}
