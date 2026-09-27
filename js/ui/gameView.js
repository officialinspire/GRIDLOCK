/** Game screen controller: wires core game state to board, HUD and actions. */
import { $, h } from './dom.js';
import { createSprite, preloadSheets } from '../assets.js';
import { ART } from '../art.js';
import { bus } from '../core/bus.js';
import {
  createGame, placeRoad, currentPlayer, getPlayer, MOVE_ERRORS, PHASES, TURN_PHASES,
  startPaving, resolveCapture,
} from '../core/game.js';
import { getBlockById, DISTRICTS, builtSides, roadBlocks } from '../core/board.js';
import { describeDevelopment, getCategory } from '../core/buildings.js';
import { blockValue, bonusIncome, formatCash, formatDelta } from '../core/economy.js';
import { bonusList } from './bonusView.js';
import { showEventCard, renderEventStrip, eventLines, initEventView } from './eventView.js';
import { effectiveBlockIncome, getEventDef } from '../core/events.js';
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
import { blockDetails } from '../core/forecast.js';
import { ECONOMY } from '../config.js';
import { modifierText } from './forecastView.js';
import { initTutorial, updateTutorial, tutorialMoment, tutorialMove, tutorialNewGame } from './tutorial.js';
import { getSettings, updateSettings } from './settingsView.js';
import { saveActiveGame, loadActiveGame, clearActiveGame } from '../core/persistence.js';
import { isCpu, controllerLabel } from '../core/seats.js';
import { chooseRoad } from '../core/cpu/roads.js';
import { chooseCityAction, cpuBids } from '../core/cpu/city.js';
import { buildOnBlock, upgradeBlock } from '../core/development.js';
import {
  downgradeBlock, sellDevelopment, declareBankruptcy, resolveRedevelopmentAuction, eligibleRedevelopers,
} from '../core/finance.js';
import { initCpuDriver, kickCpu, stopCpu, isCpuTurn } from './cpuDriver.js';

/** Must match the portrait/compact breakpoint in css/mobile.css. */
export const COMPACT_LAYOUT = '(orientation: portrait) and (max-width: 1100px), (max-width: 600px)';
const isCompact = () => globalThis.matchMedia?.(COMPACT_LAYOUT).matches ?? false;
let armHintShown = false;

let game = null;
let lastSetup = null;
let chain = 0; // blocks claimed by the current player during this turn
let lastHuman = null; // seat of the last person to have the device (for handoffs)
let cpuAuction = null; // { blockId, mode } while people bid in an auction a CPU mayor opened

export const getGame = () => game;

function refreshSavedGameControls() {
  const saved = loadActiveGame();
  $('#continue-game').hidden = !saved;
  $('#discard-save').hidden = !saved;
  return saved;
}

function autosave() {
  if (game?.phase === PHASES.PLAYING) saveActiveGame(game, lastSetup);
  refreshSavedGameControls();
}

/** Saves the game in progress right now (e.g. before an app update reloads the page). */
export function saveGameNow() {
  if (game?.phase === PHASES.PLAYING) saveActiveGame(game, lastSetup);
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
        `How much this block adds to ${owner.name}'s final score (land + ${Math.round(ECONOMY.SCORING.INVESTED_BUILDING * 100)}% of building investment)`),
      owner && d.eventPrice.length > 0 && row('Upgrade price', modifierText(d.eventPrice), 'City events changing build/upgrade prices for this category'),
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
  if (isInDistress(p)) {
    prompt.textContent = `${p.name} is ${formatCash(-p.cash)} in debt! Sell or downgrade to continue.`;
    return;
  }
  const copy = {
    [TURN_PHASES.MANAGE_CITY]: 'MANAGE CITY · Develop or upgrade, then choose Pave Road.',
    [TURN_PHASES.PAVE_ROAD]: 'PAVE ROAD · Choose one open road.',
    [TURN_PHASES.CAPTURE_DEVELOP]: 'CAPTURE / DEVELOP · Resolve each newly claimed block.',
    [TURN_PHASES.BONUS_ROAD]: 'BONUS ROAD · Pave another road.',
  }[game.turnPhase];
  prompt.textContent = `${p.name}: ${copy}`;
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
  const pave = $('#action-pave');
  pave.hidden = !(game && game.phase === PHASES.PLAYING && game.turnPhase === TURN_PHASES.MANAGE_CITY) || cpuTurn;
  pave.disabled = distress;
}

