import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { DEFAULT_SETTINGS } from '../../js/config.js';
import { normalizeSettings, loadSettings, saveSettings, BOOLEAN_SETTINGS } from '../../js/core/settings.js';

const PREFIX = "html[data-effects='reduced'] ";
/** Splits on spaces outside parentheses: '0 calc(2px + 1px) 0 rgb(0, 0, 0)' → ['0', 'calc(2px + 1px)', '0', 'rgb(0, 0, 0)']. */
const topLevel = (str) => {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of str.trim()) {
    if (ch === ' ' && depth === 0) { if (cur) out.push(cur); cur = ''; continue; }
    depth += ch === '(' ? 1 : ch === ')' ? -1 : 0;
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
};
/** The arguments of every name(…) call in `str`, nested parentheses included. */
const calls = (str, name) => {
  const out = [];
  for (let i = str.indexOf(`${name}(`); i !== -1; i = str.indexOf(`${name}(`, i + 1)) {
    let depth = 0;
    for (let j = i + name.length; j < str.length; j++) {
      depth += str[j] === '(' ? 1 : str[j] === ')' ? -1 : 0;
      if (depth === 0) { out.push(str.slice(i + name.length + 1, j)); break; }
    }
  }
  return out;
};
const css = readFileSync('css/effects.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
/** Every rule of css/effects.css: { selectors: [...], props: { name: value } }. */
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => ({
  selectors: sel.split(',').map((s) => s.trim().replace(/\s+/g, ' ')),
  props: Object.fromEntries(body.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
    const i = d.indexOf(':');
    return [d.slice(0, i).trim(), d.slice(i + 1).trim()];
  })),
}));

test('Reduce effects is a saved setting, off by default (older saves stay off)', () => {
  assert.equal(DEFAULT_SETTINGS.reducedEffects, false);
  assert.ok(BOOLEAN_SETTINGS.includes('reducedEffects'));
  assert.equal(normalizeSettings({ sound: true }).reducedEffects, false, 'a save from before the setting');
  assert.equal(normalizeSettings({ reducedEffects: 'yes' }).reducedEffects, false, 'only a real boolean counts');
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  saveSettings({ ...DEFAULT_SETTINGS, reducedEffects: true }, storage);
  assert.equal(loadSettings(storage).reducedEffects, true);
  assert.equal(loadSettings(storage).reducedMotion, false, 'independent of Reduce motion');
});

test('only the setting turns it on: never screen size or anything else', () => {
  const writers = readdirSync('js', { recursive: true }).filter((f) => f.endsWith('.js'))
    .flatMap((f) => [...readFileSync(`js/${f}`, 'utf8').matchAll(/dataset\.effects\s*=\s*([^;\n]+)/g)].map((m) => [f, m[1].trim()]));
  assert.deepEqual(writers, [['ui/settingsView.js', "s.reducedEffects ? 'reduced' : 'full'"]]);
  assert.doesNotMatch(css, /@media|@container|@supports/, 'no size- or device-based switching in the stylesheet');
});

test('the switch is in Settings › Display, and the stylesheet loads after every other one', () => {
  const html = readFileSync('index.html', 'utf8');
  assert.match(html, /<legend>Display<\/legend>[\s\S]*?name="reducedEffects"[\s\S]*?<\/fieldset>/);
  const sheets = [...html.matchAll(/<link rel="stylesheet" href="(css\/[^"]+)"/g)].map((m) => m[1]);
  assert.equal(sheets.at(-1), 'css/effects.css');
});

test('every rule applies only with Reduce effects on, and changes presentation only', () => {
  assert.ok(rules.length > 20);
  const presentation = new Set(['filter', 'animation', 'box-shadow', 'mix-blend-mode', 'backdrop-filter', 'background',
    'will-change', 'display', 'opacity', 'left']);
  for (const { selectors, props } of rules) {
    for (const s of selectors) assert.ok(s.startsWith(PREFIX), `scoped to the setting: ${s}`);
    for (const p of Object.keys(props)) assert.ok(presentation.has(p), `${selectors[0]}: "${p}" is not a presentation-only property`);
  }
});

test('it hides nothing but decoration: buildings, ownership, roads, capture feedback and event markers stay', () => {
  const hidden = rules.filter(({ props }) => props.display === 'none' || props.visibility === 'hidden' || /^0(\.0*)?$/.test(props.opacity ?? ''))
    .flatMap(({ selectors }) => selectors.map((s) => s.slice(PREFIX.length)));
  assert.deepEqual(hidden.sort(), [
    '.block__event-vfx:not(.block__event-vfx--main)', // extra event cut-outs: the lead event's one stays
    '.block__fx--build', // the build burst: the building still unfolds
    '.tabletop::after', // the tabletop grain
  ]);
  // Opacity is only ever lowered on the CPU "thinking" dots, never to nothing.
  for (const { selectors, props } of rules) {
    if ('opacity' in props) assert.deepEqual([selectors, Number(props.opacity) >= 0.5], [[`${PREFIX}.cpu-status__dots span`], true]);
  }
  // Capture feedback is never touched (its pop, burst, frame flash and chain meter).
  for (const essential of ['is-captured', 'block__fx--capture', 'is-capture', 'chain-meter', 'economy-summary', 'cash-delta']) {
    assert.ok(!rules.some(({ selectors }) => selectors.some((s) => s.includes(essential))), `${essential} untouched`);
  }
});

test('blurred and stacked shadows become one sharp shadow at most, and nothing loops', () => {
  for (const { selectors, props } of rules) {
    if (props.filter) {
      const shadows = calls(props.filter, 'drop-shadow');
      assert.ok(shadows.length <= 1, `${selectors[0]}: at most one shadow`);
      for (const sh of shadows) {
        // drop-shadow(<x> <y> [<blur>] [<color>]): the lengths come first; a third one is the blur.
        const lengths = topLevel(sh).filter((t) => /^(-?[\d.]+(px)?|calc\(.*\))$/.test(t));
        assert.ok(lengths.length === 2 || (lengths.length === 3 && /^0(px)?$/.test(lengths[2])), `${selectors[0]}: no blur (${sh})`);
      }
    }
    if (props['backdrop-filter']) assert.equal(props['backdrop-filter'], 'none');
    if (props['mix-blend-mode']) assert.equal(props['mix-blend-mode'], 'normal');
    if (props.animation) assert.equal(props.animation, 'none', `${selectors[0]}: animations are only ever stopped`);
  }
});
