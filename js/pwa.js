/**
 * Installable, offline-first app: registers sw.js and handles updates safely.
 *
 * A new version downloads in the background and waits. The player sees
 * "Update ready" and chooses when to reload; the game in progress is saved
 * first, and the new version only takes over on that reload, so code and
 * assets never change mid-game. Settings › Check for Updates looks for a new
 * version on demand and switches to it the same way. See sw.js for the caching strategy.
 */
import { APP_VERSION } from './config.js';
import { $ } from './ui/dom.js';
import { toast } from './ui/toast.js';

/**
 * After Reload, the page reloads as soon as the new version takes control ('controllerchange')
 * or reaches 'activated' (iOS home-screen apps can miss controllerchange), and after this long
 * at the latest, so the button can never hang on "Updating…".
 */
export const UPDATE_RELOAD_TIMEOUT_MS = 4000;

/**
 * @param {{ beforeReload?: () => void }} opts  beforeReload saves the game in progress
 */
export function initPwa({ beforeReload = () => {} } = {}) {
  const banner = $('#update-banner');
  const reloadButton = $('#update-reload');
  const checkButton = $('#check-updates');
  const versionLabel = $('#app-version');
  versionLabel.textContent = `v${APP_VERSION}`;
  let registration = null;
  let reloading = false;

  // Saving can never stop the update: a game that can't be saved still gets the new version.
  const save = () => {
    try {
      beforeReload();
    } catch (err) {
      console.warn('[pwa] could not save before reloading:', err);
    }
  };
  const reload = () => {
    if (reloading) return;
    reloading = true;
    save();
    window.location.reload();
  };

  // Service workers need a secure context (https or localhost); elsewhere the game just runs
  // online, so every load already fetches the latest version.
  if (!('serviceWorker' in navigator)) {
    checkButton.onclick = reload;
    return;
  }

  /** Lets `worker` (the version waiting to take over) take control, then reloads into it. */
  const applyUpdate = (worker) => {
    if (reloading) return;
    banner.hidden = false;
    reloadButton.disabled = true;
    reloadButton.textContent = 'Updating…';
    checkButton.disabled = true;
    save();
    // Nothing left waiting (another tab already switched versions): the reload picks it up.
    if (!worker || worker.state === 'activated' || worker.state === 'redundant') {
      reload();
      return;
    }
    worker.addEventListener('statechange', () => { if (worker.state === 'activated') reload(); });
    worker.postMessage({ type: 'SKIP_WAITING' });
    setTimeout(reload, UPDATE_RELOAD_TIMEOUT_MS);
  };

  const offerUpdate = (worker) => {
    if (reloading) return;
    banner.hidden = false;
    reloadButton.disabled = false;
    reloadButton.textContent = 'Reload';
    // Whatever is waiting when the player taps: a newer version may have arrived since.
    reloadButton.onclick = () => applyUpdate(registration?.waiting ?? worker);
    $('#update-later').onclick = () => { banner.hidden = true; };
  };

  // The very first install just takes control (no reload needed). Any later change of controller
  // is an update, accepted here or in another tab: save, then reload into the new version.
  let controlled = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!controlled) {
      controlled = true;
      return;
    }
    reload();
  });

  /** Settings › Check for Updates: looks for a new version now and switches to it if there is one. */
  const checkForUpdate = async () => {
    // Not registered (it failed, or hasn't finished yet): a plain reload fetches what it can.
    if (!registration) {
      reload();
      return;
    }
    const done = (message, tone) => {
      checkButton.disabled = false;
      checkButton.textContent = 'Check for Updates';
      toast(message, { tone, duration: 3600 });
    };
    checkButton.disabled = true;
    checkButton.textContent = 'Checking…';
    try {
      await registration.update();
    } catch {
      done('Couldn’t check for updates. Check your connection and try again.', 'warn');
      return;
    }
    const pending = registration.installing ?? registration.waiting;
    if (!pending) {
      done(`You have the latest version (v${APP_VERSION}).`, 'success');
      return;
    }
    if (pending.state === 'installing') {
      checkButton.textContent = 'Downloading…';
      const installed = await new Promise((resolve) => {
        pending.addEventListener('statechange', () => {
          if (pending.state === 'redundant') resolve(false);
          else if (pending.state !== 'installing') resolve(true);
        });
      });
      if (!installed) {
        done('The update didn’t finish downloading. Try again in a moment.', 'warn');
        return;
      }
    }
    applyUpdate(registration.waiting ?? pending);
  };
  checkButton.onclick = () => { checkForUpdate(); };

  const register = async () => {
    try {
      // Relative URL + './' scope: works at the domain root and under a Pages project subpath.
      // updateViaCache 'none' checks sw.js past the HTTP cache (GitHub Pages caches files for 10 minutes).
      registration = await navigator.serviceWorker.register('sw.js', { scope: './', updateViaCache: 'none' });
      const watch = (worker) => {
        if (!worker) return;
        // A real update is installed and *waiting* behind the worker that controls this page.
        // (WebKit can deliver the first install's 'installed' event after that same worker has
        // already activated and taken control; it is then no longer waiting, so no banner.)
        const ready = () => worker.state === 'installed' && navigator.serviceWorker.controller
          && registration.waiting === worker;
        if (ready()) offerUpdate(worker);
        else worker.addEventListener('statechange', () => { if (ready()) offerUpdate(worker); });
      };
      watch(registration.waiting ?? registration.installing);
      registration.addEventListener('updatefound', () => watch(registration.installing));
      // Long-lived installed apps: look for a new version whenever the game comes back to the foreground.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') registration.update().catch(() => {});
      });
    } catch (err) {
      // Offline support is an enhancement; the game itself is unaffected.
      console.warn('[pwa] service worker registration failed:', err);
    }
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
