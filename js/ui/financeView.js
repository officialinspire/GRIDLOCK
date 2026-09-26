/**
 * Financial distress + bankruptcy UI.
 * - Distress panel: debt, what selling could raise, per-block Downgrade/Sell,
 *   and Declare Bankruptcy (only when selling can't cover the debt).
 * - Bankruptcy result card: abandoned blocks, debt written off, fresh start.
 */
import { $, h } from './dom.js';
import { createSprite } from '../assets.js';
import { ECONOMY } from '../config.js';
import { blocksOwnedBy } from '../core/board.js';
import { describeDevelopment, levelArt } from '../core/buildings.js';
import { formatCash, isInDistress } from '../core/economy.js';
import { currentPlayer } from '../core/game.js';
import { isDeveloped } from '../core/development.js';
import {
  distressStatus, quoteDowngrade, quoteSale, downgradeBlock, sellDevelopment, declareBankruptcy,
} from '../core/finance.js';
import { toast } from './toast.js';

let state = { game: null, onChange: () => {} };

function saleRow(game, block) {
  const down = quoteDowngrade(game, block.id);
  const sell = quoteSale(game, block.id);
  const art = levelArt(block.type, block.level);
  return h('li', { class: 'sale-row', dataset: { block: block.id } },
    art && createSprite(art.sprite, { className: 'sale-row__art' }),
    h('span', { class: 'sale-row__info' },
      h('strong', {}, `Block ${block.label}`),
      h('span', {}, describeDevelopment(block))),
    h('span', { class: 'sale-row__actions' },
      block.level > 1 && h('button', { type: 'button', class: 'btn btn--sm', dataset: { downgrade: block.id } },
        `Downgrade +${formatCash(down.refund)}`),
      h('button', { type: 'button', class: 'btn btn--sm btn--gold', dataset: { sell: block.id } },
        `Sell +${formatCash(sell.refund)}`)),
  );
}

function distressView(game) {
  const player = currentPlayer(game);
  const st = distressStatus(game, player);
  const sellable = blocksOwnedBy(game.board, player.seat).filter(isDeveloped);
  const refundPct = ECONOMY.FINANCE.SALE_REFUND_PERCENT;
  return [
    h('header', { class: 'finance-panel__head' },
      h('span', { class: 'finance-panel__tag' }, 'Financial Distress'),
      h('h3', { id: 'finance-title', class: 'finance-panel__title' }, `${player.name} is ${formatCash(st.debt)} in debt`),
      h('p', { class: 'finance-panel__sub' },
        'Upkeep pushed your cash below $0. You can\'t pave roads or build until you\'re back to $0 or more.'),
    ),
    h('dl', { class: 'finance-panel__facts' },
      h('dt', {}, 'Cash'), h('dd', { class: 'is-negative' }, formatCash(player.cash)),
      h('dt', {}, `Selling everything raises (${refundPct}%)`), h('dd', {}, formatCash(st.liquidation)),
    ),
    sellable.length
      ? h('ul', { class: 'sale-list', 'aria-label': 'Developments you can sell' }, sellable.map((b) => saleRow(game, b)))
      : h('p', { class: 'finance-panel__none' }, 'You have no developments left to sell.'),
    h('div', { class: 'finance-panel__bankrupt' },
      st.canDeclare
        ? [
          h('p', {}, `Even selling everything can't cover the debt. Declaring bankruptcy abandons all ${blocksOwnedBy(game.board, player.seat).length} of your blocks, writes off the debt, and restarts you with ${formatCash(st.freshStart)}.`),
          h('button', { type: 'button', class: 'btn btn--danger', id: 'declare-bankruptcy' },
            createSprite('icons:restart', { className: 'btn__icon' }), h('span', {}, 'Declare Bankruptcy')),
        ]
        : h('p', { class: 'finance-panel__hint' }, 'Sell or downgrade developments to cover the debt. Bankruptcy is only possible if selling everything isn\'t enough.'),
    ),
    h('div', { class: 'build-panel__actions' },
      h('button', { type: 'button', class: 'btn', dataset: { action: 'close' } },
        createSprite('icons:map', { className: 'btn__icon' }), h('span', {}, 'View board'))),
  ];
}

function bankruptcyView(game, result) {
  const player = game.players.find((p) => p.seat === result.seat);
  return [
    h('header', { class: 'finance-panel__head' },
      h('span', { class: 'finance-panel__tag' }, 'Bankruptcy'),
      createSprite('effects:demolish', { className: 'finance-panel__art' }),
      h('h3', { id: 'finance-title', class: 'finance-panel__title' }, `${player.name} declares bankruptcy`)),
    h('ul', { class: 'finance-panel__outcome' },
      h('li', {}, `${formatCash(result.debtForgiven)} debt written off`),
      h('li', {}, `${result.abandoned.length} block${result.abandoned.length === 1 ? '' : 's'} abandoned. Roads stay, buildings go dark. Other mayors can buy and restore them.`),
      h('li', {}, result.capital > 0 ? `Fresh start: ${formatCash(result.capital)} capital` : 'No fresh-start capital left'),
    ),
    h('div', { class: 'build-panel__actions' },
      h('button', { type: 'button', class: 'btn btn--gold', dataset: { action: 'close' } },
        createSprite('icons:play', { className: 'btn__icon' }), h('span', {}, 'Continue'))),
  ];
}

function show(nodes) {
  $('#finance-body').replaceChildren(...nodes.flat().filter(Boolean));
  const dialog = $('#finance-dialog');
  if (!dialog.open) dialog.showModal();
}

export function openDistressPanel(game) {
  if (!game || !isInDistress(currentPlayer(game))) return false;
  state.game = game;
  $('#finance-dialog').dataset.mode = 'distress';
  show(distressView(game));
  $('#finance-dialog').querySelector('[data-sell], #declare-bankruptcy, [data-action="close"]')?.focus();
  return true;
}

function afterSale(result) {
  if (!result.ok) {
    toast('That sale isn\'t possible.', { tone: 'warn' });
    return;
  }
  toast(`Sold for +${formatCash(result.refund)}`, { tone: 'success' });
  state.onChange();
  if (result.recovered) {
    $('#finance-dialog').close();
    toast('Back in the black! You can play again.', { tone: 'capture' });
  } else {
    show(distressView(state.game));
  }
}

export function initFinanceView({ onChange }) {
  state.onChange = onChange;
  const dialog = $('#finance-dialog');
  dialog.addEventListener('cancel', (e) => {
    if (dialog.dataset.mode === 'bankrupt') e.preventDefault(); // make them read the result card
  });
  dialog.addEventListener('click', (e) => {
    const { game } = state;
    if (!game) return;
    const down = e.target.closest('[data-downgrade]');
    if (down) return afterSale(downgradeBlock(game, down.dataset.downgrade));
    const sell = e.target.closest('[data-sell]');
    if (sell) return afterSale(sellDevelopment(game, sell.dataset.sell));
    if (e.target.closest('#declare-bankruptcy')) {
      const result = declareBankruptcy(game);
      if (!result.ok) return toast('You can still recover by selling.', { tone: 'warn' });
      dialog.dataset.mode = 'bankrupt';
      show(bankruptcyView(game, result));
      state.onChange();
      return;
    }
    if (e.target.closest('[data-action="close"]')) dialog.close();
  });
}
