/** New Game screen: four local seats, 2–4 must join. */
import { $, h } from './dom.js';
import { createSprite } from '../assets.js';
import { PLAYER_PRESETS, MIN_PLAYERS, MAX_NAME_LENGTH } from '../config.js';
import { formatCash } from '../core/economy.js';
import { getSettings } from './settingsView.js';
import { bus } from '../core/bus.js';

function seatCard(preset) {
  const inputId = `seat-${preset.seat}-name`;
  const joinId = `seat-${preset.seat}-join`;
  return h('fieldset', { class: `seat-card paper seat-card--${preset.color}`, dataset: { seat: preset.seat } },
    h('legend', { class: 'visually-hidden' }, preset.name),
    h('div', { class: 'seat-card__head' },
      createSprite(`markers:chip-${preset.color}`, { className: 'seat-card__token' }),
      h('span', { class: 'seat-card__seat' }, `Seat ${preset.seat}`),
      createSprite(`markers:pennant-${preset.color}`, { className: 'seat-card__flag' }),
    ),
    h('label', { class: 'seat-card__label', for: inputId }, 'Mayor name'),
    h('input', {
      class: 'text-input', id: inputId, name: 'name', type: 'text',
      maxlength: MAX_NAME_LENGTH, placeholder: preset.name, spellcheck: 'false',
    }),
    h('label', { class: 'seat-card__join', for: joinId },
      h('span', {}, 'Playing'),
      h('input', { type: 'checkbox', class: 'toggle', id: joinId, name: 'join', checked: true }),
    ),
  );
}

function joinedSeats(form) {
  return [...form.querySelectorAll('.seat-card')]
    .filter((card) => card.querySelector('[name="join"]').checked)
    .map((card) => ({ seat: Number(card.dataset.seat), name: card.querySelector('[name="name"]').value }));
}

function refresh(form) {
  const seats = joinedSeats(form);
  const s = getSettings();
  form.querySelectorAll('.seat-card').forEach((card) => {
    const on = card.querySelector('[name="join"]').checked;
    card.classList.toggle('is-out', !on);
    card.querySelector('[name="name"]').disabled = !on;
  });
  const ok = seats.length >= MIN_PLAYERS;
  $('#setup-start').disabled = !ok;
  $('#setup-summary').textContent = ok
    ? `${seats.length} players · ${s.rounds} rounds · ${formatCash(s.startingCash)} each`
    : `At least ${MIN_PLAYERS} players must join.`;
}

export function initSetupView() {
  const form = $('#setup-form');
  const list = $('#setup-players');
  list.replaceChildren(...PLAYER_PRESETS.map(seatCard));

  form.addEventListener('change', () => refresh(form));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const seats = joinedSeats(form);
    if (seats.length < MIN_PLAYERS) return;
    bus.emit('game:start', { seats, settings: getSettings() });
  });
  bus.on('settings:changed', () => refresh(form));
  bus.on('screen:shown', ({ name }) => name === 'setup' && refresh(form));
  refresh(form);
}
