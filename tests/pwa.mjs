/**
 * Offline / PWA browser check. Serves the site under /GRIDLOCK/ (a GitHub Pages
 * project subpath), then:
 *   1. online first visit: service worker installs, manifest + icons resolve;
 *   2. fully offline (server stopped *and* browser offline): the game reloads,
 *      continues the autosave, keeps playing, and autosaves again;
 *   3. safe update: a new sw.js installs and waits while the game keeps running
 *      on the old version; "Reload" saves, switches versions, drops old caches.
 * Screenshots land in test-results/.
 */
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { startServer } from './serve.mjs';

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    const globalRoot = execSync('npm root -g').toString().trim();
    return createRequire(`${globalRoot}/`)('playwright');
  }
}

const BASE_PATH = '/GRIDLOCK/';
const playwright = await loadPlaywright();
const browserName = process.env.BROWSER ?? 'chromium';
const browserType = playwright[browserName];
if (!['chromium', 'webkit', 'firefox'].includes(browserName) || !browserType) {
  throw new Error(`Unsupported BROWSER=${browserName}; expected chromium, webkit, or firefox`);
}
const launchOpts = browserName === 'chromium' && process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};
const VERSION = (await readFile(new URL('../sw.js', import.meta.url), 'utf8')).match(/const VERSION = '([0-9a-f]+)'/)[1];
const PRECACHE_COUNT = (await readFile(new URL('../sw.js', import.meta.url), 'utf8')).match(/const PRECACHE = \[([\s\S]*?)\];/)[1]
  .split('\n').filter((line) => line.trim().startsWith("'")).length;

await mkdir('test-results', { recursive: true });
let server = await startServer(0, { base: BASE_PATH });
const port = server.address().port;
const base = `http://127.0.0.1:${port}${BASE_PATH}`;
const stopServer = () => new Promise((done) => { server.closeAllConnections(); server.close(done); });

