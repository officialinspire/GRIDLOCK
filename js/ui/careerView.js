/**
 * Statistics & Achievements screen, plus recording each genuinely completed match
 * (rules and storage live in core/career.js).
 */
import { $, h } from './dom.js';
import { createSprite } from '../assets.js';
import { bus } from '../core/bus.js';
import { formatCash } from '../core/economy.js';
import { getCategory } from '../core/buildings.js';
import { ACHIEVEMENTS, loadCareer, saveCareer, recordMatch, favoriteCategory } from '../core/career.js';

const dateFormat = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/** Papercraft rosette badge: earned ones are coloured and say who/when; locked ones are greyed paper. */
function badge(def, earned, { compact = false } = {}) {
  return h('li', { class: `badge${earned ? ' is-earned' : ' is-locked'}`, dataset: { achievement: def.id } },
    h('span', { class: 'badge__rosette', 'aria-hidden': 'true' },
      createSprite(def.icon, { className: 'badge__icon' })),
    h('span', { class: 'badge__text' },
      h('strong', { class: 'badge__name' }, def.name),
      h('span', { class: 'badge__desc' }, def.text),
      !compact && h('span', { class: 'badge__earned' },
        earned ? `${earned.by} · ${dateFormat.format(earned.at)}` : 'Not earned yet')),
    h('span', { class: 'visually-hidden' }, earned ? ' (earned)' : ' (locked)'));
}

function stat(label, value, detail) {
  return h('div', { class: 'career-stat' },
    h('dt', {}, label),
    h('dd', {}, h('strong', {}, value), detail && h('span', { class: 'career-stat__by' }, detail)));
}

export function renderCareer() {
  const { career, corrupt } = loadCareer();
  const t = career.totals;
  const fav = favoriteCategory(career);
  $('#career-empty').hidden = t.matches > 0;
  $('#career-stats').replaceChildren(
    stat('Matches completed', String(t.matches)),
    stat('Blocks captured', String(t.blocksCaptured)),
    stat('Longest capture chain', String(t.longestChain.count), t.longestChain.by),
    stat('Buildings developed', String(t.developments)),
    stat('Highest City Value', formatCash(t.highestCityValue.value), t.highestCityValue.by),
    stat('Bankruptcies', String(t.bankruptcies)),
    stat('Events survived', String(t.eventsSurvived)),
    stat('Favourite development', fav ? getCategory(fav).label : '—', fav ? `${career.categories[fav]} built` : null),
  );
  const mayors = Object.values(career.mayors).sort((a, b) => b.won - a.won || b.played - a.played || a.name.localeCompare(b.name));
  $('#career-mayors tbody').replaceChildren(...(mayors.length
    ? mayors.map((m) => h('tr', {}, h('th', { scope: 'row' }, m.name), h('td', {}, String(m.played)), h('td', {}, String(m.won)), h('td', {}, formatCash(m.best))))
    : [h('tr', {}, h('td', { colspan: 4, class: 'career__none' }, 'No completed matches yet.'))]));
  const earnedCount = ACHIEVEMENTS.filter((a) => career.achievements[a.id]).length;
  $('#career-badge-count').textContent = `${earnedCount} / ${ACHIEVEMENTS.length}`;
  $('#career-badges').replaceChildren(...ACHIEVEMENTS.map((a) => badge(a, career.achievements[a.id])));
  $('#career-note').textContent = corrupt
    ? 'Saved statistics on this device could not be read, so a fresh record was started (the old data was kept aside).'
    : 'Saved on this device. Only completed matches count.';
}

/**
 * Records a finished match (only if it was genuinely played to the end) and shows any
 * newly earned achievements on the results screen. Never throws.
 */
export function recordFinishedMatch(game) {
  let unlocked = [];
  try {
    const { career } = loadCareer();
    const result = recordMatch(career, game);
    if (result.recorded) saveCareer(result.career);
    unlocked = result.unlocked;
  } catch {
    unlocked = [];
  }
  const section = $('#results-unlocked');
  section.hidden = unlocked.length === 0;
  $('#results-badges').replaceChildren(...unlocked.map((u) => {
    const def = ACHIEVEMENTS.find((a) => a.id === u.id);
    const li = badge(def, { by: u.by, at: Date.now() }, { compact: true });
    li.querySelector('.badge__desc').textContent = `${u.by} · ${def.text}`;
    return li;
  }));
  return unlocked;
}

export function initCareerView() {
  bus.on('screen:shown', ({ name }) => { if (name === 'stats') renderCareer(); });
}
