import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { createReplayer, REPLAY_CLASS } from '../../js/ui/replay.js';

/** Just enough of an element: a class list. */
const element = (...classes) => {
  const set = new Set(classes);
  return {
    classList: {
      contains: (c) => set.has(c),
      add: (c) => set.add(c),
      toggle: (c) => (set.has(c) ? (set.delete(c), false) : (set.add(c), true)),
    },
    get classes() { return [...set].sort(); },
  };
};

/** Animation frames run by hand, and a page that can be hidden. */
function fakeBrowser() {
  const frames = [];
  const page = { hidden: false };
  return {
    page,
    replay: createReplayer({ requestFrame: (fn) => frames.push(fn), isHidden: () => page.hidden }),
    frame() { for (const fn of frames.splice(0)) fn(); },
    get pendingFrames() { return frames.length; },
  };
}

test('the first play adds the class; each later one switches to the other animation name', () => {
  const b = fakeBrowser();
  const el = element('chain-meter');
  b.replay(el, 'is-bumped');
  assert.deepEqual(el.classes, ['chain-meter', 'is-bumped'], 'the animation starts as the class appears');
  b.frame();
  b.replay(el, 'is-bumped');
  assert.deepEqual(el.classes, ['chain-meter', 'is-bumped', REPLAY_CLASS], 'a new animation-name: a fresh start');
  b.frame();
  b.replay(el, 'is-bumped');
  assert.deepEqual(el.classes, ['chain-meter', 'is-bumped'], 'and back: another fresh start');
  b.replay(null, 'is-bumped'); // a road that is no longer on the board
});

test('several plays before one frame restart once (a second switch would undo the first)', () => {
  const b = fakeBrowser();
  const frame = element('board-frame', 'is-capture');
  const meter = element('chain-meter', 'is-bumped');
  b.replay(frame, 'is-capture'); // a capture…
  b.replay(meter, 'is-bumped');
  b.replay(frame, 'is-capture'); // …that also opens the City era, in the same step
  assert.ok(frame.classList.contains(REPLAY_CLASS), 'still switched: the restart happens');
  assert.ok(meter.classList.contains(REPLAY_CLASS), 'other elements restart independently');
  assert.equal(b.pendingFrames, 1, 'one frame callback, however many elements');
  b.frame();
  b.replay(frame, 'is-capture');
  assert.ok(!frame.classList.contains(REPLAY_CLASS), 'the next frame restarts again');
});

test('a first play and a replay in the same frame still leave the animation playing', () => {
  const b = fakeBrowser();
  const road = element('road');
  b.replay(road, 'is-rejected');
  b.replay(road, 'is-rejected'); // tapped twice before the frame
  assert.deepEqual(road.classes, ['is-rejected', 'road']);
});

test('nothing restarts in a hidden page (it would only play late, on return)', () => {
  const b = fakeBrowser();
  const meter = element('chain-meter', 'is-bumped');
  b.page.hidden = true;
  b.replay(meter, 'is-bumped');
  assert.deepEqual(meter.classes, ['chain-meter', 'is-bumped']);
  const summary = element('economy-summary');
  b.replay(summary, 'is-showing');
  assert.ok(summary.classList.contains('is-showing'), 'a first play still sets the class: it is state, not motion');
  b.page.hidden = false;
  b.replay(meter, 'is-bumped');
  assert.ok(meter.classList.contains(REPLAY_CLASS));
});

const css = readdirSync('css').filter((f) => f.endsWith('.css')).map((f) => readFileSync(`css/${f}`, 'utf8')).join('\n');
const uiFiles = readdirSync('js/ui').filter((f) => f.endsWith('.js')).map((f) => [f, readFileSync(`js/ui/${f}`, 'utf8')]);
const keyframes = (name) => css.match(new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1];

test('every replayed animation has its replay twin in the CSS, with identical keyframes', () => {
  const replayed = uiFiles.flatMap(([, src]) => [...src.matchAll(/replayAnimation\([^,]+, '([\w-]+)'\)/g)].map((m) => m[1]));
  assert.deepEqual([...new Set(replayed)].sort(), ['is-bumped', 'is-capture', 'is-rejected', 'is-showing']);
  for (const cls of new Set(replayed)) {
    const rule = css.match(new RegExp(`(\\.[\\w-]+)\\.${cls} \\{ animation: ([\\w-]+) `));
    assert.ok(rule, `${cls}: an animation rule`);
    const [, owner, name] = rule;
    assert.match(css, new RegExp(`\\${owner}\\.${cls}:where\\(\\.${REPLAY_CLASS}\\) \\{ animation-name: ${name}-replay; \\}`),
      `${cls}: a replay rule with the same specificity`);
    assert.ok(keyframes(name), `${name}: keyframes`);
    assert.equal(keyframes(`${name}-replay`), keyframes(name), `${name}-replay: the same keyframes`);
  }
});

test('no UI code restarts animations by forcing a layout (void el.offsetWidth)', () => {
  for (const [file, src] of uiFiles) {
    assert.doesNotMatch(src, /void [\w.$()'"#-]+\.(offsetWidth|offsetHeight|clientWidth|scrollHeight|getBoundingClientRect)/, file);
  }
});
