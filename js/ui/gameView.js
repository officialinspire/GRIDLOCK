/** Game screen controller: wires core game state to board, HUD and actions. */
import { $, h } from './dom.js';
import { createSprite, preloadSheets } from '../assets.js';
import { ART } from '../art.js';
import { bus } from '../core/bus.js';
import {
  createGame, placeRoad, currentPlayer, getPlayer, MOVE_ERRORS, PHASES,
} from '../core/game.js';
import { getBlockById, DISTRICTS, builtSides } from '../core/board.js';
import { describeDevelopment } from '../core/buildings.js';
import { blockValue, bonusIncome, formatCash } from '../core/economy.js';
import { bonusList } from './bonusView.js';
import { showEventCard, renderEventStrip, eventLines, initEventView } from './eventView.js';
import { effectiveBlockIncome, getEventDef } from '../core/events.js';
import { initFinanceView, openDistressPanel } from './financeView.js';
import { isInDistress, blockUpkeep } from '../core/economy.js';
import { isDeveloped } from '../core/development.js';
import { initBuildPanel, openBuildPanel, closeBuildPanel, canManage } from './buildPanel.js';
import {
  renderBoard, initBoardView, clearSelection, rejectRoad, getSelectedBlock, disarm,
} from './boardView.js';
import { renderHud } from './hud.js';
import { showResults as openResults } from './resultsView.js';
import { showScreen, resetTo } from './router.js';
import { toast, clearToasts } from './toast.js';
import { play } from './sfx.js';

/** Must match the portrait/compact breakpoint in css/mobile.css. */
export const COMPACT_LAYOUT = '(orientation: portrait) and (max-width: 1100px), (max-width: 600px)';
const isCompact = () => globalThis.matchMedia?.(COMPACT_LAYOUT).matches ?? false;
let armHintShown = false;

let game = null;
let lastSetup = null;
let chain = 0; // blocks claimed by the current player during this turn

