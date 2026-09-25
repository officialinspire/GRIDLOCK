/** Grid Lock City — app bootstrap. */
import { hydrateSprites } from './assets.js';
import { bindNavigation, showScreen } from './ui/router.js';
import { initSettingsView } from './ui/settingsView.js';
import { initSetupView } from './ui/setupView.js';
import { initGameView } from './ui/gameView.js';

function boot() {
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
