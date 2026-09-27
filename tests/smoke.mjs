/**
 * Browser smoke test: serves the site, then drives the main flows at desktop
 * and mobile sizes, failing on any console error, failed request or broken layout.
 * Screenshots land in test-results/.
 */
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { startServer } from './serve.mjs';
import { PATTERNS as HAPTIC } from '../js/ui/haptics.js';

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    const globalRoot = execSync('npm root -g').toString().trim();
    return createRequire(`${globalRoot}/`)('playwright');
  }
}

const playwright = await loadPlaywright();
const browserName = process.env.BROWSER ?? 'chromium';
const browserType = playwright[browserName];
if (!['chromium', 'webkit', 'firefox'].includes(browserName) || !browserType) {
  throw new Error(`Unsupported BROWSER=${browserName}; expected chromium, webkit, or firefox`);
}
const launchOpts = browserName === 'chromium' && process.env.CHROMIUM_PATH
  ? { executablePath: process.env.CHROMIUM_PATH }
  : {};

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'laptop', width: 1280, height: 720 },
  { name: 'tablet', width: 820, height: 1180, isMobile: true, hasTouch: true },
  { name: 'phone', width: 390, height: 844, isMobile: true, hasTouch: true },
  { name: 'phone-landscape', width: 844, height: 390, isMobile: true, hasTouch: true },
];

async function dismissEvent(page) {
  if (await page.locator('#event-dialog[open]').count()) await page.click('#event-continue');
}

const server = await startServer(0);
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await browserType.launch(launchOpts);
console.log(`Running smoke tests in ${browserName}`);
await rm('test-results', { recursive: true, force: true });
await mkdir('test-results', { recursive: true });

let failures = 0;

async function noHorizontalScroll(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `${label}: horizontal overflow of ${overflow}px`);
}

function watchForBrowserErrors(page) {
  const errors = [];
  const optionalFont = (url) => /fonts\.(?:googleapis|gstatic)\.com/.test(url);
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    const source = message.location().url ?? '';
    if (message.type() === 'error' && !optionalFont(source)) errors.push(`console: ${message.text()}`);
    if (message.type() === 'warning' && /\[assets\]/.test(message.text())) errors.push(`asset warning: ${message.text()}`);
  });
  // A request the browser cancels because the page navigated away (reload, screen change via
  // location) isn't an asset failure. Firefox reports those as failed when a service worker is in
  // the path. Only such aborts are excused: every other failure, and any abort without a later
  // navigation, still fails the test.
  // Likewise, the browser may cancel an in-flight image a style no longer needs (e.g. on a screen
  // switch); Firefox reports these as NS_BINDING_ABORTED. Only a file that never loads is an asset
  // failure, so an abort is dropped once the same URL loads successfully (before or after).
  let navigations = 0;
  const startedAt = new WeakMap();
  const loaded = new Set();
  const abortedErrors = new Map(); // url → error entries awaiting a successful load
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations++; });
  page.on('request', (request) => startedAt.set(request, navigations));
  page.on('requestfailed', (request) => {
    const url = request.url();
    if (optionalFont(url)) return;
    const aborted = /abort|cancel/i.test(request.failure()?.errorText ?? '');
    if (aborted && (navigations > (startedAt.get(request) ?? navigations) || loaded.has(url))) return;
    const entry = `requestfailed: ${url} (${request.failure()?.errorText ?? 'unknown'})`;
    errors.push(entry);
    if (aborted) abortedErrors.set(url, [...(abortedErrors.get(url) ?? []), entry]);
  });
  page.on('response', (response) => {
    const url = response.url();
    if (response.status() >= 400 && !optionalFont(url)) errors.push(`HTTP ${response.status()}: ${url}`);
    if (response.status() < 400) {
      loaded.add(url);
      for (const entry of abortedErrors.get(url) ?? []) errors.splice(errors.indexOf(entry), 1);
      abortedErrors.delete(url);
    }
  });
  return errors;
}

async function prepareToPave(page) {
  while (await page.locator('#capture-choice-dialog[open]').count()) {
    await page.locator('[data-capture-choice="vacant"]').click();
  }
  if (await page.locator('#action-pave:visible').count()) await page.click('#action-pave');
}

async function pave(page, locator) {
  await prepareToPave(page);
  await locator.click();
}

