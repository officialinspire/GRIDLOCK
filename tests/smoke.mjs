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
    // Fall back to a globally installed copy.
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

/** City event cards are modal; close one if it's showing. */
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
    if (response.status() >= 400 && !optionalFont(response.url())) {
      errors.push(`HTTP ${response.status()}: ${response.url()}`);
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
    // Firefox does not implement Playwright's mobile emulation. Touch-specific
    // coverage still runs there in a touch-enabled desktop context below.
    ...(browserName === 'firefox' ? {} : { isMobile: vp.isMobile ?? false }),
    hasTouch: vp.hasTouch ?? false,
    deviceScaleFactor: 1,
    reducedMotion: 'reduce', // stable screenshots
  });
  // Google Fonts are optional; block them so tests are hermetic.
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

    // Title
    await page.waitForSelector('html.is-ready');
    assert.ok(await page.isVisible('[data-screen="title"]'), 'title visible');
    for (const label of ['New Game', 'How To Play', 'Settings']) {
      assert.ok(await page.getByRole('button', { name: label }).isVisible(), `${label} button`);
    }
    const unsprited = await page.$$eval('[data-sprite]', (els) => els.length);
    assert.equal(unsprited, 0, 'all static sprites hydrated');
    await noHorizontalScroll(page, 'title');
    await shot('1-title');

    // How To Play
    await page.getByRole('button', { name: 'How To Play' }).click();
    assert.ok(await page.isVisible('[data-screen="howto"]'));
    assert.equal(await page.locator('.howto-card').count(), 9);
    await noHorizontalScroll(page, 'howto');
    await shot('2-howto');
    await page.locator('[data-screen="howto"] [data-nav="back"]').click();
    assert.ok(await page.isVisible('[data-screen="title"]'), 'back to title');

    // Settings (persist across reload)
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.locator('label.setting-row', { hasText: 'Show block coordinates' }).click();
    assert.equal(await page.locator('input[name="music"]').count(), 0, 'placeholder music toggle removed');
    await noHorizontalScroll(page, 'settings');
    await shot('3-settings');
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Settings' }).click();
    assert.equal(await page.isChecked('input[name="showCoords"]'), true, 'coords persisted');
    await page.locator('[data-screen="settings"] [data-nav="back"]').click();

    // Setup
    await page.getByRole('button', { name: 'New Game' }).click();
    assert.equal(await page.locator('.seat-card').count(), 4);
    assert.match(await page.textContent('#setup-summary'), /Standard Game · 4 players · \$12,000 each/);
    assert.equal(await page.locator('[name="join"]:disabled').count(), 4, 'Standard Game locks all four seats');
    await page.fill('#seat-1-name', 'Ada');
    await page.fill('#seat-2-name', '<b>Bo</b>');
    await page.check('[name="gameType"][value="custom"]');
    // Dropping to 1 player disables start.
    for (const s of [2, 3, 4]) await page.locator(`label[for="seat-${s}-join"]`).click();
    assert.equal(await page.isDisabled('#setup-start'), true, 'start disabled with 1 player');
    for (const s of [2, 3, 4]) await page.locator(`label[for="seat-${s}-join"]`).click();
    assert.equal(await page.isDisabled('#setup-start'), false);
    assert.equal(await page.locator('.seat-card.is-out').count(), 0, 'all seats rejoined');
    await page.waitForTimeout(300); // let toggle transitions settle for the screenshot
    await noHorizontalScroll(page, 'setup');
    await shot('4-setup');
    await page.click('#setup-start');

    // Game board + HUD
    const road = (id) => page.locator(`#board [data-road="${id}"]`);
    const block = (id) => page.locator(`#board [data-block="${id}"]`);
    const banner = () => page.textContent('#turn-banner');

    assert.ok(await page.isVisible('[data-screen="game"]'), 'game visible');
    assert.equal(await page.locator('#board .block').count(), 36, '6x6 blocks');
    assert.equal(await page.locator('#board .road').count(), 84, 'road slots');
    assert.equal(await page.locator('#board .node').count(), 49, 'intersections');
    assert.equal(await page.locator('.player-card').count(), 4, 'four HUD cards');
    assert.equal(await page.locator('.player-card.is-active').count(), 1);
    assert.match(await banner(), /Ada's turn/);
    assert.equal(await page.textContent('#hud-round'), '1');
    assert.equal(await page.textContent('#hud-roads'), '0/84');
    assert.equal(await page.getAttribute('#board-frame', 'data-turn'), 'red');
    assert.ok((await page.textContent('#hud-left')).includes('$12,000'), 'cash shown');
    const firstTabStop = page.locator('#board [tabindex="0"]');
    assert.equal(await firstTabStop.count(), 1, 'board uses one roving tab stop');
    await firstTabStop.focus();
    const beforeArrow = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
    await page.keyboard.press('ArrowRight');
    const afterArrow = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
    assert.notEqual(afterArrow, beforeArrow, 'arrow key moves board focus');
    const keyboardBlock = await page.evaluate(() => document.activeElement?.dataset.block);
    await page.keyboard.press('Enter');
    assert.equal(await page.locator(`[data-block="${keyboardBlock}"]`).getAttribute('aria-pressed'), 'true', 'Enter activates focused block');
    if (await page.isVisible('#info-dialog')) await page.click('[data-info-close]');
    assert.match(await page.textContent('[data-screen="howto"]'), /\$12,000[\s\S]*\$500/, 'rules copy filled from ECONOMY');
    // Names are rendered as text, never HTML.
    assert.ok((await page.textContent('#hud-right')).includes('<b>Bo</b>'), 'name escaped');

    const box = await page.locator('.board-frame').boundingBox();
    assert.ok(box.width > 200, `board too small: ${box.width}`);
    assert.ok(Math.abs(box.width - box.height) < 2, 'board is square');
    assert.ok(box.x >= 0 && box.x + box.width <= vp.width + 1, 'board within viewport width');
    const tap = await road('v-2-3').boundingBox();
    assert.ok(Math.min(tap.width, tap.height) >= 10, `road slot too thin: ${JSON.stringify(tap)}`);
    await noHorizontalScroll(page, 'game');
    await shot('5-game');

    // P1 → P2 → P3 → P4 rotation, building three sides of A1.
    assert.match(await page.textContent('#turn-prompt'), /MANAGE CITY/);
    await pave(page, road('h-0-0'));
    assert.match(await banner(), /<b>Bo<\/b>'s turn/);
    assert.ok(await road('h-0-0').evaluate((el) => el.classList.contains('is-built') && el.classList.contains('road--red')));
    assert.equal(await page.getAttribute('#board-frame', 'data-turn'), 'blue');

    // Built roads are inert: even a synthetic click gives no rejection feedback.
    const toastBeforeLockedRoad = await page.textContent('#toasts');
    await road('h-0-0').dispatchEvent('click');
    assert.match(await banner(), /<b>Bo<\/b>'s turn/, 'locked road does not pass the turn');
    assert.equal(await page.textContent('#toasts'), toastBeforeLockedRoad, 'locked road gives no error feedback');
    assert.equal(await road('h-0-0').evaluate((el) => el.classList.contains('is-rejected')), false);
    assert.equal(await page.textContent('#hud-roads'), '1/84');
    assert.equal(await road('h-0-0').getAttribute('data-owner-symbol'), 'triangle');

    await pave(page, road('v-0-0'));
    assert.match(await banner(), /Player 3's turn/);
    await pave(page, road('h-1-0'));
    assert.match(await banner(), /Player 4's turn/);

    // P4 paves the final side: claims A1 and keeps the turn.
    await pave(page, road('v-0-1'));
    assert.ok(await block('r0c0').evaluate((el) => el.classList.contains('block--green')), 'A1 claimed by P4');
    assert.match(await banner(), /Player 4's turn/, 'capturing player keeps control');
    assert.match(await page.textContent('#turn-prompt'), /CAPTURE \/ DEVELOP/);
    assert.match(await page.textContent('#toasts'), /claims A1/);
    await shot('6-capture');

    // Development: P4 (still on their bonus turn) opens the Build panel on A1.
    const panel = page.locator('#build-dialog');
    const p4cash = () => page.locator('.player-card[data-seat="4"] .stat--cash dd').textContent();
    assert.ok(await page.isVisible('#capture-choice-dialog'), 'capture development choice opens');
    assert.match(await page.textContent('#capture-choice-dialog'), /Develop Now[\s\S]*Leave Vacant/);
    await page.click('[data-capture-choice="develop"]');
    assert.ok(await panel.isVisible(), 'build panel opens for owner');
    assert.match(await panel.textContent(), /Vacant · Level 0/);
    assert.equal(await panel.locator('[data-build]').count(), 6, 'six categories');
    await shot('7-build-panel');
    await panel.locator('[data-build="residential"]').click();
    assert.equal(await panel.isVisible(), false);
    assert.equal(await p4cash(), '$11,500', 'Level 1 residential costs $1,000');
    assert.equal(await block('r0c0').locator('.block__badge .pip.is-on').count(), 1, 'badge shows level 1');
    assert.match(await block('r0c0').getAttribute('aria-label'), /Residential · Level 1 · House/);
    assert.match(await page.textContent('#turn-prompt'), /BONUS ROAD/);
    await shot('8-developed');

    // P4's bonus road closes nothing → round wraps; the round may be calm.
    await pave(page, road('h-6-5'));
    const eventCard = page.locator('#event-dialog');
    if (await eventCard.isVisible()) {
      assert.match(await eventCard.textContent(),
        /(Heavy Rain|Snowstorm|Fire|Power Outage|City Festival|Housing Boom|Beautification Grant|Economic Boom|Recession)/);
      assert.match(await eventCard.textContent(), /round(s)? left · Round/);
      await shot('9-event-card');
      await page.click('#event-continue');
      assert.equal(await eventCard.isVisible(), false);
      assert.equal(await page.locator('#event-strip .event-pill').count(), 1, 'active event pill');
    } else {
      assert.match(await page.textContent('#toasts'), /Calm round/);
    }
    assert.match(await banner(), /Ada's turn/);
    assert.equal(await page.textContent('#hud-round'), '2', 'round advanced');
    const p4 = page.locator('.player-card[data-seat="4"]');
    assert.equal(await p4.locator('.stat--cash dd').textContent(), '$11,500', '+$500 reward − $1,000 development');
    assert.equal(await p4.locator('.stat--income').getAttribute('data-normal'), '300', 'Residential L1 income (before events)');
    assert.equal(await p4.locator('.stat--property dd').textContent(), '$2,000', 'land + invested');
    assert.equal(await page.locator('.player-card[data-seat="1"] .stat--cash dd').textContent(), '$12,000');

    // Inspect a block
    await block('r0c0').click();
    assert.match(await page.textContent('#inspector'), /Block A1/);
    assert.match(await page.textContent('#inspector'), /Player 4/);
    assert.match(await page.textContent('#inspector'), /Residential · Level 1 · House/);
    assert.equal(await panel.isVisible(), false, 'non-owners get the inspector, not the build panel');
    assert.equal(await page.isDisabled('#action-build'), true);
    // Compact layouts show the same details in a bottom sheet instead.
    if (await page.isVisible('#info-dialog')) {
      assert.match(await page.textContent('#info-dialog'), /Residential · Level 1 · House/);
      await page.click('[data-info-close]');
    }

    // Pave every remaining road; the game must end with all 36 blocks claimed.
    const remaining = await page.$$eval('#board .road:not(.is-built)', (els) => els.map((el) => el.dataset.road));
    for (const id of remaining) {
      await pave(page, road(id));
      await dismissEvent(page);
    }
    await page.waitForSelector('#results-dialog[open]');
    assert.equal(await page.locator('#board .block--owned').count(), 36, 'all blocks claimed');
    assert.equal(await page.textContent('#hud-roads'), '84/84');
    const cards = page.locator('#results-list .result-card');
    assert.equal(await cards.count(), 4, 'all four players on the results screen');
    for (let i = 0; i < 4; i++) {
      const text = await cards.nth(i).textContent();
      for (const label of ['City Value', 'Cash', 'Blocks owned', 'Developed', 'Income', 'Highest development']) {
        assert.ok(text.includes(label), `result card shows ${label}`);
      }
    }
    const values = await cards.locator('.result-card__city-value').allTextContents();
    const nums = values.map((v) => Number(v.replace(/[^0-9-]/g, '')));
    assert.deepEqual([...nums].sort((x, y) => y - x), nums, 'cards ordered by City Value');
    const winnerCards = page.locator('#results-list .result-card.is-winner');
    assert.ok(await winnerCards.count() >= 1);
    assert.equal(Number((await winnerCards.first().locator('.result-card__city-value').textContent()).replace(/[^0-9-]/g, '')), nums[0]);
    assert.ok(await page.locator('#results-awards .award').count() >= 1, 'distinctions awarded');
    assert.match(await page.textContent('#results-awards'), /Most Blocks/);
    assert.match(await banner(), /wins!|Tie:/);
    await shot('10-results');

    // View Board, then reopen the results from the action bar.
    await page.getByRole('button', { name: 'View Board' }).click();
    assert.equal(await page.isVisible('#results-dialog'), false);
    await page.click('#action-results');
    assert.ok(await page.isVisible('#results-dialog'), 'results reopen');

    // Rematch starts a clean board.
    await page.getByRole('button', { name: 'Play Again' }).click();
    assert.equal(await page.textContent('#hud-roads'), '0/84', 'rematch reset');
    assert.equal(await page.locator('#board .block--owned').count(), 0);
    assert.match(await banner(), /Ada's turn/);

    // Pause → quit
    await page.click('#game-menu-btn');
    assert.ok(await page.isVisible('#pause-dialog'));
    await shot('11-pause');
    await page.getByRole('button', { name: 'Quit to Title' }).click();
    assert.ok(await page.isVisible('[data-screen="title"]'), 'quit to title');

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

// Financial distress → recovery, bankruptcy → abandoned blocks → restore/rebuild (desktop, ?debug to set up state).
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  await context.addInitScript(() => {
    if (!sessionStorage.getItem('gl-test-init')) {
      sessionStorage.setItem('gl-test-init', '1');
      localStorage.setItem('gridlock.settings.v1', JSON.stringify({ confirmTaps: false, quickHandoff: true }));
    }
  });
  const page = await context.newPage();
  const errors = watchForBrowserErrors(page);
  try {
    await page.goto(`${base}?seed=5&debug`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'New Game' }).click();
    await page.click('#setup-start');
    const road = (id) => page.locator(`#board [data-road="${id}"]`);
    const fin = page.locator('#finance-dialog');

    // P2: ten idle lots + one Level-2 home and $0 → upkeep beats income. P3: $-5,000 with little to sell.
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

    await pave(page, road('h-3-3')); // P1 → P2's turn: income, then upkeep → distress
    assert.ok(await fin.isVisible(), 'distress panel opens');
    assert.match(await fin.textContent(), /Player 2 is \$\d[\d,]* in debt/);
    assert.equal(await fin.locator('#declare-bankruptcy').count(), 0, 'can still recover → no bankruptcy button');
    assert.ok(await page.locator('.player-card[data-seat="2"].is-distress').count(), 'HUD shows debt');
    await page.screenshot({ path: 'test-results/finance-distress.png' });

    // Try to pave while in debt: refused and the panel comes back.
    await fin.getByRole('button', { name: 'View board' }).click();
    assert.equal(await page.isVisible('#action-finance'), true, 'Resolve Debt button');
    await road('h-3-4').dispatchEvent('click');
    assert.match(await page.textContent('#toasts'), /Resolve your debt/);
    assert.ok(await fin.isVisible(), 'panel reopens');

    await fin.locator('[data-sell="r4c5"]').click(); // sell the home (+$1,250)
    assert.equal(await fin.isVisible(), false, 'recovered → panel closes');
    assert.match(await page.textContent('#toasts'), /Back in the black/);
    assert.equal(await page.locator('.player-card[data-seat="2"].is-distress').count(), 0);
    await pave(page, road('h-3-4')); // P2 can pave again → P3's turn: deep debt
    assert.ok(await fin.isVisible());
    await fin.locator('#declare-bankruptcy').click();
    assert.match(await fin.textContent(), /Player 3 declares bankruptcy/);
    assert.match(await fin.textContent(), /2 blocks abandoned/);
    assert.match(await fin.textContent(), /Fresh start: \$2,000/);
    await page.screenshot({ path: 'test-results/finance-bankruptcy.png' });
    await fin.getByRole('button', { name: 'Continue' }).click();

    const p3 = page.locator('.player-card[data-seat="3"]');
    assert.equal(await p3.locator('.stat--cash dd').textContent(), '$2,000');
    assert.equal(await p3.locator('.player-card__fresh').textContent(), '↺1');
    assert.equal(await page.locator('#board .block--abandoned').count(), 2);
    assert.equal(await page.locator('[data-block="r0c0"] .block__building').count(), 1, 'ruin still visible');
    await page.screenshot({ path: 'test-results/finance-abandoned.png' });

    // P3 carries on; P4 restores the ruined home and rebuilds the empty lot.
    await pave(page, road('h-3-5')); // P3 → P4
    const panel = page.locator('#build-dialog');
    await page.locator('[data-block="r0c0"]').click();
    assert.match(await panel.textContent(), /Abandoned by Player 3/);
    await page.screenshot({ path: 'test-results/finance-acquire.png' });
    await panel.locator('[data-auction="restore"]').click();
    assert.ok(await page.locator('[data-block="r0c0"]').evaluate((el) => el.classList.contains('block--green')), 'P4 owns the restored home');
    await page.locator('[data-block="r0c1"]').click();
    assert.equal(await panel.locator('[data-auction="restore"]').count(), 0, 'empty ruin can only be rebuilt');
    await panel.locator('[data-auction="rebuild"]').click();
    assert.ok(await panel.isVisible(), 'build panel reopens to choose a category');
    await panel.locator('[data-build="park"]').click();
    assert.equal(await page.locator('#board .block--abandoned').count(), 0);

    assert.deepEqual(errors, []);
    console.log('✔ distress, bankruptcy & redevelopment');
  } catch (err) {
    failures++;
    console.error(`✘ finance: ${err.message}`);
    await page.screenshot({ path: 'test-results/finance-FAIL.png' }).catch(() => {});
  } finally {
    await context.close();
  }
}

// City event (deterministic via ?seed=12: the first event is a Fire hitting P4's only developed block).
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  await context.addInitScript(() => {
    if (!sessionStorage.getItem('gl-test-init')) {
      sessionStorage.setItem('gl-test-init', '1');
      localStorage.setItem('gridlock.settings.v1', JSON.stringify({ confirmTaps: false, quickHandoff: true }));
    }
  });
  const page = await context.newPage();
  const errors = watchForBrowserErrors(page);
  try {
    await page.goto(`${base}?seed=19`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'New Game' }).click();
    await page.click('#setup-start');
    const road = (id) => page.locator(`#board [data-road="${id}"]`);
    for (const id of ['h-0-0', 'v-0-0', 'h-1-0', 'v-0-1']) await pave(page, road(id)); // P4 claims A1
    await page.click('[data-capture-choice="develop"]');
    await page.locator('#build-dialog [data-build="residential"]').click();
    await pave(page, road('h-6-5')); // round wraps → event

    const card = page.locator('#event-dialog');
    assert.ok(await card.isVisible());
    assert.equal(await card.locator('.event-card__name').textContent(), 'Fire');
    assert.match(await card.textContent(), /2 rounds left · Rounds 2–3/);
    assert.match(await card.textContent(), /1 block affected/);
    assert.match(await card.locator('.event-card__blocks').textContent(), /A1\s*Player 4/);
    await page.screenshot({ path: 'test-results/event-fire-card.png' });
    await page.click('#event-continue');

    assert.ok(await page.locator('[data-block="r0c0"]').evaluate((el) => el.classList.contains('is-event-hurt')), 'A1 marked');
    assert.equal(await page.locator('#event-strip .event-pill').textContent(), 'Fire2r');
    const income = page.locator('.player-card[data-seat="4"] .stat--income');
    assert.match(await income.locator('dd').textContent(), /^\+\$0/, 'fire zeroes A1 income');
    assert.equal(await income.getAttribute('data-normal'), '300');
    assert.equal(await income.locator('.stat__event--down').count(), 1, 'HUD ▼');
    await page.locator('[data-block="r0c0"]').click();
    assert.match(await page.textContent('#inspector'), /Fire[\s\S]*no income[\s\S]*2 rounds/);
    await page.screenshot({ path: 'test-results/event-fire-board.png' });

    assert.deepEqual(errors, []);
    console.log('✔ city event (seeded fire)');
  } catch (err) {
    failures++;
    console.error(`✘ city event: ${err.message}`);
    await page.screenshot({ path: 'test-results/event-FAIL.png' }).catch(() => {});
  } finally {
    await context.close();
  }
}

// District bonus through real play (desktop).
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  await context.addInitScript(() => {
    if (!sessionStorage.getItem('gl-test-init')) {
      sessionStorage.setItem('gl-test-init', '1');
      localStorage.setItem('gridlock.settings.v1', JSON.stringify({ confirmTaps: false, quickHandoff: true }));
    }
  });
  const page = await context.newPage();
  const errors = watchForBrowserErrors(page);
  try {
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'New Game' }).click();
    await page.click('#setup-start');
    const road = (id) => page.locator(`#board [data-road="${id}"]`);
    // Set up a 3-block corridor along the top row without anyone capturing…
    for (const id of ['h-0-0', 'h-0-1', 'h-0-2', 'h-1-0', 'h-1-1', 'h-1-2', 'v-0-0']) {
      await road(id).click();
      await dismissEvent(page);
    }
    // …then P4 closes A1, B1, C1 in a chain.
    for (const id of ['v-0-1', 'v-0-2', 'v-0-3']) await road(id).click();
    assert.equal(await page.locator('#board .block--green').count(), 3, 'P4 chained 3 captures');

    const panel = page.locator('#build-dialog');
    for (const id of ['r0c0', 'r0c1']) {
      await page.locator(`[data-block="${id}"]`).click();
      await panel.locator('[data-build="residential"]').click();
    }
    const income = page.locator('.player-card[data-seat="4"] .stat--income');
    assert.equal(await income.locator('.stat__bonus').count(), 0, 'no bonus with 2 homes');

    await page.locator('[data-block="r0c2"]').click();
    await panel.locator('[data-build="residential"]').click();
    assert.match(await page.textContent('#toasts'), /Bonus income \+\$180\/turn/);
    assert.equal(await income.locator('.stat__bonus').count(), 1, 'HUD ★');
    assert.equal(await income.getAttribute('data-normal'), '1080', '3 × ($300 + 20%)');
    assert.match(await income.getAttribute('title'), /\$180 adjacency bonus/);
    assert.equal(await page.locator('#board .block__badge.has-bonus').count(), 3, 'badge stars');
    assert.match(await page.textContent("#inspector"), /Residential district[\s\S]*\+\$60/);
    await page.screenshot({ path: 'test-results/bonus-district.png' });

    // The build panel shows the bonus too.
    await page.locator('[data-block="r0c1"]').click();
    assert.match(await panel.textContent(), /incl\. \$60 bonus/);
    assert.match(await panel.textContent(), /Residential district/);
    await page.screenshot({ path: 'test-results/bonus-panel.png' });
    await panel.getByRole('button', { name: 'Keep as is' }).click();

    assert.deepEqual(errors, []);
    console.log('✔ district bonus');
  } catch (err) {
    failures++;
    console.error(`✘ district bonus: ${err.message}`);
    await page.screenshot({ path: 'test-results/bonus-FAIL.png' }).catch(() => {});
  } finally {
    await context.close();
  }
}

// Game completion with a deterministic 4-way tie, then Main Menu (desktop, ?debug to stage the board).
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  await context.addInitScript(() => {
    if (!sessionStorage.getItem('gl-test-init')) {
      sessionStorage.setItem('gl-test-init', '1');
      localStorage.setItem('gridlock.settings.v1', JSON.stringify({ confirmTaps: false, quickHandoff: true }));
    }
  });
  const page = await context.newPage();
  const errors = watchForBrowserErrors(page);
  try {
    await page.goto(`${base}?seed=1&debug`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'New Game' }).click();
    await page.click('#setup-start');
    // Every road but the last is paved; the block it would close is abandoned, so the final
    // road captures nothing and all four mayors finish with identical cities.
    const last = await page.evaluate(async () => {
      const { allRoadIds, getBlock } = await import('/js/core/board.js');
      const g = window.__GRIDLOCK__.getGame();
      g.eventPool = [];
      const ids = allRoadIds(g.board);
      ids.slice(0, -1).forEach((id) => { g.board.roads[id] = 0; });
      const b = getBlock(g.board, 5, 5);
      b.abandoned = true;
      b.abandonedBy = 4;
      return ids.at(-1);
    });
    await pave(page, page.locator(`[data-road="${last}"]`));
    const dialog = page.locator('#results-dialog');
    await dialog.waitFor({ state: 'visible' });
    assert.match(await page.textContent('#results-heading'), /^Tie! All mayors share the city$/);
    assert.equal(await page.locator('.result-card.is-winner').count(), 4);
    assert.deepEqual(await page.locator('.result-card__rank').allTextContents(), ['1st', '1st', '1st', '1st']);
    assert.deepEqual(await page.locator('.result-card').evaluateAll((els) => els.map((e) => e.dataset.seat)), ['1', '2', '3', '4'], 'ties listed in seat order');
    assert.match(await page.textContent('.results__formula'), /ties broken by blocks owned/);
    assert.match(await page.textContent('#results-awards'), /No distinctions this time/, 'nothing to award in a total tie');
    assert.match(await page.textContent('#turn-banner'), /^Tie:/);
    await page.screenshot({ path: 'test-results/results-tie.png' });

    await dialog.getByRole('button', { name: 'Main Menu' }).click();
    assert.ok(await page.isVisible('[data-screen="title"]'), 'Main Menu returns to the title screen');
    assert.deepEqual(errors, []);
    console.log('✔ game completion: tie + main menu');
  } catch (err) {
    failures++;
    console.error(`✘ completion: ${err.message}`);
    await page.screenshot({ path: 'test-results/completion-FAIL.png' }).catch(() => {});
  } finally {
    await context.close();
  }
}

