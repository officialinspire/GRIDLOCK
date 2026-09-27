import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseRoad, defaultCpuSeed, CPU_REASONS } from '../../js/core/cpu/roads.js';
import { createGame, placeRoad, currentPlayer, resolveCapture, TURN_PHASES } from '../../js/core/game.js';
import { allRoadIds, getBlockById, builtSides } from '../../js/core/board.js';

const seats = (n) => Array.from({ length: n }, (_, i) => ({ seat: i + 1 }));
const DIFFICULTIES = ['easy', 'normal', 'hard'];

/** A fresh game with these roads paved (by seat 1) and it's seat 1's turn. */
function withRoads(roads, n = 2) {
  const game = createGame({ seats: seats(n), seed: 1, eventPool: [] });
  for (const id of roads) game.board.roads[id] = 1;
  return game;
}

/**
 * A late-game position: every road paved except `free`, every block owned except `open`
 * (those are the only blocks still in play).
 */
function endgame({ free, open, n = 2 }) {
  const game = createGame({ seats: seats(n), seed: 1, eventPool: [] });
  for (const id of allRoadIds(game.board)) if (!free.includes(id)) game.board.roads[id] = 2;
  for (const b of game.board.blocks) if (!open.includes(b.id)) b.ownerSeat = 2;
  return game;
}

/** Open blocks left on three sides after `road` is paved (what the next mayor could take). */
function handsOver(game, road) {
  const copy = structuredClone(game);
  copy.board.roads[road] = 1;
  return copy.board.blocks.filter((b) => b.ownerSeat == null && !b.abandoned && builtSides(copy.board, b) === 3).length;
}

/* ---------------- captures ---------------- */

test('every difficulty takes a capture when one is available', () => {
  // A1 (r0c0) has three sides: top, bottom, left. Its right side claims it.
  const game = withRoads(['h-0-0', 'h-1-0', 'v-0-0']);
  for (const difficulty of DIFFICULTIES) {
    for (let seed = 0; seed < 20; seed++) {
      const d = chooseRoad(game, { difficulty, seed });
      assert.equal(d.road, 'v-0-1', `${difficulty} seed ${seed}`);
      assert.equal(d.reason, CPU_REASONS.CAPTURE);
      assert.equal(d.captures, 1);
    }
  }
});

test('double captures and the chain behind a capture are counted', () => {
  // A1 and B1 both have three sides; the road between them claims both at once.
  const double = withRoads(['h-0-0', 'h-1-0', 'v-0-0', 'h-0-1', 'h-1-1', 'v-0-2']);
  for (const difficulty of ['normal', 'hard']) {
    const d = chooseRoad(double, { difficulty, seed: 3 });
    assert.equal(d.road, 'v-0-1', difficulty);
    assert.equal(d.captures, 2);
  }
  // A corridor A1–B1–C1 closed at the left: taking A1 opens B1, then C1.
  const chain = withRoads(['h-0-0', 'h-1-0', 'h-0-1', 'h-1-1', 'h-0-2', 'h-1-2', 'v-0-0', 'v-0-3']);
  const d = chooseRoad(chain, { difficulty: 'normal', seed: 1 });
  assert.equal(d.reason, CPU_REASONS.CAPTURE);
  assert.equal(d.score, 3, 'Normal sees the whole three-block run');
});

/* ---------------- safe roads ---------------- */

test('Normal and Hard never hand over a block while a safe road exists', () => {
  // Mid-game: rows 0 and 2 have every horizontal road, so many blocks sit on two sides.
  const roads = [];
  for (const r of [0, 1, 2, 3]) for (let c = 0; c < 6; c++) roads.push(`h-${r}-${c}`);
  const game = withRoads(roads);
  for (const difficulty of ['normal', 'hard']) {
    for (let seed = 0; seed < 25; seed++) {
      const d = chooseRoad(game, { difficulty, seed });
      assert.equal(d.reason, CPU_REASONS.SAFE, `${difficulty} seed ${seed}`);
      assert.equal(handsOver(game, d.road), 0, `${difficulty} seed ${seed}: ${d.road} is safe`);
    }
  }
});

test('Easy plays mostly random roads, now and then a risky one', () => {
  const roads = [];
  for (const r of [0, 1, 2, 3]) for (let c = 0; c < 6; c++) roads.push(`h-${r}-${c}`);
  const game = withRoads(roads);
  let risky = 0;
  const picked = new Set();
  const N = 300;
  for (let seed = 0; seed < N; seed++) {
    const d = chooseRoad(game, { difficulty: 'easy', seed });
    picked.add(d.road);
    if (handsOver(game, d.road)) {
      risky++;
      assert.equal(d.reason, CPU_REASONS.RISKY);
    } else assert.equal(d.reason, CPU_REASONS.RANDOM);
  }
  assert.ok(risky > 0, 'sometimes risky');
  assert.ok(risky < N / 2, `mostly not (${risky}/${N})`);
  assert.ok(picked.size > 20, 'spread over many roads');
});

