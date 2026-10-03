/**
 * Compact Build/Upgrade panel for a block the current player owns.
 * Vacant (Level 0): choose a category or Leave Vacant.
 * Developed: upgrade one level (up to MAX_LEVEL) or keep as is.
 * Also: abandoned blocks (redevelopment) and, in the City era, rival blocks (takeover).
 * Every option shows its category's strategic effects (core/strategy.js) and Prestige change.
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
import { formatCash, formatDelta, blockIncome, bonusIncome } from '../core/economy.js';
import { bonusList } from './bonusView.js';
import { forecastDevelopment, blockContribution } from '../core/forecast.js';
import { forecastSummary, forecastText, forecastDetails, compareForecasts } from './forecastView.js';
import { currentPlayer, getPlayer, usesCityAction, outOfCityActions, actionName, TURN_PHASES, ERAS } from '../core/game.js';
import { isCpu } from '../core/seats.js';
import { cpuBids } from '../core/cpu/city.js';
import { toast } from './toast.js';
import { buzz } from './haptics.js';
import {
  quoteDowngrade, quoteSale, downgradeBlock, sellDevelopment, quoteAcquire, acquireAbandoned,
  quoteRedevelopment, eligibleRedevelopers, resolveRedevelopmentAuction, ACQUIRE_MODES, FIN_ERRORS,
} from '../core/finance.js';
import { quoteTakeover, takeoverBlock, TAKEOVER_ERRORS } from '../core/takeover.js';
import { CATEGORY_EFFECTS } from '../core/strategy.js';
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
  [FIN_ERRORS.IN_DISTRESS]: 'Clear your debt first.',
};

/** "No Development Actions left" / "No City Actions left", for the current era. */
const noActions = () => `No ${actionName(state.game, 2)} left`;

/**
 * The turn's management budget under the cash box: Development Actions (EXPANSION) or City
 * Actions (CITY) left in Manage City; Develop Now on a just-captured block is free.
 */
function actionsNote(game) {
  if (game.turnPhase === TURN_PHASES.CAPTURE_DEVELOP && game.pendingCaptures[0] === state.blockId) {
    return h('span', { class: 'build-panel__city-actions' }, 'Develop Now: free (capture reward)');
  }
  if (!usesCityAction(game)) return null;
  const n = game.city.actionsLeft;
  return h('span', { class: `build-panel__city-actions${n ? '' : ' is-spent'}` }, `${n} ${actionName(game, n)} left`);
}

function pips(level) {
  return h('span', { class: 'level-pips', 'aria-label': `Level ${level} of ${MAX_LEVEL}` },
    Array.from({ length: MAX_LEVEL }, (_, i) => h('span', { class: `pip${i < level ? ' is-on' : ''}` })));
}

function header(game, block, player) {
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
        h('span', { title: 'Land plus what was actually paid for construction' }, `Property ${formatCash(block.value)}`),
        blockContribution(game, block.id) != null && h('span', {
          class: 'build-panel__cv',
          title: 'How much this block adds to your City Value (the final score)',
        }, `Adds ${formatCash(blockContribution(game, block.id))} to City Value`),
        h('span', { class: 'build-panel__prestige', title: 'This block\'s Prestige (each point scores at the end)' }, `Prestige ${block.prestige ?? 0}`),
        h('span', { class: 'build-panel__control', title: 'Takeover defence in the City era: a rival needs more adjacent pressure than this' }, `Control ${block.control ?? 0}`),
      ),
    ),
    h('div', { class: 'build-panel__cash' },
      h('span', {}, 'Your cash'),
      h('strong', { id: 'build-cash' }, formatCash(player.cash)),
      actionsNote(game),
    ),
  );
}

function priceTag(quote) {
  const changed = quote.baseCost != null && quote.baseCost !== quote.cost;
  return [
    h('span', { class: `price__cost${changed ? (quote.cost < quote.baseCost ? ' is-cheaper' : ' is-pricier') : ''}` },
      changed && h('s', { class: 'price__was' }, formatCash(quote.baseCost)), formatCash(quote.cost)),
    quote.industryDiscount > 0 && h('span', { class: 'price__industry' }, `Industry −${quote.industryDiscount}%`),
    h('span', { class: 'price__income' }, `+${formatCash(quote.income)}/turn`),
    quote.error === DEV_ERRORS.INSUFFICIENT_FUNDS
      && h('span', { class: 'price__short' }, `Need ${formatCash(quote.shortfall)} more`),
    quote.error === DEV_ERRORS.NO_ACTIONS && h('span', { class: 'price__short' }, noActions()),
  ];
}

