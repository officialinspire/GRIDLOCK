/**
 * V1.4.1 core-rules hardening: finance actions enforce their turn phase and City Action cost in
 * the core (not the UI), debt recovery stays free, redeveloped/auctioned blocks are shielded
 * until their new owner's next turn is done, saves migrate to schema 2, and development-level
 * validation comes from config.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { APP_VERSION, ECONOMY } from '../../js/config.js';
import { getBlock, getBlockById, allRoadIds } from '../../js/core/board.js';
import { applyDevelopment, MAX_LEVEL, TABLE } from '../../js/core/development.js';
import { refreshBonuses } from '../../js/core/bonuses.js';
import { TXN, charge } from '../../js/core/economy.js';
import {
  createGame, currentPlayer, getPlayer, enterCityEra, endCityTurn, placeRoad, startPaving, ERAS, TURN_PHASES,
} from '../../js/core/game.js';
import {
  quoteSale, quoteDowngrade, sellDevelopment, downgradeBlock, declareBankruptcy, quoteAcquire, acquireAbandoned,
  resolveRedevelopmentAuction, quoteRedevelopment, FIN_ERRORS, ACQUIRE_MODES,
} from '../../js/core/finance.js';
import {
  quoteTakeover, takeoverBlock, isShielded, shieldOwnersTurns, shieldStatus, TAKEOVER_ERRORS,
} from '../../js/core/takeover.js';
import { blockDetails } from '../../js/core/forecast.js';
import { ACHIEVEMENTS } from '../../js/core/career.js';
import {
  SAVE_KEY, SAVE_VERSION, saveActiveGame, loadActiveGame, migrateSave,
} from '../../js/core/persistence.js';

const T = ECONOMY.TAKEOVER;
const memoryStorage = () => {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
};
const seats = (n) => Array.from({ length: n }, (_, i) => ({ seat: i + 1 }));
const at = (game, row, col) => getBlock(game.board, row, col);
const snap = (game) => JSON.stringify({ board: game.board, players: game.players, city: game.city, ledger: game.ledger, log: game.log });

/** Sets ownership/development directly: [row, col, seat, type, level]. */
function place(game, list) {
  for (const [row, col, seat, type = 'vacant', level = 0] of list) {
    const b = at(game, row, col);
    b.ownerSeat = seat;
    applyDevelopment(b, type, level);
  }
  refreshBonuses(game.board);
  return game;
}

/** `n` mayors with plenty of cash; `city` paves every road and starts the CITY era at seat 1. */
function table({ n = 4, city = false } = {}) {
  const game = createGame({ seats: seats(n), seed: 5, eventPool: [] });
  if (city) {
    for (const id of allRoadIds(game.board)) game.board.roads[id] = 1;
    assert.equal(enterCityEra(game), true);
  }
  for (const p of game.players) p.cash = 30000;
  return game;
}

/** C3 (r2c2) is an abandoned Corner Store ruin (of seat 2); seat 1's towers beside it can out-press any owner. */
function withRuin(game, formerOwner = 2) {
  place(game, [[2, 2, formerOwner, 'commercial', 1], [2, 3, 1, 'commercial', 3], [1, 2, 1, 'commercial', 3]]);
  Object.assign(at(game, 2, 2), { ownerSeat: null, abandoned: true, abandonedBy: formerOwner });
  refreshBonuses(game.board);
  return game;
}

/** Puts a player into debt through the ledger. */
const indebt = (game, seat, debt) => charge(game, getPlayer(game, seat), getPlayer(game, seat).cash + debt, TXN.UPKEEP);

/* ---------------- finance actions enforce their turn phase ---------------- */

