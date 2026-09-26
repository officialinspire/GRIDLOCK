/** Grid Lock City — app bootstrap. */
import { hydrateSprites } from './assets.js';
import { ECONOMY } from './config.js';
import { formatCash } from './core/economy.js';
import { bindNavigation, showScreen } from './ui/router.js';
import { initSettingsView } from './ui/settingsView.js';
import { initSetupView } from './ui/setupView.js';
import { initGameView } from './ui/gameView.js';

/** Fills `[data-econ="KEY"]` text from ECONOMY so copy never drifts from the constants. */
function fillEconomyCopy(root = document) {
  root.querySelectorAll('[data-econ]').forEach((el) => {
    const value = ECONOMY[el.dataset.econ];
    if (Number.isFinite(value)) el.textContent = formatCash(value);
  });
}

function boot() {
  fillEconomyCopy();
  initSettingsView();
  hydrateSprites(document);
  initSetupView();
  initGameView();
  bindNavigation(document);
  showScreen('title');
  document.documentElement.classList.add('is-ready');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
