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
  page.on('requestfailed', (request) => {
    if (!optionalFont(request.url())) errors.push(`requestfailed: ${request.url()}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400 && !optionalFont(response.url())) errors.push(`HTTP ${response.status()}: ${response.url()}`);
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
      localStorage.setItem('gridlock.settings.v1', JSON.stringify({ confirmTaps: false, quickHandoff: true }));
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
    assert.equal(await page.locator('.howto-card').count(), 9);
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
  await context.addInitScript(() => localStorage.setItem('gridlock.settings.v1', JSON.stringify({ confirmTaps: false, quickHandoff: true })));
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
  await context.addInitScript(() => localStorage.setItem('gridlock.settings.v1', JSON.stringify({ confirmTaps: false, quickHandoff: true })));
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
  await context.addInitScript(() => localStorage.setItem('gridlock.settings.v1', JSON.stringify({ confirmTaps: false, quickHandoff: true })));
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
  await context.addInitScript(() => localStorage.setItem('gridlock.settings.v1', JSON.stringify({ confirmTaps: false, quickHandoff: true })));
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
  await context.addInitScript(() => localStorage.setItem('gridlock.settings.v1', JSON.stringify({ confirmTaps: false, quickHandoff: true })));
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
  await context.addInitScript(() => localStorage.setItem('gridlock.settings.v1', JSON.stringify({ confirmTaps: false, quickHandoff: true })));
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
  await context.addInitScript(() => localStorage.setItem('gridlock.settings.v1', JSON.stringify({ confirmTaps: false, quickHandoff: true })));
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
      localStorage.setItem('gridlock.settings.v1', JSON.stringify({ confirmTaps: false, quickHandoff: true }));
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

await browser.close();
server.close();
if (failures) {
  console.error(`\n${failures} viewport(s) failed`);
  process.exit(1);
}
console.log('\nAll smoke tests passed.');