test('EXPANSION: voluntary sales and downgrades work only in Manage City and leave state untouched otherwise', () => {
  const game = place(table(), [[0, 0, 1, 'residential', 2], [0, 1, 1]]);
  const phases = {
    [TURN_PHASES.PAVE_ROAD]: (g) => { assert.equal(startPaving(g), true); },
    [TURN_PHASES.CAPTURE_DEVELOP]: (g) => { g.turnPhase = TURN_PHASES.CAPTURE_DEVELOP; g.pendingCaptures = ['r0c1']; },
    [TURN_PHASES.BONUS_ROAD]: (g) => { g.turnPhase = TURN_PHASES.BONUS_ROAD; },
  };
  for (const [phase, enter] of Object.entries(phases)) {
    const g = structuredClone(game);
    enter(g);
    assert.equal(g.turnPhase, phase);
    const before = snap(g);
    for (const quote of [quoteSale, quoteDowngrade]) assert.equal(quote(g, 'r0c0').error, FIN_ERRORS.WRONG_PHASE, `${quote.name} in ${phase}`);
    assert.equal(sellDevelopment(g, 'r0c0').error, FIN_ERRORS.WRONG_PHASE);
    assert.equal(downgradeBlock(g, 'r0c0').error, FIN_ERRORS.WRONG_PHASE);
    assert.equal(snap(g), before, `nothing changes in ${phase}`);
  }
  assert.equal(game.turnPhase, TURN_PHASES.MANAGE_CITY);
  assert.equal(downgradeBlock(game, 'r0c0').ok, true);
  assert.equal(sellDevelopment(game, 'r0c0').error, FIN_ERRORS.NO_ACTIONS, 'one Development Action per turn');
});

test('EXPANSION: redevelopment purchases and auctions work only in Manage City', () => {
  const game = withRuin(table());
  for (const enter of [(g) => startPaving(g), (g) => { g.turnPhase = TURN_PHASES.BONUS_ROAD; }]) {
    const g = structuredClone(game);
    enter(g);
    const before = snap(g);
    assert.equal(quoteAcquire(g, 'r2c2', ACQUIRE_MODES.RESTORE).error, FIN_ERRORS.WRONG_PHASE);
    assert.equal(acquireAbandoned(g, 'r2c2', ACQUIRE_MODES.RESTORE).error, FIN_ERRORS.WRONG_PHASE);
    const reserve = quoteRedevelopment(g, 'r2c2', ACQUIRE_MODES.RESTORE).reserve;
    assert.equal(resolveRedevelopmentAuction(g, 'r2c2', ACQUIRE_MODES.RESTORE, [{ seat: 3, bid: reserve }]).error, FIN_ERRORS.WRONG_PHASE);
    assert.equal(snap(g), before);
  }
  assert.equal(acquireAbandoned(structuredClone(game), 'r2c2', ACQUIRE_MODES.RESTORE).ok, true);
});

test('CITY: the final road\'s Develop Now step is no loophole for free sales or purchases', () => {
  const game = createGame({ seats: seats(4), seed: 5, eventPool: [] });
  for (const id of allRoadIds(game.board)) if (id !== 'h-0-0') game.board.roads[id] = 2;
  place(game, [[3, 3, 1, 'commercial', 2]]);
  withRuin(game);
  const r = placeRoad(game, 'h-0-0'); // seat 1 encloses A1 with the final road
  assert.deepEqual([r.ok, r.cityEra, game.era, game.turnPhase], [true, true, ERAS.CITY, TURN_PHASES.CAPTURE_DEVELOP]);
  const before = snap(game);
  assert.equal(sellDevelopment(game, 'r3c3').error, FIN_ERRORS.WRONG_PHASE);
  assert.equal(downgradeBlock(game, 'r3c3').error, FIN_ERRORS.WRONG_PHASE);
  assert.equal(acquireAbandoned(game, 'r2c2', ACQUIRE_MODES.REBUILD).error, FIN_ERRORS.WRONG_PHASE);
  const reserve = quoteRedevelopment(game, 'r2c2', ACQUIRE_MODES.REBUILD).reserve;
  assert.equal(resolveRedevelopmentAuction(game, 'r2c2', ACQUIRE_MODES.REBUILD, [{ seat: 1, bid: reserve }]).error, FIN_ERRORS.WRONG_PHASE);
  assert.equal(snap(game), before);
});

/* ---------------- City Actions ---------------- */