for (const vp of VIEWPORTS) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    ...(browserName === 'firefox' ? {} : { isMobile: vp.isMobile ?? false }),
    hasTouch: vp.hasTouch ?? false,
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  await context.addInitScript(() => {
    if (!sessionStorage.getItem('gl-test-init')) {
      sessionStorage.setItem('gl-test-init', '1');
      (localStorage.setItem('gridlock.tutorial.v1', '{"status":"done"}'), localStorage.setItem('gridlock.settings.v1', JSON.stringify({ confirmTaps: false, quickHandoff: true })));
    }
  });
  const page = await context.newPage();
  const errors = watchForBrowserErrors(page);
  const shot = (step) => page.screenshot({ path: `test-results/${vp.name}-${step}.png` });

  try {
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.waitForSelector('html.is-ready');
    assert.ok(await page.isVisible('[data-screen="title"]'), 'title visible');
    assert.match(await page.textContent('.city-edition'), /Fredericksburg, Virginia/);
    for (const label of ['New Game', 'How To Play', 'Settings']) {
      assert.ok(await page.getByRole('button', { name: label }).isVisible(), `${label} button`);
    }
    assert.equal(await page.$$eval('[data-sprite]', (els) => els.length), 0, 'all static sprites hydrated');
    await noHorizontalScroll(page, 'title');
    await shot('1-title');

    await page.getByRole('button', { name: 'How To Play' }).click();
    assert.ok(await page.isVisible('[data-screen="howto"]'));
    assert.equal(await page.locator('.howto-card').count(), 10);
    await noHorizontalScroll(page, 'howto');
    await shot('2-howto');
    await page.locator('[data-screen="howto"] [data-nav="back"]').click();

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.locator('label.setting-row', { hasText: 'Show block coordinates' }).click();
    assert.equal(await page.locator('input[name="music"]').count(), 0);
    await noHorizontalScroll(page, 'settings');
    await shot('3-settings');
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Settings' }).click();
    assert.equal(await page.isChecked('input[name="showCoords"]'), true, 'coords persisted');
    await page.locator('[data-screen="settings"] [data-nav="back"]').click();

    await page.getByRole('button', { name: 'New Game' }).click();
    assert.equal(await page.locator('.seat-card').count(), 4);
    assert.match(await page.textContent('#setup-summary'), /Standard Game · 4 players · \$12,000 each/);
    assert.equal(await page.locator('[name="join"]:disabled').count(), 4);
    await page.fill('#seat-1-name', 'Ada');
    await page.fill('#seat-2-name', '<b>Bo</b>');
    await page.check('[name="gameType"][value="custom"]');
    for (const s of [2, 3, 4]) await page.locator(`label[for="seat-${s}-join"]`).click();
    assert.equal(await page.isDisabled('#setup-start'), true);
    for (const s of [2, 3, 4]) await page.locator(`label[for="seat-${s}-join"]`).click();
    assert.equal(await page.isDisabled('#setup-start'), false);
    await page.waitForTimeout(100);
    await noHorizontalScroll(page, 'setup');
    await shot('4-setup');
    await page.click('#setup-start');

    const road = (id) => page.locator(`#board [data-road="${id}"]`);
    const block = (id) => page.locator(`#board [data-block="${id}"]`);
    const banner = () => page.textContent('#turn-banner');

    assert.equal(await page.locator('#board .block').count(), 36);
    assert.equal(await page.locator('#board .road').count(), 84);
    assert.equal(await page.locator('#board .node').count(), 49);
    assert.equal(await page.locator('.block--suburbs').count(), 20);
    assert.equal(await page.locator('.block--midtown').count(), 12);
    assert.equal(await page.locator('.block--downtown').count(), 4);
    assert.match(await page.textContent('.district-legend'), /Fredericksburg.*Suburbs.*Midtown.*Downtown/s);
    assert.equal(await page.locator('.player-card').count(), 4);
    assert.match(await banner(), /Ada's turn/);
    assert.equal(await page.textContent('#hud-roads'), '0/84');
    assert.ok((await page.textContent('#hud-left')).includes('$12,000'));

    const firstTabStop = page.locator('#board [tabindex="0"]');
    assert.equal(await firstTabStop.count(), 1, 'board uses one roving tab stop');
    await firstTabStop.focus();
    const beforeArrow = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
    await page.keyboard.press('ArrowRight');
    const afterArrow = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
    assert.notEqual(afterArrow, beforeArrow, 'arrow key moves board focus');
    const keyboardBlock = await page.evaluate(() => document.activeElement?.dataset.block);
    assert.ok(keyboardBlock, 'block-first roving navigation keeps block semantics');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator(`[data-block="${keyboardBlock}"]`).getAttribute('aria-pressed'), 'true');
    if (await page.isVisible('#info-dialog')) await page.click('[data-info-close]');

    const box = await page.locator('.board-frame').boundingBox();
    assert.ok(box.width > 200);
    assert.ok(Math.abs(box.width - box.height) < 2, 'board is square');
    assert.ok(box.x >= 0 && box.x + box.width <= vp.width + 1);
    await noHorizontalScroll(page, 'game');
    await shot('5-game');

    assert.match(await page.textContent('#turn-prompt'), /MANAGE CITY/);
    await pave(page, road('h-0-0'));
    assert.match(await banner(), /<b>Bo<\/b>'s turn/);
    assert.ok(await road('h-0-0').evaluate((el) => el.classList.contains('road--red')));
    const toastBeforeLockedRoad = await page.textContent('#toasts');
    await road('h-0-0').dispatchEvent('click');
    assert.equal(await page.textContent('#toasts'), toastBeforeLockedRoad, 'built road inert');
    assert.equal(await road('h-0-0').getAttribute('data-owner-symbol'), 'triangle');

    await pave(page, road('v-0-0'));
    await pave(page, road('h-1-0'));
    await pave(page, road('v-0-1'));
    assert.ok(await block('r0c0').evaluate((el) => el.classList.contains('block--green')));
    assert.match(await page.textContent('#turn-prompt'), /CAPTURE \/ DEVELOP/);
    assert.ok(await page.isVisible('#capture-choice-dialog'));
    await shot('6-capture');

    const panel = page.locator('#build-dialog');
    await page.click('[data-capture-choice="develop"]');
    assert.ok(await panel.isVisible());
    assert.equal(await panel.locator('[data-build]').count(), 6);
    await shot('7-build-panel');
    await panel.locator('[data-build="residential"]').click();
    assert.match(await block('r0c0').getAttribute('aria-label'), /Residential · Level 1 · House/);
    assert.match(await page.textContent('#turn-prompt'), /BONUS ROAD/);
    await shot('8-developed');

    await pave(page, road('h-6-5'));
    const eventCard = page.locator('#event-dialog');
    if (await eventCard.isVisible()) {
      assert.match(await eventCard.textContent(), /(Heavy Rain|Snowstorm|Fire|Power Outage|City Festival|Housing Boom|Beautification Grant|Economic Boom|Recession)/);
      await shot('9-event-card');
      await page.click('#event-continue');
    } else {
      assert.match(await page.textContent('#toasts'), /Calm round/);
    }
    assert.equal(await page.textContent('#hud-round'), '2');

    await block('r0c0').click();
    assert.match(await page.textContent('#inspector'), /Residential · Level 1 · House/);
    if (await page.isVisible('#info-dialog')) await page.click('[data-info-close]');

    const remaining = await page.$$eval('#board .road:not(.is-built)', (els) => els.map((el) => el.dataset.road));
    for (const id of remaining) {
      await pave(page, road(id));
      await dismissEvent(page);
    }
    await page.waitForSelector('#results-dialog[open]');
    assert.equal(await page.evaluate(() => localStorage.getItem('gridlock.active-game')), null);
    assert.equal(await page.locator('#board .block--owned').count(), 36);
    assert.equal(await page.textContent('#hud-roads'), '84/84');
    const cards = page.locator('#results-list .result-card');
    assert.equal(await cards.count(), 4);
    assert.ok(await page.locator('#results-awards .award').count() >= 1);
    for (const label of ['Longest Capture Chain', 'Biggest District', 'Best Single Block', 'Events Survived', 'Bankruptcies']) {
      assert.ok((await page.textContent('#match-stats')).includes(label));
    }
    await shot('10-results');

    await page.getByRole('button', { name: 'View Board' }).click();
    await page.click('#action-results');
    assert.ok(await page.isVisible('#results-dialog'));
    await page.getByRole('button', { name: 'Play Again' }).click();
    assert.equal(await page.textContent('#hud-roads'), '0/84');
    await page.click('#game-menu-btn');
    await shot('11-pause');
    await page.getByRole('button', { name: 'Save & Quit' }).click();
    assert.ok(await page.isVisible('#continue-game'));

    assert.deepEqual(errors, [], 'no runtime errors');
    console.log(`✔ ${vp.name} (${vp.width}×${vp.height})`);
  } catch (err) {
    failures++;
    console.error(`✘ ${vp.name}: ${err.message}`);
    if (errors.length) console.error('  ' + errors.join('\n  '));
    await shot('FAIL').catch(() => {});
  } finally {
    await context.close();
  }
}

