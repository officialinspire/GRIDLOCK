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

/** CITY era: every mayor ends their City turns (clearing event cards and handoffs) until the results open. */
async function playOutCityEra(page) {
  for (let i = 0; i < 80; i++) {
    if (await page.locator('#results-dialog[open]').count()) return;
    for (const [sel, click] of [['#event-dialog', '#event-continue'], ['#handoff-dialog', '#handoff-ready'],
      ['#capture-choice-dialog', '[data-capture-choice="vacant"]']]) {
      if (await page.locator(`${sel}[open]`).count()) await page.click(click);
    }
    if (await page.locator('#finance-dialog[open]').count()) {
      await page.locator('#finance-dialog').locator('[data-downgrade], [data-sell], #declare-bankruptcy, [data-action="close"]').first().click();
    } else if (await page.isVisible('#action-end-turn')) await page.click('#action-end-turn');
    else await page.waitForTimeout(50);
  }
}

async function dismissEvent(page) {
  if (await page.locator('#event-dialog[open]').count()) await page.click('#event-continue');
}

const server = await startServer(0);
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await browserType.launch(launchOpts);
// Most runs start as a player already past the start screen and INSPIRE intro this session
// (as after a reload). `freshStart: true` opens a context on the start screen instead.
{
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async ({ freshStart = false, ...options } = {}) => {
    const context = await newContext(options);
    if (!freshStart) await context.addInitScript(() => { try { sessionStorage.setItem('gridlock.session.v1', 'started'); } catch { /* ignore */ } });
    return context;
  };
}
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
  let navigations = 0;
  const startedAt = new WeakMap();
  const loaded = new Set();
  const abortedErrors = new Map(); // url → error entries awaiting a successful load
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    const source = message.location().url ?? '';
    // Firefox reports a load the page cancelled while the service worker was answering it as
    // "A ServiceWorker intercepted the request and encountered an unexpected error": the same
    // cancellation as NS_BINDING_ABORTED below, so it gets the same rule.
    // A cancelled image stream can also surface as "Image corrupt or truncated." for that image.
    const swCancel = message.type() === 'error'
      && (message.text().match(/Failed to load ‘([^’]+)’\. A ServiceWorker intercepted the request and encountered an unexpected error/)
        ?? (/Image corrupt or truncated/.test(message.text()) && source ? [null, source] : null));
    if (swCancel) {
      const url = swCancel[1];
      if (loaded.has(url)) return;
      const entry = `console: ${message.text()}`;
      errors.push(entry);
      abortedErrors.set(url, [...(abortedErrors.get(url) ?? []), entry]);
      return;
    }
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
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations++; });
  page.on('request', (request) => startedAt.set(request, navigations));
  page.on('requestfailed', (request) => {
    const url = request.url();
    if (optionalFont(url)) return;
    const aborted = /abort|cancel/i.test(request.failure()?.errorText ?? '');
    if (aborted && (navigations > (startedAt.get(request) ?? navigations) || loaded.has(url))) return;
    // <audio>/<video> cancel their own streaming range requests when they pause, seek or loop.
    if (aborted && /\/assets\/media\/[^/?]+\.(?:mp3|mp4)(?:\?|$)/.test(url)) return;
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
    for (const label of ['Play Solo', 'Local Multiplayer', 'Custom / Mixed Game', 'How To Play', 'Statistics', 'Settings']) {
      assert.ok(await page.getByRole('button', { name: label }).isVisible(), `${label} button`);
    }
    assert.equal(await page.$$eval('[data-sprite]', (els) => els.length), 0, 'all static sprites hydrated');
    await noHorizontalScroll(page, 'title');
    await shot('1-title');

    await page.getByRole('button', { name: 'How To Play' }).click();
    assert.ok(await page.isVisible('[data-screen="howto"]'));
    assert.equal(await page.locator('.howto-card').count(), 12); // incl. Prestige & Takeovers
    await noHorizontalScroll(page, 'howto');
    await shot('2-howto');
    await page.locator('[data-screen="howto"] [data-nav="back"]').click();

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.locator('label.setting-row', { hasText: 'Show block coordinates' }).click();
    assert.equal(await page.locator('input[name="music"]').count(), 1, 'the Music switch');
    await noHorizontalScroll(page, 'settings');
    await shot('3-settings');
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Settings' }).click();
    assert.equal(await page.isChecked('input[name="showCoords"]'), true, 'coords persisted');
    await page.locator('[data-screen="settings"] [data-nav="back"]').click();

    await page.getByRole('button', { name: 'Local Multiplayer' }).click();
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

    assert.match(await page.textContent('#turn-prompt'), /MANAGE CITY · 1 Development Action left/);
    assert.match(await page.textContent('#hud-era'), /^Expansion · 1 action$/);
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
    await playOutCityEra(page);
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
    await page.getByRole('button', { name: 'Local Multiplayer' }).click();
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
    assert.match(await fin.textContent(), /restarts you with \$2,000\. You stay in the game/);
    await fin.locator('#declare-bankruptcy').click();
    const card = await fin.textContent();
    assert.match(card, /2 blocks abandoned/);
    assert.match(card, /Recovery capital: \$2,000\. .* plays on this turn/);
    assert.match(card, /Bankruptcy #1: final score −\$1,000 City Value and −2 Prestige/);
    assert.match(card, /would pay only \$1,000/);
    await fin.getByRole('button', { name: 'Continue' }).click();
    assert.equal(await page.locator('#board .block--abandoned').count(), 2);
    assert.match(await page.textContent('#turn-prompt'), /Recovering from bankruptcy/);
    assert.match(await page.textContent('.player-card[data-seat="3"]'), /↺1 Recovering/);

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
    await page.getByRole('button', { name: 'Local Multiplayer' }).click();
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
    await page.getByRole('button', { name: 'Local Multiplayer' }).click();
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
    await page.getByRole('button', { name: 'Local Multiplayer' }).click();
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
    // The final road starts the CITY era: no Pave Road, an End Turn button and the era in the HUD.
    await page.waitForFunction(() => window.__GRIDLOCK__.getGame().era === 'city');
    assert.ok(await page.isHidden('#action-pave'));
    assert.ok(await page.isVisible('#action-end-turn'));
    assert.ok(await page.isHidden('.round-badge__roads'));
    // The final mover already had this turn's Development Action: no City Actions until next round.
    assert.match(await page.textContent('#hud-era'), /^City · 4 rounds to go · 0 actions$/);
    assert.match(await page.textContent('#turn-prompt'), /CITY TURN · 0 City Actions left \(this turn's Development Action came before the final road\), then End Turn/);
    await page.click('#action-end-turn');
    assert.match(await page.textContent('#turn-prompt'), /CITY TURN · 2 City Actions left: build, upgrade, sell or redevelop/);
    for (let turns = 0; turns < 40; turns++) {
      if (await page.evaluate(() => window.__GRIDLOCK__.getGame().phase === 'ended')) break;
      if (turns === 3) assert.match(await page.textContent('#hud-era'), /^City 1\/4 · 2 actions$/); // seat 1 already ended its turn
      await page.click('#action-end-turn');
    }
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

// Hostile takeover (City era): a rival block shows price, pressure vs control, and refusals.
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  await context.addInitScript(() => (localStorage.setItem('gridlock.tutorial.v1', '{"status":"done"}'), localStorage.setItem('gridlock.settings.v1', JSON.stringify({ confirmTaps: false, quickHandoff: true }))));
  const page = await context.newPage();
  const errors = watchForBrowserErrors(page);
  try {
    await page.goto(`${base}?seed=1&debug`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Local Multiplayer' }).click();
    await page.click('#setup-start');
    const last = await page.evaluate(async () => {
      const { allRoadIds, getBlockById } = await import('/js/core/board.js');
      const { applyDevelopment } = await import('/js/core/development.js');
      const { refreshBonuses } = await import('/js/core/bonuses.js');
      const g = window.__GRIDLOCK__.getGame();
      g.eventPool = [];
      const ids = allRoadIds(g.board);
      ids.slice(0, -1).forEach((id) => { g.board.roads[id] = 1; });
      // Seat 2's House (control 3) and a bare lot, next to seat 1's Market and Corner Store.
      for (const [id, seat, type, level] of [['r2c2', 2, 'residential', 1], ['r3c3', 2, 'vacant', 0],
        ['r2c3', 1, 'commercial', 2], ['r1c2', 1, 'commercial', 1]]) {
        Object.assign(getBlockById(g.board, id), { ownerSeat: seat });
        applyDevelopment(getBlockById(g.board, id), type, level);
      }
      for (const b of g.board.blocks) if (b.ownerSeat == null) { b.abandoned = true; b.abandonedBy = 4; }
      refreshBonuses(g.board);
      return ids.at(-1);
    });
    // EXPANSION: a rival block only opens the inspector.
    await page.click('#board [data-block="r2c2"]');
    assert.equal(await page.locator('#build-dialog[open]').count(), 0, 'no takeovers before the City era');
    assert.match(await page.textContent('#inspector'), /Your pressure\s*8 vs 3/);
    await pave(page, page.locator(`[data-road="${last}"]`));
    await page.waitForFunction(() => window.__GRIDLOCK__.getGame().era === 'city');

    await page.click('#board [data-block="r2c2"]');
    const panel = page.locator('#build-dialog');
    await panel.waitFor({ state: 'visible' });
    const text = await panel.textContent();
    assert.match(text, /Your pressure 8/);
    assert.match(text, /Control 3/);
    assert.match(text, /Takeover \$3,750: .* receives the market value \$3,000; \$750 is lost/);
    await panel.locator('[data-takeover]').click();
    await page.waitForFunction(() => window.__GRIDLOCK__.getGame().board.blocks.find((b) => b.id === 'r2c2').ownerSeat === 1);
    assert.match(await page.textContent('#toasts'), /Took over C3/);
    assert.match(await page.textContent('#hud-era'), /1 action$/);

    // A second takeover the same turn is refused, with the reason on the panel.
    await page.click('#board [data-block="r3c3"]');
    await panel.waitFor({ state: 'visible' });
    assert.match(await panel.textContent(), /Only 1 takeover per turn/);
    assert.equal(await panel.locator('[data-takeover]').getAttribute('aria-disabled'), 'true');
    await panel.locator('[data-action="close"]').click();
    const log = await page.evaluate(() => window.__GRIDLOCK__.getGame().log.filter((e) => e.type === 'takeover'));
    assert.deepEqual(log.map((e) => [e.seat, e.from, e.label, e.cost]), [[1, 2, 'C3', 3750]]);
    assert.deepEqual(errors, []);
    console.log('✔ hostile takeover: City era only, price + pressure vs control, one per turn');
  } catch (err) {
    failures++;
    console.error(`✘ takeover: ${err.message}`);
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
    const btn = await page.locator('[data-setup-preset="solo"]').evaluate((el) => getComputedStyle(el).borderImageSource);
    assert.match(btn, /generated\/ui\/btn-gold\.png/);
    await page.getByRole('button', { name: 'Local Multiplayer' }).click();
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
    // Level 3: annex, two corners and a street piece; the street piece is hidden on a phone this narrow.
    assert.equal(await page.locator('[data-block="r0c0"] .block__prop').count(), 4);
    for (const slot of ['annex', 'corner-left', 'corner-right']) {
      assert.ok(await page.locator(`[data-block="r0c0"] .block__prop--${slot}`).isVisible(), slot);
    }
    assert.equal(await page.locator('[data-block="r0c0"] .block__prop--street').isVisible(), false);
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
    await page.getByRole('button', { name: 'Local Multiplayer' }).click();
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
    await page.getByRole('button', { name: 'Local Multiplayer' }).click();
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
    await page.getByRole('button', { name: 'Local Multiplayer' }).click();
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
    await page.getByRole('button', { name: 'Local Multiplayer' }).click();
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
    await page.getByRole('button', { name: 'Local Multiplayer' }).tap();
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
      g.city.rounds = 0; // staged finish goes straight to results (the City era has its own scenario)
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
      await page.getByRole('button', { name: 'Local Multiplayer' }).tap();
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
    await page.getByRole('button', { name: 'Local Multiplayer' }).click();
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
    await page.getByRole('button', { name: 'Local Multiplayer' }).click();
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
      g.city.rounds = 0; // staged finish goes straight to results (the City era has its own scenario)
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
    await page.getByRole('button', { name: 'Local Multiplayer' }).click();
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
    await page.getByRole('button', { name: 'Local Multiplayer' }).click();
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

// Rule presets: description before starting, mode shown in game/pause/results, preserved by autosave.
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  await context.addInitScript(() => {
    if (!sessionStorage.getItem('gl-test-init')) {
      sessionStorage.setItem('gl-test-init', '1');
      (localStorage.setItem('gridlock.tutorial.v1', '{"status":"done"}'), localStorage.setItem('gridlock.settings.v1', JSON.stringify({ confirmTaps: false, quickHandoff: true })));
    }
  });
  const page = await context.newPage();
  const errors = watchForBrowserErrors(page);
  const road = (id) => page.locator(`#board [data-road="${id}"]`);
  const chip = () => page.textContent('#hud-mode');
  try {
    await page.goto(`${base}?seed=4&debug`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Local Multiplayer' }).click();
    // Three presets, each with its description, Standard preselected.
    const options = page.locator('#setup-rules .rule-option');
    assert.equal(await options.count(), 3);
    assert.deepEqual(await page.locator('.rule-option__name').allTextContents(), ['Standard', 'Classic', 'Urban Chaos']);
    for (const blurb of await page.locator('.rule-option__blurb').allTextContents()) assert.ok(blurb.length > 20);
    assert.equal(await page.isChecked('[name="mode"][value="standard"]'), true);
    assert.match(await page.textContent('#setup-summary'), /Standard Game · 4 players · .* · Standard rules/);

    // Urban Chaos with a Custom 3-player table.
    await page.check('[name="gameType"][value="custom"]');
    await page.locator('label[for="seat-4-join"]').click();
    await page.locator('.rule-option', { hasText: 'Urban Chaos' }).click();
    assert.match(await page.textContent('#setup-summary'), /Custom Game · 3 players · .* · Urban Chaos rules/);
    await noHorizontalScroll(page, 'setup with rules');
    await page.screenshot({ path: 'test-results/modes-setup.png' });
    await page.click('#setup-start');
    assert.equal(await chip(), 'Urban Chaos rules', 'mode shown during play');
    assert.equal((await page.evaluate(() => window.__GRIDLOCK__.getGame().mode)), 'chaos');
    await page.click('#game-menu-btn');
    assert.match(await page.textContent('#pause-mode'), /Urban Chaos rules/);
    await page.click('#pause-dialog [data-dialog-action="resume"]');

    // Round 1 → 2: Urban Chaos always starts an event.
    for (const id of ['h-0-0', 'h-0-1', 'h-0-2']) await road(id).click();
    assert.ok(await page.isVisible('#event-dialog'), 'an event every round');
    await page.click('#event-continue');

    // Autosave/restore keeps the mode (and the table).
    await page.reload({ waitUntil: 'networkidle' });
    await page.click('#continue-game');
    assert.equal(await chip(), 'Urban Chaos rules', 'mode restored');
    assert.equal(await page.locator('.player-card:not(.is-empty)').count(), 3);

    // Results show the mode; Play Again keeps it.
    const last = await page.evaluate(async () => {
      const { allRoadIds, getBlock } = await import('/js/core/board.js');
      const g = window.__GRIDLOCK__.getGame();
      g.eventPool = [];
      const ids = allRoadIds(g.board).filter((id) => g.board.roads[id] == null);
      ids.slice(0, -1).forEach((id) => { g.board.roads[id] = 1; });
      g.city.rounds = 0; // staged finish goes straight to results (the City era has its own scenario)
      for (const b of g.board.blocks) if (b.ownerSeat == null) { b.abandoned = true; b.abandonedBy = 1; }
      return ids.at(-1);
    });
    await road(last).click();
    await page.locator('#results-dialog').waitFor({ state: 'visible' });
    assert.match(await page.textContent('#results-mode'), /^Urban Chaos rules · 3 players/);
    await page.click('#results-dialog [data-results-action="rematch"]');
    assert.equal(await chip(), 'Urban Chaos rules', 'Play Again keeps the mode');

    // Classic: no city events and no "calm round" notes.
    await page.click('#game-menu-btn');
    await page.click('#pause-dialog [data-dialog-action="save-quit"]');
    await page.getByRole('button', { name: 'Local Multiplayer' }).click();
    await page.check('[name="gameType"][value="standard"]');
    await page.locator('.rule-option', { hasText: 'Classic' }).click();
    await page.click('#setup-start');
    assert.equal(await chip(), 'Classic rules');
    for (let round = 0; round < 3; round++) {
      for (const id of [`h-${round + 1}-0`, `h-${round + 1}-1`, `h-${round + 1}-2`, `h-${round + 1}-3`]) await road(id).click();
      assert.equal(await page.isVisible('#event-dialog'), false, 'no events in Classic');
    }
    assert.doesNotMatch(await page.textContent('#toasts'), /Calm round/);
    assert.equal(await page.locator('.event-pill').count(), 0);
    assert.deepEqual(errors, []);
    console.log('✔ rule presets: setup descriptions, mode in game/pause/results, autosave, rematch, classic, chaos');
  } catch (err) {
    failures++;
    console.error(`✘ rule presets: ${err.message}`);
    await page.screenshot({ path: 'test-results/modes-FAIL.png' }).catch(() => {});
  } finally {
    await context.close();
  }
}

// Career statistics & achievements: staged games never count; a real completed match does, and persists.
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  await context.addInitScript(() => {
    if (!sessionStorage.getItem('gl-test-init')) {
      sessionStorage.setItem('gl-test-init', '1');
      (localStorage.setItem('gridlock.tutorial.v1', '{"status":"done"}'), localStorage.setItem('gridlock.settings.v1', JSON.stringify({ confirmTaps: false, quickHandoff: true })));
    }
  });
  const page = await context.newPage();
  const errors = watchForBrowserErrors(page);
  const career = () => page.evaluate(() => JSON.parse(localStorage.getItem('gridlock.career.v1')));
  const newGame = async (mode, players) => {
    await page.getByRole('button', { name: 'Local Multiplayer' }).click();
    await page.check(`[name="gameType"][value="${players === 4 ? 'standard' : 'custom'}"]`);
    for (let s = players + 1; s <= 4; s++) await page.locator(`label[for="seat-${s}-join"]`).click();
    await page.locator('.rule-option', { hasText: mode }).click();
    await page.click('#setup-start');
  };
  try {
    await page.goto(`${base}?seed=21&debug`, { waitUntil: 'networkidle' });

    // 1. Debug staging that ends a game records nothing and awards nothing.
    await newGame('Standard', 4);
    const last = await page.evaluate(async () => {
      const { allRoadIds } = await import('/js/core/board.js');
      const g = window.__GRIDLOCK__.getGame();
      const ids = allRoadIds(g.board).filter((id) => g.board.roads[id] == null);
      ids.slice(0, -1).forEach((id) => { g.board.roads[id] = 1; });
      g.city.rounds = 0; // staged finish goes straight to results (the City era has its own scenario)
      for (const b of g.board.blocks) b.abandoned = b.ownerSeat == null ? (b.abandonedBy = 1, true) : b.abandoned;
      return ids.at(-1);
    });
    await page.click(`#board [data-road="${last}"]`);
    await page.locator('#results-dialog').waitFor({ state: 'visible' });
    assert.equal(await page.isVisible('#results-unlocked'), false, 'no achievements for a staged game');
    assert.equal(await career(), null, 'nothing recorded');
    await page.click('#results-dialog [data-results-action="title"]');
    await page.getByRole('button', { name: 'Statistics' }).click();
    assert.equal(await page.isVisible('#career-empty'), true, 'empty career');
    assert.equal(await page.textContent('#career-badge-count'), '0 / 24');
    await page.locator('[data-screen="stats"] [data-nav="back"]').click();

    // 2. A real match, played to the end through the game's own controls (Classic, 2 mayors).
    await newGame('Classic', 2);
    await page.evaluate(() => {
      for (let i = 0; i < 400; i++) {
        const vacant = document.querySelector('#capture-choice-dialog[open] [data-capture-choice="vacant"]');
        if (vacant) { vacant.click(); continue; }
        const road = document.querySelector('#board .road:not(.is-built):not(:disabled)');
        const endTurn = document.querySelector('#action-end-turn:not([hidden]):not(:disabled)'); // CITY era
        if (road) road.click();
        else if (endTurn) endTurn.click();
        else break;
      }
    });
    await page.locator('#results-dialog').waitFor({ state: 'visible' });
    await page.locator('#results-unlocked').waitFor({ state: 'visible' });
    const unlocked = await page.locator('#results-badges .badge__name').allTextContents();
    for (const name of ['Ribbon Cutting', 'Mayor of the Year', 'Purist']) assert.ok(unlocked.includes(name), `${name} unlocked (${unlocked})`);
    await page.screenshot({ path: 'test-results/career-results.png' });
    const saved = await career();
    assert.equal(saved.version, 1);
    assert.equal(saved.totals.matches, 1);
    assert.equal(saved.totals.eventsSurvived, 0, 'Classic: no events');
    assert.equal(Object.keys(saved.mayors).length, 2);
    assert.ok(saved.totals.blocksCaptured > 0 && saved.totals.blocksCaptured <= 36);
    assert.equal(await page.evaluate(() => localStorage.getItem('gridlock.active-game')), null, 'separate from the active-game save');

    // 3. The Statistics screen shows it, and it survives a reload.
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Statistics' }).click();
    assert.equal(await page.isVisible('#career-empty'), false);
    assert.match(await page.textContent('#career-stats'), /Matches completed\s*1/);
    assert.equal(await page.locator('#career-mayors tbody tr').count(), 2);
    assert.equal(await page.locator('#career-badges .badge').count(), 24);
    assert.ok(await page.locator('#career-badges .badge.is-earned').count() >= 3);
    assert.match(await page.textContent('#career-badge-count'), /^\d+ \/ 24$/);
    await noHorizontalScroll(page, 'statistics');
    await page.screenshot({ path: 'test-results/career-stats.png', fullPage: true });

    // 4. Corrupt data fails safely: a fresh record, a notice, and the old data kept aside.
    await page.evaluate(() => localStorage.setItem('gridlock.career.v1', '{"version":1,"totals":"broken"'));
    await page.locator('[data-screen="stats"] [data-nav="back"]').click();
    await page.getByRole('button', { name: 'Statistics' }).click();
    assert.equal(await page.isVisible('#career-empty'), true);
    assert.match(await page.textContent('#career-note'), /could not be read/);
    assert.equal(await page.evaluate(() => localStorage.getItem('gridlock.career.corrupt')), '{"version":1,"totals":"broken"');
    assert.deepEqual(errors, []);
    console.log('✔ career: staged games ignored; real match recorded + badges; persists; corrupt data safe');
  } catch (err) {
    failures++;
    console.error(`✘ career: ${err.message}`);
    await page.screenshot({ path: 'test-results/career-FAIL.png' }).catch(() => {});
  } finally {
    await context.close();
  }
}

// Strategic information: forecasts in the Build panel match what actually happens; inspector details.
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  await context.addInitScript(() => {
    if (!sessionStorage.getItem('gl-test-init')) {
      sessionStorage.setItem('gl-test-init', '1');
      (localStorage.setItem('gridlock.tutorial.v1', '{"status":"done"}'), localStorage.setItem('gridlock.settings.v1', JSON.stringify({ confirmTaps: false, quickHandoff: true })));
    }
  });
  const page = await context.newPage();
  const errors = watchForBrowserErrors(page);
  const money = (text) => Number(text.replace(/[^0-9−-]/g, '').replace('−', '-'));
  const position = () => page.evaluate(async () => {
    const { playerStats, currentPlayer } = await import('/js/core/game.js');
    const { scorePlayer } = await import('/js/core/scoring.js');
    const g = window.__GRIDLOCK__.getGame();
    const p = currentPlayer(g);
    const s = playerStats(g, p);
    return { cash: p.cash, income: s.income, upkeep: s.upkeep, cityValue: scorePlayer(g, p).cityValue };
  });
  try {
    await page.goto(`${base}?seed=19&debug`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Local Multiplayer' }).click();
    await page.click('#setup-start');
    for (const id of ['h-0-0', 'v-0-0', 'h-1-0', 'v-0-1']) await page.click(`#board [data-road="${id}"]`);
    // P4 owns two neighbouring homes and a Housing Boom is on: a third home activates a district bonus.
    await page.evaluate(async () => {
      const { getBlock } = await import('/js/core/board.js');
      const { applyDevelopment } = await import('/js/core/development.js');
      const { refreshBonuses } = await import('/js/core/bonuses.js');
      const { startEvent } = await import('/js/core/events.js');
      const g = window.__GRIDLOCK__.getGame();
      for (const c of [1, 2]) { const b = getBlock(g.board, 0, c); b.ownerSeat = 4; applyDevelopment(b, 'residential', 1); }
      refreshBonuses(g.board);
      startEvent(g, 'housing-boom');
    });
    await page.click('[data-capture-choice="develop"]');
    const panel = page.locator('#build-dialog');

    // Every option shows its forecast; the tooltip has the full breakdown.
    assert.equal(await panel.locator('.build-option .forecast-line').count(), 6);
    const tip = await panel.locator('[data-build="residential"]').getAttribute('title');
    for (const part of ['Cost $1,250 (normally $1,000)', 'Your income', 'Upkeep', 'Net', 'City Value', 'Price: Housing Boom +25%',
      'Income: Housing Boom +50%', 'Activates: Residential district']) assert.ok(tip.includes(part), `tooltip has "${part}"`);
    await panel.locator('.forecast-compare summary').click();
    assert.equal(await panel.locator('.forecast-table tbody tr').count(), 6);
    const row = panel.locator('.forecast-table tr[data-forecast="residential"] td');
    const forecastNet = money(await row.nth(1).textContent());
    const forecastCV = money(await row.nth(2).textContent());
    assert.equal(await row.nth(3).textContent(), '★ 3');

    // Build it for real: the actual changes equal the forecast.
    const before = await position();
    await panel.locator('[data-build="residential"]').click();
    const after = await position();
    assert.equal(before.cash - after.cash, 1250, 'paid what the forecast said');
    assert.equal((after.income - after.upkeep) - (before.income - before.upkeep), forecastNet, 'net per turn as forecast');
    assert.equal(after.cityValue - before.cityValue, forecastCV, 'City Value change as forecast');

    // Inspector: income (event marker), upkeep, net, City Value contribution, price effect, bonuses.
    await page.click('#board [data-block="r0c1"]');
    const insp = await page.textContent('#inspector');
    for (const part of ['Upkeep', 'Net', 'Property value', 'Adds to City Value', 'Upgrade price', 'Housing Boom', 'Residential district']) {
      assert.ok(insp.includes(part), `inspector shows "${part}"`);
    }
    assert.match(await page.getAttribute('#inspector .inspector__event', 'title'), /normally \$\d/);

    // Upgrade card: full breakdown; the upgrade then matches it.
    await page.evaluate(() => {
      const g = window.__GRIDLOCK__.getGame();
      g.turnPhase = 'manage-city'; // stage P4's Manage City to reach the upgrade card
      g.pendingCaptures = [];
    });
    await page.click('#board [data-block="r0c0"]');
    const card = panel.locator('.upgrade-card .forecast');
    await card.waitFor();
    const dd = async (label) => card.locator(`dt:text-is("${label}") + dd`).textContent();
    const income = await dd('Your income');
    const projected = money(income.split('→')[1]);
    await panel.locator('[data-upgrade]').click();
    assert.equal((await position()).income, projected, 'upgrade income as forecast');
    assert.deepEqual(errors, []);
    console.log('✔ strategic info: build/upgrade forecasts match real outcomes; inspector details');
  } catch (err) {
    failures++;
    console.error(`✘ strategic info: ${err.message}`);
    await page.screenshot({ path: 'test-results/forecast-FAIL.png' }).catch(() => {});
  } finally {
    await context.close();
  }
}

// Replayable cities: challenge links pre-fill setup, the seed shows in pause/results,
// Replay Same City rolls the same events for the same moves, and copying falls back to a text box.
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  await context.addInitScript(() => {
    if (!sessionStorage.getItem('gl-test-init')) {
      sessionStorage.setItem('gl-test-init', '1');
      (localStorage.setItem('gridlock.tutorial.v1', '{"status":"done"}'), localStorage.setItem('gridlock.settings.v1', JSON.stringify({ confirmTaps: false, quickHandoff: true })));
    }
  });
  const page = await context.newPage();
  const errors = watchForBrowserErrors(page);
  const road = (id) => page.locator(`#board [data-road="${id}"]`);
  // Horizontal roads never close a block, so every run makes exactly the same moves.
  const MOVES = ['h-0-0', 'h-0-1', 'h-0-2', 'h-1-0', 'h-1-1', 'h-1-2', 'h-2-0', 'h-2-1', 'h-2-2', 'h-3-0', 'h-3-1', 'h-3-2', 'h-4-0', 'h-4-1', 'h-4-2'];
  const playMoves = async () => {
    for (const id of MOVES) {
      await road(id).click();
      await dismissEvent(page);
    }
    return page.evaluate(() => JSON.stringify(window.__GRIDLOCK__.getGame().events.history));
  };
  const finishCity = () => page.evaluate(async () => {
    const { allRoadIds } = await import('./js/core/board.js');
    const g = window.__GRIDLOCK__.getGame();
    g.eventPool = [];
    const ids = allRoadIds(g.board).filter((id) => g.board.roads[id] == null);
    ids.slice(0, -1).forEach((id) => { g.board.roads[id] = 1; });
    g.city.rounds = 0; // staged finish goes straight to results (the City era has its own scenario)
    for (const b of g.board.blocks) if (b.ownerSeat == null) { b.abandoned = true; b.abandonedBy = 1; }
    return ids.at(-1);
  });
  try {
    await page.goto(`${base}?seed=31337&mode=chaos&seats=134&debug`, { waitUntil: 'networkidle' });
    assert.equal(new URL(page.url()).search, '?debug', 'challenge parameters leave the address bar; ?debug stays');
    assert.match(await page.textContent('#toasts'), /Challenge city 31337 · Urban Chaos rules/);
    await page.getByRole('button', { name: 'Local Multiplayer' }).click();
    assert.equal(await page.inputValue('#setup-seed'), '31337', 'seed pre-filled');
    assert.equal(await page.isChecked('[name="mode"][value="chaos"]'), true, 'mode pre-selected');
    assert.equal(await page.isChecked('[name="gameType"][value="custom"]'), true);
    assert.deepEqual(await page.locator('.seat-card:not(.is-out)').evaluateAll((els) => els.map((e) => e.dataset.seat)), ['1', '3', '4']);
    assert.match(await page.textContent('#setup-challenge'), /Challenge city 31337 · Urban Chaos rules · 3 players/);
    assert.match(await page.textContent('#setup-summary'), /Custom Game · 3 players · .* · Urban Chaos rules · seed 31337/);

    // New Seed / Random / invalid input.
    await page.click('#setup-seed-new');
    const rolled = await page.inputValue('#setup-seed');
    assert.match(rolled, /^\d+$/);
    assert.notEqual(rolled, '31337');
    await page.fill('#setup-seed', 'abc');
    assert.equal(await page.isDisabled('#setup-start'), true, 'an invalid seed blocks Start');
    assert.match(await page.textContent('#setup-summary'), /whole number/);
    await page.click('#setup-seed-clear');
    assert.equal(await page.inputValue('#setup-seed'), '');
    assert.equal(await page.isDisabled('#setup-start'), false, 'blank = random city');
    await page.fill('#setup-seed', '31337');
    await noHorizontalScroll(page, 'setup with seed');
    await page.click('#setup-start');
    assert.equal(await page.evaluate(() => window.__GRIDLOCK__.getGame().seed), 31337);

    const firstRun = await playMoves();
    assert.ok(JSON.parse(firstRun).length >= 3, 'Urban Chaos rolled events to compare');
    await page.click('#game-menu-btn');
    assert.equal(await page.textContent('#pause-seed'), '31337', 'seed visible when paused');
    assert.ok(!(await page.textContent('#pause-dialog')).includes('debug'));
    await page.click('#pause-dialog [data-dialog-action="resume"]');

    await road(await finishCity()).click();
    await page.locator('#results-dialog').waitFor({ state: 'visible' });
    assert.equal(await page.textContent('#results-seed'), '31337', 'seed visible on results');

    // Copy Challenge Link: clipboard works → toast; clipboard refused → selectable text.
    await page.evaluate(() => {
      window.__copied = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.__copied.push(t); } } });
    });
    await page.click('[data-results-action="copy-link"]');
    await page.waitForFunction(() => window.__copied.length === 1);
    const link = new URL(await page.evaluate(() => window.__copied[0]));
    assert.equal(link.search, '?seed=31337&mode=chaos&seats=134', 'link carries seed, mode and seats');
    assert.equal(link.origin + link.pathname, base);
    assert.equal(await page.isVisible('#results-dialog'), true, 'copying keeps the results open');
    assert.equal(await page.isVisible('#share-fallback'), false);
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) } });
    });
    await page.click('[data-results-action="copy-link"]');
    await page.locator('#share-fallback').waitFor({ state: 'visible' });
    assert.equal(await page.inputValue('#share-link'), link.href);
    assert.equal(await page.evaluate(() => {
      const el = document.getElementById('share-link');
      return document.activeElement === el && el.selectionStart === 0 && el.selectionEnd === el.value.length;
    }), true, 'fallback link is focused and selected');
    await noHorizontalScroll(page, 'results with share fallback');
    await page.screenshot({ path: 'test-results/replay-results.png' });

    // Replay Same City: same seed, rules and table; the same moves roll the same events.
    await page.click('[data-results-action="replay"]');
    assert.deepEqual(await page.evaluate(() => {
      const g = window.__GRIDLOCK__.getGame();
      return [g.seed, g.mode, g.players.map((p) => p.seat).join(''), g.events.history.length];
    }), [31337, 'chaos', '134', 0]);
    assert.equal(await playMoves(), firstRun, 'identical event sequence on replay');

    // Play Again deals a new city with the same table.
    await road(await finishCity()).click();
    await page.locator('#results-dialog').waitFor({ state: 'visible' });
    await page.click('[data-results-action="rematch"]');
    assert.notEqual(await page.evaluate(() => window.__GRIDLOCK__.getGame().seed), 31337, 'Play Again = a fresh seed');
    assert.equal(await page.evaluate(() => window.__GRIDLOCK__.getGame().mode), 'chaos');

    // A friend opening the link (no ?debug) deals the same city too.
    await page.goto(link.href, { waitUntil: 'networkidle' });
    assert.equal(new URL(page.url()).search, '');
    await page.getByRole('button', { name: 'Local Multiplayer' }).click();
    assert.equal(await page.inputValue('#setup-seed'), '31337');
    await page.click('#setup-start');
    assert.equal(await page.evaluate(() => typeof window.__GRIDLOCK__), 'undefined', 'no debug hook on a challenge link');
    assert.deepEqual(errors, []);
    console.log('✔ replayable cities: challenge link → setup, seed in pause/results, copy + fallback, same events on replay');
  } catch (err) {
    failures++;
    console.error(`✘ replayable cities: ${err.message}`);
    await page.screenshot({ path: 'test-results/replay-FAIL.png' }).catch(() => {});
  } finally {
    await context.close();
  }
}