test('CITY: each voluntary sale, downgrade, purchase and auction costs one City Action', () => {
  const game = withRuin(place(table({ city: true }), [[0, 0, 1, 'residential', 3], [5, 5, 1, 'park', 1]]), 4);
  const actions = () => game.city.actionsLeft;
  assert.equal(actions(), 2);
  assert.equal(downgradeBlock(game, 'r0c0').ok, true);
  assert.equal(actions(), 1);
  assert.equal(sellDevelopment(game, 'r5c5').ok, true);
  assert.equal(actions(), 0);
  // Out of actions: every voluntary finance action is refused, with no side effects.
  const before = snap(game);
  assert.equal(sellDevelopment(game, 'r0c0').error, FIN_ERRORS.NO_ACTIONS);
  assert.equal(downgradeBlock(game, 'r0c0').error, FIN_ERRORS.NO_ACTIONS);
  assert.equal(acquireAbandoned(game, 'r2c2', ACQUIRE_MODES.RESTORE).error, FIN_ERRORS.NO_ACTIONS);
  const reserve = quoteRedevelopment(game, 'r2c2', ACQUIRE_MODES.RESTORE).reserve;
  assert.equal(resolveRedevelopmentAuction(game, 'r2c2', ACQUIRE_MODES.RESTORE, [{ seat: 3, bid: reserve }]).error, FIN_ERRORS.NO_ACTIONS);
  assert.equal(snap(game), before);

  // Next turn: a purchase costs one, and an auction costs the opener one even when a rival wins.
  assert.ok(endCityTurn(game).ok);
  const buyer = structuredClone(game);
  assert.equal(acquireAbandoned(buyer, 'r2c2', ACQUIRE_MODES.RESTORE).ok, true);
  assert.equal(buyer.city.actionsLeft, 1);
  const won = resolveRedevelopmentAuction(game, 'r2c2', ACQUIRE_MODES.RESTORE, [{ seat: 3, bid: reserve }]);
  assert.deepEqual([won.ok, won.winnerSeat, game.city.actionsLeft], [true, 3, 1]);
});

test('EXPANSION: a voluntary sale or a redevelopment purchase spends the turn\'s Development Action', () => {
  const sale = withRuin(place(table(), [[0, 0, 1, 'residential', 2]]));
  assert.equal(sale.city.actionsLeft, 1);
  assert.equal(downgradeBlock(sale, 'r0c0').ok, true);
  assert.equal(sale.city.actionsLeft, 0);
  assert.equal(acquireAbandoned(sale, 'r2c2', ACQUIRE_MODES.RESTORE).error, FIN_ERRORS.NO_ACTIONS);
  const buy = withRuin(place(table(), [[0, 0, 1, 'residential', 2]]));
  assert.equal(acquireAbandoned(buy, 'r2c2', ACQUIRE_MODES.RESTORE).ok, true);
  assert.deepEqual([buy.city.actionsLeft, downgradeBlock(buy, 'r0c0').error], [0, FIN_ERRORS.NO_ACTIONS]);
  assert.equal(buy.city.actionsPerTurn, 2, 'the City budget itself is untouched');
});

/* ---------------- debt recovery stays free ---------------- */

test('CITY: selling to clear debt is free (even with no City Actions left); the next voluntary sale is not', () => {
  const game = place(table({ city: true }), [[0, 0, 1, 'residential', 3], [0, 1, 1, 'commercial', 2]]);
  game.city.actionsLeft = 0;
  indebt(game, 1, 100);
  assert.equal(quoteDowngrade(game, 'r0c0').ok, true);
  const sale = downgradeBlock(game, 'r0c0');
  assert.deepEqual([sale.ok, sale.recovered, game.city.actionsLeft], [true, true, 0]);
  assert.equal(sellDevelopment(game, 'r0c1').error, FIN_ERRORS.NO_ACTIONS, 'solvent again: voluntary');

  // With actions left, a debt sale still doesn't spend one.
  const g2 = place(table({ city: true }), [[0, 0, 1, 'residential', 3]]);
  indebt(g2, 1, 100);
  assert.equal(sellDevelopment(g2, 'r0c0').ok, true);
  assert.equal(g2.city.actionsLeft, g2.city.actionsPerTurn);
});