// Art pipeline: WebP sheets load, 9-slice UI frames apply, board tiles render on a hi-DPI phone.
{
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, reducedMotion: 'reduce',
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
  try {
    await page.goto(`${base}?debug`, { waitUntil: 'networkidle' });
    const btn = await page.locator('[data-nav="setup"]').evaluate((el) => getComputedStyle(el).borderImageSource);
    assert.match(btn, /generated\/ui\/btn-gold\.png/, '9-slice button frame');
    await page.getByRole('button', { name: 'New Game' }).click();
    await page.click('#setup-start');
    await page.evaluate(async () => {
      const { getBlock } = await import('/js/core/board.js');
      const { applyDevelopment } = await import('/js/core/development.js');
      const g = window.__GRIDLOCK__.getGame();
      const b = getBlock(g.board, 0, 0);
      b.ownerSeat = 1;
      applyDevelopment(b, 'commercial', 3);
    });
    await pave(page, page.locator('[data-road="h-0-0"]'));
    await page.waitForLoadState('networkidle');
    const loaded = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name));
    assert.ok(loaded.some((u) => /generated\/[a-z-]+\.webp$/.test(u)), 'WebP sheets used');
    assert.ok(!loaded.some((u) => /\/(roads_infrastructure|civic-buildings|UI%20icons)\.png$/.test(u)), 'big PNG originals not downloaded');
    assert.equal(await page.locator('[data-road="h-0-0"] .road__tile').count(), 1, 'paved road uses the road tile');
    assert.ok(await page.locator('.node.is-paved .node__tile').count() >= 1, 'junction tile');
    const blk = page.locator('[data-block="r0c0"]');
    assert.equal(await blk.locator('.block__prop').count(), 2, 'level-3 progression props');
    assert.equal(await blk.locator('.block__flag').count(), 1, 'ownership flag');
    // Every sprite has a real size (nothing collapsed at this scale).
    const tiny = await page.$$eval('#board .sprite', (els) => els.filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width < 4 || r.height < 4;
    }).length);
    assert.equal(tiny, 0, 'no collapsed sprites');
    await page.locator('#board-frame').screenshot({ path: 'test-results/art-board-phone-3x.png' });
    assert.deepEqual(errors, []);
    console.log('✔ art pipeline (hi-DPI phone)');
  } catch (err) {
    failures++;
    console.error(`✘ art pipeline: ${err.message}`);
  } finally {
    await context.close();
  }
}

