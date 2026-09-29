import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseCityAction, applyCityAction, cpuBids, CITY_REASONS, defaultReserve } from '../../js/core/cpu/city.js';
import { chooseRoad } from '../../js/core/cpu/roads.js';
import { CPU, ECONOMY } from '../../js/config.js';
import {
  createGame, placeRoad, currentPlayer, getPlayer, playerStats, enterCityEra, endCityTurn, TURN_PHASES, ERAS,
} from '../../js/core/game.js';
import { getBlock, getBlockById, allRoadIds } from '../../js/core/board.js';
import { applyDevelopment } from '../../js/core/development.js';
import { refreshBonuses } from '../../js/core/bonuses.js';
import { startEvent } from '../../js/core/events.js';
import { quoteBuild, quoteUpgrade } from '../../js/core/development.js';

const seats = (n = 4) => Array.from({ length: n }, (_, i) => ({ seat: i + 1 }));
const LEVELS = ['easy', 'normal', 'hard'];

/**
 * P4 has just captured A1 (r0c0) through real play and must choose Develop Now or Leave Vacant.
 * `mode` picks the rule preset; the city's event pool is empty unless `events` (none are drawn
 * before round 2 either way, so the position is identical).
 */
function captured({ cash, events = false, mode = 'standard', cityRounds } = {}) {
  const game = createGame({ seats: seats(), seed: 3, mode, cityRounds, ...(!events && { eventPool: [] }) });
  for (const id of ['h-0-0', 'v-0-0', 'h-1-0', 'v-0-1']) assert.ok(placeRoad(game, id).ok);
  assert.equal(game.turnPhase, TURN_PHASES.CAPTURE_DEVELOP);
  if (cash != null) currentPlayer(game).cash = cash;
  return game;
}

/** Gives the current mayor developed blocks: [[row, col, type, level], ...]. */
function own(game, blocks) {
  const seat = currentPlayer(game).seat;
  for (const [row, col, type, level] of blocks) {
    const b = getBlock(game.board, row, col);
    b.ownerSeat = seat;
    applyDevelopment(b, type, level);
  }
  refreshBonuses(game.board);
}

/* ---------------- Capture / Develop ---------------- */

test('with money and time, every difficulty develops a fresh capture it can afford', () => {
  for (const difficulty of LEVELS) {
    let built = 0;
    for (let seed = 0; seed < 12; seed++) {
      const game = captured();
      const cash = currentPlayer(game).cash;
      const d = chooseCityAction(game, { difficulty, seed });
      if (d.action === 'build') {
        built++;
        assert.ok(quoteBuild(game, d.blockId, d.type).ok, 'affordable by the real quote');
        assert.ok(cash - d.cost >= CPU.RESERVE[difficulty], 'reserve kept');
        const result = applyCityAction(game, d);
        assert.ok(result.ok);
        assert.equal(game.turnPhase, TURN_PHASES.BONUS_ROAD, 'the capture choice is settled');
      } else assert.equal(d.action, 'vacant');
    }
    if (difficulty === 'easy') assert.ok(built >= 6, `Easy builds on most captures (${built}/12)`);
    else assert.equal(built, 12, `${difficulty} always develops here`);
  }
});

test('never an unaffordable purchase: short of cash, the block stays vacant', () => {
  for (const difficulty of LEVELS) {
    for (let seed = 0; seed < 20; seed++) {
      const game = captured({ cash: 700 }); // cheapest build is a $800 Park
      const d = chooseCityAction(game, { difficulty, seed });
      assert.deepEqual([d.action, d.reason], ['vacant', CITY_REASONS.NO_CASH], `${difficulty} seed ${seed}`);
    }
  }
});