export const getGame = () => game;

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
  const row = (k, v) => [h('dt', {}, k), h('dd', {}, v)];
  panel.replaceChildren(...[
    h('h3', { class: 'inspector__title' }, `Block ${block.label}`),
    (owner || block.abandoned) && h('p', { class: 'inspector__dev', dataset: { type: block.type } },
      describeDevelopment(block), block.abandoned ? ' (inactive)' : ''),
    h('dl', { class: 'inspector__facts' },
      row('District', DISTRICTS[block.district].label),
      row('Roads', `${builtSides(game.board, block)} / 4`),
      row('Land value', formatCash(block.price)),
      row('Owner', owner ? owner.name : 'Unclaimed'),
      row('Income', owner ? `+${formatCash(effectiveBlockIncome(game, block))}/turn` : '—'),
      owner && row('Upkeep', `−${formatCash(blockUpkeep(block))}/turn`),
      owner && row('City value', formatCash(blockValue(block))),
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
  prompt.textContent = chain > 0
    ? `${p.name}: bonus road! Pave another.`
    : `${p.name}: pave a road.`;
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
}

function renderActions() {
  $('#action-results').hidden = !(game && game.phase === PHASES.ENDED);
  const distress = Boolean(game && game.phase === PHASES.PLAYING && isInDistress(currentPlayer(game)));
  $('#action-finance').hidden = !distress;
  const build = $('#action-build');
  const manageable = game && canManage(game, getSelectedBlock());
  build.disabled = !manageable;
  build.title = manageable ? 'Develop the selected block' : 'Select one of your blocks to develop it';
}

function render() {
  renderBoard(game);
  renderHud(game);
  renderPrompt();
  renderInspector(getSelectedBlock());
  renderEventStrip(game);
  renderActions();
}

/** Re-render after a build/upgrade and celebrate any new bonus income. */
function handleDevelopment({ bonusBefore }) {
  render();
  play('build');
  const player = currentPlayer(game);
  const after = game.board.blocks.filter((b) => b.ownerSeat === player.seat).reduce((s, b) => s + bonusIncome(b), 0);
  if (after > bonusBefore) toast(`★ Bonus income +${formatCash(after - bonusBefore)}/turn`, { tone: 'capture' });
}

function handleBlockSelect(id) {
  renderInspector(id);
  renderActions();
  if (!id || !game) return;
  if (openBuildPanel(game, id)) return;
  // Compact (portrait) layouts hide the side inspector: show the same details in a bottom sheet.
  if (isCompact()) {
    renderInspector(id, $('#info-body'));
    $('#info-dialog').showModal();
  }
}

function handleRoadArmed() {
  play('pave');
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


const REJECT_MESSAGES = {
  [MOVE_ERRORS.TAKEN]: 'That road is already paved.',
  [MOVE_ERRORS.INVALID]: "That's not a road.",
  [MOVE_ERRORS.GAME_OVER]: 'The game is over.',
  [MOVE_ERRORS.IN_DISTRESS]: 'Resolve your debt before paving.',
};

/** Opens the distress panel for the current player, after any event card is dismissed. */
function checkDistress() {
  if (!game || game.phase !== PHASES.PLAYING || !isInDistress(currentPlayer(game))) return;
  const eventCard = $('#event-dialog');
  if (eventCard.open) {
    eventCard.addEventListener('close', () => openDistressPanel(game), { once: true });
  } else {
    openDistressPanel(game);
  }
}

function handleRoad(id) {
  if (!game) return;
  const mover = currentPlayer(game);
  const result = placeRoad(game, id);

  if (!result.ok) {
    rejectRoad(id);
    play('error');
    toast(REJECT_MESSAGES[result.error] ?? 'You can’t build there.', { tone: 'warn', duration: 1600 });
    if (result.error === MOVE_ERRORS.IN_DISTRESS) openDistressPanel(game);
    return;
  }

  const n = result.captured.length;
  chain = result.extraTurn ? chain + n : 0;
  render();
  play(n > 0 ? 'capture' : 'pave');

  if (n > 0) {
    flashFrame();
    const labels = result.captured.map((bid) => getBlockById(game.board, bid).label).join(' & ');
    toast(`${mover.name} claims ${labels}! +${formatCash(result.reward)}${result.extraTurn ? ' · Bonus road' : ''}`,
      { tone: 'capture', duration: 2200 });
  }
  if (result.gameEnded) {
    setTimeout(() => {
      if (game?.results) play('win');
      showResults();
    }, n > 0 ? 700 : 0);
    bus.emit('game:move', result);
    return;
  }
  if (result.event?.started) {
    play('event');
    showEventCard(game, result.event.started, result.event.expired);
  } else if (result.event?.expired.length) {
    toast(`City event over: ${result.event.expired.map((e) => getEventDef(e.id)?.name ?? e.id).join(', ')}`);
  }
  const paid = result.turnIncome?.amount ?? 0;
  const owed = result.turnUpkeep?.amount ?? 0;
  if (result.turnIncome && (paid > 0 || owed > 0)) {
    const payee = getPlayer(game, result.turnIncome.seat);
    const parts = [paid > 0 && `+${formatCash(paid)} income`, owed > 0 && `−${formatCash(owed)} upkeep`].filter(Boolean);
    toast(`${payee.name}: ${parts.join(', ')}`, { tone: result.turnUpkeep?.distress ? 'warn' : 'success' });
  }
  checkDistress();
  bus.emit('game:move', result);
}

/** Optional ?seed=123 in the URL makes city events reproducible (handy for bug reports). */
function seedFromUrl() {
  const raw = new URLSearchParams(window.location.search).get('seed');
  const n = raw == null ? NaN : Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

function startGame(setup) {
  // Reset every piece of per-game UI state before the new game object exists.
  closeBuildPanel();
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  clearToasts();
  disarm();
  // Development art and effects are needed as soon as blocks are captured.
  preloadSheets(['roads', 'buildings', 'civic', 'parks', 'props', 'effects', 'markers', 'icons']);
  lastSetup = setup;
  const seed = seedFromUrl();
  game = createGame(seed === undefined ? setup : { ...setup, seed });
  chain = 0;
  clearSelection();
  render();
  resetTo('game');
  toast(`${currentPlayer(game).name} goes first`);
}

function quitToTitle() {
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  clearToasts();
  disarm();
  clearSelection();
  game = null;
  resetTo('title');
}

function initDialogs() {
  const pause = $('#pause-dialog');
  $('#game-menu-btn').addEventListener('click', () => pause.showModal());
  pause.addEventListener('click', (e) => {
    // Clicking the backdrop closes the dialog.
    if (e.target === pause) return pause.close();
    const action = e.target.closest('[data-dialog-action]')?.dataset.dialogAction;
    if (!action) return;
    pause.close();
    if (action === 'howto') showScreen('howto');
    if (action === 'quit') quitToTitle();
  });

  const results = $('#results-dialog');
  results.addEventListener('click', (e) => {
    const action = e.target.closest('[data-results-action]')?.dataset.resultsAction;
    if (!action) return;
    results.close();
    if (action === 'rematch') startGame(lastSetup);
    if (action === 'title') quitToTitle();
  });
}

export function initGameView() {
  initBoardView({ onBlockSelect: handleBlockSelect, onRoadSelect: handleRoad, onRoadArmed: handleRoadArmed });
  const info = $('#info-dialog');
  info.addEventListener('click', (e) => {
    if (e.target === info || e.target.closest('[data-info-close]')) info.close();
  });
  initBuildPanel({ onChange: handleDevelopment });
  initFinanceView({ onChange: () => render() });
  $('#action-finance').addEventListener('click', () => openDistressPanel(game));
  $('#action-build').addEventListener('click', () => openBuildPanel(game, getSelectedBlock()));
  initDialogs();
  $('#action-results').addEventListener('click', showResults);
  initEventView({ getGame: () => game });
  bus.on('game:start', startGame);
  renderInspector(null);
}
