#!/usr/bin/env node
/**
 * CPU balance and robustness simulator: plays hundreds or thousands of all-CPU games through
 * the real rules engine with the real CPU decision engine (js/core/cpu), step by step exactly
 * as the game's turn loop does (js/ui/gameView.js cpuPlan): ask chooseRoad() / chooseCityAction()
 * for one decision, play it through the public actions, repeat. No DOM, no timers, no animation.
 *
 *   npm run simulate:cpu -- [--games 600] [--seed 1] [--mode standard|classic|chaos|all]
 *                           [--tables normal-v-hard,all-normal-4p] [--json]
 *
 * Reports: win rate by difficulty (head-to-head and three-way tables, every seating order),
 * seat-order advantage (tables of identical mayors), road choices and captures, capture chains,
 * building categories, bankruptcy, redevelopment auctions, final cash and City Value, game
 * length, and robustness: the share of CPU decisions the rules engine refused ("illegal"),
 * and stalls (a decision that changes nothing, or none at all, while the game is still on).
 *
 * Determinism: each game's seed deals the city and its events (core/rng.js); the CPU draws from
 * its own streams derived from the game state (core/cpu/random.js). Same arguments, same report.
 */
import { createGame, placeRoad, currentPlayer, getPlayer, TURN_PHASES, PHASES } from '../js/core/game.js';
import { chooseRoad } from '../js/core/cpu/roads.js';
import { chooseCityAction, applyCityAction } from '../js/core/cpu/city.js';
import { PERSONALITIES } from '../js/core/seats.js';
import { CATEGORY_ORDER } from '../js/core/buildings.js';
import { MODE_IDS } from '../js/core/modes.js';

const LEVELS = ['easy', 'normal', 'hard'];

/** A fingerprint of everything a step can change: a step that leaves it unchanged made no progress. */
const progressKey = (g) => [g.log.length, g.turnPhase, g.turnIndex, g.round, Object.keys(g.board.roads).length,
  g.pendingCaptures.join(','), g.players.map((p) => p.cash).join(','), g.phase].join('|');

/**
 * One all-CPU game. `seats`: [{ difficulty, personality? }] in seat order (a missing personality
 * is assigned by createGame, as in the real game). Returns the game plus robustness counters.
 * A stall (STALL_LIMIT steps without progress) or a runaway game (maxSteps) stops the game and
 * is reported, never thrown, so a sweep can count them.
 */
export function playCpuGame({ seed, mode = 'standard', seats, shock = null, maxSteps = 5000, stallLimit = 3 }) {
  const game = createGame({
    seed, mode,
    seats: seats.map((s, i) => ({ seat: i + 1, controller: 'cpu', difficulty: s.difficulty, personality: s.personality ?? null })),
  });
  const stats = { decisions: 0, illegal: [], stalls: [], roadReasons: {}, auctionsOpened: [] };
  let still = 0;
  let key = progressKey(game);
  let shocked = false;
  while (game.phase === PHASES.PLAYING) {
    // Stress test only: a debt shock (cash set to −debt) at one mayor's Manage City in `round`,
    // to drive the distress, bankruptcy and redevelopment paths that careful bots rarely reach.
    if (shock && !shocked && game.round >= shock.round && game.turnPhase === TURN_PHASES.MANAGE_CITY
      && currentPlayer(game).seat === shock.seat) {
      currentPlayer(game).cash = -shock.debt;
      shocked = true;
      key = progressKey(game);
    }
    if (stats.decisions >= maxSteps) {
      stats.stalls.push({ kind: 'runaway', steps: stats.decisions });
      break;
    }
    stats.decisions++;
    const me = currentPlayer(game);
    const paving = game.turnPhase === TURN_PHASES.PAVE_ROAD || game.turnPhase === TURN_PHASES.BONUS_ROAD;
    let decision;
    let result;
    if (paving) {
      decision = chooseRoad(game);
      if (decision.road) {
        result = placeRoad(game, decision.road);
        const r = (stats.roadReasons[me.difficulty] ??= {});
        r[decision.reason] = (r[decision.reason] ?? 0) + 1;
      }
    } else {
      decision = chooseCityAction(game);
      if (decision.action) {
        if (decision.action === 'redevelop') stats.auctionsOpened.push({ seat: me.seat, mode: decision.mode, block: decision.blockId });
        result = applyCityAction(game, decision);
      }
    }
    if (result && !result.ok) {
      stats.illegal.push({ seat: me.seat, phase: game.turnPhase, action: decision.action ?? 'road', target: decision.road ?? decision.blockId, error: result.error });
    }
    const next = progressKey(game);
    if (next === key) {
      if (++still >= stallLimit) {
        stats.stalls.push({ kind: 'stall', seat: me.seat, phase: game.turnPhase, decision: decision.action ?? decision.road ?? null, error: decision.error ?? result?.error ?? null });
        break;
      }
    } else still = 0;
    key = next;
  }
  return { game, ...stats };
}

