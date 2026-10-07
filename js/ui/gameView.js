/** Game screen controller: wires core game state to board, HUD and actions. */
import { $, h } from './dom.js';
import { replayAnimation } from './replay.js';
import { createSprite, preloadSheets } from '../assets.js';
import { ART } from '../art.js';
import { bus } from '../core/bus.js';
import {
  createGame, placeRoad, currentPlayer, getPlayer, MOVE_ERRORS, PHASES, TURN_PHASES, ERAS,
  startPaving, resolveCapture, endCityTurn, eraStatus, outOfCityActions, roadsRemaining,
} from '../core/game.js';
import { getBlockById, DISTRICTS, builtSides, roadBlocks } from '../core/board.js';
import { describeDevelopment, getCategory } from '../core/buildings.js';
import { blockValue, bonusIncome, formatCash, formatDelta } from '../core/economy.js';
import { bonusList } from './bonusView.js';
import { showEventCard, renderEventStrip, eventLines, initEventView } from './eventView.js';
import { getEventDef } from '../core/events.js';
import { initFinanceView, openDistressPanel } from './financeView.js';
import { isInDistress } from '../core/economy.js';
import { isDeveloped } from '../core/development.js';
import { initBuildPanel, openBuildPanel, closeBuildPanel, canManage } from './buildPanel.js';
import {
  renderBoard, initBoardView, clearSelection, rejectRoad, getSelectedBlock, disarm,
} from './boardView.js';
import { renderHud } from './hud.js';
import { showResults as openResults, copyChallengeLink } from './resultsView.js';
import { formatSeed, replaySetup } from '../core/challenge.js';
import { showScreen, resetTo } from './router.js';
import { toast, clearToasts } from './toast.js';
import { audio, play } from './audio.js';
import { buzz } from './haptics.js';
import { modeName } from '../core/modes.js';
import { recordFinishedMatch } from './careerView.js';
import { watchAchievements, clearAchievementPops, initAchievementView } from './achievementView.js';
import { blockDetails } from '../core/forecast.js';
import { ECONOMY } from '../config.js';
import { modifierText } from './forecastView.js';
import { initTutorial, updateTutorial, tutorialMoment, tutorialMove, tutorialNewGame } from './tutorial.js';
import { getSettings, updateSettings } from './settingsView.js';
import { saveActiveGame, loadActiveGame, clearActiveGame } from '../core/persistence.js';
import { isCpu, controllerLabel } from '../core/seats.js';
import { chooseRoad } from '../core/cpu/roads.js';
import { chooseCityAction } from '../core/cpu/city.js';
import { buildOnBlock, upgradeBlock } from '../core/development.js';
import {
  downgradeBlock, sellDevelopment, declareBankruptcy, ACQUIRE_MODES,
} from '../core/finance.js';
import { initAuctionView, startAuction, cancelAuction } from './auctionView.js';
import { initCityIntro, showCityIntro, cancelCityIntro } from './cityIntro.js';
import { takeoverBlock, influenceMap } from '../core/takeover.js';
import { initCpuDriver, kickCpu, stopCpu, isCpuTurn, cpuStepSeat } from './cpuDriver.js';
import { measure } from '../core/perf.js';
import { createAutosave } from './autosave.js';
import { createRenderScheduler } from './renderScheduler.js';
import { readPass } from '../core/passCache.js';
import { trackGameEvent, setAnalyticsContext } from '../analytics.js';

/** Must match the portrait/compact breakpoint in css/mobile.css. */
export const COMPACT_LAYOUT = '(orientation: portrait) and (max-width: 1100px), (max-width: 600px)';
const isCompact = () => globalThis.matchMedia?.(COMPACT_LAYOUT).matches ?? false;
let armHintShown = false;

let game = null;
let lastSetup = null;
let analyticsMatchSerial = 0;
let chain = 0; // blocks claimed by the current player during this turn
let lastHuman = null; // seat of the last person to have the device (for handoffs)

export const getGame = () => game;

/** Title screen: Continue and Discard show only while there is a saved game to offer. */
function showSavedGameControls(available) {
  $('#continue-game').hidden = !available;
  $('#discard-save').hidden = !available;
}

/** Reads (migrates and validates) the stored save, shows the controls to match and returns it. */
function refreshSavedGameControls() {
  const saved = loadActiveGame();
  showSavedGameControls(Boolean(saved));
  return saved;
}

/** Writes the game in progress to storage now and shows Continue / Discard to match. */
function writeSave() {
  measure('autosave', () => {
    // saveActiveGame() validates the game before writing it, so a save that succeeded is one
    // loadActiveGame() accepts: show the controls without reading it straight back. Anything
    // else (game over, a refused or failed save) asks storage what is really there.
    if (game?.phase === PHASES.PLAYING && saveActiveGame(game, lastSetup)) showSavedGameControls(true);
    else refreshSavedGameControls();
  });
}

/**
 * Autosave (js/ui/autosave.js): a quick run of moves (a capture chain, CPU steps) is written
 * once, shortly after the last of them. Hiding, reloading or leaving the page writes a pending
 * save first (initGameView); quitting, an app update, a new game, the City era and a settled
 * auction save at once (saveNow); the end of a match or an abandon drops it and clears the save.
 */
const autosaver = createAutosave(writeSave);

/** A durable change during play: saved shortly (debounced). */
function autosave() {
  autosaver.schedule();
}

/** Saves right away, replacing any pending save. */
function saveNow() {
  autosaver.saveNow();
}

/** Saves the game in progress right now (e.g. before an app update reloads the page). */
export function saveGameNow() {
  saveNow();
}