// Financial distress → bankruptcy → contested redevelopment.
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  await context.addInitScript(() => (localStorage.setItem('gridlock.tutorial.v1', '{"status":"done"}'), localStorage.setItem('gridlock.settings.v1', JSON.stringify({ confirmTaps: false, quickHandoff: true }))));
  const page = await context.newPage();
  const errors = watchForBrowserErrors(page);
  try {
    await page.goto(`${base}?seed=5&debug`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'New Game' }).click();
    await page.click('#setup-start');
    const road = (id) => page.locator(`#board [data-road="${id}"]`);
    const fin = page.locator('#finance-dialog');
    await page.evaluate(async () => {
      const { getBlock } = await import('/js/core/board.js');
      const { applyDevelopment } = await import('/js/core/development.js');
      const { refreshBonuses } = await import('/js/core/bonuses.js');
      const game = window.__GRIDLOCK__.getGame();
      game.eventPool = [];
      for (let c = 0; c < 6; c++) getBlock(game.board, 5, c).ownerSeat = 2;
      for (let c = 0; c < 4; c++) getBlock(game.board, 4, c).ownerSeat = 2;
      const home = getBlock(game.board, 4, 5); home.ownerSeat = 2; applyDevelopment(home, 'residential', 2);
      const p3home = getBlock(game.board, 0, 0); p3home.ownerSeat = 3; applyDevelopment(p3home, 'residential', 1);
      getBlock(game.board, 0, 1).ownerSeat = 3;
      refreshBonuses(game.board);
      game.players[1].cash = 0;
      game.players[2].cash = -5000;
    });
    await pave(page, road('h-3-3'));
    assert.ok(await fin.isVisible());
    await fin.getByRole('button', { name: 'View board' }).click();
    await road('h-3-4').dispatchEvent('click');
    assert.ok(await fin.isVisible());
    await fin.locator('[data-sell="r4c5"]').click();
    await pave(page, road('h-3-4'));
    await fin.locator('#declare-bankruptcy').click();
    assert.match(await fin.textContent(), /2 blocks abandoned/);
    await fin.getByRole('button', { name: 'Continue' }).click();
    assert.equal(await page.locator('#board .block--abandoned').count(), 2);

    await pave(page, road('h-3-5'));
    const panel = page.locator('#build-dialog');
    await page.locator('[data-block="r0c0"]').click();
    await panel.locator('[data-auction="restore"]').click();
    assert.ok(await page.locator('[data-block="r0c0"]').evaluate((el) => el.classList.contains('block--green')));
    assert.equal(await panel.isVisible(), false, 'restored block keeps its building, so the panel closes');
    await page.locator('[data-block="r0c1"]').click();
    assert.equal(await panel.locator('[data-auction="restore"]').count(), 0);
    await panel.locator('[data-auction="rebuild"]').click();
    assert.ok(await page.locator('[data-block="r0c1"]').evaluate((el) => el.classList.contains('block--green')), 'auction winner owns cleared lot');
    assert.ok(await panel.isVisible(), 'Clear & Rebuild reopens build selection');
    assert.equal(await panel.locator('[data-auction]').count(), 0, 'reopened on the build choices, not the auction');
    assert.ok(await panel.locator('[data-build="park"]').count(), 'build categories offered');
    await panel.locator('[data-build="park"]').click();
    assert.equal(await page.locator('#board .block--abandoned').count(), 0);
    assert.deepEqual(errors, []);
    console.log('✔ distress, bankruptcy & redevelopment');
  } catch (err) {
    failures++;
    console.error(`✘ finance: ${err.message}`);
  } finally {
    await context.close();
  }
}

// Seeded city event presentation.
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  await context.addInitScript(() => (localStorage.setItem('gridlock.tutorial.v1', '{"status":"done"}'), localStorage.setItem('gridlock.settings.v1', JSON.stringify({ confirmTaps: false, quickHandoff: true }))));
  const page = await context.newPage();
  const errors = watchForBrowserErrors(page);
  try {
    await page.goto(`${base}?seed=19`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'New Game' }).click();
    await page.click('#setup-start');
    const road = (id) => page.locator(`#board [data-road="${id}"]`);
    for (const id of ['h-0-0', 'v-0-0', 'h-1-0', 'v-0-1']) await pave(page, road(id));
    await page.click('[data-capture-choice="develop"]');
    await page.locator('#build-dialog [data-build="residential"]').click();
    await pave(page, road('h-6-5'));
    const card = page.locator('#event-dialog');
    assert.ok(await card.isVisible());
    assert.equal(await card.locator('.event-card__name').textContent(), 'Fire');
    await page.click('#event-continue');
    assert.equal(await page.locator('[data-block="r0c0"] .block__event-vfx--fire').count(), 2);
    assert.ok(await page.locator('[data-block="r0c0"].is-event-hurt').count());
    assert.deepEqual(errors, []);
    console.log('✔ city event (seeded fire)');
  } catch (err) {
    failures++;
    console.error(`✘ city event: ${err.message}`);
  } finally {
    await context.close();
  }
}

// District bonus through the V1.1 capture → develop → bonus-road flow.
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  await context.addInitScript(() => (localStorage.setItem('gridlock.tutorial.v1', '{"status":"done"}'), localStorage.setItem('gridlock.settings.v1', JSON.stringify({ confirmTaps: false, quickHandoff: true }))));
  const page = await context.newPage();
  const errors = watchForBrowserErrors(page);
  try {
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'New Game' }).click();
    await page.click('#setup-start');
    const road = (id) => page.locator(`#board [data-road="${id}"]`);
    for (const id of ['h-0-0', 'h-0-1', 'h-0-2', 'h-1-0', 'h-1-1', 'h-1-2', 'v-0-0']) {
      await road(id).click();
      await dismissEvent(page);
    }
    const panel = page.locator('#build-dialog');
    const captures = [
      ['v-0-1', 'CAPTURE ×1'],
      ['v-0-2', 'CHAIN ×2'],
      ['v-0-3', 'FLOW ×3'],
    ];
    for (const [roadId, label] of captures) {
      await pave(page, road(roadId));
      assert.equal(await page.locator('#chain-meter').textContent(), label);
      await page.click('[data-capture-choice="develop"]');
      await panel.locator('[data-build="residential"]').click();
    }
    assert.equal(await page.locator('#board .block--green').count(), 3);
    const income = page.locator('.player-card[data-seat="4"] .stat--income');
    assert.equal(await income.getAttribute('data-normal'), '1080', '3 × ($300 + 20%)');
    assert.equal(await page.locator('#board .block__badge.has-bonus').count(), 3);
    assert.match(await page.textContent('#toasts'), /Bonus income \+\$180\/turn/);
    // The build panel opens in Manage City: finish P4's bonus road and rotate back to P4.
    for (const id of ['h-6-5', 'h-6-4', 'h-6-3', 'h-6-2']) {
      await pave(page, road(id));
      await dismissEvent(page);
    }
    await page.locator('[data-block="r0c1"]').click();
    assert.match(await panel.textContent(), /Residential district/);
    await panel.getByRole('button', { name: 'Keep as is' }).click();
    assert.deepEqual(errors, []);
    console.log('✔ district bonus');
  } catch (err) {
    failures++;
    console.error(`✘ district bonus: ${err.message}`);
  } finally {
    await context.close();
  }
}

