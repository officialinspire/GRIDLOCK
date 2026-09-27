/**
 * New Game screen: seats (Standard = four, Custom = 2–4), who plays each seat (a table preset:
 * Solo, Local Friends or Mixed; CPU seats have a difficulty), a rule preset (GAME_MODES) and an
 * optional city seed.
 */
import { $, h } from './dom.js';
import { createSprite, preloadSheets } from '../assets.js';
import { ART } from '../art.js';
import { PLAYER_PRESETS, MIN_PLAYERS, MAX_NAME_LENGTH, ECONOMY, GAME_MODES, DEFAULT_MODE } from '../config.js';
import { formatCash } from '../core/economy.js';
import { getSettings } from './settingsView.js';
import { bus } from '../core/bus.js';
import { randomSeed } from '../core/rng.js';
import { parseSeed, formatSeed } from '../core/challenge.js';
import {
  SEAT_PRESETS, DEFAULT_SEAT_PRESET, DIFFICULTIES, DIFFICULTY_LABELS, DEFAULT_DIFFICULTY, SEAT_ERRORS,
  applySeatPreset, defaultNames, validateSeats, isCpu,
} from '../core/seats.js';

function seatCard(preset) {
  const inputId = `seat-${preset.seat}-name`;
  const joinId = `seat-${preset.seat}-join`;
  return h('fieldset', { class: `seat-card paper seat-card--${preset.color}`, dataset: { seat: preset.seat } },
    h('legend', { class: 'visually-hidden' }, preset.name),
    h('div', { class: 'seat-card__head' },
      createSprite(ART.owner.chip(preset.seat), { className: 'seat-card__token' }),
      h('span', { class: 'seat-card__seat' }, `Seat ${preset.seat}`),
      createSprite(ART.owner.pennant(preset.seat), { className: 'seat-card__flag' }),
    ),
    h('label', { class: 'seat-card__label', for: inputId }, 'Mayor name'),
    h('input', {
      class: 'text-input', id: inputId, name: 'name', type: 'text',
      maxlength: MAX_NAME_LENGTH, placeholder: preset.name, spellcheck: 'false',
    }),
    h('div', { class: 'seat-card__controller', role: 'radiogroup', 'aria-label': `Seat ${preset.seat} is played by` },
      ['human', 'cpu'].map((value) => h('label', { class: 'controller-option' },
        h('input', { type: 'radio', name: `controller-${preset.seat}`, value, checked: value === 'human' }),
        h('span', {}, value === 'human' ? 'Human' : 'CPU')))),
    h('label', { class: 'seat-card__difficulty', hidden: true },
      h('span', {}, 'Difficulty'),
      h('select', { class: 'select', name: 'difficulty' },
        DIFFICULTIES.map((d) => h('option', { value: d, selected: d === DEFAULT_DIFFICULTY }, DIFFICULTY_LABELS[d])))),
    h('label', { class: 'seat-card__join', for: joinId },
      h('span', {}, 'Playing'),
      h('input', { type: 'checkbox', class: 'toggle', id: joinId, name: 'join', checked: true }),
    ),
  );
}

/** One radio card per table preset (Solo / Local Friends / Mixed). */
function tableOption(preset) {
  return h('label', { class: 'table-option', dataset: { seatPreset: preset.id } },
    h('input', { type: 'radio', name: 'seatPreset', value: preset.id, checked: preset.id === DEFAULT_SEAT_PRESET }),
    h('span', { class: 'table-option__text' },
      h('strong', { class: 'table-option__name' }, preset.name),
      h('span', { class: 'table-option__blurb' }, preset.blurb)));
}

const controllerOfCard = (card) => {
  const controller = card.querySelector(`[name="controller-${card.dataset.seat}"]:checked`)?.value ?? 'human';
  return { controller, difficulty: controller === 'cpu' ? card.querySelector('[name="difficulty"]').value : null };
};

/** One radio card per rule preset: name and its one-line description, straight from config. */
function ruleOption(mode) {
  return h('label', { class: 'rule-option', dataset: { mode: mode.id } },
    h('input', { type: 'radio', name: 'mode', value: mode.id, checked: mode.id === DEFAULT_MODE }),
    h('span', { class: 'rule-option__text' },
      h('strong', { class: 'rule-option__name' }, mode.name),
      h('span', { class: 'rule-option__blurb' }, mode.blurb)));
}

function joinedSeats(form) {
  return [...form.querySelectorAll('.seat-card')]
    .filter((card) => card.querySelector('[name="join"]').checked)
    .map((card) => ({ seat: Number(card.dataset.seat), name: card.querySelector('[name="name"]').value, ...controllerOfCard(card) }));
}

/**
 * Applies the table preset to the joined seats' controls. Solo and Local Friends set every
 * controller (only CPU difficulty stays editable); Mixed leaves each seat to the players.
 */
function syncControllers(form) {
  const preset = form.elements.seatPreset.value;
  const cards = [...form.querySelectorAll('.seat-card')];
  const joined = cards.filter((card) => card.querySelector('[name="join"]').checked);
  const wanted = new Map(applySeatPreset(preset, joined.map((card) => ({ seat: Number(card.dataset.seat), ...controllerOfCard(card) })))
    .map((s) => [s.seat, s]));
  for (const card of cards) {
    const seat = Number(card.dataset.seat);
    const want = wanted.get(seat);
    const radios = card.querySelectorAll(`[name="controller-${seat}"]`);
    if (want && preset !== 'mixed') for (const r of radios) r.checked = r.value === want.controller;
    for (const r of radios) r.disabled = !want || preset !== 'mixed';
    const { controller } = controllerOfCard(card);
    const difficulty = card.querySelector('.seat-card__difficulty');
    difficulty.hidden = controller !== 'cpu';
    difficulty.querySelector('select').disabled = !want;
    card.classList.toggle('is-cpu', controller === 'cpu');
  }
  // Placeholders show the name a blank box will get ("Mayor Bot 1" for CPU seats).
  const names = defaultNames(joinedSeats(form));
  for (const card of cards) {
    card.querySelector('[name="name"]').placeholder = names.get(Number(card.dataset.seat)) ?? PLAYER_PRESETS[card.dataset.seat - 1].name;
  }
}

