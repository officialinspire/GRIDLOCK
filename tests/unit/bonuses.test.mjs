import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ECONOMY } from '../../js/config.js';
import { createBoard, getBlock } from '../../js/core/board.js';
import { applyDevelopment, buildOnBlock, upgradeBlock } from '../../js/core/development.js';
import {
  refreshBonuses, computeBonuses, components, isProtected, bonusIncomeFor, BONUS,
} from '../../js/core/bonuses.js';
import { blockIncome, calculateIncome } from '../../js/core/economy.js';
import { createGame, placeRoad, getPlayer, playerStats } from '../../js/core/game.js';

const B = ECONOMY.BONUSES;
const base = (type, level = 1) => ECONOMY.DEVELOPMENT.CATEGORIES[type].income * ECONOMY.DEVELOPMENT.LEVELS[level].income;

/** Places [row, col, seat, type, level?] developments on a fresh board and refreshes bonuses. */
function city(specs, board = createBoard()) {
  for (const [row, col, seat, type, level = 1] of specs) {
    const b = getBlock(board, row, col);
    b.ownerSeat = seat;
    if (type === 'vacant') applyDevelopment(b, 'vacant', 0);
    else applyDevelopment(b, type, level);
  }
  return refreshBonuses(board);
}
const at = (board, row, col) => getBlock(board, row, col);
const ids = (block) => block.bonuses.map((b) => b.id).sort();

/* ---------------- residential / commercial districts ---------------- */

test('2 connected Residential: no bonus; 3 connected: each gets the district bonus', () => {
  let board = city([[0, 0, 1, 'residential'], [0, 1, 1, 'residential']]);
  assert.equal(at(board, 0, 0).bonusIncome, 0);

  board = city([[0, 0, 1, 'residential'], [0, 1, 1, 'residential'], [0, 2, 1, 'residential', 2]]);
  const pct = B.RESIDENTIAL_DISTRICT.percent;
  assert.deepEqual(at(board, 0, 0).bonuses, [
    { id: BONUS.RESIDENTIAL_DISTRICT, label: 'Residential district', percent: pct, amount: base('residential') * pct / 100, size: 3 },
  ]);
  assert.equal(at(board, 0, 2).bonusIncome, base('residential', 2) * pct / 100, 'bonus scales with that block\'s own base');
  assert.equal(blockIncome(at(board, 0, 2)), base('residential', 2) * (1 + pct / 100));
});

test('L-shapes connect; diagonals, other owners and vacant lots do not', () => {
  // L-shape: (0,0) (1,0) (1,1)
  let board = city([[0, 0, 1, 'residential'], [1, 0, 1, 'residential'], [1, 1, 1, 'residential']]);
  assert.ok(at(board, 1, 1).bonusIncome > 0);

  board = city([[0, 0, 1, 'residential'], [1, 1, 1, 'residential'], [2, 2, 1, 'residential']]);
  assert.equal(bonusIncomeFor(board, 1), 0, 'diagonal only');

  board = city([[0, 0, 1, 'residential'], [0, 1, 1, 'residential'], [0, 2, 2, 'residential']]);
  assert.equal(bonusIncomeFor(board, 1) + bonusIncomeFor(board, 2), 0, 'different owners');

  board = city([[0, 0, 1, 'residential'], [0, 1, 1, 'vacant'], [0, 2, 1, 'residential'], [0, 3, 1, 'residential']]);
  assert.equal(at(board, 0, 0).bonusIncome, 0, 'a vacant lot breaks the chain');
  assert.equal(at(board, 0, 2).bonusIncome, 0);
});

test('a 2×2 loop counts each block once (no double counting through cycles)', () => {
  const board = city([[2, 2, 1, 'residential'], [2, 3, 1, 'residential'], [3, 2, 1, 'residential'], [3, 3, 1, 'residential']]);
  for (const [r, c] of [[2, 2], [2, 3], [3, 2], [3, 3]]) {
    const b = at(board, r, c);
    assert.deepEqual(ids(b), [BONUS.RESIDENTIAL_DISTRICT]);
    assert.equal(b.bonuses[0].size, 4);
    assert.equal(b.bonusIncome, base('residential') * B.RESIDENTIAL_DISTRICT.percent / 100);
  }
});