const browser = await browserType.launch(launchOpts);
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
await context.addInitScript(() => {
  if (!sessionStorage.getItem('gl-test-init')) {
    sessionStorage.setItem('gl-test-init', '1');
    localStorage.setItem('gridlock.settings.v1', JSON.stringify({ confirmTaps: false, quickHandoff: true }));
  }
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
page.on('requestfailed', (request) => errors.push(`requestfailed: ${request.url()} (${request.failure()?.errorText})`));
page.on('response', (response) => { if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`); });

const road = (id) => page.locator(`#board [data-road="${id}"]`);
const roadsPaved = async () => (await page.textContent('#hud-roads')).split('/')[0];
async function pave(id) {
  while (await page.locator('#capture-choice-dialog[open]').count()) await page.click('[data-capture-choice="vacant"]');
  if (await page.locator('#event-dialog[open]').count()) await page.click('#event-continue');
  if (await page.locator('#action-pave:visible').count()) await page.click('#action-pave');
  await road(id).click();
  if (await page.locator('#event-dialog[open]').count()) await page.click('#event-continue');
}
/** Asks the controlling service worker for its cache version. */
const controllerVersion = () => page.evaluate(() => new Promise((resolve) => {
  const controller = navigator.serviceWorker.controller;
  if (!controller) return resolve(null);
  const channel = new MessageChannel();
  channel.port1.onmessage = (e) => resolve(e.data.version);
  controller.postMessage({ type: 'GET_VERSION' }, [channel.port2]);
}));
const gameCaches = () => page.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith('gridlock-')).sort());

let failed = false;
try {
  console.log(`Running PWA/offline checks in ${browserName} at ${base}`);
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForSelector('html.is-ready');
  assert.ok(await page.evaluate(() => 'serviceWorker' in navigator && window.isSecureContext), 'service workers available');

  // --- 1. Online first visit ------------------------------------------------
  await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 60_000 });
  assert.equal(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).scope), base, 'scoped to the subpath');
  assert.equal(await controllerVersion(), VERSION);
  assert.deepEqual(await gameCaches(), [`gridlock-precache-${VERSION}`]);
  assert.equal(await page.evaluate(async (name) => (await (await caches.open(name)).keys()).length, `gridlock-precache-${VERSION}`), PRECACHE_COUNT,
    'every precache file installed');

  const manifest = await page.evaluate(async () => {
    const href = document.querySelector('link[rel="manifest"]').href;
    const json = await (await fetch(href)).json();
    const icons = await Promise.all(json.icons.map(async (icon) => {
      const res = await fetch(new URL(icon.src, href));
      return { ok: res.ok, type: res.headers.get('content-type'), purpose: icon.purpose };
    }));
    return { start: new URL(json.start_url, href).href, scope: new URL(json.scope, href).href, display: json.display, icons };
  });
  assert.equal(manifest.start, base, 'start_url resolves to the subpath');
  assert.equal(manifest.scope, base);
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.every((i) => i.ok && i.type === 'image/png'), `icons load: ${JSON.stringify(manifest.icons)}`);
  assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'));

  // Start a game online and make a few moves so there's an autosave.
  await page.getByRole('button', { name: 'New Game' }).click();
  await page.click('#setup-start');
  for (const id of ['h-0-0', 'v-0-0', 'h-1-0']) await pave(id);
  assert.equal(await roadsPaved(), '3');
  console.log('✔ online: installed, precached, manifest + icons, subpath scope');

  // --- 2. Fully offline -----------------------------------------------------
  await stopServer();
  // Playwright's WebKit offline emulation fails navigations before the service worker can answer
  // (Safari itself serves them offline). There the stopped server is the whole offline test: the
  // site has no network at all. Chromium and Firefox also go fully offline.
  const emulateOffline = browserName !== 'webkit';
  if (emulateOffline) await context.setOffline(true);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('html.is-ready');
  assert.ok(await page.isVisible('[data-screen="title"]'), 'title screen offline');
  assert.equal(await page.locator('[data-sprite]').count(), 0, 'sprites hydrated offline');
  assert.ok(await page.evaluate(async () => {
    await document.fonts.ready;
    return document.fonts.check('24px "Lilita One"') && document.fonts.check('800 16px Nunito');
  }), 'self-hosted fonts load offline');
  const offlineAssets = await page.evaluate(async () => {
    const urls = [...document.querySelectorAll('link[href]')].map((l) => l.href)
      .concat(['assets/generated/effects.webp', 'assets/generated/roads-infrastructure.webp', 'js/core/board.js'].map((u) => new URL(u, document.baseURI).href));
    const results = await Promise.all(urls.map(async (u) => [u, (await fetch(u)).ok]));
    return results.filter(([, ok]) => !ok).map(([u]) => u);
  });
  assert.deepEqual(offlineAssets, [], 'every linked file and sheet served offline');
  assert.ok(await page.isVisible('#continue-game'), 'autosave offered offline');
  await page.click('#continue-game');
  assert.ok(await page.isVisible('[data-screen="game"]'));
  assert.equal(await roadsPaved(), '3', 'continued the saved game');

  // Keep playing offline through a capture (P4 closes A1) and its Develop choice.
  await pave('v-0-1');
  assert.equal(await page.locator('#board .block--green').count(), 1, 'capture works offline');
  await page.click('[data-capture-choice="develop"]');
  await page.locator('#build-dialog [data-build="residential"]').click();
  assert.ok(await page.locator('[data-block="r0c0"] .block__building').count(), 'building art renders offline');
  await pave('h-6-5');
  const offlineRoads = await roadsPaved();
  await page.screenshot({ path: 'test-results/pwa-offline.png' });

  // A deep link with a query string still opens the cached game offline.
  await page.goto(`${base}?seed=3`, { waitUntil: 'load' });
  await page.waitForSelector('html.is-ready');
  await page.click('#continue-game');
  assert.equal(await roadsPaved(), offlineRoads, 'offline progress autosaved');
  assert.deepEqual(errors, [], 'no failed requests or errors offline');
  console.log('✔ offline: reload, continue autosave, capture + develop, deep link, autosave');

  // --- 3. Safe update -------------------------------------------------------
  server = await startServer(port, { base: BASE_PATH });
  if (emulateOffline) await context.setOffline(false);
  const NEXT = `${VERSION}-next`;
  server.overrides.set('sw.js', (src) => src.replace(`const VERSION = '${VERSION}';`, `const VERSION = '${NEXT}';`));
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await page.locator('#update-banner').waitFor({ state: 'visible', timeout: 60_000 });
  assert.match(await page.textContent('#update-banner'), /new version/);
  assert.equal(await controllerVersion(), VERSION, 'old version keeps running until the player chooses');
  const beforeUpdate = await roadsPaved();
  await pave('h-6-4');
  assert.equal(await roadsPaved(), String(Number(beforeUpdate) + 1), 'game keeps working while the update waits');

  await page.click('#update-later');
  assert.equal(await page.isVisible('#update-banner'), false, 'Later hides the prompt');
  await page.reload({ waitUntil: 'load' });
  await page.locator('#update-banner').waitFor({ state: 'visible' });
  assert.equal(await controllerVersion(), VERSION, 'a plain reload never forces the update');
  await page.screenshot({ path: 'test-results/pwa-update-ready.png' });

  await page.click('#continue-game');
  await pave('h-6-3');
  const savedRoads = await roadsPaved();
  await Promise.all([page.waitForEvent('load'), page.click('#update-reload')]);
  await page.waitForSelector('html.is-ready');
  assert.equal(await controllerVersion(), NEXT, 'new version took over after Reload');
  assert.deepEqual(await gameCaches(), [`gridlock-precache-${NEXT}`], 'old caches removed');
  assert.equal(await page.isVisible('#update-banner'), false);
  await page.click('#continue-game');
  assert.equal(await roadsPaved(), savedRoads, 'the game in progress survived the update');
  assert.deepEqual(errors, []);
  console.log('✔ update: waits, Later, reload keeps old version, Reload saves + switches + cleans caches');
} catch (err) {
  failed = true;
  console.error(`✘ pwa: ${err.message}`);
  await page.screenshot({ path: 'test-results/pwa-FAIL.png' }).catch(() => {});
} finally {
  await browser.close();
  await stopServer().catch(() => {});
}

if (failed) process.exit(1);
console.log('\nPWA/offline checks passed.');