/** "4 players" for an all-human table (as before); "4 players (1 human, 3 CPU)" otherwise. */
function playersText(seats) {
  const cpus = seats.filter(isCpu).length;
  return `${seats.length} players${cpus ? ` (${seats.length - cpus} human, ${cpus} CPU)` : ''}`;
}

/** undefined = random city, a number = that city, null = the box holds something that isn't a seed. */
function seedValue(form) {
  const raw = form.elements.seed.value;
  return raw.trim() === '' ? undefined : parseSeed(raw);
}

function refresh(form) {
  const standard = form.elements.gameType.value === 'standard';
  form.querySelectorAll('.seat-card [name="join"]').forEach((join) => {
    if (standard) join.checked = true;
    join.disabled = standard;
  });
  form.querySelectorAll('.seat-card').forEach((card) => {
    const on = card.querySelector('[name="join"]').checked;
    card.classList.toggle('is-out', !on);
    card.querySelector('[name="name"]').disabled = !on;
  });
  syncControllers(form);
  const seats = joinedSeats(form);
  const seatError = validateSeats({ gameType: standard ? 'standard' : 'custom', seats });
  const seatsOk = !seatError;
  const seed = seedValue(form);
  $('#setup-seed-box').classList.toggle('is-invalid', seed === null);
  $('#setup-seed-hint').textContent = seed === null ? SEED_ERROR : SEED_HINT;
  form.elements.seed.setAttribute('aria-invalid', String(seed === null));
  $('#setup-start').disabled = !seatsOk || seed === null;
  const mode = GAME_MODES[form.elements.mode.value] ?? GAME_MODES[DEFAULT_MODE];
  $('#setup-summary').textContent = !seatsOk
    ? (seatError === SEAT_ERRORS.NO_HUMAN ? seatError : `At least ${MIN_PLAYERS} players must join.`)
    : seed === null ? SEED_ERROR
    : `${standard ? 'Standard Game' : 'Custom Game'} · ${playersText(seats)} · ${formatCash(ECONOMY.STARTING_CASH)} each · 6×6 city · ${mode.name} rules${seed === undefined ? '' : ` · seed ${formatSeed(seed)}`}`;
}

const SEED_HINT = 'Leave blank for a surprise city. The same seed, rules and seats roll the same city events for the same moves.';
const SEED_ERROR = 'A city seed is a whole number from 0 to 4294967295.';

/**
 * Pre-fills the form from a challenge link ({ seed, mode, seats } from core/challenge.js):
 * the seed always, the rules and seats when the link names valid ones.
 */
export function applyChallenge(challenge) {
  const form = $('#setup-form');
  form.elements.seed.value = formatSeed(challenge.seed);
  if (challenge.mode) form.querySelector(`[name="mode"][value="${challenge.mode}"]`).checked = true;
  if (challenge.seats) {
    const standard = challenge.seats.length === PLAYER_PRESETS.length;
    form.querySelector(`[name="gameType"][value="${standard ? 'standard' : 'custom'}"]`).checked = true;
    form.querySelectorAll('.seat-card').forEach((card) => {
      const join = card.querySelector('[name="join"]');
      join.disabled = false;
      join.checked = challenge.seats.includes(Number(card.dataset.seat));
    });
  }
  const mode = GAME_MODES[form.elements.mode.value] ?? GAME_MODES[DEFAULT_MODE];
  const note = $('#setup-challenge');
  note.textContent = `Challenge city ${formatSeed(challenge.seed)} · ${mode.name} rules${challenge.seats ? ` · ${challenge.seats.length} players` : ''}. Beat your friend's City Value!`;
  note.hidden = false;
  refresh(form);
}

export function initSetupView() {
  const form = $('#setup-form');
  const list = $('#setup-players');
  list.replaceChildren(...PLAYER_PRESETS.map(seatCard));
  $('#setup-table').append(...Object.values(SEAT_PRESETS).map(tableOption));
  $('#setup-rules').append(...Object.values(GAME_MODES).map(ruleOption));

  form.addEventListener('change', () => refresh(form));
  form.elements.seed.addEventListener('input', () => refresh(form));
  $('#setup-seed-new').addEventListener('click', () => {
    form.elements.seed.value = formatSeed(randomSeed());
    refresh(form);
  });
  $('#setup-seed-clear').addEventListener('click', () => {
    form.elements.seed.value = '';
    $('#setup-challenge').hidden = true;
    refresh(form);
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const seats = joinedSeats(form);
    const standard = form.elements.gameType.value === 'standard';
    if (validateSeats({ gameType: standard ? 'standard' : 'custom', seats })) return;
    const seed = seedValue(form);
    if (seed === null) return;
    bus.emit('game:start', {
      seats, settings: getSettings(), gameType: standard ? 'standard' : 'custom', mode: form.elements.mode.value,
      ...(seed !== undefined && { seed }),
    });
  });
  bus.on('settings:changed', () => refresh(form));
  bus.on('screen:shown', ({ name }) => {
    if (name !== 'setup') return;
    refresh(form);
    // Warm the board art while players type their names.
    preloadSheets(['roads', 'markers', 'parks', 'buildings', 'civic', 'effects']);
  });
  refresh(form);
}
