# Grid Lock City

A papercraft tabletop city-building game for 2–4 local players, built with plain HTML, CSS and JavaScript (ES modules). There's no build step, so it runs as-is on GitHub Pages.

> **Status: v0.2 core loop.** 4-player Dots & Boxes with roads is playable end to end: menus, settings, 4-seat local setup, the 6×6 city, captures and chains, the HUD, income and a results screen. Buying, construction and city events come in later phases.

## How it plays

The city is a 6×6 grid of blocks on a 7×7 lattice of intersections, with 84 possible roads.

1. Players take turns in seat order: P1 → P2 → P3 → P4, skipping empty seats.
2. On your turn, tap the gap between two neighbouring intersections to **pave a road**. You can't pave a road twice, and there are no diagonals.
3. Paving the **last** road around a block **claims** it for you. The block takes your colour, border, seal and flag. One road can close two blocks.
4. Claiming at least one block gives you **another road**, so captures can chain. A road that closes nothing passes the turn.
5. When play wraps back to the first seat, the round ends and everyone collects income for the blocks they own.
6. The game ends when all 36 blocks are claimed. The most blocks wins, and ties go to net worth.

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
    economy.js             Cash formatting, income, property value
    buildings.js           Building catalogue (costs/income are placeholders)
    events.js              City event catalogue (not wired in yet)
    settings.js            Persisted settings (localStorage, fails safe)
    bus.js                 Pub/sub between core and UI
  ui/                      DOM rendering and input
    router.js              Screen switching + back stack
    setupView.js           4-seat new game form
    boardView.js           Board renderer (intersections, road slots, blocks)
    hud.js                 Player cards, round & turn banner
    gameView.js            Game controller (moves, capture feedback, results, pause)
    settingsView.js        Settings form ↔ storage
    toast.js, dom.js       Helpers
dev/sprites.html           Sprite atlas: every registered crop, for checking coordinates
tests/
  unit/core.test.mjs       Node unit tests for core modules
  unit/dots-and-boxes.test.mjs  Road geometry, rotation, edge/corner/double/chain captures, full games
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

The smoke test runs the whole flow through the real UI: title → how to play → settings persistence → setup → rotation → a rejected duplicate road → a capture with a bonus road → round income → paving every road to the results screen → rematch → pause → quit. It does this at desktop, laptop, tablet, phone and phone-landscape sizes, and fails on any console error, failed request or horizontal overflow. It uses a local `playwright` install if there is one and otherwise falls back to a global install.
