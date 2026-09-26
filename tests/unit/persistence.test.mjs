import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createGame, placeRoad, startPaving, TURN_PHASES } from '../../js/core/game.js';
import { getBlock } from '../../js/core/board.js';
import { applyDevelopment } from '../../js/core/development.js';
import { startEvent, EVENT_POOL } from '../../js/core/events.js';
import {
  SAVE_KEY, SAVE_VERSION, saveActiveGame, loadActiveGame, clearActiveGame,
} from '../../js/core/persistence.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    values,
  };
}

const setup = { gameType: 'standard', seats: [1, 2, 3, 4].map((seat) => ({ seat, name: `Mayor ${seat}` })) };

test('active game save/load restores all durable game state and RNG', () => {
  const storage = memoryStorage();
  const game = createGame({ ...setup, seed: 9876 });
  startPaving(game);
  placeRoad(game, 'h-0-0');
  const block = getBlock(game.board, 0, 0);
  block.ownerSeat = 2;
  applyDevelopment(block, 'commercial', 2, { constructionCosts: [1200, 2100] });
  game.players[1].cash = 4321;
  game.players[1].bankruptcies = 1;
  startEvent(game, 'city-festival');
  game.log.push({ type: 'persistence-fixture' });

  assert.equal(saveActiveGame(game, setup, storage), true);
  const saved = loadActiveGame(storage);
  assert.equal(saved.version, SAVE_VERSION);
  assert.deepEqual(saved.setup, setup);
  assert.equal(saved.game.board.roads['h-0-0'], 1);
  assert.deepEqual(saved.game.board.blocks[0].constructionCosts, [1200, 2100]);
  assert.equal(saved.game.players[1].cash, 4321);
  assert.equal(saved.game.players[1].bankruptcies, 1);
  assert.equal(saved.game.events.active[0].id, 'city-festival');
  assert.equal(saved.game.round, game.round);
  assert.equal(saved.game.turnIndex, game.turnIndex);
  assert.equal(saved.game.turnPhase, TURN_PHASES.MANAGE_CITY);
  assert.equal(saved.game.rngState, game.rngState);
  assert.equal(saved.game.eventPool, EVENT_POOL, 'runtime definitions are reattached, not serialized');
});

test('corrupt, unsupported, and ended saves are ignored without throwing', () => {
  const storage = memoryStorage();
  for (const value of ['{broken', 'null', JSON.stringify({ version: 999, game: {} }),
    JSON.stringify({ version: SAVE_VERSION, game: { phase: 'playing' } })]) {
    storage.setItem(SAVE_KEY, value);
    assert.doesNotThrow(() => loadActiveGame(storage));
    assert.equal(loadActiveGame(storage), null);
  }
  const ended = createGame({ ...setup, seed: 1 });
  ended.phase = 'ended';
  assert.equal(saveActiveGame(ended, setup, storage), false);
});

test('version 0 prototype saves migrate and reset removes the active save', () => {
  const storage = memoryStorage();
  const game = createGame({ ...setup, seed: 42 });
  delete game.events.repairs;
  game.players.forEach((player) => { delete player.lastEconomicRound; });
  const snapshot = { ...game };
  delete snapshot.eventPool;
  storage.setItem(SAVE_KEY, JSON.stringify({ version: 0, state: snapshot, setup }));

  const migrated = loadActiveGame(storage);
  assert.equal(migrated.version, SAVE_VERSION);
  assert.deepEqual(migrated.game.events.repairs, []);
  assert.ok(migrated.game.players.every((player) => player.lastEconomicRound === game.round));
  assert.equal(clearActiveGame(storage), true);
  assert.equal(loadActiveGame(storage), null);
});

test('storage failures never escape persistence helpers', () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  const game = createGame({ ...setup, seed: 1 });
  assert.equal(saveActiveGame(game, setup, broken), false);
  assert.equal(loadActiveGame(broken), null);
  assert.equal(clearActiveGame(broken), false);
});
