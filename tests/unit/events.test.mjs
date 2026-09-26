import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CITY_EVENTS, ECONOMY } from '../../js/config.js';
import { getBlock, allRoadIds } from '../../js/core/board.js';
import { applyDevelopment, quoteBuild, buildOnBlock, TABLE } from '../../js/core/development.js';
import { refreshBonuses } from '../../js/core/bonuses.js';
import {
  EVENT_POOL, getEventDef, drawEvent, drawableEvents, startEvent, expireEvents, onRoundStart,
  incomeMultiplier, effectiveIncome, effectiveBlockIncome, costMultiplier, eligibleTargets,
  eventFootprint, roundsLeft, blockImpacts,
} from '../../js/core/events.js';
import { calculateIncome, isValidAmount, TXN } from '../../js/core/economy.js';
import { createGame, placeRoad, currentPlayer, getPlayer, playerStats, PHASES } from '../../js/core/game.js';
import { distressStatus, sellDevelopment, declareBankruptcy, ownershipProblems } from '../../js/core/finance.js';
import { getSpriteRect } from '../../js/assets.js';

const seats = (n = 4) => Array.from({ length: n }, (_, i) => ({ seat: i + 1 }));
const calm = () => createGame({ seats: seats(), seed: 1, eventPool: [] });
const only = (id, seed = 1) => createGame({ seats: seats(), seed, eventPool: [getEventDef(id)] });

/** Develops a block for a seat directly and refreshes bonuses. */
function dev(game, row, col, seat, type, level = 1) {
  const b = getBlock(game.board, row, col);
  b.ownerSeat = seat;
  applyDevelopment(b, type, level);
  refreshBonuses(game.board);
  return b;
}

/** Plays one non-capturing road per player so the round wraps. */
function finishRound(game) {
  const start = game.round;
  const free = allRoadIds(game.board).filter((id) => !(id in game.board.roads));
  let last;
  while (game.round === start) {
    // Pick a road that captures nothing (all our test blocks are claimed via dev(), not roads).
    const id = free.shift();
    last = placeRoad(game, id);
    assert.equal(last.ok, true);
  }
  return last;
}

/* ---------------- data ---------------- */

test('the pool is data-driven and complete', () => {
  const ids = EVENT_POOL.map((e) => e.id);
  assert.deepEqual(ids, ['heavy-rain', 'snowstorm', 'fire', 'power-outage', 'city-festival',
    'housing-boom', 'beautification-grant', 'economic-boom', 'recession']);
  const categories = Object.keys(ECONOMY.DEVELOPMENT.CATEGORIES);
  for (const e of EVENT_POOL) {
    assert.ok(e.name && e.text, e.id);
    assert.ok(['emergency', 'boon', 'downturn'].includes(e.kind), e.id);
    assert.ok(Number.isFinite(e.weight) && e.weight >= 0, e.id);
    assert.ok(Number.isInteger(e.duration) && e.duration >= 1, e.id);
    assert.ok(getSpriteRect(...e.sprite.split(':')), `${e.id} sprite`);
    for (const m of e.income ?? []) {
      assert.ok(m.multiplier >= CITY_EVENTS.MIN_MULTIPLIER && m.multiplier <= CITY_EVENTS.MAX_MULTIPLIER);
      (m.match.categories ?? []).forEach((c) => assert.ok(categories.includes(c), `${e.id}: ${c}`));
    }
    for (const c of e.costs ?? []) c.categories.forEach((cat) => assert.ok(categories.includes(cat)));
    if (e.kind === 'emergency') assert.equal(e.mitigation, 'civic', `${e.id} is mitigable`);
  }
  assert.ok(Object.isFrozen(EVENT_POOL));
});

/* ---------------- drawing ---------------- */

test('weighted draws follow the weights and are reproducible from the seed', () => {
  const game = calm();
  dev(game, 0, 0, 1, 'residential'); // makes Fire drawable
  const counts = Object.fromEntries(EVENT_POOL.map((e) => [e.id, 0]));
  const N = 20000;
  for (let i = 0; i < N; i++) counts[drawEvent(game).id]++;
  const total = EVENT_POOL.reduce((s, e) => s + e.weight, 0);
  for (const e of EVENT_POOL) {
    const expected = (N * e.weight) / total;
    assert.ok(Math.abs(counts[e.id] - expected) < expected * 0.15, `${e.id}: ${counts[e.id]} vs ~${expected}`);
  }

  const a = createGame({ seats: seats(), seed: 42 });
  const b = createGame({ seats: seats(), seed: 42 });
  dev(a, 0, 0, 1, 'residential');
  dev(b, 0, 0, 1, 'residential');
  const seq = (g) => Array.from({ length: 30 }, () => drawEvent(g).id);
  assert.deepEqual(seq(a), seq(b));
});

