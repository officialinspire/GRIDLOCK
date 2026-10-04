# Grid Lock City

A papercraft tabletop city-building game designed for **exactly 4 players on one device**. A Custom Game preserves 2–3 player support. It plays like Dots & Boxes with roads: pave streets between intersections, enclose city blocks to claim them, develop them into neighbourhoods, weather city events, and finish with the most valuable city.

It's plain HTML, CSS and JavaScript (ES modules) with **no build step and no runtime dependencies**, so it runs on GitHub Pages as-is. It is also an **installable offline app (PWA)**: after the first visit it starts and plays with no network at all.

**V1.4.1:** a core-rules hardening pass: finance actions check their turn phase and City Action cost in the rules engine, redeveloped blocks are protected from takeovers until their new owner's next turn, and saves move to schema 2 (see the release notes below).

**V1.4:** the City era after the roads are paved, development-driven scoring with Prestige, strategic building effects, hostile takeovers, bankruptcy recovery, twelve new achievements and denser city blocks (see the release notes below).

**V1.3:** a start screen and the INSPIRE Software intro, a downtown Fredericksburg main menu, two music themes with crossfades, and new sound effects for every building type and city event (see the release notes below).

**V1.2:** installable offline play, a richer sound and haptics layer, a first-game tutorial, rule presets, career statistics and achievements, strategic forecasts, replayable cities with challenge links, and a simulation-backed balance pass (see the release notes below).

**V1.1:** release-ready four-player flow, fair final settlement, explicit cost-basis scoring, paced city events, contested redevelopment, durable local autosave, keyboard/touch accessibility, cross-browser CI, and a responsive Fredericksburg papercraft presentation.

### V1.4.1 release notes

- **City era polish** (no new mechanics):
  - **Transition card:** paving the final road shows a short papercraft notice, *THE GRID IS COMPLETE — BUILD THE CITY*, with the City rounds and actions per turn (and why the final mover's turn just ends). Skip it with the button, Escape or a tap outside; it closes itself after 4.5 s, and the final capture's Develop Now choice follows (`js/ui/cityIntro.js`).
  - **City tips:** five contextual tutorial notes (first City turn, City Actions once one is spent, the first takeover you could make, the first abandoned lot to bid on, and bankruptcy & recovery). They show once each unless the tutorial was skipped, also for players who finished the first-game tips, and never hold up tutorial completion (`cityTipForGame` in `js/core/tutorial.js`).
  - **CITY VIEW:** an optional influence overlay (the map button in the top bar; remembered between games) outlines your **takeover targets**, your blocks **at risk**, **protected** (recently changed hands) blocks and **abandoned** lots, dims everything else, and shows a small legend with counts. Each marked block also gets a screen-reader description (`influenceMap` in `js/core/takeover.js`).
  - **Net / turn on the HUD:** player cards lead with income − upkeep; gross income, upkeep, bonus and event effects are in the tooltip and screen-reader text.
  - **One turn summary:** routine income, upkeep and repairs, plus a calm-round or event-over note, are one short banner (*Player 2 · Net +$420 · Income +$900 − Upkeep $480*) instead of a toast, coin chips and a banner. New events and debt still get their own card or panel.
  - **CPU playback** (Settings → *CPU mayors*, beside the speed): **Full** paces and announces every bot step (as before); **Brief** paces only major ones (captures, the final road, takeovers, debt sales, bankruptcy, auctions) and runs routine steps after a short beat without toasts; **Instant** runs routine steps at once and major ones after the fast pause (`CPU.PLAYBACK_ROUTINE_MS`, `stepDelay` in `js/ui/cpuDriver.js`).
  - Reduced motion (the setting or the OS) shows the card, overlay and summary without animation; new smoke tests audit them for accessibility on desktop and phone.

- **Fair sealed auctions for pass-and-play.** Redevelopment bids used to be typed side by side in one panel, so every "sealed" bid was visible and editable on the shared device. Now each person bids alone (`js/ui/auctionView.js`):
  - The Build panel shows the lot, reserve, bid steps and who may bid (in turn order from the opener; former owners and mayors in debt sit out), then **Start sealed bidding**.
  - Before each bidder other than the one holding the device, a **privacy screen** ("Pass to Player 2 … everyone else, please look away"). Escape can't skip it.
  - Each bid screen shows only that mayor's terms: reserve, steps, their cash, their largest possible bid, and that passing is always allowed (or that they can only pass, when their cash can't meet the reserve). Invalid or unaffordable bids are refused privately; a placed bid leaves the page before the next screen.
  - CPU bids stay hidden. After the last person, *All bids are in* → **Reveal the result** to the table: winner, price vs reserve, the ownership change, how many bid or passed, and when a tie went to the lowest seat. Then the device goes back to the mayor on turn.
  - **No stuck turns:** nothing changes until the reveal; an auction everyone passes changes nothing and spends no action (`FIN_ERRORS.NO_BIDS`); the opener can cancel before anyone bids. Autosave never holds a half-run auction: a reload mid-auction simply cancels it.
  - Core helpers in `js/core/finance.js`: `auctionOpenError`, `auctionBidders`, `auctionTerms`, `validateAuctionBid`; `resolveRedevelopmentAuction` reuses them and reports `tied` and `bidCount`.

- **Turn economy with real opportunity cost:** an EXPANSION turn is now **1 Development Action + the required road** (`EXPANSION_ERA.ACTIONS_PER_TURN`). Building, upgrading, a voluntary sale or downgrade, and buying or auctioning a ruin each spend it; paving ends Manage City and an unused action is lost. **Develop Now** on a just-captured block stays a free capture reward, bonus-road chains are unchanged, selling to clear debt and bankruptcy stay free, and the City era keeps 2 City Actions per turn.
  - **Fair transition:** the mayor who paves the final road already had that turn's Development Action, so they get no City Actions on top: they develop the final capture (free) and end the turn. Full City turns start for everyone after them.
  - **HUD and prompts:** the round badge shows *Expansion · 1 action* during Manage City, the turn prompt says how many Development / City Actions are left (and when it's time to pave), Pave Road is highlighted once the action is spent, and the Build panel shows the budget or *Develop Now: free (capture reward)*.
  - **Forecasts** report `usesAction` and `actionAvailable` and still forecast a build when the turn's action is spent (shown for next turn). CPU mayors spend their one action on the best option, then pave; across simulated all-CPU games there were no illegal moves or stalls.
  - **Saves:** schema 3 (`city.expansionActions`; `city.actionsLeft` now counts both eras). Schema 2 saves made in an EXPANSION Manage City get this turn's action; later in a turn, none. City-era saves are unchanged.

- **Finance actions follow the turn phases in the rules engine,** not just in the UI. Voluntary sales, downgrades and redevelopment (buying a ruin or opening an auction) are Manage City actions in both eras: they're refused during Pave Road, Capture / Develop (including the final road's Develop Now step in the City era, which used to let them through for free) and the bonus road, with no side effects (`FIN_ERRORS.WRONG_PHASE`). In the City era each one costs a City Action.
- **Debt recovery stays free:** selling or downgrading while in debt and declaring bankruptcy never cost a City Action and are never phase-gated, so a mayor in debt can always dig out. Opening an auction, like any purchase, waits until the opener's debt is cleared.
- **Redevelopment protection:** a block bought out of abandonment (directly or by auction, whoever wins) can't be taken over until its new owner has completed their next turn (`ECONOMY.TAKEOVER.ACQUIRE_SHIELD_TURNS`). Bought on your own turn, that's exactly one full round; nobody can snipe a block straight out of an auction. The inspector shows whose turn the protection waits for. Takeover protection after a hostile takeover is unchanged.
- **Saves:** schema version 2 (saves record the app version too). V1.1–V1.4.0 saves migrate step by step and continue unchanged; existing takeover protection keeps its whole-round length. Unknown or newer versions are still ignored.
- **Config-driven validation:** save checks take building levels, incomes and costs from `ECONOMY.DEVELOPMENT` (`MAX_LEVEL`, the level table) instead of hardcoded numbers, and the Level 3 achievements name the configured top level.
- Version 1.4.1 (`APP_VERSION` in `js/config.js`, `package.json`, the title screen).

### V1.4 release notes

