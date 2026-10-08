import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { precacheFiles, precacheVersion, updatedServiceWorker, ICONS } from '../../tools/build-pwa.mjs';
import { SHEETS, GENERATED_DIR } from '../../js/assets.js';
import { SAVE_KEY } from '../../js/core/persistence.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => readFile(ROOT + p, 'utf8');
const SCOPE = 'https://example.github.io/GRIDLOCK/';

/** PNG width/height from the IHDR chunk. */
async function pngSize(path) {
  const buf = await readFile(ROOT + path);
  assert.equal(buf.toString('ascii', 1, 4), 'PNG', `${path} is a PNG`);
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

/** Every module reachable from js/main.js through static and dynamic relative imports. */
async function moduleGraph(entry = 'js/main.js', seen = new Set()) {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const src = await read(entry);
  for (const [, spec] of src.matchAll(/(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g)
    .map((m) => [m[0], m[1] ?? m[2]])) {
    await moduleGraph(new URL(spec, `file:///${entry}`).pathname.slice(1), seen);
  }
  return seen;
}

test('sw.js precache list and cache version are up to date (run `npm run build:pwa`)', async () => {
  const { current, next } = await updatedServiceWorker();
  assert.equal(current, next, 'sw.js is stale: run `npm run build:pwa` and commit it');
  const files = await precacheFiles();
  assert.match(current, new RegExp(`const VERSION = '${await precacheVersion(files)}';`));
});

test('the precache holds every file the game loads, and nothing outside the site', async () => {
  const files = new Set(await precacheFiles());
  for (const file of files) {
    assert.ok(!file.startsWith('/') && !file.includes('..'), `${file} is site-relative`);
    assert.ok((await stat(ROOT + file)).isFile(), `${file} exists`);
  }

  // Entry page, manifest and everything index.html links to.
  // Canonical metadata does not load a runtime asset.
  const html = (await read('index.html')).replace(/<link\b(?=[^>]*\brel=["']canonical["'])[^>]*>/gi, '');
  for (const [, url] of html.matchAll(/(?:src|href)=["']([^"'#?]+)["']/g)) {
    assert.ok(files.has(decodeURI(url)), `index.html → ${url} is precached`);
  }
  // All JavaScript modules, including lazily imported ones.
  for (const mod of await moduleGraph()) assert.ok(files.has(mod), `module ${mod} is precached`);
  // Everything the stylesheets reference (fonts, 9-slice frames).
  for (const css of [...files].filter((f) => f.endsWith('.css'))) {
    for (const [, url] of (await read(css)).matchAll(/url\(['"]?(?!data:|#|%23)([^'")]+)['"]?\)/g)) {
      assert.ok(files.has(new URL(url, `file:///${css}`).pathname.slice(1)), `${css} → ${url} is precached`);
    }
  }
  // Every sprite sheet as served (WebP).
  for (const sheet of Object.values(SHEETS)) assert.ok(files.has(sheet.webp), `${sheet.webp} is precached`);
});

test('precache stays lean: PNG sheet fallbacks (browsers without WebP) are fetched on demand; media has its own budget', async () => {
  const files = await precacheFiles();
  for (const sheet of Object.values(SHEETS)) assert.ok(!files.includes(decodeURI(sheet.url)), `${sheet.url} not precached`);
  assert.ok(SHEETS.props.url.startsWith(GENERATED_DIR), 'covers the keyed-out props PNG too');
  let bytes = 0;
  let media = 0;
  for (const file of files) {
    const size = (await stat(ROOT + file)).size;
    if (file.startsWith('assets/media/')) media += size;
    else bytes += size;
  }
  assert.ok(bytes < 7 * 1024 * 1024, `game code and art precache is ${(bytes / 1048576).toFixed(1)} MB`);
  // Music (two streamed themes) and the INSPIRE intro, cached so they also play offline.
  assert.ok(media < 6.5 * 1024 * 1024, `music and intro video are ${(media / 1048576).toFixed(1)} MB`);
});

test('the game needs no network: no external URLs in the page, styles or scripts', async () => {
  for (const file of await precacheFiles()) {
    if (!/\.(?:html|css|js|webmanifest)$/.test(file)) continue;
    const src = (await read(file)).replace(/<link\b(?=[^>]*\brel=["']canonical["'])[^>]*>/gi, '');
    const external = [...src.matchAll(/(?:src|href)=["'](https?:[^"']+)|url\(['"]?(https?:[^'")]+)|@import\s+['"]?(https?:[^'")]+)|import\(?\s*['"](https?:[^'"]+)/g)];
    assert.deepEqual(external.map((m) => m.slice(1).find(Boolean)), [], `${file} loads nothing from the network`);
  }
});

test('web app manifest is installable and subpath-safe', async () => {
  const manifest = JSON.parse(await read('manifest.webmanifest'));
  assert.equal(manifest.name, 'Grid Lock City');
  assert.ok(manifest.short_name.length <= 12, 'short name fits under a home-screen icon');
  for (const key of ['id', 'start_url', 'scope']) assert.equal(manifest[key], './', `${key} is relative to the manifest`);
  assert.equal(manifest.display, 'standalone');
  const html = await read('index.html');
  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest">/);
  assert.equal(manifest.theme_color, html.match(/name="theme-color" content="([^"]+)"/)[1], 'theme colour matches the page');

  const sizes = new Set();
  for (const icon of manifest.icons) {
    assert.ok(!icon.src.startsWith('/') && !/^https?:/.test(icon.src), `${icon.src} is relative`);
    const [w, h] = await pngSize(icon.src);
    assert.equal(icon.sizes, `${w}x${h}`, `${icon.src} declares its real size`);
    sizes.add(`${icon.purpose}:${w}`);
  }
  for (const need of ['any:192', 'any:512', 'maskable:512']) assert.ok(sizes.has(need), `manifest has ${need} icon`);
  assert.deepEqual(await pngSize('assets/icons/apple-touch-icon.png'), [180, 180]);
  assert.match(html, /<link rel="apple-touch-icon" href="assets\/icons\/apple-touch-icon\.png">/);
  for (const [file, size] of ICONS) assert.deepEqual(await pngSize(`assets/icons/${file}`), [size, size], file);
});

test('the page registers sw.js relative to itself, with safe updates', async () => {
  const pwa = await read('js/pwa.js');
  assert.match(pwa, /register\('sw\.js', \{ scope: '\.\/'/, 'relative script URL and scope (Pages subpath)');
  assert.match(pwa, /updateViaCache: 'none'/);
  assert.match(pwa, /beforeReload\(\);[\s\S]*SKIP_WAITING/, 'the game is saved before the new version takes over');
  // Reload never hangs on 'controllerchange' alone (iOS home-screen apps can miss it).
  assert.match(pwa, /worker\.state === 'activated'\) reload\(\)/, 'reloads once the new version is activated');
  assert.match(pwa, /setTimeout\(reload, UPDATE_RELOAD_TIMEOUT_MS\)/, 'reloads after a timeout at the latest');
  assert.match(pwa, /reloadButton\.onclick = \(\) => applyUpdate\(registration\?\.waiting/, 'Reload applies the newest waiting version');
  assert.match(await read('js/main.js'), /initPwa\(\{ beforeReload: saveGameNow \}\)/);
});

// ---------------------------------------------------------------------------
// sw.js itself, run in a simulated ServiceWorkerGlobalScope under a Pages subpath.
// ---------------------------------------------------------------------------

class FakeCache {
  constructor() { this.map = new Map(); }
  key(req) { return typeof req === 'string' ? req : req.url; }
  async match(req) { return this.map.get(this.key(req)); }
  async put(req, res) { this.map.set(this.key(req), res); }
  async addAll(reqs) {
    const responses = await Promise.all(reqs.map(async (req) => {
      const res = await sw.fetch(req);
      if (!res.ok) throw new TypeError(`addAll: ${req.url} → ${res.status}`);
      return [req, res];
    }));
    for (const [req, res] of responses) await this.put(req, res);
  }
}

let sw;
async function loadServiceWorker({ network = true, existingCaches = [] } = {}) {
  const listeners = {};
  const stores = new Map(existingCaches.map((name) => [name, new FakeCache()]));
  const fetched = [];
  const state = { skipped: false, claimed: false, online: network };
  const fakeFetch = async (req) => {
    const url = typeof req === 'string' ? req : req.url;
    fetched.push({ url, cache: req.cache });
    if (!state.online) throw new TypeError('Failed to fetch (offline)');
    return { ok: true, status: 200, url, body: `network:${url}`, clone() { return this; } };
  };
  sw = {
    registration: { scope: SCOPE },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: () => { state.skipped = true; },
    clients: { claim: async () => { state.claimed = true; } },
    fetch: fakeFetch,
  };
  const context = vm.createContext({
    self: sw,
    fetch: fakeFetch,
    URL,
    Set,
    Request: class { constructor(url, init = {}) { this.url = url; this.cache = init.cache; this.method = 'GET'; } },
    Response: class {
      constructor(body, init = {}) { Object.assign(this, { body, status: init.status ?? 200, ok: (init.status ?? 200) < 300, type: 'default', headers: new Map(Object.entries(init.headers ?? {})) }); }
      clone() { return this; }
      static error() { return { type: 'error', ok: false, status: 0, clone() { return this; } }; }
    },
    caches: {
      open: async (name) => { if (!stores.has(name)) stores.set(name, new FakeCache()); return stores.get(name); },
      keys: async () => [...stores.keys()],
      delete: async (name) => stores.delete(name),
    },
  });
  vm.runInContext(await read('sw.js'), context, { filename: 'sw.js' });

  const run = async (type, extra = {}) => {
    let waited;
    let responded;
    const event = { ...extra, waitUntil: (p) => { waited = p; }, respondWith: (p) => { responded = p; } };
    listeners[type](event);
    await waited;
    return responded;
  };
  const request = (url, mode = 'no-cors', { aborted = false } = {}) => ({ url, method: 'GET', mode, signal: { aborted } });
  return { listeners, stores, fetched, state, run, request };
}

test('service worker: installs the whole game into one versioned cache under the subpath', async () => {
  const { stores, fetched, state, run } = await loadServiceWorker();
  await run('install');
  const version = (await read('sw.js')).match(/const VERSION = '([0-9a-f]+)'/)[1];
  const cache = stores.get(`gridlock-precache-${version}`);
  assert.ok(cache, 'precache named after the content version');
  const files = await precacheFiles();
  assert.equal(cache.map.size, files.length);
  for (const file of files) assert.ok(cache.map.has(SCOPE + file), `${file} cached at ${SCOPE}${file}`);
  assert.ok(fetched.every((f) => f.cache === 'reload'), 'install bypasses the HTTP cache');
  assert.equal(state.skipped, false, 'a new version never takes over by itself');
});

test('service worker: activation removes old game caches only, then controls the page', async () => {
  const { stores, state, run } = await loadServiceWorker({
    existingCaches: ['gridlock-precache-000000000000', 'gridlock-runtime-000000000000', 'some-other-app'],
  });
  await run('install');
  await run('activate');
  const names = [...stores.keys()];
  assert.ok(!names.includes('gridlock-precache-000000000000'), 'old precache deleted');
  assert.ok(!names.includes('gridlock-runtime-000000000000'), 'old runtime cache deleted');
  assert.ok(names.includes('some-other-app'), 'caches that are not ours are left alone');
  assert.ok(names.some((n) => n.startsWith('gridlock-precache-')), 'current precache kept');
  assert.equal(state.claimed, true);
});

test('service worker: plays offline (app shell with any query, assets, lazy modules)', async () => {
  const { state, run, request } = await loadServiceWorker();
  await run('install');
  await run('activate');
  state.online = false;
  for (const url of [SCOPE, `${SCOPE}?seed=5&debug`, `${SCOPE}index.html`, `${SCOPE}index.html?debug`]) {
    const res = await run('fetch', { request: request(url, 'navigate') });
    assert.equal(res.url, `${SCOPE}index.html`, `${url} → cached app shell`);
  }
  for (const file of ['js/core/board.js', 'css/fonts.css', 'assets/generated/effects.webp', 'assets/fonts/nunito-latin.woff2']) {
    const res = await run('fetch', { request: request(SCOPE + file) });
    assert.equal(res?.url, SCOPE + file, `${file} served offline`);
  }
});

test('service worker: media byte-range requests get 206 slices of the cached file (music, intro video)', async () => {
  const { stores, state, run } = await loadServiceWorker();
  await run('install');
  state.online = false;
  const url = `${SCOPE}assets/media/cardboard-city.mp3`;
  const cache = [...stores.values()][0];
  const bytes = Uint8Array.from({ length: 10 }, (_, i) => i);
  cache.map.set(url, { arrayBuffer: async () => bytes.buffer.slice(0), headers: new Map([['Content-Type', 'audio/mpeg']]) });
  const ranged = (range) => run('fetch', { request: { url, method: 'GET', mode: 'no-cors', headers: new Map([['range', range]]) } });
  const mid = await ranged('bytes=2-5');
  assert.equal(mid.status, 206);
  assert.deepEqual([...new Uint8Array(mid.body)], [2, 3, 4, 5]);
  assert.equal(mid.headers.get('Content-Range'), 'bytes 2-5/10');
  assert.equal(mid.headers.get('Content-Type'), 'audio/mpeg');
  const open = await ranged('bytes=7-');
  assert.deepEqual([...new Uint8Array(open.body)], [7, 8, 9]);
  const tail = await ranged('bytes=-3');
  assert.equal(tail.headers.get('Content-Range'), 'bytes 7-9/10');
  assert.equal((await ranged('bytes=20-')).status, 416, 'outside the file');
  assert.ok((await precacheFiles()).includes('assets/media/inspiresoftwareintro.mp4'), 'the intro video is precached too');
});

test('service worker: other in-scope files are network-first with an offline copy', async () => {
  const { state, run, request } = await loadServiceWorker();
  await run('install');
  const png = `${SCOPE}effects.png`;
  assert.equal((await run('fetch', { request: request(png) })).body, `network:${png}`);
  state.online = false;
  assert.equal((await run('fetch', { request: request(png) })).url, png, 'offline copy after one online visit');
});

test('service worker: a request the page cancelled never fails the response', async () => {
  const { state, run, request } = await loadServiceWorker();
  state.online = false; // the fetch rejects, as it does when the page aborts it
  // Not yet precached (still installing) and cancelled by the page: an empty reply, no rejection.
  const precached = await run('fetch', { request: request(`${SCOPE}assets/generated/ui/btn-cream.png`, 'no-cors', { aborted: true }) });
  assert.equal(precached.status, 204);
  const other = await run('fetch', { request: request(`${SCOPE}effects.png`, 'no-cors', { aborted: true }) });
  assert.equal(other.status, 204);
});

test('service worker: a real network failure is a network error, not a crash', async () => {
  const { state, run, request } = await loadServiceWorker();
  state.online = false;
  const missing = await run('fetch', { request: request(`${SCOPE}effects.png`) });
  assert.equal(missing.type, 'error', 'offline and never fetched: the page sees a network error');
  const shell = await run('fetch', { request: request(SCOPE, 'navigate') });
  assert.equal(shell.type, 'error', 'nothing installed yet and offline');
  state.online = true;
  const fresh = await run('fetch', { request: request(`${SCOPE}css/game.css`) });
  assert.equal(fresh.body, `network:${SCOPE}css/game.css`, 'precached file not cached yet → network');
});

test('service worker: leaves other origins, other paths and non-GET requests alone', async () => {
  const { run, request } = await loadServiceWorker();
  assert.equal(await run('fetch', { request: request('https://fonts.gstatic.com/x.woff2') }), undefined);
  assert.equal(await run('fetch', { request: request('https://example.github.io/other-repo/index.html', 'navigate') }), undefined);
  assert.equal(await run('fetch', { request: { ...request(`${SCOPE}index.html`), method: 'POST' } }), undefined);
});

test('service worker: waits for the player, and only then takes over', async () => {
  const { state, run } = await loadServiceWorker();
  await run('install');
  assert.equal(state.skipped, false);
  let reply;
  await run('message', { data: { type: 'GET_VERSION' }, ports: [{ postMessage: (m) => { reply = m; } }] });
  assert.match(reply.version, /^[0-9a-f]{12}$/);
  await run('message', { data: { type: 'SKIP_WAITING' } });
  assert.equal(state.skipped, true);
});

test('offline support never touches saved games', async () => {
  const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const file of ['sw.js', 'js/pwa.js']) {
    assert.doesNotMatch(code(await read(file)), /localStorage|indexedDB|storage\.clear|removeItem/, file);
  }
  assert.equal(SAVE_KEY, 'gridlock.active-game', 'autosave key unchanged');
});