test('debt recovery is never phase-gated, so a mayor in debt can always dig out', () => {
  const game = place(table(), [[0, 0, 1, 'residential', 3]]);
  indebt(game, 1, 100);
  game.turnPhase = TURN_PHASES.BONUS_ROAD; // not reachable in play; the rule must not soft-lock it
  assert.equal(downgradeBlock(game, 'r0c0').ok, true);
});

test('bankruptcy is free: allowed with no City Actions left, and spends none', () => {
  for (const left of [0, 2]) {
    const game = place(table({ city: true }), [[0, 0, 1, 'park', 1]]);
    game.city.actionsLeft = left;
    indebt(game, 1, 9000);
    const r = declareBankruptcy(game);
    assert.equal(r.ok, true);
    assert.equal(game.city.actionsLeft, left);
  }
});

test('opening an auction waits until the opener\'s debt is cleared', () => {
  const game = withRuin(place(table({ city: true }), [[0, 0, 1, 'residential', 3]]));
  indebt(game, 1, 100);
  const reserve = quoteRedevelopment(game, 'r2c2', ACQUIRE_MODES.RESTORE).reserve;
  const before = snap(game);
  assert.equal(resolveRedevelopmentAuction(game, 'r2c2', ACQUIRE_MODES.RESTORE, [{ seat: 3, bid: reserve }]).error, FIN_ERRORS.IN_DISTRESS);
  assert.equal(snap(game), before);
});

/* ---------------- takeover protection after redevelopment ---------------- */

test('a block bought out of abandonment is shielded for one full round: until the buyer\'s next turn is done', () => {
  const game = withRuin(table({ n: 3, city: true }));
  endCityTurn(game);
  endCityTurn(game); // → seat 3, round 1
  const bought = acquireAbandoned(game, 'r2c2', ACQUIRE_MODES.RESTORE);
  const store = getBlockById(game.board, 'r2c2');
  assert.deepEqual([bought.ok, store.ownerSeat, store.shieldedUntil, store.shieldSeat], [true, 3, game.round + 1, 3]);
  assert.equal(bought.shieldedUntil, store.shieldedUntil);
  endCityTurn(game); // → seat 1, round 2
  const q = quoteTakeover(game, 'r2c2');
  assert.ok(q.pressure > q.control, 'only the shield stands in the way');
  assert.equal(q.error, TAKEOVER_ERRORS.SHIELDED);
  endCityTurn(game); // → seat 2
  assert.equal(isShielded(game, store), true);
  endCityTurn(game); // → seat 3: the owner's next turn
  assert.equal(isShielded(game, store), true);
  endCityTurn(game); // → seat 1, round 3: seat 3 has completed its next turn
  assert.equal(isShielded(game, store), false);
  assert.equal(takeoverBlock(game, 'r2c2').ok, true);
});

test('an auction won by a later seat shields the block until that winner finishes their next turn', () => {
  const game = withRuin(table({ city: true }));
  const { reserve } = quoteRedevelopment(game, 'r2c2', ACQUIRE_MODES.RESTORE);
  const r = resolveRedevelopmentAuction(game, 'r2c2', ACQUIRE_MODES.RESTORE, [{ seat: 3, bid: reserve }]);
  const store = getBlockById(game.board, 'r2c2');
  assert.deepEqual([r.ok, store.ownerSeat, store.shieldedUntil, store.shieldSeat], [true, 3, game.round, 3]);
  // The opener can't snipe the block it just auctioned off.
  assert.equal(quoteTakeover(game, 'r2c2').error, TAKEOVER_ERRORS.SHIELDED);
  endCityTurn(game); // → seat 2
  assert.equal(isShielded(game, store), true);
  endCityTurn(game); // → seat 3 (owner)
  endCityTurn(game); // → seat 4: seat 3's turn is done
  assert.equal(isShielded(game, store), false);
  endCityTurn(game); // → seat 1, next round
  assert.equal(quoteTakeover(game, 'r2c2').ok, true);
});