function renderInspector(blockId, panel = $('#inspector')) {
  const block = blockId && game ? getBlockById(game.board, blockId) : null;
  if (!block) {
    panel.replaceChildren(
      h('p', { class: 'inspector__hint' },
        createSprite('icons:zoom-in', { className: 'inspector__hint-icon' }),
        'Tap a block to inspect it.'),
    );
    return;
  }
  const owner = block.ownerSeat ? getPlayer(game, block.ownerSeat) : null;
  const row = (k, v, tip) => [h('dt', { title: tip ?? null }, k), h('dd', {}, v)];
  const d = blockDetails(game, block.id); // every number from the game's own economy/scoring/event functions
  panel.replaceChildren(...[
    h('h3', { class: 'inspector__title' }, `Block ${block.label}`),
    (owner || block.abandoned) && h('p', { class: 'inspector__dev', dataset: { type: block.type } },
      describeDevelopment(block), block.abandoned ? ' (inactive)' : ''),
    h('dl', { class: 'inspector__facts' },
      row('District', DISTRICTS[block.district].label),
      row('Roads', `${builtSides(game.board, block)} / 4`),
      row('Land value', formatCash(block.price)),
      row('Owner', owner ? [owner.name, isCpu(owner) && h('span', { class: 'inspector__bot' }, ` (${controllerLabel(owner)})`)] : 'Unclaimed'),
      row('Income', owner
        ? [`+${formatCash(d.income)}/turn`, d.income !== d.normalIncome && h('span', {
          class: `inspector__event ${d.income > d.normalIncome ? 'is-up' : 'is-down'}`,
          title: `City event: normally ${formatCash(d.normalIncome)}/turn`,
          'aria-label': `, normally ${formatCash(d.normalIncome)} per turn`,
        }, d.income > d.normalIncome ? ' ▲' : ' ▼')]
        : '—', 'Paid at the owner\'s turn start, with active city events applied'),
      owner && row('Upkeep', `−${formatCash(d.upkeep)}/turn`, 'Charged at the owner\'s turn start'),
      owner && row('Net', `${formatDelta(d.net)}/turn`, 'Income minus upkeep'),
      owner && row('Property value', formatCash(blockValue(block)), 'Land plus what was actually paid for construction'),
      owner && d.contribution != null && row('Adds to City Value', formatCash(d.contribution),
        `How much this block adds to ${owner.name}'s final score (${Math.round(ECONOMY.SCORING.LAND * 100)}% of land + `
        + `${Math.round(ECONOMY.SCORING.INVESTED_BUILDING * 100)}% of building investment + the Prestige it brings)`),
      owner && d.eventPrice.length > 0 && row('Upgrade price', modifierText(d.eventPrice), 'City events changing build/upgrade prices for this category'),
      owner && row('Prestige', d.prestige
        ? `${d.prestige > 0 ? '+' : ''}${d.prestige}${d.prestigeNotes.length > 1 ? ` (${d.prestigeNotes.map((n) => `${n.label} ${n.points > 0 ? '+' : ''}${n.points}`).join(', ')})` : ''}`
        : '0', `Each Prestige point adds ${formatCash(ECONOMY.SCORING.PRESTIGE)} to City Value. Parks, Civic and Landmarks earn it; industry next to homes costs it`),
      owner && row('Control', String(d.control),
        'Takeover defence: ownership + building level + nearby Residential, Civic and Landmark levels + adjacent own development'),
      d.shield && row('Protected', d.shield.seat != null
        ? `until ${getPlayer(game, d.shield.seat)?.name ?? 'its owner'}'s turn in round ${d.shield.untilRound} ends`
        : `until round ${d.shield.untilRound} ends`,
      'Recently changed hands: it can\'t be taken over yet'),
      d.takeover && row('Your pressure', d.takeover.ok
        ? `${d.takeover.pressure} › ${d.takeover.control}: take over for ${formatCash(d.takeover.cost)}`
        : `${d.takeover.pressure} vs ${d.takeover.control}`,
      d.takeover.reason ?? 'Your adjacent developed blocks (Commercial count extra). Tap the block to take it over'),
    ),
    block.abandoned && h('p', { class: 'inspector__note inspector__note--abandoned' },
      `Abandoned${block.abandonedBy ? ` by ${getPlayer(game, block.abandonedBy)?.name}` : ''}. Inactive until another mayor buys it.`),
    owner && bonusList(block),
    owner && eventLines(game, block),
    owner && !isDeveloped(block) && h('p', { class: 'inspector__note' }, 'Vacant: no income until developed.'),
  ].filter(Boolean));
}

function renderPrompt() {
  const prompt = $('#turn-prompt');
  if (game.phase === PHASES.ENDED) {
    prompt.textContent = 'The city is complete.';
    prompt.style.removeProperty('--player');
    return;
  }
  const p = currentPlayer(game);
  prompt.style.setProperty('--player', p.hex);
  prompt.classList.toggle('is-distress', isInDistress(p));
  // Just bankrupt this round: say so, so the fresh start is understood (the HUD card says it too).
  const recovering = p.lastBankruptcyRound === game.round && !isInDistress(p) ? ' · Recovering from bankruptcy' : '';
  if (isInDistress(p)) {
    prompt.textContent = `${p.name} is ${formatCash(-p.cash)} in debt! Sell or downgrade to continue.`;
    return;
  }
  const { actionsLeft, actionName: action } = eraStatus(game);
  const left = `${actionsLeft} ${actionsLeft === 1 ? action : `${action}s`} left`;
  if (game.era === ERAS.CITY) {
    // The final mover's turn: its Development Action came before the final road.
    const eraAt = game.log.findLastIndex((e) => e.type === 'era');
    const finalMover = eraAt >= 0 && !game.log.slice(eraAt).some((e) => e.type === 'city-turn');
    const transition = finalMover ? ' (this turn\'s Development Action came before the final road)' : '';
    prompt.textContent = game.turnPhase === TURN_PHASES.CAPTURE_DEVELOP
      ? `${p.name}: CAPTURE / DEVELOP · Develop the final claimed block now for free, or leave it vacant.`
      : `${p.name}: CITY TURN · ${left}${actionsLeft ? ': build, upgrade, sell or redevelop' : transition}, then End Turn.${recovering}`;
    return;
  }
  const copy = {
    [TURN_PHASES.MANAGE_CITY]: actionsLeft
      ? `MANAGE CITY · ${left}: build, upgrade, sell or redevelop, then Pave Road.`
      : `MANAGE CITY · ${left}: now Pave Road.`,
    [TURN_PHASES.PAVE_ROAD]: 'PAVE ROAD · Choose one open road.',
    [TURN_PHASES.CAPTURE_DEVELOP]: 'CAPTURE / DEVELOP · Develop Now is free (a capture reward), or leave it vacant.',
    [TURN_PHASES.BONUS_ROAD]: 'BONUS ROAD · Pave another road.',
  }[game.turnPhase];
  prompt.textContent = `${p.name}: ${copy}${recovering}`;
}