// Accessibility audit (no extra dependencies): on every screen and dialog, each visible control
// has an accessible name, every id reference resolves, ids are unique, and open dialogs are
// labelled. Reduced motion (OS preference or the in-app setting) leaves nothing animating.
{
  const audit = (page, label) => page.evaluate((where) => {
    const problems = [];
    const visible = (el) => el.checkVisibility ? el.checkVisibility() : el.offsetParent !== null;
    const text = (id) => document.getElementById(id)?.textContent.trim() ?? '';
    const name = (el) => {
      if (el.getAttribute('aria-labelledby')) return el.getAttribute('aria-labelledby').split(/\s+/).map(text).join(' ').trim();
      if (el.getAttribute('aria-label')?.trim()) return el.getAttribute('aria-label').trim();
      if (el.labels?.length) return [...el.labels].map((l) => l.textContent.trim()).join(' ').trim();
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) && el.type !== 'button' && el.type !== 'submit') return el.title?.trim() ?? '';
      return (el.textContent.trim() || el.title?.trim() || el.querySelector('img[alt]')?.alt || el.value || '').trim();
    };
    const controls = document.querySelectorAll('button, a[href], [role="button"], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])');
    for (const el of controls) {
      if (!visible(el)) continue;
      if (!name(el)) problems.push(`${where}: unnamed ${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.className ? `.${String(el.className).split(' ')[0]}` : ''}`);
    }
    const ids = new Map();
    for (const el of document.querySelectorAll('[id]')) ids.set(el.id, (ids.get(el.id) ?? 0) + 1);
    for (const [id, n] of ids) if (n > 1) problems.push(`${where}: duplicate id #${id}`);
    for (const attr of ['aria-labelledby', 'aria-describedby', 'aria-controls', 'for']) {
      for (const el of document.querySelectorAll(`[${attr}]`)) {
        // Closed dialogs fill in their titles when opened; only what's rendered is exposed.
        if (!(el.matches('dialog[open]') || (el.tagName !== 'DIALOG' && visible(el)))) continue;
        for (const ref of el.getAttribute(attr).split(/\s+/).filter(Boolean)) {
          if (!document.getElementById(ref)) problems.push(`${where}: ${attr}="${ref}" points nowhere`);
        }
      }
    }
    for (const dialog of document.querySelectorAll('dialog[open]')) {
      const labelled = dialog.getAttribute('aria-label') || (dialog.getAttribute('aria-labelledby') && name(dialog));
      if (!labelled) problems.push(`${where}: open dialog #${dialog.id} has no label`);
    }
    return problems;
  }, label);
  const stillMoving = (page) => page.evaluate(() => document.getAnimations()
    .filter((a) => a.playState === 'running' && !(a.effect?.getTiming().duration === 0)).map((a) => a.animationName ?? a.transitionProperty ?? 'animation'));

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  await context.addInitScript(() => {
    if (!sessionStorage.getItem('gl-test-init')) {
      sessionStorage.setItem('gl-test-init', '1');
      (localStorage.setItem('gridlock.tutorial.v1', '{"status":"done"}'), localStorage.setItem('gridlock.settings.v1', JSON.stringify({ confirmTaps: false, quickHandoff: true })));
    }
  });
  const page = await context.newPage();
  const errors = watchForBrowserErrors(page);
  const problems = [];
  const check = async (label) => {
    problems.push(...await audit(page, label));
    const moving = await stillMoving(page);
    if (moving.length) problems.push(`${label}: animating under reduced motion (${moving.join(', ')})`);
  };
  try {
    await page.goto(`${base}?debug`, { waitUntil: 'networkidle' });
    await check('title');
    for (const [nav, label] of [['howto', 'how to play'], ['settings', 'settings'], ['stats', 'statistics']]) {
      await page.click(`[data-screen="title"] [data-nav="${nav}"]`);
      await check(label);
      await page.click(`[data-screen="${nav}"] [data-nav="back"]`);
    }
    await page.getByRole('button', { name: 'Local Multiplayer' }).click();
    await check('setup');
    await page.click('#setup-start');
    await check('game');
    await page.click('#game-menu-btn');
    await check('pause');
    await page.click('#pause-dialog [data-dialog-action="resume"]');
    await page.click('#board [data-road="h-0-0"]');
    await page.click('#board [data-road="v-0-0"]');
    await page.click('#board [data-road="h-1-0"]');
    await page.click('#board [data-road="v-0-1"]'); // P4 closes A1
    await page.locator('#capture-choice-dialog').waitFor({ state: 'visible' });
    await check('capture choice');
    await page.click('[data-capture-choice="develop"]');
    await check('build panel');
    await page.locator('#build-dialog [data-build="residential"]').click();
    const last = await page.evaluate(async () => {
      const { allRoadIds } = await import('./js/core/board.js');
      const g = window.__GRIDLOCK__.getGame();
      g.eventPool = [];
      const ids = allRoadIds(g.board).filter((id) => g.board.roads[id] == null);
      ids.slice(0, -1).forEach((id) => { g.board.roads[id] = 1; });
      g.city.rounds = 0; // staged finish goes straight to results (the City era has its own scenario)
      for (const b of g.board.blocks) if (b.ownerSeat == null) { b.abandoned = true; b.abandonedBy = 1; }
      return ids.at(-1);
    });
    await page.click(`#board [data-road="${last}"]`);
    await page.locator('#results-dialog').waitFor({ state: 'visible' });
    await check('results');
    assert.deepEqual(problems, [], 'accessibility problems');

    // The in-app Reduced Motion setting works without the OS preference.
    const full = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await full.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
    const p2 = await full.newPage();
    await p2.goto(base, { waitUntil: 'networkidle' });
    await p2.click('[data-screen="title"] [data-nav="settings"]');
    await p2.locator('label:has([name="reducedMotion"])').click();
    assert.equal(await p2.evaluate(() => document.documentElement.dataset.motion), 'reduced');
    await p2.click('[data-screen="settings"] [data-nav="back"]');
    assert.deepEqual(await stillMoving(p2), [], 'nothing animates with the Reduced Motion setting on');
    await p2.reload({ waitUntil: 'networkidle' });
    assert.equal(await p2.evaluate(() => document.documentElement.dataset.motion), 'reduced', 'setting persists');
    await full.close();
    assert.deepEqual(errors, []);
    console.log('✔ accessibility: named controls, valid references, labelled dialogs on every screen; reduced motion (OS + setting)');
  } catch (err) {
    failures++;
    console.error(`✘ accessibility: ${err.message}`);
    await page.screenshot({ path: 'test-results/a11y-FAIL.png' }).catch(() => {});
  } finally {
    await context.close();
  }
}

