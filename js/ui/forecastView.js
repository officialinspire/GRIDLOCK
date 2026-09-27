/**
 * Presents forecasts from core/forecast.js. Pure presentation: every number here is
 * read from the forecast (which ran the real transaction); nothing is recalculated.
 */
import { h } from './dom.js';
import { createSprite } from '../assets.js';
import { formatCash, formatDelta } from '../core/economy.js';
import { getCategory } from '../core/buildings.js';

const perTurn = (n) => `${formatDelta(n)}/turn`;
const pct = (m) => `${m >= 1 ? '+' : '−'}${Math.round(Math.abs(m - 1) * 100)}%`;
const change = (before, after, fmt = formatCash) => (after == null ? '—' : before === after ? fmt(after) : `${fmt(before)} → ${fmt(after)}`);

/** "Housing Boom +25%" style labels for event price or income modifiers. */
export function modifierText(impacts) {
  return impacts.map((i) => `${i.def.name} ${i.mitigated ? '(shielded)' : pct(i.multiplier)}`).join(', ');
}

/** One compact line for a build option card. */
export function forecastSummary(f) {
  return h('span', { class: 'forecast-line' },
    h('span', { class: `forecast-line__net ${f.delta.net >= 0 ? 'is-up' : 'is-down'}` }, `Net ${perTurn(f.delta.net)}`),
    f.delta.cityValue != null && h('span', {}, `City Value ${formatDelta(f.delta.cityValue)}`),
    f.activated.length > 0 && h('span', { class: 'forecast-line__bonus' }, `★ ${f.activated.length} bonus${f.activated.length > 1 ? 'es' : ''}`),
    (f.eventPrice.length > 0 || f.eventIncome.length > 0) && h('span', { class: 'forecast-line__event' }, 'Event'));
}

/** Plain-text breakdown for tooltips and screen readers. */
export function forecastText(f) {
  const lines = [
    `Cost ${formatCash(f.cost)}${f.baseCost !== f.cost ? ` (normally ${formatCash(f.baseCost)})` : ''}`,
    `Your income ${change(f.before.income, f.after.income)} per turn`,
    `Upkeep ${change(f.before.upkeep, f.after.upkeep)} per turn`,
    `Net ${change(f.before.net, f.after.net, formatDelta)} per turn`,
    f.delta.cityValue != null && `City Value ${formatDelta(f.delta.cityValue)}`,
    f.eventPrice.length > 0 && `Price: ${modifierText(f.eventPrice)}`,
    f.eventIncome.length > 0 && `Income: ${modifierText(f.eventIncome)}`,
    f.activated.length > 0 && `Activates: ${f.activated.map((b) => `${b.label} on ${b.blockLabel} (+${formatCash(b.amount)})`).join('; ')}`,
  ];
  return lines.filter(Boolean).join('\n');
}

const row = (label, value, tip) => [h('dt', { title: tip ?? null }, label), h('dd', {}, value)];

/** Full breakdown (upgrade card, compare rows). */
export function forecastDetails(f) {
  return h('dl', { class: 'forecast' },
    row('Cost', [formatCash(f.cost), f.baseCost !== f.cost && h('s', { class: 'forecast__was' }, formatCash(f.baseCost))],
      'What you pay now (city events can change prices)'),
    row('Your income', `${change(f.before.income, f.after.income)}/turn`, 'Collected at the start of your turn, with active city events applied'),
    row('Upkeep', `${change(f.before.upkeep, f.after.upkeep)}/turn`, 'Charged at the start of your turn for every block you own'),
    row('Net per turn', h('strong', { class: f.delta.net >= 0 ? 'is-up' : 'is-down' }, `${change(f.before.net, f.after.net, formatDelta)} (${formatDelta(f.delta.net)})`),
      'Income minus upkeep'),
    row('City Value', f.delta.cityValue == null ? `Not affordable yet (need ${formatCash(f.shortfall)} more)`
      : `${change(f.before.cityValue, f.after.cityValue)} (${formatDelta(f.delta.cityValue)})`,
    'Final score: weighted cash + land + building investment. Spending cash on buildings changes it.'),
    row('This block', `${formatCash(f.before.block.income)} → ${formatCash(f.after.block.income)}/turn${f.after.block.income !== f.after.block.normalIncome ? ` (normally ${formatCash(f.after.block.normalIncome)})` : ''}`),
    f.eventPrice.length > 0 && row('Price events', modifierText(f.eventPrice)),
    f.eventIncome.length > 0 && row('Income events', modifierText(f.eventIncome)),
    f.activated.length > 0 && row('Activates', h('ul', { class: 'forecast__bonuses' },
      f.activated.map((b) => h('li', {}, `★ ${b.label} · ${b.blockLabel} +${formatCash(b.amount)}/turn`)))),
  );
}

function eventsCell(f) {
  const parts = [f.eventPrice.length && `Price: ${modifierText(f.eventPrice)}`, f.eventIncome.length && `Income: ${modifierText(f.eventIncome)}`];
  return parts.filter(Boolean).join(' · ') || '—';
}

/** Side-by-side comparison of every category for a vacant lot (collapsed by default). */
export function compareForecasts(entries) {
  const valid = entries.filter(([, f]) => f.ok);
  if (!valid.length) return null;
  return h('details', { class: 'forecast-compare' },
    h('summary', {}, 'Compare forecasts'),
    h('div', { class: 'forecast-compare__scroll' },
      h('table', { class: 'forecast-table' },
        h('thead', {}, h('tr', {},
          ['Build', 'Cost', 'Net/turn', 'City Value', 'Bonuses', 'Events'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', {}, valid.map(([type, f]) => h('tr', { dataset: { forecast: type }, title: forecastText(f) },
          h('th', { scope: 'row' }, createSprite(getCategory(type).icon, { className: 'forecast-table__icon' }), getCategory(type).label),
          h('td', {}, formatCash(f.cost)),
          h('td', { class: f.delta.net >= 0 ? 'is-up' : 'is-down' }, formatDelta(f.delta.net)),
          h('td', {}, f.delta.cityValue == null ? '—' : formatDelta(f.delta.cityValue)),
          h('td', {}, f.activated.length ? `★ ${f.activated.length}` : '—'),
          h('td', {}, eventsCell(f)),
        ))))));
}
