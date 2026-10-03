/**
 * Sealed-bid redevelopment auctions for pass-and-play (one shared device).
 *
 * Each person bids alone: a privacy/handoff screen comes before every bidder other than the
 * one already holding the device, their bid screen shows only their own terms (reserve,
 * increment, their cash, their largest possible bid, whether they can only pass), and a bid is
 * kept in memory, never in the page, once placed. CPU bids are computed at resolution and never
 * shown. When everyone has bid, the auction resolves through core/finance.js and the result is
 * revealed to the table: winner, price and the ownership change (or that nobody bid).
 *
 * Nothing in the game changes until resolution, so an interrupted auction (a reload, leaving
 * the game) is simply cancelled: autosave never holds a half-run auction, and no action is
 * spent. An auction everyone passes settles with no effect, so it can never leave a turn stuck.
 */
import { $, h } from './dom.js';
import { getBlockById } from '../core/board.js';
import { formatCash } from '../core/economy.js';
import { currentPlayer, getPlayer } from '../core/game.js';
import {
  auctionBidders, auctionTerms, validateAuctionBid, resolveRedevelopmentAuction, ACQUIRE_MODES, FIN_ERRORS,
} from '../core/finance.js';
import { cpuBids } from '../core/cpu/city.js';
import { isCpu } from '../core/seats.js';
import { toast } from './toast.js';

const BID_ERRORS = {
  [FIN_ERRORS.BAD_BID]: (t) => `Bid the reserve ${formatCash(t.reserve)} or more, in steps of ${formatCash(t.increment)}.`,
  [FIN_ERRORS.INSUFFICIENT_FUNDS]: (t) => `You only have ${formatCash(t.cash)}: bid at most ${formatCash(t.maxBid)}, or pass.`,
};

let auction = null; // the auction being run, or null
let onSettled = () => {};

const modeName = (mode) => (mode === ACQUIRE_MODES.RESTORE ? 'Restore' : 'Clear & rebuild');

/** True while an auction is collecting bids or showing its result. */
export const isAuctionRunning = () => auction != null;

/**
 * Starts sealed bidding on `blockId` (`mode`: restore | rebuild), opened by the current mayor.
 * `holderSeat` is the person holding the device now (the opener if human, else the last person
 * to play). `onDone(result)` runs after the result has been revealed and dismissed.
 */
export function startAuction(game, { blockId, mode, holderSeat = null, onDone = () => {} }) {
  const opener = currentPlayer(game);
  const people = auctionBidders(game, blockId).filter((p) => !isCpu(p));
  if (!people.length) {
    // Only bots can bid: settle at once with a short note, no dialog to dismiss.
    const block = getBlockById(game.board, blockId);
    const result = resolveRedevelopmentAuction(game, blockId, mode, cpuBids(game, blockId, mode));
    onSettled(result, { blockId, mode });
    toast(result.ok
      ? `${getPlayer(game, result.winnerSeat).name} wins Block ${block.label} at auction · ${formatCash(result.cost)}`
      : `No valid bids: Block ${block.label} stays abandoned`, { tone: result.ok ? 'success' : 'warn' });
    onDone(result, { holder: holderSeat });
    return;
  }
  auction = {
    game, blockId, mode, opener: opener.seat, holder: holderSeat, people: people.map((p) => p.seat),
    index: 0, bids: new Map(), result: null, onDone,
  };
  const dialog = $('#auction-dialog');
  if (!dialog.open) dialog.showModal();
  next();
}

/** Drops an auction in progress without resolving it (leaving the game, a new game, Continue). */
export function cancelAuction() {
  auction = null;
  const dialog = $('#auction-dialog');
  if (dialog?.open) dialog.close();
}

function render(...nodes) {
  const body = $('#auction-body');
  body.replaceChildren(...nodes.filter(Boolean));
  body.querySelector('[data-autofocus]')?.focus();
}

