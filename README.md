# Grid Lock City

A papercraft tabletop city-building game for 2–4 local players, built with plain HTML, CSS and JavaScript (ES modules). There's no build step, so it runs as-is on GitHub Pages.

> **Status: v0.6 city events.** 4-player Dots & Boxes with roads is playable end to end: menus, settings, 4-seat local setup, the 6×6 city, captures and chains, cash, capture rewards, block development (6 categories × 3 levels), adjacency/district bonuses, city events, turn income, the HUD and a results screen.

## How it plays

The city is a 6×6 grid of blocks on a 7×7 lattice of intersections, with 84 possible roads.

1. Players take turns in seat order: P1 → P2 → P3 → P4, skipping empty seats.
2. On your turn, tap the gap between two neighbouring intersections to **pave a road**. You can't pave a road twice, and there are no diagonals.
3. Paving the **last** road around a block **claims** it for you. The block takes your colour, border, seal and flag. One road can close two blocks.
4. Claiming at least one block gives you **another road**, so captures can chain. A road that closes nothing passes the turn.
5. The game ends when all 36 blocks are claimed. The most blocks wins, and ties go to net worth.

## Economy

All money values live in the `ECONOMY` block in `js/config.js`. That covers starting cash, the capture reward, land values by district, and development costs and income. Land values, the development tables, the How To Play copy and the setup summary all read from it.

| Rule | Default |
| --- | --- |
| Starting cash | $12,000 per player |
| Capture reward | $500 per block claimed (a double capture pays $1,000) |
| Turn income | Paid when a player's turn **starts**, from their **developed** blocks. Bonus roads are the same turn, so they don't pay again. |
| Undeveloped blocks | $0 recurring income |
| Net property value | Land value (suburbs $1,000 · midtown $1,500 · downtown $2,000) plus building cost |
| Net worth | Cash plus net property value |

### Development

A captured block starts **Vacant, Level 0** (no income). On their own turn, the owner taps the block (or selects it and presses **Build**) to open the Build/Upgrade panel.

| Category | Level 1 cost | Income/turn | Level 2 (upgrade cost / income) | Level 3 |
| --- | --- | --- | --- | --- |
| Residential | $1,000 | $300 | $1,500 / $600 | $2,000 / $900 |
| Commercial | $1,500 | $500 | $2,250 / $1,000 | $3,000 / $1,500 |
| Park | $800 | $100 | $1,200 / $200 | $1,600 / $300 |
| Civic | $2,000 | $250 | $3,000 / $500 | $4,000 / $750 |
| Industrial | $1,750 | $600 | $2,625 / $1,200 | $3,500 / $1,800 |
| Landmark | $3,000 | $700 | $4,500 / $1,400 | $6,000 / $2,100 |

Only Level 1 is set per category (`ECONOMY.DEVELOPMENT.CATEGORIES`). Levels 2–3 come from multipliers in `ECONOMY.DEVELOPMENT.LEVELS` (cost ×1 / ×1.5 / ×2, income ×1 / ×2 / ×3), and `core/development.js` rejects any config that produces fractional dollars. The rules:
- Only the owner can develop, and only on their turn.
- The player must be able to afford it; the panel shows how much more they need.
- "Leave Vacant" is always an option.
- Cash is deducted immediately.
- A category can't be changed once built.

Each block stores its `type`, `level`, `value` (land + invested) and `income`. The board shows the building art plus a badge with the category icon and level pips. Names and art per level live in `core/buildings.js`.

### Adjacency & district bonuses

All percentages are in `ECONOMY.BONUSES` in `js/config.js`. "Connected" means orthogonally adjacent blocks with the same owner that are developed (Level 1+).

| Bonus | Rule | Default |
| --- | --- | --- |
| Residential district | 3+ connected Residential | +20% each |
| Commercial district | 3+ connected Commercial | +25% each |
| Park adjacency | Each directly adjacent same-owner Park boosts a Residential block (max 2 parks) | +10% per park |
| Mixed-use | A connected Residential/Commercial/Park cluster containing all three | +10% each member |
| Civic protection | Civic blocks cover same-owner blocks within a Manhattan radius (L1: 1, L2: 1, L3: 2) | Hook only: `isProtected(block)` for future events |

