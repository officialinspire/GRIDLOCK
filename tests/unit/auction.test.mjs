/**
 * Sealed redevelopment auctions (core/finance.js): who bids and in what order, each mayor's
 * private terms, bid validation, resolution (people, CPUs, passes, ties, nobody) and the
 * guarantees the pass-and-play UI (js/ui/auctionView.js) relies on: opening and quoting change
 * nothing, an all-pass auction spends no action, so a turn can never get stuck.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ECONOMY } from '../../js/config.js';
import { getBlock, getBlockById } from '../../js/core/board.js';
import { applyDevelopment } from '../../js/core/development.js';
import { refreshBonuses } from '../../js/core/bonuses.js';
import { TXN, charge } from '../../js/core/economy.js';
import { createGame, getPlayer, startPaving, placeRoad, endCityTurn, TURN_PHASES } from '../../js/core/game.js';
import {
  auctionBidders, auctionTerms, validateAuctionBid, auctionOpenError, resolveRedevelopmentAuction, FIN_ERRORS, ACQUIRE_MODES,
} from '../../js/core/finance.js';
import { cpuBids } from '../../js/core/cpu/city.js';
import { saveActiveGame, loadActiveGame } from '../../js/core/persistence.js';

const R = ECONOMY.FINANCE.REDEVELOPMENT;
const memoryStorage = () => {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
};
const snap = (g) => JSON.stringify({ board: g.board, players: g.players, city: g.city, ledger: g.ledger, log: g.log });

/** Four mayors (`cpu` seats are Hard bots); C3 is a Corner Store ruin abandoned by seat 4. Seat 1 is on turn. */
function table({ cpu = [] } = {}) {
  const game = createGame({
    seats: [1, 2, 3, 4].map((seat) => (cpu.includes(seat) ? { seat, controller: 'cpu', difficulty: 'hard' } : { seat })),
    seed: 4, eventPool: [],
  });
  const ruin = getBlock(game.board, 2, 2);
  applyDevelopment(ruin, 'commercial', 1);
  Object.assign(ruin, { ownerSeat: null, abandoned: true, abandonedBy: 4 });
  refreshBonuses(game.board);
  return game;
}
const RESERVE = 2000 + 0.4 * 1500; // downtown land + 40% of the ruin's invested cost
const restore = (game, bids) => resolveRedevelopmentAuction(game, 'r2c2', ACQUIRE_MODES.RESTORE, bids);

/* ---------------- who bids ---------------- */

test('bidders go in turn order from the opener; former owners and mayors in debt sit out', () => {
  const game = table();
  assert.deepEqual(auctionBidders(game, 'r2c2').map((p) => p.seat), [1, 2, 3]);
  placeRoad(game, 'h-6-5'); // seat 2's turn
  assert.deepEqual(auctionBidders(game, 'r2c2').map((p) => p.seat), [2, 3, 1]);
  charge(game, getPlayer(game, 3), getPlayer(game, 3).cash + 50, TXN.UPKEEP);
  assert.deepEqual(auctionBidders(game, 'r2c2').map((p) => p.seat), [2, 1], 'in debt: no bid');
  assert.deepEqual(auctionBidders(game, 'nope'), []);
});

/* ---------------- private terms ---------------- */

test('each bidder sees only their own terms: reserve, steps, cash, largest bid, can-only-pass', () => {
  const game = table();
  getPlayer(game, 2).cash = RESERVE + 250;
  getPlayer(game, 3).cash = RESERVE - 1;
  const t1 = auctionTerms(game, 'r2c2', ACQUIRE_MODES.RESTORE, 1);
  assert.deepEqual([t1.ok, t1.reserve, t1.increment, t1.cash, t1.maxBid, t1.canBid, t1.canPass], [true, RESERVE, R.MIN_BID_INCREMENT, 12000, 12000, true, true]);
  const t2 = auctionTerms(game, 'r2c2', ACQUIRE_MODES.RESTORE, 2);
  assert.equal(t2.maxBid, RESERVE + 200, 'rounded down to a whole step above the reserve');
  const t3 = auctionTerms(game, 'r2c2', ACQUIRE_MODES.RESTORE, 3);
  assert.deepEqual([t3.canBid, t3.maxBid, t3.canPass], [false, null, true], 'can\'t meet the reserve: can only pass');
  const t4 = auctionTerms(game, 'r2c2', ACQUIRE_MODES.RESTORE, 4);
  assert.deepEqual([t4.ok, t4.error, t4.canBid], [false, FIN_ERRORS.FORMER_OWNER, false]);
  assert.equal(auctionTerms(game, 'r2c2', ACQUIRE_MODES.REBUILD, 1).reserve, 2000, 'Clear & rebuild: land only');
  assert.equal(auctionTerms(game, 'r2c2', ACQUIRE_MODES.RESTORE, 9).error, FIN_ERRORS.NOT_BIDDER);
});