function categoryOption(game, block, type, forecast) {
  const cat = getCategory(type);
  const quote = quoteBuild(game, block.id, type);
  const art = levelArt(type, 1);
  return h('button', {
    type: 'button',
    class: `build-option build-option--${type}${quote.ok ? '' : ' is-unaffordable'}`,
    dataset: { build: type },
    'aria-disabled': quote.ok ? null : 'true',
    title: forecast.ok ? forecastText(forecast) : null,
    'aria-label': `Build ${cat.label} (${art.name}) for ${formatCash(quote.cost)}, earns ${formatCash(quote.income)} per turn${quote.ok ? '' : quote.error === DEV_ERRORS.NO_ACTIONS ? `. ${noActions()}` : `. Need ${formatCash(quote.shortfall)} more`}${forecast.ok ? `. Net ${formatDelta(forecast.delta.net)} per turn${forecast.delta.cityValue == null ? '' : `, City Value ${formatDelta(forecast.delta.cityValue)}`}` : ''}`,
  },
    createSprite(art.sprite, { className: 'build-option__art' }),
    h('span', { class: 'build-option__label' },
      createSprite(cat.icon, { className: 'build-option__icon' }), cat.label),
    h('span', { class: 'build-option__name' }, art.name),
    h('span', { class: 'build-option__price' }, priceTag(quote)),
    h('span', { class: 'build-option__effect' }, CATEGORY_EFFECTS[type]),
    forecast.ok && forecast.delta.prestige !== 0 && h('span', { class: `build-option__prestige ${forecast.delta.prestige > 0 ? 'is-up' : 'is-down'}` },
      `${forecast.delta.prestige > 0 ? '+' : ''}${forecast.delta.prestige} Prestige`),
    forecast.ok && forecastSummary(forecast),
  );
}

function vacantView(game, block, player) {
  // Each forecast runs the real build on a copy of the game (core/forecast.js).
  const forecasts = CATEGORY_ORDER.map((type) => [type, forecastDevelopment(game, block.id, type)]);
  return [
    header(game, block, player),
    h('p', { class: 'build-panel__hint' }, 'Vacant lots earn nothing. Choose what to build (Level 1):'),
    h('div', { class: 'build-panel__grid' }, forecasts.map(([type, f]) => categoryOption(game, block, type, f))),
    compareForecasts(forecasts),
    h('div', { class: 'build-panel__actions' },
      h('button', { type: 'button', class: 'btn', dataset: { action: 'close' } },
        createSprite('icons:undo', { className: 'btn__icon' }), h('span', {}, 'Leave Vacant')),
    ),
  ];
}