// Seat controllers: Solo / Local Friends / Mixed presets, CPU difficulty, validation, and the
// table surviving autosave + Continue, results, Play Again and Replay Same City.
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  await context.addInitScript(() => {
    if (!sessionStorage.getItem('gl-test-init')) {
      sessionStorage.setItem('gl-test-init', '1');
      (localStorage.setItem('gridlock.tutorial.v1', '{"status":"done"}'), localStorage.setItem('gridlock.settings.v1', JSON.stringify({ confirmTaps: false, quickHandoff: true })));
    }
  });
  const page = await context.newPage();
  const errors = watchForBrowserErrors(page);
  const table = () => page.evaluate(() => window.__GRIDLOCK__.getGame().players.map((p) => [p.seat, p.name, p.controller, p.difficulty]));
  const card = (seat) => page.locator(`.seat-card[data-seat="${seat}"]`);
  const controller = (seat, value) => card(seat).locator(`[name="controller-${seat}"][value="${value}"]`);
  const finishCity = async () => {
    const last = await page.evaluate(async () => {
      const { allRoadIds } = await import('./js/core/board.js');
      const g = window.__GRIDLOCK__.getGame();
      g.eventPool = [];
      const ids = allRoadIds(g.board).filter((id) => g.board.roads[id] == null);
      ids.slice(0, -1).forEach((id) => { g.board.roads[id] = 1; });
      g.city.rounds = 0; // staged finish goes straight to results (the City era has its own scenario)
      for (const b of g.board.blocks) if (b.ownerSeat == null) { b.abandoned = true; b.abandonedBy = 1; }
      return ids.at(-1);
    });
    await page.click(`#board [data-road="${last}"]`);
    await page.locator('#results-dialog').waitFor({ state: 'visible' });
  };
  const SOLO = [[1, 'Player 1', 'human', null], [2, 'Mayor Bot 1', 'cpu', 'normal'], [3, 'Mayor Bot 2', 'cpu', 'hard'], [4, 'Mayor Bot 3', 'cpu', 'normal']];
  try {
    await page.goto(`${base}?debug`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Local Multiplayer' }).click();
    // Local Friends by default: every seat human and locked, exactly the old setup.
    assert.equal(await page.isChecked('[name="seatPreset"][value="friends"]'), true);
    assert.deepEqual(await page.locator('.table-option__name').allTextContents(), ['Solo', 'Local Friends', 'Mixed']);
    for (const seat of [1, 2, 3, 4]) {
      assert.equal(await controller(seat, 'human').isChecked(), true);
      assert.equal(await controller(seat, 'cpu').isDisabled(), true);
      assert.equal(await card(seat).locator('.seat-card__difficulty').isVisible(), false);
    }
    assert.match(await page.textContent('#setup-summary'), /^Standard Game · 4 players · \$12,000 each/);

    // Solo: seat 1 human, seats 2–4 CPU with difficulty pickers and bot names.
    await page.locator('.table-option', { hasText: 'Solo' }).click();
    assert.deepEqual(await Promise.all([1, 2, 3, 4].map((seat) => controller(seat, 'cpu').isChecked())), [false, true, true, true]);
    assert.deepEqual(await Promise.all([1, 2, 3, 4].map((seat) => card(seat).locator('[name="name"]').getAttribute('placeholder'))),
      ['Player 1', 'Mayor Bot 1', 'Mayor Bot 2', 'Mayor Bot 3']);
    assert.equal(await card(1).locator('.seat-card__difficulty').isVisible(), false);
    assert.equal(await card(2).locator('.seat-card__personality').isVisible(), false, 'Solo bots get an automatic personality');
    await card(3).locator('[name="difficulty"]').selectOption('hard');
    assert.match(await page.textContent('#setup-summary'), /Standard Game · 4 players \(1 human, 3 CPU\)/);

    // Mixed: per-seat choice; an all-CPU table can't start.
    await page.locator('.table-option', { hasText: 'Mixed' }).click();
    assert.equal(await controller(1, 'cpu').isDisabled(), false);
    await controller(1, 'cpu').check();
    assert.equal(await page.isDisabled('#setup-start'), true, 'no human seat');
    assert.match(await page.textContent('#setup-summary'), /At least one seat must be Human/);
    await controller(1, 'human').check();
    // Custom with a CPU seat left out: 3 seats, still valid.
    await page.check('[name="gameType"][value="custom"]');
    await page.locator('label[for="seat-4-join"]').click();
    assert.match(await page.textContent('#setup-summary'), /Custom Game · 3 players \(1 human, 2 CPU\)/);
    await page.locator('label[for="seat-4-join"]').click();
    await page.check('[name="gameType"][value="standard"]');
    await noHorizontalScroll(page, 'setup with CPU seats');
    await page.screenshot({ path: 'test-results/seats-setup.png' });

    await page.click('#setup-start');
    assert.deepEqual(await table(), SOLO, 'controllers and bot names reach the game');
    assert.equal(await page.locator('.player-card__cpu').count(), 3, 'CPU tag on the three bot seats');
    assert.equal(await page.locator('.player-card[data-seat="1"] .player-card__cpu').count(), 0);
    assert.match(await page.locator('.player-card[data-seat="3"]').getAttribute('aria-label'), /Mayor Bot 2 \(CPU · Hard · (Builder|Tycoon|Planner|Expansionist)\)/);

    // Autosave + Continue.
    await page.click('#board [data-road="h-0-0"]');
    await page.reload({ waitUntil: 'networkidle' });
    await page.click('#continue-game');
    assert.deepEqual(await table(), SOLO, 'Continue keeps the table');

    // Results show who was a bot.
    await finishCity();
    assert.equal(await page.locator('#results-dialog .result-card__cpu').count(), 3);
    assert.match(await page.locator('.result-card[data-seat="3"] .result-card__cpu').textContent(), /^CPU · Hard · (Builder|Tycoon|Planner|Expansionist)$/);
    await page.screenshot({ path: 'test-results/seats-results.png' });

    await page.click('[data-results-action="rematch"]');
    assert.deepEqual(await table(), SOLO, 'Play Again keeps the table');
    await finishCity();
    const seed = await page.evaluate(() => window.__GRIDLOCK__.getGame().seed);
    await page.click('[data-results-action="replay"]');
    assert.deepEqual(await table(), SOLO, 'Replay Same City keeps the table');
    assert.equal(await page.evaluate(() => window.__GRIDLOCK__.getGame().seed), seed);
    assert.deepEqual(errors, []);
    console.log('✔ seat controllers: Solo/Local Friends/Mixed, difficulty, validation; kept by Continue, results, Play Again, Replay');
  } catch (err) {
    failures++;
    console.error(`✘ seat controllers: ${err.message}`);
    await page.screenshot({ path: 'test-results/seats-FAIL.png' }).catch(() => {});
  } finally {
    await context.close();
  }
}