// Deterministic completion tie: staged roads use a valid owner seat so the UI
// remains representative of real game state while scoring stays symmetric.
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  await context.addInitScript(() => (localStorage.setItem('gridlock.tutorial.v1', '{"status":"done"}'), localStorage.setItem('gridlock.settings.v1', JSON.stringify({ confirmTaps: false, quickHandoff: true }))));
  const page = await context.newPage();
  const errors = watchForBrowserErrors(page);
  try {
    await page.goto(`${base}?seed=1&debug`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'New Game' }).click();
    await page.click('#setup-start');
    const last = await page.evaluate(async () => {
      const { allRoadIds, getBlock } = await import('/js/core/board.js');
      const g = window.__GRIDLOCK__.getGame();
      g.eventPool = [];
      const ids = allRoadIds(g.board);
      ids.slice(0, -1).forEach((id) => { g.board.roads[id] = 1; });
      const b = getBlock(g.board, 5, 5);
      b.abandoned = true;
      b.abandonedBy = 4;
      return ids.at(-1);
    });
    await pave(page, page.locator(`[data-road="${last}"]`));
    await page.waitForFunction(() => window.__GRIDLOCK__.getGame().phase === 'ended');
    const dialog = page.locator('#results-dialog');
    await dialog.waitFor({ state: 'visible' });
    assert.match(await page.textContent('#results-heading'), /^Tie! All mayors share the city$/);
    assert.equal(await page.locator('.result-card.is-winner').count(), 4);
    await dialog.getByRole('button', { name: 'Main Menu' }).click();
    assert.ok(await page.isVisible('[data-screen="title"]'));
    assert.deepEqual(errors, []);
    console.log('✔ game completion: tie + main menu');
  } catch (err) {
    failures++;
    console.error(`✘ completion: ${err.message}`);
  } finally {
    await context.close();
  }
}

// Art pipeline / hi-DPI phone.
{
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: browserName !== 'firefox', hasTouch: true, reducedMotion: 'reduce' });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  await context.addInitScript(() => (localStorage.setItem('gridlock.tutorial.v1', '{"status":"done"}'), localStorage.setItem('gridlock.settings.v1', JSON.stringify({ confirmTaps: false, quickHandoff: true }))));
  const page = await context.newPage();
  const errors = watchForBrowserErrors(page);
  try {
    await page.goto(`${base}?debug`, { waitUntil: 'networkidle' });
    const btn = await page.locator('[data-nav="setup"]').evaluate((el) => getComputedStyle(el).borderImageSource);
    assert.match(btn, /generated\/ui\/btn-gold\.png/);
    await page.getByRole('button', { name: 'New Game' }).click();
    await page.click('#setup-start');
    await page.evaluate(async () => {
      const { getBlock } = await import('/js/core/board.js');
      const { applyDevelopment } = await import('/js/core/development.js');
      const g = window.__GRIDLOCK__.getGame();
      const b = getBlock(g.board, 0, 0); b.ownerSeat = 1; applyDevelopment(b, 'commercial', 3);
    });
    await pave(page, page.locator('[data-road="h-0-0"]'));
    await page.waitForLoadState('networkidle');
    assert.equal(await page.locator('[data-road="h-0-0"] .road__tile').count(), 1);
    assert.equal(await page.locator('[data-block="r0c0"] .block__prop').count(), 2);
    assert.deepEqual(errors, []);
    console.log('✔ art pipeline (hi-DPI phone)');
  } catch (err) {
    failures++;
    console.error(`✘ art pipeline: ${err.message}`);
  } finally {
    await context.close();
  }
}

// Touch/handoff/resize flow.
{
  const context = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 2, ...(browserName === 'firefox' ? {} : { isMobile: true }), hasTouch: true, reducedMotion: 'reduce' });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  const page = await context.newPage();
  const errors = watchForBrowserErrors(page);
  try {
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'New Game' }).click();
    await page.click('#setup-start');
    const road = (id) => page.locator(`#board [data-road="${id}"]`);
    const size = await page.evaluate(() => [document.documentElement.scrollHeight, innerHeight, document.documentElement.scrollWidth, innerWidth]);
    assert.ok(size[0] <= size[1] && size[2] <= size[3], `game fits screen ${size}`);
    await page.click('#action-pave');
    await road('h-3-3').tap();
    assert.ok(await road('h-3-3').evaluate((e) => e.classList.contains('is-armed')));
    await road('h-4-4').tap();
    await page.keyboard.press('Escape');
    await road('h-4-4').tap();
    await road('h-4-4').tap();
    assert.ok(await road('h-4-4').evaluate((e) => e.classList.contains('is-built')));
    assert.ok(await page.isVisible('#handoff-dialog'));
    await page.click('#handoff-ready');
    await page.setViewportSize({ width: 667, height: 375 });
    await noHorizontalScroll(page, 'touch landscape');
    assert.equal(await page.locator('#board [tabindex="0"]').count(), 1);
    assert.deepEqual(errors, []);
    console.log('✔ touch: two-tap, handoff, resize');
  } catch (err) {
    failures++;
    console.error(`✘ touch: ${err.message}`);
  } finally {
    await context.close();
  }
}

// Persistence survives reload and can be abandoned safely.
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  await context.addInitScript(() => (localStorage.setItem('gridlock.tutorial.v1', '{"status":"done"}'), localStorage.setItem('gridlock.settings.v1', JSON.stringify({ confirmTaps: false, quickHandoff: true }))));
  const page = await context.newPage();
  const errors = watchForBrowserErrors(page);
  try {
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'New Game' }).click();
    await page.click('#setup-start');
    await pave(page, page.locator('[data-road="h-0-0"]'));
    await page.reload({ waitUntil: 'networkidle' });
    await page.click('#continue-game');
    assert.equal(await page.textContent('#hud-roads'), '1/84');
    assert.equal(await page.locator('dialog[open]').count(), 0);
    await page.click('#game-menu-btn');
    await page.locator('#pause-dialog').getByRole('button', { name: 'Abandon Game' }).click();
    await page.getByRole('button', { name: 'Keep Playing' }).click();
    await page.click('#game-menu-btn');
    await page.locator('#pause-dialog').getByRole('button', { name: 'Abandon Game' }).click();
    await page.locator('#abandon-dialog').getByRole('button', { name: 'Abandon Game' }).click();
    assert.equal(await page.isVisible('#continue-game'), false);
    assert.deepEqual(errors, []);
    console.log('✔ persistence: reload and continue');
  } catch (err) {
    failures++;
    console.error(`✘ persistence: ${err.message}`);
  } finally {
    await context.close();
  }
}