/* ---------------- tables ---------------- */

function permutations(list) {
  if (list.length <= 1) return [list];
  return list.flatMap((item, i) => permutations([...list.slice(0, i), ...list.slice(i + 1)]).map((rest) => [item, ...rest]));
}
const orders = (list) => [...new Map(permutations(list).map((p) => [p.join(), p])).values()];

/**
 * Table plans. Difficulty comparisons use every seating order of their table (rotation alone
 * keeps the cyclic order, so one mayor would always sit after, and collect gifts from, the
 * same other one). Uniform tables measure seat order. Personalities are left to createGame
 * except on the personality table, which seats all four across every order.
 */
export const TABLES = Object.freeze({
  'easy-v-normal': orders(['easy', 'normal']),
  'normal-v-hard': orders(['normal', 'hard']),
  'easy-v-hard': orders(['easy', 'hard']),
  'three-way': orders(['easy', 'normal', 'hard']),
  'normal-v-hard-4p': orders(['normal', 'normal', 'hard', 'hard']),
  'easy-v-normal-4p': orders(['easy', 'easy', 'normal', 'normal']),
  'all-normal-2p': [['normal', 'normal']],
  'all-normal-3p': [['normal', 'normal', 'normal']],
  'all-normal-4p': [['normal', 'normal', 'normal', 'normal']],
  'all-hard-4p': [['hard', 'hard', 'hard', 'hard']],
  'all-easy-4p': [['easy', 'easy', 'easy', 'easy']],
  // Stress: one mayor is thrown into debt mid-game (see playCpuGame `shock`).
  'debt-shock': orders(['easy', 'normal', 'hard', 'normal']),
  personalities: orders(PERSONALITIES).map((p) => p.map((personality) => ({ difficulty: 'hard', personality }))),
});

/** Game `i`'s table: cycles through the plans, and within a plan through its seating orders. */
export function tableFor(i, ids = Object.keys(TABLES)) {
  const id = ids[i % ids.length];
  const plan = TABLES[id];
  const seats = plan[Math.floor(i / ids.length) % plan.length].map((s) => (typeof s === 'string' ? { difficulty: s } : s));
  return { id, seats };
}

/* ---------------- statistics ---------------- */

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
const mean = (values) => (values.length ? Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 10) / 10 : null);
function spread(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? null;
  return { mean: mean(values), p10: q(0.1), median: q(0.5), p90: q(0.9), max: sorted.at(-1) ?? null };
}
const bump = (obj, key, by = 1) => { obj[key] = (obj[key] ?? 0) + by; };

