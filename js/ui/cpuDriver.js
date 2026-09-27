/**
 * Runs CPU seats inside the real turn loop. The driver only schedules: each step is one
 * decision from core/cpu (a road, a build, a sale…) played by the game view through the same
 * handlers a person's click uses, so every move goes through the public core actions.
 *
 * - One step at a time, after a short "thinking" pause (CPU.THINK_MS by the cpuSpeed setting;
 *   Faster switches to fast, Skip plays the rest of the CPU turns at once).
 * - Nothing happens while anything else needs the table: an open dialog (pause, event card,
 *   handoff, an auction people are bidding in…), another screen, or no game.
 * - Every scheduled step is tied to the exact game state it was planned for. If anything has
 *   changed when it fires (a reload, a new game, a move by someone else) it is dropped and
 *   re-planned, so a step can never run twice. The game autosaves after every step, so a
 *   reload mid-turn resumes from the last completed step.
 * - Ended games, leaving for the title screen and new games stop all timers.
 */
import { $ } from './dom.js';
import { CPU } from '../config.js';
import { PHASES, currentPlayer, roadsBuilt } from '../core/game.js';
import { isCpu } from '../core/seats.js';

let hooks = null;
let timer = null;
let plannedFor = null;
let skipping = false;

/** A fingerprint of everything a step could change: if it differs, the plan is stale. */
function stateKey(game) {
  return [game.log.length, game.ledger.length, game.turnPhase, game.turnIndex, game.round,
    roadsBuilt(game), game.pendingCaptures.join(','), currentPlayer(game).cash].join('|');
}

function cancel() {
  if (timer) clearTimeout(timer);
  timer = null;
  plannedFor = null;
}

function showStatus(player) {
  const bar = $('#cpu-status');
  if (!player) {
    bar.hidden = true;
    return;
  }
  $('#cpu-status-name').textContent = player.name;
  $('#cpu-faster').setAttribute('aria-pressed', String(hooks.getSettings().cpuSpeed === 'fast'));
  bar.hidden = false;
}

/** True while it's a CPU seat's turn in a game in progress. */
export function isCpuTurn(game = hooks?.getGame()) {
  return Boolean(game && game.phase === PHASES.PLAYING && isCpu(currentPlayer(game)));
}

/**
 * Looks at the table and plans the next CPU step if one is due. Safe to call any time and
 * as often as you like (after every render, dialog close, screen change).
 */
export function kickCpu() {
  if (!hooks) return;
  const game = hooks.getGame();
  if (!isCpuTurn(game)) {
    cancel();
    skipping = false; // control is back with a person (or the game is over)
    showStatus(null);
    return;
  }
  showStatus(currentPlayer(game));
  if (!hooks.canAct()) {
    cancel(); // paused, a dialog or another screen: nothing pending
    return;
  }
  const key = stateKey(game);
  if (timer && plannedFor === key) return;
  cancel();
  plannedFor = key;
  const delay = skipping ? 0 : CPU.THINK_MS[hooks.getSettings().cpuSpeed] ?? CPU.THINK_MS.normal;
  timer = setTimeout(() => {
    timer = null;
    const now = hooks.getGame();
    const fresh = now === game && isCpuTurn(now) && stateKey(now) === key && hooks.canAct();
    plannedFor = null;
    if (fresh) hooks.step(now);
    kickCpu();
  }, delay);
}

/** Stops everything (game over, leaving the game, starting another). */
export function stopCpu() {
  cancel();
  skipping = false;
  if (hooks) showStatus(null);
}

/** Plays the remaining CPU steps without pauses until a person has control again. */
export function skipCpu() {
  skipping = true;
  cancel();
  kickCpu();
}

export function initCpuDriver({ getGame, canAct, step, getSettings, setSpeed }) {
  hooks = { getGame, canAct, step, getSettings };
  $('#cpu-skip').addEventListener('click', skipCpu);
  $('#cpu-faster').addEventListener('click', () => {
    setSpeed(getSettings().cpuSpeed === 'fast' ? 'normal' : 'fast');
    cancel();
    kickCpu();
  });
  // Whenever a dialog closes (pause, event card, handoff, auction…) the CPU may continue.
  document.addEventListener('close', () => kickCpu(), true);
}
