/**
 * Renders the city board as a (2n+1)² grid:
 *   even row + even col → intersection (Dots & Boxes "dot")
 *   even row + odd col  → horizontal road slot   (h-r-c)
 *   odd row  + even col → vertical road slot     (v-r-c)
 *   odd row  + odd col  → city block
 * Road slots are buttons: tapping one paves the road between its two intersections.
 */
import { $, h } from './dom.js';
import { createSprite } from '../assets.js';
import { PLAYER_PRESETS } from '../config.js';
import { DISTRICTS, roadId, hasRoad, blockLabel, builtSides } from '../core/board.js';
import { getBuilding } from '../core/buildings.js';
import { getPlayer, currentPlayer, PHASES } from '../core/game.js';

let selectedId = null;
let handlers = { onBlockSelect() {}, onRoadSelect() {} };

const colorOf = (seat) => (seat ? PLAYER_PRESETS[seat - 1].color : null);

/** Intersections are labelled like blocks but on the (n+1)² lattice: A1…G7. */
const nodeLabel = (r, c) => blockLabel(r, c);

function roadLabel(dir, r, c) {
  return dir === 'h'
    ? `road from ${nodeLabel(r, c)} to ${nodeLabel(r, c + 1)}`
    : `road from ${nodeLabel(r, c)} to ${nodeLabel(r + 1, c)}`;
}

function nodeCell(board, r, c) {
  // An intersection looks paved once any road touching it is built.
  const touching = [roadId('h', r, c - 1), roadId('h', r, c), roadId('v', r - 1, c), roadId('v', r, c)];
  const paved = touching.some((id) => hasRoad(board, id));
  return h('span', { class: `node${paved ? ' is-paved' : ''}`, 'aria-hidden': 'true' });
}

function roadCell(game, dir, r, c) {
  const id = roadId(dir, r, c);
  const builder = game.board.roads[id];
  const built = builder != null;
  const last = game.lastMove?.road === id;
  const cls = ['road', `road--${dir}`];
  if (built) cls.push('is-built', `road--${colorOf(builder)}`);
  if (last) cls.push('is-last');

  const who = built ? getPlayer(game, builder)?.name : null;
  return h('button', {
    type: 'button',
    class: cls.join(' '),
    dataset: { road: id },
    'aria-label': built ? `${roadLabel(dir, r, c)}, paved by ${who}` : `Pave ${roadLabel(dir, r, c)}`,
    'aria-disabled': built || game.phase !== PHASES.PLAYING ? 'true' : null,
  }, h('span', { class: 'road__surface', 'aria-hidden': 'true' }));
}

function blockDescription(game, block) {
  const owner = block.ownerSeat ? getPlayer(game, block.ownerSeat) : null;
  const building = block.buildingId ? getBuilding(block.buildingId) : null;
  return [
    `Block ${block.label}`,
    DISTRICTS[block.district].label,
    owner ? `claimed by ${owner.name}` : `${builtSides(game.board, block)} of 4 roads`,
    building?.name,
  ].filter(Boolean).join(', ');
}

function blockCell(game, block) {
  const color = colorOf(block.ownerSeat);
  const building = block.buildingId ? getBuilding(block.buildingId) : null;
  const selected = block.id === selectedId;
  const fresh = game.lastMove?.captured.includes(block.id);
  const cls = ['block', `block--${block.district}`];
  if (color) cls.push('block--owned', `block--${color}`);
  if (selected) cls.push('is-selected');
  if (fresh) cls.push('is-captured');

  return h('button', {
    type: 'button',
    class: cls.join(' '),
    dataset: { block: block.id },
    'aria-label': blockDescription(game, block),
    'aria-pressed': selected ? 'true' : 'false',
  },
    createSprite('parks:empty-lot', { className: 'block__lot' }),
    color && h('span', { class: 'block__tint', 'aria-hidden': 'true' }),
    color && createSprite(`markers:frame-${color}`, { className: 'block__frame' }),
    building && createSprite(building.sprite, { className: 'block__building' }),
    color && !building && createSprite(`markers:seal-${color}`, { className: 'block__seal' }),
    color && createSprite(`markers:post-${color}`, { className: 'block__flag' }),
    fresh && createSprite('effects:sparkle', { className: 'block__fx' }),
    h('span', { class: 'block__coord', 'aria-hidden': 'true' }, block.label),
  );
}

export function renderBoard(game) {
  const { board } = game;
  const el = $('#board');
  const frame = $('#board-frame');

  // Keep keyboard focus on the same cell across re-renders.
  const focused = el.contains(document.activeElement) ? document.activeElement : null;
  const focusKey = focused?.dataset.road ? `[data-road="${focused.dataset.road}"]`
    : focused?.dataset.block ? `[data-block="${focused.dataset.block}"]` : null;

  el.style.setProperty('--rows', board.rows);
  el.style.setProperty('--cols', board.cols);

  const playing = game.phase === PHASES.PLAYING;
  const turnColor = playing ? currentPlayer(game).color : null;
  frame.dataset.turn = turnColor ?? 'none';
  el.classList.toggle('is-locked', !playing);

  const cells = [];
  for (let R = 0; R <= board.rows * 2; R++) {
    for (let C = 0; C <= board.cols * 2; C++) {
      const r = R >> 1;
      const c = C >> 1;
      if (R % 2 === 0 && C % 2 === 0) cells.push(nodeCell(board, r, c));
      else if (R % 2 === 0) cells.push(roadCell(game, 'h', r, c));
      else if (C % 2 === 0) cells.push(roadCell(game, 'v', r, c));
      else cells.push(blockCell(game, board.blocks[r * board.cols + c]));
    }
  }
  el.replaceChildren(...cells);

  if (focusKey) el.querySelector(focusKey)?.focus({ preventScroll: true });
}

/** Brief "nope" wiggle on a road that can't be built. */
export function rejectRoad(id) {
  const btn = document.querySelector(`#board [data-road="${id}"]`);
  if (!btn) return;
  btn.classList.remove('is-rejected');
  void btn.offsetWidth; // restart the animation
  btn.classList.add('is-rejected');
}

export function selectBlock(id) {
  selectedId = id;
  document.querySelectorAll('#board .block').forEach((btn) => {
    const on = btn.dataset.block === id;
    btn.classList.toggle('is-selected', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  handlers.onBlockSelect(id);
}

export function getSelectedBlock() {
  return selectedId;
}

export function clearSelection() {
  selectedId = null;
}

export function initBoardView(opts) {
  handlers = { ...handlers, ...opts };
  $('#board').addEventListener('click', (e) => {
    const road = e.target.closest('.road');
    if (road) {
      handlers.onRoadSelect(road.dataset.road);
      return;
    }
    const block = e.target.closest('.block');
    if (!block) return;
    selectBlock(block.dataset.block === selectedId ? null : block.dataset.block);
  });
}