/** Shows results once the final road's feedback (capture pop, toasts) has played and any dialog is closed. */
function showResults() {
  if (!game?.results) return;
  const blocking = [...document.querySelectorAll('dialog[open]')].filter((d) => d.id !== 'results-dialog');
  if (blocking.length) {
    blocking[0].addEventListener('close', showResults, { once: true });
    return;
  }
  openResults(game);
  tutorialMoment('scoring');
}

function renderActions() {
  $('#action-results').hidden = !(game && game.phase === PHASES.ENDED);
  const cpuTurn = isCpuTurn(game);
  const distress = Boolean(game && game.phase === PHASES.PLAYING && isInDistress(currentPlayer(game)));
  $('#action-finance').hidden = !distress || cpuTurn;
  const build = $('#action-build');
  const manageable = game && !cpuTurn && canManage(game, getSelectedBlock());
  build.disabled = !manageable;
  build.title = manageable ? 'Develop the selected block' : 'Select one of your blocks to develop it';
  const managing = Boolean(game && game.phase === PHASES.PLAYING && game.turnPhase === TURN_PHASES.MANAGE_CITY) && !cpuTurn;
  const city = game?.era === ERAS.CITY;
  const pave = $('#action-pave');
  pave.hidden = !managing || city;
  pave.disabled = distress;
  pave.classList.toggle('is-ready', managing && !city && !distress && game.city.actionsLeft === 0);
  const endTurn = $('#action-end-turn');
  endTurn.hidden = !managing || !city;
  endTurn.disabled = distress;
  endTurn.classList.toggle('is-ready', managing && city && game.city.actionsLeft === 0);
}

/**
 * Draws the whole game screen now: board, HUD, prompt, inspector, event strip, actions, City
 * view and tips; then lets a CPU mayor plan (kickCpu also re-marks its target on the new board).
 * Only the render scheduler calls this; everything else asks with render().
 */
function drawGame() {
  if (!game) return;
  // A bot's turn: the board waits (clicks are politely refused) and the first time, a tip explains.
  const botTurn = isCpuTurn(game);
  // One read-only pass: readings several parts ask for (a block's event impacts, a player's
  // stats, the takeover candidates…) are computed once (core/passCache.js).
  measure('render', () => readPass(game, () => {
    measure('renderBoard', () => renderBoard(game));
    measure('renderHud', () => renderHud(game));
    renderPrompt();
    measure('renderInspector', () => renderInspector(getSelectedBlock()));
    renderEventStrip(game);
    renderActions();
    $('#board-frame').classList.toggle('is-cpu-turn', botTurn);
    measure('applyCityView', applyCityView);
    updateTutorial();
  }));
  // Live achievements a person has just earned: saved and announced once the table is clear.
  measure('achievements', () => watchAchievements(game));
  kickCpu(); // may plan the CPU's next step: timed as cpuPlan, not as part of render
  if (botTurn) tutorialMoment('cpu');
}

const renderer = createRenderScheduler(drawGame);

/**
 * Asks for a redraw (js/ui/renderScheduler.js). Every request during one action becomes a single
 * draw at the end of that action, before the browser paints or handles the next event. A CPU step
 * after which the same bot is still on turn draws at the next animation frame instead, so a burst
 * of quick bot steps (Skip, Instant playback) is one visual update per frame; a step that hands
 * the turn on (to a person or another bot) is drawn at once, like a person's action.
 */
function render() {
  const bot = cpuStepSeat();
  renderer.request({ frame: bot != null && isCpuTurn(game) && currentPlayer(game).seat === bot });
}

/** A tutorial moment whose tip may point at the board or HUD: drawn first, so it points at this turn's screen. */
function tipOnScreen(id) {
  renderer.flush();
  tutorialMoment(id);
}

/* ---------------- CITY VIEW (influence overlay) ---------------- */

const INFLUENCE = [
  // [list in influenceMap, data-influence value, legend label, screen-reader note]
  ['targets', 'target', 'Takeover target', 'takeover target: your pressure beats its control'],
  ['atRisk', 'risk', 'At risk', 'at risk: a rival\'s pressure beats its control'],
  ['shielded', 'shield', 'Protected', 'protected: recently changed hands'],
  ['abandoned', 'abandoned', 'Abandoned', 'abandoned: open for redevelopment'],
];

/** Whose view the overlay shows: the mayor on turn if a person, else the last person to play. */
function viewerSeat() {
  const me = currentPlayer(game);
  return !isCpu(me) ? me.seat : (lastHuman ?? me.seat);
}

/**
 * The optional CITY VIEW: marks takeover targets, the viewer's at-risk blocks, protected
 * (shielded) blocks and abandoned lots (core/takeover.js influenceMap), dims everything else,
 * and shows a small legend with counts over the board. Off by default (Settings, or the top-bar
 * map button).
 */
function applyCityView() {
  const on = Boolean(game) && getSettings().cityView && game.phase === PHASES.PLAYING;
  $('#city-view-btn').setAttribute('aria-pressed', String(getSettings().cityView));
  $('#board-frame').classList.toggle('is-city-view', on);
  const legend = $('#influence-legend');
  legend.hidden = !on;
  const map = on ? influenceMap(game, viewerSeat()) : null;
  markInfluence(map);
  if (!on) return;
  legend.replaceChildren(...INFLUENCE.map(([list, kind, label]) => h('li', { class: 'influence-legend__item', dataset: { influence: kind } },
    h('span', { class: 'influence-legend__swatch', 'aria-hidden': 'true' }), `${label} ${map[list].length}`)));
}

/**
 * Marks the blocks the City view lists (none when `map` is null). The board keeps unchanged cells
 * between draws, so marks from before that no longer apply are cleared here; only changes are written.
 */
function markInfluence(map) {
  const marks = new Map();
  for (const [list, kind, , note] of map ? INFLUENCE : []) {
    for (const id of map[list]) marks.set(id, [kind, `City view: ${note}`]);
  }
  for (const cell of document.querySelectorAll('#board [data-influence]')) {
    if (marks.has(cell.dataset.block)) continue;
    delete cell.dataset.influence;
    cell.removeAttribute('aria-description');
  }
  for (const [id, [kind, description]] of marks) {
    const cell = document.querySelector(`#board [data-block="${id}"]`);
    if (!cell) continue;
    if (cell.dataset.influence !== kind) cell.dataset.influence = kind;
    if (cell.getAttribute('aria-description') !== description) cell.setAttribute('aria-description', description);
  }
}