// CPU seats in the real turn loop: Solo (1 human + 3 CPU) and a Mixed table.
{
  const newContext = (settings) => browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' }).then(async (context) => {
    await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
    await context.addInitScript((initial) => {
      if (!sessionStorage.getItem('gl-test-init')) {
        sessionStorage.setItem('gl-test-init', '1');
        localStorage.setItem('gridlock.tutorial.v1', '{"status":"done"}');
        localStorage.setItem('gridlock.settings.v1', JSON.stringify(initial));
      }
      // Record every dialog that opens, to prove which screens were (not) shown.
      window.__opened = [];
      const showModal = HTMLDialogElement.prototype.showModal;
      HTMLDialogElement.prototype.showModal = function () { window.__opened.push(this.id); return showModal.call(this); };
    }, { confirmTaps: false, quickHandoff: false, ...settings });
    return context;
  });
  const state = (page) => page.evaluate(() => {
    const g = window.__GRIDLOCK__.getGame();
    const me = g.players[g.turnIndex];
    return { seat: me.seat, cpu: me.controller === 'cpu', phase: g.turnPhase, ended: g.phase === 'ended',
      roads: Object.keys(g.board.roads).length, log: g.log.length, cash: me.cash };
  });
  /** A person's move: clear any dialog in the way, then pave the road a Normal CPU would pick. */
  async function humanStep(page) {
    for (const [sel, click] of [['#event-dialog', '#event-continue'], ['#handoff-dialog', '#handoff-ready'],
      ['#capture-choice-dialog', '[data-capture-choice="vacant"]']]) {
      if (await page.locator(`${sel}[open]`).count()) return page.click(click);
    }
    if (await page.locator('#finance-dialog[open]').count()) {
      const out = page.locator('#finance-dialog').locator('[data-downgrade], [data-sell], #declare-bankruptcy, [data-action="close"]').first();
      return out.click();
    }
    const road = await page.evaluate(async () => {
      const { chooseRoad } = await import('./js/core/cpu/roads.js');
      const g = window.__GRIDLOCK__.getGame();
      return g.phase === 'playing' && g.players[g.turnIndex].controller !== 'cpu' ? chooseRoad(g, { difficulty: 'normal' }).road : null;
    });
    if (road) await page.click(`#board [data-road="${road}"]`);
    else if (await page.isVisible('#action-end-turn')) await page.click('#action-end-turn'); // CITY era
  }
  /** Plays until `done`: people move via humanStep; CPU turns run themselves (Skip speeds them up). */
  async function playUntil(page, done, { skip = true, limit = 600 } = {}) {
    for (let i = 0; i < limit; i++) {
      const s = await state(page);
      if (await done(s)) return s;
      if (s.cpu && !s.ended && !(await page.locator('dialog[open]').count())) {
        if (skip && await page.isVisible('#cpu-skip')) await page.click('#cpu-skip').catch(() => {});
        await page.waitForTimeout(40);
      } else await humanStep(page);
    }
    throw new Error('playUntil: gave up');
  }

  // --- Solo ---------------------------------------------------------------
  const context = await newContext({ cpuSpeed: 'relaxed' });
  const page = await context.newPage();
  const errors = watchForBrowserErrors(page);
  try {
    await page.goto(`${base}?debug`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Local Multiplayer' }).click();
    await page.locator('.table-option', { hasText: 'Solo' }).click();
    await page.fill('#setup-seed', '4242'); // a fixed city, so every run sees the same events
    await page.click('#setup-start');
    assert.deepEqual(await state(page).then((s) => [s.seat, s.cpu]), [1, false], 'the human starts');
    assert.equal(await page.isVisible('#cpu-status'), false);

    await page.click('#board [data-road="h-0-0"]');
    // A CPU turn: thinking feedback, no human controls, board clicks refused.
    assert.equal(await page.isVisible('#cpu-status'), true);
    assert.equal(await page.textContent('#cpu-status-name'), 'Mayor Bot 1');
    assert.match(await page.textContent('#cpu-status'), /Mayor Bot 1 is thinking/);
    assert.equal(await page.isVisible('#action-pave'), false);
    await page.click('#board [data-road="h-6-5"]');
    assert.notEqual(await page.evaluate(() => window.__GRIDLOCK__.getGame().board.roads['h-6-5']), 1, 'a person can\'t move for a bot');
    assert.match(await page.textContent('#toasts'), /Mayor Bot 1 is playing/);

    // Pause stops pending CPU actions; resuming continues them.
    await page.click('#game-menu-btn');
    const paused = await state(page);
    await page.waitForTimeout(1600);
    assert.deepEqual(await state(page), paused, 'nothing happens while paused');
    await page.click('#pause-dialog [data-dialog-action="resume"]');

    // Faster: the speed control switches the setting and is pressed.
    await page.click('#cpu-faster');
    assert.equal(await page.getAttribute('#cpu-faster', 'aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('gridlock.settings.v1')).cpuSpeed), 'fast');

    // The three bots play themselves and hand back to the human, with no handoff screen.
    // (A city event card waits for a person to read it; the bots wait too.)
    await playUntil(page, (s) => !s.cpu, { skip: false });
    assert.equal(await page.isVisible('#cpu-status'), false);
    const cpuRoads = await page.evaluate(() => window.__GRIDLOCK__.getGame().log.filter((e) => e.type === 'road' && e.seat !== 1).length);
    assert.ok(cpuRoads >= 3, 'each bot paved');

    // Reload in the middle of a CPU turn: Continue resumes from the autosave, no step repeated.
    await playUntil(page, (s) => s.cpu, { skip: false });
    await page.waitForTimeout(300);
    await page.reload({ waitUntil: 'networkidle' });
    // The save as the reload left it (a bot may have finished one more step on the way out).
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('gridlock.active-game')).game);
    // Continue and read the game in one synchronous tick, before the first bot step can fire.
    const resumed = await page.evaluate(() => {
      document.querySelector('#continue-game').click();
      const g = window.__GRIDLOCK__.getGame();
      return { roads: Object.keys(g.board.roads).length, log: g.log.length };
    });
    assert.equal(resumed.roads, Object.keys(saved.board.roads).length, 'resumes exactly where the save left off');
    assert.equal(resumed.log, saved.log.length);
    await playUntil(page, (s) => !s.cpu, { skip: false });
    const roadsLog = await page.evaluate(() => window.__GRIDLOCK__.getGame().log.filter((e) => e.type === 'road').map((e) => e.road));
    assert.equal(new Set(roadsLog).size, roadsLog.length, 'no road played twice');
    assert.equal(roadsLog.length, await page.evaluate(() => Object.keys(window.__GRIDLOCK__.getGame().board.roads).length));

    // Play the whole city out (Skip on CPU turns).
    const end = await playUntil(page, (s) => s.ended);
    assert.equal(end.ended, true);
    await page.locator('#results-dialog').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#results-dialog .result-card__cpu').count(), 3);
    const opened = await page.evaluate(() => window.__opened);
    assert.ok(!opened.includes('handoff-dialog'), 'Solo never shows the handoff screen');
    // Ended games stop every CPU timer: nothing moves afterwards.
    const final = await state(page);
    await page.waitForTimeout(1200);
    assert.deepEqual(await state(page), final);
    assert.equal(await page.isVisible('#cpu-status'), false);
    assert.deepEqual(errors, []);
    console.log('✔ CPU Solo: bots play themselves, thinking feedback, no handoff, pause, faster/skip, reload resume, game end');
  } catch (err) {
    failures++;
    console.error(`✘ CPU Solo: ${err.message}`);
    await page.screenshot({ path: 'test-results/cpu-solo-FAIL.png' }).catch(() => {});
  } finally {
    await context.close();
  }

  // --- Mixed: Human, CPU, Human, CPU ------------------------------------------
  const mixedContext = await newContext({ cpuSpeed: 'fast' });
  const mixed = await mixedContext.newPage();
  const mixedErrors = watchForBrowserErrors(mixed);
  try {
    await mixed.goto(`${base}?debug`, { waitUntil: 'networkidle' });
    await mixed.getByRole('button', { name: 'Local Multiplayer' }).click();
    await mixed.locator('.table-option', { hasText: 'Mixed' }).click();
    for (const [seat, controller] of [[2, 'cpu'], [4, 'cpu']]) {
      await mixed.locator(`.seat-card[data-seat="${seat}"] [name="controller-${seat}"][value="${controller}"]`).check();
    }
    await mixed.locator('.seat-card[data-seat="4"] [name="difficulty"]').selectOption('hard');
    assert.equal(await mixed.locator('.seat-card[data-seat="4"] .seat-card__personality').isVisible(), true, 'Mixed offers a personality');
    await mixed.locator('.seat-card[data-seat="4"] [name="personality"]').selectOption('tycoon');
    await mixed.fill('#setup-seed', '777');
    await mixed.click('#setup-start');
    // Difficulty and personality on the HUD (seat 2 was left on Auto).
    assert.equal(await mixed.textContent('.player-card[data-seat="4"] .player-card__bot'), 'Hard · Tycoon');
    assert.match(await mixed.textContent('.player-card[data-seat="2"] .player-card__bot'), /^Normal · (Builder|Planner|Expansionist)$/);
    assert.equal(await mixed.locator('.player-card[data-seat="1"] .player-card__bot').count(), 0);
    const handoffs = () => mixed.evaluate(() => window.__opened.filter((id) => id === 'handoff-dialog').length);

    // Human 1 → CPU 2 → handoff to Human 3 (none before or after the bot).
    await mixed.click('#board [data-road="h-0-0"]');
    assert.equal(await handoffs(), 0, 'no handoff before a CPU seat');
    await mixed.locator('#handoff-dialog').waitFor({ state: 'visible', timeout: 15_000 });
    assert.equal(await mixed.textContent('#handoff-title'), 'Pass to Player 3');
    assert.equal(await handoffs(), 1);
    await mixed.click('#handoff-ready');

    // Stage a debt for the Hard bot (seat 4): its turn must sell its way out through the real APIs.
    await mixed.evaluate(async () => {
      const { applyDevelopment } = await import('./js/core/development.js');
      const { refreshBonuses } = await import('./js/core/bonuses.js');
      const g = window.__GRIDLOCK__.getGame();
      const b = g.board.blocks.find((x) => x.id === 'r3c3');
      b.ownerSeat = 4;
      applyDevelopment(b, 'residential', 1);
      refreshBonuses(g.board);
      g.players.find((p) => p.seat === 4).cash = -200;
    });
    await humanStep(mixed); // Human 3 paves → CPU 4 starts in debt
    await mixed.locator('#handoff-dialog').waitFor({ state: 'visible', timeout: 15_000 });
    assert.equal(await mixed.textContent('#handoff-title'), 'Pass to Player 1');
    const cpu4 = await mixed.evaluate(() => {
      const g = window.__GRIDLOCK__.getGame();
      return { cash: g.players.find((p) => p.seat === 4).cash, sold: g.log.some((e) => (e.type === 'downgrade' || e.type === 'sale') && e.seat === 4),
        paved: g.log.some((e) => e.type === 'road' && e.seat === 4) };
    });
    assert.ok(cpu4.sold, 'the bot sold to clear its debt');
    assert.ok(cpu4.cash >= 0 && cpu4.paved, 'then played on');
    assert.equal(await mixed.locator('#finance-dialog[open]').count(), 0, 'no debt panel for a bot');
    await mixed.click('#handoff-ready');

    // Redevelopment bidding: Human 1 opens an auction; the bots bid sealed.
    await mixed.evaluate(async () => {
      const { applyDevelopment } = await import('./js/core/development.js');
      const { refreshBonuses } = await import('./js/core/bonuses.js');
      const g = window.__GRIDLOCK__.getGame();
      const b = g.board.blocks.find((x) => x.id === 'r5c5');
      applyDevelopment(b, 'industrial', 1);
      Object.assign(b, { ownerSeat: null, abandoned: true, abandonedBy: 2 });
      refreshBonuses(g.board);
      g.players.find((p) => p.seat === 4).cash = 9000; // well funded again after its debt
    });
    if (await mixed.locator('#event-dialog[open]').count()) await mixed.click('#event-continue');
    await mixed.click('#board [data-block="r5c5"]');
    const auction = mixed.locator('#build-dialog [data-auction-mode="restore"]');
    await auction.waitFor();
    assert.deepEqual(await auction.locator('[data-cpu-bidder]').evaluateAll((els) => els.map((e) => e.dataset.cpuBidder)), ['4'],
      'Hard bot bids sealed (the Easy bot abandoned it, so it can\'t)');
    assert.match(await auction.locator('[data-cpu-bidder]').textContent(), /Sealed bid/);
    await auction.locator('[name="bid-1"]').fill('');
    await auction.locator('[name="bid-3"]').fill('');
    await auction.locator('[data-auction="restore"]').click();
    assert.equal(await mixed.evaluate(() => window.__GRIDLOCK__.getGame().board.blocks.find((x) => x.id === 'r5c5').ownerSeat), 4, 'the bot won the lot');
    // The inspector names the bot's difficulty and personality.
    await mixed.click('#board [data-block="r5c5"]');
    assert.match(await mixed.textContent('#inspector'), /Mayor Bot 2 \(CPU · Hard · Tycoon\)/);
    assert.match(await mixed.textContent('#toasts'), /Mayor Bot 2 wins redevelopment/);

    // (The Solo run plays a whole city to the results; this one stops here to keep CI quick.)
    assert.deepEqual(mixedErrors, []);
    console.log('✔ CPU Mixed: handoff only between different people, bot debt + sealed redevelopment bids');
  } catch (err) {
    failures++;
    console.error(`✘ CPU Mixed: ${err.message}`);
    await mixed.screenshot({ path: 'test-results/cpu-mixed-FAIL.png' }).catch(() => {});
  } finally {
    await mixedContext.close();
  }

  // --- A CPU mayor opens bidding on an abandoned block; people may bid, or pass by leaving ---
  const auctionContext = await newContext({ cpuSpeed: 'fast' });
  const bidPage = await auctionContext.newPage();
  const bidErrors = watchForBrowserErrors(bidPage);
  try {
    await bidPage.goto(`${base}?debug`, { waitUntil: 'networkidle' });
    await bidPage.getByRole('button', { name: 'Local Multiplayer' }).click();
    await bidPage.check('[name="gameType"][value="custom"]');
    await bidPage.locator('label[for="seat-4-join"]').click();
    await bidPage.locator('.table-option', { hasText: 'Mixed' }).click();
    await bidPage.locator('.seat-card[data-seat="2"] [name="controller-2"][value="cpu"]').check();
    await bidPage.locator('.seat-card[data-seat="2"] [name="difficulty"]').selectOption('hard');
    await bidPage.fill('#setup-seed', '99');
    await bidPage.click('#setup-start');
    // An abandoned downtown Commercial that Player 3 walked away from (so Player 1 may bid, 3 may not).
    await bidPage.evaluate(async () => {
      const { applyDevelopment } = await import('./js/core/development.js');
      const { refreshBonuses } = await import('./js/core/bonuses.js');
      const g = window.__GRIDLOCK__.getGame();
      const b = g.board.blocks.find((x) => x.id === 'r2c2');
      applyDevelopment(b, 'commercial', 1);
      Object.assign(b, { ownerSeat: null, abandoned: true, abandonedBy: 3 });
      refreshBonuses(g.board);
    });
    await bidPage.click('#board [data-road="h-0-0"]'); // Player 1 paves → the Hard bot's turn
    await bidPage.locator('#build-dialog [data-auction-mode="restore"]').waitFor({ timeout: 15_000 });
    assert.match(await bidPage.textContent('#toasts'), /Mayor Bot 1 opens bidding on abandoned Block C3/);
    assert.equal(await bidPage.locator('#build-dialog [data-cpu-bidder="2"]').count() > 0, true, 'the bot\'s own bid is sealed');
    assert.deepEqual(await state(bidPage).then((x) => x.roads), 1, 'the bot waits while people can bid');
    await bidPage.click('#build-dialog [data-action="close"]'); // Player 1 passes
    await bidPage.locator('#handoff-dialog').waitFor({ state: 'visible', timeout: 15_000 });
    const lot = await bidPage.evaluate(() => window.__GRIDLOCK__.getGame().board.blocks.find((x) => x.id === 'r2c2'));
    assert.deepEqual([lot.ownerSeat, lot.abandoned], [2, false], 'the bot won its own auction');
    assert.equal(await bidPage.textContent('#handoff-title'), 'Pass to Player 3', 'then finished its turn');
    assert.deepEqual(bidErrors, []);
    console.log('✔ CPU opens redevelopment bidding: people can bid, leaving passes, the bot plays on');
  } catch (err) {
    failures++;
    console.error(`✘ CPU opens bidding: ${err.message}`);
    await bidPage.screenshot({ path: 'test-results/cpu-auction-FAIL.png' }).catch(() => {});
  } finally {
    await auctionContext.close();
  }
}