function developedView(game, block, player) {
  const cat = getCategory(block.type);
  const nodes = [header(game, block, player), bonusList(block),
    h('p', { class: 'build-panel__effect' }, h('strong', {}, `${cat.label}: `), CATEGORY_EFFECTS[block.type])];
  if (block.level >= MAX_LEVEL) {
    nodes.push(h('p', { class: 'build-panel__maxed' },
      createSprite('icons:crown', { className: 'build-panel__maxed-icon' }),
      `${cat.label} is fully developed.`));
  } else {
    const quote = quoteUpgrade(game, block.id);
    const forecast = forecastDevelopment(game, block.id);
    const next = levelArt(block.type, block.level + 1);
    nodes.push(h('div', { class: `upgrade-card build-option--${block.type}` },
      createSprite(next.sprite, { className: 'upgrade-card__art' }),
      h('div', { class: 'upgrade-card__info' },
        h('span', { class: 'upgrade-card__to' }, `Upgrade to Level ${block.level + 1}`),
        h('strong', { class: 'upgrade-card__name' }, next.name),
        h('span', { class: 'upgrade-card__gain' },
          `Base income ${formatCash(block.income)} → ${formatCash(quote.income)}/turn (+${formatCash(quote.incomeGain)})`),
        quote.eventCost != null && quote.baseCost !== quote.eventCost
          && h('span', { class: 'price__event' }, `City event price (normally ${formatCash(quote.baseCost)})`),
        quote.industryDiscount > 0
          && h('span', { class: 'price__industry' }, `Industry next door: −${quote.industryDiscount}% (${formatCash(quote.eventCost)} → ${formatCash(quote.cost)})`),
        forecast.ok && forecast.delta.prestige !== 0
          && h('span', { class: `build-option__prestige ${forecast.delta.prestige > 0 ? 'is-up' : 'is-down'}` },
            `${forecast.delta.prestige > 0 ? '+' : ''}${forecast.delta.prestige} Prestige`),
        quote.error === DEV_ERRORS.INSUFFICIENT_FUNDS
          && h('span', { class: 'price__short' }, `Need ${formatCash(quote.shortfall)} more`),
        quote.error === DEV_ERRORS.NO_ACTIONS && h('span', { class: 'price__short' }, `${noActions()} this turn`),
        forecast.ok && forecastDetails(forecast),
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
      ...bidders.map((bidder) => (isCpu(bidder)
        // CPU mayors bid too, sealed: their amounts are only revealed by the result.
        ? h('p', { class: 'auction-bid auction-bid--cpu', dataset: { cpuBidder: bidder.seat } },
          h('span', {}, bidder.name), h('span', { class: 'auction-bid__sealed' }, 'Sealed bid'))
        : h('label', { class: 'auction-bid' },
        h('span', {}, bidder.name),
        h('input', {
          type: 'number', min: q.reserve, step: ECONOMY.FINANCE.REDEVELOPMENT.MIN_BID_INCREMENT,
          max: bidder.cash, name: `bid-${bidder.seat}`, placeholder: 'Pass',
          value: bidder.seat === player.seat && bidder.cash >= q.reserve ? q.reserve : null,
        })))),
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
      h('div', { class: 'build-panel__cash' }, h('span', {}, 'Your cash'), h('strong', {}, formatCash(player.cash)), actionsNote(game)),
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

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * A rival's block in the CITY era: what a takeover would cost, your pressure against its control
 * (with where each comes from), and why it's refused when it is (core/takeover.js).
 */
function takeoverView(game, block, player) {
  const owner = getPlayer(game, block.ownerSeat);
  const art = levelArt(block.type, block.level);
  const q = quoteTakeover(game, block.id);
  const cp = q.controlParts;
  const pp = q.pressureParts;
  const beats = q.pressure > q.control;
  return [
    h('header', { class: 'build-panel__head' },
      art ? createSprite(art.sprite, { className: 'build-panel__art' }) : createSprite(ART.owner.seal(block.ownerSeat), { className: 'build-panel__art build-panel__art--seal' }),
      h('div', { class: 'build-panel__titles' },
        h('h3', { id: 'build-title', class: 'build-panel__title' }, `Block ${block.label} · ${owner.name}'s`),
        h('p', { class: 'build-panel__sub' }, `${DISTRICTS[block.district].label} · ${describeDevelopment(block)}`),
        h('p', { class: 'build-panel__stats' },
          h('span', { title: 'This block\'s Prestige, which moves with it' }, `Prestige ${block.prestige ?? 0}`))),
      h('div', { class: 'build-panel__cash' }, h('span', {}, 'Your cash'), h('strong', {}, formatCash(player.cash)), actionsNote(game)),
    ),
    h('div', { class: `takeover__duel${beats ? ' is-winning' : ''}` },
      h('p', { class: 'takeover__side' },
        h('strong', {}, `Your pressure ${q.pressure}`),
        h('small', {}, `${plural(pp.adjacent, 'adjacent building')}${pp.commercial ? ` + ${pp.commercial} Commercial` : ''}`)),
      h('span', { class: 'takeover__vs', 'aria-hidden': 'true' }, beats ? '›' : '≤'),
      h('p', { class: 'takeover__side' },
        h('strong', {}, `Control ${q.control}`),
        h('small', {}, [`${cp.base} ownership`, cp.level && `${cp.level} level`, cp.defence && `${cp.defence} defence`,
          cp.support && `${cp.support} support`].filter(Boolean).join(' + '))),
    ),
    h('p', { class: 'takeover__price' },
      `Takeover ${formatCash(q.cost)}: ${owner.name} receives the market value ${formatCash(q.marketValue)}; `
      + `${formatCash(q.premium)} is lost to redevelopment costs. The buildings come with it, protected from takeover until the next full round is done.`),
    !q.ok && h('p', { class: 'takeover__reason', role: 'note' },
      q.error === TAKEOVER_ERRORS.INSUFFICIENT_FUNDS ? `Not enough cash: need ${formatCash(q.shortfall)} more.` : q.reason),
    h('div', { class: 'build-panel__actions' },
      h('button', { type: 'button', class: 'btn btn--gold', dataset: { takeover: block.id }, 'aria-disabled': q.ok ? null : 'true' },
        createSprite('icons:coins', { className: 'btn__icon' }), h('span', {}, `Take over · ${formatCash(q.cost)} · 1 City Action`)),
      h('button', { type: 'button', class: 'btn', dataset: { action: 'close' } },
        createSprite('icons:undo', { className: 'btn__icon' }), h('span', {}, 'Leave it'))),
  ];
}

function handleTakeover(result) {
  if (!result.ok) {
    buzz('error');
    toast(result.reason ?? 'You can’t take that block over.', { tone: 'warn', duration: 2200 });
    render();
    return;
  }
  const block = getBlockById(state.game.board, result.block);
  toast(`Took over ${block.label} from ${getPlayer(state.game, result.from).name} · −${formatCash(result.cost)}`, { tone: 'success' });
  $('#build-dialog').close();
  state.onChange({ ...result, bonusBefore: Infinity });
}

function render() {
  const { game, blockId } = state;
  const block = getBlockById(game.board, blockId);
  const player = currentPlayer(game);
  let view;
  if (block.ownerSeat != null && block.ownerSeat !== player.seat) view = takeoverView(game, block, player);
  else if (block.abandoned) view = abandonedView(game, block, player);
  else if (isDeveloped(block)) view = developedView(game, block, player);
  else view = vacantView(game, block, player);
  $('#build-body').replaceChildren(...view.filter(Boolean));
}

function refuse(error, shortfall) {
  buzz('error');
  // NO_ACTIONS is the same code from development.js, finance.js and takeover.js.
  const text = error === DEV_ERRORS.INSUFFICIENT_FUNDS
    ? `Not enough cash: need ${formatCash(shortfall)} more.`
    : error === DEV_ERRORS.NO_ACTIONS
      ? `${noActions()} this turn. ${state.game.era === ERAS.CITY ? 'End your turn' : 'Pave a road'} to continue.`
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
    if (text) {
      buzz('error');
      toast(text, { tone: 'warn' });
    } else {
      refuse(result.error, result.shortfall);
    }
    render();
    return;
  }
  toast(result.mode === 'restore' ? `Restored Block · −${formatCash(result.cost)}` : `Bought the lot · −${formatCash(result.cost)}. Build something!`, { tone: 'success' });
  // A cleared lot goes straight to the build choices, if this turn has an action left to build with.
  const reopen = result.mode === ACQUIRE_MODES.REBUILD && !outOfCityActions(state.game);
  $('#build-dialog').close();
  state.onChange({ ...result, bonusBefore: Infinity });
  if (reopen) openBuildPanel(state.game, result.block); // go straight to choosing what to build
}

function handleAuction(mode) {
  const panel = document.querySelector(`[data-auction-mode="${mode}"]`);
  const bids = [...panel.querySelectorAll('[name^="bid-"]')]
    .filter((input) => input.value !== '')
    .map((input) => ({ seat: Number(input.name.slice(4)), bid: Number(input.value) }));
  bids.push(...cpuBids(state.game, state.blockId, mode));
  const result = resolveRedevelopmentAuction(state.game, state.blockId, mode, bids);
  if (!result.ok) {
    if (result.error === FIN_ERRORS.NO_ACTIONS) return refuse(result.error); // buzzes too
    buzz('error');
    toast(ERROR_TEXT[result.error] ?? 'No eligible affordable bid met the reserve.', { tone: 'warn' });
    return;
  }
  const winner = getPlayer(state.game, result.winnerSeat);
  toast(`${winner.name} wins redevelopment · ${formatCash(result.cost)}`, { tone: 'success' });
  // A cleared lot goes straight to the build choices, if this turn has an action left to build with.
  const reopen = result.mode === ACQUIRE_MODES.REBUILD && !outOfCityActions(state.game);
  $('#build-dialog').close();
  state.onChange({ ...result, bonusBefore: Infinity });
  // A cleared lot goes straight to choosing what to build (only if the winner is on turn and a
  // person: a CPU mayor chooses for itself).
  if (reopen && !isCpu(currentPlayer(state.game))) openBuildPanel(state.game, result.block);
}

/**
 * True if the current player may open the panel: their own block, an abandoned one, or (in a
 * City-era Manage City) a rival's block, to see or make a takeover.
 */
export function canManage(game, blockId) {
  const block = game && getBlockById(game.board, blockId);
  if (!block || game.phase !== 'playing') return false;
  const legalPhase = game.turnPhase === TURN_PHASES.MANAGE_CITY
    || (game.turnPhase === TURN_PHASES.CAPTURE_DEVELOP && game.pendingCaptures[0] === block.id);
  if (!legalPhase) return false;
  const seat = currentPlayer(game).seat;
  // City era: any rival block opens the takeover view (with the reason when it can't be taken).
  if (game.era === ERAS.CITY && game.turnPhase === TURN_PHASES.MANAGE_CITY
    && block.ownerSeat != null && !block.abandoned && block.ownerSeat !== seat) return true;
  return block.ownerSeat === seat || (block.abandoned && block.ownerSeat == null);
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
    if (e.target.closest('[data-takeover]')) return handleTakeover(takeoverBlock(state.game, state.blockId));
    if (e.target.closest('[data-action="close"]')) {
      dialog.close();
      state.onLeave({ blockId: state.blockId });
    }
  });
}