function header(eyebrow, title) {
  const a = auction;
  const block = getBlockById(a.game.board, a.blockId);
  return [
    h('p', { class: 'handoff-card__eyebrow' }, eyebrow),
    h('h3', { id: 'auction-title' }, title),
    h('p', { class: 'auction__lot' }, `Block ${block.label} · ${modeName(a.mode)} · opened by ${getPlayer(a.game, a.opener).name}`),
  ];
}

/** The next bidder (with a privacy screen first if someone else holds the device), or the end. */
function next() {
  const a = auction;
  if (!a) return;
  if (a.index >= a.people.length) return allIn();
  const seat = a.people[a.index];
  if (seat === a.holder) return bidScreen(seat);
  return handoffScreen(seat);
}

function handoffScreen(seat) {
  const a = auction;
  const bidder = getPlayer(a.game, seat);
  $('#auction-dialog').style.setProperty('--player', bidder.hex);
  render(
    ...header('Sealed bid', `Pass to ${bidder.name}`),
    h('p', {}, `Bidder ${a.index + 1} of ${a.people.length}. Bids stay secret until everyone has bid: everyone else, please look away.`),
    h('button', { type: 'button', class: 'btn btn--gold', dataset: { auctionStep: 'ready', autofocus: '' } }, `I'm ${bidder.name}: show my bid`),
  );
}

function bidScreen(seat) {
  const a = auction;
  a.holder = seat;
  const bidder = getPlayer(a.game, seat);
  const t = auctionTerms(a.game, a.blockId, a.mode, seat);
  $('#auction-dialog').style.setProperty('--player', bidder.hex);
  const canCancel = seat === a.opener && a.bids.size === 0;
  render(
    ...header('Your sealed bid', bidder.name),
    h('dl', { class: 'auction__terms' },
      h('dt', {}, 'Reserve'), h('dd', {}, formatCash(t.reserve)),
      h('dt', {}, 'Bid steps'), h('dd', {}, formatCash(t.increment)),
      h('dt', {}, 'Your cash'), h('dd', {}, formatCash(t.cash)),
      h('dt', {}, 'Your largest bid'), h('dd', {}, t.canBid ? formatCash(t.maxBid) : '—')),
    h('form', { class: 'auction__form', dataset: { auctionForm: '' }, novalidate: '' },
      h('label', { class: 'auction-bid' },
        h('span', {}, 'Bid'),
        h('input', {
          type: 'number', name: 'bid', inputmode: 'numeric', min: t.reserve, step: t.increment, max: t.maxBid ?? t.reserve,
          value: t.canBid ? t.reserve : null, disabled: t.canBid ? null : '', 'aria-describedby': 'auction-note auction-error',
          ...(t.canBid && { 'data-autofocus': '' }),
        })),
      h('p', { id: 'auction-note', class: 'auction__note' }, t.canBid
        ? 'Passing is always allowed. The highest valid bid wins; a tie goes to the lowest seat.'
        : `Your cash can't meet the ${formatCash(t.reserve)} reserve: you can only pass.`),
      h('p', { id: 'auction-error', class: 'auction__error', role: 'alert' }),
      h('div', { class: 'auction__actions' },
        t.canBid && h('button', { type: 'submit', class: 'btn btn--gold' }, 'Place sealed bid'),
        h('button', { type: 'button', class: 'btn', dataset: { auctionStep: 'pass', ...(!t.canBid && { autofocus: '' }) } }, 'Pass'),
        canCancel && h('button', { type: 'button', class: 'btn btn--sm', dataset: { auctionStep: 'cancel' } }, 'Cancel auction'))),
  );
}

function placeBid(raw) {
  const a = auction;
  const seat = a.people[a.index];
  const bid = raw === '' || raw == null ? NaN : Number(raw);
  const error = validateAuctionBid(a.game, a.blockId, a.mode, seat, bid);
  if (error) {
    const t = auctionTerms(a.game, a.blockId, a.mode, seat);
    $('#auction-error').textContent = (BID_ERRORS[error] ?? (() => 'That bid can\'t be accepted.'))(t);
    $('#auction-body [name="bid"]')?.focus();
    return;
  }
  record(seat, bid);
}