test('bids are validated one at a time: passes always count, bad or unaffordable bids never do', () => {
  const game = table();
  getPlayer(game, 2).cash = RESERVE + 100;
  const v = (seat, bid) => validateAuctionBid(game, 'r2c2', ACQUIRE_MODES.RESTORE, seat, bid);
  assert.equal(v(1, null), null, 'a pass');
  assert.equal(v(3, undefined), null);
  assert.equal(v(1, RESERVE), null);
  assert.equal(v(1, RESERVE + 3 * R.MIN_BID_INCREMENT), null);
  for (const bad of [RESERVE - R.MIN_BID_INCREMENT, RESERVE + 50, RESERVE + 0.5, NaN, '3000', Infinity]) assert.equal(v(1, bad), FIN_ERRORS.BAD_BID, String(bad));
  assert.equal(v(2, RESERVE + 200), FIN_ERRORS.INSUFFICIENT_FUNDS);
  assert.equal(v(4, RESERVE), FIN_ERRORS.FORMER_OWNER);
  assert.equal(v(7, RESERVE), FIN_ERRORS.NOT_BIDDER);
});

/* ---------------- opening ---------------- */

test('opening is checked up front, and quoting/opening/validating never change the game', () => {
  const game = table();
  const before = snap(game);
  assert.equal(auctionOpenError(game, 'r2c2', ACQUIRE_MODES.RESTORE), null);
  auctionBidders(game, 'r2c2');
  auctionTerms(game, 'r2c2', ACQUIRE_MODES.RESTORE, 1);
  validateAuctionBid(game, 'r2c2', ACQUIRE_MODES.RESTORE, 1, RESERVE);
  assert.equal(snap(game), before);
  assert.equal(auctionOpenError(game, 'r0c0', ACQUIRE_MODES.RESTORE), FIN_ERRORS.NOT_ABANDONED);
  assert.equal(auctionOpenError(game, 'r2c2', 'bulldoze'), FIN_ERRORS.BAD_MODE);
  startPaving(game);
  assert.equal(auctionOpenError(game, 'r2c2', ACQUIRE_MODES.RESTORE), FIN_ERRORS.WRONG_PHASE);
  const broke = table();
  charge(broke, getPlayer(broke, 1), 12050, TXN.UPKEEP);
  assert.equal(auctionOpenError(broke, 'r2c2', ACQUIRE_MODES.RESTORE), FIN_ERRORS.IN_DISTRESS);
  const spent = table();
  spent.city.actionsLeft = 0;
  assert.equal(auctionOpenError(spent, 'r2c2', ACQUIRE_MODES.RESTORE), FIN_ERRORS.NO_ACTIONS);
  // Resolution refuses exactly what opening refuses.
  assert.equal(restore(spent, [{ seat: 2, bid: RESERVE }]).error, FIN_ERRORS.NO_ACTIONS);
});

/* ---------------- resolution ---------------- */

test('human-only: the highest sealed bid wins, pays its own bid, and only the winner pays', () => {
  const game = table();
  const r = restore(game, [{ seat: 1, bid: RESERVE + 100 }, { seat: 2, bid: RESERVE + 400 }, { seat: 3, bid: null }]);
  assert.deepEqual([r.ok, r.winnerSeat, r.cost, r.tied, r.bidCount, r.rejected], [true, 2, RESERVE + 400, false, 2, []]);
  assert.deepEqual(game.players.map((p) => p.cash), [12000, 12000 - RESERVE - 400, 12000, 12000]);
  const lot = getBlockById(game.board, 'r2c2');
  assert.deepEqual([lot.ownerSeat, lot.abandoned, lot.type, lot.level], [2, false, 'commercial', 1]);
  assert.equal(game.city.actionsLeft, 0, 'the opener\'s action');
});

test('ties go to the lowest seat (configured), and the result says so', () => {
  assert.equal(R.TIE_BREAKER, 'lowest-seat');
  const game = table();
  const r = restore(game, [{ seat: 3, bid: RESERVE + 500 }, { seat: 2, bid: RESERVE + 500 }, { seat: 1, bid: RESERVE }]);
  assert.deepEqual([r.winnerSeat, r.tied, r.bidCount], [2, true, 3]);
});

