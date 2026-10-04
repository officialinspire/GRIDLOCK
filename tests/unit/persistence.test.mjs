import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createGame, placeRoad, startPaving, TURN_PHASES, PHASES } from '../../js/core/game.js';
import { chooseRoad } from '../../js/core/cpu/roads.js';
import { chooseCityAction, applyCityAction } from '../../js/core/cpu/city.js';
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

const setup = { gameType: 'standard', mode: 'standard', seats: [1, 2, 3, 4].map((seat) => ({ seat, name: `Mayor ${seat}`, controller: 'human', difficulty: null })) };

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

test('saves with impossible board, accounting, phase, or log state are rejected', () => {
  const mutations = [
    (game) => { game.board.blocks[0].row = 99; },
    (game) => { game.board.blocks[0].investedCostBasis = 1; },
    (game) => { game.board.blocks[0].income = 999999; },
    (game) => { game.board.blocks[0].marketValue = 999999; },
    (game) => { game.board.blocks[0].abandoned = true; },
    (game) => { game.turnPhase = TURN_PHASES.CAPTURE_DEVELOP; game.pendingCaptures = []; },
    (game) => { game.log.push({ type: 'road', road: 'h-99-99', seat: 1, captured: [] }); },
  ];
  for (const mutate of mutations) {
    const storage = memoryStorage();
    const game = createGame({ ...setup, seed: 7 });
    assert.equal(saveActiveGame(game, setup, storage), true);
    const raw = JSON.parse(storage.getItem(SAVE_KEY));
    mutate(raw.game);
    storage.setItem(SAVE_KEY, JSON.stringify(raw));
    assert.equal(loadActiveGame(storage), null);
  }
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

test('missing or incompatible setup metadata is reconstructed for a safe rematch', () => {
  const storage = memoryStorage();
  const game = createGame({ seats: setup.seats.slice(0, 2), seed: 42, gameType: 'custom' });
  assert.equal(saveActiveGame(game, null, storage), true);
  const raw = JSON.parse(storage.getItem(SAVE_KEY));
  raw.setup = { gameType: 'standard', seats: [] };
  storage.setItem(SAVE_KEY, JSON.stringify(raw));
  assert.deepEqual(loadActiveGame(storage).setup, {
    gameType: 'custom',
    mode: 'standard',
    seats: game.players.map(({ seat, name }) => ({ seat, name, controller: 'human', difficulty: null })),
  });
});

test('storage failures never escape persistence helpers', () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  const game = createGame({ ...setup, seed: 1 });
  assert.equal(saveActiveGame(game, setup, broken), false);
  assert.equal(loadActiveGame(broken), null);
  assert.equal(clearActiveGame(broken), false);
});

test('saves from before eras, Prestige, takeovers and recovery migrate safely and play on', async () => {
  const { createGame, placeRoad, currentPlayer, ERAS } = await import('../../js/core/game.js');
  const { saveActiveGame: save, loadActiveGame: load, SAVE_KEY: KEY } = await import('../../js/core/persistence.js');
  const storage = memoryStorage();
  const game = createGame({ seats: [{ seat: 1 }, { seat: 2 }, { seat: 3 }], seed: 8 });
  for (const id of ['h-0-0', 'h-0-1', 'h-0-2', 'h-0-3']) placeRoad(game, id);
  assert.equal(save(game, { seats: game.players.map(({ seat }) => ({ seat })) }, storage), true);
  const raw = JSON.parse(storage.getItem(KEY));
  // Strip everything added since V1.3: eras/City Actions, derived Prestige/control, shields, recovery.
  raw.version = 1;
  delete raw.game.era;
  delete raw.game.city;
  for (const b of raw.game.board.blocks) for (const k of ['prestige', 'prestigeNotes', 'control', 'shieldedUntil', 'shieldSeat']) delete b[k];
  for (const p of raw.game.players) delete p.lastBankruptcyRound;
  storage.setItem(KEY, JSON.stringify(raw));
  const back = load(storage);
  assert.ok(back, 'loads');
  assert.equal(back.game.era, ERAS.EXPANSION);
  assert.equal(back.game.city.takeovers, 0);
  assert.ok(back.game.board.blocks.every((b) => b.shieldedUntil === null && b.shieldSeat === null && Number.isInteger(b.prestige) && Number.isInteger(b.control)));
  assert.ok(back.game.players.every((p) => p.lastBankruptcyRound === null));
  const seat = currentPlayer(back.game).seat;
  assert.equal(placeRoad(back.game, 'h-0-4').ok, true, 'plays on');
  assert.notEqual(currentPlayer(back.game).seat, seat);

  // Anything that can't be made consistent is refused, never half-loaded.
  for (const corrupt of [(g) => { g.era = 'utopia'; }, (g) => { g.board.blocks[0].shieldedUntil = 'x'; }, (g) => { g.players[0].lastBankruptcyRound = 'x'; }]) {
    const bad = structuredClone(raw);
    corrupt(bad.game);
    storage.setItem(KEY, JSON.stringify(bad));
    assert.equal(load(storage), null, corrupt.toString());
  }
  storage.setItem(KEY, JSON.stringify({ ...raw, version: 99 }));
  assert.equal(load(storage), null, 'a save from a newer version is ignored');
});

// The game screen trusts saveActiveGame(): after a successful autosave it offers Continue without
// reading the save back, so every successful save must be one loadActiveGame() accepts.
test('a save that succeeds always loads back, at every step of real games', () => {
  const tables = [['standard', ['normal', 'hard', 'easy', 'normal'], 21], ['chaos', ['hard', 'normal', 'easy'], 22]];
  for (const [mode, levels, seed] of tables) {
    const game = createGame({ mode, seed, seats: levels.map((difficulty, i) => ({ seat: i + 1, controller: 'cpu', difficulty })) });
    const storage = memoryStorage();
    const eras = new Set();
    let steps = 0;
    while (game.phase === PHASES.PLAYING) {
      assert.ok(++steps < 5000, `${mode}: runaway game`);
      if (game.turnPhase === TURN_PHASES.PAVE_ROAD || game.turnPhase === TURN_PHASES.BONUS_ROAD) {
        const d = chooseRoad(game);
        if (d.road) placeRoad(game, d.road);
      } else {
        const d = chooseCityAction(game);
        if (d.action) applyCityAction(game, d);
      }
      if (game.phase !== PHASES.PLAYING) break;
      eras.add(game.era);
      assert.equal(saveActiveGame(game, null, storage), true, `${mode} step ${steps}: saved`);
      const back = loadActiveGame(storage);
      assert.ok(back, `${mode} step ${steps}: the save it just wrote loads`);
      assert.deepEqual(
        [back.game.round, back.game.turnIndex, back.game.turnPhase, back.game.log.length, back.game.players.map((pl) => pl.cash)],
        [game.round, game.turnIndex, game.turnPhase, game.log.length, game.players.map((pl) => pl.cash)],
      );
    }
    assert.deepEqual([...eras].sort(), ['city', 'expansion'], `${mode}: both eras saved`);
  }
});

test('a refused or impossible save returns false and leaves the last good save in place', () => {
  const storage = memoryStorage();
  const game = createGame({ ...setup, seed: 5 });
  assert.equal(saveActiveGame(game, setup, storage), true);
  const good = storage.getItem(SAVE_KEY);
  const broken = structuredClone(game);
  broken.round = -1;
  assert.equal(saveActiveGame(broken, setup, storage), false, 'an invalid game is refused');
  assert.equal(storage.getItem(SAVE_KEY), good, 'nothing was overwritten');
  assert.ok(loadActiveGame(storage), 'the last good save still loads');
  assert.equal(saveActiveGame(game, setup, null), false, 'no storage: nothing was saved');
});