export function simulateCpu({ games = 600, seed = 1, modes = ['standard'], tables = Object.keys(TABLES) } = {}) {
  const unknown = tables.filter((t) => !TABLES[t]);
  if (unknown.length) throw new Error(`Unknown table(s): ${unknown.join(', ')}. Known: ${Object.keys(TABLES).join(', ')}`);
  const report = {};
  for (const mode of modes) {
    const acc = {
      games: 0, ms: 0, decisions: 0, illegal: [], stalls: [], rounds: [], roads: [],
      tables: {}, seat: {}, level: {}, personality: {},
      roadReasons: {}, chains: {}, longestChain: [], conceded: {}, captures: {},
      builds: {}, upgrades: {}, bankruptGames: 0, shockGames: 0, shockBankrupt: 0, bankruptcies: {},
      auctions: { opened: 0, openedBy: {}, modes: {}, won: 0, wonBy: {}, contested: 0 }, abandonedAtEnd: [],
    };
    for (const lvl of LEVELS) {
      acc.level[lvl] = { seats: 0, wins: 0, cityValue: [], cash: [], blocks: [], developed: [] };
      acc.builds[lvl] = Object.fromEntries(CATEGORY_ORDER.map((c) => [c, 0]));
      acc.upgrades[lvl] = 0;
      acc.captures[lvl] = 0;
      acc.conceded[lvl] = 0;
      acc.bankruptcies[lvl] = 0;
    }
    for (let i = 0; i < games; i++) {
      const { id, seats } = tableFor(i, tables);
      const gameSeed = (seed * 1_000_003 + i * 7919) >>> 0;
      const started = performance.now();
      // Debt shock: a different seat, round and size of debt each time (sometimes recoverable).
      const shock = id === 'debt-shock' ? { seat: 1 + (i % seats.length), round: 10 + (i % 5), debt: 1500 + (i % 7) * 2500 } : null;
      const run = playCpuGame({ seed: gameSeed, mode, seats, shock });
      acc.ms += performance.now() - started;
      const { game } = run;
      acc.games++;
      acc.decisions += run.decisions;
      for (const x of run.illegal) acc.illegal.push({ seed: gameSeed, table: id, ...x });
      for (const x of run.stalls) acc.stalls.push({ seed: gameSeed, table: id, ...x });
      if (game.phase !== PHASES.ENDED) continue;
      acc.rounds.push(game.round);
      acc.roads.push(game.log.filter((e) => e.type === 'road').length);
      const lvlOf = (seat) => getPlayer(game, seat).difficulty;
      for (const [lvl, reasons] of Object.entries(run.roadReasons)) {
        for (const [r, n] of Object.entries(reasons)) bump(acc.roadReasons[lvl] ??= {}, r, n);
      }

      // Results by table, seat, difficulty and personality (wins shared on ties).
      const t = (acc.tables[id] ??= { games: 0, byLevel: {}, bySeat: [] });
      t.games++;
      const share = 1 / game.results.winners.length;
      const won = (seat) => (game.results.winners.includes(seat) ? share : 0);
      for (const row of game.results.rows) {
        const p = getPlayer(game, row.seat);
        const L = acc.level[p.difficulty];
        L.seats++; L.wins += won(row.seat); L.cityValue.push(row.cityValue); L.cash.push(row.cash);
        L.blocks.push(row.blocks ?? game.board.blocks.filter((b) => b.ownerSeat === row.seat).length);
        L.developed.push(game.board.blocks.filter((b) => b.ownerSeat === row.seat && b.level > 0).length);
        const tl = (t.byLevel[p.difficulty] ??= { seats: 0, wins: 0, value: 0 });
        tl.seats++; tl.wins += won(row.seat); tl.value += row.cityValue;
        (t.bySeat[row.seat - 1] ??= { seats: 0, wins: 0 }).seats++;
        t.bySeat[row.seat - 1].wins += won(row.seat);
        if (id === 'personalities') {
          const P = (acc.personality[p.personality] ??= { seats: 0, wins: 0, value: 0, builds: {} });
          P.seats++; P.wins += won(row.seat); P.value += row.cityValue;
        }
      }

      // Roads: captures, chains (consecutive capturing roads by one mayor), blocks conceded
      // (captured by the very next road after a mayor's own non-capturing road).
      let run_ = 0;
      let longest = 0;
      let prev = null;
      const roadsLog = game.log.filter((e) => e.type === 'road');
      for (const e of [...roadsLog, { seat: -1, captured: [] }]) {
        if (e.captured.length) {
          if (e.seat > 0) acc.captures[lvlOf(e.seat)] += e.captured.length;
          run_ += e.captured.length;
          if (prev && !prev.captured.length && prev.seat !== e.seat) acc.conceded[lvlOf(prev.seat)] += e.captured.length;
        } else if (run_) { bump(acc.chains, run_); longest = Math.max(longest, run_); run_ = 0; }
        prev = e;
      }
      acc.longestChain.push(longest);

      // Development, bankruptcy and redevelopment.
      for (const e of game.log) {
        if (e.type === 'build') acc.builds[lvlOf(e.seat)][e.category]++;
        if (e.type === 'upgrade') acc.upgrades[lvlOf(e.seat)]++;
        if (e.type === 'build' && id === 'personalities') bump(acc.personality[getPlayer(game, e.seat).personality].builds, e.category);
        if (e.type === 'bankruptcy') acc.bankruptcies[lvlOf(e.seat)]++;
        if (e.type === 'redevelopment-auction') { acc.auctions.won++; bump(acc.auctions.wonBy, lvlOf(e.seat)); }
      }
      const bankrupt = game.log.some((e) => e.type === 'bankruptcy');
      if (id === 'debt-shock') { acc.shockGames++; if (bankrupt) acc.shockBankrupt++; } else if (bankrupt) acc.bankruptGames++;
      for (const a of run.auctionsOpened) {
        acc.auctions.opened++;
        bump(acc.auctions.openedBy, lvlOf(a.seat));
        bump(acc.auctions.modes, a.mode);
      }
      acc.abandonedAtEnd.push(game.board.blocks.filter((b) => b.abandoned).length);
    }

    const levelRow = (L) => ({ winRate: pct(L.wins, L.seats), cityValue: spread(L.cityValue), cash: spread(L.cash), blocks: mean(L.blocks), developed: mean(L.developed) });
    report[mode] = {
      games: acc.games,
      msPerGame: Math.round((acc.ms / Math.max(1, acc.games)) * 10) / 10,
      robustness: {
        decisions: acc.decisions,
        illegal: acc.illegal.length,
        illegalRate: pct(acc.illegal.length, acc.decisions),
        illegalSamples: acc.illegal.slice(0, 5),
        stalls: acc.stalls.length,
        stallSamples: acc.stalls.slice(0, 5),
        unfinished: acc.games - acc.rounds.length,
      },
      rounds: spread(acc.rounds),
      roads: spread(acc.roads),
      byDifficulty: Object.fromEntries(LEVELS.map((l) => [l, levelRow(acc.level[l])])),
      headToHead: Object.fromEntries(Object.entries(acc.tables).filter(([id]) => !id.startsWith('all-') && id !== 'personalities' && id !== 'debt-shock')
        .map(([id, t]) => [id, Object.fromEntries(Object.entries(t.byLevel).map(([l, v]) => [l, { winRate: pct(v.wins, v.seats), avgCityValue: Math.round(v.value / v.seats) }]))])),
      seatWinRate: Object.fromEntries(Object.entries(acc.tables).filter(([id]) => id.startsWith('all-'))
        .map(([id, t]) => [id, t.bySeat.map((s) => pct(s.wins, s.seats))])),
      personalities: Object.fromEntries(Object.entries(acc.personality).map(([p, v]) => [p, {
        winRate: pct(v.wins, v.seats), avgCityValue: Math.round(v.value / v.seats),
        topBuilds: Object.entries(v.builds).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c]) => c),
      }])),
      roadReasons: Object.fromEntries(Object.entries(acc.roadReasons).map(([l, r]) => {
        const total = Object.values(r).reduce((s, n) => s + n, 0);
        return [l, Object.fromEntries(Object.entries(r).sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, pct(n, total)]))];
      })),
      capturesPerSeat: Object.fromEntries(LEVELS.map((l) => [l, Math.round((acc.captures[l] / Math.max(1, acc.level[l].seats)) * 10) / 10])),
      concededPerSeat: Object.fromEntries(LEVELS.map((l) => [l, Math.round((acc.conceded[l] / Math.max(1, acc.level[l].seats)) * 10) / 10])),
      chains: acc.chains,
      longestChain: spread(acc.longestChain),
      builds: Object.fromEntries(LEVELS.map((l) => {
        const total = Object.values(acc.builds[l]).reduce((s, n) => s + n, 0);
        return [l, { perSeat: Math.round((total / Math.max(1, acc.level[l].seats)) * 10) / 10,
          upgradesPerSeat: Math.round((acc.upgrades[l] / Math.max(1, acc.level[l].seats)) * 10) / 10,
          share: Object.fromEntries(CATEGORY_ORDER.map((c) => [c, pct(acc.builds[l][c], total)])) }];
      })),
      bankruptcy: {
        gamesWithBankruptcy: pct(acc.bankruptGames, acc.rounds.length - acc.shockGames),
        afterDebtShock: pct(acc.shockBankrupt, acc.shockGames),
        perSeat: Object.fromEntries(LEVELS.map((l) => [l, pct(acc.bankruptcies[l], acc.level[l].seats)])),
      },
      redevelopment: { ...acc.auctions, abandonedAtEnd: mean(acc.abandonedAtEnd) },
    };
  }
  return report;
}

