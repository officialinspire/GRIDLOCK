/**
 * City-era, development and strategy achievements: the facts summarizeMatch reads from the final
 * board/log/ledger, each rule's threshold, and genuine-match protection.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getBlock, allRoadIds } from '../../js/core/board.js';
import { applyDevelopment } from '../../js/core/development.js';
import { refreshBonuses } from '../../js/core/bonuses.js';
import { charge, credit, TXN } from '../../js/core/economy.js';
import { createGame, getPlayer, enterCityEra, PHASES } from '../../js/core/game.js';
import { computeResults } from '../../js/core/scoring.js';
import { ACHIEVEMENTS, GOALS, summarizeMatch, recordMatch, emptyCareer, isGenuineMatch } from '../../js/core/career.js';
import { getSpriteRect, parseSpriteRef } from '../../js/assets.js';

const rule = (id) => ACHIEVEMENTS.find((a) => a.id === id).test;
const NEW = ['hostile-bid', 'fortress', 'mixed-use', 'full-palette', 'heavy-industry', 'safe-streets', 'green-belt',
  'district-boss', 'cash-machine', 'balanced-budget', 'toast-of-the-town', 'metropolis'];

/** A finished City-era match staged on the board (never a genuine match). */
function staged(blocks, { tweak } = {}) {
  const game = createGame({ seats: [{ seat: 1 }, { seat: 2 }], seed: 5, eventPool: [] });
  for (const id of allRoadIds(game.board)) game.board.roads[id] = 1;
  enterCityEra(game);
  for (const [row, col, seat, type = 'vacant', level = 0] of blocks) {
    const b = getBlock(game.board, row, col);
    b.ownerSeat = seat;
    applyDevelopment(b, type, level);
  }
  refreshBonuses(game.board);
  tweak?.(game);
  game.phase = PHASES.ENDED;
  game.results = computeResults(game);
  return summarizeMatch(game).players.find((p) => p.seat === 1);
}

test('the new badges exist, with real icons; Comeback Kid still covers winning after bankruptcy', () => {
  for (const id of [...NEW, 'comeback']) assert.ok(ACHIEVEMENTS.some((a) => a.id === id), id);
  for (const a of ACHIEVEMENTS) assert.ok(getSpriteRect(...parseSpriteRef(a.icon)), `${a.id}: ${a.icon}`);
});

test('board facts: mixed use, all six types, factories, civic shelter, park network, whole district', () => {
  const p = staged([
    // Downtown (C3, D3, C4, D4) entirely seat 1's: a mixed-use cluster plus a civic.
    [2, 2, 1, 'residential', 1], [2, 3, 1, 'commercial', 1], [3, 2, 1, 'park', 1], [3, 3, 1, 'civic', 3],
    // Three factories and a landmark elsewhere; a four-park network.
    [0, 0, 1, 'industrial', 3], [0, 1, 1, 'industrial', 3], [0, 2, 1, 'industrial', 3], [5, 5, 1, 'landmark', 1],
    [5, 0, 1, 'park', 1], [5, 1, 1, 'park', 1], [5, 2, 1, 'park', 1], [4, 2, 1, 'park', 1],
    [1, 3, 1], // a lot inside City Hall's radius
    [1, 5, 2, 'residential', 1],
  ]);
  assert.equal(p.mixedUse, true);
  assert.equal(p.categoryTypes, 6);
  assert.equal(p.industrialL3, 3);
  assert.equal(p.parkNetwork, 5, 'the downtown park (C4) joins the network through C5');
  assert.equal(p.fullDistrict, true);
  assert.ok(p.sheltered >= GOALS.SHELTERED, `${p.sheltered} sheltered (City Hall covers radius 2)`);
  for (const id of ['mixed-use', 'full-palette', 'heavy-industry', 'green-belt', 'district-boss', 'safe-streets']) {
    assert.equal(rule(id)(p, { cityEra: true }), true, id);
  }
  // Seat 2's lone house qualifies for none of them.
  const empty = staged([[1, 5, 2, 'residential', 1]]);
  for (const id of ['mixed-use', 'full-palette', 'heavy-industry', 'green-belt', 'district-boss', 'safe-streets']) {
    assert.equal(rule(id)(empty, { cityEra: true }), false, id);
  }
});

