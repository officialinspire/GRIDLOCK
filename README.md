# Grid Lock City

A papercraft tabletop city-building game designed for **exactly 4 players on one device**. A Custom Game preserves 2–3 player support. It plays like Dots & Boxes with roads: pave streets between intersections, enclose city blocks to claim them, develop them into neighbourhoods, weather city events, and finish with the most valuable city.

It's plain HTML, CSS and JavaScript (ES modules) with **no build step and no runtime dependencies**, so it runs on GitHub Pages as-is. It is also an **installable offline app (PWA)**: after the first visit it starts and plays with no network at all.

**V1.2:** installable offline play, a richer sound and haptics layer, a first-game tutorial, rule presets, career statistics and achievements, strategic forecasts, replayable cities with challenge links, and a simulation-backed balance pass (see the release notes below).

**V1.1:** release-ready four-player flow, fair final settlement, explicit cost-basis scoring, paced city events, contested redevelopment, durable local autosave, keyboard/touch accessibility, cross-browser CI, and a responsive Fredericksburg papercraft presentation.

### V1.2 release notes

- **Installable offline app (PWA):** a manifest and icons made from the game's art; a service worker that caches every game file under a content-hash version; full offline play, including autosave; updates install only when the player chooses, never mid-game; works under the GitHub Pages `/GRIDLOCK/` subpath.
- **Audio:** an audio manager with master, effects and ambience volume and mute, distinct synthesized sounds, rising pitch on capture chains, procedural city ambience, and fades. Nothing plays before the first tap or keypress.
- **Touch:** optional haptics, a guard against accidental double-tap purchases, larger tap targets, and finger-vs-mouse behaviour on touchscreen laptops.
- **First-game tutorial:** eight skippable sticky-note tips shown in context, replayable from How To Play or Settings.
- **Rule presets:** Standard, Classic (no events) and Urban Chaos (an event every round), for 2–4 players, kept by autosave.
- **Career:** a Statistics screen with per-mayor records and 12 achievement badges; only genuinely completed matches count.
- **Strategic forecasts:** the Build panel and inspector show cost, income, upkeep, net per turn, City Value change, event modifiers and the bonuses a build would activate, computed by running the real transaction on a copy of the game.
- **CPU city strategy:** `chooseCityAction()` decides builds, upgrades, leaving land vacant, keeping a configurable cash reserve, and selling or downgrading in debt. It scores everything with the real forecasts: Easy picks sensibly, Normal weighs income, upkeep, bonuses, reserve and events, and Hard adds event duration, civic shelter, district completion, return per dollar and bankruptcy risk.
- **CPU road engine:** `chooseRoad()` with Easy, Normal and Hard play: captures, safe roads, cheapest sacrifices, and for Hard chain look-ahead, value weighting and double-dealing. Pure and deterministic; it never touches the game's random generator.
- **Human and CPU seats:** each seat is Human or CPU (Easy/Normal/Hard), with Solo, Local Friends and Mixed presets on New Game and "Mayor Bot" default names. Seat types are kept through autosave, Continue, Play Again, Replay and the results screen. The rules are unchanged, human-only games play exactly as before, and CPU seats are currently played by hand.
- **Replayable cities:** a city seed on New Game, the seed shown in the pause menu and on the results screen, Replay Same City, and Copy Challenge Link (`?seed=&mode=&seats=`).
- **Balance pass:** Park income $100 → $150, Civic $250 → $325, Landmark $700 → $850. Before this, upgrading a Park or Civic building to Level 3 lost money every turn, and Landmark paid back more slowly than Industrial at every level. See *Balance simulation* for the evidence. Residential, Commercial, Industrial, scoring and events are unchanged, and the recorded V1.1 games still replay exactly.
- **Balance simulator:** `npm run simulate` plays hundreds of complete games through the real rules and reports game length, bankruptcies, builds, final spread, events, win rate by seat and capture chains.
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

Every seat is either **Human** or **CPU** (with an **Easy**, **Normal** or **Hard** difficulty). The New Game screen offers three presets:

| Preset | Seats |
| --- | --- |
| **Solo** | You plus computer mayors: the first joined seat is Human, the rest CPU (1 Human + 3 CPU in a Standard Game) |
| **Local Friends** (default) | Every joined seat is Human: the classic pass-the-device game |
| **Mixed** | Choose Human or CPU for each seat |

