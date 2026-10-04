/**
 * Runs CPU seats inside the real turn loop. The driver only schedules: each step is one
 * decision from core/cpu (a road, a build, a sale…) played by the game view through the same
 * handlers a person's click uses, so every move goes through the public core actions.
 * The step is planned when the pause starts, so the strip can say what the bot intends
 * ("Building a Landmark on C3") and the road or block it's about to use is highlighted.
 *
 * - One step at a time, after a short "thinking" pause (CPU.THINK_MS by the cpuSpeed setting;
 *   Speed up switches to fast, Skip plays the rest of the CPU turns at once; Pause opens the
 *   pause menu).
 * - Nothing happens while anything else needs the table: an open dialog (pause, event card,
 *   handoff, an auction people are bidding in…), another screen, or no game.
 * - Every scheduled step is tied to the exact game state it was planned for. If anything has
 *   changed when it fires (a reload, a new game, a move by someone else) it is dropped and
 *   re-planned, so a step can never run twice. Every step is autosaved (a quick run of steps
 *   in one write; a reload or hidden page writes it first), so a reload mid-turn resumes from
 *   the last completed step.
 * - Ended games, leaving for the title screen and new games stop all timers.
 * - Cooperative (js/ui/cooperative.js): planning a step and playing it are tasks of their own,
 *   never part of the move, redraw or click that came before. Planning that took more than a
 *   slice of a frame last time (a phone, Hard's City decisions) starts only once the browser
 *   has painted, so each move is on screen and a tap on Pause handled before the bot thinks
 *   again; quick planning (a fast desktop) may follow at once within the slice. Even with no
 *   pause between steps (Skip, Instant), bot steps can't pile up into one long block.
 */
import { $ } from './dom.js';
import { CPU } from '../config.js';
import { PHASES, currentPlayer, roadsBuilt } from '../core/game.js';
import { isCpu } from '../core/seats.js';
import { measure } from '../core/perf.js';
import { createCooperativeScheduler, SLICE_MS } from './cooperative.js';

let hooks = null;
let timer = null; // the thinking pause before a planned step
let pending = null; // cancels the planning or the step waiting for its turn (cooperative scheduling)
const { soon, nextTask } = createCooperativeScheduler();
let lastPlanMs = Infinity; // how long the last planning took (cheap planning may share a frame)
let plannedFor = null;
let plan = null; // { text, target, run } for the step being thought about
let skipping = false;
let stuck = 0; // steps in a row that changed nothing (see STUCK_LIMIT)
let stepping = null; // seat of the CPU whose planned step is being played right now

/**
 * Safety net: a step that changes nothing would be planned again and again. After this many in
 * a row the driver asks for the fallback step instead (finish managing and pave, or leave a
 * capture vacant). The simulator (tools/cpu-simulate.mjs) checks this never happens.
 */
const STUCK_LIMIT = 2;

/**
 * The pause before a planned step (ms), by the cpuPlayback and cpuSpeed settings:
 *   full     every step: THINK_MS[cpuSpeed]
 *   brief    major steps: THINK_MS[cpuSpeed]; routine: PLAYBACK_ROUTINE_MS.brief
 *   instant  major steps: THINK_MS.fast; routine: PLAYBACK_ROUTINE_MS.instant (at once)
 */
export function stepDelay(settings, step) {
  const think = CPU.THINK_MS[settings.cpuSpeed] ?? CPU.THINK_MS.normal;
  const playback = settings.cpuPlayback ?? 'full';
  if (playback === 'full') return think;
  if (step?.major) return playback === 'instant' ? Math.min(think, CPU.THINK_MS.fast) : think;
  return CPU.PLAYBACK_ROUTINE_MS[playback] ?? 0;
}

/** Whether a step is announced in the thinking strip (Full: all; Brief/Instant: major only). */
const shows = (settings, step) => (settings.cpuPlayback ?? 'full') === 'full' || Boolean(step?.major);

/** A fingerprint of everything a step could change: if it differs, the plan is stale. */
function stateKey(game) {
  return [game.log.length, game.ledger.length, game.turnPhase, game.turnIndex, game.round,
    roadsBuilt(game), game.pendingCaptures.join(','), currentPlayer(game).cash].join('|');
}