test('the cash reserve is configurable and always kept', () => {
  // $1,500: a Residential ($1,000) or Park ($800) is affordable, but not with $1,000 kept back.
  const d = chooseCityAction(captured({ cash: 1500 }), { difficulty: 'normal', seed: 1 });
  assert.deepEqual([d.action, d.reason], ['vacant', CITY_REASONS.CONSERVE]);
  const spend = chooseCityAction(captured({ cash: 1500 }), { difficulty: 'normal', seed: 1, reserve: 0 });
  assert.equal(spend.action, 'build');
  assert.equal(spend.type, 'residential', 'the best build that still covers next turn’s upkeep');
  // Easy's reserve too: $1,000 of cash with a $300 reserve rules out anything above $700.
  for (let seed = 0; seed < 20; seed++) {
    const e = chooseCityAction(captured({ cash: 1000 }), { difficulty: 'easy', seed });
    if (e.action === 'build') assert.ok(1000 - e.cost >= CPU.RESERVE.easy);
  }
  const generous = chooseCityAction(captured({ cash: 5000 }), { difficulty: 'hard', seed: 1, reserve: 4000 });
  assert.ok(generous.action === 'vacant' || 5000 - generous.cost >= 4000);
});

test('near the end of the city, Normal and Hard build only for Prestige (income would not pay back)', () => {
  // No CITY era: the match ends with the roads.
  const game = captured({ cityRounds: 0 });
  // Pave everything else except a couple of far-away roads: the game is about to end.
  const keep = new Set(['h-6-5', 'v-5-6']);
  for (const id of allRoadIds(game.board)) if (!keep.has(id) && !(id in game.board.roads)) game.board.roads[id] = 1;
  // As in real play, every enclosed block has been claimed; only F6 (r5c5) is still open.
  for (const b of game.board.blocks) if (b.ownerSeat == null && b.id !== 'r5c5') b.ownerSeat = 1;
  // Construction scores in full, so with no paydays left only Prestige makes a build worth it:
  // the Landmark (the most Prestige per build), never an income building.
  for (const difficulty of ['normal', 'hard']) {
    const d = chooseCityAction(game, { difficulty, seed: 1 });
    assert.deepEqual([d.action, d.type], ['build', 'landmark'], difficulty);
    assert.equal(d.cityValue, ECONOMY.STRATEGY.PRESTIGE.perLevel.landmark * ECONOMY.SCORING.PRESTIGE);
  }
});

test('adjacency bonuses steer the choice: a third Commercial block completes a district', () => {
  const plain = chooseCityAction(captured(), { difficulty: 'normal', seed: 1 });
  assert.notEqual(plain.type, 'commercial', 'on its own, Commercial is not the best build');
  for (const difficulty of ['normal', 'hard']) {
    const game = captured();
    own(game, [[0, 1, 'commercial', 1], [0, 2, 'commercial', 1]]);
    const d = chooseCityAction(game, { difficulty, seed: 1 });
    assert.deepEqual([d.action, d.type], ['build', 'commercial'], difficulty);
    applyCityAction(game, d);
    assert.ok(getBlockById(game.board, 'r0c0').bonuses.some((b) => /commercial/i.test(b.id)), 'the district bonus is on');
  }
});

test('events: Normal takes today’s prices and income at face value, Hard sees them pass', () => {
  // A Power Outage halves Industrial and Commercial income this round only. Landmark is out of reach.
  const setup = () => {
    const game = captured({ cash: 2500 });
    startEvent(game, 'power-outage');
    return game;
  };
  const normal = chooseCityAction(setup(), { difficulty: 'normal', seed: 1, reserve: 0 });
  assert.deepEqual([normal.action, normal.type], ['build', 'residential'], 'Normal avoids the blacked-out categories');
  const hard = chooseCityAction(setup(), { difficulty: 'hard', seed: 1, reserve: 0 });
  assert.deepEqual([hard.action, hard.type], ['build', 'industrial'], 'Hard knows the outage lasts one round');
});

