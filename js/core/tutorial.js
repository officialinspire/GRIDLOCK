/**
 * First-game tutorial: which coach-mark tips exist, when each applies, and the
 * persisted progress. Pure logic (no DOM); js/ui/tutorial.js shows the tips.
 *
 * Status: 'new' (never started) → 'active' (first New Game, or Replay) →
 * 'done' (every tip seen) or 'skipped'. Only 'done'/'skipped' stop the tips.
 */
import { PHASES, TURN_PHASES, roadsBuilt, currentPlayer } from './game.js';
import { builtSides, totalRoads } from './board.js';
import { isCpu } from './seats.js';

export const TUTORIAL_KEY = 'gridlock.tutorial.v1';

/**
 * Tips in teaching order. `moment` tips are raised by the game view when that moment happens;
 * the others follow the game state ('scoring' also appears on the results screen if still unseen).
 */
export const TUTORIAL_STEPS = Object.freeze([
  { id: 'manage', title: 'Manage City', text: 'Each turn starts here. Tap one of your blocks to build or upgrade, then choose Pave Road.' },
  { id: 'pave', title: 'Pave Road', text: 'Pave one open road between two dots. On a touch screen, tap it once to preview and again to pave.' },
  { id: 'complete', title: 'Complete a block', text: 'This block has three roads. Pave the fourth side to claim it, earn the capture reward, and get a bonus road.' },
  { id: 'develop', title: 'Develop Now or Leave Vacant', text: 'Build on your new block right away, or leave it vacant for now and develop it later from Manage City.', moment: true },
  { id: 'bonus', title: 'Bonus road', text: 'Capturing gives you another road this turn. Close more blocks to keep the chain going.' },
  { id: 'income', title: 'Income & upkeep', text: 'At the start of your turn, developed blocks pay income and every block you own costs upkeep. Watch your cash!', moment: true },
  { id: 'events', title: 'City events', text: 'Each new round can bring a city event that changes income or costs for a while. Its card shows which blocks are affected.', moment: true },
  { id: 'cpu', title: 'CPU turns', text: 'Mayor Bots play their own turns: their card lights up and this strip says what they are up to. The board waits for them. Pause, Speed up or Skip any time.', moment: true, cpuOnly: true },
  { id: 'scoring', title: 'Winning', text: 'The game ends when every road is paved. Highest City Value wins: cash + land + 75% of what you invested in buildings.' },
]);

export const STEP_IDS = TUTORIAL_STEPS.map((s) => s.id);

/** The tips that apply at this table: the CPU-turns tip only when bots are playing. */
export function stepsFor(game) {
  const bots = Boolean(game?.players?.some(isCpu));
  return TUTORIAL_STEPS.filter((s) => !s.cpuOnly || bots).map((s) => s.id);
}
const STATUSES = ['new', 'active', 'done', 'skipped'];

export function normalizeTutorial(raw) {
  const status = STATUSES.includes(raw?.status) ? raw.status : 'new';
  const seen = Array.isArray(raw?.seen) ? STEP_IDS.filter((id) => raw.seen.includes(id)) : [];
  return { status, seen };
}

export function loadTutorial(storage = globalThis.localStorage) {
  try {
    return normalizeTutorial(JSON.parse(storage?.getItem(TUTORIAL_KEY) ?? 'null'));
  } catch {
    return normalizeTutorial(null);
  }
}

export function saveTutorial(state, storage = globalThis.localStorage) {
  try {
    storage?.setItem(TUTORIAL_KEY, JSON.stringify(normalizeTutorial(state)));
    return true;
  } catch {
    return false; // private mode etc.: the tutorial just runs again next time
  }
}

/** Tips show while the tutorial is active. */
export const isRunning = (state) => state.status === 'active';

/** A New Game starts the tutorial the first time only (or after Replay reset it). */
export function onNewGame(state) {
  return state.status === 'new' ? { ...state, status: 'active' } : state;
}

/**
 * Records a tip as seen. The tutorial is done once every tip that applies (`applicable`,
 * default all; see stepsFor) has been seen, so an all-human first game finishes without
 * the CPU-turns tip.
 */
export function markSeen(state, id, applicable = STEP_IDS) {
  if (!STEP_IDS.includes(id) || state.seen.includes(id)) return state;
  const seen = STEP_IDS.filter((s) => s === id || state.seen.includes(s));
  return { status: applicable.every((s) => seen.includes(s)) ? 'done' : state.status, seen };
}

export const skipTutorial = (state) => ({ ...state, status: 'skipped' });

/** Replay: start over, beginning with the current game (or the next one). */
export const replayTutorial = () => ({ status: 'active', seen: [] });

/** The first unowned, intact block with exactly three paved sides, or null. */
export function almostCompleteBlock(game) {
  return game.board.blocks.find((b) => b.ownerSeat == null && !b.abandoned && builtSides(game.board, b) === 3) ?? null;
}

/**
 * The state-based tip that applies right now (earliest unseen in teaching order), or null.
 * Moment tips (develop, income, events) are raised by the game view instead.
 */
export function tipForGame(state, game) {
  if (!isRunning(state) || !game) return null;
  const unseen = (id) => !state.seen.includes(id);
  if (game.phase === PHASES.ENDED) return null; // the results screen raises 'scoring' as a moment
  if (isCpu(currentPlayer(game))) return null; // tips are for people: CPU turns show none
  const phase = game.turnPhase;
  const choosing = phase === TURN_PHASES.MANAGE_CITY || phase === TURN_PHASES.PAVE_ROAD;
  if (unseen('manage') && phase === TURN_PHASES.MANAGE_CITY) return 'manage';
  if (unseen('pave') && choosing) return 'pave';
  if (unseen('bonus') && phase === TURN_PHASES.BONUS_ROAD) return 'bonus';
  if (unseen('complete') && (choosing || phase === TURN_PHASES.BONUS_ROAD) && almostCompleteBlock(game)) return 'complete';
  if (unseen('scoring') && choosing && roadsBuilt(game) * 2 >= totalRoads(game.board)) return 'scoring';
  return null;
}
