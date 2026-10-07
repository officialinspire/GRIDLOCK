/**
 * Achievements in play and their papercraft badges (rules in core/achievements.js, storage and
 * unlocking in core/career.js).
 *
 * - watchAchievements(game) runs after every draw of the game screen: when the move log or ledger
 *   has changed, it unlocks any live achievement a person has just earned, saves the career and
 *   queues a pop-up.
 * - Pop-ups show one at a time at the top of the screen. They wait while a dialog is open or
 *   another screen is showing, so they never cover a choice, and they never take focus or clicks.
 *   The results screen lists the match's unlocks itself, so pending pop-ups are dropped then.
 * - badge() draws the rosette cards for the Statistics and results screens.
 */
import { $, h } from './dom.js';
import { createSprite } from '../assets.js';
import { play } from './audio.js';
import { TIERS, getAchievement, pointsOf } from '../core/achievements.js';
import { loadCareer, saveCareer, unlockLive } from '../core/career.js';
import { trackGameEvent } from '../analytics.js';

const SHOW_MS = 3600;
const BUSY_SHOW_MS = 2200; // when more are waiting
const LEAVE_MS = 280;
const RETRY_MS = 400;

let getSettings = () => ({ achievementPopups: true });
const queue = [];
let current = null;
let timer = null;
let retry = null;
const announced = new Set(); // ids shown this session (storage may refuse to keep them)
let watched = null; // { game, key, unlocked }

const dateFormat = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const reducedMotion = () => document.documentElement.dataset.motion === 'reduced'
  || Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/* ---------------- badges ---------------- */

/** The rosette: tier colours, the badge's art (or "?" for a secret one still locked). */
export function rosette(def, { hidden = false } = {}) {
  return h('span', { class: 'badge__rosette', dataset: { tier: def.tier }, 'aria-hidden': 'true' },
    hidden ? h('span', { class: 'badge__secret' }, '?') : createSprite(def.icon, { className: 'badge__icon' }));
}

const tierLine = (def) => `${TIERS[def.tier].label} · ${pointsOf(def)} pts`;

/**
 * One achievement card. `earned` is { by, at } or null; `progress` [have, need] for goals built
 * up over several matches; `compact` (results screen) drops the date line.
 */
export function badge(def, earned, { compact = false, progress = null } = {}) {
  const hidden = def.secret && !earned;
  const share = progress && !earned ? Math.round((progress[0] / progress[1]) * 100) : null;
  return h('li', {
    class: `badge${earned ? ' is-earned' : ' is-locked'}${hidden ? ' is-secret' : ''}`,
    dataset: { achievement: def.id, tier: def.tier },
  },
  rosette(def, { hidden }),
  h('span', { class: 'badge__text' },
    h('strong', { class: 'badge__name' }, hidden ? 'Secret achievement' : def.name),
    h('span', { class: 'badge__desc' }, hidden ? 'Keep playing to discover it.' : def.text),
    h('span', { class: 'badge__tier' }, tierLine(def)),
    share != null && h('span', { class: 'badge__progress' },
      h('span', { class: 'badge__bar', 'aria-hidden': 'true' }, h('span', { class: 'badge__fill', style: { width: `${share}%` } })),
      h('span', { class: 'badge__count' }, `${progress[0].toLocaleString('en-US')} / ${progress[1].toLocaleString('en-US')}`)),
    !compact && h('span', { class: 'badge__earned' },
      earned ? `${earned.by} · ${dateFormat.format(earned.at)}` : 'Not earned yet')),
  h('span', { class: 'visually-hidden' }, earned ? ' (earned)' : ' (locked)'));
}

/* ---------------- pop-ups ---------------- */

/** Something else needs the table: a dialog, another screen, or a hidden page. */
const tableBusy = () => Boolean(document.querySelector('dialog[open]'))
  || document.body.dataset.activeScreen !== 'game'
  || document.visibilityState === 'hidden';

function popup({ id, by }) {
  const def = getAchievement(id);
  return h('div', { class: 'achievement-pop', dataset: { tier: def.tier, achievement: id } },
    rosette(def),
    h('span', { class: 'achievement-pop__text' },
      h('span', { class: 'achievement-pop__kicker' }, `${TIERS[def.tier].label} achievement · +${pointsOf(def)} pts`),
      h('strong', { class: 'achievement-pop__name' }, def.name),
      h('span', { class: 'achievement-pop__desc' }, `${by} · ${def.text}`)));
}

function finish() {
  clearTimeout(timer);
  timer = null;
  const el = current;
  current = null;
  if (!el) return pump();
  if (reducedMotion()) {
    el.remove();
    return pump();
  }
  el.classList.add('is-leaving');
  timer = setTimeout(() => {
    el.remove();
    timer = null;
    pump();
  }, LEAVE_MS);
}

function pump() {
  if (current || timer || !queue.length) return;
  if (tableBusy()) {
    clearTimeout(retry);
    retry = setTimeout(() => { retry = null; pump(); }, RETRY_MS);
    return;
  }
  const stack = $('#achievement-pops');
  if (!stack) return void queue.splice(0);
  current = popup(queue.shift());
  stack.append(current);
  play('achievement');
  timer = setTimeout(() => { timer = null; finish(); }, queue.length ? BUSY_SHOW_MS : SHOW_MS);
}

/** Queues pop-ups for newly earned achievements ({ id, by }), unless pop-ups are switched off. */
export function announceAchievements(unlocked) {
  const fresh = unlocked.filter((u) => getAchievement(u.id) && !announced.has(u.id));
  for (const u of fresh) announced.add(u.id);
  if (!fresh.length || getSettings().achievementPopups === false) return;
  queue.push(...fresh);
  pump();
}

/** Drops pending and showing pop-ups (results opened, game left or replaced). */
export function clearAchievementPops() {
  queue.splice(0);
  clearTimeout(timer);
  clearTimeout(retry);
  timer = null;
  retry = null;
  current = null;
  $('#achievement-pops')?.replaceChildren();
}

/* ---------------- live unlocks ---------------- */

/**
 * After a draw of the game screen: unlocks live achievements people have just earned (only when
 * the move log or ledger changed since the last look), saves them and announces them.
 */
export function watchAchievements(game) {
  if (!game || game.phase !== 'playing') return;
  if (watched?.game !== game) watched = { game, key: null, unlocked: [] };
  const key = `${game.log.length}|${game.ledger.length}`;
  if (key === watched.key) return;
  watched.key = key;
  try {
    const { career } = loadCareer();
    const result = unlockLive(career, game);
    if (!result.unlocked.length) return;
    if (saveCareer(result.career)) {
      for (const item of result.unlocked) trackGameEvent('achievement_unlocked', { achievement: item.id }, item.id);
    }
    watched.unlocked.push(...result.unlocked);
    announceAchievements(result.unlocked);
  } catch {
    // achievements never get in the way of play
  }
}

/** Live achievements this game has unlocked so far in this session (for the results screen). */
export const unlockedThisMatch = (game) => (watched?.game === game ? [...watched.unlocked] : []);

export function initAchievementView(deps = {}) {
  if (deps.getSettings) getSettings = deps.getSettings;
}
