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
  confirmTaps: true, // touch screens: first tap previews a road, second tap paves it
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

  /** Final City Value coefficients. Development must repay its scoring discount through income. */
  SCORING: Object.freeze({
    CASH: 1,
    LAND: 1,
    INVESTED_BUILDING: 0.75,
  }),

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

  /**
   * Financial failure & recovery (core/finance.js).
   * Cash can only go negative through mandatory upkeep; purchases never overdraw.
   */
  FINANCE: Object.freeze({
    /**
     * Upkeep, charged at the start of each turn after income, per owned block:
     *   LAND_TAX_PERCENT of its land value + UPKEEP_PERCENT of its invested development cost.
     * Idle land costs money, so over-expanding without developing can lead to distress.
     */
    LAND_TAX_PERCENT: 6,
    UPKEEP_PERCENT: 7,
    /** Downgrading or selling refunds this % of the development cost removed. */
    SALE_REFUND_PERCENT: 50,
    /** Capital a bankrupt player restarts with… */
    FRESH_START_CAPITAL: 2000,
    /** …for their first N bankruptcies; after that they restart with $0 (prevents farming). */
    FRESH_START_LIMIT: 2,
    /** Buying an abandoned block: land at this % of land value, plus (to restore) this % of the ruin's invested cost. */
    REDEVELOP_LAND_PERCENT: 100,
    RESTORE_PERCENT: 40,
    /** Former owners can't buy back blocks they abandoned. */
    FORMER_OWNER_MAY_BUY: false,
    /** Contested redevelopment uses sealed whole-dollar bids at or above this reserve. */
    REDEVELOPMENT: Object.freeze({
      MIN_BID_INCREMENT: 100,
      TIE_BREAKER: 'lowest-seat',
    }),
  }),

  /**
   * Adjacency / district bonuses (core/bonuses.js). Percentages apply to a
   * block's BASE income (its level income), never to other bonuses, so bonuses
   * can't compound. Each bonus type applies at most once per block.
   * "Connected" means orthogonally adjacent (sharing a road), same owner,
   * developed (Level 1+).
   */
  BONUSES: Object.freeze({
    /** 3+ connected Residential blocks: each gets +percent. */
    RESIDENTIAL_DISTRICT: Object.freeze({ minSize: 3, percent: 20 }),
    /** 3+ connected Commercial blocks: each gets +percent. */
    COMMERCIAL_DISTRICT: Object.freeze({ minSize: 3, percent: 25 }),
    /** Each directly adjacent Park adds +percentPerPark to a Residential block (up to maxParks). */
    PARK_ADJACENCY: Object.freeze({ percentPerPark: 10, maxParks: 2, sameOwnerOnly: true }),
    /** A connected cluster of Residential/Commercial/Park containing all three: each member gets +percent. */
    MIXED_USE: Object.freeze({ percent: 10 }),
    /**
     * Civic protection radius (Manhattan distance, in blocks) by civic level.
     * Hook only: marks protected blocks for future city events; no income effect.
     */
    CIVIC_PROTECTION: Object.freeze({ radiusByLevel: Object.freeze({ 1: 1, 2: 1, 3: 2 }), sameOwnerOnly: true }),
  }),
});

export const MAX_NAME_LENGTH = 16;

/**
 * City events (core/events.js). One event is drawn when a full round of play
 * ends. Most effects are temporary modifiers computed from the active-event
 * list; targeted repair expenses are queued and charged once at owner turn start.
 *
 * Event fields:
 *   id, name, text, sprite      identity + papercraft card art (effects.png)
 *   kind                        'emergency' | 'boon' | 'downturn' (card colour)
 *   weight                      relative draw chance (0 disables)
 *   duration                    rounds the event lasts (≥ 1), starting the round it's drawn
 *   mitigation                  'civic' → blocks inside a civic protection radius are unaffected
 *   income: [{ match, multiplier }]   per-block income multipliers while active
 *   costs:  [{ categories, multiplier }] build/upgrade cost multipliers while active
 *   targets: { categories, max, perOwner }  pick specific blocks when drawn
 *                                           (event is skipped if none are eligible)
 * match: { all: true } | { categories: [...] } | { targets: true }
 */
