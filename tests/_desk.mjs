import { chromium } from 'playwright';
import { startServer } from './serve.mjs';
const server = await startServer(0);
const base = `http://127.0.0.1:${server.address().port}/`;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const out = '/tmp/claude-0/-home-user-GRIDLOCK/9eacdf01-d230-56ef-9f91-0c89d575931d/scratchpad/desk/';
const sizes = (process.argv[2] ?? '1920x940,1536x730,1366x650,1280x600').split(',');
for (const size of sizes) {
  const [w, h] = size.split('x').map(Number);
  const ctx = await b.newContext({ viewport: { width: w, height: h } });
  await ctx.addInitScript(() => { sessionStorage.setItem('gridlock.session.v1', 'started'); if (!localStorage.getItem('x')) { localStorage.setItem('x', 1); localStorage.setItem('gridlock.tutorial.v1', '{"status":"done"}'); localStorage.setItem('gridlock.settings.v1', JSON.stringify({ confirmTaps: false, quickHandoff: false })); } });
  const p = await ctx.newPage();
  const notes = [];
  p.on('pageerror', (e) => notes.push('ERR ' + e.message));
  const shot = async (s) => {
    await p.waitForTimeout(450);
    const m = await p.evaluate(() => ({ sx: document.documentElement.scrollWidth - innerWidth, sy: document.documentElement.scrollHeight - innerHeight }));
    if (m.sx > 1 || m.sy > 1) notes.push(`${s}: scroll x${m.sx} y${m.sy}`);
    await p.screenshot({ path: `${out}${size}-${s}.png` });
  };
  await p.goto(`${base}?debug`); await p.waitForTimeout(900);
  await shot('01title');
  for (const nav of ['howto', 'settings', 'stats']) { await p.click(`[data-screen="title"] [data-nav="${nav}"]`); await shot(`02${nav}`); await p.click(`[data-screen="${nav}"] [data-nav="back"]`); }
  await p.click('[data-setup-preset="friends"]'); await shot('03setup');
  await p.fill('#setup-seed', '4242'); await p.click('#setup-start'); await p.waitForTimeout(500);
  if (await p.locator('#handoff-dialog[open]').count()) { await shot('04handoff'); await p.click('#handoff-ready'); }
  await shot('05game');
  // Stage: own + build.
  await p.evaluate(() => { const g = window.__GRIDLOCK__.getGame(); for (const id of ['h-0-0', 'v-0-0', 'v-0-1']) g.board.roads[id] = 2; });
  await p.click('#board [data-road="h-1-0"]'); await p.waitForTimeout(600);
  await shot('06capture');
  const dev = p.locator('#capture-choice-dialog [data-capture-choice="develop"]');
  if (await dev.count()) { await dev.click(); await shot('07build'); await p.click('#build-dialog [data-build-type="residential"], #build-dialog .build-option >> nth=0').catch(() => {}); await shot('08built'); }
  for (let i = 0; i < 3 && await p.locator('dialog[open]').count(); i++) await p.keyboard.press('Escape');
  await p.click('#game-menu-btn'); await shot('09pause'); await p.keyboard.press('Escape');
  // results
  await p.evaluate(async () => {
    const { allRoadIds } = await import('./js/core/board.js');
    const g = window.__GRIDLOCK__.getGame(); g.eventPool = [];
    if (g.turnPhase !== 'pave-road') { const { startPaving, resolveCapture } = await import('./js/core/game.js'); while (g.pendingCaptures.length) resolveCapture(g, g.pendingCaptures[0]); startPaving(g); }
    const ids = allRoadIds(g.board).filter((id) => g.board.roads[id] == null);
    ids.slice(0, -1).forEach((id) => { g.board.roads[id] = 1; });
    for (const bl of g.board.blocks) if (bl.ownerSeat == null) { bl.ownerSeat = 1 + (bl.row + bl.col) % 4; }
    window.__last = ids.at(-1);
  });
  const last = await p.evaluate(() => window.__last);
  await p.evaluate((id) => document.querySelector(`#board [data-road="${id}"]`).click(), last);
  await p.waitForTimeout(2500);
  await shot('10results');
  console.log(size, notes.join(' | ') || 'ok');
  await ctx.close();
}
await b.close(); server.close();