// Onboarding around the play options: the title offers Play Solo / Local Multiplayer /
// Custom / Mixed Game; Solo's defaults; a first Solo game's tutorial includes the CPU tip; and
// during a bot's turn its card glows, the strip says what it intends (with the road or block
// highlighted), the board is locked, and Pause / Speed up work. Desktop and phone.
for (const vp of [{ name: 'desktop', width: 1280, height: 720 }, { name: 'phone', width: 390, height: 844, isMobile: true, hasTouch: true }]) {
  const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.isMobile, hasTouch: vp.hasTouch, reducedMotion: 'reduce' });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  await context.addInitScript(() => {
    if (!sessionStorage.getItem('gl-test-init')) {
      sessionStorage.setItem('gl-test-init', '1');
      localStorage.setItem('gridlock.settings.v1', JSON.stringify({ confirmTaps: false, quickHandoff: true, cpuSpeed: 'relaxed' }));
    }
  });
  const page = await context.newPage();
  const errors = watchForBrowserErrors(page);
  const game = () => page.evaluate(() => {
    const g = window.__GRIDLOCK__.getGame();
    return { seat: g.players[g.turnIndex].seat, log: g.log.length, roads: Object.keys(g.board.roads).length,
      players: g.players.map((p) => [p.seat, p.controller, p.difficulty]), type: g.gameType };
  });
  const heading = () => page.textContent('#setup-heading');
  const checked = (name) => page.evaluate((n) => document.querySelector(`#setup-form [name="${n}"]:checked`)?.value, name);
  const controllers = () => page.evaluate(() => [...document.querySelectorAll('.seat-card')]
    .filter((c) => !c.classList.contains('is-empty') && c.querySelector('[name^="controller-"]:checked'))
    .map((c) => c.querySelector('[name^="controller-"]:checked').value));
  try {
    await page.goto(`${base}?debug`, { waitUntil: 'networkidle' });
    // Title: three ways to play, then How To Play · Statistics · Settings.
    const options = page.locator('.play-options .play-option');
    assert.equal(await options.count(), 3);
    for (const name of ['Play Solo', 'Local Multiplayer', 'Custom / Mixed Game']) {
      const button = page.getByRole('button', { name: new RegExp(`^${name.replace('/', '\\/')}`) });
      assert.equal(await button.isVisible(), true, `${name} offered`);
      const box = await button.boundingBox();
      assert.ok(box.y + box.height <= vp.height, `${name} is above the fold`);
    }
    assert.deepEqual((await page.locator('.menu-row .menu-row__btn').allTextContents()).map((t) => t.trim()), ['How To Play', 'Statistics', 'Settings']);
    await noHorizontalScroll(page, `${vp.name} title`);

    // Local Multiplayer: everyone human.
    await page.getByRole('button', { name: /^Local Multiplayer/ }).click();
    assert.equal(await heading(), 'Local Multiplayer');
    assert.equal(await checked('seatPreset'), 'friends');
    assert.deepEqual(await controllers(), ['human', 'human', 'human', 'human']);
    await page.click('[data-screen="setup"] [data-nav="back"]');
    // Custom / Mixed Game: a Custom Game with the Mixed table.
    await page.getByRole('button', { name: /^Custom \/ Mixed Game/ }).click();
    assert.equal(await heading(), 'Custom Game');
    assert.equal(await checked('seatPreset'), 'mixed');
    assert.equal(await checked('gameType'), 'custom');
    await page.click('[data-screen="setup"] [data-nav="back"]');
    // Play Solo: Player 1 human, Players 2–4 CPU Normal, Standard Game.
    await page.getByRole('button', { name: /^Play Solo/ }).click();
    assert.equal(await heading(), 'Play Solo');
    assert.equal(await checked('seatPreset'), 'solo');
    assert.equal(await checked('gameType'), 'standard');
    assert.deepEqual(await controllers(), ['human', 'cpu', 'cpu', 'cpu']);
    assert.deepEqual(await page.locator('.seat-card [name="difficulty"]:visible').evaluateAll((s) => s.map((x) => x.value)), ['normal', 'normal', 'normal']);
    assert.match(await page.textContent('#setup-summary'), /^Standard Game · 4 players \(1 human, 3 CPU\)/);
    await noHorizontalScroll(page, `${vp.name} Play Solo setup`);
    await page.fill('#setup-seed', '4242');
    await page.click('#setup-start');
    assert.deepEqual((await game()).players, [[1, 'human', null], [2, 'cpu', 'normal'], [3, 'cpu', 'normal'], [4, 'cpu', 'normal']]);

    // First game: the tutorial counts nine tips when bots are at the table.
    const tip = (id) => page.locator(`.coach-mark[data-step="${id}"]`);
    await tip('manage').waitFor();
    assert.match(await tip('manage').textContent(), /Tip 1 of 9/);
    assert.equal(await page.locator('.player-card.is-thinking').count(), 0);
    await page.click('#action-pave');
    await page.click('#board [data-road="h-0-0"]');

    // Mayor Bot 1's turn.
    await page.locator('#cpu-status').waitFor({ state: 'visible' });
    await tip('cpu').waitFor();
    assert.match(await tip('cpu').textContent(), /Tip \d of 9.*CPU turns/s);
    assert.equal(await page.locator('.player-card.is-thinking').count(), 1, 'only the active bot glows');
    assert.equal(await page.locator(`.player-card.is-thinking[data-seat="${(await game()).seat}"]`).count(), 1, 'the glowing card is the bot whose turn it is');
    await page.locator('#cpu-status-intent').waitFor({ state: 'visible' });
    assert.ok((await page.textContent('#cpu-status-intent')).trim().length > 0, 'the bot says what it intends');
    assert.equal(await page.locator('.cpu-intent').count() <= 1, true);
    assert.equal(await page.locator('#board.is-locked').count() === 1, true, 'the board is locked');
    assert.equal(await page.isVisible('#action-pave'), false);
    const before = await game();
    await page.click('#board [data-road="h-0-5"]'); // top row: clear of the tutorial note on a phone
    assert.notEqual(await page.evaluate(() => window.__GRIDLOCK__.getGame().board.roads['h-0-5']), 1, 'a person can\'t move for a bot');
    assert.match(await page.textContent('#toasts'), /Mayor Bot \d is playing/);
    await noHorizontalScroll(page, `${vp.name} CPU turn`);
    await page.screenshot({ path: `test-results/cpu-turn-${vp.name}.png` });

    // Pause (from the strip) stops the bot; resuming lets it continue.
    await page.click('#cpu-pause');
    await page.locator('#pause-dialog').waitFor({ state: 'visible' });
    const paused = await game();
    await page.waitForTimeout(1500);
    assert.deepEqual(await game(), paused, 'nothing happens while paused');
    assert.equal(paused.log >= before.log, true);
    await page.click('#pause-dialog [data-dialog-action="resume"]');
    // Speed up: pressed, saved, and the bots play on until Player 1 has the table again.
    await page.click('#cpu-faster');
    assert.equal(await page.getAttribute('#cpu-faster', 'aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('gridlock.settings.v1')).cpuSpeed), 'fast');
    for (let i = 0; i < 300 && (await game()).seat !== 1; i++) {
      if (await page.locator('#event-dialog[open]').count()) await page.click('#event-continue');
      else await page.waitForTimeout(100);
    }
    assert.equal((await game()).seat, 1, 'control came back to the human');
    await page.locator('#cpu-status').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.player-card.is-thinking').count(), 0);
    assert.equal(await page.locator('.cpu-intent').count(), 0, 'no leftover highlight');
    assert.deepEqual(errors, []);
    console.log(`✔ ${vp.name}: play options (Solo / Local Multiplayer / Custom), Solo defaults, CPU tip, bot highlight + intent, locked board, Pause, Speed up`);
  } catch (err) {
    failures++;
    console.error(`✘ ${vp.name} play options / CPU turn UI: ${err.message}`);
    await page.screenshot({ path: `test-results/play-options-${vp.name}-FAIL.png` }).catch(() => {});
  } finally {
    await context.close();
  }
}

// 3 people + 1 CPU on a phone with reduced motion and haptics: handoffs only between people,
// the bot's moves never vibrate, nothing animates, and sound keeps working around bot turns.
{
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, ...(browserName === 'firefox' ? {} : { isMobile: true }), hasTouch: true, reducedMotion: 'reduce',
  });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  await context.addInitScript(recordVibration);
  await context.addInitScript(() => {
    if (!sessionStorage.getItem('gl-test-init')) {
      sessionStorage.setItem('gl-test-init', '1');
      localStorage.setItem('gridlock.tutorial.v1', '{"status":"done"}');
      localStorage.setItem('gridlock.settings.v1', JSON.stringify({ confirmTaps: false, quickHandoff: false, cpuSpeed: 'fast' }));
    }
    window.__opened = [];
    const showModal = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function () { window.__opened.push(this.id); return showModal.call(this); };
  });
  const page = await context.newPage();
  const errors = watchForBrowserErrors(page);
  const seatNow = () => page.evaluate(() => { const g = window.__GRIDLOCK__.getGame(); return g.players[g.turnIndex].seat; });
  const handoffs = () => page.evaluate(() => window.__opened.filter((id) => id === 'handoff-dialog').length);
  const running = () => page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length);
  try {
    await page.goto(`${base}?debug`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /^Custom \/ Mixed Game/ }).tap();
    await page.locator('.seat-card[data-seat="4"] [name="controller-4"][value="cpu"]').check();
    assert.match(await page.textContent('#setup-summary'), /4 players \(3 human, 1 CPU\)/);
    await page.fill('#setup-seed', '4242');
    await page.locator('#setup-start').tap();
    assert.deepEqual(await page.evaluate(() => window.__GRIDLOCK__.getGame().players.map((p) => p.controller)), ['human', 'human', 'human', 'cpu']);
    const haptics = await page.evaluate(() => 'vibrate' in navigator && matchMedia('(pointer: coarse)').matches);

    // Person → person: the handoff screen, every time.
    for (const [road, next] of [['h-0-0', 'Player 2'], ['h-0-2', 'Player 3']]) {
      await page.locator(`#board [data-road="${road}"]`).tap();
      await page.locator('#handoff-dialog').waitFor({ state: 'visible' });
      assert.equal(await page.textContent('#handoff-title'), `Pass to ${next}`);
      await page.waitForTimeout(400); // the tap-through guard ignores taps just after a dialog opens…
      await page.locator('#handoff-ready').tap();
      await page.waitForTimeout(400); // …and just after it closes
    }
    assert.equal(await handoffs(), 2);
    // Player 3 → the bot: no handoff; bot moves don't vibrate; reduced motion means no animation.
    await page.locator('#board [data-road="h-0-4"]').tap();
    const vibBefore = (await page.evaluate(() => window.__vib)).length;
    await page.locator('#cpu-status').waitFor({ state: 'visible' });
    assert.equal(await seatNow(), 4);
    assert.equal(await handoffs(), 2, 'no handoff before the bot');
    assert.equal(await page.locator('.player-card.is-thinking[data-seat="4"]').count(), 1);
    assert.equal(await running(), 0, 'reduced motion: the thinking glow does not animate');
    await noHorizontalScroll(page, '3 people + 1 CPU phone');
    // After the bot: back to Player 1, with a handoff (a different person than the last one).
    await page.locator('#handoff-dialog').waitFor({ state: 'visible', timeout: 20_000 });
    assert.equal(await page.textContent('#handoff-title'), 'Pass to Player 1');
    assert.equal((await page.evaluate(() => window.__vib)).length, vibBefore, 'the bot\'s moves never vibrate the phone');
    if (haptics) assert.ok(vibBefore > 0, 'people\'s own moves do (haptics on)');
    const log = await page.evaluate(() => window.__GRIDLOCK__.getGame().log.filter((e) => e.type === 'road').map((e) => e.seat));
    assert.deepEqual(log.slice(0, 3), [1, 2, 3]);
    assert.ok(log.slice(3).every((seat) => seat === 4) && log.length >= 4, 'the bot paved its own road');
    const sound = await page.evaluate(() => window.__GRIDLOCK__.audio());
    assert.equal(sound.unlocked, true, 'sound unlocked by the first tap');
    assert.equal(sound.reduced, true);
    await page.waitForTimeout(400);
    await page.locator('#handoff-ready').tap();
    assert.equal(await seatNow(), 1);
    assert.deepEqual(errors, []);
    console.log('✔ 3 people + 1 CPU (phone, reduced motion, haptics): handoffs only between people, no bot vibration or animation');
  } catch (err) {
    failures++;
    console.error(`✘ 3 people + 1 CPU: ${err.message}`);
    await page.screenshot({ path: 'test-results/three-plus-bot-FAIL.png' }).catch(() => {});
  } finally {
    await context.close();
  }
}