test('Hard values civic shelter over its own developed neighbours; Normal does not', () => {
  const setup = (mode = 'standard') => {
    const game = captured({ events: true, mode });
    own(game, [[0, 1, 'industrial', 3], [1, 0, 'industrial', 3]]);
    return game;
  };
  const hard = chooseCityAction(setup(), { difficulty: 'hard', seed: 1 });
  assert.deepEqual([hard.action, hard.type], ['build', 'civic'], 'Hard shelters $3,600/turn of Industrial');
  const normal = chooseCityAction(setup(), { difficulty: 'normal', seed: 1 });
  assert.notEqual(normal.type, 'civic');
  // No emergencies can happen in Classic, so there is nothing to shelter from.
  assert.notEqual(chooseCityAction(setup('classic'), { difficulty: 'hard', seed: 1 }).type, 'civic');
});

/* ---------------- Manage City ---------------- */

/** P4's Manage City phase with the given buildings and cash. */
function managing(blocks, cash) {
  const game = captured();
  applyCityAction(game, { action: 'vacant', blockId: 'r0c0' });
  game.board.blocks.find((b) => b.id === 'r0c0').ownerSeat = null;
  own(game, blocks);
  game.turnPhase = TURN_PHASES.MANAGE_CITY;
  game.pendingCaptures = [];
  currentPlayer(game).cash = cash;
  return game;
}

test('Manage City: upgrades when it pays, otherwise goes to pave', () => {
  const rich = managing([[2, 2, 'industrial', 1]], 12000);
  const d = chooseCityAction(rich, { difficulty: 'normal', seed: 1 });
  assert.deepEqual([d.action, d.blockId], ['upgrade', 'r2c2']);
  assert.ok(quoteUpgrade(rich, 'r2c2').ok);
  const poor = managing([[2, 2, 'industrial', 1]], 1200);
  assert.deepEqual(chooseCityAction(poor, { difficulty: 'normal', seed: 1 }).action, 'pave');
  const done = managing([[2, 2, 'industrial', 3]], 12000);
  assert.deepEqual(chooseCityAction(done, { difficulty: 'hard', seed: 1 }), { action: 'pave', reason: CITY_REASONS.NO_CASH });
  // Asking and applying repeatedly spends down to the reserve and then paves.
  const game = managing([[2, 2, 'industrial', 1], [3, 3, 'residential', 1]], 12000);
  for (let step = 0; step < 20; step++) {
    const next = chooseCityAction(game, { difficulty: 'hard' });
    assert.ok(applyCityAction(game, next).ok, `${next.action} applies`);
    if (next.action === 'pave') break;
  }
  assert.equal(game.turnPhase, TURN_PHASES.PAVE_ROAD);
  assert.ok(currentPlayer(game).cash >= CPU.RESERVE.hard);
});

/* ---------------- debt ---------------- */

test('in debt: sell or downgrade the cheapest loss first; bankruptcy only when nothing else can work', () => {
  // A Park (earns $94 net) and a Residential ($230 net); $300 of debt.
  const setup = () => {
    const game = managing([[2, 2, 'park', 1], [3, 3, 'residential', 1]], -300);
    return game;
  };
  for (const difficulty of ['normal', 'hard']) {
    const d = chooseCityAction(setup(), { difficulty, seed: 1 });
    assert.deepEqual([d.action, d.blockId], ['downgrade', 'r2c2'], `${difficulty} gives up the Park`);
  }
  for (const difficulty of LEVELS) {
    const game = setup();
    for (let step = 0; step < 10 && currentPlayer(game).cash < 0; step++) {
      const d = chooseCityAction(game, { difficulty, seed: step });
      assert.notEqual(d.action, 'bankruptcy', 'selling can cover it');
      assert.ok(applyCityAction(game, d).ok);
    }
    assert.ok(currentPlayer(game).cash >= 0, `${difficulty} gets out of debt`);
  }
  const broke = managing([[2, 2, 'park', 1]], -5000);
  assert.equal(chooseCityAction(broke, { difficulty: 'normal' }).action, 'bankruptcy');
  assert.ok(applyCityAction(broke, chooseCityAction(broke)).ok);
  assert.ok(currentPlayer(broke).cash >= 0);
});