test('a whole-board district: 36 blocks, one bonus each', () => {
  const specs = [];
  for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) specs.push([r, c, 3, 'residential']);
  const board = city(specs);
  assert.equal(components(board, (b) => b.level > 0).length, 1);
  for (const b of board.blocks) assert.equal(b.bonuses.length, 1);
  assert.equal(bonusIncomeFor(board, 3), 36 * base('residential') * B.RESIDENTIAL_DISTRICT.percent / 100);
});

test('Commercial districts use their own percentage and don\'t mix with Residential', () => {
  const board = city([
    [4, 0, 2, 'commercial'], [4, 1, 2, 'commercial'], [4, 2, 2, 'commercial'],
    [5, 0, 2, 'residential'], [5, 1, 2, 'residential'],
  ]);
  const pct = B.COMMERCIAL_DISTRICT.percent;
  assert.deepEqual(ids(at(board, 4, 1)), [BONUS.COMMERCIAL_DISTRICT]);
  assert.equal(at(board, 4, 1).bonusIncome, base('commercial') * pct / 100);
  assert.equal(at(board, 5, 0).bonusIncome, 0, 'only 2 residential');
});

/* ---------------- parks ---------------- */

test('parks boost directly adjacent Residential, capped at maxParks', () => {
  const per = B.PARK_ADJACENCY.percentPerPark;
  // Residential at (2,2) surrounded by 3 parks (max 2 count), one diagonal park (ignored).
  const board = city([
    [2, 2, 1, 'residential'],
    [1, 2, 1, 'park'], [3, 2, 1, 'park'], [2, 1, 1, 'park'],
    [1, 1, 1, 'park'],
  ]);
  const r = at(board, 2, 2);
  const parkBonus = r.bonuses.find((b) => b.id === BONUS.PARK_ADJACENCY);
  assert.equal(parkBonus.parks, B.PARK_ADJACENCY.maxParks);
  assert.equal(parkBonus.percent, B.PARK_ADJACENCY.maxParks * per);
  assert.equal(parkBonus.amount, base('residential') * B.PARK_ADJACENCY.maxParks * per / 100);
  // Parks themselves get no park bonus; commercial next to a park gets none either.
  assert.ok(!at(board, 1, 2).bonuses.some((b) => b.id === BONUS.PARK_ADJACENCY));
});

test('another player\'s park does not boost your homes (sameOwnerOnly)', () => {
  const board = city([[0, 0, 1, 'residential'], [0, 1, 2, 'park']]);
  assert.equal(at(board, 0, 0).bonusIncome, 0);
});

/* ---------------- mixed use ---------------- */

test('a connected Residential + Commercial + Park cluster gives every member the mixed-use bonus', () => {
  // R - P - C in a row: R also gets the park bonus; C and P only mixed-use.
  const board = city([[0, 0, 1, 'residential'], [0, 1, 1, 'park'], [0, 2, 1, 'commercial']]);
  const pct = B.MIXED_USE.percent;
  assert.deepEqual(ids(at(board, 0, 0)), [BONUS.MIXED_USE, BONUS.PARK_ADJACENCY].sort());
  assert.deepEqual(ids(at(board, 0, 1)), [BONUS.MIXED_USE]);
  assert.deepEqual(ids(at(board, 0, 2)), [BONUS.MIXED_USE]);
  assert.equal(at(board, 0, 2).bonusIncome, base('commercial') * pct / 100);
  assert.equal(at(board, 0, 1).bonusIncome, base('park') * pct / 100);
});

test('mixed use needs all three types, connected, same owner; other categories break it', () => {
  assert.equal(bonusIncomeFor(city([[0, 0, 1, 'residential'], [0, 1, 1, 'commercial']]), 1), 0);
  let board = city([[0, 0, 1, 'residential'], [0, 1, 1, 'commercial'], [0, 2, 1, 'industrial'], [0, 3, 1, 'park']]);
  assert.ok(!board.blocks.some((b) => b.bonuses.some((x) => x.id === BONUS.MIXED_USE)), 'industrial splits the cluster');
  board = city([[0, 0, 1, 'residential'], [0, 1, 1, 'commercial'], [0, 2, 2, 'park']]);
  assert.equal(bonusIncomeFor(board, 1), 0, 'park owned by someone else');
});

