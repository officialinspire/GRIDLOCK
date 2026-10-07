/**
 * Statistics & Achievements screen, plus recording each genuinely completed match
 * (rules in core/achievements.js, storage in core/career.js, badges in ui/achievementView.js).
 */
import { $, h } from './dom.js';
import { bus } from '../core/bus.js';
import { formatCash } from '../core/economy.js';
import { getCategory } from '../core/buildings.js';
import {
  ACHIEVEMENTS, GROUPS, TIERS, TIER_ORDER, MAX_POINTS, getAchievement, pointsOf, progressOf, streakNow,
} from '../core/achievements.js';
import { loadCareer, saveCareer, recordMatch, favoriteCategory } from '../core/career.js';
import { badge, unlockedThisMatch, clearAchievementPops } from './achievementView.js';
import { getSettings, updateSettings } from './settingsView.js';

const FILTERS = ['all', 'earned', 'locked'];
let filter = 'all';

function stat(label, value, detail) {
  return h('div', { class: 'career-stat' },
    h('dt', {}, label),
    h('dd', {}, h('strong', {}, value), detail && h('span', { class: 'career-stat__by' }, detail)));
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "3 days" now, "best 5" beside it (a streak counts until a whole period passes without play). */
function streakStat(career, kind, label, unit) {
  const now = streakNow(career, kind);
  const best = career.streaks[kind].best;
  return stat(label, plural(now, unit), best > now ? `best ${plural(best, unit)}` : null);
}

function bestWinStreak(career) {
  const top = Object.values(career.mayors).sort((a, b) => b.bestStreak - a.bestStreak || a.name.localeCompare(b.name))[0];
  return top?.bestStreak ? top : null;
}

/** Score, overall progress, tier tally and the most recent unlocks. */
function renderSummary(career) {
  const earned = ACHIEVEMENTS.filter((a) => career.achievements[a.id]);
  const points = earned.reduce((n, a) => n + pointsOf(a), 0);
  $('#career-badge-count').textContent = `${earned.length} / ${ACHIEVEMENTS.length}`;
  $('#career-score').textContent = `${points.toLocaleString('en-US')} / ${MAX_POINTS.toLocaleString('en-US')} pts`;
  const bar = $('#career-progress');
  bar.value = earned.length;
  bar.max = ACHIEVEMENTS.length;
  bar.textContent = `${earned.length} of ${ACHIEVEMENTS.length}`;
  $('#career-tiers').replaceChildren(...TIER_ORDER.map((tier) => {
    const all = ACHIEVEMENTS.filter((a) => a.tier === tier);
    return h('li', { class: 'tier-tally__item', dataset: { tier } },
      h('span', { class: 'tier-tally__dot', 'aria-hidden': 'true' }),
      `${TIERS[tier].label} ${all.filter((a) => career.achievements[a.id]).length} / ${all.length}`);
  }));
  const latest = earned.sort((a, b) => career.achievements[b.id].at - career.achievements[a.id].at).slice(0, 3);
  const recent = $('#career-latest');
  recent.hidden = latest.length === 0;
  $('#career-latest-list').replaceChildren(...latest.flatMap((a, i) => [
    i ? ', ' : '', h('strong', {}, a.name), ` (${career.achievements[a.id].by})`]));
}

/** Every badge, grouped; the filter hides earned or locked ones (and groups left empty). */
function renderBadges(career) {
  const now = Date.now();
  $('#career-badges').replaceChildren(...GROUPS.map((group) => {
    const defs = ACHIEVEMENTS.filter((a) => a.group === group.id);
    const got = defs.filter((a) => career.achievements[a.id]).length;
    const items = defs.map((a) => {
      const earned = career.achievements[a.id];
      const li = badge(a, earned, { progress: earned ? null : progressOf(a, career, now) });
      li.hidden = (filter === 'earned' && !earned) || (filter === 'locked' && Boolean(earned));
      return li;
    });
    const headingId = `badge-group-${group.id}`;
    return h('section', { class: 'badge-group', dataset: { group: group.id }, hidden: items.every((li) => li.hidden), 'aria-labelledby': headingId },
      h('h4', { class: 'badge-group__title', id: headingId }, group.label, ' ', h('span', { class: 'badge-group__count' }, `${got} / ${defs.length}`)),
      h('ul', { class: 'badges' }, ...items));
  }));
  for (const btn of document.querySelectorAll('[data-badge-filter]')) btn.setAttribute('aria-pressed', String(btn.dataset.badgeFilter === filter));
}

export function renderCareer() {
  const { career, corrupt } = loadCareer();
  const t = career.totals;
  const fav = favoriteCategory(career);
  const streaker = bestWinStreak(career);
  $('#career-empty').hidden = t.matches > 0;
  $('#career-stats').replaceChildren(
    stat('Matches completed', String(t.matches)),
    stat('Blocks captured', String(t.blocksCaptured)),
    stat('Longest capture chain', String(t.longestChain.count), t.longestChain.by),
    stat('Buildings developed', String(t.developments)),
    stat('Highest City Value', formatCash(t.highestCityValue.value), t.highestCityValue.by),
    stat('Hostile takeovers', String(t.takeovers)),
    stat('Bankruptcies', String(t.bankruptcies)),
    stat('Events survived', String(t.eventsSurvived)),
    stat('Favourite development', fav ? getCategory(fav).label : '—', fav ? `${career.categories[fav]} built` : null),
    stat('Best win streak', streaker ? String(streaker.bestStreak) : '0', streaker?.name),
    stat('Days played', String(t.daysPlayed)),
    streakStat(career, 'day', 'Daily streak', 'day'),
    streakStat(career, 'week', 'Weekly streak', 'week'),
    streakStat(career, 'month', 'Monthly streak', 'month'),
  );
  const mayors = Object.values(career.mayors).sort((a, b) => b.won - a.won || b.played - a.played || a.name.localeCompare(b.name));
  $('#career-mayors tbody').replaceChildren(...(mayors.length
    ? mayors.map((m) => h('tr', {}, h('th', { scope: 'row' }, m.name), h('td', {}, String(m.played)), h('td', {}, String(m.won)), h('td', {}, formatCash(m.best))))
    : [h('tr', {}, h('td', { colspan: 4, class: 'career__none' }, 'No completed matches yet.'))]));
  renderSummary(career);
  renderBadges(career);
  $('#achievement-popups').checked = getSettings().achievementPopups;
  $('#career-note').textContent = corrupt
    ? 'Saved statistics on this device could not be read, so a fresh record was started (the old data was kept aside).'
    : 'Saved on this device. Statistics and streaks count completed matches; many achievements unlock the moment you earn them.';
}

/**
 * Records a finished match (only if it was genuinely played to the end) and shows every
 * achievement earned in it on the results screen: those unlocked during play and those the
 * final result brings. Pending pop-ups are dropped (this list replaces them). Never throws.
 */
export function recordFinishedMatch(game) {
  clearAchievementPops();
  let unlocked = [];
  try {
    const { career } = loadCareer();
    const result = recordMatch(career, game);
    if (result.recorded) saveCareer(result.career);
    unlocked = result.unlocked;
  } catch {
    unlocked = [];
  }
  const all = [...unlockedThisMatch(game), ...unlocked].filter((u, i, list) => getAchievement(u.id) && list.findIndex((x) => x.id === u.id) === i);
  // Rarest first: a platinum badge leads the list.
  all.sort((a, b) => TIER_ORDER.indexOf(getAchievement(b.id).tier) - TIER_ORDER.indexOf(getAchievement(a.id).tier));
  const section = $('#results-unlocked');
  section.hidden = all.length === 0;
  $('#unlocked-count').textContent = all.length ? `(${all.length} · +${all.reduce((n, u) => n + pointsOf(getAchievement(u.id)), 0)} pts)` : '';
  $('#results-badges').replaceChildren(...all.map((u) => {
    const def = getAchievement(u.id);
    const li = badge(def, { by: u.by, at: Date.now() }, { compact: true });
    li.querySelector('.badge__desc').textContent = `${u.by} · ${def.text}`;
    return li;
  }));
  return all;
}

export function initCareerView() {
  bus.on('screen:shown', ({ name }) => { if (name === 'stats') renderCareer(); });
  document.querySelector('[data-screen="stats"]')?.addEventListener('click', (e) => {
    const next = e.target.closest('[data-badge-filter]')?.dataset.badgeFilter;
    if (!FILTERS.includes(next) || next === filter) return;
    filter = next;
    renderBadges(loadCareer().career);
  });
  // The pop-ups switch lives beside the badges (Settings has no room on a short desktop screen).
  $('#achievement-popups')?.addEventListener('change', (e) => updateSettings({ achievementPopups: e.target.checked }));
}
