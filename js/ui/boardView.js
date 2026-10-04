/**
 * Renders the city board as a (2n+1)² grid:
 *   even row + even col → intersection (Dots & Boxes "dot")
 *   even row + odd col  → horizontal road slot   (h-r-c)
 *   odd row  + even col → vertical road slot     (v-r-c)
 *   odd row  + odd col  → city block
 * Road slots are buttons: tapping one paves the road between its two intersections.
 */
import { $, h } from './dom.js';
import { replayAnimation } from './replay.js';
import { createSprite } from '../assets.js';
import { ART, blockScene } from '../art.js';
import { PLAYER_PRESETS } from '../config.js';
import { DISTRICTS, roadId, hasRoad, blockLabel, builtSides } from '../core/board.js';
import { levelArt, getCategory, describeDevelopment } from '../core/buildings.js';
import { isDeveloped, MAX_LEVEL } from '../core/development.js';
import { blockEventState } from './eventView.js';
import { blockImpacts } from '../core/events.js';
import { getPlayer, currentPlayer, PHASES, TURN_PHASES } from '../core/game.js';
import { isInDistress } from '../core/economy.js';
import { getSettings } from './settingsView.js';
import { isCpu } from '../core/seats.js';

let selectedId = null;
let seenMove = null;
let seenDevelopment = null;
let fx = { move: false, development: false };
let handlers = { onBlockSelect() {}, onRoadSelect() {}, onRoadArmed() {} };
let armedId = null;
let rovingKey = null;
const coarsePointer = () => globalThis.matchMedia?.('(pointer: coarse)').matches ?? false;
let boardPointer = null; // pointerType of the last press on the board

/**
 * "Tap twice to pave" applies to finger taps. It follows the pointer that made the tap, so a
 * touchscreen laptop or an iPad with a trackpad previews finger taps but not mouse clicks. Without
 * pointer information (older browsers), fall back to whether the device's main pointer is touch.
 * Keyboard (Enter/Space) and mouse/pen always pave directly.
 */
export function needsConfirmTap(e) {
  if (!getSettings().confirmTaps || e?.detail === 0) return false;
  return boardPointer ? boardPointer === 'touch' : coarsePointer();
}

const colorOf = (seat) => (seat ? PLAYER_PRESETS[seat - 1].color : null);
const nodeLabel = (r, c) => blockLabel(r, c);

function roadLabel(dir, r, c) {
  return dir === 'h'
    ? `road from ${nodeLabel(r, c)} to ${nodeLabel(r, c + 1)}`
    : `road from ${nodeLabel(r, c)} to ${nodeLabel(r + 1, c)}`;
}

/** An intersection shows a junction tile once any road touching it is paved. */
function nodePaved(board, r, c) {
  return [roadId('h', r, c - 1), roadId('h', r, c), roadId('v', r - 1, c), roadId('v', r, c)].some((id) => hasRoad(board, id));
}

function nodeCell(board, r, c) {
  const paved = nodePaved(board, r, c);
  return h('span', { class: `node${paved ? ' is-paved' : ''}`, 'aria-hidden': 'true' },
    paved && createSprite(ART.road.junction, { className: 'node__tile' }));
}

/** What locks every open road this render: not a paving moment (closed), or the mayor's debt (distress). */
function roadLocks(game) {
  const playing = game.phase === PHASES.PLAYING;
  const phaseAllowsRoad = [TURN_PHASES.MANAGE_CITY, TURN_PHASES.PAVE_ROAD, TURN_PHASES.BONUS_ROAD].includes(game.turnPhase);
  return { closed: !playing || !phaseAllowsRoad, distress: playing && isInDistress(currentPlayer(game)) };
}

