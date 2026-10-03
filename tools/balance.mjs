/**
 * Balance report: seat-order fairness, building-category usage/value and strategy (CPU
 * personality) competitiveness, from real all-CPU games (tools/cpu-simulate.mjs playCpuGame:
 * the real rules and the real CPU engine). Deterministic: every game's seed comes from its mode,
 * table and index, and results are aggregated in that order whatever the worker count.
 *
 *   npm run balance -- [--games 300] [--seed 1] [--mode standard|classic|chaos|all] [--workers 4] [--json]
 *
 * --games is per uniform table (2/3/4 players × Normal/Hard) and per rule set; the personality
 * table plays every seating order of the four personalities (Hard), --games / 12 rounds of them.
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CATEGORY_ORDER } from '../js/core/buildings.js';
import { MODE_IDS } from '../js/core/modes.js';
import { CPU } from '../js/config.js';
import { playCpuGame } from './cpu-simulate.mjs';
import { prestigeFor } from '../js/core/strategy.js';

const PERSONALITIES = Object.keys(CPU.PERSONALITIES);

function permutations(list) {
  if (list.length <= 1) return [list];
  return list.flatMap((x, i) => permutations([...list.slice(0, i), ...list.slice(i + 1)]).map((rest) => [x, ...rest]));
}

/** Uniform tables measure seat order; the personality table measures strategies. */
export const BALANCE_TABLES = Object.freeze({
  'hard-2p': [['hard', 'hard']],
  'hard-3p': [['hard', 'hard', 'hard']],
  'hard-4p': [['hard', 'hard', 'hard', 'hard']],
  'normal-2p': [['normal', 'normal']],
  'normal-3p': [['normal', 'normal', 'normal']],
  'normal-4p': [['normal', 'normal', 'normal', 'normal']],
  personalities: permutations(PERSONALITIES).map((p) => p.map((personality) => ({ difficulty: 'hard', personality }))),
});

