# Grid Lock City

A papercraft tabletop city-building game designed for **exactly 4 players on one device**. A Custom Game preserves 2–3 player support. It plays like Dots & Boxes with roads: pave streets between intersections, enclose city blocks to claim them, develop them into neighbourhoods, weather city events, and finish with the most valuable city.

It's plain HTML, CSS and JavaScript (ES modules) with **no build step and no runtime dependencies**, so it runs on GitHub Pages as-is. It is also an **installable offline app (PWA)**: after the first visit it starts and plays with no network at all.

**V1.1:** release-ready four-player flow, fair final settlement, explicit cost-basis scoring, paced city events, contested redevelopment, durable local autosave, keyboard/touch accessibility, cross-browser CI, and a responsive Fredericksburg papercraft presentation.

### V1.1 release notes

- Standard play is explicitly four-player, with 2–4 seats retained under Custom Game.
- Turn phases, queued double captures, bonus-road chains, handoffs, and final-round settlement have regression coverage.
- Construction records actual paid cost separately from market value; final scoring uses configurable coefficients.
- Events allow calm rounds, cap overlap, combine modifiers before board presentation, and respect civic shielding.
- Distress, bankruptcy, and abandoned property now feed a quick contested-redevelopment flow.
- Active games autosave defensively and restore board, economy, events, phases, bankruptcy state, and seeded RNG.
- Chromium, WebKit, and Firefox smoke jobs cover desktop, touch, portrait, and landscape layouts in CI.
- V1.1 retains all original sprite sheets byte-for-byte; GitHub Pages serves the complete game from the repository root.

---

## Quick start

```bash
npm start                  # zero-dependency static server → http://127.0.0.1:8080/
# or: python3 -m http.server 8080
```

ES modules don't load from `file://`, so open the game through a local server.

## How to play

**Setup:** Standard Game seats exactly four mayors. Custom Game allows 2–4 seats. Optionally name each mayor; everyone starts with **$12,000**. Play always goes in seat order (P1 → P2 → P3 → P4), skipping empty Custom seats.

**Your turn**
1. **MANAGE CITY:** collect **income**, pay **upkeep**, then build or upgrade any owned block. This phase does not end until you deliberately choose **Pave Road**.
2. **PAVE ROAD:** tap one gap between neighbouring intersections. A road that closes nothing passes play to the next mayor's MANAGE CITY phase.
3. **CAPTURE / DEVELOP:** completing a block claims it (+$500). For each captured block—including both halves of a double capture—choose **Develop Now** or **Leave Vacant**.
4. **BONUS ROAD:** after all capture choices are resolved, pave another road. Another capture repeats CAPTURE / DEVELOP and preserves normal Dots & Boxes chaining; a quiet bonus road ends the turn.

Blocks left vacant can be developed during any later legal MANAGE CITY phase.

**Each full round:** there is a 65% chance of a **city event** and otherwise a calm round. At most two events overlap. Civic buildings shield nearby blocks from emergencies and their repair bills.

**Debt:** if upkeep or emergency repairs take you below $0, you must sell or downgrade buildings (50% refund) before you can play on. If even that can't cover it, you can declare bankruptcy: your blocks are **abandoned** for contested redevelopment, the debt is wiped, and you restart with $2,000.

