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
import { ART, progressionProps } from '../art.js';
import { PLAYER_PRESETS } from '../config.js';
import { DISTRICTS, roadId, hasRoad, blockLabel, builtSides } from '../core/board.js';
import { levelArt, getCategory, describeDevelopment } from '../core/buildings.js';
import { isDeveloped, MAX_LEVEL } from '../core/development.js';
import { blockEventState } from './eventView.js';
import { blockImpacts } from '../core/events.js';
import { getPlayer, currentPlayer, PHASES, TURN_PHASES } from '../core/game.js';
import { isInDistress } from '../core/economy.js';
import { getSettings } from './settingsView.js';

let selectedId = null;
// One-shot effects play only on the render right after the move/build that caused them.
let seenMove = null;
let seenDevelopment = null;
let fx = { move: false, development: false };
let handlers = { onBlockSelect() {}, onRoadSelect() {}, onRoadArmed() {} };
// Touch screens: the first tap "arms" a road (preview), a second tap on it paves.
let armedId = null;
let rovingKey = null;
const coarsePointer = () => globalThis.matchMedia?.('(pointer: coarse)').matches ?? false;
export const needsConfirmTap = () => coarsePointer() && getSettings().confirmTaps;

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
  return h('span', { class: `node${paved ? ' is-paved' : ''}`, 'aria-hidden': 'true' },
    paved && createSprite(ART.road.junction, { className: 'node__tile' }));
}

function roadCell(game, dir, r, c) {
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
  // MANAGE_CITY intentionally leaves open roads interactive: selecting one is
  // equivalent to choosing “Pave Road” and the core commits the phase before
  // placing it. This keeps the explicit phase button while preserving the
  // direct tabletop gesture. Capture/develop and ended games remain locked.
  const phaseAllowsRoad = [TURN_PHASES.MANAGE_CITY, TURN_PHASES.PAVE_ROAD, TURN_PHASES.BONUS_ROAD].includes(game.turnPhase);
  const disabled = built || game.phase !== PHASES.PLAYING || !phaseAllowsRoad;
  const distress = game.phase === PHASES.PLAYING && isInDistress(currentPlayer(game));
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
    // Distress is an explanatory lock rather than a native-disabled control:
    // selecting an open road lets the controller reopen Resolve Debt feedback.
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

/** Category icon + level pips, e.g. [🏠 ●●○]. */
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
    .flatMap((impact) => (ART.event[impact.def.id] ?? []).map((sprite, index) => ({
      sprite, id: impact.def.id, index,
    })));
  for (const id of new Set(eventVfx.map((item) => item.id))) cls.push(`has-event-${id}`);
  if (ev.state) cls.push(`is-event-${ev.state}`);

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
    // Layered paper cut-outs, back to front: lot → owner tint/frame → street props → building → markers.
    createSprite(ruin ? ART.lot.abandoned : color ? ART.lot.owned : ART.lot.unclaimed, { className: 'block__lot' }),
    h('span', { class: 'block__district-paper', 'aria-hidden': 'true' }),
    color && h('span', { class: 'block__tint', 'aria-hidden': 'true' }),
    color && createSprite(ART.owner.frame(block.ownerSeat), { className: 'block__frame' }),
    ...(developed ? progressionProps(block.type, block.level) : []).map((ref, i) =>
      createSprite(ref, { className: `block__prop block__prop--${i}` })),
    art && createSprite(art.sprite, { className: 'block__building' }),
    ruin && h('span', { class: 'block__abandoned', 'aria-hidden': 'true' }, 'Abandoned'),
    color && !art && createSprite(ART.owner.seal(block.ownerSeat), { className: 'block__seal' }),
    developed && levelBadge(block),
    ev.state && createSprite(ev.state === 'shielded' ? 'title:shield' : ev.lead.def.sprite, { className: 'block__event' }),
    ...eventVfx.map(({ sprite, id, index }) => createSprite(sprite, {
      className: `block__event-vfx block__event-vfx--${id} block__event-vfx--${index + 1}`,
    })),
    color && createSprite(ART.owner.flag(block.ownerSeat), { className: 'block__flag' }),
    justBuilt && h('span', { class: 'block__foundation', 'aria-hidden': 'true' }),
    color && h('span', { class: 'block__owner-mark', 'aria-hidden': 'true' }, PLAYER_PRESETS[block.ownerSeat - 1].mark),
    fresh && createSprite(ART.fx.capture, { className: 'block__fx' }),
    justBuilt && createSprite(ART.fx.build, { className: 'block__fx' }),
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

  fx = { move: game.lastMove !== seenMove, development: game.lastDevelopment !== seenDevelopment };
  if (fx.move) armedId = null;
  seenMove = game.lastMove;
  seenDevelopment = game.lastDevelopment;

  el.style.setProperty('--rows', board.rows);
  el.style.setProperty('--cols', board.cols);

  const playing = game.phase === PHASES.PLAYING;
  const turnColor = playing ? currentPlayer(game).color : null;
  frame.dataset.turn = turnColor ?? 'none';
  el.classList.toggle('is-locked', !playing || isInDistress(currentPlayer(game)));

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
  const focusedMatch = focusKey ? el.querySelector(focusKey) : null;
  const focusTarget = focusedMatch?.matches('.block, .road:not(:disabled)') ? focusedMatch : null;
  const candidates = [...el.querySelectorAll('.block, .road:not(:disabled)')];
  const remembered = rovingKey ? el.querySelector(rovingKey) : null;
  const rememberedCandidate = remembered?.matches('.block, .road:not(:disabled)') ? remembered : null;
  const roving = focusTarget ?? rememberedCandidate ?? candidates[0] ?? null;
  candidates.forEach((cell) => { cell.tabIndex = cell === roving ? 0 : -1; });
  if (roving) {
    rovingKey = roving.dataset.road ? `[data-road="${roving.dataset.road}"]` : `[data-block="${roving.dataset.block}"]`;
  } else {
    rovingKey = null;
  }
  if (focusTarget) focusTarget.focus({ preventScroll: true });
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
  disarm();
}

export function disarm() {
  armedId = null;
  document.querySelectorAll('#board .road.is-armed').forEach((el) => el.classList.remove('is-armed'));
}

export function initBoardView(opts) {
  handlers = { ...handlers, ...opts };
  $('#board').addEventListener('click', (e) => {
    const road = e.target.closest('.road');
    if (road) {
      if (road.disabled || road.classList.contains('is-built')) return;
      rovingKey = `[data-road="${road.dataset.road}"]`;
      const id = road.dataset.road;
      const pavable = !road.classList.contains('is-built') && !$('#board').classList.contains('is-locked');
      if (pavable && needsConfirmTap() && armedId !== id) {
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
    for (let i = 0; i < 13 && !next; i++) {
      row += delta[0]; col += delta[1];
      next = document.querySelector(`#board .road:not(:disabled)[data-grid-row="${row}"][data-grid-col="${col}"], #board .block[data-grid-row="${row}"][data-grid-col="${col}"]`);
    }
    if (!next) return;
    cell.tabIndex = -1;
    next.tabIndex = 0;
    rovingKey = next.dataset.road ? `[data-road="${next.dataset.road}"]` : `[data-block="${next.dataset.block}"]`;
    next.focus({ preventScroll: true });
  });
}
