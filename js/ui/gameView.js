/** Game screen controller: wires core game state to board, HUD and actions. */
import { $, h } from './dom.js';
import { createSprite, preloadSheets } from '../assets.js';
import { bus } from '../core/bus.js';
import {
  createGame, placeRoad, currentPlayer, getPlayer, standings, MOVE_ERRORS, PHASES,
} from '../core/game.js';
import { getBlockById, DISTRICTS, builtSides } from '../core/board.js';
import { describeDevelopment } from '../core/buildings.js';
import { blockIncome, blockValue, formatCash } from '../core/economy.js';
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
    owner && h('p', { class: 'inspector__dev', dataset: { type: block.type } }, describeDevelopment(block)),
    h('dl', { class: 'inspector__facts' },
      row('District', DISTRICTS[block.district].label),
      row('Roads', `${builtSides(game.board, block)} / 4`),
      row('Land value', formatCash(block.price)),
      row('Owner', owner ? owner.name : 'Unclaimed'),
      row('Income', owner ? `+${formatCash(blockIncome(block))}/turn` : '—'),
      owner && row('Value', formatCash(blockValue(block))),
    ),
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
  prompt.textContent = chain > 0
    ? `${p.name}: bonus road! Pave another.`
    : `${p.name}: pave a road.`;
}

function renderActions() {
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
  renderActions();
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
};

function handleRoad(id) {
  if (!game) return;
  const mover = currentPlayer(game);
  const result = placeRoad(game, id);

  if (!result.ok) {
    rejectRoad(id);
    toast(REJECT_MESSAGES[result.error] ?? 'You can’t build there.', { tone: 'warn', duration: 1600 });
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
  } else if (result.turnIncome?.amount > 0) {
    const payee = getPlayer(game, result.turnIncome.seat);
    toast(`${payee.name} collects ${formatCash(result.turnIncome.amount)} income`, { tone: 'success' });
  }
  bus.emit('game:move', result);
}

function startGame(setup) {
  closeBuildPanel();
  // Development art and effects are needed as soon as blocks are captured.
  preloadSheets(['buildings', 'civic', 'parks', 'effects', 'markers', 'icons']);
  lastSetup = setup;
  game = createGame(setup);
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
  initBuildPanel({ onChange: () => render() });
  $('#action-build').addEventListener('click', () => openBuildPanel(game, getSelectedBlock()));
  initDialogs();
  bus.on('game:start', startGame);
  renderInspector(null);
}
