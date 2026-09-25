/**
 * City board model: a grid of blocks separated by streets.
 * Pure data — rendering lives in ui/boardView.js.
 */
import { BOARD_ROWS, BOARD_COLS } from '../config.js';

export const DISTRICTS = Object.freeze({
  downtown: { id: 'downtown', label: 'Downtown', price: 400 },
  midtown: { id: 'midtown', label: 'Midtown', price: 300 },
  suburbs: { id: 'suburbs', label: 'Suburbs', price: 200 },
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
        buildingId: null,
      });
    }
  }
  return { rows, cols, blocks };
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
