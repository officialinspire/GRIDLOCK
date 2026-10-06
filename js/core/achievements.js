/**
 * The 100 achievements (pure data; no DOM). Recording, storage and the facts each rule reads live
 * in core/career.js.
 *
 * Each achievement: { id, name, text, icon, group, tier, test(p, m, c), live?, secret?, progress? }
 *   test      p = one mayor's facts, m = the match, c = the career (after this match is recorded,
 *             or as it stands during play). See summarizeMatch / liveFacts in core/career.js.
 *   live      can unlock during play, the moment it happens: its rule reads only the facts the
 *             move log and the board give mid-match (LIVE_FACTS). Every rule also runs when a
 *             match is recorded, so nothing is missed.
 *   secret    shown as "Secret achievement" until earned.
 *   progress  (c, now) → [have, need] for goals built up over several matches.
 *
 * Earned once per device, credited to the mayor who got there first. Only people count.
 */
import { ECONOMY } from '../config.js';
import { CATEGORY_ORDER } from './buildings.js';
import { periodsOf } from './calendar.js';

/** The top building level (ECONOMY.DEVELOPMENT.MAX_LEVEL), for the level badges. */
const TOP_LEVEL = ECONOMY.DEVELOPMENT.MAX_LEVEL;

/** Badge tiers, rarest last, with the points each adds to the achievement score. */
export const TIERS = Object.freeze({
  bronze: Object.freeze({ id: 'bronze', label: 'Bronze', points: 10 }),
  silver: Object.freeze({ id: 'silver', label: 'Silver', points: 25 }),
  gold: Object.freeze({ id: 'gold', label: 'Gold', points: 50 }),
  platinum: Object.freeze({ id: 'platinum', label: 'Platinum', points: 100 }),
});
export const TIER_ORDER = Object.freeze(['bronze', 'silver', 'gold', 'platinum']);

/** Statistics screen sections, in order. */
export const GROUPS = Object.freeze([
  { id: 'career', label: 'Milestones' },
  { id: 'captures', label: 'Roads & Captures' },
  { id: 'building', label: 'Building' },
  { id: 'economy', label: 'Money & Prestige' },
  { id: 'victory', label: 'Victory' },
  { id: 'strategy', label: 'City Era & Strategy' },
  { id: 'events', label: 'Events & Survival' },
  { id: 'mischief', label: 'Mischief' },
  { id: 'streaks', label: 'Streaks & Habits' },
  { id: 'table', label: 'Table & Modes' },
].map((g) => Object.freeze(g)));

/** Thresholds the badges below use (tuned on tools/cpu-simulate.mjs games). */
export const GOALS = Object.freeze({
  FORTRESS_BLOCKS: 5,
  FORTRESS_CONTROL: 4,
  FACTORIES: 3,
  SHELTERED: 6,
  PARK_NETWORK: 4,
  INCOME: 4000,
  PRESTIGE: 20,
  LEVELS: 20,
  LANDSLIDE: 50000,
  NAIL_BITER: 1000,
  WEATHERED: 10,
  VACANT_LOTS: 6,
  IDLE_TURNS: 3,
});

/**
 * The facts a live rule may read: everything liveFacts() in core/career.js gives mid-match
 * (from the move log, the ledger and the board as it stands).
 */
export const LIVE_FACTS = Object.freeze([
  'seat', 'name', 'cpu', 'difficulty', 'captured', 'longestChain', 'doubleCaptures', 'roads', 'finalRoad',
  'developments', 'maxLevel', 'categories', 'topLandmark', 'takeovers', 'takeoversLost', 'mostFromOneRival',
  'evictions', 'payback', 'reclaimed', 'sales', 'topLevelSales', 'bankruptcies', 'neverInDebt', 'acquired',
  'contestedWins', 'restored', 'vulture', 'idleCityTurns', 'districtsOwned', 'fullDistrict',
]);

/** Career key for a mayor's name (one record per name, case-insensitive). */
export const mayorKey = (name) => String(name).trim().toLowerCase().slice(0, 40);
const mayorOf = (c, p) => c?.mayors?.[mayorKey(p.name)] ?? null;
const bestMayor = (c, read) => Math.max(0, ...Object.values(c?.mayors ?? {}).map(read));
const modesWon = (m) => Object.values(m?.modeWins ?? {}).filter((n) => n > 0).length;
const money = (n) => `$${n.toLocaleString('en-US')}`;