// Money/capture/build feedback with motion enabled.
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  await context.addInitScript(() => (localStorage.setItem('gridlock.tutorial.v1', '{"status":"done"}'), localStorage.setItem('gridlock.settings.v1', JSON.stringify({ confirmTaps: false, quickHandoff: true }))));
  const page = await context.newPage();
  const errors = watchForBrowserErrors(page);
  try {
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'New Game' }).click();
    await page.click('#setup-start');
    for (const id of ['h-0-0', 'v-0-0', 'h-1-0']) await pave(page, page.locator(`[data-road="${id}"]`));
    await pave(page, page.locator('[data-road="v-0-1"]'));
    const p4 = page.locator('.player-card[data-seat="4"]');
    assert.equal(await p4.locator('.cash-delta').textContent(), '+$500');
    await page.click('[data-capture-choice="develop"]');
    await page.click('#build-dialog [data-build="residential"]');
    const built = page.locator('[data-block="r0c0"]');
    assert.ok(await built.locator('.block__foundation').count());
    assert.ok(await built.locator('.block__building').count());
    for (const id of ['h-6-5', 'h-6-4', 'h-6-3', 'h-6-2']) {
      await pave(page, page.locator(`[data-road="${id}"]`));
      await dismissEvent(page);
    }
    assert.match(await page.locator('#economy-summary').textContent(), /Gross Income.*Upkeep.*Net/);
    assert.deepEqual(errors, []);
    console.log('✔ money animation');
  } catch (err) {
    failures++;
    console.error(`✘ money animation: ${err.message}`);
  } finally {
    await context.close();
  }
}

// Audio: no autoplay, settings UI + persistence, ambience scenes, pause ducking, mute, capture chain.
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  await context.addInitScript(() => {
    if (!sessionStorage.getItem('gl-test-init')) {
      sessionStorage.setItem('gl-test-init', '1');
      (localStorage.setItem('gridlock.tutorial.v1', '{"status":"done"}'), localStorage.setItem('gridlock.settings.v1', JSON.stringify({ confirmTaps: false, quickHandoff: true })));
    }
  });
  const page = await context.newPage();
  const errors = watchForBrowserErrors(page);
  const autoplayWarnings = [];
  page.on('console', (m) => { if (/AudioContext|autoplay/i.test(m.text())) autoplayWarnings.push(m.text()); });
  const audioState = () => page.evaluate(() => window.__GRIDLOCK__.audio());
  const setSlider = (name, value) => page.locator(`#settings-form [name="${name}"]`).evaluate((el, v) => {
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('gridlock.settings.v1')));
  try {
    await page.goto(`${base}?debug`, { waitUntil: 'networkidle' });
    let st = await audioState();
    assert.equal(st.contextState, 'none', 'no AudioContext before any gesture (no autoplay)');
    assert.equal(st.unlocked, false);

    // Settings: defaults, live labels, persistence, dependent controls.
    await page.getByRole('button', { name: 'Settings' }).click();
    const form = page.locator('#settings-form');
    assert.equal(await form.locator('[name="masterVolume"]').inputValue(), '80');
    assert.equal(await form.locator('output[data-for="ambienceVolume"]').textContent(), '50%');
    await setSlider('masterVolume', 55);
    await setSlider('ambienceVolume', 30);
    assert.equal(await form.locator('output[data-for="masterVolume"]').textContent(), '55%');
    assert.equal(await form.locator('[name="masterVolume"]').getAttribute('aria-valuetext'), '55%');
    assert.deepEqual([(await saved()).masterVolume, (await saved()).ambienceVolume], [55, 30]);
    await page.locator('label.setting-row', { hasText: 'City ambience' }).click();
    assert.equal(await form.locator('[name="ambienceVolume"]').isDisabled(), true, 'ambience volume greys out with ambience off');
    await page.locator('label.setting-row', { hasText: 'City ambience' }).click();
    await page.locator('label.setting-row', { hasText: /^\s*Sound\s*$/ }).click();
    assert.equal(await form.locator('[name="sfxVolume"]').isDisabled(), true, 'volumes grey out while muted');
    assert.equal((await saved()).ambience, true, 'muting keeps the ambience choice');
    await page.locator('label.setting-row', { hasText: /^\s*Sound\s*$/ }).click();
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Settings' }).click();
    assert.equal(await form.locator('[name="masterVolume"]').inputValue(), '55', 'volume persisted');
    assert.equal(await form.locator('[name="ambienceVolume"]').inputValue(), '30');
    st = await audioState();
    assert.equal(st.unlocked, true, 'unlocked by the click');
    assert.equal(st.levels.master, 0.55);
    assert.equal(st.ambienceRunning, false, 'no ambience outside the game');
    await page.locator('[data-screen="settings"] [data-nav="back"]').click();

    // In game: ambience plays (where Web Audio exists), ducks for pause, resumes.
    await page.getByRole('button', { name: 'New Game' }).click();
    await page.click('#setup-start');
    st = await audioState();
    assert.equal(st.scene.name, 'game');
    if (st.supported) {
      assert.equal(st.ambienceRunning, true, 'ambience starts in the game');
      assert.ok(st.levels.ambience > 0);
    }
    await page.click('#game-menu-btn');
    assert.equal((await audioState()).levels.ambience, 0, 'pause fades ambience out');
    assert.equal((await audioState()).scene.paused, true);
    await page.click('#pause-dialog [data-dialog-action="resume"]');
    // (The dialog's close event is delivered asynchronously.)
    await page.waitForFunction(() => window.__GRIDLOCK__.audio().levels.ambience > 0, null, { timeout: 5000 });

    // Capture chain (CAPTURE ×1 → FLOW ×3) plays escalating sounds without errors.
    for (const id of ['h-0-0', 'h-0-1', 'h-0-2', 'h-1-0', 'h-1-1', 'h-1-2', 'v-0-0']) {
      await page.locator(`#board [data-road="${id}"]`).click();
      await dismissEvent(page);
    }
    for (const id of ['v-0-1', 'v-0-2', 'v-0-3']) await pave(page, page.locator(`#board [data-road="${id}"]`));
    assert.equal(await page.locator('#chain-meter').textContent(), 'FLOW ×3');
    await page.click('[data-capture-choice="vacant"]');

    // Top-bar mute: same saved setting, survives reload.
    const mute = page.locator('#mute-btn');
    assert.equal(await mute.getAttribute('aria-pressed'), 'false');
    await mute.click();
    assert.equal(await mute.getAttribute('aria-pressed'), 'true');
    assert.equal(await mute.getAttribute('aria-label'), 'Unmute sound');
    st = await audioState();
    assert.equal(st.levels.master, 0);
    assert.equal(st.levels.ambience, 0);
    assert.equal((await saved()).sound, false);
    await page.reload({ waitUntil: 'networkidle' });
    await page.click('#continue-game');
    assert.equal(await page.locator('#mute-btn').getAttribute('aria-pressed'), 'true', 'mute persisted');
    await page.locator('#mute-btn').click();
    assert.equal((await saved()).sound, true);
    await noHorizontalScroll(page, 'game with mute button');

    assert.deepEqual(errors, []);
    assert.deepEqual(autoplayWarnings, [], 'no autoplay warnings');
    console.log(`✔ audio: no autoplay, settings, ambience scenes, pause, mute, chain${st.supported ? '' : ' (no Web Audio: silent)'}`);
  } catch (err) {
    failures++;
    console.error(`✘ audio: ${err.message}`);
    await page.screenshot({ path: 'test-results/audio-FAIL.png' }).catch(() => {});
  } finally {
    await context.close();
  }
}

