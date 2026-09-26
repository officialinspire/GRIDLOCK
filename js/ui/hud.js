/**
 * Player HUD cards. All four seats are always shown so the table layout is
 * stable; seats not in the game render as empty placeholders.
 * Left column: seats 1 & 4 (left-side corners). Right column: seats 2 & 3.
 */
import { $, h } from './dom.js';
import { createSprite } from '../assets.js';
import { ART } from '../art.js';
import { PLAYER_PRESETS } from '../config.js';
import { formatCash, formatCashShort, formatDelta } from '../core/economy.js';

/** Short phones show four HUD cards in one row; money is abbreviated there (matches css/mobile.css). */
const TIGHT_HUD = '(orientation: portrait) and (max-width: 700px) and (max-height: 700px)';
const money = (n) => (globalThis.matchMedia?.(TIGHT_HUD).matches ? formatCashShort(n) : formatCash(n));
import { currentPlayer, getPlayer, playerStats, roadsBuilt, standings, PHASES } from '../core/game.js';
import { totalRoads } from '../core/board.js';

const LAYOUT = { left: [1, 4], right: [2, 3] };
const TWEEN_MS = 700;

// Money animation state, keyed by seat. Reset whenever a new game object appears.
let lastGame = null;
const lastTargets = new Map(); // seat -> cash at the previous render
const shownCash = new Map(); // value currently displayed (mid-tween values included)
const tweens = new Map(); // seat -> requestAnimationFrame id

const reducedMotion = () =>
  document.documentElement.dataset.motion === 'reduced'
  || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function stat(key, label, value, icon, hint = label) {
  return h('div', { class: `stat stat--${key}`, title: hint },
    createSprite(icon, { className: 'stat__icon' }),
    h('dt', {}, label),
    h('dd', {}, value),
  );
}

/** Income (base + bonuses). A small ★ marks bonus income; details live in the tooltip / block info. */
function incomeStat(stats) {
  const notes = ['Income paid at the start of each turn'];
  if (stats.upkeep > 0) notes.push(`upkeep −${formatCash(stats.upkeep)} is charged after it`);
  if (stats.bonus > 0) notes.push(`includes ${formatCash(stats.bonus)} adjacency bonus`);
  if (stats.eventDelta) notes.push(`${formatDelta(stats.eventDelta)} from city events (normally ${formatCash(stats.normalIncome)})`);
  const el = stat('income', 'Income', `+${money(stats.income)}`, 'icons:clock', notes.join('; '));
  el.dataset.normal = stats.normalIncome;
  const dd = el.querySelector('dd');
  if (stats.bonus > 0) {
    el.classList.add('has-bonus');
    dd.append(h('span', { class: 'stat__bonus', 'aria-label': `includes ${formatCash(stats.bonus)} bonus` }, '★'));
  }
  if (stats.eventDelta) {
    const up = stats.eventDelta > 0;
    el.classList.add(up ? 'is-event-up' : 'is-event-down');
    dd.append(h('span', { class: `stat__event stat__event--${up ? 'up' : 'down'}`, 'aria-label': `${formatDelta(stats.eventDelta)} from city events` }, up ? '▲' : '▼'));
  }
  return el;
}

/** Counts the displayed cash from `from` to `to`, easing out. */
function tweenCash(seat, el, from, to) {
  cancelAnimationFrame(tweens.get(seat));
  tweens.delete(seat);
  if (from === to || reducedMotion()) {
    el.textContent = money(to);
    shownCash.set(seat, to);
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - start) / TWEEN_MS);
    const eased = 1 - (1 - k) ** 3;
    const value = Math.round(from + (to - from) * eased);
    shownCash.set(seat, value);
    el.textContent = money(value);
    if (k < 1) tweens.set(seat, requestAnimationFrame(step));
    else tweens.delete(seat);
  };
  tweens.set(seat, requestAnimationFrame(step));
}

/** Floating "+$500" chip and a pulse on the cash row. */
function showCashDelta(card, delta) {
  const dir = delta > 0 ? 'up' : 'down';
  card.querySelector('.stat--cash')?.classList.add(`is-${dir}`);
  const chip = h('span', { class: `cash-delta cash-delta--${dir}`, 'aria-hidden': 'true' }, formatDelta(delta));
  (card.querySelector('.stat--cash') ?? card).append(chip);

  // Keep the semantic delta in the DOM for a minimum readable interval in all
  // motion modes. CSS may animate it away sooner visually, but interrupted or
  // very fast animations should not erase the feedback before assistive/test
  // consumers can observe the transaction.
  setTimeout(() => chip.remove(), reducedMotion() ? 1200 : 1800);
}

