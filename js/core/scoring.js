/**
 * End-of-game scoring. Pure functions of game state (no DOM, no randomness),
 * so results are fully testable and deterministic.
 *
 *   City Value = configured cash score + land score + building-investment score.
 * Coefficients live in ECONOMY.SCORING so development can earn its advantage
 * through income instead of converting every spent dollar directly into score.
 *
 * Ranking: City Value, then tie-breakers blocks → developed blocks → cash.
 * Players equal on all four share the rank (co-winners), listed in seat order.
 *
 * Distinctions are fun awards anyone can win (including the winner). A tie
 * shares the award; an award isn't given if its best value is 0 or if every
 * player is tied for it (it wouldn't distinguish anyone).
 */
import { blocksOwnedBy, blockLabel } from './board.js';
import { ECONOMY } from '../config.js';
import { getCategory, levelArt } from './buildings.js';
import { calculateIncome, investedIn } from './economy.js';

const isDev = (b) => b.level > 0 && b.type !== 'vacant';

/** Highest development: level, then money invested, then board order (row-major). */
function highestDevelopment(blocks) {
  let best = null;
  for (const b of blocks) {
    if (!isDev(b)) continue;
    const inv = investedIn(b);
    if (!best || b.level > best.level || (b.level === best.level && inv > best.invested)) {
      best = { blockId: b.id, label: blockLabel(b.row, b.col), type: b.type, level: b.level, invested: inv };
    }
  }
  if (!best) return null;
  const cat = getCategory(best.type);
  const art = levelArt(best.type, best.level);
  return { ...best, category: cat?.label ?? best.type, name: art?.name ?? '', sprite: art?.sprite ?? null };
}

/** Every stat shown on the results screen for one player. */
/**
 * @param opts.exclude  score as if this block weren't owned (used to measure a block's
 *                      contribution to City Value with the same formula)
 */
export function scorePlayer(game, player, { exclude = null } = {}) {
  const owned = blocksOwnedBy(game.board, player.seat).filter((b) => b.id !== exclude);
  const developed = owned.filter(isDev);
  const landValue = owned.reduce((s, b) => s + b.price, 0);
  const buildingValue = owned.reduce((s, b) => s + investedIn(b), 0);
  const scoredCash = Math.round(player.cash * ECONOMY.SCORING.CASH);
  const scoredLand = Math.round(landValue * ECONOMY.SCORING.LAND);
  const scoredBuildings = Math.round(buildingValue * ECONOMY.SCORING.INVESTED_BUILDING);
  const parks = developed.filter((b) => b.type === 'park');
  return {
    seat: player.seat,
    name: player.name,
    color: player.color,
    cash: player.cash,
    landValue,
    buildingValue,
    scoredCash,
    scoredLand,
    scoredBuildings,
    cityValue: scoredCash + scoredLand + scoredBuildings,
    blocks: owned.length,
    developed: developed.length,
    totalLevels: developed.reduce((s, b) => s + b.level, 0),
    income: calculateIncome(game.board, player.seat), // base + bonuses (events are temporary)
    highest: highestDevelopment(developed),
    greenery: parks.reduce((s, b) => s + b.level, 0), // park levels
    bankruptcies: player.bankruptcies ?? 0,
  };
}

/** Ordered tie-breakers after City Value. Exported so the UI can explain them. */
export const TIEBREAKERS = Object.freeze([
  { key: 'cityValue', label: 'City Value' },
  { key: 'blocks', label: 'blocks owned' },
  { key: 'developed', label: 'developed blocks' },
  { key: 'cash', label: 'cash' },
]);

function compare(a, b) {
  for (const { key } of TIEBREAKERS) if (a[key] !== b[key]) return b[key] - a[key];
  return 0;
}

/** Sorts scores and assigns shared ranks. Seat order breaks display order only. */
export function rankScores(scores) {
  const rows = [...scores].sort((a, b) => compare(a, b) || a.seat - b.seat);
  rows.forEach((row, i) => {
    const prev = rows[i - 1];
    row.rank = prev && compare(prev, row) === 0 ? prev.rank : i + 1;
  });
  return rows;
}

