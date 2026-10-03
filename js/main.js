/** Grid Lock City — app bootstrap. */
import { hydrateSprites, createSprite } from './assets.js';
import { ART } from './art.js';
import { ECONOMY } from './config.js';
import { formatCash } from './core/economy.js';
import { bindNavigation } from './ui/router.js';
import { initSettingsView, getSettings } from './ui/settingsView.js';
import { initStartView } from './ui/startView.js';
import { initSetupView, applyChallenge } from './ui/setupView.js';
import { toast } from './ui/toast.js';
import { readChallenge, withoutChallenge, formatSeed } from './core/challenge.js';
import { getMode } from './core/modes.js';
import { initGameView, getGame, saveGameNow } from './ui/gameView.js';
import { initPwa } from './pwa.js';
import { audio, initAudio } from './ui/audio.js';
import { initHaptics } from './ui/haptics.js';
import { initTouchGuard } from './ui/touchGuard.js';
import { tutorialState } from './ui/tutorial.js';
import { initCareerView } from './ui/careerView.js';
import { loadSettings } from './core/settings.js';
import { bus } from './core/bus.js';
import { DEBUG_PERF, perfReport, perfReset, perfStats } from './core/perf.js';

/** Fills `[data-econ="KEY"]` text from ECONOMY so copy never drifts from the constants. */
function fillEconomyCopy(root = document) {
  root.querySelectorAll('[data-econ]').forEach((el) => {
    const value = ECONOMY[el.dataset.econ];
    if (Number.isFinite(value)) el.textContent = formatCash(value);
  });
}

/** Builds every `[data-downtown]` street: sidewalk buildings and props, the road and its traffic. */
function buildDowntown(root = document) {
  root.querySelectorAll('[data-downtown]').forEach((box) => {
    const row = document.createElement('div');
    row.className = 'downtown__row';
    row.append(...ART.downtown.map(({ sprite, size, prop, from }) => {
      const el = createSprite(sprite, { className: prop ? 'downtown__prop' : 'downtown__building' });
      el.style.setProperty('--size', size);
      if (from) el.dataset.from = from;
      return el;
    }));
    const road = document.createElement('div');
    road.className = 'downtown__road';
    road.append(...ART.downtownTraffic.map(({ sprite, lane, at }) => {
      const el = createSprite(sprite, { className: `downtown__car downtown__car--${lane}` });
      el.style.setProperty('--at', `${at}%`);
      el.style.setProperty('--at-n', at / 100); // where it is in its drive, when moving
      return el;
    }));
    const sidewalk = document.createElement('div');
    sidewalk.className = 'downtown__sidewalk';
    box.replaceChildren(row, sidewalk, road);
  });
}

/**
 * A challenge link (?seed=…&mode=…&seats=…) pre-fills the New Game screen, then leaves the address bar
 * so a later reload or bookmark isn't pinned to that city. Other parameters are kept.
 */
function acceptChallengeLink() {
  const challenge = readChallenge(window.location.search);
  if (!challenge) return;
  try {
    window.history.replaceState(window.history.state, '', withoutChallenge(window.location.href));
  } catch { /* the link still works; the address just keeps its parameters */ }
  if (challenge.invalid) {
    toast('That challenge link has no valid city seed. New games will be random.', { tone: 'warn', duration: 4200 });
    return;
  }
  applyChallenge(challenge);
  const mode = challenge.mode ? ` · ${getMode(challenge.mode).name} rules` : '';
  toast(`Challenge city ${formatSeed(challenge.seed)}${mode} is ready. Choose how to play it.`, { tone: 'success', duration: 4200 });
}

function boot() {
  fillEconomyCopy();
  buildDowntown();
  initAudio({ bus });
  initHaptics(loadSettings());
  initTouchGuard();
  initSettingsView();
  hydrateSprites(document);
  initSetupView();
  initCareerView();
  initGameView();
  bindNavigation(document);
  // A new session opens on the start screen and the INSPIRE intro; a challenge link is announced
  // once the main menu is showing.
  let announced = false;
  const start = initStartView({ getSettings, onMenu: () => { if (!announced) { announced = true; acceptChallengeLink(); } } });
  start.show();
  // ?debug exposes the live game for automated tests and bug reproduction (never on by default).
  if (new URLSearchParams(window.location.search).has('debug')) window.__GRIDLOCK__ = { getGame, audio: () => audio.state(), tutorial: tutorialState };
  // ?perf times render, autosave, CPU planning, forecasts and turn resolution (js/core/perf.js; never on by default).
  if (DEBUG_PERF) window.__GRIDLOCK_PERF__ = { report: perfReport, reset: perfReset, stats: perfStats };
  document.documentElement.classList.add('is-ready');
  initPwa({ beforeReload: saveGameNow });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