function toggleCityView() {
  updateSettings({ cityView: !getSettings().cityView });
  if (game) render();
}

/** Re-render after a build/upgrade/sale and celebrate any new bonus income. */
function handleDevelopment(change) {
  const { bonusBefore } = change;
  const captured = game.turnPhase === TURN_PHASES.CAPTURE_DEVELOP ? game.pendingCaptures[0] : null;
  if (captured) resolveCapture(game, captured);
  autosave();
  // Sales/downgrades pay a refund; Level 2–3 is an upgrade; anything else is new construction.
  const kind = change.refund > 0 ? 'coins' : change.level >= 2 && !change.mode ? 'upgrade' : 'build';
  // Each building type has its own construction sound.
  play(kind, { id: change.block ? getBlockById(game.board, change.block)?.type : undefined });
  if (kind !== 'coins' && !change.cpu) buzz(kind);
  const player = currentPlayer(game);
  const after = game.board.blocks.filter((b) => b.ownerSeat === player.seat).reduce((s, b) => s + bonusIncome(b), 0);
  if (after > bonusBefore) toast(`★ Bonus income +${formatCash(after - bonusBefore)}/turn`, { tone: 'capture' });
  if (captured) showCaptureChoice();
  else render();
}

function showCaptureChoice() {
  const dialog = $('#capture-choice-dialog');
  // CPU mayors make this choice themselves (cpuPlan); people get the dialog.
  if (!game || game.phase !== PHASES.PLAYING || game.turnPhase !== TURN_PHASES.CAPTURE_DEVELOP || isCpuTurn()) {
    if (dialog.open) dialog.close();
    render();
    return;
  }
  const block = getBlockById(game.board, game.pendingCaptures[0]);
  $('#capture-choice-copy').textContent = `Block ${block.label} is yours. Develop it now, or leave it vacant and continue to your bonus road.`;
  if (!dialog.open) dialog.showModal();
  dialog.querySelector('[data-capture-choice="develop"]').focus();
  tutorialMoment('develop');
  render();
}

let handoffReady = null;
/**
 * The pass-the-device screen is for people: it shows only when control reaches a person other
 * than the last one who played (never before or after a CPU seat, never in a one-person game).
 * An all-human table therefore gets it on every change of turn, as always.
 */
function needsHandoff(next) {
  const humans = game.players.filter((p) => !isCpu(p)).length;
  return !isCpu(next) && humans >= 2 && next.seat !== lastHuman;
}

function showHandoff(player, onReady) {
  lastHuman = player.seat;
  if (getSettings().quickHandoff) return onReady();
  const dialog = $('#handoff-dialog');
  dialog.style.setProperty('--player', player.hex);
  $('#handoff-title').textContent = `Pass to ${player.name}`;
  $('#handoff-copy').textContent = `${player.symbol} · Hand the device to ${player.name}, then continue.`;
  handoffReady = onReady;
  if (!dialog.open) dialog.showModal();
  $('#handoff-ready').focus();
}

function leaveCapturedBlock(blockId) {
  if (!game || game.turnPhase !== TURN_PHASES.CAPTURE_DEVELOP || game.pendingCaptures[0] !== blockId) return;
  resolveCapture(game, blockId);
  autosave();
  showCaptureChoice();
}

function handleBlockSelect(id) {
  readPass(game, () => {
    renderInspector(id);
    renderActions();
  });
  if (!id || !game) return;
  if (!isCpuTurn() && openBuildPanel(game, id)) return;
  // Compact (portrait) layouts hide the side inspector: show the same details in a bottom sheet.
  if (isCompact()) {
    renderInspector(id, $('#info-body'));
    $('#info-dialog').showModal();
  }
}

function handleRoadArmed() {
  play('tick');
  buzz('arm');
  if (!armHintShown) {
    armHintShown = true;
    toast('Tap the highlighted road again to pave it.', { duration: 2200 });
  }
}

function flashFrame() {
  replayAnimation($('#board-frame'), 'is-capture');
}

function chainLabel(count) {
  if (count >= 5) return `GRID LOCK ×${count}`;
  if (count === 4) return 'MOMENTUM ×4';
  if (count === 3) return 'FLOW ×3';
  if (count === 2) return 'CHAIN ×2';
  return count === 1 ? 'CAPTURE ×1' : '';
}

function renderChain() {
  const meter = $('#chain-meter');
  meter.hidden = chain < 1;
  meter.textContent = chainLabel(chain);
  meter.dataset.chain = Math.min(chain, 5);
  if (chain) replayAnimation(meter, 'is-bumped');
}

/**
 * One short turn summary instead of separate toasts and coin chips: the new mayor's net for the
 * turn (income − upkeep − repairs, with the gross figures beside it) and, on a new round, a
 * calm-round or event-over note. Major news (a new event, debt) keeps its own card or panel.
 */
function showTurnSummary({ turnIncome, turnUpkeep, turnRepair, note = null }) {
  const paid = turnIncome?.amount ?? 0;
  const upkeep = turnUpkeep?.amount ?? 0;
  const repair = turnRepair?.amount ?? 0;
  const money = turnIncome && (paid > 0 || upkeep > 0 || repair > 0);
  if (!money && !note) return;
  const summary = $('#economy-summary');
  const nodes = [];
  if (money) {
    const net = paid - upkeep - repair;
    const payee = getPlayer(game, turnIncome.seat);
    nodes.push(
      h('span', { class: 'economy-summary__who' }, `${payee.name} · `),
      h('strong', { class: `economy-summary__net${net < 0 ? ' is-negative' : ''}` }, `Net ${net < 0 ? '−' : '+'}${formatCash(Math.abs(net))}`),
      h('span', { class: 'economy-summary__gross' },
        ` · Income +${formatCash(paid)} − Upkeep ${formatCash(upkeep)}${repair ? ` − Repairs ${formatCash(repair)}` : ''}`),
    );
    summary.dataset.seat = turnIncome.seat;
    summary.classList.toggle('is-warn', Boolean(turnUpkeep?.distress || turnRepair?.distress));
  } else {
    delete summary.dataset.seat;
    summary.classList.remove('is-warn');
  }
  if (note) nodes.push(h('span', { class: 'economy-summary__note' }, note));
  summary.replaceChildren(...nodes);
  summary.hidden = false;
  replayAnimation(summary, 'is-showing');
  clearTimeout(showTurnSummary.timer);
  showTurnSummary.timer = setTimeout(() => { summary.hidden = true; }, 2600);
}