**End:** when every block is enclosed, unfinished income, upkeep and repairs are settled first. Highest **City Value** uses all cash and land plus 75% of actual construction investment. See [Scoring](#scoring).

### Controls

| | Desktop | Touch (Android / iPhone) |
| --- | --- | --- |
| Pave a road | Click the gap between two intersections (hover previews it in your colour) | **Tap twice**: the first tap highlights the road, the second paves it. This prevents misplaced roads on small screens and can be turned off in Settings. |
| Inspect / develop a block | Click it: your blocks open the Build panel; others show in the side panel | Tap it: your blocks open the Build panel; others open a details sheet |
| Keyboard | Tab into the board, use arrow keys between cells, Enter/Space to activate, Escape to cancel an armed road | n/a |
| Pause, How To Play, quit | ⏸ button (top left) | same |

Settings (saved on the device): sound effects, tap twice to pave, **Quick Handoff** (skip the “Pass to…” privacy card), reduce motion, and block coordinates. Without Quick Handoff, every control change pauses until the next mayor confirms they are ready.

### Saving a local game

Active matches autosave to versioned local storage after every durable action: phase changes, roads, capture decisions, construction, sales, bankruptcy and redevelopment. The title screen shows **Continue Game** only when the saved state passes validation. **Save & Quit** keeps it; **Abandon Game** asks for confirmation and deletes it. A completed match, explicit discard, or rematch also clears the old active save. Reloading never restores transient dialogs, selection, road previews, animations or sound state. Corrupt and unsupported saves are ignored safely.

## Install & play offline

Grid Lock City is a Progressive Web App. After one online visit, the whole game (page, styles, scripts, every sprite sheet as WebP, UI frames, fonts and icons: about 5.7 MB) is stored on the device, and it starts and plays fully offline, including autosave and Continue Game.

- **Install:** Chrome/Edge (desktop or Android): use the **Install** icon in the address bar or *Add to Home screen*. iPhone/iPad Safari: **Share → Add to Home Screen**. It opens full-window with the game's own icon.
- **Updates are never forced mid-game.** When a new version is published, it downloads in the background and a *"A new version of Grid Lock City is ready"* prompt appears. **Reload** saves the game in progress and switches to the new version; **Later** keeps playing (the prompt returns next launch). Until then the current version keeps running, unchanged.
- **Saved games are safe:** the service worker only manages its own `gridlock-*` caches and never touches local storage, so autosaves and settings carry across updates.
- Works at a domain root or a GitHub Pages project subpath (`/<repo>/`): the manifest, service worker scope and every cached URL are relative.
- Fonts (Lilita One, Nunito; SIL Open Font License, see `assets/fonts/`) are self-hosted, so the game looks the same offline and makes no third-party requests.
- To reset a device completely: browser settings → site data for the game's address → clear. (This also deletes that device's saved game.)

**How it works** (`sw.js`, `js/pwa.js`, `manifest.webmanifest`):

| Request | Strategy |
| --- | --- |
| The game (`./`, `index.html`, any `?query`) | Cached app shell |
| Every runtime file (HTML, CSS, JS modules, WebP sheets, UI frames, fonts, icons, manifest) | Precached at install, served cache-first |
| Anything else in scope (e.g. the original PNG sheets, only used by browsers without WebP) | Network-first, with an offline copy once fetched |
| Other origins / other paths | Not intercepted |

The precache is named after a **content hash** of all its files (`gridlock-precache-<hash>`). `tools/build-pwa.mjs` regenerates the file list and hash inside `sw.js`; any change to a game file therefore yields a new cache, installed atomically (a failed download leaves the old version running) and fetched past the HTTP cache. Old `gridlock-*` caches are deleted only when the new version takes over.

## Scoring

`core/scoring.js` is pure and deterministic.

- **Fair final settlement:** before results are frozen, every mayor is advanced to the same economic round boundary. Players whose turn already began are not paid twice; players still waiting receive that round's event-adjusted income and upkeep.
- **City Value** uses configurable coefficients: 100% cash + 100% land + 75% of actual construction cost invested in retained levels. Development earns income and bonuses, but no longer converts spending automatically into equal score. Debt lowers value, and abandoned blocks count for nobody.
- **Ranking:** City Value, then blocks owned, then developed blocks, then cash. Players equal on all four share the rank (co-winners), listed in seat order. Results are computed once when the last road resolves and frozen in `game.results`, so viewing the board afterwards can't change them.
- **Results screen:** a card for every player showing City Value (with its breakdown), cash, blocks owned, developed blocks, income, highest development, distinctions, and match summaries for capture chains, districts, blocks, events, and bankruptcies. The buttons are **Play Again**, **View Board** (reopen the results with the Results button) and **Main Menu**.
- **Distinctions:** Most Blocks, Most Cash, Most Developed (ties go to more total levels), Greenest City (park levels), Top Earner and Tallest Skyline. Anyone can win them, including the winner. Ties share an award. An award isn't given if its best value is 0 or if every player is tied for it.

