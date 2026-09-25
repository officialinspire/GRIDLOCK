/**
 * Renders the city board as a (2n+1)² grid: streets on even rows/cols,
 * blocks on odd ones, so roads and intersections are real grid cells.
 */
import { $, h } from './dom.js';
import { createSprite } from '../assets.js';
import { PLAYER_PRESETS } from '../config.js';
import { DISTRICTS } from '../core/board.js';
import { getBuilding } from '../core/buildings.js';
import { getPlayer } from '../core/game.js';

let selectedId = null;
let onSelect = () => {};

function roadCell(r, c) {
  const kind = r % 2 === 0 && c % 2 === 0 ? 'x' : r % 2 === 0 ? 'h' : 'v';
  return h('span', { class: `road road--${kind}`, 'aria-hidden': 'true' });
}

function blockDescription(game, block) {
  const owner = block.ownerSeat ? getPlayer(game, block.ownerSeat) : null;
  const building = block.buildingId ? getBuilding(block.buildingId) : null;
  return [
    `Block ${block.label}`,
    DISTRICTS[block.district].label,
    owner ? `owned by ${owner.name}` : 'unowned',
    building?.name,
  ].filter(Boolean).join(', ');
}

function blockCell(game, block) {
  const color = block.ownerSeat ? PLAYER_PRESETS[block.ownerSeat - 1].color : null;
  const building = block.buildingId ? getBuilding(block.buildingId) : null;
  const selected = block.id === selectedId;

  return h('button', {
    type: 'button',
    class: `block block--${block.district}${color ? ` block--owned block--${color}` : ''}${selected ? ' is-selected' : ''}`,
    dataset: { block: block.id },
    'aria-label': blockDescription(game, block),
    'aria-pressed': selected ? 'true' : 'false',
  },
    createSprite('parks:empty-lot', { className: 'block__lot' }),
    color && createSprite(`markers:frame-${color}`, { className: 'block__frame' }),
    building && createSprite(building.sprite, { className: 'block__building' }),
    color && createSprite(`markers:post-${color}`, { className: 'block__flag' }),
    h('span', { class: 'block__coord', 'aria-hidden': 'true' }, block.label),
  );
}

export function renderBoard(game) {
  const { board } = game;
  const el = $('#board');
  el.style.setProperty('--rows', board.rows);
  el.style.setProperty('--cols', board.cols);

  const cells = [];
  for (let r = 0; r <= board.rows * 2; r++) {
    for (let c = 0; c <= board.cols * 2; c++) {
      if (r % 2 === 1 && c % 2 === 1) {
        cells.push(blockCell(game, board.blocks[((r - 1) / 2) * board.cols + (c - 1) / 2]));
      } else {
        cells.push(roadCell(r, c));
      }
    }
  }
  el.replaceChildren(...cells);
}

export function selectBlock(id) {
  selectedId = id;
  document.querySelectorAll('#board .block').forEach((btn) => {
    const on = btn.dataset.block === id;
    btn.classList.toggle('is-selected', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  onSelect(id);
}

export function clearSelection() {
  selectedId = null;
}

export function initBoardView({ onBlockSelect }) {
  onSelect = onBlockSelect;
  $('#board').addEventListener('click', (e) => {
    const btn = e.target.closest('.block');
    if (!btn) return;
    selectBlock(btn.dataset.block === selectedId ? null : btn.dataset.block);
  });
}