const REJECT_MESSAGES = {
  [MOVE_ERRORS.ROADS_CLOSED]: 'Every road is paved: it’s the City era.',
  [MOVE_ERRORS.TAKEN]: 'That road is already paved.',
  [MOVE_ERRORS.INVALID]: "That's not a road.",
  [MOVE_ERRORS.GAME_OVER]: 'The game is over.',
  [MOVE_ERRORS.IN_DISTRESS]: 'Resolve your debt before paving.',
};

/** Opens the distress panel for the current player, after any event card is dismissed. */
function checkDistress() {
  if (!game || game.phase !== PHASES.PLAYING || !isInDistress(currentPlayer(game))) return;
  if (isCpuTurn()) return; // CPU mayors sell or declare themselves (cpuPlan)
  const eventCard = $('#event-dialog');
  if (eventCard.open) {
    eventCard.addEventListener('close', () => openDistressPanel(game), { once: true });
  } else {
    openDistressPanel(game);
  }
}

function handleRoad(id, { cpu = false } = {}) {
  if (!game) return;
  const mover = currentPlayer(game);
  if (isCpu(mover) && !cpu) {
    toast(`${mover.name} is playing. Your turn is coming.`, { duration: 1600 });
    return;
  }
  if (!isCpu(mover)) lastHuman = mover.seat;
  const result = placeRoad(game, id);

  if (!result.ok) {
    rejectRoad(id);
    play('error');
    buzz('error');
    toast(REJECT_MESSAGES[result.error] ?? 'You can’t build there.', { tone: 'warn', duration: 1600 });
    if (result.error === MOVE_ERRORS.IN_DISTRESS) openDistressPanel(game);
    return;
  }

  if (!cpu) tutorialMove();
  const n = result.captured.length;
  chain = result.extraTurn ? chain + n : 0;
  render();
  renderChain();
  play(n > 0 ? 'capture' : 'pave', { intensity: chain || 1 });
  if (!cpu) buzz(n > 0 ? 'capture' : 'pave', { intensity: chain || 1 });

  if (n > 0) {
    flashFrame();
    const labels = result.captured.map((bid) => getBlockById(game.board, bid).label).join(' & ');
    toast(`${mover.name} claims ${labels}! +${formatCash(result.reward)}${result.extraTurn ? ' · Bonus road' : ''}`,
      { tone: 'capture', duration: 2200 });
  }
  if (result.gameEnded) {
    finishMatch(n > 0 ? 700 : 0);
    bus.emit('game:move', result);
    return;
  }
  // The final road (the City era begins) is saved at once; other moves shortly after.
  if (result.cityEra) saveNow();
  else autosave();
  // The City era card first; the final capture's Develop Now choice when it closes.
  if (result.cityEra) announceCityEra(mover, () => { if (n > 0) showCaptureChoice(); });
  else if (n > 0) showCaptureChoice();
  passTurn(result, mover);
}

/** The match is over (final road with no City era, or the last City turn): results after a beat. */
function finishMatch(delay) {
  stopCpu();
  $('#board-frame').classList.add('is-city-complete');
  // Career stats/achievements: counted only if this match was genuinely played to the end.
  recordFinishedMatch(game);
  // GRIDLOCK always ends with ranked results; the winning City Value is the match score.
  // Never send the locally chosen mayor names, seed, or saved board.
  trackGameEvent('game_completed', {
    mode: game.mode,
    round: game.round,
    score: game.results?.rows?.[0]?.cityValue,
  }, analyticsMatchSerial);
  autosaver.cancel(); // a pending save must not bring the finished match back
  clearActiveGame();
  refreshSavedGameControls();
  setTimeout(() => {
    if (game?.results) {
      play('win');
      buzz('win');
    }
    showResults();
  }, delay);
}

/** Every road is paved: the skippable City era card (rounds and actions), then `then`. */
function announceCityEra(mover, then = () => {}) {
  flashFrame();
  play('event', { kind: 'boon' });
  showCityIntro(eraStatus(game), { finalMover: mover.name, onClose: () => { if (game) then(); } });
}

/** CITY era: the current mayor ends their turn (End Turn, or a CPU mayor's decision). */
function handleEndTurn({ cpu = false } = {}) {
  if (!game) return;
  const mover = currentPlayer(game);
  if (isCpu(mover) && !cpu) return;
  if (!isCpu(mover)) lastHuman = mover.seat;
  const result = endCityTurn(game);
  if (!result.ok) {
    play('error');
    buzz('error');
    toast(result.error === MOVE_ERRORS.IN_DISTRESS ? 'Resolve your debt before ending your turn.' : 'You can’t end your turn now.',
      { tone: 'warn', duration: 1600 });
    if (result.error === MOVE_ERRORS.IN_DISTRESS) openDistressPanel(game);
    return;
  }
  clearSelection();
  disarm();
  chain = 0;
  renderChain();
  render();
  if (result.gameEnded) {
    finishMatch(0);
    bus.emit('game:move', result);
    return;
  }
  autosave();
  passTurn(result, mover);
}

/**
 * After a move that may have passed play on (a road, or a City turn ending): the next mayor's
 * chime, the pass-the-device screen, the new round's event card and their income feedback.
 */
