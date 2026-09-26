import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createBoard, getBlock, roadId, parseRoadId, isValidRoad, roadBetweenNodes, roadNodes,
  allRoadIds, blockRoadIds, roadBlocks, builtSides, totalRoads,
} from '../../js/core/board.js';
import {
  createGame, placeRoad, currentPlayer, roadsBuilt, roadsRemaining, standings, validateRoad,
  MOVE_ERRORS, PHASES, TURN_PHASES, startPaving, resolveCapture,
} from '../../js/core/game.js';

const four = () => createGame({ seats: [1, 2, 3, 4].map((seat) => ({ seat })) });

/** Builds roads directly (no turn logic) to set up a position. */
function preset(game, ids, seat = 0) {
  for (const id of ids) game.board.roads[id] = seat;
}

const seatNow = (game) => currentPlayer(game).seat;

/* ---------------- geometry ---------------- */

test('a 6x6 city has 7x7 intersections and 84 roads', () => {
  const board = createBoard();
  const ids = allRoadIds(board);
  assert.equal(ids.length, 84);
  assert.equal(totalRoads(board), 84);
  assert.equal(new Set(ids).size, 84);
  assert.ok(ids.every((id) => isValidRoad(board, id)));
});

test('road ids validate against board bounds', () => {
  const board = createBoard();
  assert.ok(isValidRoad(board, 'h-6-5'));   // bottom edge, last segment
  assert.ok(isValidRoad(board, 'v-5-6'));   // right edge, last segment
  assert.ok(!isValidRoad(board, 'h-7-0'));
  assert.ok(!isValidRoad(board, 'h-0-6'));
  assert.ok(!isValidRoad(board, 'v-6-0'));
  assert.ok(!isValidRoad(board, 'v-0-7'));
  assert.ok(!isValidRoad(board, 'd-0-0'));
  assert.ok(!isValidRoad(board, 'h--1-0'));
  assert.ok(!isValidRoad(board, ''));
  assert.ok(!isValidRoad(board, undefined));
  assert.equal(parseRoadId('nope'), null);
});

test('roads exist only between orthogonally adjacent intersections', () => {
  const board = createBoard();
  assert.equal(roadBetweenNodes(board, { row: 0, col: 0 }, { row: 0, col: 1 }), 'h-0-0');
  assert.equal(roadBetweenNodes(board, { row: 0, col: 1 }, { row: 0, col: 0 }), 'h-0-0');
  assert.equal(roadBetweenNodes(board, { row: 3, col: 6 }, { row: 4, col: 6 }), 'v-3-6');
  assert.equal(roadBetweenNodes(board, { row: 0, col: 0 }, { row: 1, col: 1 }), null); // diagonal
  assert.equal(roadBetweenNodes(board, { row: 0, col: 0 }, { row: 0, col: 2 }), null); // too far
  assert.equal(roadBetweenNodes(board, { row: 0, col: 0 }, { row: 0, col: 0 }), null); // same node
  assert.equal(roadBetweenNodes(board, { row: 6, col: 6 }, { row: 6, col: 7 }), null); // off board
  assert.deepEqual(roadNodes('v-2-3'), [{ row: 2, col: 3 }, { row: 3, col: 3 }]);
});

test('edge roads border one block, inner roads border two', () => {
  const board = createBoard();
  assert.deepEqual(roadBlocks(board, 'h-0-0').map((b) => b.id), ['r0c0']);
  assert.deepEqual(roadBlocks(board, 'v-0-6').map((b) => b.id), ['r0c5']);
  assert.deepEqual(roadBlocks(board, 'h-6-2').map((b) => b.id), ['r5c2']);
  assert.deepEqual(roadBlocks(board, 'h-3-2').map((b) => b.id), ['r2c2', 'r3c2']);
  assert.deepEqual(roadBlocks(board, 'v-4-1').map((b) => b.id), ['r4c0', 'r4c1']);
  assert.deepEqual(blockRoadIds(getBlock(board, 0, 0)), ['h-0-0', 'h-1-0', 'v-0-0', 'v-0-1']);
});

/* ---------------- moves & validation ---------------- */

test('turn phases preserve management before paving and pass only after a committed quiet road', () => {
  const game = four();
  assert.equal(game.turnPhase, TURN_PHASES.MANAGE_CITY);
  assert.equal(startPaving(game), true);
  assert.equal(game.turnPhase, TURN_PHASES.PAVE_ROAD);
  const result = placeRoad(game, 'h-0-0');
  assert.equal(result.captured.length, 0);
  assert.equal(seatNow(game), 2);
  assert.equal(game.turnPhase, TURN_PHASES.MANAGE_CITY);
});