test('bonus types stack at most once each and never compound', () => {
  // 3 residential in a row + park + commercial all connected → residential gets district + park + mixed.
  const board = city([
    [1, 0, 1, 'residential', 3], [1, 1, 1, 'residential'], [1, 2, 1, 'residential'],
    [0, 0, 1, 'park'], [2, 0, 1, 'commercial'],
  ]);
  const r = at(board, 1, 0);
  assert.deepEqual(ids(r), [BONUS.MIXED_USE, BONUS.PARK_ADJACENCY, BONUS.RESIDENTIAL_DISTRICT].sort());
  const b = base('residential', 3);
  const expected = [B.RESIDENTIAL_DISTRICT.percent, B.PARK_ADJACENCY.percentPerPark, B.MIXED_USE.percent]
    .reduce((sum, pct) => sum + Math.round(b * pct / 100), 0);
  assert.equal(r.bonusIncome, expected, 'each bonus is a % of base only');
  for (const block of board.blocks) assert.equal(new Set(ids(block)).size, block.bonuses.length);
});

/* ---------------- recalculation ---------------- */

test('refresh is idempotent and drops stale bonuses when the board changes', () => {
  const board = city([[0, 0, 1, 'residential'], [0, 1, 1, 'residential'], [0, 2, 1, 'residential']]);
  const once = JSON.stringify(board.blocks);
  refreshBonuses(board);
  refreshBonuses(board);
  assert.equal(JSON.stringify(board.blocks), once);

  at(board, 0, 1).ownerSeat = 2; // ownership changes → district broken
  refreshBonuses(board);
  assert.equal(bonusIncomeFor(board, 1), 0);
  assert.deepEqual(at(board, 0, 0).bonuses, []);
});

test('computeBonuses is pure (does not mutate the board)', () => {
  const board = city([[0, 0, 1, 'residential'], [0, 1, 1, 'residential']]);
  getBlock(board, 0, 2).ownerSeat = 1;
  applyDevelopment(getBlock(board, 0, 2), 'residential', 1);
  const before = JSON.stringify(board.blocks);
  computeBonuses(board);
  assert.equal(JSON.stringify(board.blocks), before);
});

/* ---------------- civic protection hooks ---------------- */

test('civic buildings protect same-owner blocks within their level radius', () => {
  const board = city([
    [2, 2, 1, 'civic'], // L1 radius 1
    [1, 2, 1, 'residential'], [2, 3, 1, 'vacant'], [2, 1, 2, 'residential'], [0, 2, 1, 'park'],
  ]);
  assert.deepEqual(at(board, 2, 2).protectedBy, ['r2c2'], 'covers itself');
  assert.equal(isProtected(at(board, 1, 2)), true);
  assert.equal(isProtected(at(board, 2, 3)), true, 'owned vacant lots too');
  assert.equal(isProtected(at(board, 2, 1)), false, 'other owner');
  assert.equal(isProtected(at(board, 0, 2)), false, 'outside radius 1');

  applyDevelopment(at(board, 2, 2), 'civic', 3); // radius 2
  refreshBonuses(board);
  assert.equal(isProtected(at(board, 0, 2)), true);
  assert.equal(at(board, 2, 2).bonusIncome, 0, 'protection has no income effect');
});

test('overlapping civic radii list every protector once', () => {
  const board = city([[2, 1, 1, 'civic'], [2, 3, 1, 'civic'], [2, 2, 1, 'residential']]);
  assert.deepEqual(at(board, 2, 2).protectedBy.sort(), ['r2c1', 'r2c3']);
});

/* ---------------- integration with play ---------------- */