// Start screen → INSPIRE intro → main menu (once per session), the INSPIRE logo, the downtown
// street, music by scene (menu / gameplay / pause) and the media files. Desktop and phone.
for (const vp of [{ name: 'desktop', width: 1280, height: 720 }, { name: 'phone', width: 390, height: 844, isMobile: true, hasTouch: true }]) {
  const context = await browser.newContext({
    freshStart: true, viewport: { width: vp.width, height: vp.height },
    ...(browserName === 'firefox' ? {} : { isMobile: vp.isMobile ?? false }), hasTouch: vp.hasTouch ?? false, reducedMotion: 'reduce',
  });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  await context.addInitScript(() => {
    if (!sessionStorage.getItem('gl-test-init')) {
      sessionStorage.setItem('gl-test-init', '1');
      localStorage.setItem('gridlock.tutorial.v1', '{"status":"done"}');
      localStorage.setItem('gridlock.settings.v1', JSON.stringify({ confirmTaps: false, quickHandoff: true }));
    }
  });
  const page = await context.newPage();
  const errors = watchForBrowserErrors(page);
  const screen = () => page.evaluate(() => document.body.dataset.activeScreen);
  const music = () => page.evaluate(() => window.__GRIDLOCK__.audio().music);
  /** The music theme once it has settled (dialog close events arrive a moment after the click). */
  const theme = async (want) => {
    await page.waitForFunction((w) => window.__GRIDLOCK__.audio().music.theme === w, want, { timeout: 3000 }).catch(() => {});
    return (await music()).theme;
  };
  const logoLoaded = (where) => page.locator(`[data-screen="${where}"] .inspire-logo`).evaluate((img) => img.complete && img.naturalWidth > 0);
  try {
    await page.goto(`${base}?debug`, { waitUntil: 'networkidle' });
    assert.equal(await screen(), 'start', 'a new session opens on the start screen');
    assert.equal(await page.isVisible('#start-button'), true);
    assert.match(await page.textContent('#start-prompt'), vp.hasTouch ? /^Tap to start$/ : /press Enter to start/);
    assert.equal(await logoLoaded('start'), true, 'INSPIRE logo on the start screen');
    assert.ok(await page.locator('[data-screen="start"] .downtown__building').count() >= 3, 'the downtown street');
    assert.equal(await page.evaluate(() => window.__GRIDLOCK__.audio().contextState), 'none', 'no sound before the first tap');
    await noHorizontalScroll(page, `${vp.name} start`);
    await page.screenshot({ path: `test-results/start-${vp.name}.png` });

    // The first tap: the INSPIRE intro (its video may not play in a test browser: it then ends
    // by itself), never any music under it; Skip ends it early.
    await (vp.hasTouch ? page.locator('#start-button').tap() : page.click('#start-button'));
    const during = await page.evaluate(() => [document.body.dataset.activeScreen, window.__GRIDLOCK__.audio().music.theme]);
    // (A test browser without H.264 ends the intro at once, straight to the menu.)
    if (during[0] === 'intro') assert.equal(during[1], null, 'no music during the intro');
    else assert.equal(during[0], 'title');
    assert.equal(await page.getAttribute('#intro-video', 'src'), 'assets/media/inspiresoftwareintro.mp4');
    await page.waitForTimeout(600); // past the guard that keeps the start tap from skipping it
    if (await screen() === 'intro') await page.click('#intro-skip');
    await page.waitForFunction(() => document.body.dataset.activeScreen === 'title', null, { timeout: 16_000 });
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.setupPreset), 'solo', 'focus lands on Play Solo');
    assert.equal(await logoLoaded('title'), true, 'INSPIRE logo on the main menu');
    for (const name of ['Play Solo', 'Local Multiplayer', 'Custom / Mixed Game']) {
      const box = await page.getByRole('button', { name: new RegExp(`^${name.replace('/', '\\/')}`) }).boundingBox();
      assert.ok(box.y >= 0 && box.y + box.height <= vp.height, `${name} is on screen`);
    }
    await noHorizontalScroll(page, `${vp.name} title`);
    assert.equal(await theme('menu'), 'menu', 'the menu theme on the main menu');

    // Music by scene: gameplay theme in play, the menu theme in the pause menu, and back.
    await page.click('[data-setup-preset="solo"]');
    await page.click('#setup-start');
    assert.equal(await theme('game'), 'game');
    await page.click('#game-menu-btn');
    assert.equal(await theme('menu'), 'menu', 'pause menu: the menu theme');
    await page.click('#pause-dialog [data-dialog-action="resume"]');
    assert.equal(await theme('game'), 'game');
    const volumes = await page.evaluate(() => window.__GRIDLOCK__.audio().levels);
    assert.ok(volumes.music > 0 && volumes.music < volumes.sfx, 'music sits under the effects');

    // Music switch in Settings (saved), and a reload in the same session skips the start screen.
    await page.click('#game-menu-btn');
    await page.click('#pause-dialog [data-dialog-action="save-quit"]');
    assert.equal(await screen(), 'title');
    assert.equal(await theme('menu'), 'menu', 'back on the menu: the menu theme');
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await screen(), 'title', 'a reload in the same session goes straight to the menu');
    await page.click('[data-screen="title"] [data-nav="settings"]');
    assert.equal(await page.isChecked('#settings-form [name="music"]'), true);
    await page.locator('#settings-form [name="music"]').evaluate((el) => el.closest('label').click());
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('gridlock.settings.v1')).music), false);
    assert.equal(await theme(null), null, 'Music off');
    assert.equal(await page.locator('#settings-form [name="musicVolume"]').isDisabled(), true);

    // The media are served (and precached for offline play).
    for (const file of ['assets/media/cardboard-city.mp3', 'assets/media/paper-blocks.mp3', 'assets/media/inspiresoftwareintro.mp4', 'assets/media/inspire.png']) {
      const status = await page.evaluate((url) => fetch(url, { method: 'HEAD' }).then((r) => r.status), file);
      assert.equal(status, 200, `${file} served`);
    }
    assert.deepEqual(errors, []);
    console.log(`✔ ${vp.name}: start screen → INSPIRE intro → menu, INSPIRE logo, downtown, music by scene, Music setting`);
  } catch (err) {
    failures++;
    console.error(`✘ ${vp.name} start/intro/music: ${err.message}`);
    await page.screenshot({ path: `test-results/start-${vp.name}-FAIL.png` }).catch(() => {});
  } finally {
    await context.close();
  }
}

