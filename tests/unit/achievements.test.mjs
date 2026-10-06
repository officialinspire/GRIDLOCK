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

test('mischief facts from the move log: takeovers, payback, reclaiming, auctions, fire sales, idle City turns', () => {
  const p = staged([[0, 0, 1, 'residential', 1], [1, 1, 1, 'residential', 1]], {
    tweak: (g) => {
      const full = g.city.actionsPerTurn;
      g.log.push(
        { type: 'takeover', seat: 1, from: 2, block: 'r0c0', category: 'residential', level: 1 }, // first: no payback yet
        { type: 'takeover', seat: 2, from: 1, block: 'r1c1', category: 'park', level: 1 },
        { type: 'takeover', seat: 1, from: 2, block: 'r1c1', category: 'park', level: 1 }, // payback, and r1c1 reclaimed
        { type: 'bankruptcy', seat: 2, abandoned: ['r5c5', 'r5c4'] },
        { type: 'redevelopment-auction', seat: 1, block: 'r5c5', mode: 'restore', bid: 900, bids: 2 },
        { type: 'sale', seat: 1, block: 'r0c3', category: 'civic', fromLevel: 3, toLevel: 0, refund: 10 },
        { type: 'city-turn', seat: 1, unused: full }, { type: 'city-turn', seat: 1, unused: full },
        { type: 'city-turn', seat: 1, unused: 0 }, { type: 'city-turn', seat: 1, unused: full },
      );
    },
  });
  assert.deepEqual([p.takeovers, p.takeoversLost, p.mostFromOneRival, p.evictions], [2, 1, 2, 1]);
  assert.deepEqual([p.payback, p.reclaimed], [true, true]);
  assert.deepEqual([p.acquired, p.contestedWins, p.restored, p.vulture], [1, 1, 1, true]);
  assert.deepEqual([p.sales, p.topLevelSales, p.idleCityTurns], [1, 1, 3]);
  for (const id of ['thorn-in-the-side', 'eviction-notice', 'payback', 'reclaimed', 'hostile-environment', 'redeveloper', 'bidding-war',
    'restoration', 'vulture', 'fire-sale', 'couch-mayor']) {
    assert.equal(rule(id)(p, {}), true, id);
  }
  assert.equal(rule('corporate-raider')(p, {}), false, 'three takeovers needed');

  // Only one takeover, from the mayor who never took anything back: no payback, no reclaim.
  const q = staged([[0, 0, 1, 'residential', 1]], {
    tweak: (g) => g.log.push(
      { type: 'takeover', seat: 1, from: 2, block: 'r0c0', category: 'commercial', level: 2 },
      { type: 'bankruptcy', seat: 1, abandoned: ['r4c4'] },
      { type: 'acquire', seat: 1, block: 'r4c4', mode: 'rebuild', cost: 500 }, // buying back your own ruin
    ),
  });
  assert.deepEqual([q.payback, q.reclaimed, q.evictions, q.vulture, q.contestedWins, q.restored], [false, false, 0, false, 0, 0]);
  assert.equal(q.acquired, 1);
  assert.equal(q.bankruptcies, 0, 'the final count comes from the scored player (staged here without one)');
});

test('board facts for the cheeky badges: the holdout, a bad neighbour, a land speculator', () => {
  // Downtown is C3, D3, C4, D4: seat 2 holds three, seat 1 the fourth.
  const holdout = staged([[2, 2, 2, 'residential', 1], [2, 3, 2], [3, 2, 2], [3, 3, 1, 'industrial', 1], [3, 4, 2, 'residential', 1]]);
  assert.equal(holdout.holdout, true);
  assert.equal(holdout.badNeighbour, true, 'a factory beside a rival\'s house');
  assert.equal(rule('holdout')(holdout), true);
  assert.equal(rule('bad-neighbour')(holdout), true);
  const lone = staged([[2, 2, 1], [0, 0, 1, 'industrial', 1], [0, 1, 1, 'residential', 1]]);
  assert.equal(lone.holdout, false, 'nobody else owns the rest of Downtown');
  assert.equal(lone.badNeighbour, false, 'next to your own homes is only bad planning');
  const lots = staged([[0, 0, 1], [0, 1, 1], [0, 2, 1], [0, 3, 1], [0, 4, 1], [0, 5, 1], [1, 0, 1, 'park', 1]]);
  assert.equal(lots.vacantLots, GOALS.VACANT_LOTS);
  assert.equal(rule('land-speculator')(lots), true);
  const district = staged([[2, 2, 1], [2, 3, 1], [3, 2, 1], [3, 3, 1]]);
  assert.deepEqual([district.districtsOwned, district.fullDistrict], [1, true]);
  assert.deepEqual([rule('district-boss')(district), rule('kingpin')(district)], [true, false]);
});

test('match, table and rule-set badges on hand-made facts', () => {
  const me = { seat: 1, name: 'Ann', won: true, rank: 1, blocks: 8, margin: 600, bankruptcies: 0, cpu: false };
  const bot = (seat, difficulty, rank, blocks = 9) => ({ seat, name: `Bot ${seat}`, cpu: true, difficulty, rank, blocks });
  const hard3 = { mode: 'standard', tie: false, humans: 1, players: [me, bot(2, 'hard', 2), bot(3, 'hard', 3), bot(4, 'hard', 4)] };
  assert.equal(rule('against-all-odds')(me, hard3), true);
  assert.equal(rule('hard-drive')(me, hard3), true);
  assert.equal(rule('solo-act')(me, hard3), true);
  assert.equal(rule('small-but-mighty')(me, hard3), true, 'the bots own more blocks');
  assert.equal(rule('nail-biter')(me, hard3), true);
  assert.equal(rule('landslide')(me, hard3), false);
  assert.equal(rule('by-the-book')(me, hard3), true);
  assert.equal(rule('eye-of-the-storm')(me, { ...hard3, mode: 'chaos' }), true);
  assert.equal(rule('nail-biter')(me, { ...hard3, tie: true }), false, 'a tie is a Photo Finish, not a narrow win');
  assert.equal(rule('landslide')({ ...me, margin: 50000 }, hard3), true);

  const last = { ...me, won: false, rank: 4, margin: -9000 };
  const easy = { mode: 'standard', humans: 1, players: [last, bot(2, 'easy', 1), bot(3, 'normal', 2), bot(4, 'normal', 3)] };
  assert.equal(rule('participation-trophy')(last, easy), true);
  assert.equal(rule('humbled')(last, easy), true);
  assert.equal(rule('humbled')(me, hard3), false);
  assert.equal(rule('participation-trophy')(last, { ...easy, players: easy.players.slice(0, 3) }), false, 'four mayors');
  assert.equal(rule('full-house')(me, { humans: 4 }), true);
  assert.equal(rule('solo-act')(me, { humans: 2, players: [me, bot(2, 'easy', 2)] }), false);

  const phoenix = { ...me, won: false, rank: 2, bankruptcies: 1 };
  assert.equal(rule('phoenix')(phoenix, { players: [me, phoenix, bot(3, 'easy', 3)] }), true);
  assert.equal(rule('phoenix')(phoenix, { players: [me, phoenix] }), false, 'second of two is last');
  assert.equal(rule('weathered')(me, { eventsSurvived: GOALS.WEATHERED }), true);
  assert.equal(rule('in-the-red')({ neverInDebt: false }), true);
  assert.equal(rule('in-the-red')({ neverInDebt: true }), false);
});