/* ---------------- purity & determinism ---------------- */

test('decisions are pure and deterministic, and never touch the game RNG', () => {
  const game = captured();
  startEvent(game, 'housing-boom');
  const before = JSON.stringify(game);
  for (const difficulty of LEVELS) {
    assert.deepEqual(chooseCityAction(game, { difficulty, seed: 5 }), chooseCityAction(game, { difficulty, seed: 5 }));
    assert.deepEqual(chooseCityAction(game, { difficulty }), chooseCityAction(game, { difficulty }));
  }
  assert.equal(JSON.stringify(game), before, 'game untouched (rngState included)');
  assert.deepEqual(chooseCityAction({ ...game, turnPhase: TURN_PHASES.PAVE_ROAD }), { action: null, error: 'wrong-turn-phase' });
});

/* ---------------- whole games ---------------- */

/** All-CPU game: city decisions then roads, every step through the real APIs. */
function cpuGame(difficulties, seed, mode = 'standard') {
  const game = createGame({ seats: difficulties.map((difficulty, i) => ({ seat: i + 1, controller: 'cpu', difficulty })), seed, mode });
  let steps = 0;
  while (game.phase === 'playing') {
    assert.ok(++steps < 3000, 'game finishes');
    const me = currentPlayer(game);
    if (game.turnPhase === TURN_PHASES.MANAGE_CITY || game.turnPhase === TURN_PHASES.CAPTURE_DEVELOP) {
      const d = chooseCityAction(game);
      const cash = me.cash;
      const result = applyCityAction(game, d);
      assert.ok(result.ok, `seed ${seed}: ${d.action} ${d.blockId ?? ''} ${d.type ?? ''} applies`);
      if (d.action === 'build' || d.action === 'upgrade') {
        assert.ok(cash - d.cost >= defaultReserve(me.difficulty, me), 'reserve kept');
      }
    } else {
      const d = chooseRoad(game);
      assert.ok(placeRoad(game, d.road).ok);
    }
  }
  return game;
}

test('CPU mayors of every difficulty play whole games legally, in every preset', () => {
  for (const [table, seed, mode] of [[['easy', 'normal', 'hard', 'easy'], 1, 'standard'], [['hard', 'normal'], 2, 'chaos'], [['normal', 'hard', 'easy'], 3, 'classic']]) {
    const game = cpuGame(table, seed, mode);
    assert.equal(game.phase, 'ended');
    const developed = game.board.blocks.filter((b) => b.level > 0).length;
    assert.ok(developed > 0, `${mode}: the city gets built`);
  }
});

test('stronger difficulties build better cities: Hard and Normal out-score Easy', () => {
  const totals = { easy: 0, normal: 0, hard: 0 };
  const rounds = 6;
  for (let i = 0; i < rounds; i++) {
    // Every seating order once: rotating alone keeps the cyclic order, so one difficulty would
    // always sit right after (and collect the gifts of) the same other one.
    const table = [['easy', 'normal', 'hard'], ['easy', 'hard', 'normal'], ['normal', 'easy', 'hard'],
      ['normal', 'hard', 'easy'], ['hard', 'easy', 'normal'], ['hard', 'normal', 'easy']][i % 6];
    const game = cpuGame(table, 40 + i);
    for (const row of game.results.rows) totals[getPlayer(game, row.seat).difficulty] += row.cityValue;
    for (const p of game.players) assert.ok(Number.isSafeInteger(playerStats(game, p).income));
  }
  assert.ok(totals.normal > totals.easy, `Normal $${totals.normal} v Easy $${totals.easy}`);
  assert.ok(totals.hard > totals.easy, `Hard $${totals.hard} v Easy $${totals.easy}`);
});

/* ---------------- redevelopment bidding ---------------- */

