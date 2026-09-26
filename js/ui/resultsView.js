/**
 * Final results screen. Reads the frozen game.results from core/scoring.js,
 * so what's shown is exactly what was scored when the city was completed.
 */
import { $, h } from './dom.js';
import { createSprite } from '../assets.js';
import { ART } from '../art.js';
import { formatCash } from '../core/economy.js';
import { TIEBREAKERS } from '../core/scoring.js';

const ordinal = (n) => ({ 1: '1st', 2: '2nd', 3: '3rd' }[n] ?? `${n}th`);

function stat(label, value, cls = '') {
  return [h('dt', {}, label), h('dd', { class: cls }, value)];
}

function playerCard(row, awardsBySeat, isWinner) {
  const hi = row.highest;
  return h('li', {
    class: `result-card result-card--${row.color}${isWinner ? ' is-winner' : ''}`,
    dataset: { seat: row.seat, rank: row.rank },
    'aria-label': `${ordinal(row.rank)}: ${row.name}, City Value ${formatCash(row.cityValue)}`,
  },
    h('div', { class: 'result-card__head' },
      h('span', { class: 'result-card__rank' }, ordinal(row.rank)),
      createSprite(ART.owner.chip(row.seat), { className: 'result-card__token' }),
      h('span', { class: 'result-card__name' }, row.name),
      isWinner && createSprite('icons:crown', { className: 'result-card__crown', label: 'Winner' }),
    ),
    h('p', { class: 'result-card__value' },
      h('span', {}, 'City Value'),
      h('strong', { class: 'result-card__city-value' }, formatCash(row.cityValue))),
    h('p', { class: 'result-card__breakdown' },
      `${formatCash(row.scoredCash)} cash + ${formatCash(row.scoredLand)} land + ${formatCash(row.scoredBuildings)} building score`),
    h('dl', { class: 'result-card__stats' },
      stat('Cash', formatCash(row.cash), row.cash < 0 ? 'is-negative' : ''),
      stat('Blocks owned', row.blocks),
      stat('Developed', row.developed),
      stat('Income', `+${formatCash(row.income)}/turn`),
    ),
    h('div', { class: 'result-card__best' },
      hi && createSprite(hi.sprite, { className: 'result-card__best-art' }),
      h('span', {},
        h('small', {}, 'Highest development'),
        hi ? `${hi.name} · ${hi.category} Lv ${hi.level} (${hi.label})` : 'None built')),
    (awardsBySeat.get(row.seat) ?? []).length > 0 && h('ul', { class: 'result-card__ribbons', 'aria-label': 'Distinctions' },
      awardsBySeat.get(row.seat).map((a) => h('li', {}, createSprite(a.icon, { className: 'ribbon-icon' }), a.title))),
  );
}

export function renderResults(game) {
  const res = game.results;
  const nameOf = (seat) => res.rows.find((r) => r.seat === seat)?.name ?? `Seat ${seat}`;
  const winners = new Set(res.winners);

  const everyone = res.winners.length === res.rows.length && res.rows.length > 1;
  const heading = everyone ? 'Tie! All mayors share the city'
    : res.winners.length > 1 ? `Tie! ${res.winners.map(nameOf).join(' & ')} share the city`
    : `${nameOf(res.winners[0])} wins the city!`;
  $('#results-heading').textContent = heading;
  $('#results-dialog').dataset.winnerColor = res.rows[0].color;

  const awardsBySeat = new Map();
  for (const a of res.distinctions) for (const seat of a.seats) {
    if (!awardsBySeat.has(seat)) awardsBySeat.set(seat, []);
    awardsBySeat.get(seat).push(a);
  }

  $('#results-list').replaceChildren(...res.rows.map((row) => playerCard(row, awardsBySeat, winners.has(row.seat))));
  $('#results-awards').replaceChildren(...(res.distinctions.length
    ? res.distinctions.map((a) => h('li', { class: 'award', dataset: { award: a.id } },
      createSprite(a.icon, { className: 'award__icon' }),
      h('strong', { class: 'award__title' }, a.title),
      h('span', { class: 'award__who' }, a.seats.map(nameOf).join(' & ') + (a.shared ? ' (shared)' : '')),
      h('span', { class: 'award__detail' }, a.detail)))
    : [h('li', { class: 'award award--none' }, 'No distinctions this time.')]));

  const tie = res.rows.length > 1 && res.rows[0].cityValue === res.rows[1].cityValue;
  $('.results__formula').textContent = tie
    ? `City Value = weighted cash + land + building investment · ties broken by ${TIEBREAKERS.slice(1).map((t) => t.label).join(', then ')}`
    : 'City Value = weighted cash + land + building investment';
}

export function showResults(game) {
  renderResults(game);
  const dialog = $('#results-dialog');
  if (!dialog.open) dialog.showModal();
  dialog.querySelector('[data-results-action="rematch"]').focus();
}
