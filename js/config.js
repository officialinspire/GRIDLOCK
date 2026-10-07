/** Shared constants for Grid Lock City. Pure data, no DOM. */

/** App release (kept equal to package.json "version"; shown on the title screen, stored in saves). */
export const APP_VERSION = '1.5.0';

export const BOARD_ROWS = 6;
export const BOARD_COLS = 6;

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;

/** Seat presets match the four colours/symbols in "ownership markers.png". */
export const PLAYER_PRESETS = Object.freeze([
  { seat: 1, name: 'Player 1', color: 'red', symbol: 'triangle', mark: '▲', hex: '#c8322b' },
  { seat: 2, name: 'Player 2', color: 'blue', symbol: 'diamond', mark: '◆', hex: '#1f4f9c' },
  { seat: 3, name: 'Player 3', color: 'yellow', symbol: 'circle', mark: '●', hex: '#e9a91e' },
  { seat: 4, name: 'Player 4', color: 'green', symbol: 'leaf', mark: '✦', hex: '#3a8a3a' },
]);

export const DEFAULT_SETTINGS = Object.freeze({
  sound: true, // master sound on/off (the mute switch)
  masterVolume: 80, // 0–100
  sfxVolume: 80, // 0–100
  ambience: true, // procedural tabletop/city background, game screen only
  ambienceVolume: 50, // 0–100
  music: true, // recorded themes: "Cardboard City" (menus, pause) and "Paper Blocks" (in play)
  musicVolume: 60, // 0–100
  confirmTaps: true, // touch screens: first tap previews a road, second tap paves it
  haptics: true, // vibration feedback on touch devices that support it (no effect elsewhere)
  reducedMotion: false,
  // Lighter presentation for lower-powered devices (css/effects.css): event cut-outs hold still,
  // softer shadows, no decorative loops. Gameplay information is unchanged. Only ever turned on
  // by the player, never from screen size.
  reducedEffects: false,
  showCoords: false,
  quickHandoff: false,
  cpuSpeed: 'normal', // how long CPU mayors pause before each move: relaxed | normal | fast
  // How CPU turns play back: full (every step paced and announced) | brief (only major events —
  // captures, takeovers, bankruptcy, auctions — are paced and announced) | instant (routine steps
  // run at once; major events are still announced, briefly).
  cpuPlayback: 'full',
  cityView: false, // the CITY VIEW / influence overlay on the board
  achievementPopups: true, // announce achievements the moment they're earned in play (js/ui/achievementView.js)
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

  /**
   * Final City Value = CASH × cash + LAND × land value + INVESTED_BUILDING × actual construction
   * spend + PRESTIGE × Prestige points (dollars per point). Land is discounted and buildings count
   * in full, so developing a city beats merely owning the most blocks.
   */
  SCORING: Object.freeze({
    CASH: 1,
    LAND: 0.7,
    INVESTED_BUILDING: 1,
    PRESTIGE: 150,
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
      park: Object.freeze({ cost: 800, income: 150 }),
      civic: Object.freeze({ cost: 2000, income: 325 }),
      industrial: Object.freeze({ cost: 1750, income: 600 }),
      landmark: Object.freeze({ cost: 3000, income: 850 }),
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
    /**
     * Recovery capital a bankrupt player restarts with (core/finance.js recoveryCapital):
     * CAPITAL for the first bankruptcy, then CAPITAL_DECAY_PERCENT of the previous amount each
     * time, but never below MIN_CAPITAL, so a mayor is never stuck at $0 with nothing to do.
     * Farming is prevented by the shrinking capital and the growing score penalty below.
     */
    RECOVERY: Object.freeze({ CAPITAL: 2000, CAPITAL_DECAY_PERCENT: 50, MIN_CAPITAL: 500 }),
    /**
     * Final-score penalty for going bankrupt (core/scoring.js). The nth bankruptcy costs
     * CITY_VALUE × n (so 1, 2, 3 bankruptcies cost 1×, 3×, 6× CITY_VALUE in all) and PRESTIGE
     * Prestige points each (a player's Prestige never goes below 0).
     */
    BANKRUPTCY_PENALTY: Object.freeze({ CITY_VALUE: 1000, PRESTIGE: 2 }),
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
    PARK_ADJACENCY: Object.freeze({ percentPerPark: 15, maxParks: 2, sameOwnerOnly: true }),
    /** A connected cluster of Residential/Commercial/Park containing all three: each member gets +percent. */
    MIXED_USE: Object.freeze({ percent: 10 }),
    /**
     * Civic protection radius (Manhattan distance, in blocks) by civic level.
     * Marks protected blocks so emergencies can be mitigated; no direct income effect.
     */
    CIVIC_PROTECTION: Object.freeze({ radiusByLevel: Object.freeze({ 1: 1, 2: 1, 3: 2 }), sameOwnerOnly: true }),
  }),

  /**
   * Strategic category effects (core/strategy.js, derived with the adjacency data by
   * refreshBonuses). Only developed, owned, active blocks produce effects. "Nearby" means within
   * RADIUS (Manhattan distance, in blocks); "adjacent" means sharing a road (distance 1).
   */
  STRATEGY: Object.freeze({
    RADIUS: 1,

    /**
     * Prestige: points that score PRESTIGE dollars each (SCORING). A block's own Prestige is
     * perLevel × its level; a Park also gives each adjacent same-owner developed block
     * parkNeighbour points (at most parkNeighbourMax Parks count per block). An Industrial block
     * adjacent to any developed Residential block (anyone's) loses industrialPenaltyPerLevel × its
     * level, unless an adjacent same-owner Park buffers it. A player's total never goes below 0.
     */
    PRESTIGE: Object.freeze({
      perLevel: Object.freeze({ residential: 0, commercial: 0, park: 1, civic: 1, industrial: 0, landmark: 3 }),
      parkNeighbour: 1,
      parkNeighbourMax: 2,
      industrialPenaltyPerLevel: 1,
    }),

    /** Industry: builds and upgrades adjacent to the builder's own developed Industrial block cost this % less. */
    INDUSTRY: Object.freeze({ costDiscountPercent: 10 }),
  }),

  /**
   * Hostile takeovers (core/takeover.js; strengths in core/strategy.js). CITY era only.
   *
   * controlStrength of an owned block =
   *     CONTROL.base (ownership)
   *   + CONTROL.perLevel × its building level
   *   + Σ CONTROL.defence[type] × level of its owner's developed Residential/Civic/Landmark
   *     blocks within ECONOMY.STRATEGY.RADIUS (itself included)
   *   + CONTROL.supportPerAdjacent × its owner's developed blocks across a road from it
   * developmentPressure of a player on a rival block =
   *     Σ over that player's developed blocks across a road from it:
   *       PRESSURE.perAdjacent + PRESSURE.commercialPerLevel × level (Commercial only)
   * A takeover needs pressure greater than control, costs one City Action, and at most
   * PER_TURN happen per player turn. The attacker pays PREMIUM_PERCENT of the block's market
   * value (land + list-price development); the defender receives the market value and the rest
   * is lost to redevelopment costs. Ownership moves with the development intact, and the block
   * is shielded from further takeovers until SHIELD_ROUNDS full rounds have passed.
   *
   * A block bought out of abandonment (a redevelopment purchase or auction, core/finance.js) is
   * shielded until its new owner has completed ACQUIRE_SHIELD_TURNS turns of their own after the
   * purchase. Bought on the new owner's own turn, one turn is exactly one full round.
   */
  TAKEOVER: Object.freeze({
    CONTROL: Object.freeze({
      base: 1,
      perLevel: 1,
      defence: Object.freeze({ residential: 1, civic: 1, landmark: 2 }),
      supportPerAdjacent: 1,
    }),
    PRESSURE: Object.freeze({ perAdjacent: 1, commercialPerLevel: 2 }),
    PREMIUM_PERCENT: 125,
    PER_TURN: 1,
    SHIELD_ROUNDS: 1,
    ACQUIRE_SHIELD_TURNS: 1,
  }),
});