function roadCell(game, dir, r, c, locks) {
  const id = roadId(dir, r, c);
  const builder = game.board.roads[id];
  const built = builder != null;
  const last = game.lastMove?.road === id;
  const cls = ['road', `road--${dir}`];
  if (built) cls.push('is-built', `road--${colorOf(builder)}`);
  if (last) cls.push('is-last');
  if (last && fx.move) cls.push('is-new');
  if (id === armedId && !built) cls.push('is-armed');

  const who = built ? getPlayer(game, builder)?.name : null;
  const owner = built ? PLAYER_PRESETS[builder - 1] : null;
  const disabled = built || locks.closed;
  const distress = locks.distress;
  return h('button', {
    type: 'button',
    class: cls.join(' '),
    dataset: { road: id },
    'data-grid-row': dir === 'h' ? r * 2 : r * 2 + 1,
    'data-grid-col': dir === 'h' ? c * 2 + 1 : c * 2,
    'data-owner-symbol': owner?.symbol,
    'aria-label': built
      ? `${roadLabel(dir, r, c)}, paved${who ? ` by ${who}` : ''}${owner ? `, ${owner.symbol}` : ''}`
      : `Pave ${roadLabel(dir, r, c)}`,
    disabled,
    'aria-disabled': disabled || distress ? 'true' : null,
  }, h('span', { class: 'road__surface', 'aria-hidden': 'true' },
    built && createSprite(ART.road[dir], { className: 'road__tile' }),
    owner && h('span', { class: 'road__owner-mark' }, owner.mark)));
}

function blockDescription(game, block) {
  const owner = block.ownerSeat ? getPlayer(game, block.ownerSeat) : null;
  return [
    `Block ${block.label}`,
    DISTRICTS[block.district].label,
    owner ? `claimed by ${owner.name}, ${owner.symbol}` : block.abandoned ? 'abandoned' : `${builtSides(game.board, block)} of 4 roads`,
    (owner || block.abandoned) && describeDevelopment(block),
    block.bonusIncome > 0 && `bonus +$${block.bonusIncome} per turn`,
    blockEventState(game, block).state && `city event: ${blockEventState(game, block).state}`,
  ].filter(Boolean).join(', ');
}

function levelBadge(block) {
  const cat = getCategory(block.type);
  const pips = Array.from({ length: MAX_LEVEL }, (_, i) =>
    h('span', { class: `pip${i < block.level ? ' is-on' : ''}` }));
  const bonus = block.bonusIncome > 0;
  return h('span', { class: `block__badge block__badge--${block.type}${bonus ? ' has-bonus' : ''}`, 'aria-hidden': 'true', title: describeDevelopment(block) },
    createSprite(cat.icon, { className: 'block__badge-icon' }),
    h('span', { class: 'block__badge-pips' }, pips),
  );
}

function blockCell(game, block) {
  const color = colorOf(block.ownerSeat);
  const developed = isDeveloped(block) && !block.abandoned;
  const ruin = block.abandoned;
  const art = isDeveloped(block) ? levelArt(block.type, block.level) : null;
  const selected = block.id === selectedId;
  const fresh = fx.move && game.lastMove?.captured.includes(block.id);
  const justBuilt = fx.development && game.lastDevelopment?.block === block.id;
  const cls = ['block', `block--${block.district}`];
  if (color) cls.push('block--owned', `block--${color}`);
  if (developed) cls.push('block--developed', `block--lv${block.level}`);
  if (ruin) cls.push('block--abandoned');
  if (selected) cls.push('is-selected');
  if (fresh) cls.push('is-captured');
  if (justBuilt) cls.push('is-just-built');
  if (justBuilt && game.lastDevelopment.fromLevel > 0) cls.push('is-upgraded');
  const ev = blockEventState(game, block);
  const eventVfx = blockImpacts(game, block)
    .filter((impact) => !impact.mitigated)
    .flatMap((impact) => (ART.event[impact.def.id] ?? []).map((sprite, index) => ({ sprite, id: impact.def.id, index })));
  for (const id of new Set(eventVfx.map((item) => item.id))) cls.push(`has-event-${id}`);
  if (ev.state) cls.push(`is-event-${ev.state}`);
  // The one cut-out kept with Reduce effects (css/effects.css): the lead event's, as in the marker.
  const mainVfx = eventVfx.find((item) => item.id === ev.lead?.def.id && item.index === 0) ?? eventVfx[0];

  return h('button', {
    type: 'button',
    class: cls.join(' '),
    dataset: { block: block.id },
    'data-grid-row': block.row * 2 + 1,
    'data-grid-col': block.col * 2 + 1,
    'data-owner-symbol': block.ownerSeat ? PLAYER_PRESETS[block.ownerSeat - 1].symbol : null,
    'aria-label': blockDescription(game, block),
    'aria-pressed': selected ? 'true' : 'false',
  },
    createSprite(ruin ? ART.lot.abandoned : color ? ART.lot.owned : ART.lot.unclaimed, { className: 'block__lot' }),
    h('span', { class: 'block__district-paper', 'aria-hidden': 'true' }),
    color && h('span', { class: 'block__tint', 'aria-hidden': 'true' }),
    color && createSprite(ART.owner.frame(block.ownerSeat), { className: 'block__frame' }),
    // Denser with each level (js/art.js blockScene): corner props at Level 2, an annex and a
    // street piece at Level 3. Decorative only: the block's label already says what it is.
    ...(developed ? blockScene(block.type, block.level) : []).map(({ ref, slot }) =>
      createSprite(ref, { className: `block__prop block__prop--${slot}` })),
    art && createSprite(art.sprite, { className: 'block__building' }),
    ruin && h('span', { class: 'block__abandoned', 'aria-hidden': 'true' }, 'Abandoned'),
    color && !art && createSprite(ART.owner.seal(block.ownerSeat), { className: 'block__seal' }),
    developed && levelBadge(block),
    ev.state && createSprite(ev.state === 'shielded' ? 'title:shield' : ev.lead.def.sprite, { className: 'block__event' }),
    ...eventVfx.map((item) => createSprite(item.sprite, {
      className: `block__event-vfx block__event-vfx--${item.id} block__event-vfx--${item.index + 1}${item === mainVfx ? ' block__event-vfx--main' : ''}`,
    })),
    color && createSprite(ART.owner.flag(block.ownerSeat), { className: 'block__flag' }),
    justBuilt && h('span', { class: 'block__foundation', 'aria-hidden': 'true' }),
    color && h('span', { class: 'block__owner-mark', 'aria-hidden': 'true' }, PLAYER_PRESETS[block.ownerSeat - 1].mark),
    fresh && createSprite(ART.fx.capture, { className: 'block__fx block__fx--capture' }),
    justBuilt && createSprite(ART.fx.build, { className: 'block__fx block__fx--build' }),
    h('span', { class: 'block__coord', 'aria-hidden': 'true' }, block.label),
  );
}

