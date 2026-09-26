/**
 * Compact Build/Upgrade panel for a block the current player owns.
 * Vacant (Level 0): choose a category or Leave Vacant.
 * Developed: upgrade one level (up to MAX_LEVEL) or keep as is.
 * All numbers come from core/development.js (which reads ECONOMY.DEVELOPMENT).
 */
import { $, h } from './dom.js';
import { createSprite } from '../assets.js';
import { getBlockById, DISTRICTS } from '../core/board.js';
import { CATEGORY_ORDER, getCategory, levelArt, describeDevelopment } from '../core/buildings.js';
import {
  quoteBuild, quoteUpgrade, buildOnBlock, upgradeBlock, isDeveloped, MAX_LEVEL, DEV_ERRORS,
} from '../core/development.js';
import { formatCash } from '../core/economy.js';
import { currentPlayer } from '../core/game.js';
import { toast } from './toast.js';

let state = { game: null, blockId: null, onChange: () => {} };

const ERROR_TEXT = {
  [DEV_ERRORS.NOT_OWNER]: 'Only the owner can develop this block, on their turn.',
  [DEV_ERRORS.GAME_OVER]: 'The game is over.',
  [DEV_ERRORS.ALREADY_DEVELOPED]: 'This block is already developed.',
  [DEV_ERRORS.MAX_LEVEL]: 'This block is fully developed.',
  [DEV_ERRORS.UNKNOWN_TYPE]: 'Unknown building type.',
  [DEV_ERRORS.NOT_DEVELOPED]: 'Build something here first.',
  [DEV_ERRORS.NO_BLOCK]: 'That block does not exist.',
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
      : createSprite(`markers:seal-${player.color}`, { className: 'build-panel__art build-panel__art--seal' }),
    h('div', { class: 'build-panel__titles' },
      h('h3', { id: 'build-title', class: 'build-panel__title' }, `Block ${block.label}`),
      h('p', { class: 'build-panel__sub' },
        `${DISTRICTS[block.district].label} · `,
        h('strong', { class: 'build-panel__type', dataset: { type: block.type } }, describeDevelopment(block)),
      ),
      h('p', { class: 'build-panel__stats' },
        pips(block.level),
        h('span', {}, `+${formatCash(block.income)}/turn`),
        h('span', {}, `Value ${formatCash(block.value)}`),
      ),
    ),
    h('div', { class: 'build-panel__cash' },
      h('span', {}, 'Your cash'),
      h('strong', { id: 'build-cash' }, formatCash(player.cash)),
    ),
  );
}

function priceTag(quote) {
  return [
    h('span', { class: 'price__cost' }, formatCash(quote.cost)),
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
  const nodes = [header(block, player)];
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
          `Income ${formatCash(block.income)} → ${formatCash(quote.income)}/turn (+${formatCash(quote.incomeGain)})`),
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
  nodes.push(h('div', { class: 'build-panel__actions' },
    h('button', { type: 'button', class: 'btn', dataset: { action: 'close' } },
      createSprite('icons:undo', { className: 'btn__icon' }), h('span', {}, block.level >= MAX_LEVEL ? 'Close' : 'Keep as is'))));
  return nodes;
}

function render() {
  const { game, blockId } = state;
  const block = getBlockById(game.board, blockId);
  const player = currentPlayer(game);
  $('#build-body').replaceChildren(...(isDeveloped(block)
    ? developedView(game, block, player)
    : vacantView(game, block, player)).filter(Boolean));
}

function refuse(error, shortfall) {
  const text = error === DEV_ERRORS.INSUFFICIENT_FUNDS
    ? `Not enough cash: need ${formatCash(shortfall)} more.`
    : ERROR_TEXT[error] ?? 'You can’t do that.';
  toast(text, { tone: 'warn', duration: 1800 });
}

function handleResult(result, verb) {
  if (!result.ok) {
    refuse(result.error, result.shortfall);
    render();
    return;
  }
  const block = getBlockById(state.game.board, result.block);
  toast(`${verb} ${describeDevelopment(block)} · −${formatCash(result.cost)}`, { tone: 'success' });
  $('#build-dialog').close();
  state.onChange(result);
}

/** True if the current player may open the panel for this block. */
export function canManage(game, blockId) {
  const block = game && getBlockById(game.board, blockId);
  return Boolean(block && game.phase === 'playing' && block.ownerSeat === currentPlayer(game).seat);
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

export function initBuildPanel({ onChange }) {
  state.onChange = onChange;
  const dialog = $('#build-dialog');
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) return dialog.close(); // backdrop
    const build = e.target.closest('[data-build]');
    if (build) return handleResult(buildOnBlock(state.game, state.blockId, build.dataset.build), 'Built');
    if (e.target.closest('[data-upgrade]')) return handleResult(upgradeBlock(state.game, state.blockId), 'Upgraded to');
    if (e.target.closest('[data-action="close"]')) dialog.close();
  });
}