## Economy

All money values live in the `ECONOMY` block in `js/config.js`. That covers starting cash, the capture reward, land values by district, and development costs and income. Land values, the development tables, the How To Play copy and the setup summary all read from it.

| Rule | Default |
| --- | --- |
| Starting cash | $12,000 per player |
| Capture reward | $500 per block claimed (a double capture pays $1,000) |
| Turn income | Paid when a player's turn **starts**, from their **developed** blocks. Bonus roads are the same turn, so they don't pay again. |
| Undeveloped blocks | $0 recurring income |
| Property shown in HUD | Land value plus actual invested construction cost basis |
| Final building score | 75% of actual invested construction cost basis |
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

Each block stores its `type`, `level`, `income`, per-level actual `constructionCosts`, cumulative `investedCostBasis`, and optional list-price `marketValue`. Scoring uses land plus `investedCostBasis`; `marketValue` is informational and does not grant free City Value after a discount. The board shows the building art plus a badge with the category icon and level pips. Names and art per level live in `core/buildings.js`.

### Adjacency & district bonuses

All percentages are in `ECONOMY.BONUSES` in `js/config.js`. "Connected" means orthogonally adjacent blocks with the same owner that are developed (Level 1+).

| Bonus | Rule | Default |
| --- | --- | --- |
| Residential district | 3+ connected Residential | +20% each |
| Commercial district | 3+ connected Commercial | +25% each |
| Park adjacency | Each directly adjacent same-owner Park boosts a Residential block (max 2 parks) | +10% per park |
| Mixed-use | A connected Residential/Commercial/Park cluster containing all three | +10% each member |
| Civic protection | Civic blocks cover same-owner blocks within a Manhattan radius (L1: 1, L2: 1, L3: 2) | Shields covered blocks from emergencies and their repair bills |

`core/bonuses.js` → `refreshBonuses(board)` recomputes everything from scratch after every capture and every build/upgrade. The results are stored on each block as `bonuses`, `bonusIncome` and `protectedBy`. There's no incremental state, so nothing goes stale. Bonuses are a percentage of the block's **base** (level) income and never compound on each other. Each bonus type applies at most once per block, and connected groups are found with an iterative flood fill that tracks visited blocks, so cycles can't double count. Turn income pays base plus bonuses.

In the UI: the HUD income includes bonuses, with a small ★ and a tooltip giving the bonus amount. Board badges get a ★ when a block earns a bonus. The details panel and Build panel list each bonus and any civic protection. A toast announces newly gained bonus income.

### City events

After every full round, a configured probability check happens before turn income. A calm round starts no event, and no more than two different events can be active. The pool and pacing controls live in `CITY_EVENTS` in `js/config.js`.

| Event | Kind | Rounds | Effect |
| --- | --- | --- | --- |
| Heavy Rain | emergency | 1 | Park income stops |
| Snowstorm | emergency | 1 | All income −25% |
| Fire | emergency | 2 | Up to 2 developed blocks earn nothing and owe $400 repairs next owner turn |
| Power Outage | emergency | 1 | Commercial + Industrial income −50% |
| City Festival | boon | 1 | Commercial + Landmark income +50% |
| Housing Boom | boon | 2 | Residential income +50%, homes cost 25% more |
| Beautification Grant | boon | 2 | Parks earn ×2 and cost half |
| Economic Boom | boon | 1 | All income +25% |
| Recession | downturn | 2 | All income −20%, construction 10% cheaper |