/* ---------------- incremental drawing ----------------
 * The board keeps one element per grid cell between draws. Each cell has a key: everything its
 * markup depends on except the parts patched in place (block selection; a road's disabled /
 * aria-disabled lock). A cell whose key is unchanged keeps its element (and its focus, running
 * animations and DOM state); one whose key changed is rebuilt with the same builder a full draw
 * uses and swapped in. Fresh capture / build / paving animations carry a counter in the key, so
 * each new one rebuilds its cell and plays from the start, exactly as after a full draw.
 */
let cells = []; // [{ el, key }] in grid order: #board's children
let cellsGame = null; // the game `cells` were drawn for (a new game is drawn in full)
let moveCount = 0; // bumped for each new move…
let developmentCount = 0; // …and development

function nodeKey(board, r, c) {
  return nodePaved(board, r, c) ? 'paved' : '';
}

function roadKey(game, dir, r, c) {
  const id = roadId(dir, r, c);
  const builder = game.board.roads[id];
  const last = game.lastMove?.road === id;
  return [builder ?? '', builder != null ? getPlayer(game, builder)?.name : '', last ? 'last' : '',
    last && fx.move ? moveCount : '', id === armedId && builder == null ? 'armed' : ''].join('|');
}

function blockKey(game, block) {
  const ev = blockEventState(game, block);
  const vfx = blockImpacts(game, block).filter((impact) => !impact.mitigated).map((impact) => impact.def.id).join(',');
  const fresh = fx.move && game.lastMove?.captured.includes(block.id);
  const justBuilt = fx.development && game.lastDevelopment?.block === block.id;
  return [blockDescription(game, block), block.ownerSeat ?? '', block.abandoned ? 'abandoned' : '', block.type, block.level,
    block.bonusIncome, ev.state ?? '', ev.lead?.def.id ?? '', vfx, fresh ? moveCount : '',
    justBuilt ? `${developmentCount}${game.lastDevelopment.fromLevel > 0 ? 'up' : ''}` : ''].join('|');
}

/** The grid is (2n+1)²: even/even an intersection, even/odd and odd/even road slots, odd/odd a block. */
function cellKey(game, R, C) {
  const { board } = game;
  if (R % 2 === 0 && C % 2 === 0) return nodeKey(board, R >> 1, C >> 1);
  if (R % 2 === 0) return roadKey(game, 'h', R >> 1, C >> 1);
  if (C % 2 === 0) return roadKey(game, 'v', R >> 1, C >> 1);
  return blockKey(game, board.blocks[(R >> 1) * board.cols + (C >> 1)]);
}