/** A 3-seat table (1 human, 2 CPU) with an abandoned downtown Commercial that seat 3 walked away from. */
function abandonedTable({ cash } = {}) {
  const game = createGame({
    seats: [{ seat: 1 }, { seat: 2, controller: 'cpu', difficulty: 'hard' }, { seat: 3, controller: 'cpu', difficulty: 'normal' }],
    seed: 5, eventPool: [],
  });
  const b = getBlockById(game.board, 'r2c2');
  applyDevelopment(b, 'commercial', 1);
  Object.assign(b, { ownerSeat: null, abandoned: true, abandonedBy: 3 });
  refreshBonuses(game.board);
  if (cash != null) for (const p of game.players) p.cash = cash;
  return game;
}

test('sealed bids: at least the reserve, in whole increments, within cash minus the reserve kept', async () => {
  const { chooseRedevelopmentBid, cpuBids } = await import('../../js/core/cpu/city.js');
  const { quoteRedevelopment } = await import('../../js/core/finance.js');
  const game = abandonedTable();
  const { reserve: price } = quoteRedevelopment(game, 'r2c2', 'restore');
  const hard = chooseRedevelopmentBid(game, 2, 'r2c2', 'restore');
  const normal = chooseRedevelopmentBid(game, 2, 'r2c2', 'restore', { difficulty: 'normal' });
  for (const bid of [hard, normal]) {
    assert.ok(bid >= price, 'meets the reserve price');
    assert.equal((bid - price) % ECONOMY.FINANCE.REDEVELOPMENT.MIN_BID_INCREMENT, 0, 'whole increments');
    assert.ok(bid <= getPlayer(game, 2).cash - CPU.RESERVE.hard);
  }
  assert.ok(hard >= normal, 'Hard bids closer to what the lot is worth');
  assert.equal(chooseRedevelopmentBid(game, 3, 'r2c2', 'restore'), null, 'a former owner can\'t bid');
  assert.equal(chooseRedevelopmentBid(abandonedTable({ cash: 2500 }), 2, 'r2c2', 'restore'), null, 'can\'t pay and keep its reserve');
  assert.deepEqual(cpuBids(game, 'r2c2', 'restore').map((b) => b.seat), [2], 'only eligible CPU seats bid');
  assert.equal(JSON.stringify(game), JSON.stringify(abandonedTable()), 'bidding changes nothing');
});

test('a CPU mayor only opens bidding it will bid in itself, at any cash level (no stuck auctions)', () => {
  // Hard keeps next turn's upkeep in hand when bidding; opening must follow the same rule, or the
  // auction settles with no bids and the bot asks to open it again, forever.
  for (let cash = 0; cash <= 14000; cash += 250) {
    const game = abandonedTable();
    placeRoad(game, 'h-0-0'); // seat 1 → the Hard bot's Manage City
    const own = getBlockById(game.board, 'r4c4');
    Object.assign(own, { ownerSeat: 2 });
    applyDevelopment(own, 'industrial', 2); // upkeep to keep in hand
    refreshBonuses(game.board);
    currentPlayer(game).cash = cash;
    const d = chooseCityAction(game);
    if (d.action !== 'redevelop') continue;
    const result = applyCityAction(structuredClone(game), d);
    assert.ok(result.ok, `cash $${cash}: the auction it opens settles (${result.error})`);
  }
});

