/**
 * Compact Build/Upgrade panel for a block the current player owns.
 * Vacant (Level 0): choose a category or Leave Vacant.
 * Developed: upgrade one level (up to MAX_LEVEL) or keep as is.
 * All numbers come from core/development.js (which reads ECONOMY.DEVELOPMENT).
 */
import { $, h } from './dom.js';
import { createSprite } from '../assets.js';
import { ART } from '../art.js';
import { getBlockById, DISTRICTS } from '../core/board.js';
import { CATEGORY_ORDER, getCategory, levelArt, describeDevelopment } from '../core/buildings.js';
import {
  quoteBuild, quoteUpgrade, buildOnBlock, upgradeBlock, isDeveloped, MAX_LEVEL, DEV_ERRORS,
} from '../core/development.js';
import { formatCash, blockIncome, bonusIncome } from '../core/economy.js';
import { bonusList } from './bonusView.js';
import { currentPlayer, getPlayer, TURN_PHASES } from '../core/game.js';
import { toast } from './toast.js';
import {
  quoteDowngrade, quoteSale, downgradeBlock, sellDevelopment, quoteAcquire, acquireAbandoned,
  quoteRedevelopment, eligibleRedevelopers, resolveRedevelopmentAuction, ACQUIRE_MODES, FIN_ERRORS,
} from '../core/finance.js';
import { ECONOMY } from '../config.js';

let state = { game: null, blockId: null, onChange: () => {}, onLeave: () => {} };

const ERROR_TEXT = {
  [DEV_ERRORS.NOT_OWNER]: 'Only the owner can develop this block, on their turn.',
  [DEV_ERRORS.GAME_OVER]: 'The game is over.',
  [DEV_ERRORS.ALREADY_DEVELOPED]: 'This block is already developed.',
  [DEV_ERRORS.MAX_LEVEL]: 'This block is fully developed.',
  [DEV_ERRORS.UNKNOWN_TYPE]: 'Unknown building type.',
  [DEV_ERRORS.NOT_DEVELOPED]: 'Build something here first.',
  [DEV_ERRORS.NO_BLOCK]: 'That block does not exist.',
  [DEV_ERRORS.WRONG_PHASE]: 'Develop during Manage City, or immediately after capturing this block.',
};

function pips(level) {
  return h('span', { class: 'level-pips', 'aria-label': `Level ${level} of ${MAX_LEVEL}` },
    Array.from({ length: MAX_LEVEL }, (_, i) => h('span', { class: `pip${i < level ? ' is-on' : ''}` })));
}

function header(block, player) {
  const art = levelArt(block.type, block.level);
  return h('header', { class: 'build-panel__head' },
    art
      ? createSprite(art.sprite, { className: 'build-panel__art' })
      : createSprite(ART.owner.seal(player.seat), { className: 'build-panel__art build-panel__art--seal' }),
    h('div', { class: 'build-panel__titles' },
      h('h3', { id: 'build-title', class: 'build-panel__title' }, `Block ${block.label}`),
      h('p', { class: 'build-panel__sub' },
        `${DISTRICTS[block.district].label} · `,
        h('strong', { class: 'build-panel__type', dataset: { type: block.type } }, describeDevelopment(block)),
      ),
      h('p', { class: 'build-panel__stats' },
        pips(block.level),
        h('span', {}, `+${formatCash(blockIncome(block))}/turn`),
        bonusIncome(block) > 0 && h('span', { class: 'build-panel__bonus' }, `★ incl. ${formatCash(bonusIncome(block))} bonus`),
        h('span', {}, `City value ${formatCash(block.value)}`),
      ),
    ),
    h('div', { class: 'build-panel__cash' },
      h('span', {}, 'Your cash'),
      h('strong', { id: 'build-cash' }, formatCash(player.cash)),
    ),
  );
}

function priceTag(quote) {
  const changed = quote.baseCost != null && quote.baseCost !== quote.cost;
  return [
    h('span', { class: `price__cost${changed ? (quote.cost < quote.baseCost ? ' is-cheaper' : ' is-pricier') : ''}` },
      changed && h('s', { class: 'price__was' }, formatCash(quote.baseCost)), formatCash(quote.cost)),
    h('span', { class: 'price__income' }, `+${formatCash(quote.income)}/turn`),
    quote.error === DEV_ERRORS.INSUFFICIENT_FUNDS
      && h('span', { class: 'price__short' }, `Need ${formatCash(quote.shortfall)} more`),
  ];
}

