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

export const DEFAULT_SETTINGS = Object.freeze({
  sound: true,
  music: true,
  reducedMotion: false,
  showCoords: false,
});

/**
 * Every economy number in the game lives here. Tune balance in this block only.
 * All amounts are whole dollars.
 */
export const ECONOMY = Object.freeze({
  /** Cash each player starts with. */
  STARTING_CASH: 12000,

  /** Paid to the player who claims a block (per block, so a double capture pays twice). */
  CAPTURE_REWARD: 500,

  /** Recurring income from an owned block with no building on it. */
  UNDEVELOPED_INCOME: 0,

  /** Land value of a block by district; counts toward net property value. */
  LAND_VALUE: Object.freeze({
    suburbs: 1000,
    midtown: 1500,
    downtown: 2000,
  }),

  /**
   * Block development. A captured block starts Vacant (Level 0). The owner can
   * build one category on it (Level 1) and upgrade it to MAX_LEVEL.
   * Everything below is derived by core/development.js — edit numbers here only.
   */
  DEVELOPMENT: Object.freeze({
    MAX_LEVEL: 3,

    /** Level 1 purchase cost and income paid at the start of the owner's turn. */
    CATEGORIES: Object.freeze({
      residential: Object.freeze({ cost: 1000, income: 300 }),
      commercial: Object.freeze({ cost: 1500, income: 500 }),
      park: Object.freeze({ cost: 800, income: 100 }),
      civic: Object.freeze({ cost: 2000, income: 250 }),
      industrial: Object.freeze({ cost: 1750, income: 600 }),
      landmark: Object.freeze({ cost: 3000, income: 700 }),
    }),

    /**
     * Per level, as multiples of the category base:
     *   cost   = price to reach this level from the one below
     *   income = the block's total income at this level
     * Results must come out as whole dollars (checked at load).
     */
    LEVELS: Object.freeze({
      1: Object.freeze({ cost: 1, income: 1 }),
      2: Object.freeze({ cost: 1.5, income: 2 }),
      3: Object.freeze({ cost: 2, income: 3 }),
    }),
  }),
});

export const MAX_NAME_LENGTH = 16;