test('an auction won by an earlier seat shields the block until that winner\'s turn next round', () => {
  const game = withRuin(table({ city: true }));
  place(game, [[2, 3, 3, 'commercial', 3], [1, 2, 3, 'commercial', 3]]); // seat 3's towers now
  endCityTurn(game);
  endCityTurn(game); // → seat 3
  const { reserve } = quoteRedevelopment(game, 'r2c2', ACQUIRE_MODES.RESTORE);
  const round = game.round;
  assert.equal(resolveRedevelopmentAuction(game, 'r2c2', ACQUIRE_MODES.RESTORE, [{ seat: 1, bid: reserve }]).ok, true);
  const store = getBlockById(game.board, 'r2c2');
  assert.deepEqual([store.ownerSeat, store.shieldedUntil, store.shieldSeat], [1, round + 1, 1]);
  assert.equal(quoteTakeover(game, 'r2c2').error, TAKEOVER_ERRORS.SHIELDED);
  endCityTurn(game); // → seat 4
  endCityTurn(game); // → seat 1 (owner), next round
  assert.equal(isShielded(game, store), true);
  endCityTurn(game); // → seat 2
  assert.equal(isShielded(game, store), false);
  endCityTurn(game); // → seat 3
  assert.equal(quoteTakeover(game, 'r2c2').ok, true);
});

test('the redevelopment shield length comes from TAKEOVER.ACQUIRE_SHIELD_TURNS; takeover shields keep whole rounds', () => {
  assert.equal(T.ACQUIRE_SHIELD_TURNS, 1);
  const game = table({ city: true });
  const block = at(game, 0, 0);
  shieldOwnersTurns(game, block, 1, 2); // seat 1 is on turn: its next two turns are rounds 2 and 3
  assert.deepEqual([block.shieldedUntil, block.shieldSeat], [game.round + 2, 1]);
  shieldOwnersTurns(game, block, 2, 2); // seat 2 sits later: rounds 1 and 2
  assert.deepEqual([block.shieldedUntil, block.shieldSeat], [game.round + 1, 2]);
  shieldOwnersTurns(game, block, 2, 0);
  assert.deepEqual([block.shieldedUntil, block.shieldSeat, isShielded(game, block)], [null, null, false]);

  // A hostile takeover still shields through SHIELD_ROUNDS whole rounds (no shield seat).
  const duel = place(table({ n: 2, city: true }), [[2, 2, 2, 'residential', 1], [2, 3, 1, 'commercial', 2], [1, 2, 1, 'commercial', 1]]);
  assert.equal(takeoverBlock(duel, 'r2c2').ok, true);
  const house = at(duel, 2, 2);
  assert.deepEqual([house.shieldedUntil, house.shieldSeat], [duel.round + T.SHIELD_ROUNDS, null]);
  endCityTurn(duel);
  endCityTurn(duel); // seat 1, next round, after its own turn passed
  endCityTurn(duel); // seat 2, still within the shield round
  assert.equal(isShielded(duel, house), true);
});

test('bankruptcy clears a shield; the inspector reports who the shield waits for', () => {
  const game = withRuin(table({ city: true }));
  const { reserve } = quoteRedevelopment(game, 'r2c2', ACQUIRE_MODES.RESTORE);
  resolveRedevelopmentAuction(game, 'r2c2', ACQUIRE_MODES.RESTORE, [{ seat: 3, bid: reserve }]);
  assert.deepEqual(blockDetails(game, 'r2c2').shield, { untilRound: game.round, seat: 3 });
  assert.deepEqual(shieldStatus(game, at(game, 2, 2)), { untilRound: game.round, seat: 3 });
  assert.equal(blockDetails(game, 'r0c0').shield, null);

  endCityTurn(game);
  endCityTurn(game); // → seat 3, the new owner, now drowning in debt
  indebt(game, 3, 90000);
  assert.equal(declareBankruptcy(game).ok, true);
  const ruin = at(game, 2, 2);
  assert.deepEqual([ruin.abandoned, ruin.shieldedUntil, ruin.shieldSeat], [true, null, null]);
});