/** A streak still counts while its last period is this one or the one before. */
export function streakNow(c, kind, now = Date.now()) {
  const s = c?.streaks?.[kind];
  if (!s || s.last == null) return 0;
  return s.last >= periodsOf(now)[kind] - 1 ? s.current : 0;
}

const cpus = (m, difficulty) => (m.players ?? []).filter((x) => x.cpu && (!difficulty || x.difficulty === difficulty));

/* Small builders keep the 100 rules readable. */
const matches = (n) => ({ test: (p, m, c) => c.totals.matches >= n, progress: (c) => [c.totals.matches, n] });
const chain = (n) => ({ live: true, test: (p) => p.longestChain >= n });
const firstBuild = (category) => ({ live: true, test: (p) => (p.categories?.[category] ?? 0) >= 1 });
const streak = (kind, n) => ({
  test: (p, m, c) => (c.streaks?.[kind]?.best ?? 0) >= n,
  progress: (c, now) => [streakNow(c, kind, now), n],
});
const mayorWins = (n) => ({
  test: (p, m, c) => (mayorOf(c, p)?.won ?? 0) >= n,
  progress: (c) => [bestMayor(c, (x) => x.won), n],
});

const section = (group, list) => list.map((a) => Object.freeze({ group, ...a }));

export const ACHIEVEMENTS = Object.freeze([
  ...section('career', [
    { id: 'first-ribbon', name: 'Ribbon Cutting', text: 'Complete your first match.', icon: 'title:rosette', tier: 'bronze', test: () => true },
    { id: 'veteran', name: 'Veteran Mayor', text: 'Complete 10 matches on this device.', icon: 'title:shield', tier: 'silver', ...matches(10) },
    { id: 'seasoned', name: 'Seasoned Mayor', text: 'Complete 25 matches on this device.', icon: 'ui:seal-red', tier: 'gold', ...matches(25) },
    { id: 'mayor-for-life', name: 'Mayor for Life', text: 'Complete 100 matches on this device.', icon: 'civic:city-hall', tier: 'platinum', ...matches(100) },
    {
      id: 'surveyor', name: 'Surveyor', text: 'Capture 100 blocks across all your matches.', icon: 'title:ruler', tier: 'silver',
      test: (p, m, c) => c.totals.blocksCaptured >= 100, progress: (c) => [c.totals.blocksCaptured, 100],
    },
    {
      id: 'construction-crew', name: 'Construction Crew', text: 'Build or upgrade 100 times across all your matches.', icon: 'props:truck', tier: 'silver',
      test: (p, m, c) => c.totals.developments >= 100, progress: (c) => [c.totals.developments, 100],
    },
  ]),
  ...section('captures', [
    { id: 'groundbreaking', name: 'Groundbreaking', text: 'Capture your first block.', icon: 'markers:flag-red', tier: 'bronze', live: true, test: (p) => p.captured >= 1 },
    { id: 'chain-reaction', name: 'Chain Reaction', text: 'Capture 3 blocks in one chain.', icon: 'icons:road', tier: 'bronze', ...chain(3) },
    { id: 'grid-lock', name: 'Grid Lock!', text: 'Capture 5 blocks in one chain.', icon: 'roads:cross', tier: 'silver', ...chain(5) },
    { id: 'domino-effect', name: 'Domino Effect', text: 'Capture 8 blocks in one chain.', icon: 'roads:roundabout', tier: 'gold', ...chain(8) },
    { id: 'avalanche', name: 'Avalanche', text: 'Capture 12 blocks in one chain.', icon: 'effects:star-burst', tier: 'platinum', ...chain(12) },
    { id: 'two-for-one', name: 'Two for One', text: 'Close two blocks with a single road.', icon: 'roads:tee', tier: 'bronze', live: true, test: (p) => p.doubleCaptures >= 1 },
    { id: 'final-say', name: 'The Final Say', text: 'Pave the city\'s very last road.', icon: 'roads:crosswalk', tier: 'silver', live: true, test: (p) => p.finalRoad },
    { id: 'land-baron', name: 'Land Baron', text: 'Finish a match owning 10 or more blocks.', icon: 'icons:map', tier: 'silver', test: (p) => p.blocks >= 10 },
    { id: 'half-the-city', name: 'Half the City', text: 'Finish a match owning 18 or more blocks.', icon: 'markers:pennant-blue', tier: 'gold', test: (p) => p.blocks >= 18 },
  ]),
  ...section('building', [
    { id: 'home-sweet-home', name: 'Home Sweet Home', text: 'Build a Residential block.', icon: 'buildings:house', tier: 'bronze', ...firstBuild('residential') },
    { id: 'open-for-business', name: 'Open for Business', text: 'Build a Commercial block.', icon: 'buildings:corner-store', tier: 'bronze', ...firstBuild('commercial') },
    { id: 'breath-of-fresh-air', name: 'Breath of Fresh Air', text: 'Build a Park.', icon: 'parks:garden', tier: 'bronze', ...firstBuild('park') },
    { id: 'public-servant', name: 'Public Servant', text: 'Build a Civic building.', icon: 'civic:library', tier: 'bronze', ...firstBuild('civic') },
    { id: 'smokestack', name: 'Smokestack', text: 'Build an Industrial block.', icon: 'civic:factory', tier: 'bronze', ...firstBuild('industrial') },
    { id: 'landmark-decision', name: 'Landmark Decision', text: 'Build a Landmark.', icon: 'civic:monument', tier: 'bronze', ...firstBuild('landmark') },
    { id: 'skyline', name: 'Skyline', text: `Raise a building to Level ${TOP_LEVEL}.`, icon: 'icons:building', tier: 'silver', live: true, test: (p) => p.maxLevel >= TOP_LEVEL },
    { id: 'wonder-of-the-city', name: 'Wonder of the City', text: `Raise a Landmark to Level ${TOP_LEVEL}.`, icon: 'civic:stadium', tier: 'gold', live: true, test: (p) => p.topLandmark },
    { id: 'master-builder', name: 'Master Builder', text: 'Build or upgrade 8 times in one match.', icon: 'icons:star', tier: 'bronze', live: true, test: (p) => p.developments >= 8 },
    { id: 'construction-boom', name: 'Construction Boom', text: 'Build or upgrade 20 times in one match.', icon: 'roads:lot-construction', tier: 'silver', live: true, test: (p) => p.developments >= 20 },
    { id: 'full-palette', name: 'Full Palette', text: 'Finish with all six building types.', icon: 'buildings:market', tier: 'silver', test: (p) => p.categoryTypes >= CATEGORY_ORDER.length },
    { id: 'mixed-use', name: 'Mixed Use', text: 'Finish with a mixed-use cluster.', icon: 'icons:home', tier: 'silver', test: (p) => p.mixedUse },
    { id: 'metropolis', name: 'Metropolis', text: `Finish with ${GOALS.LEVELS}+ development levels.`, icon: 'title:skyline', tier: 'silver', test: (p) => p.totalLevels >= GOALS.LEVELS },
    { id: 'heavy-industry', name: 'Heavy Industry', text: `Finish with ${GOALS.FACTORIES} Level ${TOP_LEVEL} Industrial blocks.`, icon: 'icons:gear', tier: 'gold', test: (p) => p.industrialL3 >= GOALS.FACTORIES },
    { id: 'green-belt', name: 'Green Belt', text: `Finish with ${GOALS.PARK_NETWORK} connected parks.`, icon: 'icons:tree', tier: 'silver', test: (p) => p.parkNetwork >= GOALS.PARK_NETWORK },
  ]),
  ...section('economy', [
    { id: 'big-city', name: 'Big City', text: 'Finish with a City Value of $40,000 or more.', icon: 'buildings:rowhouses', tier: 'bronze', test: (p) => p.cityValue >= 40000 },
    { id: 'boomtown', name: 'Boomtown', text: 'Finish with a City Value of $75,000 or more.', icon: 'buildings:office', tier: 'silver', test: (p) => p.cityValue >= 75000 },
    { id: 'megacity', name: 'Megacity', text: 'Finish with a City Value of $120,000 or more.', icon: 'buildings:apartments', tier: 'gold', test: (p) => p.cityValue >= 120000 },
    { id: 'cash-machine', name: 'Cash Machine', text: `Finish earning ${money(GOALS.INCOME)}+ per turn.`, icon: 'icons:coins', tier: 'bronze', test: (p) => p.income >= GOALS.INCOME },
    { id: 'money-printer', name: 'Money Printer', text: 'Finish earning $10,000+ per turn.', icon: 'effects:boost', tier: 'silver', test: (p) => p.income >= 10000 },
    { id: 'gold-mine', name: 'Gold Mine', text: 'Finish earning $20,000+ per turn.', icon: 'effects:sparkle', tier: 'gold', test: (p) => p.income >= 20000 },
    { id: 'toast-of-the-town', name: 'Toast of the Town', text: `Finish with ${GOALS.PRESTIGE}+ Prestige.`, icon: 'buildings:diner', tier: 'bronze', test: (p) => p.prestige >= GOALS.PRESTIGE },
    { id: 'pillar-of-the-community', name: 'Pillar of the Community', text: 'Finish with 50+ Prestige.', icon: 'civic:museum', tier: 'silver', test: (p) => p.prestige >= 50 },
    { id: 'crown-jewel', name: 'Crown Jewel', text: 'Finish with 90+ Prestige.', icon: 'props:statue', tier: 'gold', test: (p) => p.prestige >= 90 },
  ]),
  ...section('victory', [
    { id: 'mayor-of-the-year', name: 'Mayor of the Year', text: 'Win a match.', icon: 'icons:trophy', tier: 'bronze', test: (p) => p.won },
    { id: 'photo-finish', name: 'Photo Finish', text: 'Share first place in a tie.', icon: 'icons:zoom-in', tier: 'gold', test: (p, m) => p.won && m.tie },
    { id: 'comeback', name: 'Comeback Kid', text: 'Win a match after declaring bankruptcy.', icon: 'icons:restart', tier: 'gold', test: (p) => p.won && p.bankruptcies > 0 },
    { id: 'balanced-budget', name: 'Balanced Budget', text: 'Win without ever falling into debt.', icon: 'icons:save', tier: 'silver', test: (p) => p.won && p.neverInDebt },
    { id: 'landslide', name: 'Landslide', text: `Win by ${money(GOALS.LANDSLIDE)} or more.`, icon: 'effects:confetti', tier: 'silver', test: (p, m) => p.won && !m.tie && p.margin >= GOALS.LANDSLIDE },
    { id: 'nail-biter', name: 'Nail-Biter', text: `Win by less than ${money(GOALS.NAIL_BITER)}.`, icon: 'icons:clock', tier: 'gold', test: (p, m) => p.won && !m.tie && p.margin > 0 && p.margin < GOALS.NAIL_BITER },
    {
      id: 'small-but-mighty', name: 'Small but Mighty', text: 'Win while a rival owns more blocks.', icon: 'buildings:cafe', tier: 'silver',
      test: (p, m) => p.won && (m.players ?? []).some((x) => x.seat !== p.seat && x.blocks > p.blocks),
    },
    { id: 're-elected', name: 'Re-elected', text: 'Win 5 matches as the same mayor.', icon: 'title:ribbon-blue', tier: 'silver', ...mayorWins(5) },
    { id: 'dynasty', name: 'Political Dynasty', text: 'Win 10 matches as the same mayor.', icon: 'title:ribbon-red', tier: 'gold', ...mayorWins(10) },
    {
      id: 'hat-trick', name: 'Hat Trick', text: 'Win 3 matches in a row as the same mayor.', icon: 'title:plate-gold', tier: 'gold',
      test: (p, m, c) => (mayorOf(c, p)?.bestStreak ?? 0) >= 3, progress: (c) => [bestMayor(c, (x) => x.streak), 3],
    },
    {
      id: 'triple-crown', name: 'Triple Crown', text: 'One mayor wins Standard, Classic and Urban Chaos.', icon: 'ui:plaque-medal', tier: 'gold',
      test: (p, m, c) => modesWon(mayorOf(c, p)) >= 3, progress: (c) => [bestMayor(c, modesWon), 3],
    },
  ]),
  ...section('strategy', [
    { id: 'hostile-bid', name: 'Hostile Bid', text: 'Make your first hostile takeover.', icon: 'icons:swap', tier: 'bronze', live: true, test: (p) => p.takeovers >= 1 },
    {
      id: 'fortress', name: 'Fortress City', text: `End the City era with ${GOALS.FORTRESS_BLOCKS}+ blocks at control ${GOALS.FORTRESS_CONTROL}+, none lost.`, icon: 'props:brick-wall', tier: 'gold',
      test: (p, m) => m.cityEra && p.takeoversLost === 0 && p.blocks >= GOALS.FORTRESS_BLOCKS && p.minControl >= GOALS.FORTRESS_CONTROL,
    },
    { id: 'safe-streets', name: 'Safe Streets', text: `Finish with ${GOALS.SHELTERED}+ blocks under civic protection.`, icon: 'civic:police', tier: 'silver', test: (p) => p.sheltered >= GOALS.SHELTERED },
    { id: 'district-boss', name: 'District Boss', text: 'Own every block of a district.', icon: 'props:fredericksburg-sign', tier: 'silver', live: true, test: (p) => p.districtsOwned >= 1 },
    { id: 'kingpin', name: 'Kingpin', text: 'Own two whole districts at once.', icon: 'markers:seal-yellow', tier: 'platinum', live: true, test: (p) => p.districtsOwned >= 2 },
    { id: 'redeveloper', name: 'Redeveloper', text: 'Buy an abandoned block.', icon: 'parks:empty-lot', tier: 'bronze', live: true, test: (p) => p.acquired >= 1 },
    { id: 'bidding-war', name: 'Bidding War', text: 'Win an auction another mayor bid in too.', icon: 'ui:speech', tier: 'silver', live: true, test: (p) => p.contestedWins >= 1 },
    { id: 'restoration', name: 'Restoration Society', text: 'Restore an abandoned building instead of clearing it.', icon: 'civic:theater', tier: 'silver', live: true, test: (p) => p.restored >= 1 },
  ]),
  ...section('events', [
    { id: 'weathered', name: 'Weathered the Storm', text: `Complete a match that saw ${GOALS.WEATHERED}+ city events.`, icon: 'effects:rain', tier: 'silver', test: (p, m) => m.eventsSurvived >= GOALS.WEATHERED },
    {
      id: 'storm-veteran', name: 'Storm Veteran', text: 'Survive 50 city events across all your matches.', icon: 'effects:wind', tier: 'gold',
      test: (p, m, c) => c.totals.eventsSurvived >= 50, progress: (c) => [c.totals.eventsSurvived, 50],
    },
    { id: 'in-the-red', name: 'In the Red', text: 'Fall into debt.', icon: 'effects:alert', tier: 'bronze', live: true, test: (p) => !p.neverInDebt },
    { id: 'rock-bottom', name: 'Rock Bottom', text: 'Declare bankruptcy.', icon: 'effects:demolish', tier: 'bronze', live: true, test: (p) => p.bankruptcies >= 1 },
    {
      id: 'phoenix', name: 'Phoenix', text: 'Go bankrupt, then finish in the top two of 3+ mayors.', icon: 'effects:sunburst', tier: 'gold',
      test: (p, m) => p.bankruptcies > 0 && p.rank <= 2 && (m.players?.length ?? 0) >= 3,
    },
  ]),
  ...section('mischief', [
    { id: 'corporate-raider', name: 'Corporate Raider', text: 'Make 3 hostile takeovers in one match.', icon: 'civic:warehouse', tier: 'gold', live: true, test: (p) => p.takeovers >= 3 },
    { id: 'thorn-in-the-side', name: 'Thorn in the Side', text: 'Take two blocks from the same rival in one match.', icon: 'props:fence', tier: 'silver', live: true, test: (p) => p.mostFromOneRival >= 2 },
    { id: 'eviction-notice', name: 'Eviction Notice', text: 'Take over a rival\'s Residential block.', icon: 'ui:note-yellow', tier: 'bronze', live: true, test: (p) => p.evictions >= 1 },
    { id: 'payback', name: 'Payback', text: 'Take over a block from a mayor who took one of yours.', icon: 'icons:undo', tier: 'silver', live: true, test: (p) => p.payback },
    { id: 'reclaimed', name: 'Reclaimed', text: 'Take back a block that was taken from you.', icon: 'markers:flag-green', tier: 'gold', live: true, secret: true, test: (p) => p.reclaimed },
    { id: 'hostile-environment', name: 'Hostile Environment', text: 'Lose a block to a hostile takeover.', icon: 'effects:smoke', tier: 'bronze', live: true, test: (p) => p.takeoversLost >= 1 },
    { id: 'bad-neighbour', name: 'Bad Neighbour', text: 'Finish with a factory next door to a rival\'s home.', icon: 'props:power-pole', tier: 'bronze', secret: true, test: (p) => p.badNeighbour },
    { id: 'holdout', name: 'The Holdout', text: 'Finish holding the one block a rival needs for a district.', icon: 'props:traffic-light', tier: 'silver', secret: true, test: (p) => p.holdout },
    { id: 'vulture', name: 'Vulture', text: 'Buy land another mayor abandoned.', icon: 'parks:parking-lot', tier: 'silver', live: true, test: (p) => p.vulture },
    { id: 'fire-sale', name: 'Fire Sale', text: `Sell or downgrade a Level ${TOP_LEVEL} building.`, icon: 'civic:fire-station', tier: 'bronze', live: true, test: (p) => p.topLevelSales >= 1 },
    {
      id: 'couch-mayor', name: 'Couch Mayor', text: `End ${GOALS.IDLE_TURNS} City turns without spending a City Action.`, icon: 'props:bench', tier: 'bronze',
      live: true, secret: true, test: (p) => p.idleCityTurns >= GOALS.IDLE_TURNS,
    },
    { id: 'land-speculator', name: 'Land Speculator', text: `Finish a match with ${GOALS.VACANT_LOTS}+ vacant lots.`, icon: 'roads:lot-grass', tier: 'bronze', secret: true, test: (p) => p.vacantLots >= GOALS.VACANT_LOTS },
    {
      id: 'participation-trophy', name: 'Participation Trophy', text: 'Finish dead last in a four-mayor match.', icon: 'ui:corner-flag', tier: 'bronze', secret: true,
      test: (p, m) => (m.players?.length ?? 0) === 4 && p.rank === 4,
    },
    {
      id: 'humbled', name: 'Humbled', text: 'Finish behind an Easy CPU mayor.', icon: 'props:trash-can', tier: 'bronze', secret: true,
      test: (p, m) => cpus(m, 'easy').some((x) => x.rank < p.rank),
    },
  ]),
  ...section('streaks', [
    { id: 'daily-2', name: 'See You Tomorrow', text: 'Complete matches on 2 days in a row.', icon: 'props:streetlamp', tier: 'bronze', ...streak('day', 2) },
    { id: 'daily-3', name: 'Daily Commute', text: 'Complete matches on 3 days in a row.', icon: 'props:bus-stop', tier: 'silver', ...streak('day', 3) },
    { id: 'daily-7', name: 'Seven-Day Week', text: 'Complete matches on 7 days in a row.', icon: 'props:bike', tier: 'gold', ...streak('day', 7) },
    { id: 'daily-30', name: 'The City Never Sleeps', text: 'Complete matches on 30 days in a row.', icon: 'props:water-tower', tier: 'platinum', ...streak('day', 30) },
    { id: 'weekly-2', name: 'Weekly Planner', text: 'Complete matches 2 weeks in a row.', icon: 'title:note-yellow-taped', tier: 'bronze', ...streak('week', 2) },
    { id: 'weekly-4', name: 'Council Regular', text: 'Complete matches 4 weeks in a row.', icon: 'title:pin-red', tier: 'silver', ...streak('week', 4) },
    { id: 'weekly-12', name: 'Quarterly Report', text: 'Complete matches 12 weeks in a row.', icon: 'title:clip-blue', tier: 'gold', ...streak('week', 12) },
    { id: 'monthly-2', name: 'Return Visit', text: 'Complete matches 2 months in a row.', icon: 'title:note-cream-taped', tier: 'bronze', ...streak('month', 2) },
    { id: 'monthly-3', name: 'Season Pass', text: 'Complete matches 3 months in a row.', icon: 'props:tree-oak', tier: 'silver', ...streak('month', 3) },
    { id: 'monthly-6', name: 'Half-Year Plan', text: 'Complete matches 6 months in a row.', icon: 'props:tree-pine', tier: 'gold', ...streak('month', 6) },
    { id: 'monthly-12', name: 'Anniversary', text: 'Complete matches 12 months in a row.', icon: 'effects:leaves', tier: 'platinum', ...streak('month', 12) },
    {
      id: 'marathon', name: 'Marathon Session', text: 'Complete 3 matches in one day.', icon: 'props:car-red', tier: 'silver',
      test: (p, m, c) => (c.today?.matches ?? 0) >= 3,
      progress: (c, now) => [c.today?.day === periodsOf(now).day ? c.today.matches : 0, 3],
    },
    {
      id: 'weekend-warrior', name: 'Weekend Warrior', text: 'Complete matches on a Saturday and the next Sunday.', icon: 'parks:picnic-grove', tier: 'silver',
      test: (p, m) => m.clock?.weekday === 0 && m.clock.previousDay === m.clock.day - 1,
    },
    {
      id: 'night-owl', name: 'Night Owl', text: 'Finish a match between midnight and 4 a.m.', icon: 'effects:glow', tier: 'bronze', secret: true,
      test: (p, m) => m.clock != null && m.clock.hour < 4,
    },
  ]),
  ...section('table', [
    { id: 'storm-chaser', name: 'Storm Chaser', text: 'Complete an Urban Chaos match.', icon: 'effects:streaks', tier: 'bronze', test: (p, m) => m.mode === 'chaos' },
    { id: 'purist', name: 'Purist', text: 'Win a Classic match.', icon: 'icons:crown', tier: 'bronze', test: (p, m) => p.won && m.mode === 'classic' },
    { id: 'by-the-book', name: 'By the Book', text: 'Win a Standard match.', icon: 'civic:school', tier: 'bronze', test: (p, m) => p.won && m.mode === 'standard' },
    { id: 'eye-of-the-storm', name: 'Eye of the Storm', text: 'Win an Urban Chaos match.', icon: 'effects:splash', tier: 'silver', test: (p, m) => p.won && m.mode === 'chaos' },
    { id: 'full-house', name: 'Full House', text: 'Complete a match with four people at the table.', icon: 'buildings:duplex', tier: 'silver', test: (p, m) => m.humans === 4 },
    {
      id: 'solo-act', name: 'Solo Act', text: 'Complete a match alone against CPU mayors.', icon: 'icons:play', tier: 'bronze',
      test: (p, m) => m.humans === 1 && cpus(m).length >= 1,
    },
    { id: 'hard-drive', name: 'Hard Drive', text: 'Win against a Hard CPU mayor.', icon: 'civic:substation', tier: 'gold', test: (p, m) => p.won && cpus(m, 'hard').length >= 1 },
    { id: 'against-all-odds', name: 'Against All Odds', text: 'Win against three Hard CPU mayors.', icon: 'effects:boom', tier: 'platinum', test: (p, m) => p.won && cpus(m, 'hard').length >= 3 },
    { id: 'deja-vu', name: 'Déjà Vu', text: 'Complete the same city seed twice.', icon: 'title:arrow-left', tier: 'bronze', test: (p, m) => m.seenSeed === true },
  ]),
]);

export const getAchievement = (id) => ACHIEVEMENTS.find((a) => a.id === id) ?? null;
export const pointsOf = (def) => TIERS[def.tier].points;
export const MAX_POINTS = ACHIEVEMENTS.reduce((n, a) => n + pointsOf(a), 0);

/** [have, need] for an achievement built up over matches (have capped at need), or null. */
export function progressOf(def, career, now = Date.now()) {
  if (!def.progress) return null;
  const [have, need] = def.progress(career, now);
  return [Math.min(Math.max(0, have), need), need];
}