function render() {
  renderBoard(game);
  renderHud(game);
  renderPrompt();
  renderInspector(getSelectedBlock());
  renderEventStrip(game);
  renderActions();
  // A bot's turn: the board waits (clicks are politely refused) and the first time, a tip explains.
  const botTurn = isCpuTurn(game);
  $('#board-frame').classList.toggle('is-cpu-turn', botTurn);
  updateTutorial();
  kickCpu();
  if (botTurn) tutorialMoment('cpu');
}

/** Re-render after a build/upgrade/sale and celebrate any new bonus income. */
function handleDevelopment(change) {
  const { bonusBefore } = change;
  if (change.winnerSeat != null) cpuAuction = null; // people settled the CPU's auction in the panel
  const captured = game.turnPhase === TURN_PHASES.CAPTURE_DEVELOP ? game.pendingCaptures[0] : null;
  if (captured) resolveCapture(game, captured);
  autosave();
  // Sales/downgrades pay a refund; Level 2–3 is an upgrade; anything else is new construction.
  const kind = change.refund > 0 ? 'coins' : change.level >= 2 && !change.mode ? 'upgrade' : 'build';
  play(kind);
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
  if (!game || game.turnPhase !== TURN_PHASES.CAPTURE_DEVELOP || isCpuTurn()) {
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
  // People leaving an auction a CPU mayor opened are passing: the CPU bids decide it.
  if (cpuAuction?.blockId === blockId) return settleCpuAuction();
  if (!game || game.turnPhase !== TURN_PHASES.CAPTURE_DEVELOP || game.pendingCaptures[0] !== blockId) return;
  resolveCapture(game, blockId);
  autosave();
  showCaptureChoice();
}

function handleBlockSelect(id) {
  renderInspector(id);
  renderActions();
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
  const frame = $('#board-frame');
  frame.classList.remove('is-capture');
  void frame.offsetWidth;
  frame.classList.add('is-capture');
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
  if (chain) {
    meter.classList.remove('is-bumped');
    void meter.offsetWidth;
    meter.classList.add('is-bumped');
  }
}

/** Brief, non-blocking breakdown of the income that was just paid. */
function showEconomyFeedback(turnIncome, turnUpkeep, turnRepair) {
  if (!turnIncome) return;
  const seat = turnIncome.seat;
  const gross = turnIncome.amount;
  const upkeep = turnUpkeep?.amount ?? 0;
  const repair = turnRepair?.amount ?? 0;
  const net = gross - upkeep - repair;
  const blocks = game.board.blocks.filter((b) => b.ownerSeat === seat && effectiveBlockIncome(game, b) > 0);
  for (const block of blocks) {
    const cell = document.querySelector(`[data-block="${block.id}"]`);
    if (!cell) continue;
    const chip = h('span', { class: `block-income block-income--seat-${seat}`, 'aria-hidden': 'true' },
      `+${formatCash(effectiveBlockIncome(game, block))}`);
    cell.append(chip);
    setTimeout(() => chip.remove(), 1250);
  }
  const summary = $('#economy-summary');
  summary.replaceChildren(
    h('strong', {}, `+${formatCash(gross)}`),
    h('span', {}, ` Gross Income − ${formatCash(upkeep)} Upkeep${repair ? ` − ${formatCash(repair)} Repairs` : ''} = `),
    h('strong', {}, `${net < 0 ? '−' : '+'}${formatCash(Math.abs(net))} Net`),
  );
  summary.dataset.seat = seat;
  summary.hidden = false;
  summary.classList.remove('is-showing');
  void summary.offsetWidth;
  summary.classList.add('is-showing');
  setTimeout(() => { summary.hidden = true; }, 1800);
}


const REJECT_MESSAGES = {
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
    stopCpu();
    $('#board-frame').classList.add('is-city-complete');
    // Career stats/achievements: counted only if this match was genuinely played to the end.
    recordFinishedMatch(game);
    clearActiveGame();
    refreshSavedGameControls();
    setTimeout(() => {
      if (game?.results) {
        play('win');
        buzz('win');
      }
      showResults();
    }, n > 0 ? 700 : 0);
    bus.emit('game:move', result);
    return;
  }
  autosave();
  if (n > 0) showCaptureChoice();
  const finishTransition = () => {
    if (result.event?.started) {
      play('event', { kind: getEventDef(result.event.started.id)?.kind });
      buzz('event');
      showEventCard(game, result.event.started, result.event.expired);
      tutorialMoment('events');
    } else if (result.event?.expired.length) {
      toast(`City event over: ${result.event.expired.map((e) => getEventDef(e.id)?.name ?? e.id).join(', ')}`);
    } else if (result.event?.calm) {
      toast('Calm round · no new city event', { tone: 'success' });
    }
    const paid = result.turnIncome?.amount ?? 0;
    const owed = result.turnUpkeep?.amount ?? 0;
    const repairs = result.turnRepair?.amount ?? 0;
    if (result.turnIncome && (paid > 0 || owed > 0 || repairs > 0)) {
      if (paid > 0 && !result.event?.started) play('coins');
      showEconomyFeedback(result.turnIncome, result.turnUpkeep, result.turnRepair);
      const payee = getPlayer(game, result.turnIncome.seat);
      if (!isCpu(payee)) tutorialMoment('income');
      const parts = [paid > 0 && `+${formatCash(paid)} income`, owed > 0 && `−${formatCash(owed)} upkeep`,
        repairs > 0 && `−${formatCash(repairs)} repairs`].filter(Boolean);
      toast(`${payee.name}: ${parts.join(', ')}`, {
        tone: result.turnUpkeep?.distress || result.turnRepair?.distress ? 'warn' : 'success',
      });
    }
    checkDistress();
    bus.emit('game:move', result);
  };
  const next = currentPlayer(game);
  if (result.turnIncome && result.turnIncome.seat !== mover.seat && needsHandoff(next)) showHandoff(next, finishTransition);
  else {
    if (!isCpu(next)) lastHuman = next.seat;
    finishTransition();
  }
}

