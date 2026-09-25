/**
 * Player HUD cards. All four seats are always shown so the table layout is
 * stable; seats not in the game render as empty placeholders.
 * Left column: seats 1 & 4 (left-side corners). Right column: seats 2 & 3.
 */
import { $, h } from './dom.js';
import { createSprite } from '../assets.js';
import { PLAYER_PRESETS } from '../config.js';
import { formatCash } from '../core/economy.js';
import { currentPlayer, getPlayer, playerStats, PHASES } from '../core/game.js';

const LAYOUT = { left: [1, 4], right: [2, 3] };

function stat(label, value, icon) {
  return h('div', { class: 'stat' },
    createSprite(icon, { className: 'stat__icon' }),
    h('dt', {}, label),
    h('dd', {}, value),
  );
}

function playerCard(game, seat) {
  const preset = PLAYER_PRESETS[seat - 1];
  const player = getPlayer(game, seat);

  if (!player) {
    return h('article', { class: `player-card paper player-card--${preset.color} is-empty`, 'aria-label': `Seat ${seat} empty` },
      h('header', { class: 'player-card__head' },
        createSprite(`markers:ring-${preset.color}`, { className: 'player-card__token' }),
        h('span', { class: 'player-card__name' }, `Seat ${seat}`),
      ),
      h('p', { class: 'player-card__empty' }, 'Open seat'),
    );
  }

  const stats = playerStats(game, player);
  const active = game.phase === PHASES.PLAYING && currentPlayer(game).seat === seat;
  return h('article', {
    class: `player-card paper player-card--${preset.color}${active ? ' is-active' : ''}`,
    'aria-label': `${player.name}${active ? ', current turn' : ''}`,
    'aria-current': active ? 'true' : null,
    dataset: { seat },
  },
    h('header', { class: 'player-card__head' },
      createSprite(`markers:chip-${preset.color}`, { className: 'player-card__token' }),
      h('span', { class: 'player-card__name' }, player.name),
      active && h('span', { class: 'player-card__turn' }, 'Turn'),
    ),
    h('dl', { class: 'player-card__stats' },
      stat('Cash', formatCash(stats.cash), 'icons:coins'),
      stat('Blocks', stats.blocks, 'icons:map'),
      stat('Income', `+${formatCash(stats.income)}`, 'icons:building'),
    ),
  );
}

export function renderHud(game) {
  $('#hud-left').replaceChildren(...LAYOUT.left.map((seat) => playerCard(game, seat)));
  $('#hud-right').replaceChildren(...LAYOUT.right.map((seat) => playerCard(game, seat)));
  $('#hud-round').textContent = game.round;
  $('#hud-round-max').textContent = game.maxRounds;

  const banner = $('#turn-banner');
  if (game.phase === PHASES.ENDED) {
    banner.textContent = 'Game over';
    banner.style.removeProperty('--player');
  } else {
    const p = currentPlayer(game);
    banner.textContent = `${p.name}'s turn`;
    banner.style.setProperty('--player', p.hex);
  }
}