/**
 * CPU mayor strategy (core/cpu/city.js). Tuning only: every price, income, upkeep, bonus and
 * event effect the CPU weighs comes from the real economy through core/forecast.js.
 */
export const CPU = Object.freeze({
  /** Pause before each CPU move, by the cpuSpeed setting, so people can follow along (ms). */
  THINK_MS: Object.freeze({ relaxed: 1100, normal: 650, fast: 220 }),
  /**
   * CPU turn playback (the cpuPlayback setting): the pause before a step by playback and step
   * kind. Full paces every step with THINK_MS; Brief paces major steps (captures, takeovers,
   * bankruptcy, debt sales, auctions, the final road) with THINK_MS and runs routine ones after a
   * short beat; Instant runs routine steps at once and major ones after THINK_MS.fast.
   */
  PLAYBACK_ROUTINE_MS: Object.freeze({ brief: 90, instant: 0 }),
  /** Cash a CPU mayor keeps in hand after any purchase (a table can pass its own). */
  RESERVE: Object.freeze({ easy: 300, normal: 1000, hard: 1000 }),
  /** Easy: chance to develop a block it just captured (when something sensible is affordable)… */
  EASY_BUILD_CHANCE: 0.75,
  /** …and, in Manage City, to build on or upgrade one of its blocks. */
  EASY_MANAGE_CHANCE: 0.35,
  /** Easy: chance it rethinks a road that would leave a three-sided block (else it plays it). */
  EASY_CAUTION: 0.7,
  /**
   * Hard roads: how much of the captures it expects back after the next mayor's reply counts,
   * by table size (in full at two players; others move in between at bigger tables)…
   */
  HARD_FOLLOW_UP: Object.freeze({ 2: 1, 3: 0.5, 4: 0.5 }),
  /** …and the largest table at which it will decline the last two blocks of a run to keep control. */
  HARD_DOUBLE_DEAL_MAX_PLAYERS: 4,
  /**
   * Hard roads, endgame at three or more players (no safe roads left): play the remaining chains
   * out, every mayor taking what it's offered and giving away as little as it can, to see which
   * sacrifice sends the long chains its way. Off: one reply ahead, as at two players.
   */
  HARD_ENDGAME_ROLLOUT: true,
  /** …starting once this few safe roads are left (0: only when none are). */
  HARD_ROLLOUT_SAFE_ROADS: 0,
  /** Hard: minimum expected return per dollar spent before it commits cash. */
  HARD_MIN_ROI: 0.05,
  /**
   * Takeovers (Normal/Hard only; Easy never attempts one). Conservative: the takeover, run for
   * real on a copy, must return at least MIN_RETURN × its price over the turns left (income net of
   * upkeep × turns + City Value change), there must be at least MIN_TURNS paydays left, and the
   * cash left must cover the reserve plus CASH_TURNS turns of upkeep.
   */
  TAKEOVER: Object.freeze({ MIN_RETURN: 0.25, MIN_TURNS: 1, CASH_TURNS: 2 }),
  /** Hard: its cash floor covers next turn's charges as if income fell by this share… */
  HARD_INCOME_CUT: 0.5,
  /** …plus this share of a Fire repair bill when a Fire could hit one of its buildings. */
  HARD_FIRE_BUFFER: 1,
  /** Hard: value per turn of civic shelter, as a share of the income it protects from emergencies. */
  CIVIC_SHELTER_VALUE: 0.15,
  /** Hard: share of a district bonus it counts for a build that leaves the district one block short. */
  DISTRICT_POTENTIAL: 0.5,
  /**
   * CPU personalities: priorities, never extra knowledge or different rules. Each weight
   * multiplies how much the mayor cares about something it has already valued from the real
   * forecasts, and stays modest (0.85–1.35) so difficulty always matters more than personality.
   *   categories    weight on a build/upgrade's value by category
   *   upgrade       weight on upgrading an existing building
   *   district      weight on district-completion value (Hard)
   *   shelter       weight on civic shelter value (Hard)
   *   redevelop     weight on buying abandoned land (opening auctions, and how much of its value it bids)
   *   reserve       multiplier on the default cash reserve
   *   followUp      weight on captures it expects next turn when choosing roads (Hard)
   */
  PERSONALITIES: Object.freeze({
    builder: Object.freeze({
      id: 'builder', name: 'Builder', blurb: 'Develops and upgrades, chasing districts.',
      categories: Object.freeze({ residential: 1.2, commercial: 1.1, park: 1, civic: 1, industrial: 1, landmark: 1.1 }),
      upgrade: 1.25, district: 1.35, shelter: 1, redevelop: 1, reserve: 0.9, followUp: 1,
    }),
    tycoon: Object.freeze({
      id: 'tycoon', name: 'Tycoon', blurb: 'Commerce, industry and income first.',
      categories: Object.freeze({ residential: 0.95, commercial: 1.25, park: 0.85, civic: 0.85, industrial: 1.25, landmark: 1.1 }),
      upgrade: 1.1, district: 1, shelter: 0.85, redevelop: 1, reserve: 1, followUp: 1,
    }),
    planner: Object.freeze({
      id: 'planner', name: 'Planner', blurb: 'Parks, civic buildings and mixed-use neighbourhoods.',
      categories: Object.freeze({ residential: 1.05, commercial: 1, park: 1.35, civic: 1.35, industrial: 0.9, landmark: 1 }),
      upgrade: 1, district: 1.1, shelter: 1.35, redevelop: 0.9, reserve: 1.15, followUp: 1,
    }),
    expansionist: Object.freeze({
      id: 'expansionist', name: 'Expansionist', blurb: 'Territory first: captures and abandoned land.',
      categories: Object.freeze({ residential: 0.95, commercial: 0.95, park: 0.9, civic: 0.9, industrial: 0.95, landmark: 0.9 }),
      upgrade: 0.9, district: 1, shelter: 1, redevelop: 1.3, reserve: 0.85, followUp: 1.3,
    }),
  }),
});

