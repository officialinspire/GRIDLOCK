/** Game screen controller: wires core game state to board, HUD and actions. */
import { $, h } from './dom.js';
import { createSprite } from '../assets.js';
import { bus } from '../core/bus.js';
import { createGame, endTurn, currentPlayer, getPlayer, PHASES } from '../core/game.js';
import { getBlockById, DISTRICTS } from '../core/board.js';
import { getBuilding } from '../core/buildings.js';
import { blockIncome, formatCash, propertyValue } from '../core/economy.js';
import { renderBoard, initBoardView, clearSelection } from './boardView.js';
import { renderHud } from './hud.js';
import { showScreen, resetTo } from './router.js';
import { toast } from './toast.js';

let game = null;

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
  const building = block.buildingId ? getBuilding(block.buildingId) : null;
  const row = (k, v) => [h('dt', {}, k), h('dd', {}, v)];
  panel.replaceChildren(
    h('h3', { class: 'inspector__title' }, `Block ${block.label}`),
    h('dl', { class: 'inspector__facts' },
      row('District', DISTRICTS[block.district].label),
      row('Land value', formatCash(block.price)),
      row('Owner', owner ? owner.name : 'For sale'),
      row('Building', building ? building.name : 'Empty lot'),
      row('Income', owner ? `+${formatCash(blockIncome(block))}/round` : '—'),
    ),
  );
}

function render() {
  renderBoard(game);
  renderHud(game);
  $('#action-end-turn').disabled = game.phase !== PHASES.PLAYING;
}

function winnerSummary() {
  const ranked = [...game.players]
    .map((p) => ({ p, worth: p.cash + propertyValue(game.board, p.seat) }))
    .sort((a, b) => b.worth - a.worth);
  return `${ranked[0].p.name} wins with ${formatCash(ranked[0].worth)} net worth!`;
}

function handleEndTurn() {
  if (!game || game.phase !== PHASES.PLAYING) return;
  const result = endTurn(game);
  render();
  renderInspector(null);
  clearSelection();

  if (result.gameEnded) {
    toast(`Final round complete. ${winnerSummary()}`, { tone: 'success', duration: 6000 });
  } else if (result.roundEnded) {
    toast(`Income paid — Round ${game.round} begins`, { tone: 'success' });
  } else {
    toast(`${currentPlayer(game).name}, you're up!`);
  }
}

function startGame({ seats, settings }) {
  game = createGame({ seats, settings });
  clearSelection();
  render();
  renderInspector(null);
  resetTo('game');
  toast(`${currentPlayer(game).name} goes first`);
}

function initPauseDialog() {
  const dialog = $('#pause-dialog');
  $('#game-menu-btn').addEventListener('click', () => dialog.showModal());
  dialog.addEventListener('click', (e) => {
    // Clicking the backdrop closes the dialog.
    if (e.target === dialog) return dialog.close();
    const action = e.target.closest('[data-dialog-action]')?.dataset.dialogAction;
    if (!action) return;
    dialog.close();
    if (action === 'howto') showScreen('howto');
    if (action === 'quit') {
      game = null;
      resetTo('title');
    }
  });
}

export function initGameView() {
  initBoardView({ onBlockSelect: renderInspector });
  initPauseDialog();
  $('#action-end-turn').addEventListener('click', handleEndTurn);
  bus.on('game:start', startGame);
  renderInspector(null);
}

