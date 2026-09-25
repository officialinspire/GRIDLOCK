import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BOARD_ROWS, BOARD_COLS, DEFAULT_SETTINGS } from '../../js/config.js';
import { createBoard, getBlock, neighbors, districtFor, blockLabel, blocksOwnedBy } from '../../js/core/board.js';
import { BUILDINGS, getBuilding } from '../../js/core/buildings.js';
import { formatCash, calculateIncome, BLOCK_BASE_INCOME } from '../../js/core/economy.js';
import { createGame, endTurn, currentPlayer, playerStats, PHASES, sanitizeName } from '../../js/core/game.js';
import { CITY_EVENTS, drawCityEvent } from '../../js/core/events.js';
import { normalizeSettings, loadSettings, saveSettings } from '../../js/core/settings.js';
import { EventBus } from '../../js/core/bus.js';
import { SHEETS, getSpriteRect } from '../../js/assets.js';

const fourSeats = [1, 2, 3, 4].map((seat) => ({ seat }));

test('default board is 6x6 blocks', () => {
  const board = createBoard();
  assert.equal(BOARD_ROWS, 6);
  assert.equal(BOARD_COLS, 6);
  assert.equal(board.blocks.length, 36);
  assert.equal(getBlock(board, 5, 5).id, 'r5c5');
  assert.equal(getBlock(board, 6, 0), null);
  assert.equal(blockLabel(0, 0), 'A1');
  assert.equal(blockLabel(5, 5), 'F6');
});

test('districts ring the board from suburbs to downtown', () => {
  assert.equal(districtFor(0, 3).id, 'suburbs');
  assert.equal(districtFor(1, 1).id, 'midtown');
  assert.equal(districtFor(2, 3).id, 'downtown');
  const board = createBoard();
  assert.equal(board.blocks.filter((b) => b.district === 'downtown').length, 4);
});

test('neighbors are orthogonal and clipped to the board', () => {
  const board = createBoard();
  assert.equal(neighbors(board, getBlock(board, 0, 0)).length, 2);
  assert.equal(neighbors(board, getBlock(board, 2, 2)).length, 4);
});

test('buildings have unique ids and valid sprite refs', () => {
  const ids = new Set(BUILDINGS.map((b) => b.id));
  assert.equal(ids.size, BUILDINGS.length);
  for (const b of BUILDINGS) {
    const [sheet, name] = b.sprite.split(':');
    assert.ok(getSpriteRect(sheet, name), `sprite for ${b.id}`);
  }
  assert.equal(getBuilding('nope'), null);
});

test('all sprite rects fit inside their sheets', () => {
  for (const [key, sheet] of Object.entries(SHEETS)) {
    for (const name of Object.keys(sheet.sprites)) {
      const [x, y, w, h] = getSpriteRect(key, name);
      assert.ok(x >= 0 && y >= 0 && w > 0 && h > 0, `${key}:${name}`);
      assert.ok(x + w <= sheet.w && y + h <= sheet.h, `${key}:${name} out of bounds`);
    }
  }
});

test('createGame seats 2–4 players in corners with a starter house', () => {
  const game = createGame({ seats: fourSeats });
  assert.equal(game.players.length, 4);
  assert.equal(game.round, 1);
  assert.equal(game.maxRounds, DEFAULT_SETTINGS.rounds);
  for (const p of game.players) {
    assert.equal(p.cash, DEFAULT_SETTINGS.startingCash);
    assert.equal(blocksOwnedBy(game.board, p.seat).length, 1);
  }
  assert.equal(getBlock(game.board, 0, 0).ownerSeat, 1);
  assert.equal(getBlock(game.board, 5, 0).ownerSeat, 4);
  assert.throws(() => createGame({ seats: [{ seat: 1 }] }), RangeError);
  assert.throws(() => createGame({ seats: [{ seat: 1 }, { seat: 1 }] }), RangeError);
  assert.throws(() => createGame({ seats: [{ seat: 1 }, { seat: 9 }] }), RangeError);
});

test('names are trimmed, capped and fall back to defaults', () => {
  assert.equal(sanitizeName('   ', 'Player 1'), 'Player 1');
  assert.equal(sanitizeName('  Ada   Lovelace ', 'x'), 'Ada Lovelace');
  assert.equal(sanitizeName('x'.repeat(40), 'y').length, 16);
});

test('income = base per block + building income', () => {
  const game = createGame({ seats: fourSeats });
  const expected = BLOCK_BASE_INCOME + getBuilding('house').income;
  assert.equal(calculateIncome(game.board, 1), expected);
  assert.equal(playerStats(game, game.players[0]).income, expected);
  assert.equal(formatCash(1500), '$1,500');
});

test('endTurn rotates players, pays income at round end, and finishes the game', () => {
  const game = createGame({ seats: [{ seat: 1 }, { seat: 3 }], settings: { rounds: 8, startingCash: 1000 } });
  assert.equal(currentPlayer(game).seat, 1);
  assert.deepEqual(endTurn(game), { roundEnded: false, gameEnded: false, income: null });
  assert.equal(currentPlayer(game).seat, 3);

  const r = endTurn(game);
  assert.equal(r.roundEnded, true);
  assert.equal(game.round, 2);
  assert.equal(currentPlayer(game).seat, 1);
  assert.equal(game.players[0].cash, 1000 + calculateIncome(game.board, 1));

  for (let i = 0; i < 2 * 7; i++) endTurn(game);
  assert.equal(game.phase, PHASES.ENDED);
  assert.equal(game.round, 8);
  assert.equal(endTurn(game).gameEnded, true);
});

test('city events draw deterministically from an injected rng', () => {
  assert.equal(drawCityEvent(() => 0).id, CITY_EVENTS[0].id);
  assert.equal(drawCityEvent(() => 0.9999).id, CITY_EVENTS.at(-1).id);
});

test('settings normalize, persist, and survive broken storage', () => {
  assert.deepEqual(normalizeSettings({ rounds: '16', sound: false, startingCash: 5 }), {
    ...DEFAULT_SETTINGS, rounds: 16, sound: false,
  });
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  assert.equal(saveSettings({ ...DEFAULT_SETTINGS, music: false }, storage), true);
  assert.equal(loadSettings(storage).music, false);
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.deepEqual(loadSettings(broken), DEFAULT_SETTINGS);
  assert.equal(saveSettings(DEFAULT_SETTINGS, broken), false);
});

test('event bus delivers, unsubscribes and isolates handler errors', () => {
  const bus = new EventBus();
  const seen = [];
  const off = bus.on('x', (d) => seen.push(d));
  bus.on('x', () => { throw new Error('boom'); });
  const origError = console.error;
  console.error = () => {};
  bus.emit('x', 1);
  off();
  bus.emit('x', 2);
  console.error = origError;
  assert.deepEqual(seen, [1]);
});