function animateMoney(game) {
  const fresh = game !== lastGame;
  lastGame = game;
  if (fresh) {
    tweens.forEach((id) => cancelAnimationFrame(id));
    tweens.clear();
    shownCash.clear();
    lastTargets.clear();
  }
  for (const player of game.players) {
    const { seat, cash } = player;
    const card = document.querySelector(`.player-card[data-seat="${seat}"]`);
    const dd = card?.querySelector('.stat--cash dd');
    const prevTarget = lastTargets.get(seat);
    lastTargets.set(seat, cash);
    if (!dd) continue;
    if (prevTarget === undefined) {
      shownCash.set(seat, cash);
      dd.textContent = money(cash);
      continue;
    }
    // The chip shows the real change; the counter continues from what's on screen.
    if (prevTarget !== cash) showCashDelta(card, cash - prevTarget);
    tweenCash(seat, dd, shownCash.get(seat) ?? prevTarget, cash);
  }
}

function playerCard(game, seat) {
  const preset = PLAYER_PRESETS[seat - 1];
  const player = getPlayer(game, seat);

  if (!player) {
    return h('article', { class: `player-card paper player-card--${preset.color} is-empty`, 'aria-label': `Seat ${seat} empty`, dataset: { seat } },
      h('header', { class: 'player-card__head' },
        createSprite(ART.owner.ring(seat), { className: 'player-card__token' }),
        h('span', { class: 'player-card__name' }, `Seat ${seat}`),
      ),
      h('p', { class: 'player-card__empty' }, 'Open seat'),
    );
  }

  const stats = playerStats(game, player);
  const active = game.phase === PHASES.PLAYING && currentPlayer(game).seat === seat;
  return h('article', {
    class: `player-card paper player-card--${preset.color}${active ? ' is-active' : ''}${stats.distress ? ' is-distress' : ''}`,
    'aria-label': `${player.name}${active ? ', current turn' : ''}${stats.distress ? ', in debt' : ''}`,
    'aria-current': active ? 'true' : null,
    dataset: { seat },
  },
    h('header', { class: 'player-card__head' },
      createSprite(ART.owner.chip(seat), { className: 'player-card__token' }),
      h('span', { class: 'player-card__name' }, player.name),
      stats.distress && h('span', { class: 'player-card__debt' }, 'Debt'),
      !stats.distress && active && h('span', { class: 'player-card__turn' }, 'Turn'),
      stats.bankruptcies > 0 && h('span', { class: 'player-card__fresh', title: `Bankrupt ${stats.bankruptcies}× (fresh start)` }, `↺${stats.bankruptcies}`),
    ),
    h('dl', { class: 'player-card__stats' },
      stat('cash', 'Cash', money(shownCash.get(seat) ?? stats.cash), 'icons:coins', formatCash(stats.cash)),
      stat('blocks', 'Blocks', stats.blocks, 'icons:star', 'Blocks owned'),
      incomeStat(stats),
      stat('property', 'Property', formatCash(stats.property), 'icons:building', 'City value of property (land + actual construction cost basis)'),
    ),
  );
}

export function renderHud(game) {
  $('#hud-left').replaceChildren(...LAYOUT.left.map((seat) => playerCard(game, seat)));
  $('#hud-right').replaceChildren(...LAYOUT.right.map((seat) => playerCard(game, seat)));
  animateMoney(game);
  $('#hud-round').textContent = game.round;
  $('#hud-roads').textContent = `${roadsBuilt(game)}/${totalRoads(game.board)}`;

  const banner = $('#turn-banner');
  if (game.phase === PHASES.ENDED) {
    const rows = standings(game);
    const top = rows[0];
    const winners = rows.filter((r) => r.rank === 1);
    banner.textContent = winners.length > 1
      ? `Tie: ${winners.map((r) => r.player.name).join(' & ')}`
      : `${top.player.name} wins!`;
    banner.style.setProperty('--player', top.player.hex);
    banner.dataset.color = top.player.color;
  } else {
    const p = currentPlayer(game);
    banner.textContent = `${p.name}'s turn`;
    banner.title = banner.textContent;
    banner.style.setProperty('--player', p.hex);
    banner.dataset.color = p.color;
  }
}