/* ---------------- sacrifices, chains and double-deals ---------------- */

test('with no safe road left, the smallest giveaway is chosen', () => {
  // A single open block A1 (two free edges) and a four-block chain along row 6.
  const game = endgame({
    open: ['r0c0', 'r5c0', 'r5c1', 'r5c2', 'r5c3'],
    free: ['h-0-0', 'v-0-0', 'v-5-0', 'v-5-1', 'v-5-2', 'v-5-3', 'v-5-4'],
  });
  for (const difficulty of ['normal', 'hard']) {
    for (let seed = 0; seed < 10; seed++) {
      const d = chooseRoad(game, { difficulty, seed });
      assert.ok(['h-0-0', 'v-0-0'].includes(d.road), `${difficulty}: gives away 1 block, not the chain of 4 (${d.road})`);
      assert.equal(d.reason, CPU_REASONS.SACRIFICE);
    }
  }
});

test('Hard weighs blocks by value: it sacrifices a suburb block before a downtown one', () => {
  // A1 (suburbs, $1,000 land) and C3 (downtown, $2,000), each on two sides with two free roads.
  const game = endgame({ open: ['r0c0', 'r2c2'], free: ['h-0-0', 'v-0-0', 'h-2-2', 'v-2-2'] });
  assert.equal(getBlockById(game.board, 'r2c2').district, 'downtown');
  for (let seed = 0; seed < 10; seed++) {
    const d = chooseRoad(game, { difficulty: 'hard', seed });
    assert.ok(['h-0-0', 'v-0-0'].includes(d.road), `seed ${seed}: gives the cheap block (${d.road})`);
  }
  // Normal only counts blocks, so either sacrifice is fine to it.
  const normal = new Set(Array.from({ length: 30 }, (_, seed) => chooseRoad(game, { difficulty: 'normal', seed }).road));
  assert.ok([...normal].some((r) => ['h-2-2', 'v-2-2'].includes(r)), 'Normal is indifferent between them');
});

test('Hard double-deals: it declines the last two blocks of a chain to keep control', () => {
  // A1–B1 chain with A1 already on three sides (the opponent opened it), and a long
  // six-block chain along row 6 that whoever moves after this turn must open.
  const game = endgame({
    open: ['r0c0', 'r0c1', 'r5c0', 'r5c1', 'r5c2', 'r5c3', 'r5c4', 'r5c5'],
    free: ['v-0-1', 'v-0-2', 'v-5-0', 'v-5-1', 'v-5-2', 'v-5-3', 'v-5-4', 'v-5-5', 'v-5-6'],
  });
  const normal = chooseRoad(game, { difficulty: 'normal', seed: 1 });
  assert.equal(normal.road, 'v-0-1', 'Normal grabs the two blocks');
  assert.equal(normal.reason, CPU_REASONS.CAPTURE);

  const hard = chooseRoad(game, { difficulty: 'hard', seed: 1 });
  assert.equal(hard.road, 'v-0-2', 'Hard closes the far end, leaving a two-block domino');
  assert.equal(hard.reason, CPU_REASONS.DOUBLE_DEAL);
  assert.equal(hard.captures, 0);
  assert.ok(hard.score > 0, 'it expects to come out ahead (gives 2, gets 6)');

  // Played out with real moves: the opponent takes the domino and must open the long chain.
  const g = structuredClone(game);
  assert.ok(placeRoad(g, hard.road).ok);
  assert.equal(currentPlayer(g).seat, 2);
  const reply = placeRoad(g, 'v-0-1');
  assert.deepEqual(reply.captured.sort(), ['r0c0', 'r0c1']);
});

test('Hard takes a whole chain when giving the rest away would cost more', () => {
  // Same two-block run, but the only other structure is a single block: keep what's offered.
  const game = endgame({ open: ['r0c0', 'r0c1', 'r5c5'], free: ['v-0-1', 'v-0-2', 'h-5-5', 'v-5-5'] });
  const d = chooseRoad(game, { difficulty: 'hard', seed: 2 });
  assert.equal(d.road, 'v-0-1');
  assert.equal(d.reason, CPU_REASONS.CAPTURE);
});

/* ---------------- purity and determinism ---------------- */