function passTurn(result, mover) {
  const finishTransition = () => {
    if (result.event?.started) {
      play('event', { kind: getEventDef(result.event.started.id)?.kind, id: result.event.started.id });
      buzz('event');
      showEventCard(game, result.event.started, result.event.expired);
      tutorialMoment('events');
    }
    const note = result.event?.started ? null
      : result.event?.expired.length ? `City event over: ${result.event.expired.map((e) => getEventDef(e.id)?.name ?? e.id).join(', ')}`
        : result.event?.calm ? 'Calm round · no new city event' : null;
    const paid = result.turnIncome?.amount ?? 0;
    if (paid > 0 && !result.event?.started) play('coins');
    showTurnSummary({ turnIncome: result.turnIncome, turnUpkeep: result.turnUpkeep, turnRepair: result.turnRepair, note });
    const payee = result.turnIncome && getPlayer(game, result.turnIncome.seat);
    if (payee && !isCpu(payee) && (paid > 0 || (result.turnUpkeep?.amount ?? 0) > 0)) tipOnScreen('income');
    checkDistress();
    bus.emit('game:move', result);
  };
  const next = currentPlayer(game);
  // A new mayor's turn: a soft chime, just after the road's own sound.
  if (next.seat !== mover.seat) setTimeout(() => { if (game && currentPlayer(game).seat === next.seat) play('turn'); }, 260);
  if (result.turnIncome && result.turnIncome.seat !== mover.seat && needsHandoff(next)) showHandoff(next, finishTransition);
  else {
    if (!isCpu(next)) lastHuman = next.seat;
    finishTransition();
  }
}

/* ---------------- CPU turns ---------------- */

const bonusTotal = (seat) => game.board.blocks.filter((b) => b.ownerSeat === seat).reduce((s, b) => s + bonusIncome(b), 0);

/**
 * Runs a sealed redevelopment auction opened by the current mayor (person or CPU): each person
 * at the table bids alone behind a privacy screen (js/ui/auctionView.js), CPU bids stay hidden,
 * then the result is revealed. Nothing changes until it resolves, and an all-pass auction
 * changes nothing, so the turn always carries on. Afterwards the device goes back to the mayor
 * on turn (a handoff if someone else bid last), and a person who just cleared a lot on their
 * own turn goes straight to the build choices if they still have an action.
 */
function runAuction(blockId, mode) {
  const opener = currentPlayer(game);
  startAuction(game, {
    blockId, mode, holderSeat: isCpu(opener) ? lastHuman : opener.seat,
    onDone: (result, { holder }) => {
      if (!game) return;
      if (holder != null) lastHuman = holder;
      const me = currentPlayer(game);
      const buildNow = () => {
        render();
        if (result.ok && result.mode === ACQUIRE_MODES.REBUILD && result.winnerSeat === me.seat && !isCpu(me)
          && !outOfCityActions(game)) openBuildPanel(game, result.block);
      };
      if (!isCpu(me) && needsHandoff(me)) showHandoff(me, buildNow);
      else buildNow();
    },
  });
}

/**
 * Right after an auction resolves: save, redraw and sound off (the dialog shows the details).
 * Saved at once: the sealed bids are now revealed, so a reload must never replay the auction.
 */
function auctionSettled(result) {
  if (result.ok) {
    play('coins');
    clearSelection();
  }
  saveNow();
  render();
}

/** Blocks a road would claim right now (for "Claiming C3 & D3"). */
function claimsOf(g, road) {
  return roadBlocks(g.board, road).filter((b) => b.ownerSeat == null && !b.abandoned && builtSides(g.board, b) === 3);
}

/** What a CPU road choice looks like in the thinking strip. */
function roadIntent(g, d) {
  const claims = claimsOf(g, d.road).map((b) => b.label).join(' & ');
  const text = {
    capture: `Claiming ${claims}`,
    'double-deal': 'Giving up a pair to take the longer chain',
    sacrifice: 'No safe roads left: giving away as little as it can',
    risky: 'Paving a risky road',
  }[d.reason] ?? 'Paving a road';
  return { text, target: `#board [data-road="${d.road}"]` };
}

/**
 * Plans one CPU step: a decision from core/cpu, described for the thinking strip ("Building a
 * Landmark on C3", with the road or block it will use highlighted), and `run`, which plays it
 * through the same handlers and core actions a person's clicks use (placeRoad via handleRoad,
 * buildOnBlock/upgradeBlock via handleDevelopment, resolveCapture, downgrade/sale, bankruptcy,
 * the redevelopment auction). The driver runs it only if the game is still exactly as planned.
 */
/** CPU playback is Full (every step paced and announced); Brief and Instant keep routine steps quiet. */
const fullPlayback = () => getSettings().cpuPlayback === 'full';