function record(seat, bid) {
  const a = auction;
  a.bids.set(seat, bid);
  a.index += 1;
  render(); // the bid leaves the page before anything else is shown
  next();
}

/** Everyone has bid: a privacy screen hides the last bid, then the result is revealed to the table. */
function allIn() {
  const a = auction;
  $('#auction-dialog').style.removeProperty('--player');
  render(
    ...header('Sealed bids', 'All bids are in'),
    h('p', {}, 'Gather round: the result is shown to everyone.'),
    h('button', { type: 'button', class: 'btn btn--gold', dataset: { auctionStep: 'reveal', autofocus: '' } }, 'Reveal the result'),
  );
}

function resolve() {
  const a = auction;
  const people = [...a.bids].map(([seat, bid]) => ({ seat, bid }));
  const bots = cpuBids(a.game, a.blockId, a.mode);
  const bidders = auctionBidders(a.game, a.blockId).length;
  const block = getBlockById(a.game.board, a.blockId);
  const result = resolveRedevelopmentAuction(a.game, a.blockId, a.mode, [...bots, ...people]);
  a.result = result;
  onSettled(result, { blockId: a.blockId, mode: a.mode });
  if (result.ok) {
    const winner = getPlayer(a.game, result.winnerSeat);
    $('#auction-dialog').style.setProperty('--player', winner.hex);
    const passes = bidders - result.bidCount;
    render(
      ...header('Auction result', `${winner.name} wins!`),
      h('p', { class: 'auction__price' }, `Price ${formatCash(result.cost)} · reserve ${formatCash(result.reserve)}`),
      h('p', {}, `Block ${block.label} now belongs to ${winner.name}${a.mode === ACQUIRE_MODES.REBUILD ? ', cleared to a vacant lot' : ', its building restored'}.`),
      h('p', { class: 'auction__note' }, [
        `${result.bidCount} valid bid${result.bidCount === 1 ? '' : 's'}${passes > 0 ? `, ${passes} pass${passes === 1 ? '' : 'es'}` : ''}.`,
        result.tied && ` Tie at ${formatCash(result.cost)}: the lowest seat wins.`,
      ].filter(Boolean).join('')),
      h('button', { type: 'button', class: 'btn btn--gold', dataset: { auctionStep: 'done', autofocus: '' } }, 'Continue'),
    );
  } else {
    render(
      ...header('Auction result', result.error === FIN_ERRORS.NO_BIDS ? 'No valid bids' : 'Auction cancelled'),
      h('p', {}, result.error === FIN_ERRORS.NO_BIDS
        ? `Block ${block.label} stays abandoned. No action was used.`
        : 'The game changed before bidding finished, so nothing happened.'),
      h('button', { type: 'button', class: 'btn btn--gold', dataset: { auctionStep: 'done', autofocus: '' } }, 'Continue'),
    );
  }
}

function finish() {
  const a = auction;
  auction = null;
  $('#auction-dialog').close();
  a?.onDone(a.result ?? { ok: false, error: 'cancelled' }, { holder: a.holder });
}

/**
 * `onResolved(result, { blockId, mode })` runs right after resolution (before the reveal is
 * dismissed): the place to autosave and redraw the board.
 */
export function initAuctionView({ onResolved = () => {} } = {}) {
  onSettled = onResolved;
  const dialog = $('#auction-dialog');
  dialog.addEventListener('click', (e) => {
    const step = e.target.closest('[data-auction-step]')?.dataset.auctionStep;
    if (!auction || !step) return;
    if (step === 'ready') bidScreen(auction.people[auction.index]);
    else if (step === 'pass') record(auction.people[auction.index], null);
    else if (step === 'reveal') resolve();
    else if (step === 'done') finish();
    else if (step === 'cancel' && auction.bids.size === 0) finish();
  });
  dialog.addEventListener('submit', (e) => {
    e.preventDefault();
    if (auction) placeBid(e.target.querySelector('[name="bid"]')?.value);
  });
  // Escape never passes for someone by accident or skips a privacy screen; on the result it continues.
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    if (auction?.result) finish();
  });
}