test('weight-0 events are never drawn; targeted events need eligible blocks', () => {
  const game = calm();
  const pool = [{ ...getEventDef('snowstorm'), weight: 0 }, getEventDef('fire'), getEventDef('recession')];
  assert.deepEqual(drawableEvents(game, pool).map((e) => e.id), ['recession'], 'no developed blocks → no fire');
  for (let i = 0; i < 200; i++) assert.equal(drawEvent(game, pool).id, 'recession');
  dev(game, 2, 2, 1, 'commercial');
  assert.deepEqual(drawableEvents(game, pool).map((e) => e.id), ['fire', 'recession']);
  assert.equal(drawEvent(game, []), null);
});

/* ---------------- lifecycle ---------------- */

test('an event triggers once per full round, never mid-round', () => {
  const game = only('snowstorm');
  for (let i = 0; i < 3; i++) {
    const r = placeRoad(game, allRoadIds(game.board)[i]);
    assert.equal(r.event, null);
    assert.equal(game.events.active.length, 0);
  }
  const wrap = placeRoad(game, allRoadIds(game.board)[3]); // 4th player → round 2
  assert.equal(wrap.roundEnded, true);
  assert.equal(wrap.event.started.id, 'snowstorm');
  assert.deepEqual(
    { start: wrap.event.started.startRound, end: wrap.event.started.endRound },
    { start: 2, end: 2 },
  );
  assert.equal(game.events.history.length, 1);
  assert.equal(game.log.filter((e) => e.type === 'event').length, 1);
});

test('events last exactly `duration` rounds and then expire', () => {
  const game = only('housing-boom'); // duration 2
  const r2 = finishRound(game); // → round 2
  const boom = r2.event.started;
  assert.deepEqual([boom.startRound, boom.endRound], [2, 3]);
  assert.equal(roundsLeft(game, boom), 2);

  // Round 3: re-drawn (only event in pool) → refreshed, not stacked.
  const r3 = finishRound(game);
  assert.equal(game.events.active.length, 1, 'same event never stacks');
  assert.deepEqual([r3.event.started.startRound, r3.event.started.endRound], [3, 4]);

  // With an empty pool from now on, it expires at the start of round 5.
  game.eventPool = [];
  const r4 = finishRound(game);
  assert.equal(r4.event.expired.length, 0);
  assert.equal(game.events.active.length, 1, 'still active in round 4');
  const r5 = finishRound(game);
  assert.deepEqual(r5.event.expired.map((e) => e.id), ['housing-boom']);
  assert.equal(game.events.active.length, 0);
});

test('expireEvents is idempotent and only removes finished events', () => {
  const game = calm();
  game.round = 3;
  game.events.active = [
    { uid: 1, id: 'fire', startRound: 2, endRound: 2, targets: [] },
    { uid: 2, id: 'recession', startRound: 2, endRound: 3, targets: [] },
  ];
  assert.deepEqual(expireEvents(game).map((e) => e.uid), [1]);
  assert.deepEqual(expireEvents(game), []);
  assert.deepEqual(game.events.active.map((e) => e.uid), [2]);
});

/* ---------------- income effects ---------------- */

test('income modifiers apply while active and vanish exactly on expiry', () => {
  const game = calm();
  const home = dev(game, 5, 5, 2, 'residential'); // P2, base 300
  const normal = calculateIncome(game.board, 2);
  startEvent(game, 'housing-boom'); // round 1..2, residential ×1.5
  assert.equal(effectiveIncome(game, 2), normal * 1.5);
  assert.equal(playerStats(game, getPlayer(game, 2)).eventDelta, normal * 0.5);

  // P2's turn begins in round 1 → paid boosted income.
  const r = placeRoad(game, 'h-0-0');
  assert.deepEqual(r.turnIncome, { seat: 2, amount: 450 });

  // Advance past round 2; income returns to normal with nothing left behind.
  finishRound(game); // → round 2 (still active)
  assert.equal(effectiveIncome(game, 2), 450);
  finishRound(game); // → round 3 (expired)
  assert.equal(game.events.active.length, 0);
  assert.equal(effectiveIncome(game, 2), normal);
  assert.equal(home.income, 300, 'block data never modified by events');
  assert.equal(incomeMultiplier(game, home), 1);
});