`core/bonuses.js` → `refreshBonuses(board)` recomputes everything from scratch after every capture and every build/upgrade. The results are stored on each block as `bonuses`, `bonusIncome` and `protectedBy`. There's no incremental state, so nothing goes stale. Bonuses are a percentage of the block's **base** (level) income and never compound on each other. Each bonus type applies at most once per block, and connected groups are found with an iterative flood fill that tracks visited blocks, so cycles can't double count. Turn income pays base plus bonuses.

In the UI: the HUD income includes bonuses, with a small ★ and a tooltip giving the bonus amount. Board badges get a ★ when a block earns a bonus. The details panel and Build panel list each bonus and any civic protection. A toast announces newly gained bonus income.

### City events

After every full round (when play wraps back to the first seat), one event is drawn from a weighted pool, **before** that round's turn income is paid. The whole pool lives in `CITY_EVENTS` in `js/config.js`: weight, duration, text, card art, income multipliers per category, cost multipliers, targeting, and whether civic buildings mitigate it.

| Event | Kind | Rounds | Effect |
| --- | --- | --- | --- |
| Heavy Rain | emergency | 1 | Park income stops |
| Snowstorm | emergency | 1 | All income −25% |
| Fire | emergency | 2 | Up to 2 developed blocks (max 1 per player) earn nothing |
| Power Outage | emergency | 1 | Commercial + Industrial income −50% |
| City Festival | boon | 1 | Commercial + Landmark income +50% |
| Housing Boom | boon | 2 | Residential income +50%, homes cost 25% more |
| Beautification Grant | boon | 2 | Parks earn ×2 and cost half |
| Economic Boom | boon | 1 | All income +25% |
| Recession | downturn | 2 | All income −20%, construction 10% cheaper |

How it stays safe (`core/events.js`):
- **Nothing is written:** events never touch blocks, cash or ownership. `game.events.active` holds `{ id, startRound, endRound, targets }`, and income and costs are derived from that list whenever they're needed. An event expires by being removed from the list, so it can't leave a permanent change behind.
- **No duplicates:** re-drawing an active event refreshes its duration instead of adding a second copy. Overlapping different events multiply, clamped to ×0–×2.
- **Civic mitigation:** emergencies skip any block inside a civic protection radius (`isProtected`). This is checked live, so building a civic mid-event helps immediately.
- **Reproducible randomness:** draws use a seeded PRNG stored in the game (`game.seed` / `game.rngState`). Add `?seed=123` to the URL to replay a game's events. Fire is capped and spread out: at most 2 targets, 1 per player.
- **Prices:** cost events change what you pay, but block value uses the list price.

In the UI, a papercraft event card lists the affected blocks, anything shielded, and the duration. Active events show as pills under the top bar (tap one to reopen its card). Affected blocks get a red, green or blue outline and the event's icon. The details panel lists each event on a block, the HUD income shows ▲/▼ with a tooltip, and the Build panel shows adjusted prices.

Money safety: every balance change goes through `credit()`/`debit()` in `core/economy.js`. They only accept finite, non-negative whole-dollar amounts, refuse to overdraw, detect corrupted balances, and record every change in `game.ledger`. Turn income and property value read the `income`/`value` stored on each block.

## Play locally

ES modules don't load over `file://`, so serve the folder:

```bash
npm start            # zero-dependency server → http://127.0.0.1:8080/
# or: python3 -m http.server 8080
```

## Deploy to GitHub Pages

Settings → Pages → *Deploy from a branch* → `main` / root. `.nojekyll` is included so every file is served untouched.

## Project layout