test('decisions are pure and deterministic, and never touch the game RNG', () => {
  const game = createGame({ seats: seats(3), seed: 77 });
  for (const id of ['h-0-0', 'h-1-0', 'v-2-3', 'h-4-4']) game.board.roads[id] = 1;
  const before = JSON.stringify(game);
  for (const difficulty of DIFFICULTIES) {
    const a = chooseRoad(game, { difficulty, seed: 9 });
    const b = chooseRoad(game, { difficulty, seed: 9 });
    assert.deepEqual(a, b, `${difficulty}: same position + seed → same decision`);
    assert.deepEqual(chooseRoad(game, { difficulty }), chooseRoad(game, { difficulty, seed: defaultCpuSeed(game) }), 'default seed');
  }
  assert.equal(JSON.stringify(game), before, 'the game is untouched (rngState included)');
  const choices = new Set(Array.from({ length: 30 }, (_, seed) => chooseRoad(game, { difficulty: 'normal', seed }).road));
  assert.ok(choices.size > 5, 'the AI seed varies the choice between equally good roads');
});

test('asking the CPU for moves never changes the city events', () => {
  // Same seed and same moves; one game also consults every difficulty before each move.
  const play = (consult) => {
    const game = createGame({ seats: seats(4), seed: 2024, mode: 'chaos' });
    for (let i = 0; i < 40 && game.phase === 'playing'; i++) {
      if (consult) for (const difficulty of DIFFICULTIES) chooseRoad(game, { difficulty });
      const road = allRoadIds(game.board).find((id) => !(id in game.board.roads));
      assert.ok(placeRoad(game, road).ok);
    }
    return JSON.stringify({ events: game.events.history, rng: game.rngState });
  };
  assert.equal(play(true), play(false));
});

test('no decision when no road can be paved', () => {
  const game = withRoads(['h-0-0', 'h-1-0', 'v-0-0']);
  placeRoad(game, 'v-0-1'); // seat 1 captures A1 → Capture / Develop choice pending
  assert.equal(game.turnPhase, TURN_PHASES.CAPTURE_DEVELOP);
  assert.deepEqual(chooseRoad(game, { difficulty: 'hard' }), { road: null, error: 'wrong-turn-phase' });
  const broke = createGame({ seats: seats(2), seed: 1 });
  broke.players[0].cash = -50;
  assert.deepEqual(chooseRoad(broke), { road: null, error: 'in-distress' });
});

/* ---------------- whole games ---------------- */

/** CPU against CPU: every seat plays chooseRoad's road through placeRoad. */
function cpuGame(difficulties, seed) {
  const game = createGame({ seats: difficulties.map((difficulty, i) => ({ seat: i + 1, controller: 'cpu', difficulty })), seed, mode: 'classic' });
  let moves = 0;
  while (game.phase === 'playing') {
    assert.ok(++moves < 500, 'game finishes');
    // Development isn't this engine's job: captured blocks are left vacant.
    while (game.turnPhase === TURN_PHASES.CAPTURE_DEVELOP) resolveCapture(game);
    const d = chooseRoad(game);
    assert.ok(d.road, `seed ${seed}: a decision every turn`);
    const result = placeRoad(game, d.road);
    assert.ok(result.ok, `seed ${seed}: ${d.road} is legal`);
  }
  return game;
}

test('CPU mayors of every difficulty finish whole games with legal moves only', () => {
  for (const [table, seed] of [[['easy', 'normal'], 1], [['hard', 'easy', 'normal'], 2], [['normal', 'hard', 'hard', 'easy'], 3]]) {
    const game = cpuGame(table, seed);
    assert.equal(game.phase, 'ended');
    assert.equal(game.board.blocks.filter((b) => b.ownerSeat != null).length, 36, 'every block claimed');
  }
});

test('stronger difficulties capture more: Hard ≥ Normal > Easy head to head', () => {
  const duel = (a, b, games = 16) => {
    let blocksA = 0;
    let blocksB = 0;
    for (let i = 0; i < games; i++) {
      // Alternate who moves first.
      const order = i % 2 ? [b, a] : [a, b];
      const game = cpuGame(order, 100 + i);
      const owned = (seat) => game.board.blocks.filter((x) => x.ownerSeat === seat).length;
      blocksA += owned(i % 2 ? 2 : 1);
      blocksB += owned(i % 2 ? 1 : 2);
    }
    return { blocksA, blocksB };
  };
  const ne = duel('normal', 'easy');
  assert.ok(ne.blocksA > ne.blocksB * 1.5, `Normal beats Easy (${ne.blocksA} v ${ne.blocksB})`);
  const hn = duel('hard', 'normal');
  assert.ok(hn.blocksA >= hn.blocksB, `Hard at least matches Normal (${hn.blocksA} v ${hn.blocksB})`);
});