function categoryOption(game, block, type) {
  const cat = getCategory(type);
  const quote = quoteBuild(game, block.id, type);
  const art = levelArt(type, 1);
  return h('button', {
    type: 'button',
    class: `build-option build-option--${type}${quote.ok ? '' : ' is-unaffordable'}`,
    dataset: { build: type },
    'aria-disabled': quote.ok ? null : 'true',
    'aria-label': `Build ${cat.label} (${art.name}) for ${formatCash(quote.cost)}, earns ${formatCash(quote.income)} per turn${quote.ok ? '' : `. Need ${formatCash(quote.shortfall)} more`}`,
  },
    createSprite(art.sprite, { className: 'build-option__art' }),
    h('span', { class: 'build-option__label' },
      createSprite(cat.icon, { className: 'build-option__icon' }), cat.label),
    h('span', { class: 'build-option__name' }, art.name),
    h('span', { class: 'build-option__price' }, priceTag(quote)),
  );
}

function vacantView(game, block, player) {
  return [
    header(block, player),
    h('p', { class: 'build-panel__hint' }, 'Vacant lots earn nothing. Choose what to build (Level 1):'),
    h('div', { class: 'build-panel__grid' }, CATEGORY_ORDER.map((type) => categoryOption(game, block, type))),
    h('div', { class: 'build-panel__actions' },
      h('button', { type: 'button', class: 'btn', dataset: { action: 'close' } },
        createSprite('icons:undo', { className: 'btn__icon' }), h('span', {}, 'Leave Vacant')),
    ),
  ];
}

function developedView(game, block, player) {
  const cat = getCategory(block.type);
  const nodes = [header(block, player), bonusList(block)];
  if (block.level >= MAX_LEVEL) {
    nodes.push(h('p', { class: 'build-panel__maxed' },
      createSprite('icons:crown', { className: 'build-panel__maxed-icon' }),
      `${cat.label} is fully developed.`));
  } else {
    const quote = quoteUpgrade(game, block.id);
    const next = levelArt(block.type, block.level + 1);
    nodes.push(h('div', { class: `upgrade-card build-option--${block.type}` },
      createSprite(next.sprite, { className: 'upgrade-card__art' }),
      h('div', { class: 'upgrade-card__info' },
        h('span', { class: 'upgrade-card__to' }, `Upgrade to Level ${block.level + 1}`),
        h('strong', { class: 'upgrade-card__name' }, next.name),
        h('span', { class: 'upgrade-card__gain' },
          `Base income ${formatCash(block.income)} → ${formatCash(quote.income)}/turn (+${formatCash(quote.incomeGain)})`),
        quote.baseCost != null && quote.baseCost !== quote.cost
          && h('span', { class: 'price__event' }, `City event price (normally ${formatCash(quote.baseCost)})`),
        quote.error === DEV_ERRORS.INSUFFICIENT_FUNDS
          && h('span', { class: 'price__short' }, `Need ${formatCash(quote.shortfall)} more`),
      ),
      h('button', {
        type: 'button',
        class: 'btn btn--gold upgrade-card__btn',
        dataset: { upgrade: block.id },
        'aria-disabled': quote.ok ? null : 'true',
      }, createSprite('icons:star', { className: 'btn__icon' }), h('span', {}, `Upgrade · ${formatCash(quote.cost)}`)),
    ));
  }
  nodes.push(sellSection(game, block));
  nodes.push(h('div', { class: 'build-panel__actions' },
    h('button', { type: 'button', class: 'btn', dataset: { action: 'close' } },
      createSprite('icons:undo', { className: 'btn__icon' }), h('span', {}, block.level >= MAX_LEVEL ? 'Close' : 'Keep as is'))));
  return nodes;
}

/** Downgrade one level / sell everything for SALE_REFUND_PERCENT of what's removed. */
function sellSection(game, block) {
  const down = quoteDowngrade(game, block.id);
  const sell = quoteSale(game, block.id);
  if (!sell.ok) return null;
  return h('details', { class: 'sell-section' },
    h('summary', {}, `Sell or downgrade (${ECONOMY.FINANCE.SALE_REFUND_PERCENT}% refund)`),
    h('div', { class: 'sell-section__actions' },
      block.level > 1 && h('button', { type: 'button', class: 'btn btn--sm', dataset: { downgrade: block.id } },
        `Downgrade to Level ${down.toLevel} · +${formatCash(down.refund)}`),
      h('button', { type: 'button', class: 'btn btn--sm btn--danger', dataset: { sell: block.id } },
        `Sell development · +${formatCash(sell.refund)}`)),
  );
}