How it stays safe (`core/events.js`):
- **Temporary effects:** events never rewrite blocks or ownership. Income and construction modifiers are derived from the active list; one-time repair bills are queued explicitly and charged once at the owner's next turn.
- **No duplicates:** re-drawing an active event refreshes its duration instead of adding a second copy. Overlapping different events multiply, clamped to ×0–×2.
- **Calm pacing:** `ROUND_PROBABILITY` controls whether a round draws anything and `MAX_ACTIVE` caps simultaneous events.
- **Civic mitigation:** emergencies skip any block inside a civic protection radius (`isProtected`). This is checked live, so building a civic mid-event helps immediately.
- **Reproducible randomness:** draws use a seeded PRNG stored in the game (`game.seed` / `game.rngState`). Add `?seed=123` to the URL to replay a game's events. Fire is capped and spread out: at most 2 targets, 1 per player.
- **Prices and value:** cost events change the actual price paid. That amount becomes the level's invested cost basis and is used by upkeep, refunds, property City Value and final scoring. A separate list-price market value is retained only as optional information.

In the UI, a papercraft event card lists the affected blocks, anything shielded, and the duration. Active events show as pills under the top bar (tap one to reopen its card). Affected blocks get a red, green or blue outline based on the final combined multiplier across all events (not whichever modifier is listed first). The details panel lists each event on a block, the HUD income shows ▲/▼ with a tooltip, and the Build panel shows adjusted prices.

### Financial failure & recovery

Numbers are in `ECONOMY.FINANCE`; the rules are in `core/finance.js`.

- **Upkeep:** charged after income: 6% of owned land value plus 7% of invested construction cost. Idle expansion and aggressive building now carry meaningful risk without making ordinary developed blocks unprofitable.
- **Emergency repairs:** targeted emergencies can queue a modest configured expense at the affected owner's next turn. Civic protection prevents both the income loss and repair charge.
- **Financial distress:** cash < $0. This is derived from cash, not stored as a flag. While in distress, a player can't pave or buy. The distress panel opens automatically, after any event card is dismissed, and can be reopened with the **Resolve Debt** button.
- **Selling:** *Downgrade* removes one level and refunds 50% of that level's cost. *Sell* clears the block to Vacant and refunds 50% of everything invested. It's also available any time from the Build panel. Recovering (cash ≥ $0) unblocks play immediately.
- **Bankruptcy:** allowed only when selling everything couldn't cover the debt.
  - Every block the player owns becomes **Abandoned**: ownerless, with the development kept but inactive (no income, upkeep, bonuses, events or score).
  - Roads stay as they are, the debt is written off, and the player stays in the game with **$2,000 Fresh Start** capital.
- **Contested redevelopment:** the Build panel collects quick sealed bids from every eligible mayor. Restore reserves at land plus 40% of invested cost and keeps the building; Clear & rebuild reserves at land value and starts Vacant. Highest affordable valid bid wins, with lowest seat breaking ties. Distressed players and the former owner cannot bid.
  - Roads can never capture an abandoned block.
- **Loop and orphan safety:**
  - After bankruptcy the player owns nothing, so they owe no upkeep and can't fall straight back into distress.
  - Former owners can't buy back their own ruins.
  - Fresh Start capital is paid for the first 2 bankruptcies only.
  - Bankruptcy always ends distress, so a turn can never deadlock.
  - `ownershipProblems(game)` checks that every owner exists and every abandoned block is ownerless.

Money safety: every balance change goes through `credit()`/`debit()` in `core/economy.js`. They only accept finite, non-negative whole-dollar amounts, refuse to overdraw, detect corrupted balances, and record every change in `game.ledger`. Turn income and property value read the `income`/`value` stored on each block.

## Deploy to GitHub Pages

The repo root **is** the site: `index.html`, `css/`, `js/`, `assets/generated/` and the original PNG sheets. There's nothing to build.

1. If you changed any file the game loads, run `npm run build:pwa` and commit the updated `sw.js` (CI fails if it is stale). Players then get the new version through the update prompt.
2. Push this branch to GitHub and merge it into `main` (or deploy from any branch).
3. In the repository, go to **Settings → Pages**.
4. Under **Build and deployment**, choose **Source: Deploy from a branch**, **Branch: `main`**, **Folder: `/ (root)`**, then **Save**.
5. After a minute or so the game is live at `https://<user>.github.io/<repo>/`.