test('players rotate P1 → P2 → P3 → P4 → P1 on non-capturing roads', () => {
  const game = four();
  const order = [];
  for (const id of ['h-0-0', 'h-0-2', 'h-0-4', 'h-6-0', 'h-6-2']) {
    order.push(seatNow(game));
    const r = placeRoad(game, id);
    assert.equal(r.ok, true);
    assert.equal(r.extraTurn, false);
  }
  assert.deepEqual(order, [1, 2, 3, 4, 1]);
  assert.equal(game.round, 2);
  assert.equal(seatNow(game), 2);
  assert.equal(game.board.roads['h-0-0'], 1);
  assert.equal(game.board.roads['h-6-0'], 4);
});

test('rotation skips empty seats', () => {
  const game = createGame({ seats: [{ seat: 2 }, { seat: 4 }] });
  assert.equal(seatNow(game), 2);
  placeRoad(game, 'h-0-0');
  assert.equal(seatNow(game), 4);
  placeRoad(game, 'h-0-1');
  assert.equal(seatNow(game), 2);
});

test('duplicate and invalid roads are rejected without changing state', () => {
  const game = four();
  placeRoad(game, 'v-2-2');
  const before = JSON.stringify(game);
  assert.deepEqual(placeRoad(game, 'v-2-2'), { ok: false, error: MOVE_ERRORS.TAKEN });
  assert.deepEqual(placeRoad(game, 'v-9-9'), { ok: false, error: MOVE_ERRORS.INVALID });
  assert.deepEqual(placeRoad(game, '<script>'), { ok: false, error: MOVE_ERRORS.INVALID });
  assert.equal(JSON.stringify(game), before);
  assert.equal(seatNow(game), 2, 'a rejected move does not pass the turn');
});

/* ---------------- captures ---------------- */

test('corner block: the final road claims it and grants another road', () => {
  const game = four();
  preset(game, ['h-0-0', 'v-0-0', 'h-1-0']); // three sides of A1
  assert.equal(builtSides(game.board, getBlock(game.board, 0, 0)), 3);
  const r = placeRoad(game, 'v-0-1'); // P1 closes it
  assert.deepEqual(r.captured, ['r0c0']);
  assert.equal(r.extraTurn, true);
  assert.equal(getBlock(game.board, 0, 0).ownerSeat, 1);
  assert.equal(seatNow(game), 1, 'P1 moves again');
  assert.deepEqual(game.lastMove, { road: 'v-0-1', seat: 1, captured: ['r0c0'], reward: 500 });
});

test('edge block (non-corner) is claimed by whoever paves its last side', () => {
  const game = four();
  placeRoad(game, 'h-0-3'); // P1
  placeRoad(game, 'v-0-3'); // P2
  placeRoad(game, 'v-0-4'); // P3 — three sides built, no capture yet
  assert.equal(getBlock(game.board, 0, 3).ownerSeat, null);
  assert.equal(seatNow(game), 4);
  const r = placeRoad(game, 'h-1-3'); // P4 closes D1 from below
  assert.deepEqual(r.captured, ['r0c3']);
  assert.equal(getBlock(game.board, 0, 3).ownerSeat, 4);
  assert.equal(seatNow(game), 4);
});

test('the completing player claims the block even if others built the other sides', () => {
  const game = four();
  preset(game, ['h-2-2', 'h-3-2', 'v-2-2'], 3);
  placeRoad(game, 'h-0-0'); // P1 elsewhere
  const r = placeRoad(game, 'v-2-3'); // P2 finishes C3
  assert.deepEqual(r.captured, ['r2c2']);
  assert.equal(getBlock(game.board, 2, 2).ownerSeat, 2);
});

test('one road can close two blocks at once (double capture)', () => {
  const game = four();
  // B2 and C2 share v-1-2; build every other side of both.
  preset(game, ['h-1-1', 'h-2-1', 'v-1-1', 'h-1-2', 'h-2-2', 'v-1-3']);
  const r = placeRoad(game, 'v-1-2');
  assert.deepEqual(r.captured.sort(), ['r1c1', 'r1c2']);
  assert.equal(r.extraTurn, true);
  assert.equal(getBlock(game.board, 1, 1).ownerSeat, 1);
  assert.equal(getBlock(game.board, 1, 2).ownerSeat, 1);
  assert.equal(game.turnPhase, TURN_PHASES.CAPTURE_DEVELOP);
  assert.deepEqual(game.pendingCaptures, ['r1c1', 'r1c2']);
  assert.equal(resolveCapture(game, 'r1c2'), false, 'double captures resolve in board order');
  assert.equal(resolveCapture(game, 'r1c1'), true);
  assert.equal(game.turnPhase, TURN_PHASES.CAPTURE_DEVELOP);
  assert.equal(resolveCapture(game, 'r1c2'), true);
  assert.equal(game.turnPhase, TURN_PHASES.BONUS_ROAD);
});