function cancel() {
  if (timer) clearTimeout(timer);
  timer = null;
  pending?.();
  pending = null;
  plannedFor = null;
  plan = null;
  showIntent(null);
}

/** "Building a Landmark on C3" under the thinking line, and a highlight on what it will use. */
function showIntent(next) {
  for (const el of document.querySelectorAll('.cpu-intent')) el.classList.remove('cpu-intent');
  const line = $('#cpu-status-intent');
  if (!line) return;
  line.textContent = next?.text ?? '';
  line.hidden = !next?.text;
  if (next?.target) document.querySelector(next.target)?.classList.add('cpu-intent');
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

/** The seat whose CPU step the driver is playing right now, or null (see the game view's render()). */
export const cpuStepSeat = () => stepping;

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
  if (plannedFor === key && (timer || pending)) {
    // A re-render may have replaced the highlighted element.
    if (plan && shows(hooks.getSettings(), plan)) showIntent(plan);
    return;
  }
  cancel();
  plannedFor = key;
  const kickedAt = performance.now();
  // Planned in a task of its own: after a paint, unless planning has been quick (see above).
  pending = soon(() => {
    pending = null;
    planStep(game, key, kickedAt);
  }, { cheap: lastPlanMs < SLICE_MS });
}

/** True while `game` is still the game, in exactly the state `key` describes, and the CPU may act. */
const stillFor = (game, key) => {
  const now = hooks.getGame();
  return now === game && isCpuTurn(now) && stateKey(now) === key && hooks.canAct();
};

function planStep(game, key, kickedAt) {
  if (!stillFor(game, key)) {
    plannedFor = null;
    kickCpu(); // the table changed while the planning waited: look again
    return;
  }
  const started = performance.now();
  plan = measure('cpuPlan', () => (stuck >= STUCK_LIMIT && hooks.fallback?.(game)) || hooks.plan(game));
  lastPlanMs = performance.now() - started;
  const planned = plan;
  // The thinking pause counts from the previous step, so its length is the setting's.
  const wait = skipping ? 0 : Math.max(0, stepDelay(hooks.getSettings(), planned) - (performance.now() - kickedAt));
  // Brief/Instant: only major steps get the "what it's doing" line and highlight.
  showIntent(shows(hooks.getSettings(), planned) ? planned : null);
  const play = () => {
    timer = null;
    pending = null;
    playStep(game, key, planned);
  };
  if (wait > 0) timer = setTimeout(play, wait);
  else pending = nextTask(play); // a task of its own, straight after the planning
}

function playStep(game, key, planned) {
  const fresh = stillFor(game, key);
  plannedFor = null;
  plan = null;
  showIntent(null);
  // The plan was made for exactly this state (same key), so it is still the right move.
  if (fresh) {
    const now = hooks.getGame();
    stepping = currentPlayer(now).seat;
    try {
      planned.run();
    } finally {
      stepping = null;
    }
    stuck = hooks.getGame() === now && stateKey(now) === key ? stuck + 1 : 0;
  }
  kickCpu();
}

/** Stops everything (game over, leaving the game, starting another). */
export function stopCpu() {
  cancel();
  skipping = false;
  stuck = 0;
  if (hooks) showStatus(null);
}

/** Plays the remaining CPU steps without pauses until a person has control again. */
export function skipCpu() {
  skipping = true;
  cancel();
  kickCpu();
}

export function initCpuDriver({ getGame, canAct, plan: planStep, fallback, getSettings, setSpeed, pause }) {
  hooks = { getGame, canAct, plan: planStep, fallback, getSettings };
  $('#cpu-skip').addEventListener('click', skipCpu);
  $('#cpu-pause').addEventListener('click', pause);
  $('#cpu-faster').addEventListener('click', () => {
    setSpeed(getSettings().cpuSpeed === 'fast' ? 'normal' : 'fast');
    cancel();
    kickCpu();
  });
  // Whenever a dialog closes (pause, event card, handoff, auction…) the CPU may continue.
  document.addEventListener('close', () => kickCpu(), true);
}
