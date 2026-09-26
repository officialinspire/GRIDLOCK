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
   * Building economics: purchase cost and income paid at the start of the
   * owner's turn. Keyed by building id (see core/buildings.js). Buildings are
   * not placeable yet; these are the data hooks for that phase.
   */
  BUILDINGS: Object.freeze({
    // Residential
    house: { cost: 1000, income: 100 },
    duplex: { cost: 1600, income: 160 },
    rowhouses: { cost: 2200, income: 220 },
    apartments: { cost: 3200, income: 320 },
    // Commercial
    'corner-store': { cost: 1400, income: 150 },
    diner: { cost: 1800, income: 190 },
    'convenience-store': { cost: 2000, income: 210 },
    cafe: { cost: 1700, income: 180 },
    shop: { cost: 2000, income: 220 },
    market: { cost: 2800, income: 300 },
    'gas-station': { cost: 2600, income: 280 },
    office: { cost: 4000, income: 440 },
    // Civic
    school: { cost: 3000, income: 150 },
    library: { cost: 2600, income: 120 },
    hospital: { cost: 5000, income: 300 },
    'fire-station': { cost: 3000, income: 150 },
    police: { cost: 3000, income: 150 },
    'city-hall': { cost: 6000, income: 500 },
    'train-station': { cost: 4500, income: 450 },
    theater: { cost: 3800, income: 400 },
    museum: { cost: 3800, income: 350 },
    stadium: { cost: 7000, income: 800 },
    monument: { cost: 2500, income: 100 },
    'parking-garage': { cost: 2600, income: 280 },
    // Industrial
    warehouse: { cost: 2600, income: 280 },
    factory: { cost: 4500, income: 520 },
    substation: { cost: 3000, income: 250 },
    // Parks
    plaza: { cost: 1200, income: 60 },
    garden: { cost: 800, income: 40 },
    playground: { cost: 1000, income: 50 },
    'basketball-court': { cost: 1000, income: 60 },
    fountain: { cost: 1500, income: 80 },
    'dog-park': { cost: 800, income: 40 },
    'picnic-grove': { cost: 800, income: 40 },
    skatepark: { cost: 1200, income: 60 },
  }),
});

export const MAX_NAME_LENGTH = 16;