function cpuPlan(g) {
  const me = currentPlayer(g);
  if (g.turnPhase === TURN_PHASES.PAVE_ROAD || g.turnPhase === TURN_PHASES.BONUS_ROAD) {
    const d = chooseRoad(g);
    if (!d.road) return { text: null, run: () => render() };
    // Captures (and the final road, which starts the City era) are major; a quiet road is routine.
    const major = claimsOf(g, d.road).length > 0 || roadsRemaining(g) === 1;
    return { ...roadIntent(g, d), major, run: () => handleRoad(d.road, { cpu: true }) };
  }
  const d = chooseCityAction(g);
  const label = (id) => getBlockById(g.board, id).label;
  const blockTarget = (id) => `#board [data-block="${id}"]`;
  switch (d.action) {
    case 'end-turn':
      return {
        text: d.reason === 'no-actions' ? 'Out of City Actions: ending the turn' : 'Done for this City turn',
        run: () => handleEndTurn({ cpu: true }),
      };
    case 'pave':
      return {
        text: d.reason === 'no-actions' ? 'Development Action used: heading out to pave' : 'Done building: heading out to pave',
        run: () => {
          if (startPaving(g)) {
            autosave();
            render();
          }
        },
      };
    case 'build':
    case 'upgrade': {
      const block = getBlockById(g.board, d.blockId);
      const text = d.action === 'build'
        ? `Building ${/^[aeiou]/i.test(getCategory(d.type).label) ? 'an' : 'a'} ${getCategory(d.type).label} on ${block.label}`
        : `Upgrading ${block.label} to Level ${block.level + 1}`;
      return {
        text,
        target: blockTarget(d.blockId),
        run: () => {
          const bonusBefore = bonusTotal(me.seat);
          const result = d.action === 'build' ? buildOnBlock(g, d.blockId, d.type) : upgradeBlock(g, d.blockId);
          if (!result.ok) return render();
          if (fullPlayback()) toast(`${me.name} ${d.action === 'build' ? 'builds' : 'upgrades to'} ${describeDevelopment(getBlockById(g.board, result.block))} on ${label(result.block)} · −${formatCash(result.cost)}`, { tone: 'success' });
          return handleDevelopment({ ...result, bonusBefore, cpu: true });
        },
      };
    }
    case 'vacant':
      return {
        text: `Leaving ${label(d.blockId)} vacant for now`,
        target: blockTarget(d.blockId),
        run: () => {
          if (fullPlayback()) toast(`${me.name} leaves ${label(d.blockId)} vacant`);
          leaveCapturedBlock(d.blockId);
        },
      };
    case 'downgrade':
    case 'sell':
      return {
        text: `In debt: ${d.action === 'sell' ? 'selling' : 'downgrading'} ${label(d.blockId)}`,
        target: blockTarget(d.blockId),
        major: true,
        run: () => {
          const result = (d.action === 'sell' ? sellDevelopment : downgradeBlock)(g, d.blockId);
          if (result.ok) toast(`${me.name} ${d.action === 'sell' ? 'sells' : 'downgrades'} ${label(d.blockId)} to pay debts · +${formatCash(result.refund)}`, { tone: 'warn' });
          autosave();
          render();
        },
      };
    case 'bankruptcy':
      return {
        text: 'Out of options: declaring bankruptcy',
        major: true,
        run: () => {
          const result = declareBankruptcy(g);
          if (result.ok) {
            toast(`${me.name} declares bankruptcy: ${result.abandoned.length} block${result.abandoned.length === 1 ? '' : 's'} abandoned, `
              + `restarts with ${formatCash(result.capital)} (final score −${formatCash(result.penalty.cityValue)})`, { tone: 'warn', duration: 3600 });
          }
          autosave();
          render();
        },
      };
    case 'takeover':
      return {
        text: `Hostile takeover of ${label(d.blockId)}: its development out-pressures the owner`,
        target: blockTarget(d.blockId),
        major: true,
        run: () => {
          const from = getBlockById(g.board, d.blockId).ownerSeat;
          const result = takeoverBlock(g, d.blockId);
          if (result.ok) {
            toast(`${me.name} takes over ${label(d.blockId)} from ${getPlayer(g, from).name} · ${formatCash(result.cost)} `
              + `(${formatCash(result.marketValue)} to the owner)`, { tone: 'warn', duration: 3200 });
            play('coins');
          }
          autosave();
          render();
        },
      };
    case 'redevelop':
      return {
        text: `Opening bidding on abandoned ${label(d.blockId)}`,
        target: blockTarget(d.blockId),
        major: true,
        run: () => {
          const block = getBlockById(g.board, d.blockId);
          toast(`${me.name} opens bidding on abandoned Block ${block.label}`);
          // People at the table bid one at a time, sealed; the bots' bids stay hidden.
          runAuction(d.blockId, d.mode);
        },
      };
    default:
      return { text: null, run: () => render() };
  }
}

/**
 * The driver's safety net when a CPU step changed nothing twice in a row: finish managing and
 * go pave, or leave the pending capture vacant. Null when neither applies.
 */
function cpuFallback(g) {
  if (g.turnPhase === TURN_PHASES.CAPTURE_DEVELOP && g.pendingCaptures.length) {
    const blockId = g.pendingCaptures[0];
    return { text: null, run: () => leaveCapturedBlock(blockId) };
  }
  if (g.turnPhase === TURN_PHASES.MANAGE_CITY && currentPlayer(g).cash >= 0) {
    if (g.era === ERAS.CITY) return { text: null, run: () => handleEndTurn({ cpu: true }) };
    return { text: null, run: () => { if (startPaving(g)) autosave(); render(); } };
  }
  return null;
}

/** The CPU may act only when nothing else needs the table. */
function cpuCanAct() {
  return Boolean(game) && document.body.dataset.activeScreen === 'game' && !document.querySelector('dialog[open]');
}

function startGame(setup) {
  // Reset every piece of per-game UI state before the new game object exists.
  closeBuildPanel();
  cancelCityIntro();
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  clearToasts();
  disarm();
  // Development art and effects are needed as soon as blocks are captured.
  preloadSheets(['roads', 'buildings', 'civic', 'parks', 'props', 'effects', 'markers', 'icons']);
  stopCpu();
  cancelAuction();
  clearAchievementPops();
  lastSetup = setup;
  clearActiveGame();
  tutorialNewGame();
  // setup.seed (from the seed box, a challenge link or Replay Same City) deals a specific city; none = random.
  game = createGame(setup);
  analyticsMatchSerial += 1;
  trackGameEvent('game_started', { mode: game.mode }, analyticsMatchSerial);
  lastHuman = isCpu(currentPlayer(game)) ? null : currentPlayer(game).seat;
  $('#board-frame').classList.remove('is-city-complete');
  chain = 0;
  renderChain();
  clearSelection();
  render();
  resetTo('game');
  saveNow(); // the new game replaces the cleared save at once
  toast(`${currentPlayer(game).name} goes first`);
}

function leaveForTitle() {
  autosaver.cancel(); // Save & Quit has already saved; Abandon and the end of a match clear the save
  renderer.cancel(); // nothing left to draw
  stopCpu();
  cancelAuction();
  cancelCityIntro();
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  clearToasts();
  clearAchievementPops();
  disarm();
  clearSelection();
  game = null;
  resetTo('title');
  refreshSavedGameControls();
}

function saveAndQuit() {
  saveNow();
  leaveForTitle();
}

function abandonGame() {
  autosaver.cancel();
  clearActiveGame();
  leaveForTitle();
}

function continueGame(saved = loadActiveGame()) {
  if (!saved) return refreshSavedGameControls();
  closeBuildPanel();
  cancelCityIntro();
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  clearToasts();
  disarm();
  clearSelection();
  stopCpu();
  cancelAuction();
  clearAchievementPops();
  game = saved.game;
  analyticsMatchSerial += 1;
  lastSetup = saved.setup;
  lastHuman = isCpu(currentPlayer(game)) ? null : currentPlayer(game).seat;
  chain = 0;
  renderChain();
  preloadSheets(['roads', 'buildings', 'civic', 'parks', 'props', 'effects', 'markers', 'icons']);
  render();
  resetTo('game');
  if (game.turnPhase === TURN_PHASES.CAPTURE_DEVELOP && game.pendingCaptures.length) showCaptureChoice();
  checkDistress();
  toast('Game restored', { tone: 'success' });
}