Before merging a release, wait for the **CI / Unit tests and Pages checks** job and
all three **CI / Browser smoke** jobs to pass. The Pages check confirms that
`index.html` and `.nojekyll` are at the repository root, that every local URL in
the entry page is relative (so `/GRIDLOCK/` works), and that each referenced file
is committed. No Pages build command or output directory is required.

Notes:
- `.nojekyll` is included so GitHub serves every file unchanged. The file names with spaces work because all URLs are encoded.
- All paths are relative, so the game works from a repository subpath.
- `assets/generated/` is committed because Pages doesn't run build steps. If you change the art or crops, run `npm run build:assets` and commit the output.
- The game makes no external requests: fonts are self-hosted, and after the first visit everything is served from the offline cache.

## Performance

- Sprite sheets are served as **WebP**: the whole set is about 4 MB against 23 MB of PNGs, with the PNG as fallback.
- The title screen loads only about **1.4 MB**; its three sheets are preloaded in `<head>`.
- Board art starts downloading on the New Game setup screen, while players type names.
- The 9-sliced UI frames are small (about 170 KB for all of them).
- The offline precache is about **5.7 MB** (69 files) and downloads in the background after the first page load; the 23 MB of original PNGs are never installed.
- The board re-renders only on game actions; no animation loops run while idle.
- Animations use transforms, opacity and filters only, and turn off with reduced motion.

## Mobile & accessibility

- **One screen, no page scrolling in-game:** on phones the four HUD cards sit in a 2×2 grid (or one row on short screens, with abbreviated money), and the board fills the rest.
- **No accidental zoom or selection:** `touch-action: manipulation` stops double-tap zoom while pinch zoom still works, and board text can't be selected or long-pressed.
- **Touch targets:** road slots have enlarged hit areas, and all buttons are at least about 44px tall.
- **Hover effects only where hover exists** (`@media (hover: none)`), so taps don't leave items looking stuck in a hover state.
- **Clear states:** the current player's colour appears on the board frame, banner, card and prompt. Roads show an armed/preview state, disabled roads look disabled when the board is locked, and focus rings are visible.
- **Not colour alone:** every player also has a persistent symbol and distinct road/block pattern, repeated in accessible labels.
- **Keyboard board:** one board cell is tabbable at a time; arrow keys move spatially, Enter/Space activates, and Escape clears a road preview. Built and otherwise locked roads are inert.
- **Screen readers:** every road and block has a spoken label, dialogs are native `<dialog>` elements, and the HUD, prompts and toasts announce changes politely.
- **Safe areas:** iPhone notches and home indicators are respected (`viewport-fit=cover` plus `env(safe-area-inset-*)`).

## Project layout