function buildCell(game, locks, R, C) {
  const { board } = game;
  if (R % 2 === 0 && C % 2 === 0) return nodeCell(board, R >> 1, C >> 1);
  if (R % 2 === 0) return roadCell(game, 'h', R >> 1, C >> 1, locks);
  if (C % 2 === 0) return roadCell(game, 'v', R >> 1, C >> 1, locks);
  return blockCell(game, board.blocks[(R >> 1) * board.cols + (C >> 1)]);
}

/** A kept cell's in-place state: a block's selection, a road's lock. Writes only what changed. */
function patchCell(game, locks, el, R, C) {
  if (R % 2 === 1 && C % 2 === 1) {
    const on = el.dataset.block === selectedId;
    if (el.classList.contains('is-selected') !== on) el.classList.toggle('is-selected', on);
    if (el.getAttribute('aria-pressed') !== String(on)) el.setAttribute('aria-pressed', String(on));
  } else if (R % 2 !== C % 2) {
    const disabled = game.board.roads[el.dataset.road] != null || locks.closed;
    if (el.disabled !== disabled) el.disabled = disabled;
    if (disabled && el.hasAttribute('tabindex')) el.removeAttribute('tabindex'); // not a tab stop, as when built
    const aria = disabled || locks.distress ? 'true' : null;
    if (el.getAttribute('aria-disabled') !== aria) {
      if (aria) el.setAttribute('aria-disabled', aria);
      else el.removeAttribute('aria-disabled');
    }
  }
}

/**
 * Every cell of the board as a full draw makes it right now, in grid order (detached elements).
 * renderBoard uses it for full draws; tests compare it with the incrementally drawn board.
 */
export function buildBoardCells(game) {
  const { board } = game;
  const locks = roadLocks(game);
  const out = [];
  for (let R = 0; R <= board.rows * 2; R++) {
    for (let C = 0; C <= board.cols * 2; C++) out.push(buildCell(game, locks, R, C));
  }
  return out;
}

/**
 * Draws the board. Only cells whose state changed are rebuilt (see above); `full` (and a new game,
 * a new board size, or a board someone else emptied) rebuilds every cell.
 */
export function renderBoard(game, { full = false } = {}) {
  const { board } = game;
  const el = $('#board');
  const frame = $('#board-frame');
  const focused = el.contains(document.activeElement) ? document.activeElement : null;
  const focusKey = focused?.dataset.road ? `[data-road="${focused.dataset.road}"]`
    : focused?.dataset.block ? `[data-block="${focused.dataset.block}"]` : null;

  fx = { move: game.lastMove !== seenMove, development: game.lastDevelopment !== seenDevelopment };
  if (fx.move) {
    armedId = null;
    moveCount += 1;
  }
  if (fx.development) developmentCount += 1;
  seenMove = game.lastMove;
  seenDevelopment = game.lastDevelopment;

  el.style.setProperty('--rows', board.rows);
  el.style.setProperty('--cols', board.cols);
  const playing = game.phase === PHASES.PLAYING;
  const turnColor = playing ? currentPlayer(game).color : null;
  frame.dataset.turn = turnColor ?? 'none';
  // Locked: no road previews or taps to arm (game over, debt to settle, or a CPU mayor's turn).
  el.classList.toggle('is-locked', !playing || isInDistress(currentPlayer(game)) || isCpu(currentPlayer(game)));

  const size = (board.rows * 2 + 1) * (board.cols * 2 + 1);
  const locks = roadLocks(game);
  if (full || game !== cellsGame || cells.length !== size || el.children.length !== size || cells[0]?.el.parentNode !== el) {
    const built = buildBoardCells(game);
    cells = built.map((cell, i) => ({ el: cell, key: cellKey(game, Math.floor(i / (board.cols * 2 + 1)), i % (board.cols * 2 + 1)) }));
    el.replaceChildren(...built);
    cellsGame = game;
  } else {
    let i = 0;
    for (let R = 0; R <= board.rows * 2; R++) {
      for (let C = 0; C <= board.cols * 2; C++, i++) {
        const key = cellKey(game, R, C);
        const cell = cells[i];
        if (key === cell.key) {
          patchCell(game, locks, cell.el, R, C);
          continue;
        }
        const next = buildCell(game, locks, R, C);
        cell.el.replaceWith(next);
        cells[i] = { el: next, key };
      }
    }
  }

  const focusedMatch = focusKey ? el.querySelector(focusKey) : null;
  const focusTarget = focusedMatch?.matches('.block, .road:not(:disabled)') ? focusedMatch : null;
  // Blocks are the default keyboard entry point because arrow navigation among
  // blocks is more predictable than dropping users into the dense road lattice.
  const candidates = [...el.querySelectorAll('.block'), ...el.querySelectorAll('.road:not(:disabled)')];
  const remembered = rovingKey ? el.querySelector(rovingKey) : null;
  const rememberedCandidate = remembered?.matches('.block, .road:not(:disabled)') ? remembered : null;
  const roving = focusTarget ?? rememberedCandidate ?? candidates[0] ?? null;
  for (const cell of candidates) {
    const tabIndex = cell === roving ? '0' : '-1';
    if (cell.getAttribute('tabindex') !== tabIndex) cell.setAttribute('tabindex', tabIndex);
  }
  if (roving) {
    rovingKey = roving.dataset.road ? `[data-road="${roving.dataset.road}"]` : `[data-block="${roving.dataset.block}"]`;
  } else {
    rovingKey = null;
  }
  // Focus stays put on a kept cell; a rebuilt one gets it back.
  if (focusTarget && document.activeElement !== focusTarget) focusTarget.focus({ preventScroll: true });
}