test('overlapping events multiply and are clamped; no permanent change after both expire', () => {
  const game = calm();
  const park = dev(game, 0, 0, 1, 'park');
  const shop = dev(game, 0, 5, 1, 'commercial');
  startEvent(game, 'beautification-grant'); // park ×2
  startEvent(game, 'economic-boom'); // all ×1.25
  assert.equal(incomeMultiplier(game, park), CITY_EVENTS.MAX_MULTIPLIER, '2 × 1.25 clamped to 2');
  assert.equal(incomeMultiplier(game, shop), 1.25);
  startEvent(game, 'snowstorm'); // ×0.75
  assert.equal(incomeMultiplier(game, shop), 1.25 * 0.75);

  game.round = 10;
  expireEvents(game);
  for (const b of [park, shop]) assert.equal(effectiveBlockIncome(game, b), b.income);
});

test('Heavy Rain zeroes park income; other categories unaffected', () => {
  const game = calm();
  const park = dev(game, 0, 0, 1, 'park');
  const home = dev(game, 5, 5, 1, 'residential');
  startEvent(game, 'heavy-rain');
  assert.equal(effectiveBlockIncome(game, park), 0);
  assert.equal(effectiveBlockIncome(game, home), 300);
  assert.equal(effectiveIncome(game, 1), 300);
});

test('Power Outage halves Commercial + Industrial; Recession cuts all income and costs', () => {
  const game = calm();
  const shop = dev(game, 0, 0, 1, 'commercial');
  const mill = dev(game, 0, 5, 1, 'industrial');
  const home = dev(game, 5, 5, 1, 'residential');
  startEvent(game, 'power-outage');
  assert.deepEqual([shop, mill, home].map((b) => effectiveBlockIncome(game, b)), [250, 300, 300]);
  game.events.active = [];
  startEvent(game, 'recession');
  assert.deepEqual([shop, mill, home].map((b) => effectiveBlockIncome(game, b)), [400, 480, 240]);
  assert.equal(costMultiplier(game, 'landmark'), 0.9);
});

/* ---------------- civic mitigation ---------------- */

test('civic protection shields emergencies but not boons', () => {
  const game = calm();
  dev(game, 2, 2, 1, 'civic'); // protects radius 1 (same owner)
  const shielded = dev(game, 2, 3, 1, 'commercial');
  const exposed = dev(game, 0, 5, 1, 'commercial');
  startEvent(game, 'power-outage');
  assert.equal(effectiveBlockIncome(game, shielded), 500, 'mitigated');
  assert.equal(effectiveBlockIncome(game, exposed), 250);
  const fp = eventFootprint(game, game.events.active[0]);
  assert.deepEqual(fp.mitigated, ['r2c3']);
  assert.deepEqual(fp.affected, ['r0c5']);
  assert.equal(blockImpacts(game, shielded)[0].mitigated, true);

  game.events.active = [];
  startEvent(game, 'city-festival');
  assert.equal(effectiveBlockIncome(game, shielded), 750, 'boons still apply');
});

test('building a civic mid-event protects immediately (mitigation is live, not snapshotted)', () => {
  const game = calm();
  const shop = dev(game, 0, 0, 1, 'commercial');
  startEvent(game, 'snowstorm');
  assert.equal(effectiveBlockIncome(game, shop), 375);
  dev(game, 0, 1, 1, 'civic');
  assert.equal(effectiveBlockIncome(game, shop), 500);
});

/* ---------------- fire targeting ---------------- */

test('Fire strikes ≤ max eligible blocks, ≤ 1 per owner, zeroing income for its duration', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const game = createGame({ seats: seats(), seed, eventPool: [] });
    dev(game, 0, 0, 1, 'residential'); dev(game, 0, 1, 1, 'commercial');
    dev(game, 5, 5, 2, 'industrial'); dev(game, 5, 4, 2, 'landmark');
    dev(game, 3, 3, 3, 'park'); // not eligible
    dev(game, 2, 0, 4, 'civic'); // not eligible
    const fire = startEvent(game, 'fire');
    const def = getEventDef('fire');
    assert.ok(fire.targets.length <= def.targets.max);
    const owners = fire.targets.map((id) => game.board.blocks.find((b) => b.id === id).ownerSeat);
    assert.equal(new Set(owners).size, owners.length, 'one per owner');
    for (const id of fire.targets) {
      const b = game.board.blocks.find((x) => x.id === id);
      assert.ok(def.targets.categories.includes(b.type));
      assert.equal(effectiveBlockIncome(game, b), 0);
    }
    assert.equal(fire.targets.length, 2, 'two owners have eligible blocks');
    assert.deepEqual([fire.startRound, fire.endRound], [1, 2]);
  }
  const g = calm();
  assert.deepEqual(eligibleTargets(g, getEventDef('fire')), []);
});

