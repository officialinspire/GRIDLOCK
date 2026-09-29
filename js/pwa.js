/**
 * Installable, offline-first app: registers sw.js and handles updates safely.
 *
 * A new version downloads in the background and waits. The player sees
 * "Update ready" and chooses when to reload; the game in progress is saved
 * first, and the new version only takes over on that reload, so code and
 * assets never change mid-game. See sw.js for the caching strategy.
 */
import { $ } from './ui/dom.js';

/**
 * @param {{ beforeReload?: () => void }} opts  beforeReload saves the game in progress
 */
export function initPwa({ beforeReload = () => {} } = {}) {
  // Service workers need a secure context (https or localhost); elsewhere the game just runs online.
  if (!('serviceWorker' in navigator)) return;
  const banner = $('#update-banner');
  let reloading = false;

  const offerUpdate = (worker) => {
    banner.hidden = false;
    $('#update-reload').onclick = () => {
      beforeReload();
      $('#update-reload').disabled = true;
      worker.postMessage({ type: 'SKIP_WAITING' });
    };
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
    if (reloading) return;
    reloading = true;
    beforeReload();
    window.location.reload();
  });

  const register = async () => {
    try {
      // Relative URL + './' scope: works at the domain root and under a Pages project subpath.
      // updateViaCache 'none' checks sw.js past the HTTP cache (GitHub Pages caches files for 10 minutes).
      const registration = await navigator.serviceWorker.register('sw.js', { scope: './', updateViaCache: 'none' });
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