```
index.html                 All screens (title, how-to, settings, setup, game)
css/
  tokens.css               Colours, type, shadows (sampled from the art)
  base.css                 Reset, tabletop backdrop, sprite primitive
  components.css           Paper panels, buttons, toggles, ribbon, modal, toasts
  screens.css              Title / How To Play / Settings / Setup
  game.css                 Board grid, HUD cards, inspector, action bar
js/
  main.js                  Bootstrap
  config.js                Board size, player seats/colours, default settings
  assets.js                Sprite-sheet manifest + responsive sprite helpers
  core/                    Game rules, pure logic with no DOM (unit-tested in Node)
    board.js               6×6 block grid, districts, road/edge geometry
    game.js                placeRoad(): validation, captures, bonus roads, turns, standings
    economy.js             Safe credit/debit + ledger, rewards, turn income, property value
    buildings.js           Development categories: names, blurbs and art per level
    development.js         Build/upgrade rules, quotes and derived cost/income tables
    bonuses.js             Adjacency/district bonuses + civic protection (pure recompute)
    events.js              City event engine: weighted draw, lifecycle, derived modifiers
    rng.js                 Seeded PRNG (mulberry32) stored in game state
    settings.js            Persisted settings (localStorage, fails safe)
    bus.js                 Pub/sub between core and UI
  ui/                      DOM rendering and input
    router.js              Screen switching + back stack
    setupView.js           4-seat new game form
    boardView.js           Board renderer (intersections, road slots, blocks)
    hud.js                 Player cards, round & turn banner
    gameView.js            Game controller (moves, capture feedback, results, pause)
    buildPanel.js          Build/Upgrade panel for the current player's blocks
    bonusView.js           Shared bonus/protection lines
    eventView.js           Event card, active-event pills, block event lines
    settingsView.js        Settings form ↔ storage
    toast.js, dom.js       Helpers
dev/sprites.html           Sprite atlas: every registered crop, for checking coordinates
tests/
  unit/core.test.mjs       Node unit tests for core modules
  unit/dots-and-boxes.test.mjs  Road geometry, rotation, edge/corner/double/chain captures, full games
  unit/economy.test.mjs    Constants, money safety, rewards, 4-player turn-income flow, ledger reconciliation
  unit/development.test.mjs  Level tables, purchases, upgrades, insufficient funds, owner-only, invalid input
  unit/bonuses.test.mjs    Districts, parks, mixed use, loops/full board, no compounding, protection, fuzzed invariants
  unit/events.test.mjs     Pool data, weighted/seeded draws, trigger timing, duration/expiry, no stacking, mitigation, fire, costs, full games
  smoke.mjs                Playwright smoke test across 5 viewports
  serve.mjs                Static server used by `npm start` and the smoke test
*.png                      Original papercraft sprite sheets (unmodified)
```

## Art assets

The original sprite sheets stay at the repo root, unmodified. `js/assets.js` maps sprite names to pixel rectangles, e.g. `createSprite('buildings:diner')` or `<span data-sprite="icons:gear"></span>`. Sprites scale with their element's width.

| Sheet | Key | Notes |
| --- | --- | --- |
| `title_menu decor.png` | `title` | Logo, skyline, pins, notes, ribbons |
| `UI icons.png` | `icons` | 24 UI icons |
| `UI buttons_panels.png` | `ui` | Buttons, toggles, plaques |
| `ownership markers.png` | `markers` | `{flag,pennant,ring,chip,corner,frame,post,seal}-{red,blue,yellow,green}` |
| `roads_infrastructure.png` | `roads` | Road tiles and lots |
| `parks_open spaces.png` | `parks` | 12 park/open-space blocks |
| `residential_commercial buildings.png` | `buildings` | 12 homes and shops |
| `civic-buildings.png` | `civic` | 15 civic/industrial buildings |
| `effects.png` | `effects` | Weather and FX bursts |
| `props_decor.png` | `props` | Not used yet: the checkerboard is baked into the image (it has no alpha channel) |

Open `dev/sprites.html` through the local server to see every crop.

## Tests

```bash
npm test             # unit tests (node:test)
npm run test:smoke   # browser smoke test; screenshots → test-results/
```

The smoke test runs the whole flow through the real UI: title → how to play → settings persistence → setup → rotation → a rejected duplicate road → a capture with a bonus road and its $500 reward → Leave Vacant, build and upgrade through the panel → paving every road to the results screen → rematch → pause → quit. It does this at desktop, laptop, tablet, phone and phone-landscape sizes, plus a seeded Fire event scenario, a district-bonus scenario played through the UI and a check with animations on that the HUD money counter runs. It fails on any console error, failed request or horizontal overflow. It uses a local `playwright` install if there is one and otherwise falls back to a global install.
