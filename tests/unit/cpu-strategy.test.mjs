import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseCityAction, applyCityAction, evaluatePurchases, chooseRedevelopmentBid, defaultReserve, CITY_REASONS,
} from '../../js/core/cpu/city.js';
import { chooseRoad } from '../../js/core/cpu/roads.js';
import { CPU, ECONOMY } from '../../js/config.js';
import { createGame, placeRoad, currentPlayer, getPlayer, resolveCapture, TURN_PHASES } from '../../js/core/game.js';
import { getBlock, getBlockById } from '../../js/core/board.js';
import { applyDevelopment } from '../../js/core/development.js';
import { refreshBonuses } from '../../js/core/bonuses.js';
import { startEvent } from '../../js/core/events.js';
import { quoteRedevelopment } from '../../js/core/finance.js';

const humans = (n = 4) => Array.from({ length: n }, (_, i) => ({ seat: i + 1 }));
const PERSONALITY_IDS = Object.keys(CPU.PERSONALITIES);

/** P4 has just captured A1 through real play (no event drawn yet; `mode` sets the rules). */
function captured({ mode = 'standard', events = true } = {}) {
  const game = createGame({ seats: humans(), seed: 3, mode, ...(!events && { eventPool: [] }) });
  for (const id of ['h-0-0', 'v-0-0', 'h-1-0', 'v-0-1']) assert.ok(placeRoad(game, id).ok);
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

/** P4's Manage City with only the given blocks (A1 handed back). */
function managing(blocks, { cash } = {}) {
  const game = captured();
  resolveCapture(game);
  getBlockById(game.board, 'r0c0').ownerSeat = null;
  game.turnPhase = TURN_PHASES.MANAGE_CITY;
  game.pendingCaptures = [];
  game.city.actionsLeft = game.city.expansionActions; // a fresh Manage City's Development Action
  own(game, blocks);
  if (cash != null) currentPlayer(game).cash = cash;
  return game;
}

const score = (options, type) => options.find((o) => o.type === type)?.score;

/* ---------------- responding to city events ---------------- */

test('Hard waits out a price surcharge that ends this round; Normal pays it', () => {
  // Upgrading a Level 2 home to Level 3 costs 25% more during a Housing Boom. The extra is
  // paid once but, as upkeep follows the price paid, it costs every turn after too.
  const setup = (ending) => {
    const game = managing([[2, 2, 'residential', 2]]);
    if (ending != null) {
      startEvent(game, 'housing-boom');
      if (ending) game.events.active[0].endRound = game.round; // its last round: no boosted payday left
    }
    return game;
  };
  const [ends] = evaluatePurchases(setup(true), { difficulty: 'hard' });
  assert.equal(ends.waiting, true, 'waits: buying next turn is cheaper for good');
  assert.deepEqual(chooseCityAction(setup(true), { difficulty: 'hard' }), { action: 'pave', reason: CITY_REASONS.WAIT });
  assert.equal(evaluatePurchases(setup(null), { difficulty: 'hard' })[0].waiting, false, 'no surcharge, no waiting');
  assert.equal(evaluatePurchases(setup(false), { difficulty: 'hard' })[0].waiting, false, 'a longer boom pays for its surcharge');
  assert.equal(chooseCityAction(setup(true), { difficulty: 'normal' }).action, 'upgrade', 'Normal takes today\'s price at face value');
});

test('discounts and boosts count only while they last (Beautification Grant)', () => {
  const plain = captured();
  const grant = captured();
  startEvent(grant, 'beautification-grant'); // parks: half price, double income, 2 rounds
  const hard = [plain, grant].map((g) => score(evaluatePurchases(g, { difficulty: 'hard' }), 'park'));
  const normal = score(evaluatePurchases(grant, { difficulty: 'normal' }), 'park');
  assert.ok(hard[1] > hard[0], `Hard values a Park more during the grant (${hard[0]} → ${hard[1]})`);
  assert.ok(normal > hard[1], `but not as if the doubled income lasted all game, as Normal does (${normal})`);
});

test('civic shelter is worth more where emergencies are likelier', () => {
  const civic = (mode, emergency = false) => {
    const game = captured({ mode });
    own(game, [[0, 1, 'industrial', 3], [1, 0, 'industrial', 3]]);
    if (emergency) startEvent(game, 'power-outage');
    return score(evaluatePurchases(game, { difficulty: 'hard' }), 'civic');
  };
  const [classic, standard, chaos] = ['classic', 'standard', 'chaos'].map((m) => civic(m));
  assert.ok(classic < standard && standard < chaos, `Classic ${classic} < Standard ${standard} < Urban Chaos ${chaos}`);
  assert.ok(civic('standard', true) > standard, 'more so while an emergency is on');
});

test('during a downturn, Hard buys nothing that leaves its net income negative', () => {
  // Twelve vacant downtown lots: land tax far above any single building's income.
  const lots = [];
  for (let row = 1; row <= 4; row++) for (let col = 1; col <= 4; col++) if (lots.length < 12) lots.push([row, col]);
  const setup = (recession) => {
    const game = managing([]);
    for (const [row, col] of lots) getBlock(game.board, row, col).ownerSeat = 4;
    refreshBonuses(game.board);
    if (recession) startEvent(game, 'recession');
    return game;
  };
  const calm = chooseCityAction(setup(false), { difficulty: 'hard' });
  assert.equal(calm.action, 'build', 'in calm times it develops');
  const slump = chooseCityAction(setup(true), { difficulty: 'hard' });
  assert.deepEqual([slump.action, slump.reason], ['pave', CITY_REASONS.NOT_WORTH_IT], 'in a recession it holds its cash');
});

/* ---------------- redevelopment ---------------- */

/** Seats: 1 human, 2 Hard bot, 3 Normal bot. An abandoned block (seat 3 walked away) at r2c2. */
function ruin(type, level, { cash = {} } = {}) {
  const game = createGame({
    seats: [{ seat: 1 }, { seat: 2, controller: 'cpu', difficulty: 'hard', personality: 'builder' },
      { seat: 3, controller: 'cpu', difficulty: 'normal', personality: 'builder' }],
    seed: 5, eventPool: [],
  });
  const b = getBlockById(game.board, 'r2c2');
  applyDevelopment(b, type, level);
  Object.assign(b, { ownerSeat: null, abandoned: true, abandonedBy: 3 });
  refreshBonuses(game.board);
  for (const [seat, amount] of Object.entries(cash)) getPlayer(game, Number(seat)).cash = amount;
  return game;
}

test('Hard bids the reserve when no rival can pay it, and just enough to beat the richest rival otherwise', () => {
  const step = ECONOMY.FINANCE.REDEVELOPMENT.MIN_BID_INCREMENT;
  const price = quoteRedevelopment(ruin('commercial', 1), 'r2c2', 'restore').reserve;
  // Player 1 (the only other eligible bidder) is short of the reserve: uncontested.
  const alone = chooseRedevelopmentBid(ruin('commercial', 1, { cash: { 1: price - 100 } }), 2, 'r2c2', 'restore');
  assert.equal(alone, price, 'no one to outbid: pays the reserve');
  // Player 1 could pay $500 over the reserve: one step above that wins outright.
  const rival = price + 500;
  const contested = chooseRedevelopmentBid(ruin('commercial', 1, { cash: { 1: rival } }), 2, 'r2c2', 'restore');
  assert.equal(contested, rival + step, 'beats the richest rival by one step');
  assert.equal((contested - price) % step, 0);
  // A very rich rival: it bids up to its own limit and no further.
  const rich = chooseRedevelopmentBid(ruin('commercial', 1, { cash: { 1: 100000 } }), 2, 'r2c2', 'restore');
  assert.ok(rich < 100000 && rich >= price, 'never above what the lot is worth to it');
  assert.ok(rich <= getPlayer(ruin('commercial', 1), 2).cash - defaultReserve('hard', getPlayer(ruin('commercial', 1), 2)));
  // Cash risk: a poor Hard bot (reserve + next turn's bills not covered) passes.
  assert.equal(chooseRedevelopmentBid(ruin('commercial', 1, { cash: { 2: price + 500 } }), 2, 'r2c2', 'restore'), null);
});

test('restore vs clear & rebuild: it compares the ruin with the best building it could put there', () => {
  // A Level 1 Commercial ruin: cheaper to clear and build something better.
  const low = ruin('commercial', 1);
  placeRoad(low, 'h-0-0'); // seat 1 → the Hard bot's turn
  assert.deepEqual([chooseCityAction(low).action, chooseCityAction(low).mode], ['redevelop', 'rebuild']);
  // A Level 3 Landmark ruin: restoring it (40% of what it cost) beats starting over.
  const high = ruin('landmark', 3);
  placeRoad(high, 'h-0-0');
  assert.deepEqual([chooseCityAction(high).action, chooseCityAction(high).mode], ['redevelop', 'restore']);
  const won = applyCityAction(high, chooseCityAction(high));
  assert.equal(won.winnerSeat, 2);
  assert.equal(getBlockById(high.board, 'r2c2').level, 3, 'the Landmark is back in business');
});

/* ---------------- personalities ---------------- */

test('personality changes the cash reserve and how keen a mayor is on abandoned land', () => {
  const as = (personality) => ({ controller: 'cpu', difficulty: 'normal', personality });
  assert.equal(defaultReserve('normal', as('builder')), Math.round(CPU.RESERVE.normal * 0.9));
  assert.equal(defaultReserve('normal', as('planner')), Math.round(CPU.RESERVE.normal * 1.15));
  assert.equal(defaultReserve('normal', { controller: 'cpu', difficulty: 'normal', personality: null }), CPU.RESERVE.normal);
  const bid = (personality) => {
    const game = ruin('commercial', 1, { cash: { 1: 50000 } });
    getPlayer(game, 2).personality = personality;
    return chooseRedevelopmentBid(game, 2, 'r2c2', 'restore', { difficulty: 'normal' });
  };
  assert.ok(bid('expansionist') > bid('planner'), `Expansionist ${bid('expansionist')} > Planner ${bid('planner')}`);
});

test('Easy picks sensible builds at random, leaning towards its personality', () => {
  const picks = (personality) => {
    const tally = {};
    for (let seed = 0; seed < 60; seed++) {
      const game = captured({ events: false });
      Object.assign(currentPlayer(game), { controller: 'cpu', difficulty: 'easy', personality });
      const d = chooseCityAction(game, { seed });
      if (d.action === 'build') tally[d.type] = (tally[d.type] ?? 0) + 1;
    }
    return tally;
  };
  const planner = picks('planner');
  const tycoon = picks('tycoon');
  const green = (t) => (t.park ?? 0) + (t.civic ?? 0);
  const money = (t) => (t.commercial ?? 0) + (t.industrial ?? 0);
  assert.ok(green(planner) > green(tycoon), `Planner ${green(planner)} parks/civic v Tycoon ${green(tycoon)}`);
  assert.ok(money(tycoon) > money(planner), `Tycoon ${money(tycoon)} commerce/industry v Planner ${money(planner)}`);
});

/** All-CPU game through the real APIs; returns the game and every build by seat. */
function cpuGame(seats, seed) {
  const game = createGame({ seats, seed });
  const builds = {};
  while (game.phase === 'playing') {
    const me = currentPlayer(game);
    if (game.turnPhase === TURN_PHASES.MANAGE_CITY || game.turnPhase === TURN_PHASES.CAPTURE_DEVELOP) {
      const d = chooseCityAction(game);
      if (d.action === 'build') (builds[me.personality] ??= []).push(d.type);
      assert.ok(applyCityAction(game, d).ok);
    } else assert.ok(placeRoad(game, chooseRoad(game).road).ok);
  }
  return { game, builds };
}

test('Hard bots with different personalities build different cities', () => {
  const all = {};
  for (let i = 0; i < 4; i++) {
    const order = PERSONALITY_IDS.map((_, k) => PERSONALITY_IDS[(k + i) % 4]);
    const { builds } = cpuGame(order.map((personality, k) => ({ seat: k + 1, controller: 'cpu', difficulty: 'hard', personality })), 700 + i);
    for (const [p, list] of Object.entries(builds)) (all[p] ??= []).push(...list);
  }
  const share = (p, types) => all[p].filter((t) => types.includes(t)).length / all[p].length;
  assert.ok(share('planner', ['park', 'civic']) > share('tycoon', ['park', 'civic']), 'Planners green the city');
  assert.ok(share('tycoon', ['commercial', 'industrial']) > share('planner', ['commercial', 'industrial']), 'Tycoons chase income');
});

test('difficulty matters more than personality: Hard beats Easy whatever the personality', () => {
  for (const personality of PERSONALITY_IDS) {
    let hard = 0;
    let easy = 0;
    for (let i = 0; i < 4; i++) {
      const order = i % 2 ? ['easy', 'hard'] : ['hard', 'easy'];
      const { game } = cpuGame(order.map((difficulty, k) => ({ seat: k + 1, controller: 'cpu', difficulty, personality })), 1200 + i);
      for (const row of game.results.rows) {
        if (getPlayer(game, row.seat).difficulty === 'hard') hard += row.cityValue;
        else easy += row.cityValue;
      }
    }
    assert.ok(hard > easy * 1.5, `${personality}: Hard $${hard} v Easy $${easy}`);
  }
});

test('Hard double-deals for the next chain at two players, but not where a third mayor would get it', () => {
  // A downtown domino (C3 already on three sides, D3) is on offer, and a four-block chain
  // (A1, B1, C1 in the suburbs, C2 in midtown) is left for whoever must open it.
  //   take both:   +$5,000 now, then open the chain for the next mayor (−$6,500)
  //   double-deal: give the next mayor the domino; they must then open the chain. At two
  //                players it comes back to us; at three it goes to the third mayor.
  const free = ['v-0-0', 'v-0-1', 'v-0-2', 'h-1-2', 'v-1-2', 'v-2-3', 'v-2-4'];
  const open = ['r0c0', 'r0c1', 'r0c2', 'r1c2', 'r2c2', 'r2c3'];
  const table = (players, personality = null) => {
    const seats = [{ seat: 1, controller: 'cpu', difficulty: 'hard', personality }, { seat: 2 }, { seat: 3 }].slice(0, players);
    const game = createGame({ seats, seed: 1, eventPool: [] });
    for (const id of Object.keys(game.board.roads)) delete game.board.roads[id];
    const all = [];
    for (let r = 0; r <= 6; r++) for (let c = 0; c < 6; c++) all.push(`h-${r}-${c}`);
    for (let r = 0; r < 6; r++) for (let c = 0; c <= 6; c++) all.push(`v-${r}-${c}`);
    for (const id of all) if (!free.includes(id)) game.board.roads[id] = 2;
    for (const b of game.board.blocks) if (!open.includes(b.id)) b.ownerSeat = 2;
    return game;
  };
  const duel = chooseRoad(table(2));
  assert.deepEqual([duel.road, duel.reason], ['v-2-4', 'double-deal'], 'two players: the chain comes back');
  for (const personality of [null, ...PERSONALITY_IDS]) {
    const three = chooseRoad(table(3, personality));
    assert.deepEqual([three.road, three.reason], ['v-2-3', 'capture'], `three players (${personality ?? 'no personality'}): takes the domino`);
  }
});
