import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { SHEETS, getSpriteRect, parseSpriteRef, sheetSlug, GENERATED_DIR } from '../../js/assets.js';
import { ART, allArtRefs, progressionProps } from '../../js/art.js';
import { CATEGORY_ORDER, levelArt } from '../../js/core/buildings.js';
import { SHEET_FILES, UI_CUTS, slug } from '../../tools/build-assets.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const exists = (p) => access(ROOT + p).then(() => true, () => false);

/** Original art as committed. These files must never be modified. */
const ORIGINALS = {
  'UI buttons_panels.png': '3c90d72f1e5fa0ac6d082e508677c477db5b6081ffedd79164f7864b927548d4',
  'UI icons.png': 'c9bc1a22a96755c738400997e519a79f336191e9dc0ed79360c07e1c0242455c',
  'civic-buildings.png': '0510f770281ce75414b62482e9cbe5b538e2caefdcb34fff2ce2da4b4a2f9feb',
  'effects.png': '0f422bbbb48ae90952dde1a43369f296c05c8fd329103618dd0014117924b904',
  'ownership markers.png': '426bbaeafb0c49718da5975fb82dbf3b4c11f01116715c626d9bc22d1f648691',
  'parks_open spaces.png': '556cb24a9d57112e57a2dcfa1c9ab1c02af6d897131dc2a22db0566efaf1f1f3',
  'props_decor.png': '65b4721a6af71d0b02659d1a026c9e65714b8ce2a9c444cccbaa8128ea684c01',
  'residential_commercial buildings.png': 'b284b8aa3da15ab4279fd332a3b3c6e14c9ea1db446f598db371336148a4dfcd',
  'roads_infrastructure.png': '0e6f953a16542f60a3ecf884bee69b6a6a318fa5370aaeae40ab2c05396e0320',
  'title_menu decor.png': '08e28478605fd0ee9b41ae7ab3582ec0dddd8438ec76b0e99024dbb3502e1556',
};

test('original sprite sheets are untouched', async () => {
  for (const [file, sha] of Object.entries(ORIGINALS)) {
    const got = createHash('sha256').update(await readFile(ROOT + file)).digest('hex');
    assert.equal(got, sha, `${file} was modified`);
  }
});

test('all ten sheets are registered, and every one is used', () => {
  const files = Object.values(SHEETS).map((s) => s.file).sort();
  assert.deepEqual(files, Object.keys(ORIGINALS).sort());
  assert.deepEqual([...SHEET_FILES].sort(), files);
  for (const [key, s] of Object.entries(SHEETS)) assert.ok(Object.keys(s.sprites).length > 0, `${key} has sprites`);
});

test('generated assets exist for every sheet and UI frame', async () => {
  for (const s of Object.values(SHEETS)) {
    assert.equal(sheetSlug(s.file), slug(s.file), 'runtime and build tool agree on names');
    assert.ok(await exists(s.webp), `${s.webp}`);
    assert.ok(await exists(decodeURI(s.url)), `${s.url}`);
    assert.ok(s.webp.startsWith(GENERATED_DIR));
  }
  assert.ok(SHEETS.props.url.startsWith(GENERATED_DIR), 'props uses the keyed-out copy');
  for (const name of Object.keys(UI_CUTS)) assert.ok(await exists(`${GENERATED_DIR}/ui/${name}.png`), name);
  const css = await readFile(`${ROOT}css/art.css`, 'utf8');
  for (const m of css.matchAll(/url\('\.\.\/([^']+)'\)/g)) assert.ok(await exists(m[1]), `css references ${m[1]}`);
});

test('the repository root is a self-contained GitHub Pages site', async () => {
  assert.ok(await exists('index.html'), 'root index.html exists');
  assert.ok(await exists('.nojekyll'), '.nojekyll exists');

  const html = await readFile(`${ROOT}index.html`, 'utf8');
  const localUrls = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
    .map(([, url]) => url)
    .filter((url) => !/^(?:https?:|data:|#)/.test(url));
  assert.ok(localUrls.length > 0, 'index contains local assets');
  for (const url of localUrls) {
    assert.ok(!url.startsWith('/'), `${url} must be relative for a Pages project subpath`);
    assert.ok(await exists(decodeURI(url.split(/[?#]/, 1)[0])), `${url} resolves from the repository root`);
  }
});

test('every semantic art role resolves to a real sprite', () => {
  const refs = allArtRefs();
  assert.ok(refs.length > 30);
  for (const ref of refs) {
    const [sheet, name] = parseSpriteRef(ref);
    assert.ok(getSpriteRect(sheet, name), `ART → ${ref}`);
  }
  for (const seat of [1, 2, 3, 4]) assert.match(ART.owner.flag(seat), /^markers:flag-(red|blue|yellow|green)$/);
});

test('visual progression adds props with level; buildings exist for every level', () => {
  for (const type of CATEGORY_ORDER) {
    assert.deepEqual(progressionProps(type, 1), []);
    assert.equal(progressionProps(type, 2).length, 1);
    assert.equal(progressionProps(type, 3).length, 2);
    for (let lv = 1; lv <= 3; lv++) assert.ok(levelArt(type, lv));
  }
  assert.deepEqual(progressionProps('vacant', 3), []);
});