/* ---------------- saves: schema 2+ and migration ---------------- */

test('saves are the current schema, record the app version, and keep turn-precise shields', () => {
  assert.equal(SAVE_VERSION, 3);
  const game = withRuin(table({ city: true }));
  const { reserve } = quoteRedevelopment(game, 'r2c2', ACQUIRE_MODES.RESTORE);
  resolveRedevelopmentAuction(game, 'r2c2', ACQUIRE_MODES.RESTORE, [{ seat: 3, bid: reserve }]);
  const storage = memoryStorage();
  assert.equal(saveActiveGame(game, null, storage), true);
  const raw = JSON.parse(storage.getItem(SAVE_KEY));
  assert.deepEqual([raw.version, raw.appVersion], [SAVE_VERSION, APP_VERSION]);
  const back = loadActiveGame(storage).game;
  const store = getBlockById(back.board, 'r2c2');
  assert.deepEqual([store.shieldedUntil, store.shieldSeat], [game.round, 3]);
  assert.equal(quoteTakeover(back, 'r2c2').error, TAKEOVER_ERRORS.SHIELDED);
  endCityTurn(back);
  endCityTurn(back);
  endCityTurn(back);
  assert.equal(isShielded(back, store), false, 'the shield still ends after the owner\'s turn');
});

test('V1.4.0 (schema 1) saves migrate to the current schema with their state and takeover shields unchanged', () => {
  const game = place(table({ n: 2, city: true }), [[2, 2, 2, 'residential', 1], [2, 3, 1, 'commercial', 2], [1, 2, 1, 'commercial', 1]]);
  assert.equal(takeoverBlock(game, 'r2c2').ok, true);
  const storage = memoryStorage();
  saveActiveGame(game, null, storage);
  const v1 = JSON.parse(storage.getItem(SAVE_KEY));
  v1.version = 1;
  delete v1.appVersion;
  for (const b of v1.game.board.blocks) delete b.shieldSeat;
  storage.setItem(SAVE_KEY, JSON.stringify(v1));

  const loaded = loadActiveGame(storage);
  assert.equal(loaded.version, SAVE_VERSION);
  assert.ok(loaded.game.board.blocks.every((b) => b.shieldSeat === null));
  // Everything else is exactly as saved.
  const strip = (g) => JSON.stringify({ ...g, eventPool: undefined, board: { ...g.board, blocks: g.board.blocks.map(({ shieldSeat, ...b }) => b) } });
  assert.equal(strip(loaded.game), strip(v1.game));
  // The V1.4.0 takeover shield still lasts the whole round.
  const house = getBlockById(loaded.game.board, 'r2c2');
  assert.equal(house.shieldedUntil, game.round + T.SHIELD_ROUNDS);
  endCityTurn(loaded.game);
  endCityTurn(loaded.game);
  endCityTurn(loaded.game);
  assert.equal(isShielded(loaded.game, house), true);
});

test('migrateSave walks 0 → 1 → 2 → 3 and refuses unknown or malformed versions', () => {
  const game = createGame({ seats: seats(4), seed: 2 });
  const state = JSON.parse(JSON.stringify({ ...game, eventPool: undefined }));
  delete state.events.repairs;
  for (const b of state.board.blocks) delete b.shieldSeat;
  const migrated = migrateSave({ version: 0, state, setup: null });
  assert.equal(migrated.version, SAVE_VERSION);
  assert.deepEqual(migrated.game.events.repairs, []);
  assert.ok(migrated.game.board.blocks.every((b) => b.shieldSeat === null));
  for (const raw of [null, 'x', [], {}, { version: SAVE_VERSION + 1, game: {} }, { version: '1', game: {} }, { version: 0 }, { version: 1 }, { version: -1, game: {} }]) {
    assert.equal(migrateSave(raw), null, JSON.stringify(raw));
  }
});

