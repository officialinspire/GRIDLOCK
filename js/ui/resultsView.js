/**
 * Final results screen. Reads the frozen game.results from core/scoring.js,
 * so what's shown is exactly what was scored when the city was completed.
 */
import { $, h } from './dom.js';
import { createSprite } from '../assets.js';
import { ART } from '../art.js';
import { formatCash } from '../core/economy.js';
import { TIEBREAKERS } from '../core/scoring.js';
import { modeName } from '../core/modes.js';
import { challengeUrl, formatSeed } from '../core/challenge.js';
import { controllerLabel } from '../core/seats.js';
import { toast } from './toast.js';
import { ECONOMY } from '../config.js';

const ordinal = (n) => ({ 1: '1st', 2: '2nd', 3: '3rd' }[n] ?? `${n}th`);

function stat(label, value, cls = '') {
  return [h('dt', {}, label), h('dd', { class: cls }, value)];
}

function playerCard(row, awardsBySeat, isWinner, index, cpu) {
  const hi = row.highest;
  return h('li', {
    class: `result-card result-card--${row.color}${isWinner ? ' is-winner' : ''}`,
    dataset: { seat: row.seat, rank: row.rank, cityValue: row.cityValue },
    style: { animationDelay: `${160 + index * 120}ms` },
    'aria-label': `${ordinal(row.rank)}: ${row.name}${cpu ? ` (${cpu})` : ''}, City Value ${formatCash(row.cityValue)}`,
  },
    h('div', { class: 'result-card__head' },
      h('span', { class: 'result-card__rank' }, ordinal(row.rank)),
      createSprite(ART.owner.chip(row.seat), { className: 'result-card__token' }),
      h('span', { class: 'result-card__name' }, row.name),
      cpu && h('span', { class: 'result-card__cpu', title: cpu }, cpu),
      isWinner && createSprite('icons:crown', { className: 'result-card__crown', label: 'Winner' }),
    ),
    h('p', { class: 'result-card__value' },
      h('span', {}, 'City Value'),
      h('strong', { class: 'result-card__city-value' }, formatCash(row.cityValue))),
    h('p', { class: 'result-card__breakdown' },
      `${formatCash(row.scoredCash)} cash + ${formatCash(row.scoredLand)} land + ${formatCash(row.scoredBuildings)} buildings`
      + ` + ${formatCash(row.scoredPrestige)} Prestige`
      + (row.bankruptcyPenalty ? ` − ${formatCash(row.bankruptcyPenalty)} bankruptcy (${row.bankruptcies}×)` : '')),
    h('dl', { class: 'result-card__stats' },
      stat('Cash', formatCash(row.cash), row.cash < 0 ? 'is-negative' : ''),
      stat('Prestige', row.prestige),
      stat('Levels built', row.totalLevels),
      stat('Blocks owned', row.blocks),
      stat('Income', `+${formatCash(row.income)}/turn`),
      (row.takeovers > 0 || row.takeoversLost > 0) && stat('Takeovers', `${row.takeovers} made · ${row.takeoversLost} lost`),
      row.bankruptcies > 0 && stat('Bankruptcies', `${row.bankruptcies} (−${formatCash(row.bankruptcyPenalty)})`, 'is-negative'),
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

  $('#results-list').replaceChildren(...res.rows.map((row, index) => playerCard(row, awardsBySeat, winners.has(row.seat), index,
    controllerLabel(game.players.find((p) => p.seat === row.seat)))));
  $('#results-awards').replaceChildren(...(res.distinctions.length
    ? res.distinctions.map((a) => h('li', { class: 'award', dataset: { award: a.id } },
      createSprite(a.icon, { className: 'award__icon' }),
      h('strong', { class: 'award__title' }, a.title),
      h('span', { class: 'award__who' }, a.seats.map(nameOf).join(' & ') + (a.shared ? ' (shared)' : '')),
      h('span', { class: 'award__detail' }, a.detail)))
    : [h('li', { class: 'award award--none' }, 'No distinctions this time.')]));

  const tie = res.rows.length > 1 && res.rows[0].cityValue === res.rows[1].cityValue;
  const { CASH, LAND, INVESTED_BUILDING, PRESTIGE } = ECONOMY.SCORING;
  const pct = (k) => `${Math.round(k * 100)}%`;
  const formula = `City Value = ${pct(CASH)} cash + ${pct(LAND)} land + ${pct(INVESTED_BUILDING)} building investment`
    + ` + ${formatCash(PRESTIGE)} per Prestige`;
  $('.results__formula').textContent = tie
    ? `${formula} · ties broken by ${TIEBREAKERS.slice(1).map((t) => t.label).join(', then ')}`
    : formula;

  const stats = res.matchStats;
  const statName = (seat) => seat ? nameOf(seat) : 'None';
  const category = (type) => type ? `${type[0].toUpperCase()}${type.slice(1)}` : 'None';
  const facts = [
    ['Longest Capture Chain', stats.longestCaptureChain.count
      ? `${statName(stats.longestCaptureChain.seat)} · ${stats.longestCaptureChain.count}` : 'None'],
    ['Biggest District', stats.biggestDistrict
      ? `${statName(stats.biggestDistrict.seat)} · ${stats.biggestDistrict.size} ${category(stats.biggestDistrict.type)}` : 'None'],
    ['Best Single Block', stats.bestSingleBlock
      ? `${statName(stats.bestSingleBlock.seat)} · ${stats.bestSingleBlock.label} · ${formatCash(stats.bestSingleBlock.value)}` : 'None'],
    ['Events Survived', stats.eventsSurvived],
    // One tile for both, so the summary keeps its five-across layout.
    ['Bankruptcies · Takeovers', `${stats.bankruptcies} · ${stats.takeovers ?? 0}`],
  ];
  $('#match-stats').replaceChildren(...facts.map(([label, value]) =>
    h('div', { class: 'match-stat' }, h('dt', {}, label), h('dd', {}, value))));
}

const reducedMotion = () => document.documentElement.dataset.motion === 'reduced'
  || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function countCityValues(dialog) {
  for (const el of dialog.querySelectorAll('.result-card__city-value')) {
    const target = Number(el.closest('.result-card').dataset.cityValue);
    if (reducedMotion()) continue;
    el.textContent = formatCash(0);
    const start = performance.now();
    const tick = (now) => {
      if (!dialog.open) return;
      const progress = Math.min(1, (now - start) / 850);
      el.textContent = formatCash(Math.round(target * (1 - (1 - progress) ** 3)));
      if (progress < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

export function showResults(game) {
  renderResults(game);
  $('#results-mode').textContent = `${modeName(game)} rules · ${game.players.length} players · ${game.round} rounds`;
  $('#results-seed').textContent = formatSeed(game.seed);
  $('#share-fallback').hidden = true;
  const dialog = $('#results-dialog');
  if (!dialog.open) dialog.showModal();
  requestAnimationFrame(() => countCityValues(dialog));
  dialog.querySelector('[data-results-action="rematch"]').focus();
}

/** Link that deals this city again: seed, rules and seats only (never ?debug or names). */
export const gameChallengeUrl = (game, pageHref = window.location.href) =>
  challengeUrl({ seed: game.seed, mode: game.mode, seats: game.players }, pageHref);

/**
 * Copies the challenge link. Where the Clipboard API is missing, blocked or refused,
 * the link appears in a selected read-only box instead, so it can still be copied by hand.
 */
export async function copyChallengeLink(game) {
  const link = gameChallengeUrl(game);
  const fallback = $('#share-fallback');
  const input = $('#share-link');
  input.value = link;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
    await navigator.clipboard.writeText(link);
    fallback.hidden = true;
    toast('Challenge link copied', { tone: 'success' });
    return true;
  } catch {
    fallback.hidden = false;
    input.focus();
    input.select();
    return false;
  }
}