/** Top-bar mute switch: the same saved "Sound" setting as the Settings screen. */
function initMuteButton() {
  const btn = $('#mute-btn');
  const sync = () => {
    const muted = !getSettings().sound;
    btn.setAttribute('aria-pressed', String(muted));
    btn.setAttribute('aria-label', muted ? 'Unmute sound' : 'Mute sound');
    btn.title = muted ? 'Sound off' : 'Sound on';
    btn.querySelector('.btn__icon').replaceWith(createSprite(muted ? 'icons:mute' : 'icons:sound', { className: 'btn__icon' }));
  };
  btn.addEventListener('click', () => {
    updateSettings({ sound: !getSettings().sound });
    play('tick');
  });
  bus.on('settings:changed', sync);
  sync();
}

function initDialogs() {
  const pause = $('#pause-dialog');
  $('#game-menu-btn').addEventListener('click', () => {
    $('#pause-mode').textContent = game ? `${modeName(game)} rules · Round ${game.round}` : '';
    $('#pause-seed').textContent = game ? formatSeed(game.seed) : '';
    pause.showModal();
    audio.setPaused(true);
  });
  pause.addEventListener('close', () => audio.setPaused(false));
  initMuteButton();
  pause.addEventListener('click', (e) => {
    // Clicking the backdrop closes the dialog.
    if (e.target === pause) return pause.close();
    const action = e.target.closest('[data-dialog-action]')?.dataset.dialogAction;
    if (!action) return;
    pause.close();
    if (action === 'howto') showScreen('howto');
    if (action === 'save-quit') saveAndQuit();
    if (action === 'abandon') $('#abandon-dialog').showModal();
  });

  const results = $('#results-dialog');
  results.addEventListener('click', (e) => {
    const action = e.target.closest('[data-results-action]')?.dataset.resultsAction;
    if (!action) return;
    if (action === 'copy-link') return void copyChallengeLink(game);
    results.close();
    // Play Again: same table and rules, a fresh city. Replay Same City: the same seed too.
    if (action === 'rematch') startGame({ ...lastSetup, seed: undefined });
    if (action === 'replay') startGame(replaySetup(game, lastSetup));
    if (action === 'title') leaveForTitle();
  });
  const abandon = $('#abandon-dialog');
  abandon.addEventListener('click', (e) => {
    const action = e.target.closest('[data-abandon-action]')?.dataset.abandonAction;
    if (!action) return;
    abandon.close();
    if (action === 'confirm') abandonGame();
  });
}

export function initGameView() {
  setAnalyticsContext(() => game ? {
    mode: game.mode, round: game.round, match_id: analyticsMatchSerial,
    game_state: game.phase, era: game.era, turn_phase: game.turnPhase,
  } : { game_state: 'menu' });
  initBoardView({ onBlockSelect: handleBlockSelect, onRoadSelect: handleRoad, onRoadArmed: handleRoadArmed });
  const info = $('#info-dialog');
  info.addEventListener('click', (e) => {
    if (e.target === info || e.target.closest('[data-info-close]')) info.close();
  });
  initBuildPanel({
    onChange: handleDevelopment,
    onLeave: ({ blockId }) => leaveCapturedBlock(blockId),
    onAuction: ({ blockId, mode }) => runAuction(blockId, mode),
  });
  initFinanceView({
    onChange: () => {
      autosave();
      render();
      // A person just went bankrupt: explain recovery (once).
      const me = game && currentPlayer(game);
      if (me && !isCpu(me) && game.lastBankruptcy?.seat === me.seat) tipOnScreen('recovery');
    },
  });
  $('#action-finance').addEventListener('click', () => openDistressPanel(game));
  $('#action-build').addEventListener('click', () => openBuildPanel(game, getSelectedBlock()));
  $('#action-end-turn').addEventListener('click', () => handleEndTurn());
  $('#action-pave').addEventListener('click', () => {
    if (startPaving(game)) {
      clearSelection();
      disarm();
      render();
      autosave();
    }
  });
  $('#capture-choice-dialog').addEventListener('cancel', (e) => e.preventDefault());
  $('#capture-choice-dialog').addEventListener('click', (e) => {
    const action = e.target.closest('[data-capture-choice]')?.dataset.captureChoice;
    if (!action || !game?.pendingCaptures.length) return;
    const blockId = game.pendingCaptures[0];
    $('#capture-choice-dialog').close();
    if (action === 'develop') openBuildPanel(game, blockId);
    if (action === 'vacant') leaveCapturedBlock(blockId);
  });
  $('#handoff-dialog').addEventListener('cancel', (e) => e.preventDefault());
  $('#handoff-ready').addEventListener('click', () => {
    $('#handoff-dialog').close();
    const ready = handoffReady;
    handoffReady = null;
    ready?.();
  });
  initDialogs();
  initAchievementView({ getSettings });
  initCpuDriver({
    getGame: () => game,
    canAct: cpuCanAct,
    plan: cpuPlan,
    fallback: cpuFallback,
    pause: () => $('#game-menu-btn').click(),
    getSettings,
    setSpeed: (cpuSpeed) => updateSettings({ cpuSpeed }),
  });
  bus.on('screen:shown', () => kickCpu());
  initAuctionView({ onResolved: auctionSettled });
  $('#city-view-btn').addEventListener('click', toggleCityView);
  bus.on('settings:changed', () => { if (game && document.body.dataset.activeScreen === 'game') applyCityView(); });
  // Changed in Settings: shown on the way back to the board.
  bus.on('screen:shown', ({ name }) => { if (name === 'game' && game) applyCityView(); });
  initCityIntro();
  initTutorial({ getGame: () => game });
  $('#action-results').addEventListener('click', showResults);
  initEventView({ getGame: () => game });
  bus.on('game:start', startGame);
  $('#continue-game').addEventListener('click', () => continueGame());
  $('#discard-save').addEventListener('click', () => {
    clearActiveGame();
    refreshSavedGameControls();
  });
  bus.on('screen:shown', ({ name }) => {
    if (name !== 'title') return;
    autosaver.flush();
    refreshSavedGameControls();
  });
  // Hiding, reloading or leaving the page (switching apps, closing the tab) writes a pending save
  // first, so a reload or a killed background tab resumes from the latest move.
  window.addEventListener('pagehide', () => autosaver.flush());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') autosaver.flush(); });
  refreshSavedGameControls();
  renderInspector(null);
}