```
index.html                 All screens (title, how-to, settings, setup, game)
manifest.webmanifest       PWA install metadata (relative start_url/scope, icons)
sw.js                      Service worker: versioned precache, offline play, safe updates
css/
  fonts.css                Self-hosted Lilita One + Nunito (@font-face)
  tokens.css               Colours, type, shadows (sampled from the art)
  base.css                 Reset, tabletop backdrop, sprite primitive
  components.css           Paper panels, buttons, toggles, ribbon, modal, toasts
  screens.css              Title / How To Play / Settings / Setup
  game.css                 Board grid, HUD cards, inspector, action bar
js/
  main.js                  Bootstrap
  pwa.js                   Service worker registration + "update ready" prompt
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
    scoring.js             City Value, ranking/tie-breakers, distinctions, final results
    finance.js             Distress, selling/downgrading, bankruptcy, abandoned-block redevelopment
    settings.js            Persisted settings (localStorage, fails safe)
    persistence.js         Versioned active-game save, migration, validation and reset
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
    financeView.js         Distress panel and bankruptcy card
    resultsView.js         Final results screen
    sfx.js                 Tiny synthesised sound effects (Web Audio, no files)
    settingsView.js        Settings form ↔ storage
    toast.js, dom.js       Helpers
dev/sprites.html           Sprite atlas: every registered crop, for checking coordinates
js/art.js                  Semantic art roles (what views ask for)
css/art.css                Papercraft skin: 9-sliced UI frames, toggles, ribbon, table decor
css/mobile.css             Touch hardening + compact phone/tablet layout (loaded last)
tools/build-assets.mjs     Generates assets/generated/ (WebP, keyed-out props, UI frames)
tools/build-pwa.mjs        Refreshes sw.js precache + version; --icons renders assets/icons/
assets/generated/          Build output (committed so GitHub Pages serves it)
assets/icons/              App icons (192, 512, maskable 512, Apple touch 180) from the title logo
assets/fonts/              Self-hosted WOFF2 fonts + their OFL licences
tests/
  unit/core.test.mjs       Node unit tests for core modules
  unit/dots-and-boxes.test.mjs  Road geometry, rotation, edge/corner/double/chain captures, full games
  unit/economy.test.mjs    Constants, money safety, rewards, 4-player turn-income flow, ledger reconciliation
  unit/development.test.mjs  Level tables, purchases, upgrades, insufficient funds, owner-only, invalid input
  unit/bonuses.test.mjs    Districts, parks, mixed use, loops/full board, no compounding, protection, fuzzed invariants
  unit/invariants.test.mjs 45 fuzzed games (2–4 players, events on): every rule re-checked after every step
  unit/scoring.test.mjs    City Value maths, highest development, ranking/tie-breakers, shared ranks, distinctions, frozen results, seeded full games
  unit/assets.test.mjs     Originals unmodified (SHA-256), every sheet used, generated files exist, ART roles resolve
  unit/finance.test.mjs    Upkeep, distress blocking, sell/downgrade refunds, bankruptcy rules, capped fresh start, restore/rebuild, 60-game fuzz
  unit/events.test.mjs     Pool data, weighted/seeded draws, trigger timing, duration/expiry, no stacking, mitigation, fire, costs, full games
  unit/persistence.test.mjs Save/load fidelity, migration, corruption and storage-failure safety
  unit/pwa.test.mjs        Manifest, icons, precache completeness/freshness, and sw.js run in a simulated worker
  smoke.mjs                Playwright smoke test across 5 viewports
  pwa.mjs                  Offline/PWA browser check under a /GRIDLOCK/ subpath
  serve.mjs                Static server used by `npm start` and the smoke test
*.png                      Original papercraft sprite sheets (unmodified)
```

## Art assets

The ten original sprite sheets stay at the repo root, **unmodified**; `tests/unit/assets.test.mjs` pins their SHA-256 hashes. The art system has three layers:

1. **Sheet manifest: `js/assets.js`.** Pixel rectangles for every sprite, measured from each sheet's alpha channel. `createSprite('buildings:diner')` or `<span data-sprite="icons:gear">` crops responsively via `background-position`. Sheets are served as generated WebP through `image-set()`, with the PNG as fallback.
2. **Semantic roles: `js/art.js`.** Views ask for *roles* (`ART.lot.unclaimed`, `ART.owner.flag(seat)`, `ART.road.h`, `progressionProps(type, level)`), never raw coordinates. Re-skinning means editing this file. Building art per category and level lives in `core/buildings.js`.
3. **Generated assets: `tools/build-assets.mjs`** (`npm run build:assets`), written to `assets/generated/`:
   - `<sheet>.webp`: full-resolution WebP of every sheet (about 4.4 MB in total, against 23 MB of PNG)
   - `props-decor.png/.webp`: `props_decor.png` with its baked-in checkerboard flood-filled to transparency
   - `ui/*.png`: buttons, plaques, toggles and ribbon cut from `UI buttons_panels.png`, because CSS `border-image` 9-slicing can't crop a sprite sheet