test('Fire targets are reproducible from the seed', () => {
  const run = (seed) => {
    const game = createGame({ seats: seats(), seed, eventPool: [] });
    for (let c = 0; c < 6; c++) dev(game, 0, c, 1 + (c % 4), 'residential');
    return startEvent(game, 'fire').targets;
  };
  assert.deepEqual(run(7), run(7));
});

/* ---------------- cost effects ---------------- */

test('cost modifiers change quotes and the amount charged, then revert', () => {
  const game = calm();
  getBlock(game.board, 0, 0).ownerSeat = 1;
  const base = TABLE.park[1].cost;
  startEvent(game, 'beautification-grant'); // park ×0.5
  const q = quoteBuild(game, 'r0c0', 'park');
  assert.deepEqual([q.cost, q.baseCost], [base / 2, base]);
  const before = getPlayer(game, 1).cash;
  const r = buildOnBlock(game, 'r0c0', 'park');
  assert.equal(r.cost, base / 2);
  assert.equal(getPlayer(game, 1).cash, before - base / 2);
  assert.equal(getBlock(game.board, 0, 0).value, getBlock(game.board, 0, 0).price + base, 'value uses list price');
  assert.deepEqual(game.ledger.at(-1).delta, -base / 2);

  game.round = 5;
  expireEvents(game);
  getBlock(game.board, 0, 1).ownerSeat = 1;
  assert.equal(quoteBuild(game, 'r0c1', 'park').cost, base);

  startEvent(game, 'housing-boom'); // residential ×1.25
  assert.equal(quoteBuild(game, 'r0c1', 'residential').cost, 1250);
});

/* ---------------- safety ---------------- */

test('events never move cash or ownership when they trigger', () => {
  const game = only('fire');
  dev(game, 0, 0, 1, 'residential');
  dev(game, 5, 5, 2, 'commercial');
  const owners = game.board.blocks.map((b) => b.ownerSeat);
  const ledgerBefore = game.ledger.length;
  const cashBefore = game.players.map((p) => p.cash);
  onRoundStart(game, game.eventPool);
  assert.deepEqual(game.board.blocks.map((b) => b.ownerSeat), owners);
  assert.equal(game.ledger.length, ledgerBefore);
  assert.deepEqual(game.players.map((p) => p.cash), cashBefore);
});

test('full random games with events: valid balances, reconciled ledger, clean expiry', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const game = createGame({ seats: seats(), seed });
    const pool = allRoadIds(game.board);
    let rng = seed;
    const rand = () => ((rng = (rng * 16807) % 2147483647) / 2147483647);
    let events = 0;
    while (game.phase === PHASES.PLAYING) {
      // The current player develops something whenever they can, to exercise events.
      const me = currentPlayer(game);
      // Resolve financial distress first (paving is blocked while in debt).
      while (me.cash < 0) {
        const st = distressStatus(game, me);
        if (st.canDeclare) { assert.equal(declareBankruptcy(game).ok, true); break; }
        const sellable = game.board.blocks.find((b) => b.ownerSeat === me.seat && b.level > 0);
        assert.equal(sellDevelopment(game, sellable.id).ok, true);
      }
      const vacant = game.board.blocks.find((b) => b.ownerSeat === me.seat && b.level === 0);
      if (vacant) buildOnBlock(game, vacant.id, ['residential', 'commercial', 'park', 'civic', 'industrial', 'landmark'][Math.floor(rand() * 6)]);
      const [id] = pool.splice(Math.floor(rand() * pool.length), 1);
      const r = placeRoad(game, id);
      if (r.event?.started) events++;
      for (const p of game.players) assert.ok(Number.isSafeInteger(p.cash), `seed ${seed} seat ${p.seat}`);
      assert.deepEqual(ownershipProblems(game), []);
      for (const e of game.events.active) {
        assert.ok(e.startRound <= game.round && e.endRound >= game.round, 'only live events are active');
      }
      assert.equal(new Set(game.events.active.map((e) => e.id)).size, game.events.active.length, 'no duplicate events');
    }
    assert.equal(events, game.round - 1, 'exactly one event per completed round');
    assert.equal(game.events.history.length, events);
    for (const p of game.players) {
      const sum = game.ledger.filter((e) => e.seat === p.seat).reduce((n, e) => n + e.delta, 0);
      assert.equal(p.cash, ECONOMY.STARTING_CASH + sum);
    }
    assert.ok(game.ledger.every((e) => Object.values(TXN).includes(e.reason)));
  }
});