// Phone: the sound settings fit without horizontal scrolling.
{
  const context = await browser.newContext({ viewport: { width: 360, height: 740 }, ...(browserName === 'firefox' ? {} : { isMobile: true }), hasTouch: true, reducedMotion: 'reduce' });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  const page = await context.newPage();
  const errors = watchForBrowserErrors(page);
  try {
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Settings' }).click();
    await noHorizontalScroll(page, 'phone settings');
    const box = await page.locator('#settings-form [name="sfxVolume"]').boundingBox();
    assert.ok(box.width >= 100 && box.height >= 24, `slider is a usable touch target: ${JSON.stringify(box)}`);
    await page.screenshot({ path: 'test-results/audio-settings-phone.png', fullPage: true });
    assert.deepEqual(errors, []);
    console.log('✔ audio settings on a phone');
  } catch (err) {
    failures++;
    console.error(`✘ audio settings (phone): ${err.message}`);
  } finally {
    await context.close();
  }
}

/** Records navigator.vibrate calls (defines the API where the engine lacks it, e.g. WebKit). */
const recordVibration = () => {
  window.__vib = [];
  Object.defineProperty(Navigator.prototype, 'vibrate', {
    configurable: true,
    writable: true,
    value(pattern) { window.__vib.push(Array.isArray(pattern) ? pattern : [pattern]); return true; },
  });
};

// Touch + haptics on a phone: patterns per action, tap-through guard, setting, tap targets.
{
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, ...(browserName === 'firefox' ? {} : { isMobile: true }), hasTouch: true, reducedMotion: 'reduce',
  });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  await context.addInitScript(recordVibration);
  await context.addInitScript(() => {
    if (!sessionStorage.getItem('gl-test-init')) {
      sessionStorage.setItem('gl-test-init', '1');
      (localStorage.setItem('gridlock.tutorial.v1', '{"status":"done"}'), localStorage.setItem('gridlock.settings.v1', JSON.stringify({ confirmTaps: true, quickHandoff: true })));
    }
  });
  const page = await context.newPage();
  const errors = watchForBrowserErrors(page);
  const road = (id) => page.locator(`#board [data-road="${id}"]`);
  const vib = () => page.evaluate(() => window.__vib);
  const lastVib = async () => (await vib()).at(-1) ?? null;
  const tapTwice = async (id) => { await road(id).tap(); await road(id).tap(); };
  const settle = () => page.waitForTimeout(400); // longer than the 300ms tap-through guard
  try {
    await page.goto(`${base}?seed=19&debug`, { waitUntil: 'networkidle' });
    const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
    // Settings: the switch exists only where haptics can work.
    await page.getByRole('button', { name: 'Settings' }).tap();
    assert.equal(await page.isVisible('#haptics-row'), coarse, 'haptics switch shown only on touch devices');
    if (coarse) assert.equal(await page.isChecked('#settings-form [name="haptics"]'), true, 'on by default');
    await page.locator('[data-screen="settings"] [data-nav="back"]').tap();
    await page.getByRole('button', { name: 'New Game' }).tap();
    await page.locator('#setup-start').tap();

    // Tap twice to pave: arm (tiny) then pave (short).
    await road('h-0-0').tap();
    assert.ok(await road('h-0-0').evaluate((el) => el.classList.contains('is-armed')), 'first tap previews');
    if (coarse) assert.deepEqual(await lastVib(), HAPTIC.arm);
    await road('h-0-0').tap();
    assert.ok(await road('h-0-0').evaluate((el) => el.classList.contains('is-built')), 'second tap paves');
    if (coarse) assert.deepEqual(await lastVib(), HAPTIC.pave);
    for (const id of ['v-0-0', 'h-1-0', 'v-0-1']) await tapTwice(id);
    if (coarse) assert.deepEqual(await lastVib(), HAPTIC.capture, 'capture: stronger pattern');

    // Tap-through: a quick double tap on "Develop Now" must not also press what opens beneath it.
    // Dispatched in the page 60ms apart so the gap is a real double tap on every engine (driving
    // two separate taps can take longer than the guard window on slow CI runners).
    await settle();
    const doubleTap = await page.evaluate(async () => {
      const develop = document.querySelector('[data-capture-choice="develop"]').getBoundingClientRect();
      const [x, y] = [develop.left + develop.width / 2, develop.top + develop.height / 2];
      const tap = (el) => {
        el.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true, clientX: x, clientY: y }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, clientX: x, clientY: y }));
      };
      const t0 = performance.now();
      tap(document.elementFromPoint(x, y));
      await new Promise((done) => setTimeout(done, 60));
      // The second tap lands on a build option of the panel that just opened (worst case).
      tap(document.querySelector('#build-dialog [data-build="residential"]'));
      return { gap: performance.now() - t0 };
    });
    assert.ok(doubleTap.gap < 300, `taps ${Math.round(doubleTap.gap)}ms apart form a double tap`);
    const panel = page.locator('#build-dialog');
    assert.equal(await panel.isVisible(), true, 'build panel opened and stayed open');
    assert.equal(await page.locator('[data-block="r0c0"] .block__building').count(), 0, 'the second tap built nothing');

    // Refused action: warning; then a real build: confirmation.
    await settle();
    await page.evaluate(() => { const g = window.__GRIDLOCK__.getGame(); g.players[3].cash = 10; });
    await panel.locator('[data-build="residential"]').tap();
    if (coarse) assert.deepEqual(await lastVib(), HAPTIC.error, 'invalid action: warning');
    // Cash restored behind the UI's back, so the open panel still shows the option as unaffordable.
    await page.evaluate(() => { const g = window.__GRIDLOCK__.getGame(); g.players[3].cash = 12500; });
    await panel.locator('[data-build="residential"]').tap({ force: true });
    assert.ok(await page.locator('[data-block="r0c0"] .block__building').count(), 'built');
    if (coarse) assert.deepEqual(await lastVib(), HAPTIC.build, 'build: confirmation');

    // Bonus road ends the round: the seeded Fire is a major event.
    await settle();
    await tapTwice('h-6-5');
    assert.ok(await page.isVisible('#event-dialog'), 'city event');
    if (coarse) assert.deepEqual(await lastVib(), HAPTIC.event, 'major event pattern');
    await settle();
    await page.locator('#event-continue').tap();

    // Setting off: gameplay unchanged, no vibration.
    if (coarse) {
      await settle();
      await page.locator('[data-screen="game"] [data-nav="settings"]').tap();
      await page.locator('#haptics-row').tap();
      assert.equal(await page.isChecked('#settings-form [name="haptics"]'), false);
      await page.locator('[data-screen="settings"] [data-nav="back"]').tap();
      const before = (await vib()).length;
      await tapTwice('h-6-4');
      assert.ok(await road('h-6-4').evaluate((el) => el.classList.contains('is-built')), 'paving still works');
      assert.equal((await vib()).length, before, 'no vibration with haptics off');
      await page.reload({ waitUntil: 'networkidle' });
      await page.getByRole('button', { name: 'Settings' }).tap();
      assert.equal(await page.isChecked('#settings-form [name="haptics"]'), false, 'haptics setting persisted');
      await page.locator('#haptics-row').tap();
      await page.locator('[data-screen="settings"] [data-nav="back"]').tap();
      await page.locator('#continue-game').tap();
    }

    // Win: stage a nearly finished city, then pave the last road.
    await settle();
    const last = await page.evaluate(async () => {
      const { allRoadIds, getBlock } = await import('/js/core/board.js');
      const g = window.__GRIDLOCK__.getGame();
      g.eventPool = [];
      const ids = allRoadIds(g.board);
      ids.slice(0, -1).forEach((id) => { if (g.board.roads[id] == null) g.board.roads[id] = 1; });
      const b = getBlock(g.board, 5, 5);
      if (b.ownerSeat == null) { b.abandoned = true; b.abandonedBy = 1; }
      return ids.at(-1);
    });
    await tapTwice(last);
    await page.locator('#results-dialog').waitFor({ state: 'visible' });
    if (coarse) assert.deepEqual(await lastVib(), HAPTIC.win, 'win pattern');
    await settle();
    await page.locator('#results-dialog [data-results-action="title"]').tap();

    // Tap targets (portrait and rotated to landscape).
    for (const [w, h] of [[390, 844], [844, 390]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.getByRole('button', { name: 'New Game' }).tap();
      await page.locator('#setup-start').tap();
      const t = await page.evaluate(() => {
        const hit = (sel, axis) => {
          const el = document.querySelector(sel);
          const b = el.getBoundingClientRect();
          let n = 0;
          for (let i = -30; i < (axis === 'y' ? b.height : b.width) + 30; i++) {
            const at = axis === 'y' ? document.elementFromPoint(b.left + b.width / 2, b.top + i) : document.elementFromPoint(b.left + i, b.top + b.height / 2);
            if (at?.closest(sel)) n++;
          }
          return n;
        };
        const controls = [...document.querySelectorAll('[data-screen="game"] button')].filter((b) => b.offsetParent && !b.closest('#board'))
          .map((b) => { const r = b.getBoundingClientRect(); return [b.id || b.className, Math.round(Math.min(r.width, r.height))]; });
        return { road: hit('[data-road="h-2-2"]', 'y'), block: hit('[data-block="r2c2"]', 'x'), controls };
      });
      assert.ok(t.road >= 20, `${w}×${h}: road hit strip ${t.road}px`);
      assert.ok(t.block >= 12, `${w}×${h}: block keeps a tappable centre (${t.block}px)`);
      if (coarse) for (const [name, min] of t.controls) assert.ok(min >= 44, `${w}×${h}: ${name} is ${min}px (< 44)`);
      await noHorizontalScroll(page, `touch ${w}×${h}`);
      await page.locator('#game-menu-btn').tap();
      await settle();
      await page.locator('#pause-dialog [data-dialog-action="save-quit"]').tap();
    }
    assert.deepEqual(errors, []);
    console.log(`✔ touch + haptics: patterns, tap-through guard, setting, win, tap targets${coarse ? '' : ' (no coarse pointer: haptics off)'}`);
  } catch (err) {
    failures++;
    console.error(`✘ touch + haptics: ${err.message}`);
    await page.screenshot({ path: 'test-results/haptics-FAIL.png' }).catch(() => {});
  } finally {
    await context.close();
  }
}