test('mixed people and CPUs: the bots\' sealed bids join the people\'s; a person can outbid a bot', () => {
  const game = table({ cpu: [3] });
  const bots = cpuBids(game, 'r2c2', ACQUIRE_MODES.RESTORE);
  assert.deepEqual(bots.map((b) => b.seat), [3]);
  const botBid = bots[0].bid;
  assert.ok(botBid >= RESERVE && (botBid - RESERVE) % R.MIN_BID_INCREMENT === 0);
  const passing = structuredClone(game);
  assert.equal(restore(passing, [...bots, { seat: 1, bid: null }, { seat: 2, bid: null }]).winnerSeat, 3, 'people pass: the bot wins');
  const r = restore(game, [...bots, { seat: 1, bid: botBid + R.MIN_BID_INCREMENT }, { seat: 2, bid: null }]);
  assert.deepEqual([r.winnerSeat, r.cost], [1, botBid + R.MIN_BID_INCREMENT]);
});

test('unaffordable, ineligible and duplicate bids are reported but never win; a lone bad bid is no bid', () => {
  const game = table();
  getPlayer(game, 3).cash = RESERVE - 1;
  const r = restore(game, [
    { seat: 4, bid: RESERVE + 900 }, // former owner
    { seat: 3, bid: RESERVE }, // can't pay
    { seat: 1, bid: RESERVE + 100 },
    { seat: 1, bid: RESERVE + 800 }, // a second bid
    { seat: 2, bid: RESERVE + 50 }, // not a whole step
  ]);
  assert.deepEqual([r.winnerSeat, r.cost], [1, RESERVE + 100]);
  assert.deepEqual(r.rejected.map((x) => [x.seat, x.error]),
    [[4, FIN_ERRORS.FORMER_OWNER], [3, FIN_ERRORS.INSUFFICIENT_FUNDS], [1, FIN_ERRORS.BAD_BID], [2, FIN_ERRORS.BAD_BID]]);
});

test('everyone passes (or nobody can pay): nothing happens, no action is spent, and the turn goes on', () => {
  const game = table();
  getPlayer(game, 3).cash = 10;
  const before = snap(game);
  const r = restore(game, [{ seat: 1, bid: null }, { seat: 2, bid: null }, { seat: 3, bid: RESERVE }]);
  assert.deepEqual([r.ok, r.error], [false, FIN_ERRORS.NO_BIDS]);
  assert.equal(snap(game), before);
  assert.equal(game.city.actionsLeft, 1);
  assert.equal(game.turnPhase, TURN_PHASES.MANAGE_CITY);
  assert.equal(auctionOpenError(game, 'r2c2', ACQUIRE_MODES.RESTORE), null, 'it can even be opened again');
  assert.equal(startPaving(game), true, 'and the mayor can always pave on');
});

/* ---------------- saving ---------------- */

test('an auction is never saved half-run: before resolution the save is untouched; after, it holds the result', () => {
  const game = table();
  const storage = memoryStorage();
  saveActiveGame(game, null, storage);
  const saved = storage.getItem('gridlock.active-game');
  // Opening, quoting and collecting bids touch nothing, so a save taken mid-auction is the save from before it.
  auctionTerms(game, 'r2c2', ACQUIRE_MODES.RESTORE, 2);
  validateAuctionBid(game, 'r2c2', ACQUIRE_MODES.RESTORE, 2, RESERVE + 300);
  saveActiveGame(game, null, storage);
  assert.equal(JSON.parse(storage.getItem('gridlock.active-game')).game.board.blocks.find((b) => b.id === 'r2c2').ownerSeat, null);
  assert.equal(JSON.stringify(JSON.parse(storage.getItem('gridlock.active-game')).game), JSON.stringify(JSON.parse(saved).game));
  restore(game, [{ seat: 2, bid: RESERVE + 300 }]);
  saveActiveGame(game, null, storage);
  const back = loadActiveGame(storage).game;
  const lot = getBlockById(back.board, 'r2c2');
  assert.deepEqual([lot.ownerSeat, lot.abandoned, lot.shieldSeat], [2, false, 2]);
  assert.equal(getPlayer(back, 2).cash, 12000 - RESERVE - 300);
  assert.equal(endCityTurn(back).ok, false, 'EXPANSION: the turn ends by paving');
});