CPU seats that aren't given a name are called **Mayor Bot 1**, **Mayor Bot 2** and so on, numbered in seat order. Standard Game is still exactly 4 seats and Custom 2–4, with CPU seats counting toward the total. At least one seat must be Human. The seat types show as a **CPU** tag on the player cards and the results screen. They're kept by autosave and Continue Game, Play Again and Replay Same City. Saves from before seat types existed load as all-Human tables.

A seat's type is table information only: `createGame` stores `controller` (`"human"` / `"cpu"`) and `difficulty` (`null` / `"easy"` / `"normal"` / `"hard"`) on each player, and no rule reads them. A game with only Human seats plays exactly as before. CPU seats don't take their turns on their own yet: whoever holds the device plays them. The decisions they will use already exist (see [CPU road decisions](#cpu-road-decisions) and [CPU city strategy](#cpu-city-strategy)); what's still missing is hooking them into turns. Career statistics and achievements count only the Human seats. Validation, presets and bot names live in `js/core/seats.js`.

### CPU road decisions

`chooseRoad(game, { difficulty, seed })` in `js/core/cpu/roads.js` answers one question: which road should the current seat pave? It returns a decision (`{ road, reason, captures, score, difficulty, candidates }`) and changes nothing; the caller plays it with `placeRoad()`. Legality comes from the game's own `validateRoad()` and board geometry from `board.js`. Look-ahead runs on a copy of the paved roads.

| Difficulty | How it picks a road |
| --- | --- |
| **Easy** | Takes a capture if there is one. Otherwise a random legal road, usually (70%) rethinking a road that would leave a three-sided block, so it now and then hands one over |
| **Normal** | Best capture first, counting double captures and the chain behind a capture. Otherwise a safe road (one that gives nobody a block). If none is left, the road that gives the next mayor the fewest blocks. Picks randomly among equally good roads |
| **Hard** | Everything Normal does, plus look-ahead: it plays out its own capture run, the next mayor's reply (they take what's offered, then close safely or sacrifice as little as they can) and its own follow-up, weighing blocks by what they're worth (land value + capture reward). So it sacrifices a suburb block before a downtown one, avoids handing over chains, and will **double-deal**: stop two blocks short of the end of a chain so the opponent must open the next, longer one |

**Fairness and determinism:** the engine sees only what a player at the table sees. It never reads `game.rngState` or the event pool and never draws from the game's random generator, so asking it for a move can't predict or change city events (a test plays the same game with and without consulting it and gets identical events). Its choices between equally good roads come from its own seeded stream: pass `seed`, or it derives one from the public city seed, the seat and how many roads are down. The same position and seed always give the same road.

Measured in 40-game head-to-head matches with seats alternated (Classic rules, captures only): Normal takes 79% of the blocks against Easy, Hard takes 62% against Normal, and Hard takes 74% against Easy. Hard decides in under a millisecond typically, and 42 ms at worst in crowded endgames.

### CPU city strategy

`chooseCityAction(game, { difficulty, seed, reserve })` in `js/core/cpu/city.js` decides the CPU's Manage City and Capture / Develop steps, one at a time. The possible actions are build, upgrade, leave a captured block vacant, downgrade or sell while in debt, declare bankruptcy, and "pave" (done managing). `applyCityAction()` plays a decision through the normal APIs (`buildOnBlock`, `upgradeBlock`, `resolveCapture`, `downgradeBlock`, `sellDevelopment`, `declareBankruptcy`, `startPaving`), resolving a capture after a build just as the UI does. The caller asks and applies until the answer is "pave".

It has no economy formulas of its own:
- Purchases are priced and scored with `forecastDevelopment()`, the real build on a copy, including event prices, income with bonuses and events, upkeep and City Value.
- Debt options use `quoteDowngrade()`/`quoteSale()` plus the real `downgradeBlock()`/`sellDevelopment()` on a copy, read back with `playerStats()`/`scorePlayer()`.
- It never chooses a purchase the quote says is unaffordable, and it always keeps a **cash reserve**: `CPU.RESERVE` in `config.js` ($300 Easy, $1,000 Normal/Hard), or the `reserve` option.

| Difficulty | Building | Cash kept after a purchase | In debt |
| --- | --- | --- | --- |
| **Easy** | Builds something sensible (any affordable option that raises net income) on 75% of captures; builds or upgrades in Manage City 35% of the time | Reserve | Random downgrades |
| **Normal** | The best net income per turn × turns left + City Value change: adjacency bonuses, upkeep and today's event prices and income are all in the forecast. Leaves land vacant when nothing pays back before the city is finished | Reserve + next turn's upkeep and repair bills | Gives up the least net income per dollar raised |
| **Hard** | The same judged harder: active events count only for the rounds they have left, civic shelter is worth 15% of the neighbouring income it protects, a build that leaves a district one block short counts half the bonus it would bring, and it needs a return of at least 5% per dollar | Reserve + next turn's charges even if income were halved, plus a possible Fire repair | Least (income lost over the turns left + City Value lost) per dollar of debt covered |

All three declare bankruptcy only when selling everything couldn't cover the debt (the rules allow nothing else). The tuning constants live in `CPU` in `config.js`. In 30 all-CPU Standard games with the three difficulties at each table (seats rotated), average City Value was $23.6k for Easy, $38.5k for Normal and $40.8k for Hard; there were no bankruptcies, and all six categories got built.

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

Settings (saved on the device): sound on/off, master/effects/ambience volume, city ambience, tap twice to pave, haptics (touch devices with vibration), **Quick Handoff** (skip the “Pass to…” privacy card), reduce motion, and block coordinates. Without Quick Handoff, every control change pauses until the next mayor confirms they are ready.

### Statistics & achievements

**Statistics** (title menu) keeps a career record for this device, from **completed matches only**:

- **Career:** matches completed, blocks captured, longest capture chain (and who), buildings developed (builds + upgrades), highest City Value (and who), bankruptcies, events survived, and favourite development category.
- **Mayors:** games played, games won and best City Value for each mayor name used on this device (hot-seat friendly).
- **12 achievements**, shown as papercraft rosettes (earned ones in colour with who and when, locked ones in grey): Ribbon Cutting, Mayor of the Year, Chain Reaction, Land Baron, Skyline, Master Builder, Big City, Comeback Kid, Storm Chaser, Purist, Photo Finish and Veteran Mayor. New ones also appear on the results screen. When several mayors qualify in the same match, the credit goes to a winner first, then seat order.

A match counts only if it was genuinely played to the end: all 84 roads paved through play (move log), every balance reconciling with the money ledger, and every owned or developed block traceable to a logged capture, build or purchase. Games finished by debug/test staging fail these checks and are never recorded, even with `?debug`. Each match counts once.

The record is stored separately from the active-game save (`gridlock.career.v1`), versioned. Unreadable, corrupt or unknown-version data loads as a fresh record without errors; the Statistics screen says so, and the raw data is copied to `gridlock.career.corrupt` rather than lost.

### First-game tutorial

A player's first **New Game** shows short tips as each rule comes up, on taped sticky notes next to the control they explain: **Manage City**, **Pave Road**, **completing a block** (when one has three roads), **Develop Now / Leave Vacant**, the **bonus road**, **income & upkeep**, **city events**, and **winning/scoring** (at the halfway point or on the results screen).

- One note at a time, never modal and never stealing focus: the game stays fully playable underneath, and a note clears itself once you act (tips inside a dialog go when it closes).
- Every note has **Got it** and **Skip tutorial**. Skipping or finishing all eight tips is saved on the device, so later games stay tip-free.
- **Replay Tutorial** (at the end of How To Play, or under Settings → Help) starts it over: in the current game if one is in progress, otherwise in the next New Game.

### Sound

All audio is synthesised in the browser with Web Audio (no sound files), and gameplay never depends on it: everything a sound signals is also shown on screen.

- **Effects:** each action has its own sound: road paved (a card tile set down), capture (rising arpeggio), build (wooden knocks and a chord), upgrade (brassy fanfare), coins (income, sales), city events (bright bells for boons, a soft two-tone siren for emergencies, low bells for downturns), refused move (a muted bonk) and the final fanfare.
- **Capture chains escalate:** each extra capture in a chain climbs a whole tone and adds layers (octave, sparkle, then a low boom), capped after a few steps.
- **City ambience** (game screen only): quiet room tone and a slowly swelling distant-traffic hum, with an occasional passing car, bird, far-off bell or paper rustle. It fades out for the pause menu, on other screens and when the app goes to the background (then audio is suspended entirely), and fades back in on return.
- **Settings:** a master **Sound** switch (also the 🔈 button in the game's top bar), **Master**, **Effects** and **Ambience** volume sliders, and a **City ambience** switch. All are saved on the device; volume changes glide instead of jumping.
- **No autoplay:** nothing is created or played until the player first taps or presses a key.
- **Reduce motion** (the game setting or the system preference) keeps audio calmer: capture chains climb less and skip the boom, and ambient sounds don't sweep across the stereo field and come less often.
- Browsers without Web Audio, or with audio blocked, simply stay silent.

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

Forecasts have no formulas of their own: `js/core/forecast.js` runs the real `buildOnBlock` / `upgradeBlock` on a copy of the game and reads the result with the same functions the game uses (`playerStats`, `scorePlayer`, `effectiveBlockIncome`, `blockUpkeep`, `blockImpacts` / `costImpacts`, and the bonuses `refreshBonuses` writes). So a forecast is exactly what will happen; tests prove it against real transactions and the next turn's actual income and upkeep. Note that building usually *lowers* City Value at first (cash counts in full, construction at 75%), and pays back through income.

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
    cpu/city.js            CPU Manage City + Capture/Develop: build, upgrade, vacant, reserve, debt (forecast-based)
    cpu/random.js          The CPU's own seeded stream (never the game RNG)
    career.js              Career stats + achievements: genuine-match check, recording, versioned storage
    forecast.js            Build/upgrade forecasts (real transaction on a copy) + block details for the inspector
    bus.js                 Pub/sub between core and UI
  ui/                      DOM rendering and input
    router.js              Screen switching + back stack
    setupView.js           New game form: seats, Human/CPU presets + difficulty, rules, city seed
    boardView.js           Board renderer (intersections, road slots, blocks)
    hud.js                 Player cards, round & turn banner
    gameView.js            Game controller (moves, capture feedback, results, pause)
    buildPanel.js          Build/Upgrade panel for the current player's blocks
    bonusView.js           Shared bonus/protection lines
    eventView.js           Event card, active-event pills, block event lines
    financeView.js         Distress panel and bankruptcy card
    resultsView.js         Final results screen
    audio.js               Audio manager: synthesised effects, procedural ambience, volume buses, fades
    haptics.js             Optional vibration patterns (touch devices with the Vibration API only)
    touchGuard.js          Ignores tap-through taps on freshly opened/closed dialogs (touch only)
    tutorial.js            First-game coach marks (sticky notes) + Replay Tutorial
    careerView.js          Statistics & Achievements screen; records finished matches
    forecastView.js        Forecast lines, tooltips, breakdowns and the compare table
    settingsView.js        Settings form ↔ storage
    toast.js, dom.js       Helpers
dev/sprites.html           Sprite atlas: every registered crop, for checking coordinates
js/art.js                  Semantic art roles (what views ask for)
css/art.css                Papercraft skin: 9-sliced UI frames, toggles, ribbon, table decor
css/mobile.css             Touch hardening + compact phone/tablet layout (loaded last)
tools/build-assets.mjs     Generates assets/generated/ (WebP, keyed-out props, UI frames)
tools/build-pwa.mjs        Refreshes sw.js precache + version; --icons renders assets/icons/
tools/simulate.mjs         Deterministic balance simulator (npm run simulate)
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
  unit/audio.test.mjs      Audio manager on a fake Web Audio: no autoplay, silent failure, distinct sounds, chain escalation, volumes/fades, ambience scenes, settings
  unit/haptics.test.mjs    Haptic patterns, support/setting/activation rules, tap-through guard decisions
  unit/modes.test.mjs      Presets: Standard replays V1.1 goldens exactly, Classic never has events, Urban Chaos
                           has one every round (≤3 at once), determinism, 2–4 players, save/restore, old saves
  unit/career.test.mjs     Genuine-match check (staged games rejected), totals, mayors, achievements, dedupe, storage, corruption
  unit/forecast.test.mjs   Forecasts = real transactions (every category, upgrades, events, bonuses, next turn's income/upkeep, 100+ mid-game positions)
  unit/challenge.test.mjs  Seed/link parsing, links never carry ?debug, Replay setup; same seed + mode + seats + moves = same events (every preset)
  unit/seats.test.mjs      Seat validation (Standard/Custom, controllers, difficulty, a human seat), presets, bot names, human-only games unchanged, mixed tables, save/Continue/rematch/replay, career counts humans
  unit/cpu-roads.test.mjs  CPU roads on staged positions: captures, doubles/chains, safe roads, sacrifices, value-weighting, double-deal; purity, determinism, event RNG untouched; whole CPU games; Hard ≥ Normal > Easy
  unit/cpu-city.test.mjs   CPU city decisions on staged positions: affordability, configurable reserve, endgame restraint, district and event and civic judgement, upgrades, debt and bankruptcy; purity; whole CPU games; Normal/Hard > Easy
  unit/simulate.test.mjs   Simulator determinism; every simulated game legal, complete and reconciled; seating rotation
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
npm run simulate               # balance report: hundreds of complete bot games (see Balance simulation)
npm run build:icons            # re-render app icons from the logo sprite (needs Playwright)
```

`npm run test:smoke` defaults to Chromium; set `BROWSER=chromium`, `webkit`, or
`firefox` to select an engine. GitHub Actions runs unit tests on every push and
pull request, then runs the complete smoke suite independently in all three
engines. A browser job fails on an uncaught JavaScript error, console error,
asset/request failure, assertion failure, or horizontal page overflow. Failure
screenshots are uploaded as workflow artifacts.

**Offline/PWA checks.** `npm test` includes `tests/unit/pwa.test.mjs`: the manifest is installable and subpath-safe, icons have their declared sizes, the precache contains every file the page, stylesheets and module graph load (and is up to date with its content hash), no file loads anything from the network, and `sw.js` itself is run in a simulated worker scoped to `/GRIDLOCK/` to verify install, activation cleanup, offline routing and the update handshake. In the browser, `npm run test:pwa` (run by CI in all three engines) serves the site under `/GRIDLOCK/`, installs the service worker, then stops the server and goes offline. It reloads, continues the autosave, captures and builds, deep-links with a query string, and autosaves again. Finally it publishes a new `sw.js` and checks that the running game keeps the old version, that **Later** and a plain reload don't force the update, and that **Reload** keeps the saved game, switches version and removes the old caches.

The smoke test runs the whole flow through the real UI: title → how to play → settings persistence → setup → keyboard navigation → rotation and handoff → inert completed roads → capture and bonus-road chains → Leave Vacant, build and upgrade → income feedback → complete city → progressive results → rematch → save/restore → confirmed abandon. It does this at desktop, laptop, tablet, phone and phone-landscape sizes, plus a staged four-way tie, a hi-DPI phone art check (WebP loaded, 9-slice frames, road/junction tiles, progression props, no collapsed sprites), distress → recovery → bankruptcy → contested redevelopment, a seeded Fire footprint, district bonuses, touch confirmation/cancellation, animation/reduced-motion paths, and audio (no AudioContext before a gesture, volume sliders and persistence, ambience only in game and ducked by pause, the top-bar mute, a capture chain, and the sound settings on a phone), and touch: every haptic pattern on a phone (recorded from `navigator.vibrate`), the tap-through guard, the Haptics setting and its persistence, touch-target sizes in portrait and rotated landscape, desktop without haptics, and a touchscreen laptop where finger taps preview but mouse clicks pave. Two tutorial runs play a first game through all eight tips in context (without dismissing most of them, proving they never block play) and check that completion persists; and skip → reload → no tips, then Replay Tutorial from How To Play (next game) and from Settings (current game). The other tests start as returning players with the tutorial finished. A rule-preset run checks the setup descriptions, Urban Chaos with a Custom 3-player table (mode shown in game, pause and results; an event in round 2; kept by reload/Continue and Play Again), and Classic (no events or calm-round notes). A career run checks that a debug-staged ending records nothing, that a Classic match played to the end through the game's own controls records stats and awards Ribbon Cutting, Mayor of the Year and Purist (shown on the results screen and the Statistics screen, surviving a reload), and that corrupt stored data shows a fresh record with the old data kept aside. A strategic-information run checks the forecast lines, tooltip and compare table during a Housing Boom with a district bonus to gain, then builds and upgrades for real and confirms cost, net per turn, City Value and income matched the forecast, plus the inspector's details. A replay run opens a challenge link (setup pre-filled, address bar cleaned, `?debug` kept), checks New Seed/Random/invalid seeds, plays an Urban Chaos city, checks the seed in the pause menu and results, copies the link (and the selectable-text fallback when the clipboard refuses), then Replay Same City with the same moves must roll the identical event sequence, Play Again must deal a new seed, and the link opened plainly must deal the same city. A seat-controller run checks the Solo / Local Friends / Mixed presets (Local Friends by default, with locked all-Human seats as before), CPU difficulty and bot names, the no-Human-seat and Custom seat-count validation, the CPU tags in game and on the results screen, and that the table survives reload + Continue, Play Again and Replay Same City. An accessibility audit visits every screen and the pause, capture, build and results dialogs with reduced motion on: every visible control must have an accessible name, every rendered `aria-labelledby`/`aria-describedby`/`for` reference must resolve, ids must be unique, open dialogs must be labelled, and nothing may be animating; the in-app Reduce Motion setting must also stop all animation and persist. It uses a local `playwright` install if there is one and otherwise falls back to a global install.