// Desktop is unchanged: no haptics switch, no vibration, mouse clicks pave directly.
// A touchscreen laptop (touch + mouse) previews finger taps but not mouse clicks.
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true, reducedMotion: 'reduce' });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  await context.addInitScript(recordVibration);
  await context.addInitScript(() => localStorage.setItem('gridlock.tutorial.v1', '{"status":"done"}'));
  const page = await context.newPage();
  const errors = watchForBrowserErrors(page);
  try {
    await page.goto(base, { waitUntil: 'networkidle' });
    const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
    await page.getByRole('button', { name: 'Settings' }).click();
    if (!coarse) assert.equal(await page.isVisible('#haptics-row'), false, 'no haptics switch on desktop');
    await page.locator('[data-screen="settings"] [data-nav="back"]').click();
    await page.getByRole('button', { name: 'New Game' }).click();
    await page.click('#setup-start');
    if (await page.locator('#handoff-dialog[open]').count()) await page.click('#handoff-ready');
    const road = (id) => page.locator(`#board [data-road="${id}"]`);
    await road('h-0-0').click();
    assert.ok(await road('h-0-0').evaluate((el) => el.classList.contains('is-built')), 'mouse click paves at once');
    if (await page.locator('#handoff-dialog[open]').count()) await page.click('#handoff-ready');
    await page.waitForTimeout(400);
    await road('h-0-1').tap();
    assert.ok(await road('h-0-1').evaluate((el) => el.classList.contains('is-armed')), 'a finger tap on a touch laptop previews first');
    await road('h-0-1').tap();
    assert.ok(await road('h-0-1').evaluate((el) => el.classList.contains('is-built')));
    if (!coarse) assert.deepEqual(await page.evaluate(() => window.__vib), [], 'desktop never vibrates');
    assert.deepEqual(errors, []);
    console.log('✔ desktop unchanged; touchscreen laptop previews finger taps');
  } catch (err) {
    failures++;
    console.error(`✘ desktop/touch laptop: ${err.message}`);
    await page.screenshot({ path: 'test-results/touch-laptop-FAIL.png' }).catch(() => {});
  } finally {
    await context.close();
  }
}

