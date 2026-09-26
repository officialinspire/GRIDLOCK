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

const { chromium } = await loadPlaywright();
const launchOpts = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};

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
const browser = await chromium.launch(launchOpts);
await rm('test-results', { recursive: true, force: true });
await mkdir('test-results', { recursive: true });

let failures = 0;

async function noHorizontalScroll(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `${label}: horizontal overflow of ${overflow}px`);
}

for (const vp of VIEWPORTS) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    isMobile: vp.isMobile ?? false,
    hasTouch: vp.hasTouch ?? false,
    deviceScaleFactor: 1,
    reducedMotion: 'reduce', // stable screenshots
  });
  // Google Fonts are optional; block them so tests are hermetic.
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/fonts\.g/.test(m.text() + m.location().url) && errors.push(`console: ${m.text()}`));
  page.on('console', (m) => m.type() === 'warning' && /\[assets\]/.test(m.text()) && errors.push(`warn: ${m.text()}`));
  page.on('requestfailed', (r) => !/fonts\.g/.test(r.url()) && errors.push(`requestfailed: ${r.url()}`));
  page.on('response', (r) => r.status() >= 400 && errors.push(`HTTP ${r.status()}: ${r.url()}`));

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
    await noHorizontalScroll(page, 'settings');
    await shot('3-settings');
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Settings' }).click();
    assert.equal(await page.isChecked('input[name="showCoords"]'), true, 'coords persisted');
    await page.locator('[data-screen="settings"] [data-nav="back"]').click();

    // Setup
    await page.getByRole('button', { name: 'New Game' }).click();
    assert.equal(await page.locator('.seat-card').count(), 4);
    assert.match(await page.textContent('#setup-summary'), /4 players · \$12,000 each/);
    await page.fill('#seat-1-name', 'Ada');
    await page.fill('#seat-2-name', '<b>Bo</b>');
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
    await road('h-0-0').click();
    assert.match(await banner(), /<b>Bo<\/b>'s turn/);
    assert.ok(await road('h-0-0').evaluate((el) => el.classList.contains('is-built') && el.classList.contains('road--red')));
    assert.equal(await page.getAttribute('#board-frame', 'data-turn'), 'blue');

    // Duplicate road is rejected and the turn does not pass.
    // (dispatchEvent: Playwright won't click an aria-disabled control, but a player can tap it)
    await road('h-0-0').dispatchEvent('click');
    assert.match(await banner(), /<b>Bo<\/b>'s turn/, 'duplicate road rejected');
    assert.match(await page.textContent('#toasts'), /already paved/);
    assert.equal(await page.textContent('#hud-roads'), '1/84');

    await road('v-0-0').click();
    assert.match(await banner(), /Player 3's turn/);
    await road('h-1-0').click();
    assert.match(await banner(), /Player 4's turn/);

    // P4 paves the final side: claims A1 and keeps the turn.
    await road('v-0-1').click();
    assert.ok(await block('r0c0').evaluate((el) => el.classList.contains('block--green')), 'A1 claimed by P4');
    assert.match(await banner(), /Player 4's turn/, 'bonus road');
    assert.match(await page.textContent('#turn-prompt'), /bonus road/i);
    assert.match(await page.textContent('#toasts'), /claims A1/);
    await shot('6-capture');

    // Development: P4 (still on their bonus turn) opens the Build panel on A1.
    const panel = page.locator('#build-dialog');
    const p4cash = () => page.locator('.player-card[data-seat="4"] .stat--cash dd').textContent();
    await block('r0c0').click();
    assert.ok(await panel.isVisible(), 'build panel opens for owner');
    assert.match(await panel.textContent(), /Vacant · Level 0/);
    assert.equal(await panel.locator('[data-build]').count(), 6, 'six categories');
    await shot('7-build-panel');
    await panel.getByRole('button', { name: 'Leave Vacant' }).click();
    assert.equal(await panel.isVisible(), false, 'Leave Vacant closes the panel');
    assert.equal(await p4cash(), '$12,500', 'leaving vacant costs nothing');

    await block('r0c0').click();
    await panel.locator('[data-build="residential"]').click();
    assert.equal(await panel.isVisible(), false);
    assert.equal(await p4cash(), '$11,500', 'Level 1 residential costs $1,000');
    assert.equal(await block('r0c0').locator('.block__badge .pip.is-on').count(), 1, 'badge shows level 1');
    assert.match(await block('r0c0').getAttribute('aria-label'), /Residential · Level 1 · House/);
    assert.match(await page.textContent('#inspector'), /Residential · Level 1/);

    // Upgrade via the action-bar Build button (block still selected).
    await page.click('#action-build');
    assert.match(await panel.textContent(), /Upgrade to Level 2/);
    await panel.locator('[data-upgrade]').click();
    assert.equal(await p4cash(), '$10,000', 'upgrade to L2 costs $1,500');
    assert.equal(await block('r0c0').locator('.block__badge .pip.is-on').count(), 2);
    await shot('8-developed');

    // P4's bonus road closes nothing → round wraps to P1 and a city event is drawn.
    await road('h-6-5').click();
    const eventCard = page.locator('#event-dialog');
    assert.ok(await eventCard.isVisible(), 'event card after the first full round');
    assert.match(await eventCard.textContent(),
      /(Heavy Rain|Snowstorm|Fire|Power Outage|City Festival|Housing Boom|Beautification Grant|Economic Boom|Recession)/);
    assert.match(await eventCard.textContent(), /round(s)? left · Round/);
    await shot('9-event-card');
    await page.click('#event-continue');
    assert.equal(await eventCard.isVisible(), false);
    assert.equal(await page.locator('#event-strip .event-pill').count(), 1, 'active event pill');
    assert.match(await banner(), /Ada's turn/);
    assert.equal(await page.textContent('#hud-round'), '2', 'round advanced');
    const p4 = page.locator('.player-card[data-seat="4"]');
    assert.equal(await p4.locator('.stat--cash dd').textContent(), '$10,000', '+$500 reward − $2,500 development');
    assert.equal(await p4.locator('.stat--income').getAttribute('data-normal'), '600', 'Residential L2 income (before events)');
    assert.equal(await p4.locator('.stat--property dd').textContent(), '$3,500', 'land + invested');
    assert.equal(await page.locator('.player-card[data-seat="1"] .stat--cash dd').textContent(), '$12,000');

    // Inspect a block
    await block('r0c0').click();
    assert.match(await page.textContent('#inspector'), /Block A1/);
    assert.match(await page.textContent('#inspector'), /Player 4/);
    assert.match(await page.textContent('#inspector'), /Residential · Level 2 · Rowhouses/);
    assert.equal(await panel.isVisible(), false, 'non-owners get the inspector, not the build panel');
    assert.equal(await page.isDisabled('#action-build'), true);

    // Pave every remaining road; the game must end with all 36 blocks claimed.
    const remaining = await page.$$eval('#board .road:not(.is-built)', (els) => els.map((el) => el.dataset.road));
    for (const id of remaining) {
      await road(id).click();
      await dismissEvent(page);
    }
    await page.waitForSelector('#results-dialog[open]');
    assert.equal(await page.locator('#board .block--owned').count(), 36, 'all blocks claimed');
    assert.equal(await page.textContent('#hud-roads'), '84/84');
    assert.equal(await page.locator('#results-list li').count(), 4);
    assert.match(await banner(), /wins!/);
    await shot('10-results');

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
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
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

    await road('h-3-3').click(); // P1 → P2's turn: income, then upkeep → distress
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
    await road('h-3-4').click(); // P2 can pave again → P3's turn: deep debt
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
    await road('h-3-5').click(); // P3 → P4
    const panel = page.locator('#build-dialog');
    await page.locator('[data-block="r0c0"]').click();
    assert.match(await panel.textContent(), /Abandoned by Player 3/);
    await page.screenshot({ path: 'test-results/finance-acquire.png' });
    await panel.locator('[data-acquire="restore"]').click();
    assert.ok(await page.locator('[data-block="r0c0"]').evaluate((el) => el.classList.contains('block--green')), 'P4 owns the restored home');
    await page.locator('[data-block="r0c1"]').click();
    assert.equal(await panel.locator('[data-acquire="restore"]').count(), 0, 'empty ruin can only be rebuilt');
    await panel.locator('[data-acquire="rebuild"]').click();
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
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(`${base}?seed=12`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'New Game' }).click();
    await page.click('#setup-start');
    const road = (id) => page.locator(`#board [data-road="${id}"]`);
    for (const id of ['h-0-0', 'v-0-0', 'h-1-0', 'v-0-1']) await road(id).click(); // P4 claims A1
    await page.locator('[data-block="r0c0"]').click();
    await page.locator('#build-dialog [data-build="residential"]').click();
    await road('h-6-5').click(); // round wraps → event

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
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
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

// Art pipeline: WebP sheets load, 9-slice UI frames apply, board tiles render on a hi-DPI phone.
{
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, reducedMotion: 'reduce',
  });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', (r) => r.status() >= 400 && errors.push(`HTTP ${r.status()} ${r.url()}`));
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
    await page.locator('[data-road="h-0-0"]').click();
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

// Money animation (runs with motion enabled, desktop only).
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  const page = await context.newPage();
  try {
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'New Game' }).click();
    await page.click('#setup-start');
    for (const id of ['h-0-0', 'v-0-0', 'h-1-0']) await page.locator(`[data-road="${id}"]`).click();
    await page.locator('[data-road="v-0-1"]').click(); // P4 captures A1
    const p4 = page.locator('.player-card[data-seat="4"]');
    assert.equal(await p4.locator('.cash-delta').textContent(), '+$500', 'delta chip shown');
    assert.ok(await p4.locator('.stat--cash.is-up').count(), 'cash row pulses');
    const mid = await p4.locator('.stat--cash dd').textContent();
    assert.notEqual(mid, '$12,500', `cash should still be counting up (saw ${mid})`);
    await page.waitForFunction(() =>
      document.querySelector('.player-card[data-seat="4"] .stat--cash dd')?.textContent === '$12,500');
    await page.waitForTimeout(250);
    await page.screenshot({ path: 'test-results/money-animation.png' });
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