/* ---------------- CPU turns ---------------- */

const bonusTotal = (seat) => game.board.blocks.filter((b) => b.ownerSeat === seat).reduce((s, b) => s + bonusIncome(b), 0);

/** Settles an auction a CPU mayor opened: CPU sealed bids plus whatever people entered (none if they left). */
function settleCpuAuction(humanBids = []) {
  if (!cpuAuction || !game) return;
  const { blockId, mode } = cpuAuction;
  cpuAuction = null;
  const result = resolveRedevelopmentAuction(game, blockId, mode, [...cpuBids(game, blockId, mode), ...humanBids]);
  if (result.ok) {
    toast(`${getPlayer(game, result.winnerSeat).name} wins redevelopment · ${formatCash(result.cost)}`, { tone: 'success' });
    play('coins');
  }
  autosave();
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
function cpuPlan(g) {
  const me = currentPlayer(g);
  if (g.turnPhase === TURN_PHASES.PAVE_ROAD || g.turnPhase === TURN_PHASES.BONUS_ROAD) {
    const d = chooseRoad(g);
    if (!d.road) return { text: null, run: () => render() };
    return { ...roadIntent(g, d), run: () => handleRoad(d.road, { cpu: true }) };
  }
  const d = chooseCityAction(g);
  const label = (id) => getBlockById(g.board, id).label;
  const blockTarget = (id) => `#board [data-block="${id}"]`;
  switch (d.action) {
    case 'pave':
      return {
        text: 'Done building: heading out to pave',
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
          toast(`${me.name} ${d.action === 'build' ? 'builds' : 'upgrades to'} ${describeDevelopment(getBlockById(g.board, result.block))} on ${label(result.block)} · −${formatCash(result.cost)}`, { tone: 'success' });
          return handleDevelopment({ ...result, bonusBefore, cpu: true });
        },
      };
    }
    case 'vacant':
      return {
        text: `Leaving ${label(d.blockId)} vacant for now`,
        target: blockTarget(d.blockId),
        run: () => {
          toast(`${me.name} leaves ${label(d.blockId)} vacant`);
          leaveCapturedBlock(d.blockId);
        },
      };
    case 'downgrade':
    case 'sell':
      return {
        text: `In debt: ${d.action === 'sell' ? 'selling' : 'downgrading'} ${label(d.blockId)}`,
        target: blockTarget(d.blockId),
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
        run: () => {
          const result = declareBankruptcy(g);
          if (result.ok) toast(`${me.name} declares bankruptcy: ${result.abandoned.length} block${result.abandoned.length === 1 ? '' : 's'} abandoned`, { tone: 'warn', duration: 3200 });
          autosave();
          render();
        },
      };
    case 'redevelop':
      return {
        text: `Opening bidding on abandoned ${label(d.blockId)}`,
        target: blockTarget(d.blockId),
        run: () => {
          cpuAuction = { blockId: d.blockId, mode: d.mode };
          const block = getBlockById(g.board, d.blockId);
          const people = eligibleRedevelopers(g, block).filter((p) => !isCpu(p));
          toast(`${me.name} opens bidding on abandoned Block ${block.label}`);
          // People at the table may bid (sealed, in the auction panel); otherwise it settles at once.
          if (people.length && openBuildPanel(g, d.blockId)) return;
          settleCpuAuction();
        },
      };
    default:
      return { text: null, run: () => render() };
  }
}

