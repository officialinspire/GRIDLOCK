/**
 * End-of-game scoring. Pure functions of game state (no DOM, no randomness),
 * so results are fully testable and deterministic.
 *
 *   City Value = cash + land value + building value
 *     land value      price of every block the player owns
 *     building value  development cost invested in those blocks (block.value − land)
 *
 * Ranking: City Value, then tie-breakers blocks → developed blocks → cash.
 * Players equal on all four share the rank (co-winners), listed in seat order.
 *
 * Distinctions are fun awards anyone can win (including the winner). A tie
 * shares the award; an award isn't given if its best value is 0 or if every
 * player is tied for it (it wouldn't distinguish anyone).
 */
import { blocksOwnedBy, blockLabel } from './board.js';
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
export function scorePlayer(game, player) {
  const owned = blocksOwnedBy(game.board, player.seat);
  const developed = owned.filter(isDev);
  const landValue = owned.reduce((s, b) => s + b.price, 0);
  const buildingValue = owned.reduce((s, b) => s + investedIn(b), 0);
  const parks = developed.filter((b) => b.type === 'park');
  return {
    seat: player.seat,
    name: player.name,
    color: player.color,
    cash: player.cash,
    landValue,
    buildingValue,
    cityValue: player.cash + landValue + buildingValue,
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

/** Full results: ranked rows, winners (seats), distinctions. */
export function computeResults(game) {
  const rows = rankScores(game.players.map((p) => scorePlayer(game, p)));
  return {
    round: game.round,
    rows,
    winners: rows.filter((r) => r.rank === 1).map((r) => r.seat),
    distinctions: awardDistinctions(rows),
  };
}