/** A refused road shakes (again, if it is tapped again). */
export function rejectRoad(id) {
  replayAnimation(document.querySelector(`#board [data-road="${id}"]`), 'is-rejected');
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

export function getSelectedBlock() { return selectedId; }

export function clearSelection() {
  selectedId = null;
  disarm();
}

export function disarm() {
  armedId = null;
  document.querySelectorAll('#board .road.is-armed').forEach((el) => el.classList.remove('is-armed'));
}

export function initBoardView(opts) {
  handlers = { ...handlers, ...opts };
  $('#board').addEventListener('pointerdown', (e) => { boardPointer = e.pointerType || null; }, { passive: true });
  $('#board').addEventListener('click', (e) => {
    const road = e.target.closest('.road');
    if (road) {
      if (road.disabled || road.classList.contains('is-built')) return;
      rovingKey = `[data-road="${road.dataset.road}"]`;
      const id = road.dataset.road;
      const pavable = !road.classList.contains('is-built') && !$('#board').classList.contains('is-locked');
      if (pavable && needsConfirmTap(e) && armedId !== id) {
        disarm();
        armedId = id;
        road.classList.add('is-armed');
        handlers.onRoadArmed(id);
        return;
      }
      disarm();
      handlers.onRoadSelect(id);
      return;
    }
    disarm();
    const block = e.target.closest('.block');
    if (!block) return;
    rovingKey = `[data-block="${block.dataset.block}"]`;
    selectBlock(block.dataset.block);
  });

  $('#board').addEventListener('keydown', (e) => {
    const cell = e.target.closest('.road, .block');
    if (!cell) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      disarm();
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      cell.click();
      return;
    }
    const directions = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    const delta = directions[e.key];
    if (!delta) return;
    e.preventDefault();

    let row = Number(cell.dataset.gridRow);
    let col = Number(cell.dataset.gridCol);
    let next = null;
    const selector = cell.classList.contains('block') ? '.block' : '.road:not(:disabled)';
    // Stay within the same semantic cell type. This makes arrow keys behave
    // like a city/block grid or a road grid instead of unexpectedly switching
    // between a block and the road that happens to sit beside it.
    for (let i = 0; i < 13 && !next; i++) {
      row += delta[0];
      col += delta[1];
      next = document.querySelector(`#board ${selector}[data-grid-row="${row}"][data-grid-col="${col}"]`);
    }
    if (!next) return;
    cell.tabIndex = -1;
    next.tabIndex = 0;
    rovingKey = next.dataset.road ? `[data-road="${next.dataset.road}"]` : `[data-block="${next.dataset.block}"]`;
    next.focus({ preventScroll: true });
  });
}
