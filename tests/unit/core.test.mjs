import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BOARD_ROWS, BOARD_COLS, DEFAULT_SETTINGS, ECONOMY } from '../../js/config.js';
import { createBoard, getBlock, neighbors, districtFor, blockLabel, blocksOwnedBy } from '../../js/core/board.js';
import { CATEGORIES, CATEGORY_ORDER, levelArt, getCategory } from '../../js/core/buildings.js';
import { createGame, sanitizeName } from '../../js/core/game.js';
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

test('every development category has valid art for every level', () => {
  assert.deepEqual(Object.keys(CATEGORIES).sort(), [...CATEGORY_ORDER].sort());
  for (const type of CATEGORY_ORDER) {
    for (let level = 1; level <= 3; level++) {
      const art = levelArt(type, level);
      const [sheet, name] = art.sprite.split(':');
      assert.ok(getSpriteRect(sheet, name), `sprite for ${type} L${level}`);
      assert.ok(art.name);
    }
    assert.ok(getSpriteRect(...getCategory(type).icon.split(':')), `icon for ${type}`);
  }
  assert.equal(levelArt('vacant', 0), null);
  assert.equal(getCategory('nope'), null);
  assert.equal(getCategory('__proto__'), null);
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

test('createGame seats 2–4 players on an empty city', () => {
  const game = createGame({ seats: fourSeats });
  assert.equal(game.players.length, 4);
  assert.equal(game.round, 1);
  assert.deepEqual(Object.keys(game.board.roads), []);
  for (const p of game.players) {
    assert.equal(p.cash, ECONOMY.STARTING_CASH);
    assert.equal(blocksOwnedBy(game.board, p.seat).length, 0);
  }
  assert.throws(() => createGame({ seats: [{ seat: 1 }] }), RangeError);
  assert.throws(() => createGame({ seats: [{ seat: 1 }, { seat: 1 }] }), RangeError);
  assert.throws(() => createGame({ seats: [{ seat: 1 }, { seat: 9 }] }), RangeError);
  assert.throws(() => createGame({ seats: [{ seat: 1 }, { seat: 2 }, { seat: 3 }], gameType: 'standard' }),
    /exactly 4/);
  assert.equal(createGame({ seats: fourSeats, gameType: 'standard' }).players.length, 4);
});

test('play order is always by seat number', () => {
  const game = createGame({ seats: [{ seat: 3 }, { seat: 1 }] });
  assert.deepEqual(game.players.map((p) => p.seat), [1, 3]);
});

test('names are trimmed, capped and fall back to defaults', () => {
  assert.equal(sanitizeName('   ', 'Player 1'), 'Player 1');
  assert.equal(sanitizeName('  Ada   Lovelace ', 'x'), 'Ada Lovelace');
  assert.equal(sanitizeName('x'.repeat(40), 'y').length, 16);
});

test('settings normalize, persist, and survive broken storage', () => {
  assert.deepEqual(normalizeSettings({ sound: false, showCoords: 'yes', startingCash: 5 }), {
    ...DEFAULT_SETTINGS, sound: false,
  });
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  assert.equal(saveSettings({ ...DEFAULT_SETTINGS, confirmTaps: false }, storage), true);
  assert.equal(loadSettings(storage).confirmTaps, false);
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