test('fortress: enough blocks at enough control, none lost to a takeover, in the City era', () => {
  // A 3×2 residential estate: each block's control is 1 + level + nearby homes + adjacent support.
  const estate = [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2]].map(([r, c]) => [r, c, 1, 'residential', 1]);
  const strong = staged(estate);
  assert.ok(strong.minControl >= GOALS.FORTRESS_CONTROL, `min control ${strong.minControl}`);
  assert.equal(rule('fortress')(strong, { cityEra: true }), true);
  assert.equal(rule('fortress')(strong, { cityEra: false }), false, 'only a City-era match');
  const lost = staged(estate, { tweak: (g) => g.log.push({ type: 'takeover', seat: 2, from: 1, block: 'r4c4' }) });
  assert.equal(lost.takeoversLost, 1);
  assert.equal(rule('fortress')(lost, { cityEra: true }), false);
  const weak = staged([...estate.slice(0, 5), [4, 4, 1]]); // a lone vacant lot: control 1
  assert.equal(rule('fortress')(weak, { cityEra: true }), false);
});

test('takeovers, income, Prestige, levels and a debt-free win come from the log, results and ledger', () => {
  const p = staged([[0, 0, 1, 'landmark', 3], [0, 1, 1, 'landmark', 3], [0, 2, 1, 'commercial', 3], [0, 3, 1, 'industrial', 3],
    [1, 0, 1, 'park', 3], [1, 1, 1, 'civic', 3], [1, 2, 1, 'commercial', 3]], {
    tweak: (g) => g.log.push({ type: 'takeover', seat: 1, from: 2, block: 'r0c0' }),
  });
  assert.equal(p.takeovers, 1);
  assert.equal(rule('hostile-bid')(p), true);
  assert.ok(p.income >= GOALS.INCOME && rule('cash-machine')(p), `income ${p.income}`);
  assert.ok(p.prestige >= GOALS.PRESTIGE && rule('toast-of-the-town')(p), `Prestige ${p.prestige}`);
  assert.ok(p.totalLevels >= GOALS.LEVELS && rule('metropolis')(p), `levels ${p.totalLevels}`);
  assert.equal(p.neverInDebt, true);
  assert.equal(rule('balanced-budget')({ ...p, won: true }), true);
  assert.equal(rule('balanced-budget')({ ...p, won: false }), false, 'a win');

  const debtor = staged([[0, 0, 1, 'residential', 1]], {
    tweak: (g) => { charge(g, getPlayer(g, 1), 20000, TXN.UPKEEP); credit(g, getPlayer(g, 1), 20000, TXN.SALE); },
  });
  assert.equal(debtor.neverInDebt, false, 'dipping below $0 once is enough');
  assert.equal(rule('balanced-budget')({ ...debtor, won: true }), false);
  for (const id of ['hostile-bid', 'cash-machine', 'toast-of-the-town', 'metropolis']) assert.equal(rule(id)(debtor), false, id);
});

test('staged matches never award the new badges (genuine-match protection)', () => {
  const game = createGame({ seats: [{ seat: 1 }, { seat: 2 }], seed: 5, eventPool: [] });
  for (const id of allRoadIds(game.board)) game.board.roads[id] = 1;
  enterCityEra(game);
  for (let c = 0; c < 6; c++) {
    const b = getBlock(game.board, 0, c);
    b.ownerSeat = 1;
    applyDevelopment(b, 'landmark', 3);
  }
  refreshBonuses(game.board);
  game.phase = PHASES.ENDED;
  game.results = computeResults(game);
  assert.equal(isGenuineMatch(game), false);
  const r = recordMatch(emptyCareer(), game, 1);
  assert.deepEqual([r.recorded, r.unlocked], [false, []]);
});
