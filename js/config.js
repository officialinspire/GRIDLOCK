/** Shared constants for Grid Lock City. Pure data, no DOM. */

export const BOARD_ROWS = 6;
export const BOARD_COLS = 6;

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;

/** Seat presets match the four colours/symbols in "ownership markers.png". */
export const PLAYER_PRESETS = Object.freeze([
  { seat: 1, name: 'Player 1', color: 'red', symbol: 'triangle', hex: '#c8322b' },
  { seat: 2, name: 'Player 2', color: 'blue', symbol: 'diamond', hex: '#1f4f9c' },
  { seat: 3, name: 'Player 3', color: 'yellow', symbol: 'circle', hex: '#e9a91e' },
  { seat: 4, name: 'Player 4', color: 'green', symbol: 'leaf', hex: '#3a8a3a' },
]);

/** Each seat starts in its own corner of the city, clockwise from top-left. */
export const START_CORNERS = Object.freeze([
  { row: 0, col: 0 },
  { row: 0, col: BOARD_COLS - 1 },
  { row: BOARD_ROWS - 1, col: BOARD_COLS - 1 },
  { row: BOARD_ROWS - 1, col: 0 },
]);

export const DEFAULT_SETTINGS = Object.freeze({
  sound: true,
  music: true,
  reducedMotion: false,
  showCoords: false,
  rounds: 12,
  startingCash: 1500,
});

export const MAX_NAME_LENGTH = 16;