/** Abandoned block: buy the land and restore the ruin, or clear it to rebuild. */
function abandonedView(game, block, player) {
  const former = block.abandonedBy ? getPlayer(game, block.abandonedBy) : null;
  const art = levelArt(block.type, block.level);
  const option = (mode, title, detail) => {
    const q = quoteRedevelopment(game, block.id, mode);
    const blocked = !q.ok;
    if (blocked && q.error === FIN_ERRORS.NOT_DEVELOPED) return null;
    const bidders = eligibleRedevelopers(game, block);
    return h('section', { class: 'acquire-option', dataset: { auctionMode: mode } },
      h('strong', { class: 'acquire-option__title' }, title),
      h('span', { class: 'acquire-option__detail' }, detail({ ...q, cost: q.reserve })),
      h('span', { class: 'price__cost' }, `Reserve ${formatCash(q.reserve)}`),
      ...bidders.map((bidder) => h('label', { class: 'auction-bid' },
        h('span', {}, bidder.name),
        h('input', {
          type: 'number', min: q.reserve, step: ECONOMY.FINANCE.REDEVELOPMENT.MIN_BID_INCREMENT,
          max: bidder.cash, name: `bid-${bidder.seat}`, placeholder: 'Pass',
          value: bidder.seat === player.seat && bidder.cash >= q.reserve ? q.reserve : null,
        }))),
      h('button', { type: 'button', class: 'btn btn--sm', dataset: { auction: mode } }, 'Resolve bids'),
    );
  };
  return [
    h('header', { class: 'build-panel__head' },
      art ? createSprite(art.sprite, { className: 'build-panel__art is-abandoned' }) : createSprite(ART.lot.abandoned, { className: 'build-panel__art' }),
      h('div', { class: 'build-panel__titles' },
        h('h3', { id: 'build-title', class: 'build-panel__title' }, `Block ${block.label} · Abandoned`),
        h('p', { class: 'build-panel__sub' },
          `${DISTRICTS[block.district].label} · ${describeDevelopment(block)} (inactive)`),
        former && h('p', { class: 'build-panel__stats' }, `Abandoned by ${former.name} after bankruptcy`)),
      h('div', { class: 'build-panel__cash' }, h('span', {}, 'Your cash'), h('strong', {}, formatCash(player.cash))),
    ),
    h('div', { class: 'acquire-grid' },
      option(ACQUIRE_MODES.RESTORE, `Restore ${art?.name ?? ''}`.trim(),
        (q) => `Land ${formatCash(q.land)} + ${ECONOMY.FINANCE.RESTORE_PERCENT}% repairs ${formatCash(q.restore)}. Keeps Level ${block.level}.`),
      option(ACQUIRE_MODES.REBUILD, 'Clear & rebuild',
        (q) => `Land ${formatCash(q.land)}. Starts Vacant: build any category after.`),
    ),
    h('div', { class: 'build-panel__actions' },
      h('button', { type: 'button', class: 'btn', dataset: { action: 'close' } },
        createSprite('icons:undo', { className: 'btn__icon' }), h('span', {}, 'Leave it'))),
  ];
}

function render() {
  const { game, blockId } = state;
  const block = getBlockById(game.board, blockId);
  const player = currentPlayer(game);
  let view;
  if (block.abandoned) view = abandonedView(game, block, player);
  else if (isDeveloped(block)) view = developedView(game, block, player);
  else view = vacantView(game, block, player);
  $('#build-body').replaceChildren(...view.filter(Boolean));
}

function refuse(error, shortfall) {
  const text = error === DEV_ERRORS.INSUFFICIENT_FUNDS
    ? `Not enough cash: need ${formatCash(shortfall)} more.`
    : ERROR_TEXT[error] ?? 'You can’t do that.';
  toast(text, { tone: 'warn', duration: 1800 });
}

function playerBonus() {
  const seat = currentPlayer(state.game).seat;
  return state.game.board.blocks.filter((b) => b.ownerSeat === seat).reduce((s, b) => s + bonusIncome(b), 0);
}

function handleResult(result, verb, bonusBefore) {
  if (!result.ok) {
    refuse(result.error, result.shortfall);
    render();
    return;
  }
  const block = getBlockById(state.game.board, result.block);
  toast(`${verb} ${describeDevelopment(block)} · −${formatCash(result.cost)}`, { tone: 'success' });
  $('#build-dialog').close();
  state.onChange({ ...result, bonusBefore });
}

