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
    assert.equal(await page.locator('.howto-card').count(), 6);
    await noHorizontalScroll(page, 'howto');
    await shot('2-howto');
    await page.locator('[data-screen="howto"] [data-nav="back"]').click();
    assert.ok(await page.isVisible('[data-screen="title"]'), 'back to title');

    // Settings (persist across reload)
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.selectOption('select[name="startingCash"]', '2000');
    await page.locator('label.setting-row', { hasText: 'Show block coordinates' }).click();
    await noHorizontalScroll(page, 'settings');
    await shot('3-settings');
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Settings' }).click();
    assert.equal(await page.inputValue('select[name="startingCash"]'), '2000', 'cash persisted');
    assert.equal(await page.isChecked('input[name="showCoords"]'), true, 'coords persisted');
    await page.locator('[data-screen="settings"] [data-nav="back"]').click();

    // Setup
    await page.getByRole('button', { name: 'New Game' }).click();
    assert.equal(await page.locator('.seat-card').count(), 4);
    assert.match(await page.textContent('#setup-summary'), /4 players · \$2,000 each/);
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
    assert.ok((await page.textContent('#hud-left')).includes('$2,000'), 'cash shown');
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

    // P4's bonus road closes nothing → round wraps to P1 and income is paid.
    await road('h-6-5').click();
    assert.match(await banner(), /Ada's turn/);
    assert.equal(await page.textContent('#hud-round'), '2', 'round advanced');
    assert.ok((await page.textContent('#hud-left')).includes('$2,050'), 'P4 paid income for A1');

    // Inspect a block
    await block('r0c0').click();
    assert.match(await page.textContent('#inspector'), /Block A1/);
    assert.match(await page.textContent('#inspector'), /Player 4/);

    // Pave every remaining road; the game must end with all 36 blocks claimed.
    const remaining = await page.$$eval('#board .road:not(.is-built)', (els) => els.map((el) => el.dataset.road));
    for (const id of remaining) await road(id).click();
    await page.waitForSelector('#results-dialog[open]');
    assert.equal(await page.locator('#board .block--owned').count(), 36, 'all blocks claimed');
    assert.equal(await page.textContent('#hud-roads'), '84/84');
    assert.equal(await page.locator('#results-list li').count(), 4);
    assert.match(await banner(), /wins!/);
    await shot('7-results');

    // Rematch starts a clean board.
    await page.getByRole('button', { name: 'Play Again' }).click();
    assert.equal(await page.textContent('#hud-roads'), '0/84', 'rematch reset');
    assert.equal(await page.locator('#board .block--owned').count(), 0);
    assert.match(await banner(), /Ada's turn/);

    // Pause → quit
    await page.click('#game-menu-btn');
    assert.ok(await page.isVisible('#pause-dialog'));
    await shot('8-pause');
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

await browser.close();
server.close();
if (failures) {
  console.error(`\n${failures} viewport(s) failed`);
  process.exit(1);
}
console.log('\nAll smoke tests passed.');
