/**
 * City board model: a grid of blocks separated by streets.
 * Pure data — rendering lives in ui/boardView.js.
 */
import { BOARD_ROWS, BOARD_COLS, ECONOMY } from '../config.js';

export const DISTRICTS = Object.freeze({
  downtown: { id: 'downtown', label: 'Downtown', price: ECONOMY.LAND_VALUE.downtown },
  midtown: { id: 'midtown', label: 'Midtown', price: ECONOMY.LAND_VALUE.midtown },
  suburbs: { id: 'suburbs', label: 'Suburbs', price: ECONOMY.LAND_VALUE.suburbs },
});

/** Ring distance from the board edge decides the district (0 = edge). */
export function districtFor(row, col, rows = BOARD_ROWS, cols = BOARD_COLS) {
  const ring = Math.min(row, col, rows - 1 - row, cols - 1 - col);
  if (ring === 0) return DISTRICTS.suburbs;
  if (ring === 1) return DISTRICTS.midtown;
  return DISTRICTS.downtown;
}

export const blockId = (row, col) => `r${row}c${col}`;

/** Column letter + row number, e.g. "A1" for the top-left block. */
export const blockLabel = (row, col) => `${String.fromCharCode(65 + col)}${row + 1}`;

export function createBoard(rows = BOARD_ROWS, cols = BOARD_COLS) {
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1) {
    throw new RangeError(`Invalid board size ${rows}x${cols}`);
  }
  const blocks = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const district = districtFor(row, col, rows, cols);
      blocks.push({
        id: blockId(row, col),
        row,
        col,
        label: blockLabel(row, col),
        district: district.id,
        price: district.price,
        ownerSeat: null,
        // Development (managed by core/development.js). Every block starts Vacant, Level 0.
        type: 'vacant',
        level: 0,
        // Accounting is explicit: constructionCosts are the actual amounts paid,
        // investedCostBasis is their total, and marketValue uses list prices.
        constructionCosts: [],
        investedCostBasis: 0,
        marketValue: district.price,
        value: district.price, // land + invested cost basis (legacy/UI convenience)
        income: ECONOMY.UNDEVELOPED_INCOME, // base income for the level
        // Derived by core/bonuses.js refreshBonuses() — never edited directly.
        bonuses: [],
        bonusIncome: 0,
        protectedBy: [],
        prestige: 0,
        prestigeNotes: [],
        control: 0,
        // Round until which a block taken over (core/takeover.js) can't be taken again.
        shieldedUntil: null,
        // Set by bankruptcy (core/finance.js): ownerless, development kept but inactive.
        abandoned: false,
        abandonedBy: null,
      });
    }
  }
  // roads: edgeId -> seat of the player who built it (Dots & Boxes lines).
  return { rows, cols, blocks, roads: {} };
}

export function getBlock(board, row, col) {
  if (row < 0 || col < 0 || row >= board.rows || col >= board.cols) return null;
  return board.blocks[row * board.cols + col];
}

export function getBlockById(board, id) {
  return board.blocks.find((b) => b.id === id) ?? null;
}

/** Orthogonally adjacent blocks (across one street). */
export function neighbors(board, block) {
  return [
    [-1, 0], [1, 0], [0, -1], [0, 1],
  ]
    .map(([dr, dc]) => getBlock(board, block.row + dr, block.col + dc))
    .filter(Boolean);
}

export function blocksOwnedBy(board, seat) {
  return board.blocks.filter((b) => b.ownerSeat === seat);
}

export function setOwner(board, block, seat) {
  block.ownerSeat = seat;
  return block;
}

/* ------------------------------------------------------------------
 * Roads (Dots & Boxes edges)
 *
 * Intersections ("nodes") form a (rows+1) x (cols+1) lattice. A road joins
 * two orthogonally adjacent nodes:
 *   h-{r}-{c}  horizontal, node (r,c) -> (r,c+1)   r: 0..rows, c: 0..cols-1
 *   v-{r}-{c}  vertical,   node (r,c) -> (r+1,c)   r: 0..rows-1, c: 0..cols
 * Block (row,col) is bounded by h-row-col, h-(row+1)-col, v-row-col, v-row-(col+1).
 * ------------------------------------------------------------------ */

export const roadId = (dir, r, c) => `${dir}-${r}-${c}`;

export function parseRoadId(id) {
  const m = /^([hv])-(\d+)-(\d+)$/.exec(String(id));
  return m ? { dir: m[1], r: Number(m[2]), c: Number(m[3]) } : null;
}

export function isValidRoad(board, id) {
  const e = parseRoadId(id);
  if (!e) return false;
  if (e.dir === 'h') return e.r <= board.rows && e.c < board.cols;
  return e.r < board.rows && e.c <= board.cols;
}

/** Road joining two nodes, or null if they aren't orthogonally adjacent. */
export function roadBetweenNodes(board, a, b) {
  const dr = b.row - a.row;
  const dc = b.col - a.col;
  let id = null;
  if (dr === 0 && Math.abs(dc) === 1) id = roadId('h', a.row, Math.min(a.col, b.col));
  else if (dc === 0 && Math.abs(dr) === 1) id = roadId('v', Math.min(a.row, b.row), a.col);
  return id && isValidRoad(board, id) ? id : null;
}

/** The two nodes a road joins. */
export function roadNodes(id) {
  const e = parseRoadId(id);
  if (!e) return null;
  return e.dir === 'h'
    ? [{ row: e.r, col: e.c }, { row: e.r, col: e.c + 1 }]
    : [{ row: e.r, col: e.c }, { row: e.r + 1, col: e.c }];
}

export function allRoadIds(board) {
  const ids = [];
  for (let r = 0; r <= board.rows; r++) for (let c = 0; c < board.cols; c++) ids.push(roadId('h', r, c));
  for (let r = 0; r < board.rows; r++) for (let c = 0; c <= board.cols; c++) ids.push(roadId('v', r, c));
  return ids;
}

export function blockRoadIds(block) {
  const { row, col } = block;
  return [roadId('h', row, col), roadId('h', row + 1, col), roadId('v', row, col), roadId('v', row, col + 1)];
}

/** Blocks bordering a road: 1 on the city edge, otherwise 2. */
export function roadBlocks(board, id) {
  const e = parseRoadId(id);
  if (!e) return [];
  const pair = e.dir === 'h'
    ? [getBlock(board, e.r - 1, e.c), getBlock(board, e.r, e.c)]
    : [getBlock(board, e.r, e.c - 1), getBlock(board, e.r, e.c)];
  return pair.filter(Boolean);
}

export const hasRoad = (board, id) => Object.hasOwn(board.roads, id);

export function builtSides(board, block) {
  return blockRoadIds(block).filter((id) => hasRoad(board, id)).length;
}

export const isBlockEnclosed = (board, block) => builtSides(board, block) === 4;

export const totalRoads = (board) => (board.rows + 1) * board.cols + board.rows * (board.cols + 1);