test('building the 3rd home through real play recalculates everyone\'s bonus and income', () => {
  // Four developments in one Manage City: a table with a bigger Development Action budget.
  const game = createGame({ seats: [1, 2, 3, 4].map((seat) => ({ seat })), expansionActions: 4 });
  for (const [r, c] of [[0, 0], [0, 1], [0, 2]]) getBlock(game.board, r, c).ownerSeat = 1;
  assert.equal(buildOnBlock(game, 'r0c0', 'residential').ok, true);
  assert.equal(buildOnBlock(game, 'r0c1', 'residential').ok, true);
  assert.equal(playerStats(game, getPlayer(game, 1)).bonus, 0);

  assert.equal(buildOnBlock(game, 'r0c2', 'residential').ok, true); // third → district
  const each = base('residential') * B.RESIDENTIAL_DISTRICT.percent / 100;
  assert.equal(playerStats(game, getPlayer(game, 1)).bonus, 3 * each);
  assert.equal(calculateIncome(game.board, 1), 3 * (base('residential') + each));

  assert.equal(upgradeBlock(game, 'r0c0').ok, true); // upgrade → bonus follows new base
  assert.equal(getBlock(game.board, 0, 0).bonusIncome, base('residential', 2) * B.RESIDENTIAL_DISTRICT.percent / 100);
});

test('turn income pays bonuses; captures trigger a refresh', () => {
  const game = createGame({ seats: [1, 2].map((seat) => ({ seat })), eventPool: [] });
  for (const [r, c] of [[5, 0], [5, 1], [5, 2]]) {
    const b = getBlock(game.board, r, c);
    b.ownerSeat = 2;
    applyDevelopment(b, 'residential', 1);
  }
  // Stale on purpose: nothing refreshed yet. A capture elsewhere must refresh the whole board.
  assert.equal(getBlock(game.board, 5, 0).bonusIncome, 0);
  ['h-0-0', 'v-0-0', 'h-1-0'].forEach((id) => { game.board.roads[id] = 0; });
  placeRoad(game, 'v-0-1'); // P1 captures A1
  const each = base('residential') * B.RESIDENTIAL_DISTRICT.percent / 100;
  assert.equal(getBlock(game.board, 5, 0).bonusIncome, each);

  const r = placeRoad(game, 'h-6-5'); // P1's bonus road → P2's turn begins
  assert.deepEqual(r.turnIncome, { seat: 2, amount: 3 * (base('residential') + each) });
});

test('random boards keep bonus invariants', () => {
  let seed = 3;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const types = ['vacant', 'residential', 'commercial', 'park', 'civic', 'industrial', 'landmark'];
  const maxPct = Math.max(B.RESIDENTIAL_DISTRICT.percent, B.COMMERCIAL_DISTRICT.percent)
    + B.PARK_ADJACENCY.percentPerPark * B.PARK_ADJACENCY.maxParks + B.MIXED_USE.percent;
  for (let i = 0; i < 200; i++) {
    const board = createBoard();
    for (const b of board.blocks) {
      if (rand() < 0.2) continue;
      b.ownerSeat = 1 + Math.floor(rand() * 4);
      const type = types[Math.floor(rand() * types.length)];
      applyDevelopment(b, type, type === 'vacant' ? 0 : 1 + Math.floor(rand() * 3));
    }
    refreshBonuses(board);
    const snap = JSON.stringify(board.blocks);
    refreshBonuses(board);
    assert.equal(JSON.stringify(board.blocks), snap, 'idempotent');
    for (const b of board.blocks) {
      assert.equal(new Set(ids(b)).size, b.bonuses.length, 'each type once');
      assert.equal(b.bonusIncome, b.bonuses.reduce((s, x) => s + x.amount, 0));
      assert.ok(Number.isSafeInteger(b.bonusIncome) && b.bonusIncome >= 0);
      for (const x of b.bonuses) assert.equal(x.amount, Math.round(b.income * x.percent / 100));
      assert.ok(b.bonuses.reduce((s, x) => s + x.percent, 0) <= maxPct);
      if (b.ownerSeat == null || b.level === 0) assert.equal(b.bonuses.length, 0, 'vacant/unowned get nothing');
    }
  }
});
