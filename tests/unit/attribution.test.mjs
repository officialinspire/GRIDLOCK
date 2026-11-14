import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAttribution } from '../../js/attribution.js';
const id = '11111111-1111-4111-8111-111111111111';
function browser(href, storage = new Map()) {
  const win = { location: { href }, navigator: {}, history: { state: null, replaceState(_s, _t, url) { win.location.href = url; } }, sessionStorage: { getItem: k => storage.get(k), setItem: (k,v) => storage.set(k,v) } };
  return win;
}
test('connects a launch, retains campaign on reload, removes only handoff fragment', () => {
  const store = new Map();
  const win = browser(`https://example.test/GRIDLOCK/?utm_source=newsletter&utm_campaign=november#inspire_launch_id=${id}&inspire_launch_at=${Date.now()}&inspire_cta=hero&tab=rules`, store);
  const get = createAttribution(win);
  assert.deepEqual(get(), { attribution_version: 'v2', launch_id: id, cta_location: 'hero', utm_source: 'newsletter', utm_campaign: 'november' });
  assert.equal(new URL(win.location.href).hash, '#tab=rules');
  assert.equal(get().launch_id, id);
  assert.equal(createAttribution(browser('https://example.test/GRIDLOCK/', store))().launch_id, id);
  assert.equal(createAttribution(browser('https://example.test/OTHER/', store))().launch_id, undefined);
});
test('ignores stale, forged, unsafe and unknown attribution fields', () => {
  const win = browser(`https://example.test/GRIDLOCK/?utm_source=person%40example.com&email=private#inspire_launch_id=${id}&inspire_launch_at=${Date.now()-1800001}`);
  assert.deepEqual(createAttribution(win)(), { attribution_version: 'v2' });
});
test('blocked storage and history cannot affect gameplay', () => {
  const win = browser(`https://example.test/GRIDLOCK/#inspire_launch_id=${id}&inspire_launch_at=${Date.now()}`);
  win.sessionStorage.getItem = win.sessionStorage.setItem = win.history.replaceState = () => { throw Error('blocked'); };
  assert.equal(createAttribution(win)().launch_id, id);
});
test('privacy signals prevent reading or writing attribution', () => {
  const win = browser('https://example.test/GRIDLOCK/');
  win.navigator.globalPrivacyControl = true;
  Object.defineProperty(win, 'sessionStorage', { get() { throw Error('must not access'); } });
  assert.deepEqual(createAttribution(win)(), {});
});
test('expires a launch even when a game stays open', () => {
  const original = Date.now;
  let now = original(); Date.now = () => now;
  try {
    const get = createAttribution(browser(`https://example.test/GRIDLOCK/#inspire_launch_id=${id}&inspire_launch_at=${now}`));
    assert.equal(get().launch_id, id);
    now += 1800001;
    assert.equal(get().launch_id, undefined);
  } finally { Date.now = original; }
});
