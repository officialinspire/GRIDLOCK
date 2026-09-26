/** Game screen controller: wires core game state to board, HUD and actions. */
import { $, h } from './dom.js';
import { createSprite, preloadSheets } from '../assets.js';
import { bus } from '../core/bus.js';
import {
  createGame, placeRoad, currentPlayer, getPlayer, standings, MOVE_ERRORS, PHASES,
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
  renderBoard, initBoardView, clearSelection, rejectRoad, getSelectedBlock,
} from './boardView.js';
import { renderHud } from './hud.js';
import { showScreen, resetTo } from './router.js';
import { toast } from './toast.js';

let game = null;
let lastSetup = null;
let chain = 0; // blocks claimed by the current player during this turn

export const getGame = () => game;

function renderInspector(blockId) {
  const panel = $('#inspector');
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
      owner && row('Value', formatCash(blockValue(block))),
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
    prompt.textContent = 'Every block is claimed.';
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

function renderActions() {
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
  const player = currentPlayer(game);
  const after = game.board.blocks.filter((b) => b.ownerSeat === player.seat).reduce((s, b) => s + bonusIncome(b), 0);
  if (after > bonusBefore) toast(`★ Bonus income +${formatCash(after - bonusBefore)}/turn`, { tone: 'capture' });
}

function handleBlockSelect(id) {
  renderInspector(id);
  renderActions();
  if (id && game) openBuildPanel(game, id);
}

function flashFrame() {
  const frame = $('#board-frame');
  frame.classList.remove('is-capture');
  void frame.offsetWidth;
  frame.classList.add('is-capture');
}

function showResults() {
  const list = $('#results-list');
  list.replaceChildren(...standings(game).map((row) =>
    h('li', { class: `results__row results__row--${row.player.color}${row.rank === 1 ? ' is-winner' : ''}` },
      h('span', { class: 'results__rank' }, `#${row.rank}`),
      createSprite(`markers:chip-${row.player.color}`, { className: 'results__token' }),
      h('span', { class: 'results__name' }, row.player.name),
      h('span', { class: 'results__score' }, `${row.blocks} block${row.blocks === 1 ? '' : 's'}`),
      h('span', { class: 'results__worth' }, formatCash(row.worth)),
    )));
  const winners = standings(game).filter((r) => r.rank === 1);
  $('#results-heading').textContent = winners.length > 1
    ? 'A tie for Mayor!'
    : `${winners[0].player.name} runs the city!`;
  $('#results-dialog').showModal();
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
    toast(REJECT_MESSAGES[result.error] ?? 'You can’t build there.', { tone: 'warn', duration: 1600 });
    if (result.error === MOVE_ERRORS.IN_DISTRESS) openDistressPanel(game);
    return;
  }

  const n = result.captured.length;
  chain = result.extraTurn ? chain + n : 0;
  render();

  if (n > 0) {
    flashFrame();
    const labels = result.captured.map((bid) => getBlockById(game.board, bid).label).join(' & ');
    toast(`${mover.name} claims ${labels}! +${formatCash(result.reward)}${result.extraTurn ? ' · Bonus road' : ''}`,
      { tone: 'capture', duration: 2200 });
  }
  if (result.gameEnded) {
    setTimeout(showResults, n > 0 ? 700 : 0);
    bus.emit('game:move', result);
    return;
  }
  if (result.event?.started) {
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
  closeBuildPanel();
  $('#event-dialog').close();
  $('#finance-dialog').close();
  // Development art and effects are needed as soon as blocks are captured.
  preloadSheets(['buildings', 'civic', 'parks', 'effects', 'markers', 'icons']);
  lastSetup = setup;
  const seed = seedFromUrl();
  game = createGame(seed === undefined ? setup : { ...setup, seed });
  chain = 0;
  clearSelection();
  render();
  resetTo('game');
  toast(`${currentPlayer(game).name} goes first`);
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
    if (action === 'quit') {
      game = null;
      resetTo('title');
    }
  });

  const results = $('#results-dialog');
  results.addEventListener('click', (e) => {
    const action = e.target.closest('[data-results-action]')?.dataset.resultsAction;
    if (!action) return;
    results.close();
    if (action === 'rematch') startGame(lastSetup);
    if (action === 'title') {
      game = null;
      resetTo('title');
    }
  });
}

export function initGameView() {
  initBoardView({ onBlockSelect: handleBlockSelect, onRoadSelect: handleRoad });
  initBuildPanel({ onChange: handleDevelopment });
  initFinanceView({ onChange: () => render() });
  $('#action-finance').addEventListener('click', () => openDistressPanel(game));
  $('#action-build').addEventListener('click', () => openBuildPanel(game, getSelectedBlock()));
  initDialogs();
  initEventView({ getGame: () => game });
  bus.on('game:start', startGame);
  renderInspector(null);
}