- **City era:** paving the final road starts the City era instead of ending the match: no more roads, 4 full rounds (`CITY_ERA`), 2 City Actions per turn and an **End Turn** button. The HUD shows the era, City round and actions left. See [How to play](#how-to-play).
- **Development decides victory:** City Value = 100% cash + 70% land + 100% construction + $150 per Prestige point; ties go to Prestige, development levels, cash, then blocks. See [Scoring](#scoring).
- **Strategic effects:** Prestige from Parks, Civic and Landmarks (industry beside homes costs it unless a park buffers it), takeover defence from Residential, Civic and Landmarks, takeover pressure from Commercial, cheaper construction next to your own Industry. See [Strategic effects](#strategic-effects).
- **Hostile takeovers** (City era): beat a rival block's control with adjacent development to buy it at 125% of market value, one per turn, protected afterwards. CPU mayors take one only when it clearly pays. See [Hostile takeovers](#hostile-takeovers).
- **Bankruptcy & recovery:** never ends the match or removes a mayor; recovery capital shrinks each time but never reaches $0, and a growing City Value / Prestige penalty makes it never worth doing on purpose.
- **Achievements:** 24 badges, including twelve new ones for takeovers, fortresses, mixed use, all six types, heavy industry, civic shelter, park networks, whole districts, income, debt-free wins, Prestige and big cities.
- **City look:** Level 2 blocks gain corner props, Level 3 blocks an annex and a parked vehicle or street furniture; developed blocks outweigh the ownership overlay.
- **Results:** Prestige, development levels, takeovers made/lost and bankruptcies per mayor, with the penalty in the City Value breakdown.
- **Saved games:** saves from V1.3 load and continue in the Expansion era with the new rules; inconsistent or unknown-version saves are ignored, never half-loaded.

### V1.3 release notes

- **Start screen and INSPIRE intro**, as in the other INSPIRE games (Deja Vu, Bird Mahjong…). A new session opens on a start screen: *Tap to start* on touch screens, *Click or press Enter to start* elsewhere. Then the INSPIRE Software intro plays (Skip, Escape, Enter or Space ends it) and the main menu appears.
  - Once per browser session: a reload, or the update prompt's Reload, goes straight to the menu.
  - The intro can never trap anyone. It ends by itself if the video can't play, stalls, or the tab is hidden, and after 15 seconds at most.
  - The key that starts the game never also presses the menu button that gets focus next.
- **INSPIRE logo** on the start screen and the main menu (`assets/media/inspire.png`).
- **Downtown main menu.** A papercraft street under a dusk sky, built from the game's own art:
  - buildings with City Hall in the middle, a paper-cut skyline behind, lamps, trees and a traffic light;
  - a road with a crosswalk, and traffic driving past (parked with Reduce Motion).
  - The menu itself is a little city block: an asphalt road with a dashed lane around blocks for each way to play (City Hall for Play Solo, rowhouses for Local Multiplayer, the market for Custom / Mixed), under a *Main St* sign.
  - Laid out for desktop, laptop, tablet, phone and phone-landscape: every button on screen, no sideways scrolling. Narrow screens show the heart of downtown, wide screens the whole street.
- **Music:** *Cardboard City* plays on the start screen, the menus and the pause menu; *Paper Blocks* plays in play.
  - Themes crossfade (~1.2 s) on every screen and pause change, fade with the tab, and loop seamlessly.
  - They stream from `<audio>` (no big decode in memory), routed through Web Audio so the master volume and mute apply.
  - Nothing plays during the intro video.
  - Settings adds a **Music** switch and **Music volume** slider; music sits under the effects.
- **New sound effects:**
  - interface: a click on buttons, a "pip" when choosing an option, and a card-slide chime at each new turn;
  - captures: a rubber "claimed" stamp before the arpeggio;
  - construction: a building site of its own for each building type: hammers and a doorbell for homes, a drill and cash register for shops, shovels and birdsong for parks, a stone block and brass call for civic buildings, clanking and steam for industry, a crane whoosh and fanfare for landmarks;
  - events: a sound of its own for each city event: rain and thunder, wind and sleigh bells, a fire engine, a power-down, festival horns and fireworks, hammering for the Housing Boom, sparkling chimes for the grant, a ka-ching for the boom, and a sad trombone for the recession.
- **Layout polish (desktop, tablet, phone):**
  - The board is always exactly square. An old WebKit workaround had set its height separately, which stretched blocks slightly on some screens.
  - The district key sits under the board instead of over its corner (phones held sideways leave it out to keep the board and its tap targets large), and the stray decorations around the board are gone.
  - Player cards line up. When bots are at the table, every card has a second line (*CPU · Hard · Tycoon* or *Human*), and names shrink to fit narrow cards instead of being cut short.
  - Phones held sideways show compact cards (cash, blocks, income), so all four fit.
  - The empty *Tap a block* hint hides on short screens.
  - New Game's section headings are paper tabs instead of being cut by the panel frame.
- **Desktop fits one screen** (`css/desktop.css`, for landscape windows wider than 900px). Real browser windows are short: a 1366×768 laptop leaves about 650px.
  - **Game:** the side cards shrink on short windows (cash, then blocks and income) instead of pushing the board under the action bar. The action bar is one slim line, the district key sits beside the board, and toasts appear bottom-left over empty table.
  - **Build panel:** all six building choices in one row.
  - **Results:** four player cards across, stats, distinctions, the seed and all actions on one screen.
  - **New Game:** game type, city seed and Start on the left, Players and Rules beside them, the four seats below. Start is always on screen.
  - **Settings:** two columns.
  - **How To Play and Statistics:** tighter cards. These reference pages still scroll on short windows.
  - A smoke test checks 1366×650 and 1920×940: the game, Settings, the build panel and the results fit with no scrolling, New Game's Start button is on screen, and the board is square and clear of the action bar.
- **Offline:** the music and intro are precached too (about 5.9 MB). The service worker answers media byte-range requests from the cache, which Safari requires to play audio and video offline.

### V1.2 release notes

- **Installable offline app (PWA):** a manifest and icons made from the game's art; a service worker that caches every game file under a content-hash version; full offline play, including autosave; updates install only when the player chooses, never mid-game; works under the GitHub Pages `/GRIDLOCK/` subpath.
- **Audio:** an audio manager with master, effects and ambience volume and mute, distinct synthesized sounds, rising pitch on capture chains, procedural city ambience, and fades. Nothing plays before the first tap or keypress.
- **Touch:** optional haptics, a guard against accidental double-tap purchases, larger tap targets, and finger-vs-mouse behaviour on touchscreen laptops.
- **Play options on the title screen:** **Play Solo** (you against three Normal Mayor Bots), **Local Multiplayer** (2–4 people on one device) and **Custom / Mixed Game** (people and bots, your way), each opening New Game with the right table.
- **First-game tutorial:** skippable sticky-note tips shown in context (eight, plus a ninth on CPU turns when bots are at the table), replayable from How To Play or Settings.
- **Rule presets:** Standard, Classic (no events) and Urban Chaos (an event every round), for 2–4 players, kept by autosave.
- **Career:** a Statistics screen with per-mayor records and 12 achievement badges; only genuinely completed matches count.
- **Strategic forecasts:** the Build panel and inspector show cost, income, upkeep, net per turn, City Value change, event modifiers and the bonuses a build would activate, computed by running the real transaction on a copy of the game.
- **Deeper CPU play and personalities:** Hard reads the city's events: it waits out surcharges, uses discounts and boosts only while they last, builds civic shelter when emergencies are likely, and guards against downturns. Hard bids strategically in contested auctions and chooses between restoring a ruin and clearing it. CPU mayors are Builders, Tycoons, Planners or Expansionists: assigned automatically, or chosen in Mixed setup, and shown on the HUD, inspector and results.
- **CPU turns in play:** CPU seats play their own turns (Manage City, roads, captures, bonus chains, debt, sealed redevelopment bids) through the same actions as people. They pause briefly to "think", say what they're about to do and highlight the road or block, light up their player card, lock the board, and offer Pause, Speed up and Skip. They, wait for the pause menu and for dialogs, resume safely after a reload, and show the handoff screen only when a different person takes over.
- **CPU city strategy:** `chooseCityAction()` decides builds, upgrades, leaving land vacant, keeping a configurable cash reserve, and selling or downgrading in debt. It scores everything with the real forecasts: Easy picks sensibly, Normal weighs income, upkeep, bonuses, reserve and events, and Hard adds event duration, civic shelter, district completion, return per dollar and bankruptcy risk.
- **CPU road engine:** `chooseRoad()` with Easy, Normal and Hard play: captures, safe roads, cheapest sacrifices, and for Hard chain look-ahead, value weighting and double-dealing. Pure and deterministic; it never touches the game's random generator.
- **Human and CPU seats:** each seat is Human or CPU (Easy/Normal/Hard), with Solo, Local Friends and Mixed presets on New Game and "Mayor Bot" default names. Seat types are kept through autosave, Continue, Play Again, Replay and the results screen. The rules are unchanged and human-only games play exactly as before.
- **Replayable cities:** a city seed on New Game, the seed shown in the pause menu and on the results screen, Replay Same City, and Copy Challenge Link (`?seed=&mode=&seats=`).
- **Balance pass:** Park income $100 → $150, Civic $250 → $325, Landmark $700 → $850. Before this, upgrading a Park or Civic building to Level 3 lost money every turn, and Landmark paid back more slowly than Industrial at every level. See *Balance simulation* for the evidence. Residential, Commercial, Industrial, scoring and events are unchanged, and the recorded V1.1 games still replay exactly.
- **Balance simulator:** `npm run simulate` plays hundreds of complete games through the real rules and reports game length, bankruptcies, builds, final spread, events, win rate by seat and capture chains.
- **CPU simulator and AI hardening:** `npm run simulate:cpu` plays thousands of all-CPU games with the real CPU engine (no DOM, about 0.13 s a game) and reports win rates by difficulty, seat order, road choices, chains, builds, bankruptcy, redevelopment, cash and City Value, game length, illegal CPU actions and stalls. Across 1,800 games in all three modes: no illegal actions, no stalls, and Hard > Normal > Easy at every table size. Fixes from it:
  - Hard now plays out the endgame at 3–4 player tables. Hard vs Normal at four players went from level (25% / 25%) to 28% / 22%, and from 47% / 47% to 52% / 44% in three-way games.
  - A Hard bot no longer double-deals at a bigger table, where the chain it gives away goes to a third mayor.
  - A bot no longer opens a redevelopment auction it won't bid in. That auction settled with no bids and the bot asked again forever.
  - The turn driver has a no-progress safety net.
  - The remaining CPU tuning constants moved to `CPU` in `config.js`.
- **Accessibility audit** in the browser tests on every screen and dialog: every control has an accessible name, label references resolve, ids are unique, open dialogs are labelled, and nothing animates under reduced motion (the system preference or the in-app setting).

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

**Setup:** Standard Game seats exactly four mayors. Custom Game allows 2–4 seats. Choose who plays (see [Human and CPU seats](#human-and-cpu-seats)). Optionally name each mayor; everyone starts with **$12,000**. Play always goes in seat order (P1 → P2 → P3 → P4), skipping empty Custom seats. Then pick the **rules** (see [Rule presets](#rule-presets)); the setup screen describes each one before you start.

### Human and CPU seats

Every seat is either **Human** or **CPU** (with an **Easy**, **Normal** or **Hard** difficulty). The title screen offers three ways to play, each opening New Game with a table preset already chosen (the heading says which):

| Title button | Opens New Game with |
| --- | --- |
| **Play Solo** | Standard Game, Solo: Player 1 Human, Players 2–4 CPU on Normal (personalities automatic) |
| **Local Multiplayer** | Local Friends: every seat Human, as in earlier versions |
| **Custom / Mixed Game** | Custom Game (2–4 seats), Mixed: choose Human or CPU, difficulty and personality per seat |

The preset can still be changed on New Game. The three presets:

| Preset | Seats |
| --- | --- |
| **Solo** | You plus computer mayors: the first joined seat is Human, the rest CPU (1 Human + 3 CPU in a Standard Game) |
| **Local Friends** (default) | Every joined seat is Human: the classic pass-the-device game |
| **Mixed** | Choose Human or CPU for each seat |

CPU seats that aren't given a name are called **Mayor Bot 1**, **Mayor Bot 2** and so on, numbered in seat order. Standard Game is still exactly 4 seats and Custom 2–4, with CPU seats counting toward the total. At least one seat must be Human. The seat types show as a **CPU** tag on the player cards and the results screen. They're kept by autosave and Continue Game, Play Again and Replay Same City. Saves from before seat types existed load as all-Human tables.

A seat's type is table information only: `createGame` stores `controller` (`"human"` / `"cpu"`) and `difficulty` (`null` / `"easy"` / `"normal"` / `"hard"`) on each player, and no rule reads them. A game with only Human seats plays exactly as before. CPU seats play their own turns (see [CPU turns](#cpu-turns)), using [CPU road decisions](#cpu-road-decisions) and the [CPU city strategy](#cpu-city-strategy). Career statistics and achievements count only the Human seats. Validation, presets and bot names live in `js/core/seats.js`.

### CPU turns

When it's a CPU seat's turn the game plays it: Manage City (builds and upgrades, or nothing), Pave Road, each Capture / Develop choice, bonus-road chains, selling or bankruptcy when in debt, and redevelopment bidding. It does one step at a time after a short thinking pause, and a **"Mayor Bot 1 is thinking…"** strip appears under the turn prompt.

- **What the bot is doing:** the active bot's player card glows, and the strip adds a short line about the planned step ("Building a Commercial on C3", "Claiming B2 & B3", "Paving a risky road", "In debt: selling C3"…). The road or block it is about to use gets a dashed outline. The step is planned when the thinking pause starts and runs only if nothing has changed.
- **Board locked:** while a bot plays, the board shows no hover preview and doesn't arm roads; a tap or click on it is politely refused with a toast.

- **Same moves as people:** every step is one decision from `js/core/cpu/` played through the same handlers a person's click uses (`placeRoad`, `buildOnBlock`/`upgradeBlock`, `resolveCapture`, `downgradeBlock`/`sellDevelopment`, `declareBankruptcy`, `resolveRedevelopmentAuction`, `startPaving`). Nothing edits the board or cash directly, and the usual toasts, sounds and event cards appear. A bot's moves don't vibrate your phone or trigger rule tips (only the tutorial's *CPU turns* note).
- **Speed:** Settings → *CPU mayor speed* sets the thinking pause (Relaxed 1.1 s, Normal 0.65 s, Fast 0.22 s; `CPU.THINK_MS`). The strip has **Pause** (opens the pause menu, which stops the bots), **Speed up** (switches to Fast; pressed while on) and **Skip**, which plays the remaining CPU steps at once until a person has control again.
- **Playback:** Settings → *CPU mayors* (the second menu, beside the speed): **Full** (every step paced and announced), **Brief** (only major steps — captures, the final road, takeovers, debt sales, bankruptcy, auctions — are paced, highlighted and announced) or **Instant** (routine steps run at once; major ones after the fast pause).
- **Handoffs:** the pass-the-device screen appears only when control reaches a person other than the last person who played. A Solo game never shows it; Human A → CPU → Human B shows it once, for B. An all-human table gets it on every turn change, as always.
- **Waiting its turn:** the bots never act while anything else needs the table: the pause menu, an event card, a handoff, an auction people are bidding in, or another screen. Pausing drops a pending step, and resuming re-plans it. People's clicks on the board during a bot's turn are politely refused.
- **Reloads and game end:** the game autosaves after every step. Each scheduled step is tied to the exact state it was planned for and is dropped if anything changed, so a reload mid-turn resumes from the last completed step without repeating a move. Ending a game, leaving for the title screen or starting a new game stops all CPU timers.
- **Redevelopment:** CPU mayors bid in every auction with **sealed** bids (never shown; only the result reveals the winner and price), valued by running the real auction on a copy (`chooseRedevelopmentBid`). A CPU can also open bidding on an abandoned block during its Manage City. If people are eligible, each bids or passes alone in the sealed-bid dialog; if none are, it settles at once with a short note.

The driver is `js/ui/cpuDriver.js`. The CPU steps live in `cpuStep()` in `js/ui/gameView.js`.

### CPU road decisions

`chooseRoad(game, { difficulty, seed })` in `js/core/cpu/roads.js` answers one question: which road should the current seat pave? It returns a decision (`{ road, reason, captures, score, difficulty, candidates }`) and changes nothing; the caller plays it with `placeRoad()`. Legality comes from the game's own `validateRoad()` and board geometry from `board.js`. Look-ahead runs on a copy of the paved roads.

| Difficulty | How it picks a road |
| --- | --- |
| **Easy** | Takes a capture if there is one. Otherwise a random legal road, usually (70%) rethinking a road that would leave a three-sided block, so it now and then hands one over |
| **Normal** | Best capture first, counting double captures and the chain behind a capture. Otherwise a safe road (one that gives nobody a block). If none is left, the road that gives the next mayor the fewest blocks. Picks randomly among equally good roads |
| **Hard** | Everything Normal does, plus look-ahead. It plays out its own capture run, the next mayor's reply (they take what's offered, then close safely or sacrifice as little as they can) and its own follow-up, weighing blocks by what they're worth (land value + capture reward). So it sacrifices a suburb block before a downtown one and avoids handing over chains. At two players it will **double-deal**: stop two blocks short of the end of a chain, so the opponent must open the next, longer one. At three or four players, once no safe roads are left, it plays the whole endgame out: every mayor takes what it's offered and then gives away as little as it can. It picks the sacrifice that sends the long chains its way (`CPU.HARD_ENDGAME_ROLLOUT`). This is look-ahead against sensible play, not perfect play: it assumes rivals never double-deal, and it doesn't steer who runs out of safe roads first |

**Fairness and determinism:** the engine sees only what a player at the table sees. It never reads `game.rngState` or the event pool and never draws from the game's random generator, so asking it for a move can't predict or change city events (a test plays the same game with and without consulting it and gets identical events). Its choices between equally good roads come from its own seeded stream: pass `seed`, or it derives one from the public city seed, the seat and how many roads are down. The same position and seed always give the same road.

Whole-game win rates are in [CPU simulation](#cpu-simulation). Hard decides in about a millisecond typically. Its worst case (a four-player endgame play-out) is under 30 ms on a desktop. Each position is played out once per decision, and roads that open the same chain share one play-out.

### CPU city strategy

`chooseCityAction(game, { difficulty, seed, reserve })` in `js/core/cpu/city.js` decides the CPU's Manage City and Capture / Develop steps, one at a time. The possible actions are build, upgrade, leave a captured block vacant, downgrade or sell while in debt, declare bankruptcy, "pave" (done managing) and, in the CITY era, "end-turn" (done, or out of City Actions). In EXPANSION it gets one Development Action per Manage City, so it takes its single best option and then answers "pave". `applyCityAction()` plays a decision through the normal APIs (`buildOnBlock`, `upgradeBlock`, `resolveCapture`, `downgradeBlock`, `sellDevelopment`, `declareBankruptcy`, `startPaving`), resolving a capture after a build just as the UI does. The caller asks and applies until the answer is "pave" or "end-turn" (`endCityTurn`). In the CITY era the turns left are known exactly, so builds that can't pay back before the end are skipped.

It has no economy formulas of its own:
- Purchases are priced and scored with `forecastDevelopment()`, the real build on a copy, including event prices, income with bonuses and events, upkeep and City Value.
- Debt options use `quoteDowngrade()`/`quoteSale()` plus the real `downgradeBlock()`/`sellDevelopment()` on a copy, read back with `playerStats()`/`scorePlayer()`.
- It never chooses a purchase the quote says is unaffordable, and it always keeps a **cash reserve**: `CPU.RESERVE` in `config.js` ($300 Easy, $1,000 Normal/Hard), or the `reserve` option.

| Difficulty | Building | Cash kept after a purchase | In debt |
| --- | --- | --- | --- |
| **Easy** | Builds something sensible (any affordable option that raises net income) on 75% of captures; builds or upgrades in Manage City 35% of the time | Reserve | Random downgrades |
| **Normal** | The best net income per turn × turns left + City Value change: adjacency bonuses, upkeep and today's event prices and income are all in the forecast. Leaves land vacant when nothing pays back before the city is finished | Reserve + next turn's upkeep and repair bills | Gives up the least net income per dollar raised |
| **Hard** | The same judged harder: active events count only for the rounds they have left, civic shelter is worth 15% of the neighbouring income it protects, a build that leaves a district one block short counts half the bonus it would bring, and it needs a return of at least 5% per dollar | Reserve + next turn's charges even if income were halved, plus a possible Fire repair | Least (income lost over the turns left + City Value lost) per dollar of debt covered |

All three declare bankruptcy only when selling everything couldn't cover the debt (the rules allow nothing else). The tuning constants live in `CPU` in `config.js`. In 60 all-CPU Standard games under the V1.4 rules (City era, Prestige scoring, takeovers; `npm run simulate:cpu -- --games 60 --modes standard`), average City Value was $31.9k for Easy, $50.7k for Normal and $52.6k for Hard, with no illegal moves or stalls in 12,325 decisions. Normal and Hard now lean heavily on Parks and Landmarks (about 40% and 30–38% of their builds), since cheap Prestige scores well; all six categories still get built.

**Reading the city's events (Hard).** Income from anything bought now is first paid at the owner's *next* turn start, so Hard counts an event's boost or penalty only for the paydays it will actually cover. An event ending this round adds nothing.
- **Surcharges:** upkeep follows the price actually paid, so a surcharge costs every turn after too. When a Housing Boom's surcharge ends this round and waiting one turn is worth more, Hard holds off (reason `wait-for-price`); Normal pays it.
- **Discounts and boosts:** a Beautification Grant or a Recession discount is worth exactly what it saves, including the lower upkeep. Hard values a Park more during a grant, but not as if the doubled income lasted all game.
- **Civic shelter:** it's weighted by how likely emergencies are: none in Classic, more in Urban Chaos, half as much again while an emergency is on.
- **Downturns (Recession, Snowstorm):** Hard keeps enough extra cash to cover what the lean rounds will cost beyond its income, and buys nothing that would leave its net income negative.

**Redevelopment strategy.** A lot's value to a mayor is the real auction run on a copy. "Clear & rebuild" also counts the best building the mayor could put there on its next turn, so a bot restores a valuable ruin (a Level 3 Landmark at 40% of its cost) but clears a cheap one to build something better. Bids never go above what the lot is worth to the bot, and Hard also keeps next turn's bills in hand:

| Difficulty | Sealed bid |
| --- | --- |
| Easy | The reserve price, half the time |
| Normal | The reserve price plus half of what the lot is worth to it |
| Hard | Just the reserve price when no eligible rival can afford it. Otherwise one step above the richest rival's cash, since nobody can bid more than they have (cash is on the HUD), capped at 80% of the lot's surplus |

### CPU personalities

Every CPU mayor also has a **personality**. Personalities change priorities, never knowledge or rules:

| Personality | Leans towards |
| --- | --- |
| **Builder** | Development: Residential (×1.2), upgrades (×1.25) and completing districts (×1.35); keeps a slightly smaller reserve |
| **Tycoon** | Income: Commercial and Industrial (×1.25), Landmarks (×1.1); cares less for parks and civic buildings |
| **Planner** | Parks and civic buildings (×1.35), civic shelter (×1.35) and mixed-use neighbourhoods; keeps a bigger reserve |
| **Expansionist** | Territory: abandoned land (×1.3 on opening auctions and on how much of a lot's value it bids), follow-up captures in its road look-ahead (×1.3: at two players it double-deals more readily); keeps a smaller reserve |

- **Weights, not rules:** a weight only scales an option the mayor already values positively from the real forecasts, so a personality can reorder good choices but never makes a bad one attractive. Easy's random picks lean the same way. The weights live in `CPU.PERSONALITIES`.
- **Assignment:** bots get a personality automatically, fixed by the city seed (so Replay Same City and challenge links seat the same bots), with no two bots at a table sharing one. In **Mixed** setup each CPU seat can instead pick one (default *Auto*). Solo bots are always automatic.
- **Where it shows:** the difficulty and personality appear under a bot's name on its player card, in the inspector's Owner line and on the results screen ("CPU · Hard · Tycoon").
- **Difficulty still matters more:** with the same personality on both sides, Hard took 76–77% of the combined City Value against Easy in head-to-head games, for every personality. Two Hard bots with different personalities split about 50–59%, mostly seat luck. A unit test checks the first for all four personalities.

**Your turn**
1. **MANAGE CITY:** collect **income**, pay **upkeep**, then spend your **1 Development Action** (`EXPANSION_ERA.ACTIONS_PER_TURN`): one build, upgrade, voluntary sale or downgrade, or redevelopment purchase/auction. This phase does not end until you deliberately choose **Pave Road**; an unspent action is lost when you do.
2. **PAVE ROAD:** tap one gap between neighbouring intersections. A road that closes nothing passes play to the next mayor's MANAGE CITY phase.
3. **CAPTURE / DEVELOP:** completing a block claims it (+$500). For each captured block—including both halves of a double capture—choose **Develop Now** (free: it costs no Development Action) or **Leave Vacant**.
4. **BONUS ROAD:** after all capture choices are resolved, pave another road. Another capture repeats CAPTURE / DEVELOP and preserves normal Dots & Boxes chaining; a quiet bonus road ends the turn.

Blocks left vacant can be developed during any later legal MANAGE CITY phase.

**Each full round:** there is a 65% chance of a **city event** and otherwise a calm round. At most two events overlap. Civic buildings shield nearby blocks from emergencies and their repair bills.

**Debt:** if upkeep or emergency repairs take you below $0, you must sell or downgrade buildings (50% refund) before you can play on. If even that can't cover it, you can declare bankruptcy: your blocks are **abandoned** for contested redevelopment, the debt is wiped, and you restart with recovery capital ($2,000, less each further time, never below $500) and a final-score penalty that grows with each bankruptcy. You're never out of the game.

**Two eras.** Everything above is the **EXPANSION** era. Paving the final road does not end the match: it starts the **CITY** era.
- No more roads. The mayor who paved the last road resolves any capture it made (Develop Now stays free); they already had this turn's Development Action, so they then just end the turn (no City Actions on top). The rest of that round is full City turns.
- Then **4 full City rounds** (`CITY_ERA.ROUNDS` in `js/config.js`). Income, upkeep, repairs and city events carry on as normal.
- Each City turn gives **2 City Actions** (`CITY_ERA.ACTIONS_PER_TURN`). Building, upgrading, a voluntary sale or downgrade, and buying or opening bidding on an abandoned block each cost one. Selling to clear debt and declaring bankruptcy are free, so a mayor can always recover. Choose **End Turn** when done; unused actions are lost.
- The round badge shows the era and the turn's actions: *Expansion · 1 action* in Manage City, then e.g. *City 2/4 · 1 action*.

**End:** the match ends after the last seat of the last City round, so every mayor has had the same number of turns. Highest **City Value** wins: all cash + 70% of land + all actual construction investment + Prestige. See [Scoring](#scoring). (With `CITY_ERA.ROUNDS` set to 0 the match ends on the final road instead, after unfinished income, upkeep and repairs are settled.)

### Controls

| | Desktop | Touch (Android / iPhone) |
| --- | --- | --- |
| Pave a road | Click the gap between two intersections (hover previews it in your colour) | **Tap twice**: the first tap highlights the road, the second paves it. This prevents misplaced roads on small screens and can be turned off in Settings. |
| Inspect / develop a block | Click it: your blocks open the Build panel; others show in the side panel | Tap it: your blocks open the Build panel; others open a details sheet |
| Keyboard | Tab into the board, use arrow keys between cells, Enter/Space to activate, Escape to cancel an armed road | n/a |
| Pause, How To Play, quit | ⏸ button (top left) | same |

Settings (saved on the device): sound on/off, master/effects/ambience volume, city ambience, tap twice to pave, haptics (touch devices with vibration), **Quick Handoff** (skip the “Pass to…” privacy card), reduce motion, and block coordinates. Without Quick Handoff, every control change pauses until the next mayor confirms they are ready.

### Statistics & achievements

**Statistics** (title menu) keeps a career record for this device, from **completed matches only**:

- **Career:** matches completed, blocks captured, longest capture chain (and who), buildings developed (builds + upgrades), highest City Value (and who), bankruptcies, events survived, and favourite development category.
- **Mayors:** games played, games won and best City Value for each mayor name used on this device (hot-seat friendly).
- **24 achievements**, shown as papercraft rosettes (earned ones in colour with who and when, locked ones in grey). New ones also appear on the results screen. When several mayors qualify in the same match, the credit goes to a winner first, then seat order.
  - Classic: Ribbon Cutting, Mayor of the Year, Chain Reaction, Land Baron, Skyline, Master Builder, Big City, Comeback Kid (win after a bankruptcy), Storm Chaser, Purist, Photo Finish and Veteran Mayor.
  - City & strategy (thresholds in `GOALS` in `js/core/career.js`):

    | Badge | Earned by |
    | --- | --- |
    | Hostile Bid | your first hostile takeover |
    | Fortress City | ending a City-era match with 5+ blocks, each at control 4+, none lost to a takeover |
    | Mixed Use | finishing with a mixed-use cluster |
    | Full Palette | finishing with all six building types |
    | Heavy Industry | finishing with three Level 3 Industrial blocks |
    | Safe Streets | finishing with 6+ blocks under civic protection |
    | Green Belt | finishing with 4+ connected parks |
    | District Boss | owning every block of a district (Downtown, Midtown or Suburbs) |
    | Cash Machine | finishing on $4,000+ income per turn |
    | Balanced Budget | winning without the balance ever going below $0 (read from the ledger) |
    | Toast of the Town | finishing with 20+ Prestige |
    | Metropolis | finishing with 20+ development levels |

  Every rule reads the frozen final board, log and ledger (`summarizeMatch`), so the result is deterministic.

A match counts only if it was genuinely played to the end: all 84 roads paved through play (move log), every balance reconciling with the money ledger, and every owned or developed block traceable to a logged capture, build or purchase. Games finished by debug/test staging fail these checks and are never recorded, even with `?debug`. Each match counts once.

The record is stored separately from the active-game save (`gridlock.career.v1`), versioned. Unreadable, corrupt or unknown-version data loads as a fresh record without errors; the Statistics screen says so, and the raw data is copied to `gridlock.career.corrupt` rather than lost.

### First-game tutorial

A player's first **New Game** shows short tips as each rule comes up, on taped sticky notes next to the control they explain: **Manage City**, **Pave Road**, **completing a block** (when one has three roads), **Develop Now / Leave Vacant**, the **bonus road**, **income & upkeep**, **city events**, **CPU turns** (only when bots are at the table: the note points at the thinking strip), and **winning/scoring** (at the halfway point or on the results screen).

- One note at a time, never modal and never stealing focus: the game stays fully playable underneath, and a note clears itself once you act (tips inside a dialog go when it closes).
- Every note has **Got it** and **Skip tutorial**. Skipping or finishing all the tips (eight at an all-human table, nine with bots; the count reads "Tip 3 of 9") is saved on the device, so later games stay tip-free.
- **Replay Tutorial** (at the end of How To Play, or under Settings → Help) starts it over: in the current game if one is in progress, otherwise in the next New Game.

### Sound

Sound effects and ambience are synthesised in the browser with Web Audio (no sound files); the two music themes are recorded (`assets/media/`). Gameplay never depends on audio: everything a sound signals is also shown on screen.

- **Music** (`js/ui/music.js`): *Cardboard City* on the start screen, menus and pause menu; *Paper Blocks* in play; none during the INSPIRE intro. Themes crossfade over ~1.2 s, loop seamlessly (two overlapping players per theme) and pause in place when the app goes to the background. Each theme streams from an `<audio>` element routed through the music bus, so master volume and mute apply. A theme that can't play (unsupported, missing, offline before caching) is simply skipped.
- **Effects:**
  - Every action has its own sound: button click, option select, new turn (card slide + chime), road paved (a card tile set down), capture (a "claimed" stamp and a rising arpeggio), upgrade (that building's site sound + a brassy fanfare), coins (income, sales), refused move (a muted bonk) and the final fanfare.
  - Construction has one sound per building type: Residential, Commercial, Park, Civic, Industrial and Landmark (see the V1.3 notes).
  - City events have one sound per event, falling back to bells, a siren or low bells by kind.
- **Capture chains escalate:** each extra capture in a chain climbs a whole tone and adds layers (octave, sparkle, then a low boom), capped after a few steps.
- **City ambience** (game screen only): quiet room tone and a slowly swelling distant-traffic hum, with an occasional passing car, bird, far-off bell or paper rustle. It fades out for the pause menu, on other screens and when the app goes to the background (then audio is suspended entirely), and fades back in on return.
- **Settings:** a master **Sound** switch (also the 🔈 button in the game's top bar), **Master**, **Effects**, **Music** and **Ambience** volume sliders, and **Music** and **City ambience** switches. All are saved on the device; volume changes glide instead of jumping.
- **No autoplay:** nothing is created or played until the player first taps or presses a key.
- **Reduce motion** (the game setting or the system preference) keeps audio calmer: capture chains climb less and skip the boom, and ambient sounds don't sweep across the stereo field and come less often.
- Browsers without Web Audio, or with audio blocked, simply stay silent.

### Saving a local game

Active matches autosave to versioned local storage after every durable action: phase changes, roads, capture decisions, construction, sales, bankruptcy and redevelopment. A quick run of actions (a capture chain, a stretch of CPU steps) is written once, about 0.3 s after the last of them and never more than a second late (`js/ui/autosave.js`). Hiding, reloading or leaving the page writes a pending save first; Save & Quit, an app update, a new game, the start of the City era and a settled auction save at once. The title screen shows **Continue Game** only when the saved state passes validation. **Save & Quit** keeps it; **Abandon Game** asks for confirmation and deletes it. A completed match, explicit discard, or rematch also clears the old active save. Reloading never restores transient dialogs, selection, road previews, animations or sound state. Corrupt and unsupported saves are ignored safely. Saves carry a schema version (`SAVE_VERSION`, now 2) and older versions are migrated one step at a time (`migrateSave` in `js/core/persistence.js`).

## Install & play offline

Grid Lock City is a Progressive Web App. After one online visit, the whole game (page, styles, scripts, every sprite sheet as WebP, UI frames, fonts and icons: about 5.7 MB, plus the music themes and INSPIRE intro: about 5.9 MB) is stored on the device, and it starts and plays fully offline, including autosave and Continue Game.

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
| Every runtime file (HTML, CSS, JS modules, WebP sheets, UI frames, fonts, icons, manifest, music, intro video, INSPIRE logo) | Precached at install, served cache-first; a media byte-range request gets a 206 slice of the cached file |
| Anything else in scope (e.g. the original PNG sheets, only used by browsers without WebP) | Network-first, with an offline copy once fetched |
| Other origins / other paths | Not intercepted |

The precache is named after a **content hash** of all its files (`gridlock-precache-<hash>`). `tools/build-pwa.mjs` regenerates the file list and hash inside `sw.js`; any change to a game file therefore yields a new cache, installed atomically (a failed download leaves the old version running) and fetched past the HTTP cache. Old `gridlock-*` caches are deleted only when the new version takes over.

## Scoring

`core/scoring.js` is pure and deterministic.

- **Fair final settlement:** the match ends at a round boundary (after the last City round), so every mayor has had the same turns. If it ends on the final road instead (`CITY_ERA.ROUNDS` = 0), every mayor is first advanced to the same economic round boundary. Players whose turn already began are not paid twice; players still waiting receive that round's event-adjusted income and upkeep.
- **City Value** uses configurable coefficients (`ECONOMY.SCORING`): 100% cash + 70% land + 100% of actual construction cost invested in retained levels + $150 per **Prestige** point. Discounted land and full-value buildings mean a developed city beats a sprawl of empty lots. Debt lowers value, and abandoned blocks count for nobody.
- **Ranking:** City Value, then Prestige, then total development levels, then cash, then blocks owned. Players equal on all five share the rank (co-winners), listed in seat order. Results are computed once when the match ends and frozen in `game.results`, so viewing the board afterwards can't change them.
- **Results screen:** a card for every player showing City Value (with its cash / land / buildings / Prestige breakdown, minus any bankruptcy penalty), cash, Prestige, levels built, blocks owned, income, takeovers made and lost, bankruptcies, highest development, distinctions, and match summaries for capture chains, districts, blocks, events, and bankruptcies · hostile takeovers. The buttons are **Play Again**, **View Board** (reopen the results with the Results button) and **Main Menu**.
- **Distinctions:** Most Blocks, Most Cash, Most Developed (ties go to more total levels), Most Prestigious, Greenest City (park levels), Top Earner and Tallest Skyline. Anyone can win them, including the winner. Ties share an award. An award isn't given if its best value is 0 or if every player is tied for it.

## Economy

All money values live in the `ECONOMY` block in `js/config.js`. That covers starting cash, the capture reward, land values by district, and development costs and income. Land values, the development tables, the How To Play copy and the setup summary all read from it.

| Rule | Default |
| --- | --- |
| Starting cash | $12,000 per player |
| Capture reward | $500 per block claimed (a double capture pays $1,000) |
| Turn income | Paid when a player's turn **starts**, from their **developed** blocks. Bonus roads are the same turn, so they don't pay again. |
| Undeveloped blocks | $0 recurring income |
| Property shown in HUD | Land value plus actual invested construction cost basis |
| Final land score | 70% of land value |
| Final building score | 100% of actual invested construction cost basis |
| Prestige | $150 of City Value per point (see [Strategic effects](#strategic-effects)) |
| Net worth | Cash plus net property value |

### Development

A captured block starts **Vacant, Level 0** (no income). On their own turn, the owner taps the block (or selects it and presses **Build**) to open the Build/Upgrade panel.

| Category | Level 1 cost | Income/turn | Level 2 (upgrade cost / income) | Level 3 |
| --- | --- | --- | --- | --- |
| Residential | $1,000 | $300 | $1,500 / $600 | $2,000 / $900 |
| Commercial | $1,500 | $500 | $2,250 / $1,000 | $3,000 / $1,500 |
| Park | $800 | $150 | $1,200 / $300 | $1,600 / $450 |
| Civic | $2,000 | $325 | $3,000 / $650 | $4,000 / $975 |
| Industrial | $1,750 | $600 | $2,625 / $1,200 | $3,500 / $1,800 |
| Landmark | $3,000 | $850 | $4,500 / $1,700 | $6,000 / $2,550 |

Only Level 1 is set per category (`ECONOMY.DEVELOPMENT.CATEGORIES`). Levels 2–3 come from multipliers in `ECONOMY.DEVELOPMENT.LEVELS` (cost ×1 / ×1.5 / ×2, income ×1 / ×2 / ×3), and `core/development.js` rejects any config that produces fractional dollars. The rules:
- Only the owner can develop, and only on their turn.
- The player must be able to afford it; the panel shows how much more they need.
- "Leave Vacant" is always an option.
- Cash is deducted immediately.
- A category can't be changed once built.

Each block stores its `type`, `level`, `income`, per-level actual `constructionCosts`, cumulative `investedCostBasis`, and optional list-price `marketValue`. Scoring uses land plus `investedCostBasis`; `marketValue` is informational and does not grant free City Value after a discount. The board shows the building art plus a badge with the category icon and level pips. Names and art per level live in `core/buildings.js`.

### Strategic information

The Build panel and inspector show what a move will really do, without cluttering the board:

- **Build choices:** each option shows its cost (struck-through normal price during a price event), base income, the change to your **net income per turn**, the change to your **City Value**, how many **bonuses it would activate**, and an *Event* tag. Hover (or long-press) for the full breakdown; **Compare forecasts** puts all six side by side.
- **Upgrade card:** cost, your income, upkeep and net per turn (now → after), City Value (now → after), this block's income (and its normal income if an event is changing it), price/income events, and bonuses it would activate on this or neighbouring blocks. Bonuses already active are listed above it.
- **Inspector:** income (▲/▼ when a city event changes it; tooltip shows the normal amount), upkeep, net per turn, property value, how much the block **adds to City Value**, event price effects for upgrades, active bonuses and events.

Forecasts have no formulas of their own: `js/core/forecast.js` runs the real `buildOnBlock` / `upgradeBlock` on a copy of the game and reads the result with the same functions the game uses (`playerStats`, `scorePlayer`, `effectiveBlockIncome`, `blockUpkeep`, `blockImpacts` / `costImpacts`, and the bonuses `refreshBonuses` writes). So a forecast is exactly what will happen; tests prove it against real transactions and the next turn's actual income and upkeep. Construction counts in full, so a build changes City Value only by the Prestige it brings; it pays back through income (minus upkeep).

### Adjacency & district bonuses

All percentages are in `ECONOMY.BONUSES` in `js/config.js`. "Connected" means orthogonally adjacent blocks with the same owner that are developed (Level 1+).

| Bonus | Rule | Default |
| --- | --- | --- |
| Residential district | 3+ connected Residential | +20% each |
| Commercial district | 3+ connected Commercial | +25% each |
| Park adjacency | Each directly adjacent same-owner Park boosts a Residential block (max 2 parks) | +15% per park |
| Mixed-use | A connected Residential/Commercial/Park cluster containing all three | +10% each member |
| Civic protection | Civic blocks cover same-owner blocks within a Manhattan radius (L1: 1, L2: 1, L3: 2) | Shields covered blocks from emergencies and their repair bills |

`core/bonuses.js` → `refreshBonuses(board)` recomputes everything from scratch after every capture and every build/upgrade. The results are stored on each block as `bonuses`, `bonusIncome` and `protectedBy`. There's no incremental state, so nothing goes stale. Bonuses are a percentage of the block's **base** (level) income and never compound on each other. Each bonus type applies at most once per block, and connected groups are found with an iterative flood fill that tracks visited blocks, so cycles can't double count. Turn income pays base plus bonuses.

In the UI: the HUD income includes bonuses, with a small ★ and a tooltip giving the bonus amount. Board badges get a ★ when a block earns a bonus. The details panel and Build panel list each bonus and any civic protection. A toast announces newly gained bonus income.

### Strategic effects

Each category also has a strategic role, computed by `js/core/strategy.js` from the same neighbourhood data. All numbers are in `ECONOMY.STRATEGY` in `js/config.js`. Only developed, owned, active blocks produce effects; "nearby" is within `RADIUS` (1: the four blocks across a road).

| Category | Effect (defaults) |
| --- | --- |
| Residential | Takeover **defence**: +1 control per level to itself and nearby own blocks |
| Commercial | Extra takeover **pressure**: +2 per level on adjacent rival blocks |
| Park | **Prestige** +1 per level; +1 Prestige to each adjacent own block (max 2 parks count); +15% income for adjacent homes |
| Civic | Prestige +1 per level; takeover defence +1 per level nearby; event protection as before |
| Industrial | Top income; builds and upgrades next to your own Industrial block cost **10% less**; **−1 Prestige per level** when next to any Residential, unless an adjacent own Park buffers it |
| Landmark | Prestige **+3 per level**; takeover defence **+2 per level** nearby |

- **Prestige** is summed per player (never below 0) and scores $150 per point. The HUD card, the inspector and the Build panel show it, and every build option shows its Prestige change.
- `refreshBonuses` stores each block's `prestige`, `prestigeNotes` and `control` for display; scoring and the rules recompute them, so they never go stale.

### Hostile takeovers

In the **CITY era** a mayor can take over a rival's block. The rules are in `js/core/takeover.js`; the strengths are pure functions in `js/core/strategy.js`; every number is in `ECONOMY.TAKEOVER` in `js/config.js`. Abandoned-property auctions are a separate system (`js/core/finance.js`).

- **controlStrength** of an owned block = 1 (ownership) + its building level + its owner's Residential / Civic / Landmark levels within 1 block (×1 / ×1 / ×2, itself included) + 1 per owner's developed block across a road from it.
- **developmentPressure** of a player on a rival block = 1 per their developed block across a road from it, plus 2 per level for each of those that is Commercial.
- A takeover needs pressure **greater** than control. It is allowed only in the attacker's City-era Manage City, never while they are in debt, costs **one City Action**, and at most **one** happens per player turn.
- **Price:** the attacker pays **125%** of the block's market value (land + list-price development). The defender receives the market value; the 25% premium is lost to redevelopment and transaction costs.
- Ownership moves with the development intact. The block is then **protected** until the next full round is done (`shieldedUntil`), so it can't bounce straight back.
- A block bought out of abandonment (a redevelopment purchase or auction) is **protected** until its new owner has completed their next turn (`ACQUIRE_SHIELD_TURNS`; stored as `shieldedUntil` plus `shieldSeat`, the owner whose turn ends it). Bought on the owner's own turn, that's one full round; won at auction by a mayor seated later this round, it lasts until their turn this round ends.
- Each takeover is logged (`{ type: 'takeover', round, seat, from, block, label, cost, marketValue, premium, pressure, control }`) and appears in the ledger as `takeover` for both mayors.
- **UI:** in the City era, tapping a rival's block opens the takeover view: price and where the money goes, your pressure against its control (with where each comes from), and the reason when it isn't possible. The inspector shows control, protection and your pressure.
- **CPU:** Normal and Hard mayors run the takeover on a copy and take it only when it returns at least 25% of its price over the turns left (income net of upkeep × turns + City Value change) and leaves the reserve plus two turns of upkeep in hand (`CPU.TAKEOVER`); Easy never tries. In simulated all-CPU games, the takeovers that arose were weak blocks that didn't pay, so bots passed on them.

### Rule presets

Every preset works with Standard (4) or Custom (2–4) tables. The rules in play are shown at the start of the event strip during the game, in the pause menu, and on the results screen, and they're kept by autosave, Continue Game and Play Again.

| Preset | Rules |
| --- | --- |
| **Standard** | The full rules described here (V1.1 rules with the V1.2 balance pass): roads, captures, development, and paced city events (65% chance per round, at most two at once). |
| **Classic** | Roads, captures and development only. City events never happen (no draws and no "calm round" notes). |
| **Urban Chaos** | A new city event every round from round 2, each lasting one round longer than usual, with up to three at once. |

Presets are plain configuration (`GAME_MODES` in `js/config.js`). `createGame({ mode })` copies the preset's rules onto the game as `game.rules`, and the event engine reads only that; there are no mode checks elsewhere in the rules or UI. Saves from before presets existed load as Standard.

### Replay a city & challenge links

Every city is dealt from a seed: a whole number from 0 to 4294967295 that drives all of its city-event rolls.

- **Pick a city before starting.** New Game has a **City seed** box. Leave it blank for a random city, type a seed, or tap **New Seed** to roll one. **Random** clears it again.
- **See the seed.** The seed is shown in the pause menu and on the results screen.
- **Replay Same City** (results screen) deals the same city again: same seed, rules, seats and mayor names. **Play Again** keeps the table and rules but deals a new city.
- **Copy Challenge Link** copies a link like `…/GRIDLOCK/?seed=31337&mode=chaos&seats=134`. It holds the seed, the rule preset and the seats at the table (which is everything the event rolls depend on), and nothing else. If the browser won't allow copying, the link appears in a selected text box to copy by hand.
- **Opening a challenge link** fills in New Game with that seed, preset and seats, and shows a "Challenge city" note. Then the challenge parameters are removed from the address bar, so reloading or bookmarking the page doesn't lock you to that city. A link with only `?seed=` still works; an invalid seed is ignored with a notice.

The same seed, rules and seats give the same event rolls for the same moves. Events can still differ if the players move differently, because targets depend on the board. The logic lives in `js/core/challenge.js` (pure, unit tested).

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
- **Reproducible randomness:** draws use a seeded PRNG stored in the game (`game.seed` / `game.rngState`). Use a city seed or a challenge link to replay a game's events (see *Replay a city & challenge links*). Fire is capped and spread out: at most 2 targets, 1 per player.
- **Prices and value:** cost events change the actual price paid. That amount becomes the level's invested cost basis and is used by upkeep, refunds, property City Value and final scoring. A separate list-price market value is retained only as optional information.

In the UI, a papercraft event card lists the affected blocks, anything shielded, and the duration. Active events show as pills under the top bar (tap one to reopen its card). Affected blocks get a red, green or blue outline based on the final combined multiplier across all events (not whichever modifier is listed first). The details panel lists each event on a block, the HUD income shows ▲/▼ with a tooltip, and the Build panel shows adjusted prices.

### Financial failure & recovery

Numbers are in `ECONOMY.FINANCE`; the rules are in `core/finance.js`.

- **Upkeep:** charged after income: 6% of owned land value plus 7% of invested construction cost. Idle expansion and aggressive building now carry meaningful risk without making ordinary developed blocks unprofitable.
- **Emergency repairs:** targeted emergencies can queue a modest configured expense at the affected owner's next turn. Civic protection prevents both the income loss and repair charge.
- **Financial distress:** cash < $0. This is derived from cash, not stored as a flag. While in distress, a player can't pave or buy. The distress panel opens automatically, after any event card is dismissed, and can be reopened with the **Resolve Debt** button.
- **Selling:** *Downgrade* removes one level and refunds 50% of that level's cost. *Sell* clears the block to Vacant and refunds 50% of everything invested. Recovering (cash ≥ $0) unblocks play immediately. Selling to clear debt is free and always allowed; a voluntary sale (from the Build panel) is a Manage City action and costs a City Action in the City era.
- **Bankruptcy:** allowed only when selling everything couldn't cover the debt.
  - Every block the player owns becomes **Abandoned**: ownerless, with the development kept but inactive (no income, upkeep, bonuses, events or score).
  - Roads stay as they are, the debt is written off, and the player stays in the game with **recovery capital**: $2,000 the first time, then half the previous amount each time, never below $500 (`FINANCE.RECOVERY`).
  - Bankruptcy never ends the match or removes a player. The bankrupt mayor carries on with the same turn (pave in EXPANSION, End Turn in the CITY era, where bankruptcy costs no City Action) and plays every later turn.
  - **Score penalty** (`FINANCE.BANKRUPTCY_PENALTY`): the nth bankruptcy costs n × $1,000 of final City Value (so 1, 2, 3 bankruptcies cost $1,000, $3,000, $6,000 in all) and 2 Prestige each. The results card shows it in the City Value breakdown.
  - Any queued event repair bills and takeover protection on the abandoned blocks are dropped. Ruins keep their buildings on the board (dark, marked *Abandoned*), can't be taken over, and go to redevelopment.
  - **Messaging:** the bankruptcy card lists the debt written off, blocks abandoned, recovery capital, the total penalty so far and what another bankruptcy would pay. The HUD card shows **↺n Recovering** for the rest of that round and the next (tooltip: penalty so far, next recovery capital), the turn prompt says *Recovering from bankruptcy*, and the log entry records era, count, capital, penalty and next capital.
- **Contested redevelopment:** sealed bids from every eligible mayor, one at a time behind privacy screens on a shared device (see the V1.4.1 notes). Restore reserves at land plus 40% of invested cost and keeps the building; Clear & rebuild reserves at land value and starts Vacant. Highest affordable valid bid wins, with lowest seat breaking ties. Distressed players and the former owner cannot bid. Buying or opening bidding happens in the current mayor's Manage City (a City Action in the City era), never while they're in debt, and the winner's block is protected from takeovers until their next turn is done.
  - Roads can never capture an abandoned block.
- **Loop and orphan safety:**
  - After bankruptcy the player owns nothing, so they owe no upkeep and can't fall straight back into distress.
  - Former owners can't buy back their own ruins.
  - Recovery capital shrinks with each bankruptcy while the score penalty grows faster, so going bankrupt on purpose never pays; the $500 floor means nobody is stuck at $0.
  - Bankruptcy always ends distress, so a turn can never deadlock.
  - `ownershipProblems(game)` checks that every owner exists and every abandoned block is ownerless.

Money safety: every balance change goes through `credit()`/`debit()` in `core/economy.js`. They only accept finite, non-negative whole-dollar amounts, refuse to overdraw, detect corrupted balances, and record every change in `game.ledger`. Turn income and property value read the `income`/`value` stored on each block.

## Balance simulation

`npm run simulate -- [--games 600] [--seed 1] [--mode standard|classic|chaos|all] [--json]` (`tools/simulate.mjs`) plays complete games through the real rules engine and prints a report. It is deterministic: each game's seed drives both the city events and a separate random stream for every bot decision, so the same arguments always give the same numbers (`tests/unit/simulate.test.mjs` checks this, and checks that every simulated game is legal, complete and reconciles its ledger).

Tables mix four scripted mayors and rotate them through every seating order:

| Mayor | Roads | Money |
| --- | --- | --- |
| **planner** | Takes captures, avoids giving blocks away, and when forced, gives away the shortest chain | Builds or upgrades by forecast: the real transaction's net income per turn × turns left + its City Value change |
| **casual** | Mostly safe roads, with the odd blunder | Builds a random affordable category on most captures; upgrades now and then |
| **saver** | Same as the planner | Never builds |
| **spender** | Same as the planner | Spends every dollar on the highest-income build or upgrade, keeping no reserve |

**V1.2 results** (600 games per preset, seed 1, with the balance pass):

| | Standard | Classic | Urban Chaos |
| --- | --- | --- | --- |
| Rounds per game | 16.7 (13–27) | 16.7 | 16.7 |
| Games with a bankruptcy | 0% | 0% | 0% |
| Events per game (per round) | 10.2 (0.65) | 0 | 15.7 (1.0) |
| Planner builds: residential / commercial / park / civic / industrial / landmark | 23 / 9 / 19 / 4 / 20 / 26% | 21 / 10 / 8 / 4 / 29 / 29% | 22 / 8 / 28 / 5 / 13 / 24% |
| Final City Value, mean (sd) | $30,492 ($12,604) | $30,563 ($12,629) | $30,483 ($12,592) |
| Gap between first and last place, median | 54% | 53% | 54% |
| Longest capture chain per game, median (max) | 13 (31) | 13 (31) | 13 (31) |

**What changed, and why.** The only balance fix is to three incomes, because the per-level numbers showed traps:

| Level step | Park before → after | Civic before → after | Landmark before → after |
| --- | --- | --- | --- |
| Extra income vs extra upkeep at Level 3 | +$100 vs $112 → +$150 vs $112 | +$250 vs $280 → +$325 vs $280 | +$700 vs $420 → +$850 vs $420 |
| Turns for Level 1 to pay back its scoring discount | 4.5 → 2.1 | 4.5 → 2.7 | 1.5 → 1.2 (Industrial: 0.9) |

Before the fix, Park and Civic Level 3 upgrades lost money every turn, and Level 2 took about 19 turns to pay back (a whole game is about 17 rounds). Landmark paid back more slowly than Industrial at every level, so the planner only chose it during a City Festival. Over 2,000 Standard games, the planner's Landmark share rose from 13% to 27% and Industrial fell from 32% to 19%. Win rates, spread, game length and bankruptcies did not move. A unit test now requires every build and upgrade step to earn more per turn than the upkeep it adds.

**Known characteristics (not changed; each would need a rule decision):**

- **Captures come late.** With sensible road play, 98% of blocks are claimed in the second half of the game (55% in the last quarter), and a captured block usually pays income only once. So development matters far less than capturing: the saver and the planner finish within about 2% of each other (over 2,000 Standard games, 2 players: planner 48.5% / saver 51.5% wins). Making development decisive would need a rule change, such as paying income as soon as a block is built, or scoring buildings at full cost. The simulator can measure either option before it's adopted.
- **Turn order matters.** At a table of identical planners, the later seats are more often forced to open the first long chain. Win rates by seat over 2,000 Standard games: 4 players 25.5 / 33 / 24.8 / 16.8%; 3 players 38 / 42 / 20%; 2 players 53 / 47%. Seats 1–2 capture about 11 and 10 blocks per game, seats 3–4 about 7. This comes from the roads, not the money, so no economy number can fix it. Rotating the first player between games (for example on Play Again) would even it out over a series.
- **Bankruptcy is rare.** Even the all-in spender never went bankrupt: income beats upkeep for every build, and most money is spent near the end. Distress and bankruptcy remain a safety net for unusual play (heavy Fire damage, lots of undeveloped land, $0 cash).
- **Fire is uncommon** (about 1.5% of events). It needs developed targets, which mostly appear late, and it's skipped when none are eligible.

## CPU simulation

`npm run simulate:cpu -- [--games 600] [--seed 1] [--mode standard|classic|chaos|all] [--tables a,b] [--json]` (`tools/cpu-simulate.mjs`) plays all-CPU games through the real rules engine. It uses the same CPU decisions the game uses (`chooseRoad`, `chooseCityAction`, `applyCityAction`), one step at a time exactly as the turn loop plays them, with no DOM, timers or animation. It takes about 0.13 s per game, or about 0.2 s at an all-Hard four-player table. It is deterministic: the same arguments give the same report.

**Planner speed.** Each CPU decision runs in a memo scope (`js/core/memo.js`): a forecast, a player's stats and score, a block's details or a redevelopment valuation asked for twice while one decision is made is computed once, and nothing outlives the decision. The planner also skips forecasting builds whose quote already rules them out (unaffordable, or no action left), and Hard's look past today's events reuses today's forecasts when no event is on. Every what-if (forecasts, sales, auctions, takeovers) still runs the real transaction, on a slim copy (`simulationCopy` in `js/core/forecast.js`): players, the city's action counts and each block are copied, history is left out, and roads, events and rules are shared, since no transaction writes them. That is about 4× cheaper than a deep copy of the game, and planning never writes to the game it reads (the test runs every decision on a deep-frozen game). Decisions are unchanged: `tests/unit/cpu-memo.test.mjs` compares every decision with and without these optimizations, and the 104-games-per-mode sweep gives the same report as before them.

Tables cycle through every seating order:
- head-to-head (Easy v Normal, Normal v Hard, Easy v Hard, two of each at four seats);
- a three-way Easy/Normal/Hard game;
- identical mayors, to measure seat order;
- the four personalities (all Hard);
- a **debt shock** stress table. One mayor's cash is set deep into debt mid-game, which drives distress, bankruptcy and redevelopment auctions. Careful bots almost never reach these on their own.

**Robustness.** Every decision is checked:
- An **illegal** action is one the rules engine refuses.
- A **stall** is a step that changes nothing three times running, or a game still going after 5,000 steps. Either stops the game and is reported, never looped.
- `tests/unit/cpu-simulate.test.mjs` runs a small sweep on every `npm test`. It checks determinism, and that there are no illegal actions, stalls or unfinished games. It also checks that the debt shock ends in bankruptcy and redevelopment.
- The simulator exits with an error on any illegal action, stall or unfinished game. CI runs 104 games in each mode (every table, 8 times) after the unit tests.
- In the game itself, the CPU driver falls back to "finish managing and pave", or "leave the capture vacant", if a step ever changes nothing twice.

**V1.2 results** (600 games per mode, seed 1; "win" is the share of seats that won, ties shared):

| | Standard | Classic | Urban Chaos |
| --- | --- | --- | --- |
| Illegal CPU actions / stalls / unfinished | 0 / 0 / 0 (104,021 decisions) | 0 / 0 / 0 | 0 / 0 / 0 |
| Easy v Normal, 2 players | 2% / 98% | 2% / 98% | 2% / 98% |
| Normal v Hard, 2 players | 13% / 87% | 11% / 89% | 15% / 85% |
| Easy / Normal / Hard, three-way | 4% / 44% / 52% | 2% / 46% / 52% | 7% / 44% / 50% |
| Normal v Hard, 2 of each at 4 players | 22% / 28% | 21% / 29% | 22% / 28% |
| Easy v Normal, 2 of each at 4 players | 19% / 32% | 19% / 32% | 17% / 33% |
| Final City Value, Easy / Normal / Hard (mean) | $25.1k / $34.0k / $34.6k | $25.3k / $34.2k / $35.1k | $25.1k / $34.0k / $34.5k |
| Final cash, Easy / Normal / Hard (mean) | $6.6k / $6.6k / $12.1k | $6.7k / $6.3k / $12.6k | $6.7k / $6.7k / $10.9k |
| Blocks per seat, Easy / Normal / Hard | 8.2 / 12.1 / 12.0 | same | same |
| Rounds per game, mean (max) | 17.5 (27) | 17.5 (27) | 17.5 (27) |
| Longest capture chain per game, median (max) | 13 (32) | 13 (32) | 13 (32) |
| Redevelopment auctions (opened / won) | 12 / 12 | 11 / 11 | 11 / 11 (2 cleared and rebuilt) |

**Reading it:**
- **Difficulty order holds everywhere.** Hard > Normal > Easy in every mode and at every table size. Two-player games are the most one-sided (in dots-and-boxes one control of the endgame decides it). At four seats the ranking holds, but the margins are human-sized.
- **Hard is not perfect.** It sees no hidden information and assumes sensible rivals. Its 2-player edge comes from classic double-dealing, which a person who knows the trick can use against it.
- **Hard builds less and saves more, and that is correct.** Nearly all captures come in the second half, when a new building rarely pays back its 25% scoring discount. To check, games were branched at 443 of Hard's "leave it vacant" calls and played both ways. Building instead lost that mayor about $320 on average and helped only 8–15% of the time.
- **Personalities** (960 all-Hard games, every seating order): Builder 28%, Tycoon 25%, Expansionist 24%, Planner 23% wins. Average City Value is within 2.5%, so difficulty matters far more than personality.
- **Builds by difficulty:** Easy spreads its builds evenly across categories. Normal and Hard favour Landmark, Park, Residential and Industrial. Civic is chosen mainly as shelter: 2% of Hard's builds in Standard, 8% in Urban Chaos, none in Classic.
- **Bankruptcy** is rare without a shock. Careful bots keep a reserve, and income beats upkeep for every build. The debt-shock table ends in bankruptcy about two times in three. The bots then sell or declare legally, and the abandoned land is always redeveloped by the end.
- **Seat order.** At a table of *identical* sensible bots, which seat inherits the long late chains is fixed by dots-and-boxes parity. Four Normal bots win by seat 33 / 52 / 13 / 2%; four Hard bots 48 / 24 / 7 / 22%. With varied play the effect disappears: four Easy bots win 20 / 24 / 28 / 28%, within noise. The rules give no seat an edge; mirror-matched bots do. Mixed tables in the simulator (and in Solo, a person against bots) don't show it. See also *Known characteristics* above.

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
- The board re-renders only on game actions; no animation loops run while idle. Every redraw asked for during one action is drawn once, at the end of that action; while one CPU mayor plays a run of quick steps (Skip, Instant playback), at most once per animation frame (`js/ui/renderScheduler.js`).
- Animations use transforms, opacity and filters only, and turn off with reduced motion.
- **Timing (development only):** open the game with `?perf` (or run Node tools with `DEBUG_PERF=1`) to time `render` (and `renderBoard`, `renderHud`, `renderInspector`, `applyCityView`), `autosave` (`saveActiveGame` + `loadActiveGame`), CPU planning (`cpuPlan`, `chooseRoad`, `chooseCityAction`, `cpuBids`), `forecastDevelopment`, `influenceMap` and turn resolution (`placeRoad`, `endTurn`, `endCityTurn`). Any call of 8 ms or more is logged as it happens; `__GRIDLOCK_PERF__.report()` in the console prints a table per label (calls, total, mean, max) and `.reset()` starts again. Off by default, and then it only calls through (`js/core/perf.js`).

## Mobile & accessibility

- **One screen, no page scrolling in-game:** on phones the four HUD cards sit in a 2×2 grid (or one row on short screens, with abbreviated money), and the board fills the rest.
- **No accidental zoom or selection:** `touch-action: manipulation` stops double-tap zoom while pinch zoom still works, and board text can't be selected or long-pressed.
- **Touch targets:** every button is at least 44px in both directions on touch screens (iOS 44pt / Android 48dp guidance), including the slim short-landscape layout. Road slots have enlarged hit strips, capped relative to the board so that on small phone boards the blocks between them stay tappable too (desktop boards are unchanged).
- **Tap twice to pave** (on by default): a finger tap previews a road in your colour and a second tap paves it; tapping another road moves the preview, and tapping a block or making a move clears it. It follows the pointer that made the tap, so on a touchscreen laptop or an iPad with a trackpad finger taps preview while mouse clicks, pens and the keyboard pave directly.
- **No tap-through:** on touch screens, a tap in the first 300ms after a dialog opens (or on the board right after one closes) is ignored, so the second half of a quick double tap can't press whatever just appeared under the finger (for example a build option after *Develop Now*). Mouse and keyboard are unaffected.
- **Haptics (optional):** on touch devices that support vibration (Android browsers), a **Haptics** setting (on by default) adds short patterns: a barely-there pulse when a road is previewed, a short tap when it's paved, a stronger double on a capture (three pulses in a chain), a confirmation tick for builds and upgrades, two firm buzzes when an action is refused, and distinct patterns for a new city event and for winning. It never vibrates before your first touch or in the background. Desktop and iPhone (no Vibration API) don't show the setting and behave exactly as before; everything a buzz signals is also on screen.
- **Rotation:** the board, dialogs and sheets re-fit when the device rotates; open dialogs stay within the screen and scroll if they must, and a road preview survives the rotation.
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
    tutorial.js            First-game tips: steps, when each applies, saved progress (skip/done)
    modes.js               Rule presets (GAME_MODES) resolved into the rules a game carries
    seats.js               Seat controllers (human / cpu + difficulty): validation, table presets, bot names
    cpu/roads.js           CPU road choice (Easy / Normal / Hard): pure, deterministic, decision only
    cpu/city.js            CPU Manage City + Capture/Develop: build, upgrade, vacant, reserve, debt, events, redevelopment, personalities (forecast-based)
    cpu/random.js          The CPU's own seeded stream (never the game RNG)
    career.js              Career stats + achievements: genuine-match check, recording, versioned storage
    forecast.js            Build/upgrade forecasts (real transaction on a copy) + block details for the inspector
    memo.js                Per-decision memo for the CPU planner: each forecast/reading once per decision, nothing kept after
    passCache.js           Read-pass cache for the live game (a screen draw): each derived reading once per pass, state-version checked
    bus.js                 Pub/sub between core and UI
    perf.js                Development-only timing behind DEBUG_PERF (?perf): measure(), per-label stats, report
  ui/                      DOM rendering and input
    router.js              Screen switching + back stack
    startView.js           Start screen (once per session) → INSPIRE intro → main menu
    intro.js               The INSPIRE intro video: Skip, and every way it can end without trapping anyone
    music.js               Recorded music: two streamed themes, crossfades, seamless loops, tab visibility
    cpuDriver.js           Runs CPU turns: thinking pause + intent line, Pause/Speed up/Skip, waits for dialogs/pause, stale-step guard
    autosave.js            Debounced autosave scheduling: one write per quick run of moves, flush / save now / cancel
    renderScheduler.js     Coalesces redraw requests: one draw per action, or per animation frame during a bot's quick steps
    setupView.js           New game form: seats, Human/CPU presets + difficulty, rules, city seed
    boardView.js           Board renderer (intersections, road slots, blocks)
    hud.js                 Player cards, round & turn banner
    gameView.js            Game controller (moves, capture feedback, results, pause)
    buildPanel.js          Build/Upgrade panel for the current player's blocks
    bonusView.js           Shared bonus/protection lines
    eventView.js           Event card, active-event pills, block event lines
    financeView.js         Distress panel and bankruptcy card
    resultsView.js         Final results screen
    audio.js               Audio manager: synthesised effects (per building type and event), ambience, music scenes, volume buses, fades
    haptics.js             Optional vibration patterns (touch devices with the Vibration API only)
    touchGuard.js          Ignores tap-through taps on freshly opened/closed dialogs (touch only)
    tutorial.js            First-game coach marks (sticky notes) + Replay Tutorial
    careerView.js          Statistics & Achievements screen; records finished matches
    forecastView.js        Forecast lines, tooltips, breakdowns and the compare table
    settingsView.js        Settings form ↔ storage
    toast.js, dom.js       Helpers
dev/sprites.html           Sprite atlas: every registered crop, for checking coordinates
js/art.js                  Semantic art roles (what views ask for)
css/title.css              Start screen, intro and the downtown main menu (sky, street, city-block menu)
css/art.css                Papercraft skin: 9-sliced UI frames, toggles, ribbon
css/mobile.css             Touch hardening + compact phone/tablet layout
css/desktop.css            Desktop / landscape tablet: one-screen game, dialogs, New Game, Settings (loaded last)
tools/build-assets.mjs     Generates assets/generated/ (WebP, keyed-out props, UI frames)
tools/build-pwa.mjs        Refreshes sw.js precache + version; --icons renders assets/icons/
tools/simulate.mjs         Deterministic balance simulator (npm run simulate)
tools/cpu-simulate.mjs     All-CPU simulator with the real CPU engine: win rates, robustness (npm run simulate:cpu)
assets/generated/          Build output (committed so GitHub Pages serves it)
assets/icons/              App icons (192, 512, maskable 512, Apple touch 180) from the title logo
assets/fonts/              Self-hosted WOFF2 fonts + their OFL licences
assets/media/              Music themes (cardboard-city.mp3, paper-blocks.mp3), the INSPIRE intro video and logo
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
  unit/autosave.test.mjs   Debounced autosave on a fake clock: one write per burst, max wait, flush, save now, cancel
  unit/render-scheduler.test.mjs  Render scheduling: one draw per action, one per frame for bursts, flush, cancel, no render loops
  unit/audio.test.mjs      Audio manager on a fake Web Audio: no autoplay, silent failure, distinct sounds (per building type and event), chain escalation, volumes/fades, ambience scenes, music by scene/switch/volume/mute/hidden tab, settings
  unit/intro.test.mjs      INSPIRE intro: plays on demand, Skip guard, ends on refusal/error/stall/time cap/hidden tab
  unit/haptics.test.mjs    Haptic patterns, support/setting/activation rules, tap-through guard decisions
  unit/modes.test.mjs      Presets: Standard replays V1.1 goldens exactly, Classic never has events, Urban Chaos
                           has one every round (≤3 at once), determinism, 2–4 players, save/restore, old saves
  unit/career.test.mjs     Genuine-match check (staged games rejected), totals, mayors, achievements, dedupe, storage, corruption
  unit/forecast.test.mjs   Forecasts = real transactions (every category, upgrades, events, bonuses, next turn's income/upkeep, 100+ mid-game positions)
  unit/challenge.test.mjs  Seed/link parsing, links never carry ?debug, Replay setup; same seed + mode + seats + moves = same events (every preset)
  unit/seats.test.mjs      Seat validation (Standard/Custom, controllers, difficulty, a human seat), presets, bot names, human-only games unchanged, mixed tables, save/Continue/rematch/replay, career counts humans
  unit/cpu-roads.test.mjs  CPU roads on staged positions: captures, doubles/chains, safe roads, sacrifices, value-weighting, double-deal; purity, determinism, event RNG untouched; whole CPU games; Hard ≥ Normal > Easy
  unit/cpu-city.test.mjs   CPU city decisions on staged positions: affordability, configurable reserve, endgame restraint, district and event and civic judgement, upgrades, debt and bankruptcy; auctions a bot opens always settle (any cash level); purity; whole CPU games; Normal/Hard > Easy
  unit/cpu-strategy.test.mjs  Events (wait out a surcharge, grants, civic exposure, downturns), contested bids, restore vs rebuild, personalities (reserve, bids, Easy's picks, build mix), double-deal at two players but not three, difficulty > personality
  unit/simulate.test.mjs   Simulator determinism; every simulated game legal, complete and reconciled; seating rotation
  unit/cpu-simulate.test.mjs  All-CPU sweep: deterministic, no illegal actions/stalls/unfinished games; debt shock → bankruptcy → redevelopment; runaway detection
  unit/cpu-memo.test.mjs   Planner memo lives one decision; optimized decisions equal the plain planner's at every step (all difficulties, personalities, debt shock)
  unit/pass-cache.test.mjs  Read-pass cache: reuse within a pass, actions mid-pass and direct edits between passes invalidate, copies never cached, whole games match fresh readings
  unit/_playthrough.mjs    Deterministic full-game driver used by the preset tests
  unit/tutorial.test.mjs   Tutorial start/skip/replay/completion, persistence (incl. broken storage), tips per game state
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

**Tabletop look:** each block is a paper cut-out lifted off a kraft-paper board. Stacked drop shadows read as cardstock, and developed blocks gain a layer per level. Blocks grow denser as they level (`blockScene` in `js/art.js`, existing sprites only):
- **Level 1:** the primary building.
- **Level 2:** plus two corner props at the kerb (trees, lamps, mailboxes, hydrants, utility poles, planters…).
- **Level 3:** plus an annex behind the main building (a duplex, café, warehouse, oak, statue or fountain) and a street piece in front (a parked car, van, truck or bike, a bus stop or traffic light), so the lot reads as a dense mini city block. On the smallest phones the street piece is dropped to keep the block readable.

Claimed blocks carry the owner's flag, frame, tint and symbol mark. As a block develops, the tint, frame and flag fade back so the city dominates the ownership overlay; the symbol mark stays at every level for colour-blind players, and every block's spoken label is unchanged. The board frame is a stack of card sheets.

**Readability rules:** props and decor never sit on roads, and nothing floats over the board. The district key sits in a strip under the board, never over it; on short landscape screens the chrome slims down and the key is left out so the board keeps every pixel. Unbuilt roads stay as high-contrast pencil lines, and paved ones keep a thin builder-coloured curb.

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
npm run simulate               # balance report: hundreds of complete bot games (see Balance simulation)
npm run simulate:cpu           # CPU report: all-CPU games with the real CPU engine (see CPU simulation)
npm run build:icons            # re-render app icons from the logo sprite (needs Playwright)
```

`npm run test:smoke` defaults to Chromium; set `BROWSER=chromium`, `webkit`, or
`firefox` to select an engine. GitHub Actions runs unit tests on every push and
pull request, then runs the complete smoke suite independently in all three
engines. A browser job fails on an uncaught JavaScript error, console error,
asset/request failure, assertion failure, or horizontal page overflow. Failure
screenshots are uploaded as workflow artifacts.

**Offline/PWA checks.** `npm test` includes `tests/unit/pwa.test.mjs`: the manifest is installable and subpath-safe, icons have their declared sizes, the precache contains every file the page, stylesheets and module graph load (and is up to date with its content hash), no file loads anything from the network, and `sw.js` itself is run in a simulated worker scoped to `/GRIDLOCK/` to verify install, activation cleanup, offline routing and the update handshake. In the browser, `npm run test:pwa` (run by CI in all three engines) serves the site under `/GRIDLOCK/`, installs the service worker, then stops the server and goes offline. It reloads, continues the autosave, captures and builds, deep-links with a query string, and autosaves again. Finally it publishes a new `sw.js` and checks that the running game keeps the old version, that **Later** and a plain reload don't force the update, and that **Reload** keeps the saved game, switches version and removes the old caches.

The smoke test runs the whole flow through the real UI: title → how to play → settings persistence → setup → keyboard navigation → rotation and handoff → inert completed roads → capture and bonus-road chains → Leave Vacant, build and upgrade → income feedback → complete city → progressive results → rematch → save/restore → confirmed abandon. It does this at desktop, laptop, tablet, phone and phone-landscape sizes, plus a staged four-way tie played through the City era with End Turn (era chip, prompt, no Pave Road), a City-era hostile takeover (Expansion refuses it; price, pressure vs control, one per turn), a hi-DPI phone art check (WebP loaded, 9-slice frames, road/junction tiles, progression props, no collapsed sprites), distress → recovery → bankruptcy (recovery capital, penalty, the Recovering chip and prompt) → contested redevelopment, a seeded Fire footprint, district bonuses, touch confirmation/cancellation, animation/reduced-motion paths, and audio (no AudioContext before a gesture, volume sliders and persistence, ambience only in game and ducked by pause, the top-bar mute, a capture chain, and the sound settings on a phone), and touch: every haptic pattern on a phone (recorded from `navigator.vibrate`), the tap-through guard, the Haptics setting and its persistence, touch-target sizes in portrait and rotated landscape, desktop without haptics, and a touchscreen laptop where finger taps preview but mouse clicks pave. Two tutorial runs play a first game through all eight tips in context (without dismissing most of them, proving they never block play) and check that completion persists; and skip → reload → no tips, then Replay Tutorial from How To Play (next game) and from Settings (current game). The other tests start as returning players with the tutorial finished. A rule-preset run checks the setup descriptions, Urban Chaos with a Custom 3-player table (mode shown in game, pause and results; an event in round 2; kept by reload/Continue and Play Again), and Classic (no events or calm-round notes). A career run checks that a debug-staged ending records nothing, that a Classic match played to the end through the game's own controls records stats and awards Ribbon Cutting, Mayor of the Year and Purist (shown on the results screen and the Statistics screen, surviving a reload), and that corrupt stored data shows a fresh record with the old data kept aside. A strategic-information run checks the forecast lines, tooltip and compare table during a Housing Boom with a district bonus to gain, then builds and upgrades for real and confirms cost, net per turn, City Value and income matched the forecast, plus the inspector's details. A replay run opens a challenge link (setup pre-filled, address bar cleaned, `?debug` kept), checks New Seed/Random/invalid seeds, plays an Urban Chaos city, checks the seed in the pause menu and results, copies the link (and the selectable-text fallback when the clipboard refuses), then Replay Same City with the same moves must roll the identical event sequence, Play Again must deal a new seed, and the link opened plainly must deal the same city. A play-options run (desktop and phone) checks the three title buttons fit above the fold, what each opens (Local Multiplayer all Human; Custom / Mixed a Custom Game with Mixed seats; Play Solo Player 1 Human + three Normal CPUs), then plays a first Solo game: the tutorial counts nine tips and shows the CPU note, the active bot's card glows, the strip states its intent, the board is locked and refuses a click, Pause from the strip stops the bots, Speed up is pressed and saved, and control returns to the human with no leftover highlight. A seat-controller run checks the Solo / Local Friends / Mixed presets (Local Friends by default, with locked all-Human seats as before), CPU difficulty and bot names, the no-Human-seat and Custom seat-count validation, the CPU tags in game and on the results screen, and that the table survives reload + Continue, Play Again and Replay Same City. Three CPU runs play real games: Solo (the bots play themselves with the thinking strip and a refused board click; pause stops them; Speed up and Skip work; a reload mid-bot-turn resumes with no repeated road; the whole city is played out with no handoff screen, and nothing moves after the end), Mixed Human/CPU/Human/CPU (the handoff appears only when a different person takes over, a Hard bot in debt sells its way out, and a person-opened auction gets a sealed bot bid that wins), and a bot opening bidding itself (people may bid, leaving passes, and the bot then finishes its turn). A 3-people + 1-bot run on a phone with reduced motion and haptics checks that handoffs appear only between people (never before or after the bot, except when a different person takes over), that the bot's moves never vibrate the phone, that nothing animates, and that sound stays unlocked around the bot's turn. A start-screen run (desktop and phone) opens a fresh session on the start screen (the right prompt for touch or keyboard, the INSPIRE logo, the downtown street, no sound before a tap), taps through the INSPIRE intro (or Skip) to the main menu with focus on Play Solo and every button on screen, follows the music theme through the menu, a game, the pause menu and Save & Quit, checks a reload skips the start screen, turns Music off in Settings, and fetches the music, video and logo; a keyboard run starts with Enter, skips with Escape and checks the key never presses a menu button. The other runs start as a player already past the start screen this session. An accessibility audit visits every screen and the pause, capture, build and results dialogs with reduced motion on: every visible control must have an accessible name, every rendered `aria-labelledby`/`aria-describedby`/`for` reference must resolve, ids must be unique, open dialogs must be labelled, and nothing may be animating; the in-app Reduce Motion setting must also stop all animation and persist. It uses a local `playwright` install if there is one and otherwise falls back to a global install.