/** Fun awards. `value` picks the stat; `min` is the smallest value worth awarding. */
export const DISTINCTIONS = Object.freeze([
  { id: 'most-blocks', title: 'Most Blocks', icon: 'icons:map', value: (s) => s.blocks, show: (v) => `${v} blocks` },
  { id: 'most-cash', title: 'Most Cash', icon: 'icons:coins', value: (s) => s.cash, show: (v) => `$${v.toLocaleString('en-US')}` },
  {
    id: 'most-developed', title: 'Most Developed', icon: 'icons:building',
    value: (s) => s.developed * 100 + s.totalLevels, // developed blocks, then total levels
    show: (v, s) => `${s.developed} developed`,
  },
  { id: 'greenest', title: 'Greenest City', icon: 'icons:tree', value: (s) => s.greenery, show: (v) => `${v} park level${v === 1 ? '' : 's'}` },
  { id: 'top-earner', title: 'Top Earner', icon: 'icons:clock', value: (s) => s.income, show: (v) => `+$${v.toLocaleString('en-US')}/turn` },
  {
    id: 'skyline', title: 'Tallest Skyline', icon: 'icons:crown',
    value: (s) => (s.highest ? s.highest.level * 1e6 + s.highest.invested : 0),
    show: (v, s) => `${s.highest.name} (Lv ${s.highest.level})`,
  },
]);

export function awardDistinctions(scores) {
  const bySeat = [...scores].sort((a, b) => a.seat - b.seat);
  const awards = [];
  for (const d of DISTINCTIONS) {
    const best = Math.max(...bySeat.map(d.value));
    if (!(best > 0)) continue;
    const holders = bySeat.filter((s) => d.value(s) === best);
    if (bySeat.length > 1 && holders.length === bySeat.length) continue;
    awards.push({
      id: d.id,
      title: d.title,
      icon: d.icon,
      seats: holders.map((s) => s.seat),
      detail: d.show(best, holders[0]),
      shared: holders.length > 1,
    });
  }
  return awards;
}

function largestDistrict(game) {
  const eligible = game.board.blocks.filter((b) => b.ownerSeat != null && isDev(b));
  const seen = new Set();
  let best = null;
  for (const start of eligible) {
    if (seen.has(start.id)) continue;
    const stack = [start];
    const group = [];
    seen.add(start.id);
    while (stack.length) {
      const block = stack.pop();
      group.push(block);
      for (const other of eligible) {
        if (seen.has(other.id) || other.ownerSeat !== start.ownerSeat || other.type !== start.type) continue;
        if (Math.abs(other.row - block.row) + Math.abs(other.col - block.col) !== 1) continue;
        seen.add(other.id);
        stack.push(other);
      }
    }
    if (!best || group.length > best.size) best = { seat: start.ownerSeat, type: start.type, size: group.length };
  }
  return best;
}

/** Match-wide facts derived from the frozen board/log; these never affect ranking. */
export function computeMatchStats(game) {
  let runSeat = null;
  let run = 0;
  let longest = { seat: null, count: 0 };
  for (const entry of game.log) {
    if (entry.type !== 'road') continue;
    if (entry.captured.length) {
      run = entry.seat === runSeat ? run + entry.captured.length : entry.captured.length;
      runSeat = entry.seat;
      if (run > longest.count) longest = { seat: entry.seat, count: run };
    } else {
      runSeat = null;
      run = 0;
    }
  }
  const owned = game.board.blocks.filter((b) => b.ownerSeat != null);
  const best = owned.reduce((top, block) => {
    const value = block.price + investedIn(block);
    return !top || value > top.value ? { seat: block.ownerSeat, label: block.label, value } : top;
  }, null);
  return {
    longestCaptureChain: longest,
    biggestDistrict: largestDistrict(game),
    bestSingleBlock: best,
    eventsSurvived: game.events.history.length,
    bankruptcies: game.players.reduce((sum, player) => sum + (player.bankruptcies ?? 0), 0),
  };
}

/** Full results: ranked rows, winners (seats), distinctions. */
export function computeResults(game) {
  const rows = rankScores(game.players.map((p) => scorePlayer(game, p)));
  return {
    round: game.round,
    rows,
    winners: rows.filter((r) => r.rank === 1).map((r) => r.seat),
    distinctions: awardDistinctions(rows),
    matchStats: computeMatchStats(game),
  };
}
