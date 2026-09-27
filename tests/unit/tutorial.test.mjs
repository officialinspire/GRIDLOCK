import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TUTORIAL_KEY, TUTORIAL_STEPS, STEP_IDS, normalizeTutorial, loadTutorial, saveTutorial, isRunning, onNewGame,
  markSeen, skipTutorial, replayTutorial, tipForGame, almostCompleteBlock,
} from '../../js/core/tutorial.js';
import { createGame, placeRoad, resolveCapture, startPaving, PHASES, TURN_PHASES } from '../../js/core/game.js';
import { allRoadIds } from '../../js/core/board.js';

const memoryStorage = (initial = {}) => {
  const map = new Map(Object.entries(initial));
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), map };
};
const newGame = () => createGame({ seats: [1, 2, 3, 4].map((seat) => ({ seat })), seed: 7, eventPool: [] });

test('the eight tips cover the first game, in teaching order', () => {
  assert.deepEqual(STEP_IDS, ['manage', 'pave', 'complete', 'develop', 'bonus', 'income', 'events', 'scoring']);
  for (const step of TUTORIAL_STEPS) assert.ok(step.title && step.text.length > 20 && step.text.length < 200, step.id);
});

test('starts only on the first New Game', () => {
  let s = normalizeTutorial(null);
  assert.equal(s.status, 'new');
  assert.equal(isRunning(s), false, 'no tips before a New Game (e.g. continuing an old save)');
  s = onNewGame(s);
  assert.equal(s.status, 'active');
  assert.equal(isRunning(s), true);
  assert.deepEqual(onNewGame(skipTutorial(s)).status, 'skipped', 'a later New Game never restarts a skipped tutorial');
  assert.deepEqual(onNewGame({ status: 'done', seen: STEP_IDS }).status, 'done');
});

test('completion: seeing every tip finishes the tutorial', () => {
  let s = onNewGame(normalizeTutorial(null));
  for (const id of STEP_IDS.slice(0, -1)) {
    s = markSeen(s, id);
    assert.equal(s.status, 'active');
  }
  assert.equal(markSeen(s, 'manage'), s, 'seeing a tip twice changes nothing');
  assert.equal(markSeen(s, 'bogus'), s);
  s = markSeen(s, 'scoring');
  assert.equal(s.status, 'done');
  assert.deepEqual(s.seen, STEP_IDS, 'kept in teaching order');
  assert.equal(isRunning(s), false);
});

test('skip and replay', () => {
  const skipped = skipTutorial(markSeen(onNewGame(normalizeTutorial(null)), 'manage'));
  assert.equal(skipped.status, 'skipped');
  assert.equal(isRunning(skipped), false);
  const again = replayTutorial();
  assert.deepEqual(again, { status: 'active', seen: [] }, 'replay starts over, including the current game');
});

test('persistence: skip and completion survive reloads; bad or missing storage is safe', () => {
  const storage = memoryStorage();
  assert.equal(loadTutorial(storage).status, 'new');
  assert.equal(saveTutorial(skipTutorial(onNewGame(loadTutorial(storage))), storage), true);
  assert.equal(loadTutorial(storage).status, 'skipped', 'skip persisted');

  let s = onNewGame(normalizeTutorial(null));
  for (const id of STEP_IDS) s = markSeen(s, id);
  saveTutorial(s, storage);
  assert.deepEqual(loadTutorial(storage), { status: 'done', seen: STEP_IDS }, 'completion persisted');
  assert.equal(JSON.parse(storage.map.get(TUTORIAL_KEY)).status, 'done');

  saveTutorial(replayTutorial(), storage);
  assert.equal(loadTutorial(storage).status, 'active', 'replay persisted');

  assert.equal(loadTutorial(memoryStorage({ [TUTORIAL_KEY]: '{not json' })).status, 'new');
  assert.deepEqual(normalizeTutorial({ status: 'bogus', seen: ['pave', 'nope', 'manage'] }), { status: 'new', seen: ['manage', 'pave'] });
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(loadTutorial(broken).status, 'new');
  assert.equal(saveTutorial(replayTutorial(), broken), false);
});

test('state tips follow the game: manage → pave → complete → bonus → scoring', () => {
  const game = newGame();
  let s = onNewGame(normalizeTutorial(null));
  assert.equal(tipForGame(normalizeTutorial(null), game), null, 'nothing while not running');
  assert.equal(tipForGame(s, game), 'manage');
  s = markSeen(s, 'manage');
  assert.equal(tipForGame(s, game), 'pave', 'paving is explained during Manage City too');
  startPaving(game);
  assert.equal(tipForGame(s, game), 'pave');
  s = markSeen(s, 'pave');
  assert.equal(tipForGame(s, game), null, 'no block is close to complete yet');

  // Three sides of A1 (P1–P3), then P4 closes it.
  for (const id of ['h-0-0', 'v-0-0', 'h-1-0']) assert.ok(placeRoad(game, id).ok);
  assert.equal(almostCompleteBlock(game).id, 'r0c0');
  assert.equal(tipForGame(s, game), 'complete');
  s = markSeen(s, 'complete');
  assert.ok(placeRoad(game, 'v-0-1').captured.length);
  assert.equal(game.turnPhase, TURN_PHASES.CAPTURE_DEVELOP);
  assert.equal(tipForGame(s, game), null, 'the capture choice is a moment tip (raised by the view)');
  resolveCapture(game);
  assert.equal(tipForGame(s, game), 'bonus');
  s = markSeen(s, 'bonus');

  // Scoring is explained once half the city's roads are paved.
  const ids = allRoadIds(game.board).filter((id) => game.board.roads[id] == null);
  for (const id of ids.slice(0, 38)) game.board.roads[id] = 1;
  game.turnPhase = TURN_PHASES.MANAGE_CITY;
  assert.equal(tipForGame(s, game), 'scoring');
  game.phase = PHASES.ENDED;
  assert.equal(tipForGame(s, game), null, 'at the end the results screen raises it');
});