function handleSale(result, verb) {
  if (!result.ok) {
    refuse(result.error);
    return;
  }
  toast(`${verb} · +${formatCash(result.refund)}`, { tone: 'success' });
  $('#build-dialog').close();
  state.onChange({ ...result, bonusBefore: Infinity });
}

function handleAcquire(result) {
  if (!result.ok) {
    const text = {
      [FIN_ERRORS.FORMER_OWNER]: 'You can\'t buy back a block you abandoned.',
      [FIN_ERRORS.IN_DISTRESS]: 'Clear your debt first.',
    }[result.error];
    if (text) toast(text, { tone: 'warn' });
    else refuse(result.error, result.shortfall);
    render();
    return;
  }
  toast(result.mode === 'restore' ? `Restored Block · −${formatCash(result.cost)}` : `Bought the lot · −${formatCash(result.cost)}. Build something!`, { tone: 'success' });
  const reopen = result.mode === ACQUIRE_MODES.REBUILD;
  $('#build-dialog').close();
  state.onChange({ ...result, bonusBefore: Infinity });
  if (reopen) openBuildPanel(state.game, result.block); // go straight to choosing what to build
}

function handleAuction(mode) {
  const panel = document.querySelector(`[data-auction-mode="${mode}"]`);
  const bids = [...panel.querySelectorAll('[name^="bid-"]')]
    .filter((input) => input.value !== '')
    .map((input) => ({ seat: Number(input.name.slice(4)), bid: Number(input.value) }));
  const result = resolveRedevelopmentAuction(state.game, state.blockId, mode, bids);
  if (!result.ok) {
    toast('No eligible affordable bid met the reserve.', { tone: 'warn' });
    return;
  }
  const winner = getPlayer(state.game, result.winnerSeat);
  toast(`${winner.name} wins redevelopment · ${formatCash(result.cost)}`, { tone: 'success' });
  // A cleared lot won by the player on turn goes straight to choosing what to build.
  const reopen = result.mode === ACQUIRE_MODES.REBUILD;
  $('#build-dialog').close();
  state.onChange({ ...result, bonusBefore: Infinity });
  if (reopen) openBuildPanel(state.game, result.block);
}

/** True if the current player may open the panel: their own block, or an abandoned one. */
export function canManage(game, blockId) {
  const block = game && getBlockById(game.board, blockId);
  if (!block || game.phase !== 'playing') return false;
  const legalPhase = game.turnPhase === TURN_PHASES.MANAGE_CITY
    || (game.turnPhase === TURN_PHASES.CAPTURE_DEVELOP && game.pendingCaptures[0] === block.id);
  if (!legalPhase) return false;
  return block.ownerSeat === currentPlayer(game).seat || (block.abandoned && block.ownerSeat == null);
}

export function openBuildPanel(game, blockId) {
  if (!canManage(game, blockId)) return false;
  state = { ...state, game, blockId };
  render();
  const dialog = $('#build-dialog');
  if (!dialog.open) dialog.showModal();
  dialog.querySelector('[data-build]:not([aria-disabled]), [data-upgrade]:not([aria-disabled]), [data-action="close"]')?.focus();
  return true;
}

export function closeBuildPanel() {
  const dialog = $('#build-dialog');
  if (dialog.open) dialog.close();
}

export function initBuildPanel({ onChange, onLeave = () => {} }) {
  state.onChange = onChange;
  state.onLeave = onLeave;
  const dialog = $('#build-dialog');
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) {
      dialog.close();
      return state.onLeave({ blockId: state.blockId });
    }
    const build = e.target.closest('[data-build]');
    const bonusBefore = playerBonus();
    if (build) return handleResult(buildOnBlock(state.game, state.blockId, build.dataset.build), 'Built', bonusBefore);
    if (e.target.closest('[data-upgrade]')) return handleResult(upgradeBlock(state.game, state.blockId), 'Upgraded to', bonusBefore);
    const down = e.target.closest('[data-downgrade]');
    if (down) return handleSale(downgradeBlock(state.game, down.dataset.downgrade), 'Downgraded');
    const sell = e.target.closest('[data-sell]');
    if (sell) return handleSale(sellDevelopment(state.game, sell.dataset.sell), 'Sold development');
    const acquire = e.target.closest('[data-acquire]');
    if (acquire) return handleAcquire(acquireAbandoned(state.game, state.blockId, acquire.dataset.acquire));
    const auction = e.target.closest('[data-auction]');
    if (auction) return handleAuction(auction.dataset.auction);
    if (e.target.closest('[data-action="close"]')) {
      dialog.close();
      state.onLeave({ blockId: state.blockId });
    }
  });
}