export const MAX_NAME_LENGTH = 16;

/**
 * Gameplay eras (core/game.js). EXPANSION is the road/capture game. Paving the final road starts
 * CITY: no more roads, but income, upkeep and events carry on while mayors build, upgrade, sell
 * and redevelop. The rest of the round in which the grid is finished is played as City turns,
 * then CITY lasts ROUNDS more full rounds and the match ends after the last seat of the last one.
 *
 *   ROUNDS            full City rounds after the grid is complete (0: the match ends on the final road)
 *   ACTIONS_PER_TURN  City Actions each mayor gets per City turn. A build, upgrade, voluntary sale
 *                     or downgrade, or redevelopment purchase/auction costs one. Selling to clear
 *                     debt, bankruptcy and developing a block just captured by the final road are free.
 *                     Voluntary sales, downgrades and redevelopment happen only in Manage City
 *                     (either era); debt recovery is allowed whenever the mayor is in debt.
 */
export const CITY_ERA = Object.freeze({
  ROUNDS: 4,
  ACTIONS_PER_TURN: 2,
});

/**
 * EXPANSION turn economy (core/game.js). A normal EXPANSION turn is ACTIONS_PER_TURN Development
 * Actions in Manage City, then the required road. A build, upgrade, voluntary sale or downgrade,
 * or redevelopment purchase/auction costs one. Paving ends Manage City, so an unspent action is
 * lost. Develop Now on a block just captured is a free capture reward, bonus roads are unchanged,
 * and selling to clear debt and bankruptcy stay free.
 */