test('corrupt shield seats are refused, never half-loaded', () => {
  const game = withRuin(table({ city: true }));
  const storage = memoryStorage();
  saveActiveGame(game, null, storage);
  const raw = JSON.parse(storage.getItem(SAVE_KEY));
  for (const corrupt of [
    (g) => { g.board.blocks[0].shieldSeat = 9; g.board.blocks[0].shieldedUntil = 2; }, // no such seat
    (g) => { g.board.blocks[0].shieldSeat = 'p1'; g.board.blocks[0].shieldedUntil = 2; },
    (g) => { g.board.blocks[0].shieldSeat = 1; g.board.blocks[0].shieldedUntil = null; }, // seat without a round
  ]) {
    const bad = structuredClone(raw);
    corrupt(bad.game);
    storage.setItem(SAVE_KEY, JSON.stringify(bad));
    assert.equal(loadActiveGame(storage), null, corrupt.toString());
  }
});

/* ---------------- config-derived development limits ---------------- */

test('save validation takes development levels and accounting from config, not hardcoded numbers', async () => {
  const storage = memoryStorage();
  const game = place(table(), [[0, 0, 1, 'landmark', MAX_LEVEL]]);
  assert.equal(saveActiveGame(game, null, storage), true);
  assert.ok(loadActiveGame(storage), `Level ${MAX_LEVEL} (MAX_LEVEL) loads`);

  const raw = JSON.parse(storage.getItem(SAVE_KEY));
  const over = structuredClone(raw);
  const b = over.game.board.blocks[0];
  // One level past MAX_LEVEL, with otherwise self-consistent accounting.
  const extra = TABLE.landmark[MAX_LEVEL].cost;
  Object.assign(b, {
    level: MAX_LEVEL + 1, constructionCosts: [...b.constructionCosts, extra],
    investedCostBasis: b.investedCostBasis + extra, value: b.value + extra, marketValue: b.marketValue + extra,
  });
  storage.setItem(SAVE_KEY, JSON.stringify(over));
  assert.equal(loadActiveGame(storage), null, 'past MAX_LEVEL is refused');

  const wrongIncome = structuredClone(raw);
  wrongIncome.game.board.blocks[0].income = TABLE.landmark[MAX_LEVEL].income + 1;
  storage.setItem(SAVE_KEY, JSON.stringify(wrongIncome));
  assert.equal(loadActiveGame(storage), null, 'income must match the config table');

  // A malformed block is refused without throwing, on save and on load.
  const broken = table();
  broken.board.blocks[0] = null;
  assert.equal(saveActiveGame(broken, null, storage), false);
  const nullBlock = structuredClone(raw);
  nullBlock.game.board.blocks[0] = null;
  storage.setItem(SAVE_KEY, JSON.stringify(nullBlock));
  assert.equal(loadActiveGame(storage), null);

  const source = await readFile(new URL('../../js/core/persistence.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /level\s*[<>]=?\s*[1-9]/, 'no hardcoded level limit');
});

test('level achievements name the configured top level', () => {
  const skyline = ACHIEVEMENTS.find((a) => a.id === 'skyline');
  assert.match(skyline.text, new RegExp(`Level ${MAX_LEVEL}\\b`));
  assert.equal(skyline.test({ maxLevel: MAX_LEVEL }), true);
  assert.equal(skyline.test({ maxLevel: MAX_LEVEL - 1 }), false);
  assert.match(ACHIEVEMENTS.find((a) => a.id === 'heavy-industry').text, new RegExp(`Level ${MAX_LEVEL} Industrial`));
});

/* ---------------- version ---------------- */

test('the app, package and title screen all say V1.5.0', async () => {
  assert.equal(APP_VERSION, '1.5.0');
  const read = async (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
  const pkg = JSON.parse(await read('package.json'));
  const lock = JSON.parse(await read('package-lock.json'));
  assert.equal(pkg.version, APP_VERSION);
  assert.equal(lock.version, APP_VERSION);
  assert.equal(lock.packages[''].version, APP_VERSION);
  assert.match(await read('index.html'), new RegExp(`class="title-note__ver">v${APP_VERSION.replaceAll('.', '\\.')}<`));
});