test('chains: each capture earns another road until a road closes nothing', () => {
  const game = four();
  placeRoad(game, 'h-6-5'); // P1 elsewhere → P2 to move
  // A 3-block corridor along the top: A1, B1, C1 with only the dividers + right end open.
  preset(game, ['h-0-0', 'h-0-1', 'h-0-2', 'h-1-0', 'h-1-1', 'h-1-2', 'v-0-0']);

  const r1 = placeRoad(game, 'v-0-1'); // closes A1
  assert.deepEqual(r1.captured, ['r0c0']);
  assert.equal(seatNow(game), 2);
  const r2 = placeRoad(game, 'v-0-2'); // closes B1
  assert.deepEqual(r2.captured, ['r0c1']);
  assert.equal(seatNow(game), 2);
  const r3 = placeRoad(game, 'v-0-3'); // closes C1
  assert.deepEqual(r3.captured, ['r0c2']);
  assert.equal(seatNow(game), 2);
  const r4 = placeRoad(game, 'h-6-0'); // no capture → turn passes
  assert.deepEqual(r4.captured, []);
  assert.equal(r4.extraTurn, false);
  assert.equal(seatNow(game), 3);
  assert.equal(standings(game)[0].player.seat, 2);
  assert.equal(standings(game)[0].blocks, 3);
});

test('captured blocks are never re-claimed', () => {
  const game = four();
  preset(game, ['h-0-0', 'v-0-0', 'h-1-0']);
  placeRoad(game, 'v-0-1'); // P1 claims A1
  preset(game, ['h-0-1', 'h-1-1']);
  placeRoad(game, 'h-6-0'); // P1's bonus road, no capture → P2
  const r = placeRoad(game, 'v-0-2'); // P2 closes B1; A1 stays P1's
  assert.deepEqual(r.captured, ['r0c1']);
  assert.equal(getBlock(game.board, 0, 0).ownerSeat, 1);
  assert.equal(getBlock(game.board, 0, 1).ownerSeat, 2);
});

/* ---------------- game end ---------------- */

test('the game ends when the final block is claimed', () => {
  const game = four();
  const ids = allRoadIds(game.board);
  preset(game, ids.slice(0, -1)); // every road but the last
  game.board.blocks.slice(0, -1).forEach((b, i) => { b.ownerSeat = (i % 4) + 1; });
  assert.equal(game.phase, PHASES.PLAYING);
  assert.equal(roadsRemaining(game), 1);
  const last = ids.at(-1); // v-5-6: right edge of F6
  const r = placeRoad(game, last);
  assert.deepEqual(r.captured, ['r5c5']);
  assert.equal(r.gameEnded, true);
  assert.equal(r.extraTurn, false);
  assert.equal(game.phase, PHASES.ENDED);
  assert.equal(roadsBuilt(game), 84);
  assert.equal(validateRoad(game, 'h-0-0'), MOVE_ERRORS.GAME_OVER);
});

test('a full random game always claims all 36 blocks and conserves roads', () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let g = 0; g < 25; g++) {
    const game = four();
    const pool = allRoadIds(game.board);
    let moves = 0;
    while (game.phase === PHASES.PLAYING) {
      const i = Math.floor(rand() * pool.length);
      const [id] = pool.splice(i, 1);
      const before = seatNow(game);
      const r = placeRoad(game, id);
      assert.equal(r.ok, true);
      if (!r.gameEnded) assert.equal(seatNow(game) === before, r.captured.length > 0);
      moves++;
    }
    assert.equal(moves, 84);
    const total = standings(game).reduce((n, row) => n + row.blocks, 0);
    assert.equal(total, 36);
  }
});

test('standings rank by City Value (land counts), sharing exact ties', () => {
  const game = four();
  getBlock(game.board, 0, 0).ownerSeat = 3;
  getBlock(game.board, 0, 1).ownerSeat = 3;
  getBlock(game.board, 1, 0).ownerSeat = 1;
  getBlock(game.board, 0, 3).ownerSeat = 2; // suburbs, same value as 1,0 → tie
  const rows = standings(game);
  assert.deepEqual(rows.map((r) => [r.player.seat, r.rank]), [[3, 1], [1, 2], [2, 2], [4, 4]]);
});