export const CITY_EVENTS = Object.freeze({
  /** A round may be calm; at most this many different events overlap. */
  ROUND_PROBABILITY: 0.65,
  MAX_ACTIVE: 2,
  /** Combined multipliers from overlapping events are clamped to this range. */
  MIN_MULTIPLIER: 0,
  MAX_MULTIPLIER: 2,

  POOL: Object.freeze([
    {
      id: 'heavy-rain', name: 'Heavy Rain', kind: 'emergency', weight: 12, duration: 1,
      sprite: 'effects:rain', mitigation: 'civic',
      text: 'Flooded parks close. Park income stops.',
      income: [{ match: { categories: ['park'] }, multiplier: 0 }],
    },
    {
      id: 'snowstorm', name: 'Snowstorm', kind: 'emergency', weight: 10, duration: 1,
      sprite: 'effects:snow', mitigation: 'civic',
      text: 'Snow slows the whole city. All income −25%.',
      income: [{ match: { all: true }, multiplier: 0.75 }],
    },
    {
      id: 'fire', name: 'Fire', kind: 'emergency', weight: 8, duration: 2,
      sprite: 'effects:boom', mitigation: 'civic',
      text: 'Fire breaks out! Struck blocks earn nothing while they recover.',
      targets: { categories: ['residential', 'commercial', 'industrial', 'landmark'], max: 2, perOwner: 1 },
      repairCost: 400,
      income: [{ match: { targets: true }, multiplier: 0 }],
    },
    {
      id: 'power-outage', name: 'Power Outage', kind: 'emergency', weight: 10, duration: 1,
      sprite: 'effects:alert', mitigation: 'civic',
      text: 'The grid goes dark. Commercial and Industrial income −50%.',
      income: [{ match: { categories: ['commercial', 'industrial'] }, multiplier: 0.5 }],
    },
    {
      id: 'city-festival', name: 'City Festival', kind: 'boon', weight: 10, duration: 1,
      sprite: 'effects:confetti',
      text: 'Crowds pack the streets. Commercial and Landmark income +50%.',
      income: [{ match: { categories: ['commercial', 'landmark'] }, multiplier: 1.5 }],
    },
    {
      id: 'housing-boom', name: 'Housing Boom', kind: 'boon', weight: 10, duration: 2,
      sprite: 'effects:boost',
      text: 'Everyone wants to move in. Residential income +50%, but homes cost 25% more to build.',
      income: [{ match: { categories: ['residential'] }, multiplier: 1.5 }],
      costs: [{ categories: ['residential'], multiplier: 1.25 }],
    },
    {
      id: 'beautification-grant', name: 'Beautification Grant', kind: 'boon', weight: 8, duration: 2,
      sprite: 'effects:sparkle',
      text: 'City grant money! Parks earn double and cost half to build or upgrade.',
      income: [{ match: { categories: ['park'] }, multiplier: 2 }],
      costs: [{ categories: ['park'], multiplier: 0.5 }],
    },
    {
      id: 'economic-boom', name: 'Economic Boom', kind: 'boon', weight: 8, duration: 1,
      sprite: 'effects:star-burst',
      text: 'Business is booming. All income +25%.',
      income: [{ match: { all: true }, multiplier: 1.25 }],
    },
    {
      id: 'recession', name: 'Recession', kind: 'downturn', weight: 8, duration: 2,
      sprite: 'effects:smoke',
      text: 'Belts tighten. All income −20%, but construction is 10% cheaper.',
      income: [{ match: { all: true }, multiplier: 0.8 }],
      costs: [{ categories: ['residential', 'commercial', 'park', 'civic', 'industrial', 'landmark'], multiplier: 0.9 }],
    },
  ].map((e) => Object.freeze(e))),
});