test('a CPU mayor opens bidding on a lot worth having, and the sealed bids settle it', async () => {
  const game = abandonedTable();
  placeRoad(game, 'h-0-0'); // seat 1 → the Hard bot's Manage City
  assert.equal(currentPlayer(game).seat, 2);
  const d = chooseCityAction(game);
  // Clearing the Commercial ruin and building something better beats restoring it.
  assert.deepEqual([d.action, d.blockId, d.mode], ['redevelop', 'r2c2', 'rebuild']);
  // A person outbids it: the highest sealed bid wins.
  const outbid = structuredClone(game);
  const botBid = cpuBids(game, d.blockId, d.mode).find((b) => b.seat === 2).bid;
  const r = applyCityAction(outbid, { ...d, humanBids: [{ seat: 1, bid: botBid + ECONOMY.FINANCE.REDEVELOPMENT.MIN_BID_INCREMENT }] });
  assert.equal(r.winnerSeat, 1);
  // Nobody else bids: the bot wins at its own bid, paid through the real auction.
  const cash = currentPlayer(game).cash;
  const won = applyCityAction(game, d);
  assert.equal(won.winnerSeat, 2);
  assert.equal(getBlockById(game.board, 'r2c2').ownerSeat, 2);
  assert.equal(currentPlayer(game).cash, cash - won.cost);
  assert.ok(currentPlayer(game).cash >= CPU.RESERVE.hard);
});

/* ---------------- CITY era ---------------- */

/** Every road paved and the CITY era under way; the current mayor (a CPU) owns a few vacant lots. */
function cityTable(difficulty) {
  const game = createGame({ seats: [1, 2].map((seat) => ({ seat, controller: 'cpu', difficulty })), seed: 9, eventPool: [] });
  for (const id of allRoadIds(game.board)) game.board.roads[id] = 1;
  game.board.blocks.forEach((b, i) => { b.ownerSeat = (i % 2) + 1; });
  refreshBonuses(game.board);
  assert.equal(enterCityEra(game), true);
  currentPlayer(game).cash = 40000;
  return game;
}

test('CITY era: CPU mayors spend at most their City Actions, then end the turn', () => {
  for (const difficulty of LEVELS) {
    const game = cityTable(difficulty);
    const me = currentPlayer(game);
    let spent = 0;
    let d;
    for (let i = 0; i < 10; i++) {
      d = chooseCityAction(game, { seed: i });
      assert.notEqual(d.action, 'pave', `${difficulty}: no paving in the CITY era`);
      if (d.action === 'end-turn') break;
      assert.ok(applyCityAction(game, d).ok, `${difficulty}: ${d.action}`);
      spent++;
    }
    assert.equal(d.action, 'end-turn', `${difficulty}: the turn ends`);
    assert.ok(spent <= game.city.actionsPerTurn, `${difficulty}: ${spent} actions`);
    if (difficulty !== 'easy') assert.equal(d.reason, CITY_REASONS.NO_ACTIONS, `${difficulty}: plenty to build, so every action is used`);
    const result = applyCityAction(game, d);
    assert.equal(result.ok, true);
    assert.notEqual(currentPlayer(game).seat, me.seat, 'play passes on');
    assert.equal(game.city.actionsLeft, game.city.actionsPerTurn);
  }
});

test('CITY era: on the very last turn, Normal and Hard spend their actions on Prestige only', () => {
  for (const difficulty of ['normal', 'hard']) {
    const game = cityTable(difficulty);
    // Play on to the last seat of the last City round.
    while (!(game.round === game.city.endRound && game.turnIndex === game.players.length - 1)) {
      assert.ok(endCityTurn(game).ok);
      currentPlayer(game).cash = 40000;
    }
    assert.equal(game.era, ERAS.CITY);
    // No paydays left: income buildings are worth nothing more, Landmarks still score Prestige.
    const built = [];
    let d = chooseCityAction(game, { seed: 1 });
    while (d.action === 'build' || d.action === 'upgrade') {
      built.push(d.type ?? getBlockById(game.board, d.blockId).type); // a Landmark build or upgrade
      assert.ok(applyCityAction(game, d).ok);
      d = chooseCityAction(game, { seed: 1 });
    }
    assert.deepEqual(built, ['landmark', 'landmark'], difficulty);
    assert.deepEqual([d.action, d.reason], ['end-turn', CITY_REASONS.NO_ACTIONS], difficulty);
    assert.equal(applyCityAction(game, d).gameEnded, true);
  }
});