// Touch: tap-twice-to-pave (default on for coarse pointers), no page scroll, info sheet, reset on rematch.
{
  const context = await browser.newContext({
    viewport: { width: 375, height: 667 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: 'reduce',
  });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  const page = await context.newPage();
  const errors = watchForBrowserErrors(page);
  try {
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'New Game' }).click();
    await page.click('#setup-start');
    const road = (id) => page.locator(`#board [data-road="${id}"]`);
    await page.waitForTimeout(400); // let the screen entrance animation finish
    const size = await page.evaluate(() => [document.documentElement.scrollHeight, innerHeight, document.documentElement.scrollWidth, innerWidth]);
    assert.ok(size[0] <= size[1] && size[2] <= size[3], `game fits the screen without scrolling ${size}`);
    assert.equal(await page.locator('.player-card').count(), 4);
    const cardsFit = await page.$$eval('.player-card', (els) => els.every((e) => e.scrollWidth <= e.clientWidth + 1));
    assert.ok(cardsFit, 'HUD cards do not overflow');

    await page.click('#action-pave');
    await road('h-3-3').tap();
    assert.ok(await road('h-3-3').evaluate((e) => e.classList.contains('is-armed')), 'first tap arms');
    assert.equal(await page.textContent('#hud-round'), '1');
    assert.match(await page.textContent('#turn-banner'), /Player 1/, 'turn not passed on first tap');
    await road('h-4-4').tap(); // re-arms another road instead
    assert.equal(await page.locator('.road.is-armed').count(), 1);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.road.is-armed').count(), 0, 'Escape cancels an armed road');
    await road('h-4-4').tap(); // arm again
    await road('h-4-4').tap(); // second tap paves
    assert.ok(await road('h-4-4').evaluate((e) => e.classList.contains('is-built')), 'second tap paves');
    assert.match(await page.textContent('#turn-banner'), /Player 2/);
    assert.ok(await page.isVisible('#handoff-dialog'));
    assert.match(await page.textContent('#handoff-title'), /Pass to Player 2/);
    await page.click('#handoff-ready');
    assert.equal(await road('h-3-3').evaluate((e) => e.classList.contains('is-built')), false);
    await page.setViewportSize({ width: 667, height: 375 });
    await noHorizontalScroll(page, 'touch rotation landscape');
    assert.equal(await page.locator('#board [tabindex="0"]').count(), 1, 'roving tab stop survives resize');
    await page.setViewportSize({ width: 375, height: 667 });

    // Tapping an unowned block opens the details sheet (inspector is hidden on phones).
    await page.locator('[data-block="r2c2"]').tap();
    assert.ok(await page.isVisible('#info-dialog'), 'info sheet');
    assert.match(await page.textContent('#info-dialog'), /Block C3/);
    await page.locator('[data-info-close]').tap();
    assert.equal(await page.isVisible('#info-dialog'), false);

    // Restart resets everything: pause → quit → new game.
    await page.click('#game-menu-btn');
    await page.getByRole('button', { name: 'Quit to Title' }).click();
    await page.getByRole('button', { name: 'New Game' }).click();
    await page.click('#setup-start');
    assert.equal(await page.locator('#board .road.is-built').count(), 0, 'fresh board');
    assert.equal(await page.locator('.road.is-armed').count(), 0);
    assert.equal(await page.textContent('#hud-round'), '1');
    assert.match(await page.textContent('#turn-banner'), /Player 1/);
    assert.equal(await page.locator('dialog[open]').count(), 0);
    await page.screenshot({ path: 'test-results/touch-phone-se.png' });
    assert.deepEqual(errors, []);
    console.log('✔ touch: two-tap paving, fit, info sheet, reset');
  } catch (err) {
    failures++;
    console.error(`✘ touch: ${err.message}`);
    await page.screenshot({ path: 'test-results/touch-FAIL.png' }).catch(() => {});
  } finally {
    await context.close();
  }
}

// Money animation (runs with motion enabled, desktop only).
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
  try {
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'New Game' }).click();
    await page.click('#setup-start');
    for (const id of ['h-0-0', 'v-0-0', 'h-1-0']) await pave(page, page.locator(`[data-road="${id}"]`));
    await pave(page, page.locator('[data-road="v-0-1"]')); // P4 captures A1
    const p4 = page.locator('.player-card[data-seat="4"]');
    assert.equal(await p4.locator('.cash-delta').textContent(), '+$500', 'delta chip shown');
    assert.ok(await p4.locator('.stat--cash.is-up').count(), 'cash row pulses');
    const mid = await p4.locator('.stat--cash dd').textContent();
    assert.notEqual(mid, '$12,500', `cash should still be counting up (saw ${mid})`);
    await page.waitForFunction(() =>
      document.querySelector('.player-card[data-seat="4"] .stat--cash dd')?.textContent === '$12,500');
    await page.waitForTimeout(250);
    await page.screenshot({ path: 'test-results/money-animation.png' });
    assert.deepEqual(errors, []);
    console.log('✔ money animation');
  } catch (err) {
    failures++;
    console.error(`✘ money animation: ${err.message}`);
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