const tableSeed = (seed, mode, table, i) => {
  let h = (seed * 2654435761) >>> 0;
  for (const ch of `${mode}|${table}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return (h + i * 7919) >>> 0;
};

/** The list of games for a run, in aggregation order. */
export function balanceJobs({ games = 300, seed = 1, modes = ['standard'], tables = Object.keys(BALANCE_TABLES) } = {}) {
  const jobs = [];
  for (const mode of modes) {
    for (const table of tables) {
      const plans = BALANCE_TABLES[table];
      const count = table === 'personalities' ? plans.length * Math.max(1, Math.round(games / 12)) : games;
      for (let i = 0; i < count; i++) {
        const plan = plans[i % plans.length].map((s) => (typeof s === 'string' ? { difficulty: s } : s));
        jobs.push({ mode, table, i, seed: tableSeed(seed, mode, table, i), seats: plan });
      }
    }
  }
  return jobs;
}

/** Plays one job and boils it down to what the report needs (small enough to post between threads). */
export function playJob(job) {
  const run = playCpuGame({ seed: job.seed, mode: job.mode, seats: job.seats });
  const { game } = run;
  const ended = game.phase === 'ended';
  const winners = ended ? game.results.winners : [];
  const seats = game.players.map((p) => {
    const cats = Object.fromEntries(CATEGORY_ORDER.map((c) => [c, { blocks: 0, levels: 0, invested: 0, income: 0 }]));
    for (const b of game.board.blocks) {
      if (b.ownerSeat !== p.seat || b.abandoned || b.level === 0 || !cats[b.type]) continue;
      const c = cats[b.type];
      c.blocks++; c.levels += b.level; c.invested += b.investedCostBasis; c.income += b.income + (b.bonusIncome ?? 0);
    }
    const row = ended ? game.results.rows.find((r) => r.seat === p.seat) : null;
    return {
      seat: p.seat, personality: p.personality, difficulty: p.difficulty,
      won: winners.includes(p.seat) ? 1 / winners.length : 0,
      cityValue: row?.cityValue ?? 0, prestige: prestigeFor(game.board, p.seat), cats,
    };
  });
  const builds = Object.fromEntries(CATEGORY_ORDER.map((c) => [c, 0]));
  const upgrades = Object.fromEntries(CATEGORY_ORDER.map((c) => [c, 0]));
  for (const e of game.log) {
    if (e.type === 'build') builds[e.category]++;
    if (e.type === 'upgrade') upgrades[e.category]++;
  }
  return {
    mode: job.mode, table: job.table, ended, rounds: game.round,
    illegal: run.illegal.length, stalls: run.stalls.length, seats, builds, upgrades,
  };
}

/* ---------------- aggregation ---------------- */

const r1 = (x) => Math.round(x * 10) / 10;
const r3 = (x) => Math.round(x * 1000) / 1000;

/** Seat win rates for a uniform table, with z-scores against a fair 1/n share. */
function seatFairness(results) {
  const n = results[0].seats.length;
  const wins = Array(n).fill(0);
  for (const g of results) g.seats.forEach((s, k) => { wins[k] += s.won; });
  const games = results.length;
  const fair = 1 / n;
  const se = Math.sqrt((fair * (1 - fair)) / games);
  const rates = wins.map((w) => w / games);
  const z = rates.map((p) => (p - fair) / se);
  const chi2 = wins.reduce((s, w) => s + ((w - games * fair) ** 2) / (games * fair), 0);
  // Meaningful: statistically clear (|z| ≥ 2.58, 99%) AND big enough to matter (≥ 5 points).
  const flagged = rates.map((p, k) => Math.abs(z[k]) >= 2.58 && Math.abs(p - fair) >= 0.05);
  return {
    games, fair: r1(fair * 100), rates: rates.map((p) => r1(p * 100)), z: z.map((x) => Math.round(x * 100) / 100),
    chi2: Math.round(chi2 * 100) / 100, df: n - 1, biased: flagged.some(Boolean), flagged,
  };
}

/** Building categories: usage, money and Prestige per dollar, and how much winners lean on them. */
function categoryReport(results) {
  const out = {};
  const seats = results.flatMap((g) => g.seats);
  const winners = seats.filter((s) => s.won > 0);
  const totalBuilds = results.reduce((s, g) => s + Object.values(g.builds).reduce((a, b) => a + b, 0), 0);
  const totalInvested = seats.reduce((s, x) => s + CATEGORY_ORDER.reduce((a, c) => a + x.cats[c].invested, 0), 0);
  for (const c of CATEGORY_ORDER) {
    const builds = results.reduce((s, g) => s + g.builds[c], 0);
    const upgrades = results.reduce((s, g) => s + g.upgrades[c], 0);
    const invested = seats.reduce((s, x) => s + x.cats[c].invested, 0);
    const income = seats.reduce((s, x) => s + x.cats[c].income, 0);
    const levels = seats.reduce((s, x) => s + x.cats[c].levels, 0);
    const blocks = seats.reduce((s, x) => s + x.cats[c].blocks, 0);
    const mean = (list, f) => list.reduce((s, x) => s + f(x), 0) / Math.max(1, list.length);
    const shareOf = (x) => {
      const all = CATEGORY_ORDER.reduce((a, k) => a + x.cats[k].invested, 0);
      return all ? x.cats[c].invested / all : 0;
    };
    out[c] = {
      buildShare: r1((builds / Math.max(1, totalBuilds)) * 100),
      investedShare: r1((invested / Math.max(1, totalInvested)) * 100),
      upgradesPerBuild: r3(upgrades / Math.max(1, builds)),
      avgLevel: r3(levels / Math.max(1, blocks)),
      incomePerK: r1((income / Math.max(1, invested)) * 1000), // income per turn per $1,000 invested (final boards)
      // Winners' share of investment in this category vs everyone's: > 1 means winners lean on it.
      winnerLift: r3(mean(winners, shareOf) / Math.max(1e-9, mean(seats, shareOf))),
    };
  }
  return out;
}

function personalityReport(results) {
  const acc = {};
  for (const g of results) {
    for (const s of g.seats) {
      const p = (acc[s.personality] ??= { seats: 0, wins: 0, value: 0, prestige: 0, invested: Object.fromEntries(CATEGORY_ORDER.map((c) => [c, 0])) });
      p.seats++; p.wins += s.won; p.value += s.cityValue; p.prestige += s.prestige;
      for (const c of CATEGORY_ORDER) p.invested[c] += s.cats[c].invested;
    }
  }
  return Object.fromEntries(PERSONALITIES.filter((p) => acc[p]).map((p) => {
    const a = acc[p];
    const total = Object.values(a.invested).reduce((s, v) => s + v, 0) || 1;
    return [p, {
      winRate: r1((a.wins / a.seats) * 100), avgCityValue: Math.round(a.value / a.seats), avgPrestige: r1(a.prestige / a.seats),
      mix: Object.fromEntries(CATEGORY_ORDER.map((c) => [c, r1((a.invested[c] / total) * 100)])),
    }];
  }));
}

export function aggregate(results) {
  const report = {};
  const modes = [...new Set(results.map((r) => r.mode))];
  for (const mode of modes) {
    const mine = results.filter((r) => r.mode === mode);
    const byTable = (t) => mine.filter((r) => r.table === t && r.ended);
    const uniform = Object.keys(BALANCE_TABLES).filter((t) => t !== 'personalities' && byTable(t).length);
    const strong = byTable('hard-2p').concat(byTable('hard-3p'), byTable('hard-4p'), byTable('personalities'));
    report[mode] = {
      games: mine.length,
      robustness: { illegal: mine.reduce((s, r) => s + r.illegal, 0), stalls: mine.reduce((s, r) => s + r.stalls, 0), unfinished: mine.filter((r) => !r.ended).length },
      seats: Object.fromEntries(uniform.map((t) => [t, seatFairness(byTable(t))])),
      categories: strong.length ? categoryReport(strong) : null,
      personalities: byTable('personalities').length ? personalityReport(byTable('personalities')) : null,
    };
  }
  return report;
}

/** Runs jobs on `workers` threads (results in job order, so the report is deterministic). */
export async function runBalance(options = {}) {
  const jobs = balanceJobs(options);
  const workers = Math.max(1, Math.min(options.workers ?? cpus().length, jobs.length));
  if (workers === 1) return aggregate(jobs.map(playJob));
  const results = new Array(jobs.length);
  const file = fileURLToPath(import.meta.url);
  await Promise.all(Array.from({ length: workers }, (_, w) => new Promise((resolve, reject) => {
    const mine = jobs.map((job, i) => [i, job]).filter(([i]) => i % workers === w);
    const worker = new Worker(file, { workerData: { jobs: mine } });
    worker.on('message', ([i, result]) => { results[i] = result; });
    worker.on('error', reject);
    worker.on('exit', (code) => (code ? reject(new Error(`worker exited ${code}`)) : resolve()));
  })));
  return aggregate(results);
}

/* ---------------- CLI ---------------- */

function printReport(report) {
  for (const [mode, r] of Object.entries(report)) {
    console.log(`\n=== ${mode.toUpperCase()} · ${r.games} games · illegal ${r.robustness.illegal} · stalls ${r.robustness.stalls} · unfinished ${r.robustness.unfinished} ===`);
    console.log('Seat win rate (%)   fair share · seats · z · χ²(df)');
    for (const [t, s] of Object.entries(r.seats)) {
      const seats = s.rates.map((p, k) => `${p}${s.flagged[k] ? '!' : ''}`).join(' / ');
      console.log(`  ${t.padEnd(10)} n=${String(s.games).padEnd(4)} fair ${s.fair} · ${seats} · z ${s.z.join(' / ')} · χ² ${s.chi2}(${s.df})${s.biased ? '  ← BIAS' : ''}`);
    }
    if (r.categories) {
      console.log('Categories (Hard)   build% · invested% · upgrades/build · avg level · income/$1k · winner lift');
      for (const [c, v] of Object.entries(r.categories)) {
        console.log(`  ${c.padEnd(11)} ${String(v.buildShare).padStart(5)} · ${String(v.investedShare).padStart(5)} · ${v.upgradesPerBuild} · ${v.avgLevel} · ${v.incomePerK} · ${v.winnerLift}`);
      }
    }
    if (r.personalities) {
      console.log('Personalities       win% · avg City Value · avg Prestige · investment mix');
      for (const [p, v] of Object.entries(r.personalities)) {
        console.log(`  ${p.padEnd(13)} ${String(v.winRate).padStart(5)} · $${v.avgCityValue} · ${v.avgPrestige} · ${Object.entries(v.mix).filter(([, x]) => x >= 1).map(([c, x]) => `${c} ${x}%`).join(' ')}`);
      }
    }
  }
}

if (!isMainThread) {
  for (const [i, job] of workerData.jobs) parentPort.postMessage([i, playJob(job)]);
} else if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : fallback;
  };
  const mode = arg('mode', 'all');
  const started = Date.now();
  const report = await runBalance({
    games: Number(arg('games', 300)), seed: Number(arg('seed', 1)), workers: Number(arg('workers', cpus().length)),
    modes: mode === 'all' ? MODE_IDS : mode.split(','),
    ...(arg('tables') && { tables: arg('tables').split(',') }),
  });
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
  console.error(`\n(${((Date.now() - started) / 1000).toFixed(0)} s)`);
}
