/**
 * First-game tutorial coach marks: one taped sticky note at a time, next to the
 * control it explains. Non-modal and never focus-stealing, so play continues
 * underneath; each note has "Got it" and "Skip tutorial", and state tips clear
 * themselves once the player acts. Rules and persistence: core/tutorial.js.
 */
import { $, h } from './dom.js';
import { toast } from './toast.js';
import { bus } from '../core/bus.js';
import { PHASES } from '../core/game.js';
import {
  TUTORIAL_STEPS, loadTutorial, saveTutorial, onNewGame, markSeen, skipTutorial, replayTutorial,
  tipForGame, almostCompleteBlock, isRunning, stepsFor,
} from '../core/tutorial.js';

let state = loadTutorial();
let current = null; // { id, el, moment }
let getGame = () => null;

const visible = (el) => (el && !el.hidden && el.getClientRects().length ? el : null);

/** Where each tip points. A target inside an open dialog puts the note at the top of that dialog. */
const TARGETS = {
  manage: () => visible($('#action-pave')) ?? $('#turn-prompt'),
  pave: () => $('#turn-prompt'),
  complete: (game) => {
    const block = almostCompleteBlock(game);
    return block ? document.querySelector(`#board [data-block="${block.id}"]`) : null;
  },
  develop: () => $('#capture-choice-dialog'),
  bonus: () => $('#turn-prompt'),
  income: () => visible($('#economy-summary')) ?? document.querySelector('.player-card.is-active'),
  events: () => $('#event-dialog'),
  cpu: () => visible($('#cpu-status')),
  scoring: (game) => (game?.phase === PHASES.ENDED ? $('#results-dialog') : document.querySelector('.round-badge')),
};

function persist(next) {
  const wasDone = state.status === 'done';
  state = next;
  saveTutorial(state);
  if (!wasDone && state.status === 'done') toast('Tutorial complete. Good luck, Mayor!', { tone: 'success' });
}

/** Keeps a floating note beside its target, inside the viewport, with its arrow on the target. */
function place(el, target) {
  const r = target.getBoundingClientRect();
  const w = el.offsetWidth;
  const ht = el.offsetHeight;
  const gap = 14;
  const above = r.top - ht - gap >= 8;
  const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
  const top = above ? r.top - ht - gap : Math.min(r.bottom + gap, window.innerHeight - ht - 8);
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(Math.max(8, top))}px`;
  el.dataset.side = above ? 'above' : 'below';
  el.style.setProperty('--arrow-x', `${Math.round(Math.min(Math.max(18, r.left + r.width / 2 - left), w - 18))}px`);
}

function hide(seen) {
  if (!current) return;
  const { id, el } = current;
  current = null;
  const dialog = el.parentElement?.closest('dialog[open]');
  el.remove();
  if (dialog) dialog.scrollTop = 0; // the note sat above the dialog's heading
  if (seen) persist(markSeen(state, id, stepsFor(getGame())));
}

function show(id, { moment = false } = {}) {
  const game = getGame();
  const target = TARGETS[id]?.(game);
  if (!target) return false;
  hide(false);
  const step = TUTORIAL_STEPS.find((s) => s.id === id);
  const steps = stepsFor(game); // numbered among the tips that apply at this table
  const el = h('aside', { class: 'coach-mark sticky-note', 'aria-label': 'Tutorial tip', dataset: { step: id } },
    h('p', { class: 'coach-mark__count' }, `Tip ${steps.indexOf(id) + 1} of ${steps.length}`),
    h('p', { class: 'coach-mark__body', role: 'status' },
      h('strong', { class: 'coach-mark__title' }, step.title), ' ', step.text),
    h('div', { class: 'coach-mark__actions' },
      h('button', { type: 'button', class: 'btn btn--sm btn--gold', dataset: { coach: 'next' } }, 'Got it'),
      h('button', { type: 'button', class: 'btn btn--sm', dataset: { coach: 'skip' } }, 'Skip tutorial')));
  const dialog = target.tagName === 'DIALOG' ? target : target.closest('dialog');
  if (dialog?.open) {
    el.classList.add('coach-mark--inline');
    dialog.prepend(el);
    dialog.addEventListener('close', () => { if (current?.el === el) hide(true); }, { once: true });
  } else {
    document.body.append(el);
    place(el, target);
  }
  current = { id, el, moment, target };
  return true;
}

/** Re-evaluates state tips after the game re-renders. */
export function updateTutorial() {
  const game = getGame();
  if (!isRunning(state) || !game) return hide(false);
  if (current?.moment) return undefined;
  const id = tipForGame(state, game);
  if (current && current.id !== id) hide(true); // its moment has passed
  if (!current && id) show(id);
  else if (current && !current.el.classList.contains('coach-mark--inline')) {
    const target = TARGETS[current.id]?.(game);
    if (target) place(current.el, target);
  }
  return undefined;
}

/** A tip tied to a moment (capture choice, first income, first event, results). */
export function tutorialMoment(id) {
  // One note at a time: a tip already open for another moment wins (this one recurs later).
  if (!isRunning(state) || state.seen.includes(id) || current?.moment) return;
  show(id, { moment: true });
}

/** A road was paved: a floating tip has done its job (tips inside dialogs go when the dialog closes). */
export function tutorialMove() {
  if (current && !current.el.classList.contains('coach-mark--inline')) hide(true);
}

/** Starts the tutorial on the player's first New Game. */
export function tutorialNewGame() {
  hide(false);
  persist(onNewGame(state));
}

export const tutorialState = () => ({ ...state, showing: current?.id ?? null });

export function initTutorial({ getGame: gameGetter }) {
  getGame = gameGetter;
  document.addEventListener('click', (e) => {
    const action = e.target.closest('[data-coach]')?.dataset.coach;
    if (!action || !current) return;
    if (action === 'next') {
      hide(true);
      updateTutorial();
    } else {
      hide(false);
      persist(skipTutorial(state));
      toast('Tutorial skipped. Replay it any time from How To Play or Settings.');
    }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-replay-tutorial]')) return;
    hide(false);
    persist(replayTutorial());
    const playing = getGame()?.phase === PHASES.PLAYING;
    toast(playing ? 'Tutorial restarted: tips will appear as you play.' : 'Tutorial on: tips will appear in your next game.', { tone: 'success' });
  });
  window.addEventListener('resize', () => updateTutorial());
  bus.on('screen:shown', ({ name }) => (name === 'game' ? updateTutorial() : hide(false)));
}