/** The CPU may act only when nothing else needs the table. */
function cpuCanAct() {
  return Boolean(game) && document.body.dataset.activeScreen === 'game' && !document.querySelector('dialog[open]');
}

function startGame(setup) {
  // Reset every piece of per-game UI state before the new game object exists.
  closeBuildPanel();
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  clearToasts();
  disarm();
  // Development art and effects are needed as soon as blocks are captured.
  preloadSheets(['roads', 'buildings', 'civic', 'parks', 'props', 'effects', 'markers', 'icons']);
  stopCpu();
  cpuAuction = null;
  lastSetup = setup;
  clearActiveGame();
  tutorialNewGame();
  // setup.seed (from the seed box, a challenge link or Replay Same City) deals a specific city; none = random.
  game = createGame(setup);
  lastHuman = isCpu(currentPlayer(game)) ? null : currentPlayer(game).seat;
  $('#board-frame').classList.remove('is-city-complete');
  chain = 0;
  renderChain();
  clearSelection();
  render();
  resetTo('game');
  autosave();
  toast(`${currentPlayer(game).name} goes first`);
}

function leaveForTitle() {
  stopCpu();
  cpuAuction = null;
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  clearToasts();
  disarm();
  clearSelection();
  game = null;
  resetTo('title');
  refreshSavedGameControls();
}

function saveAndQuit() {
  autosave();
  leaveForTitle();
}

function abandonGame() {
  clearActiveGame();
  leaveForTitle();
}

function continueGame(saved = loadActiveGame()) {
  if (!saved) return refreshSavedGameControls();
  closeBuildPanel();
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  clearToasts();
  disarm();
  clearSelection();
  stopCpu();
  cpuAuction = null;
  game = saved.game;
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
  initBoardView({ onBlockSelect: handleBlockSelect, onRoadSelect: handleRoad, onRoadArmed: handleRoadArmed });
  const info = $('#info-dialog');
  info.addEventListener('click', (e) => {
    if (e.target === info || e.target.closest('[data-info-close]')) info.close();
  });
  initBuildPanel({ onChange: handleDevelopment, onLeave: ({ blockId }) => leaveCapturedBlock(blockId) });
  initFinanceView({ onChange: () => { autosave(); render(); } });
  $('#action-finance').addEventListener('click', () => openDistressPanel(game));
  $('#action-build').addEventListener('click', () => openBuildPanel(game, getSelectedBlock()));
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
  initCpuDriver({
    getGame: () => game,
    canAct: cpuCanAct,
    plan: cpuPlan,
    pause: () => $('#game-menu-btn').click(),
    getSettings,
    setSpeed: (cpuSpeed) => updateSettings({ cpuSpeed }),
  });
  bus.on('screen:shown', () => kickCpu());
  // However people close an auction a CPU opened (Leave it, backdrop, Escape), it still settles.
  $('#build-dialog').addEventListener('close', () => settleCpuAuction());
  initTutorial({ getGame: () => game });
  $('#action-results').addEventListener('click', showResults);
  initEventView({ getGame: () => game });
  bus.on('game:start', startGame);
  $('#continue-game').addEventListener('click', () => continueGame());
  $('#discard-save').addEventListener('click', () => {
    clearActiveGame();
    refreshSavedGameControls();
  });
  bus.on('screen:shown', ({ name }) => { if (name === 'title') refreshSavedGameControls(); });
  refreshSavedGameControls();
  renderInspector(null);
}