/* ---------------- CLI ---------------- */

const fmt = (v) => (v == null ? '—' : `${v}%`);
function printReport(report) {
  for (const [mode, r] of Object.entries(report)) {
    const rb = r.robustness;
    console.log(`\n=== ${mode.toUpperCase()} · ${r.games} all-CPU games · ${r.msPerGame} ms/game ===`);
    console.log(`Robustness        ${rb.decisions} decisions · illegal ${rb.illegal} (${fmt(rb.illegalRate)}) · stalls ${rb.stalls} · unfinished ${rb.unfinished}`);
    for (const s of [...rb.illegalSamples, ...rb.stallSamples]) console.log(`                  ${JSON.stringify(s)}`);
    console.log(`Length            rounds mean ${r.rounds.mean} (median ${r.rounds.median}, max ${r.rounds.max}) · roads mean ${r.roads.mean}`);
    console.log('Head to head      (win rate per seat, ties shared; avg City Value)');
    for (const [id, by] of Object.entries(r.headToHead)) {
      console.log(`  ${id.padEnd(17)} ${Object.entries(by).map(([l, v]) => `${l} ${fmt(v.winRate)} $${v.avgCityValue}`).join(' · ')}`);
    }
    console.log('By difficulty     (every table)');
    for (const [l, v] of Object.entries(r.byDifficulty)) {
      console.log(`  ${l.padEnd(7)} win ${fmt(v.winRate).padEnd(6)} City Value mean $${v.cityValue.mean} (p10 $${v.cityValue.p10}, p90 $${v.cityValue.p90}) · cash mean $${v.cash.mean} · blocks ${v.blocks} · developed ${v.developed}`);
    }
    console.log(`Seat win rate     ${Object.entries(r.seatWinRate).map(([id, s]) => `${id} [${s.map(fmt).join(', ')}]`).join(' · ')}`);
    console.log(`Personalities     ${Object.entries(r.personalities).map(([p, v]) => `${p} ${fmt(v.winRate)} $${v.avgCityValue} (${v.topBuilds.join('/')})`).join(' · ')}`);
    console.log(`Road choices      ${Object.entries(r.roadReasons).map(([l, v]) => `${l}: ${Object.entries(v).map(([k, n]) => `${k} ${n}%`).join(' ')}`).join(' | ')}`);
    console.log(`Captures/seat     ${JSON.stringify(r.capturesPerSeat)} · conceded/seat ${JSON.stringify(r.concededPerSeat)}`);
    console.log(`Capture chains    ${JSON.stringify(r.chains)} · longest per game median ${r.longestChain.median}, max ${r.longestChain.max}`);
    for (const [l, b] of Object.entries(r.builds)) {
      console.log(`Builds ${l.padEnd(10)} ${b.perSeat}/seat + ${b.upgradesPerSeat} upgrades · ${Object.entries(b.share).map(([c, s]) => `${c} ${fmt(s)}`).join(' ')}`);
    }
    console.log(`Bankruptcy        ${fmt(r.bankruptcy.gamesWithBankruptcy)} of normal games · ${fmt(r.bankruptcy.afterDebtShock)} after a debt shock · per seat (all) ${Object.entries(r.bankruptcy.perSeat).map(([l, v]) => `${l} ${fmt(v)}`).join(' ')}`);
    const rd = r.redevelopment;
    console.log(`Redevelopment     opened ${rd.opened} ${JSON.stringify(rd.openedBy)} ${JSON.stringify(rd.modes)} · won ${rd.won} ${JSON.stringify(rd.wonBy)} · abandoned at end ${rd.abandonedAtEnd}/game`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : fallback;
  };
  const mode = arg('mode', 'standard');
  const started = Date.now();
  const report = simulateCpu({ games: Number(arg('games', 600)), seed: Number(arg('seed', 1)), modes: mode === 'all' ? MODE_IDS : [mode],
    ...(arg('tables') && { tables: arg('tables').split(',') }) });
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
  console.error(`\n(${((Date.now() - started) / 1000).toFixed(1)}s)`);
  // Any illegal CPU action, stall or unfinished game fails the run (CI gates on it).
  const broken = Object.entries(report).filter(([, r]) => r.robustness.illegal || r.robustness.stalls || r.robustness.unfinished);
  if (broken.length) {
    console.error(`CPU robustness failures in: ${broken.map(([m]) => m).join(', ')}`);
    process.exitCode = 1;
  }
}