// Keyboard: Enter starts (and never also presses the menu button that gets focus); Escape skips the intro.
{
  const context = await browser.newContext({ freshStart: true, viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  const page = await context.newPage();
  const errors = watchForBrowserErrors(page);
  try {
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    if (await page.evaluate(() => document.body.dataset.activeScreen) === 'intro') await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.body.dataset.activeScreen === 'title', null, { timeout: 16_000 });
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => document.body.dataset.activeScreen), 'title', 'still on the menu: the start key did not press Play Solo');
    assert.deepEqual(errors, []);
    console.log('✔ keyboard: Enter starts, Escape skips the intro, no click-through');
  } catch (err) {
    failures++;
    console.error(`✘ keyboard start: ${err.message}`);
  } finally {
    await context.close();
  }
}

// Desktop fits one screen: real browser windows are short (1366×768 screens leave ~650px). The
// game, the build panel, the results and New Game's Start button fit without scrolling, and the
// board is square and clear of the action bar.
for (const [w, h] of [[1366, 650], [1920, 940]]) {
  const context = await browser.newContext({ viewport: { width: w, height: h }, reducedMotion: 'reduce' });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  await context.addInitScript(() => {
    if (!sessionStorage.getItem('gl-test-init')) {
      sessionStorage.setItem('gl-test-init', '1');
      localStorage.setItem('gridlock.tutorial.v1', '{"status":"done"}');
      localStorage.setItem('gridlock.settings.v1', JSON.stringify({ confirmTaps: false, quickHandoff: true }));
    }
  });
  const page = await context.newPage();
  const errors = watchForBrowserErrors(page);
  const scroll = () => page.evaluate(() => [document.documentElement.scrollWidth - innerWidth, document.documentElement.scrollHeight - innerHeight]);
  const fitsDialog = (sel) => page.locator(sel).evaluate((d) => d.scrollHeight <= d.clientHeight + 1);
  try {
    await page.goto(`${base}?debug`, { waitUntil: 'networkidle' });
    await page.click('[data-setup-preset="friends"]');
    const start = await page.locator('#setup-start').boundingBox();
    assert.ok(start.y + start.height <= h, `${w}×${h}: Start Game on screen`);
    await page.click('[data-screen="setup"] [data-nav="back"]');
    await page.click('[data-screen="title"] [data-nav="settings"]');
    assert.deepEqual(await scroll(), [0, 0], `${w}×${h}: Settings fit`);
    await page.click('[data-screen="settings"] [data-nav="back"]');
    await page.click('[data-setup-preset="friends"]');
    await page.click('#setup-start');
    assert.deepEqual(await scroll(), [0, 0], `${w}×${h}: the game fits one screen`);
    const g = await page.evaluate(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      return { frame: r('#board-frame'), bar: r('.action-bar'), legend: r('.district-legend') };
    });
    assert.ok(Math.abs(g.frame.width - g.frame.height) <= 1, `${w}×${h}: square board`);
    assert.ok(g.frame.bottom <= g.bar.top + 1, `${w}×${h}: board clear of the action bar`);
    assert.ok(g.legend.bottom <= g.bar.top + 1, `${w}×${h}: district key clear of the action bar`);
    // Build panel and results fit without scrolling inside.
    await page.evaluate(() => { const game = window.__GRIDLOCK__.getGame(); game.eventPool = []; for (const id of ['h-0-0', 'v-0-0', 'v-0-1']) game.board.roads[id] = 2; });
    await page.click('#board [data-road="h-1-0"]');
    await page.click('#capture-choice-dialog [data-capture-choice="develop"]');
    await page.locator('#build-dialog').waitFor({ state: 'visible' });
    assert.equal(await fitsDialog('#build-dialog'), true, `${w}×${h}: build panel fits`);
    // Back out of the build panel and leave the block vacant: on to the bonus road.
    await page.locator('#build-dialog').getByRole('button', { name: 'Leave Vacant' }).click();
    await page.waitForFunction(() => window.__GRIDLOCK__.getGame().turnPhase === 'bonus-road');
    const last = await page.evaluate(async () => {
      const { allRoadIds } = await import('./js/core/board.js');
      const game = window.__GRIDLOCK__.getGame();
      const ids = allRoadIds(game.board).filter((id) => game.board.roads[id] == null);
      ids.slice(0, -1).forEach((id) => { game.board.roads[id] = 1; });
      game.city.rounds = 0; // staged finish goes straight to results (the City era has its own scenario)
      for (const b of game.board.blocks) if (b.ownerSeat == null) b.ownerSeat = 1 + ((b.row + b.col) % 4);
      return ids.at(-1);
    });
    await page.evaluate((id) => document.querySelector(`#board [data-road="${id}"]`).click(), last);
    await page.locator('#results-dialog').waitFor({ state: 'visible' });
    await page.waitForTimeout(400);
    assert.equal(await fitsDialog('#results-dialog'), true, `${w}×${h}: results fit`);
    assert.deepEqual(errors, []);
    console.log(`✔ desktop ${w}×${h}: game, New Game, Settings, build panel and results fit one screen; square board`);
  } catch (err) {
    failures++;
    console.error(`✘ desktop ${w}×${h} fit: ${err.message}`);
    await page.screenshot({ path: `test-results/desktop-fit-${w}x${h}-FAIL.png` }).catch(() => {});
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
