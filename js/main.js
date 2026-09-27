/** Grid Lock City — app bootstrap. */
import { hydrateSprites, createSprite } from './assets.js';
import { ART } from './art.js';
import { ECONOMY } from './config.js';
import { formatCash } from './core/economy.js';
import { bindNavigation, showScreen } from './ui/router.js';
import { initSettingsView } from './ui/settingsView.js';
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

/** Fills `[data-econ="KEY"]` text from ECONOMY so copy never drifts from the constants. */
function fillEconomyCopy(root = document) {
  root.querySelectorAll('[data-econ]').forEach((el) => {
    const value = ECONOMY[el.dataset.econ];
    if (Number.isFinite(value)) el.textContent = formatCash(value);
  });
}

/** Fills `[data-art-decor="key"]` containers with the prop list ART[key]. */
function placeDecor(root = document) {
  root.querySelectorAll('[data-art-decor]').forEach((box) => {
    const items = ART[box.dataset.artDecor] ?? [];
    box.replaceChildren(...items.map(({ sprite, spot }) => {
      const el = createSprite(sprite);
      el.dataset.spot = spot;
      return el;
    }));
  });
}

/**
 * A challenge link (?seed=…&mode=…&seats=…) pre-fills New Game, then leaves the address bar
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
  toast(`Challenge city ${formatSeed(challenge.seed)}${mode} is ready. Tap New Game.`, { tone: 'success', duration: 4200 });
}

function boot() {
  fillEconomyCopy();
  placeDecor();
  initAudio({ bus });
  initHaptics(loadSettings());
  initTouchGuard();
  initSettingsView();
  hydrateSprites(document);
  initSetupView();
  initCareerView();
  initGameView();
  bindNavigation(document);
  showScreen('title');
  acceptChallengeLink();
  // ?debug exposes the live game for automated tests and bug reproduction (never on by default).
  if (new URLSearchParams(window.location.search).has('debug')) window.__GRIDLOCK__ = { getGame, audio: () => audio.state(), tutorial: tutorialState };
  document.documentElement.classList.add('is-ready');
  initPwa({ beforeReload: saveGameNow });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