export const EXPANSION_ERA = Object.freeze({
  ACTIONS_PER_TURN: 1,
});

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

/**
 * Rule presets for the New Game screen. A mode is pure configuration: createGame()
 * copies its `events` block into game.rules, and the event engine reads only that.
 * Player count is chosen separately (Standard Game = 4 players, Custom = 2–4), so
 * every mode works with any table.
 *
 *   events.enabled      false: no city events at all (no draws, no "calm round" notes)
 *   events.probability  chance a new event starts at the start of each round after the first
 *   events.maxActive    at most this many different events at once
 *   events.durationBonus  extra rounds every event lasts (on top of its own duration)
 */
export const GAME_MODES = Object.freeze({
  standard: Object.freeze({
    id: 'standard',
    name: 'Standard',
    blurb: 'The full rules: roads, captures, development and paced city events.',
    events: Object.freeze({ enabled: true, probability: CITY_EVENTS.ROUND_PROBABILITY, maxActive: CITY_EVENTS.MAX_ACTIVE, durationBonus: 0 }),
  }),
  classic: Object.freeze({
    id: 'classic',
    name: 'Classic',
    blurb: 'Pure strategy: roads, captures and development. No city events.',
    events: Object.freeze({ enabled: false, probability: 0, maxActive: 0, durationBonus: 0 }),
  }),
  chaos: Object.freeze({
    id: 'chaos',
    name: 'Urban Chaos',
    blurb: 'A city event every round, each lasting longer, up to three at once.',
    events: Object.freeze({ enabled: true, probability: 1, maxActive: 3, durationBonus: 1 }),
  }),
});
export const DEFAULT_MODE = 'standard';