| Sheet | Key | Used for |
| --- | --- | --- |
| `roads_infrastructure.png` | `roads` | Paved road segments and junction tiles, grass/abandoned lots |
| `residential_commercial buildings.png` | `buildings` | Residential and commercial levels 1–3 |
| `civic-buildings.png` | `civic` | Civic, industrial and landmark levels 1–3 |
| `parks_open spaces.png` | `parks` | Park levels, owned-lot base |
| `props_decor.png` | `props` | Level-up street props, table and title decor (keyed-out copy) |
| `ownership markers.png` | `markers` | Flags, territory frames, seals, HUD chips |
| `UI buttons_panels.png` | `ui` + `generated/ui` | 9-sliced buttons, icon buttons, HUD plaques, toggles, page ribbon |
| `UI icons.png` | `icons` | Buttons, HUD stats, category icons |
| `effects.png` | `effects` | Capture/build bursts, event cards, bankruptcy |
| `title_menu decor.png` | `title` | Logo, skyline, pins, shields |

**Tabletop look:** each block is a paper cut-out lifted off a kraft-paper board. Stacked drop shadows read as cardstock, and developed blocks gain a layer per level. Level 2 adds one street prop and Level 3 a second (trees, lamps, mailboxes, power poles…), placed at the kerb so buildings stay readable. Claimed blocks carry the owner's flag, frame and tint. The board frame is a stack of card sheets.

**Readability rules:** props and decor never sit on roads. Table decor only appears when the board has side margins, and on short landscape screens chrome slims down and decor is hidden. Unbuilt roads stay as high-contrast pencil lines, and paved ones keep a thin builder-coloured curb.

Open `dev/sprites.html` through the local server to see every crop.

## Tests

```bash
npm ci                         # install the locked development dependencies
npm test                       # unit tests + original-art and Pages checks
npx playwright install         # first-time local browser installation
npm run test:smoke:chromium    # browser smoke; screenshots → test-results/
npm run test:smoke:webkit
npm run test:smoke:firefox
npm run test:pwa               # offline/PWA check (BROWSER=chromium|webkit|firefox)
npm run build:pwa              # after changing game files: refresh sw.js (CI checks it)
npm run build:icons            # re-render app icons from the logo sprite (needs Playwright)
```

`npm run test:smoke` defaults to Chromium; set `BROWSER=chromium`, `webkit`, or
`firefox` to select an engine. GitHub Actions runs unit tests on every push and
pull request, then runs the complete smoke suite independently in all three
engines. A browser job fails on an uncaught JavaScript error, console error,
asset/request failure, assertion failure, or horizontal page overflow. Failure
screenshots are uploaded as workflow artifacts.

**Offline/PWA checks.** `npm test` includes `tests/unit/pwa.test.mjs`: the manifest is installable and subpath-safe, icons have their declared sizes, the precache contains every file the page, stylesheets and module graph load (and is up to date with its content hash), no file loads anything from the network, and `sw.js` itself is run in a simulated worker scoped to `/GRIDLOCK/` to verify install, activation cleanup, offline routing and the update handshake. In the browser, `npm run test:pwa` (run by CI in all three engines) serves the site under `/GRIDLOCK/`, installs the service worker, then stops the server and goes offline. It reloads, continues the autosave, captures and builds, deep-links with a query string, and autosaves again. Finally it publishes a new `sw.js` and checks that the running game keeps the old version, that **Later** and a plain reload don't force the update, and that **Reload** keeps the saved game, switches version and removes the old caches.

The smoke test runs the whole flow through the real UI: title → how to play → settings persistence → setup → keyboard navigation → rotation and handoff → inert completed roads → capture and bonus-road chains → Leave Vacant, build and upgrade → income feedback → complete city → progressive results → rematch → save/restore → confirmed abandon. It does this at desktop, laptop, tablet, phone and phone-landscape sizes, plus a staged four-way tie, a hi-DPI phone art check (WebP loaded, 9-slice frames, road/junction tiles, progression props, no collapsed sprites), distress → recovery → bankruptcy → contested redevelopment, a seeded Fire footprint, district bonuses, touch confirmation/cancellation, and animation/reduced-motion paths. It uses a local `playwright` install if there is one and otherwise falls back to a global install.