// First-game tutorial: all eight tips appear in context during real play, never block it, and completion persists.
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  await context.addInitScript(() => {
    if (!sessionStorage.getItem('gl-test-init')) {
      sessionStorage.setItem('gl-test-init', '1');
      localStorage.setItem('gridlock.settings.v1', JSON.stringify({ confirmTaps: false, quickHandoff: true }));
    }
  });
  const page = await context.newPage();
  const errors = watchForBrowserErrors(page);
  const road = (id) => page.locator(`#board [data-road="${id}"]`);
  const tip = (id) => page.locator(`.coach-mark[data-step="${id}"]`);
  const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('gridlock.tutorial.v1')));
  const seen = async () => (await page.evaluate(() => window.__GRIDLOCK__.tutorial())).seen;
  try {
    await page.goto(`${base}?seed=19&debug`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'New Game' }).click();
    await page.click('#setup-start');
    // 1. Manage City: shown at once, and the game stays fully playable around it.
    await tip('manage').waitFor();
    assert.match(await tip('manage').textContent(), /Tip 1 of 8.*Manage City/s);
    assert.equal(await page.locator('.coach-mark').count(), 1, 'one note at a time');
    await page.click('#action-pave'); // acting moves the tutorial on
    // 2. Pave Road.
    await tip('pave').waitFor();
    await tip('pave').getByRole('button', { name: 'Got it' }).click();
    assert.equal(await page.locator('.coach-mark').count(), 0);
    for (const id of ['h-0-0', 'v-0-0', 'h-1-0']) await road(id).click();
    // 3. Completing a block: points at A1, the block with three roads.
    await tip('complete').waitFor();
    const note = await tip('complete').boundingBox();
    const block = await page.locator('[data-block="r0c0"]').boundingBox();
    assert.ok(Math.abs(note.y - (block.y + block.height)) < 60 || Math.abs(note.y + note.height - block.y) < 60, 'note sits by the block');
    await road('v-0-1').click(); // never blocks: pave straight through
    // 4. Develop Now / Leave Vacant: inside the capture dialog.
    await page.locator('#capture-choice-dialog .coach-mark[data-step="develop"]').waitFor();
    await page.click('[data-capture-choice="develop"]');
    await page.locator('#build-dialog [data-build="residential"]').click();
    // 5. Bonus road.
    await tip('bonus').waitFor();
    await road('h-6-5').click();
    // 7. City event (the seeded Fire), inside its card.
    await page.locator('#event-dialog .coach-mark[data-step="events"]').waitFor();
    await page.click('#event-continue');
    // 6. Income & upkeep: at Player 4's next turn start.
    for (const id of ['h-6-4', 'h-6-3', 'h-6-2']) await road(id).click();
    await tip('income').waitFor();
    assert.deepEqual(await seen(), ['manage', 'pave', 'complete', 'develop', 'bonus', 'events']);
    // 8. Winning/scoring: on the results screen.
    const last = await page.evaluate(async () => {
      const { allRoadIds, getBlock } = await import('/js/core/board.js');
      const g = window.__GRIDLOCK__.getGame();
      g.eventPool = [];
      const ids = allRoadIds(g.board);
      ids.slice(0, -1).forEach((id) => { if (g.board.roads[id] == null) g.board.roads[id] = 1; });
      const b = getBlock(g.board, 5, 5);
      if (b.ownerSeat == null) { b.abandoned = true; b.abandonedBy = 1; }
      return ids.at(-1);
    });
    await road(last).click();
    const scoring = page.locator('#results-dialog .coach-mark[data-step="scoring"]');
    await scoring.waitFor();
    assert.match(await scoring.textContent(), /Tip 8 of 8.*City Value/s);
    await scoring.getByRole('button', { name: 'Got it' }).click();
    assert.match(await page.textContent('#toasts'), /Tutorial complete/);
    assert.deepEqual(await saved(), { status: 'done', seen: ['manage', 'pave', 'complete', 'develop', 'bonus', 'income', 'events', 'scoring'] });
    await page.screenshot({ path: 'test-results/tutorial-complete.png' });

    // Completion persists: the next game has no tips.
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'New Game' }).click();
    await page.click('#setup-start');
    await road('h-0-0').click();
    assert.equal(await page.locator('.coach-mark').count(), 0, 'no tips after completing the tutorial');
    assert.deepEqual(errors, []);
    console.log('✔ tutorial: all 8 tips in context, never blocking, completion persists');
  } catch (err) {
    failures++;
    console.error(`✘ tutorial (complete): ${err.message}`);
    await page.screenshot({ path: 'test-results/tutorial-FAIL.png' }).catch(() => {});
  } finally {
    await context.close();
  }
}

// Tutorial skip persists; Replay Tutorial from How To Play (next game) and Settings (current game).
{
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, ...(browserName === 'firefox' ? {} : { isMobile: true }), hasTouch: true, reducedMotion: 'reduce',
  });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  await context.addInitScript(() => {
    if (!sessionStorage.getItem('gl-test-init')) {
      sessionStorage.setItem('gl-test-init', '1');
      localStorage.setItem('gridlock.settings.v1', JSON.stringify({ confirmTaps: false, quickHandoff: true }));
    }
  });
  const page = await context.newPage();
  const errors = watchForBrowserErrors(page);
  const status = async () => (await page.evaluate(() => JSON.parse(localStorage.getItem('gridlock.tutorial.v1'))))?.status;
  const startNewGame = async () => {
    await page.getByRole('button', { name: 'New Game' }).click();
    await page.click('#setup-start');
  };
  try {
    await page.goto(base, { waitUntil: 'networkidle' });
    await startNewGame();
    await page.locator('.coach-mark[data-step="manage"]').waitFor();
    await noHorizontalScroll(page, 'tutorial note on a phone');
    await page.locator('.coach-mark').getByRole('button', { name: 'Skip tutorial' }).click();
    assert.equal(await page.locator('.coach-mark').count(), 0, 'skip removes the note');
    assert.match(await page.textContent('#toasts'), /Tutorial skipped/);
    assert.equal(await status(), 'skipped');

    // Skip persists across reloads and new games.
    await page.reload({ waitUntil: 'networkidle' });
    await startNewGame();
    await page.click('#board [data-road="h-0-0"]');
    assert.equal(await page.locator('.coach-mark').count(), 0, 'no tips after skipping');
    assert.equal(await status(), 'skipped');

    // Replay from How To Play: tips return in the next game.
    await page.click('#game-menu-btn');
    await page.click('#pause-dialog [data-dialog-action="save-quit"]');
    await page.getByRole('button', { name: 'How To Play' }).click();
    await page.locator('[data-screen="howto"] [data-replay-tutorial]').click();
    assert.match(await page.textContent('#toasts'), /next game/);
    assert.equal(await status(), 'active');
    await page.locator('[data-screen="howto"] [data-nav="back"]').click();
    await startNewGame();
    await page.locator('.coach-mark[data-step="manage"]').waitFor();
    await page.locator('.coach-mark').getByRole('button', { name: 'Skip tutorial' }).click();

    // Replay from Settings mid-game: tips start in this game.
    await page.locator('[data-screen="game"] [data-nav="settings"]').click();
    await page.locator('[data-screen="settings"] [data-replay-tutorial]').click();
    assert.match(await page.textContent('#toasts'), /as you play/);
    await page.locator('[data-screen="settings"] [data-nav="back"]').click();
    await page.locator('.coach-mark[data-step="manage"]').waitFor();
    assert.equal(await status(), 'active');
    assert.deepEqual(errors, []);
    console.log('✔ tutorial: skip persists; replay from How To Play and Settings');
  } catch (err) {
    failures++;
    console.error(`✘ tutorial (skip/replay): ${err.message}`);
    await page.screenshot({ path: 'test-results/tutorial-skip-FAIL.png' }).catch(() => {});
  } finally {
    await context.close();
  }
}

await browser.close();
server.close();
if (failures) {
  console.error(`\n${failures} viewport(s) failed`);
  process.exit(1);
}
console.log('\nAll smoke tests passed.');
