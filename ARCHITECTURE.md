# Architecture

How the app is put together: the module map, where data comes from, how it reaches the
screen, and the files it keeps on disk. Read this before changing anything; read
[MODEL.md](MODEL.md) for the maths and [DATA_SOURCES.md](DATA_SOURCES.md) for the feeds.

Zero runtime dependencies. Node 18+ for the data layer, Electron for the widget shell,
`electron-builder` (dev-only) for installers. No framework, no bundler, no build step —
the renderer is plain DOM calls in one file.

---

## The shape of it

```
   feeds (HTTP, no auth except two optional keys)
   ESPN · FotMob · Action Network · FanDuel · OddsPapi · The Odds API
                          │
                          ▼
   ┌──────────────────────────────────────────────────────────┐
   │  data + model layer  (plain ESM, runs in Node)           │
   │                                                          │
   │  competition.mjs  which tournament, ids, format rules    │
   │  teams.mjs        one strict club-name matcher           │
   │  <feed>.mjs       one module per feed, best-effort       │
   │  lib.mjs          the model + the view assemblers        │
   │  parlays.mjs      candidate legs → the daily card        │
   │  betlog.mjs       bet log, settling, calibration         │
   └──────────────────────────────────────────────────────────┘
                          │  plain JSON, no classes
          ┌───────────────┴───────────────┐
          ▼                               ▼
   widget/main.cjs                   morning.mjs / cli.mjs
   (Electron main: polls,            (scheduled card, terminal
    owns IPC + tray + window)         tracker — same layer)
          │  IPC
          ▼
   widget/renderer.js  (draws five tabs from that JSON)
```

**The rule that keeps this simple:** the data layer never touches the DOM and the renderer
never fetches. The renderer draws whatever JSON it is handed: on the website (and the desktop
app, which is the website in a window) `web/wc.js` hands it what the publisher and the live
functions built with `lib.getWidgetState()` and friends; before v1.2 the desktop app's main
process polled `lib` and pushed the blob over IPC. Anything the renderer needs must be added to the
payload in `lib.mjs` first.

---

## Modules

### `competition.mjs` — what competition this is
The single source of truth for every competition-specific id and format rule. `COMP` is
the active entry, chosen once when the module loads: the `COMPETITION` env var, else
`"competition"` in `odds.config.json`, else `ucl`. Entries: `epl` (Premier League), `laliga`,
`ucl` (Champions League), `unl` (Nations League: 14 groups in four tiers, each tier with its own
zones via `leagues` + `groupRules()`, and four FotMob leagues), `wc` (kept as the reference the
tool was built on).
`SITE_COMPETITIONS` lists the ones the website shows. Because the data layer is bound to
one competition per process, the website runs one publisher pass and one Vercel live
function per competition rather than switching at runtime.

Each entry carries: the ESPN league slug, The Odds API sport key, the OddsPapi tournament
id and monthly call budget, the FotMob league id + slug, FanDuel's competition id, the
`format` (`league-phase`, `league` or `groups`), the phase slugs and games per team, the
table `zones` with their labels and cut-line text, the round-pill prefix (`MD` / `MW`), the
knockout round order, labels and date window (none for a domestic league), whether ties are
two-legged, the fixture-pool look-back/ahead, and the bet-log directory. `compMeta()`
carries the display subset into every payload, so the renderer has no competition-specific
words of its own.

Also here: `DATA_DIR` (where the user's own files live — the repo when run from source,
Electron's per-user data folder when packaged), `readConfig()` (the one reader of
`odds.config.json`), `compMeta()` (the plain-data subset the widget shows), and
`clubLeague()` (a season map of club → domestic league, since no feed carries it).

**Repointing at another competition is a config change, not a code hunt.** If you find
yourself hardcoding a league id or a round name anywhere else, it belongs here.

### `teams.mjs` — the club-name matcher
Every feed spells clubs differently. This is the only place that decides whether two names
are the same club: fold diacritics, canonicalise the handful of disagreements
(Inter/Internazionale, Bayern Munich/München, PSG, Sporting CP), drop generic tokens (fc,
sc, club…), then require every distinctive token of the shorter name to appear in the
longer one.

**An abbreviation only ever matches by exact equality against a feed's own abbreviation
field.** This is load-bearing: the old per-module matchers accepted any substring, so
ESPN's `MUN` (Bayern Munich) matched Dort-**mun**-d and `MAN` (Manchester United) matched
**Man**chester City, and the wrong players, form and prices flowed into those games for a
day. Never reintroduce a substring test on names.

### Feed modules — one per source, all best-effort
`espn` lives in `lib.mjs` (it's the backbone); the rest are separate:

| Module | Provides | Key | Failure mode |
|---|---|---|---|
| `fotmob.mjs` | shot-level xG, xGOT, big chances, momentum, lineups + pitch coordinates, player ratings, per-player shot maps, recent form across all competitions | none | returns `null`, caller falls back |
| `actionnetwork.mjs` | FanDuel moneyline/spread/total, public betting tickets % vs money % | none | returns `null` |
| `fanduel.mjs` | corners O/U, BTTS, anytime-scorer and shots-on-target prices | none | returns `null` |
| `oddspapi.mjs` | best price across books for corners, BTTS, DNB, team totals, Asian handicaps | optional | returns `null` |
| The Odds API (in `lib.mjs`) | multi-book moneyline + player props | optional | falls back to Action Network |

Every one of them swallows its own errors and returns `null`. **A dead feed must never
break a view** — it degrades. FotMob and FanDuel are unofficial endpoints read from public
pages; treat them as liable to change shape without notice.

### `lib.mjs` — the model and the view assemblers
The big one (~1500 lines). Three layers inside it:

1. **Fetch + cache helpers** — `scoreboard*`, `summary`, `allStandings`, `fetchOddsEvents`
   (quota-aware, TTL by game state: 30 min pre, 5 min live, 6 h final), `fixturePool`
   (one ranged ESPN call covering `lookBackDays` → `lookAheadDays`).
2. **The model** — `scorePrediction`, `bettingModel`, `outcomeProbs`, `cornersModel`,
   `keeperSaveLine`, `pregameProjections`, `matchConditions`, `centreLine`. See
   [MODEL.md](MODEL.md).
3. **View assemblers** — the functions the widget actually calls, each returning plain JSON:

| Function | Feeds | Used by |
|---|---|---|
| `getWidgetState(query)` | everything for one tracked match | every poll |
| `listMatchesData()` | the slate: one row per game with a market prediction | Matchday, search, table |
| `getStandings()` | league table with zones, or the folded knockout bracket | Table |
| `getDailyParlays()` | the morning card (cached 30 min) | Matchday |
| `getParlayMenu()` | every priced candidate leg per game (cached 30 min) | Builder |
| `getRecord()` | bet log + calibration + graded predictions (cached 5 min) | Record |
| `trackParlay(payload)` | logs a user-built slip | Builder |
| `captureClosing()` | snapshots closing prices for CLV | every poll |

Also here: the **predictions store** (`freezePrediction`, `gradePredictions`) — the
model's own scorecard, described below.

### `parlays.mjs` — candidate legs → the card
`matchLegs(ev)` prices every market it can find for one game into candidate legs, each
carrying `{market, pick, ml, dec, impl, modelProb, edge, rawEdge, coherent, fadePublic,
guard, why}`. Then:

- `bettable(l)` is the gate: not corners, not scorers, no `guard`, agrees with the model's
  own predicted script, not a side sharp money is fading, and `rawEdge` inside the band.
- `bestSingles(cands)` takes at most one leg per **axis** (result: ML/DNB/spread; goals:
  total/team total/BTTS) so the card never double-stakes one opinion.
- `generateDailyParlays()` returns the tracked singles, an untracked cross-game longshot,
  and `notes` — one line per game saying why it did or didn't qualify, so an empty card
  still explains itself.
- `parlayMenu()` returns every candidate (guards included) for the Builder board.

### `betlog.mjs` — the bet record and the two learned dials
Appends the card to `log.json`, settles finished legs from the box score, and computes the
stats the Record tab shows. Two values feed back into the model:

- `goalsBias()` — scales goal expectation, learned from settled totals.
- `edgeTrust()` — how much of a claimed edge on a *derived* market is believed, learned by
  regressing outcomes on claimed edges. Clamped to `[0.2, 1]`.

`captureClosing()` snapshots the price near kickoff so closing-line value can be computed
later. CLV is the honest measure of edge; results take months.

### `widget/` — the shell
- **`main.cjs`** (Electron main) — since v1.2 **the desktop app is a window around the
  website** (`FUTBOL_SITE`, GitHub Pages by default because it's an authorized Google sign-in
  domain). A frameless window with the native caption buttons over the site's 50px bar
  (Windows Controls Overlay, so Snap Layouts works; traffic lights inset on macOS), CSS
  injected so that bar drags the window and the site's "Get app" button hides, Google
  sign-in popups kept in-app and every other link sent to the browser, a retry page when
  offline, remembered bounds, the tray, start-with-Windows, single instance. It names the app
  and takes its own `userData` folder (carrying over the old Starball Lab one). The user
  agent drops its Electron token because Google refuses sign-in from embedded browsers.
  Before v1.2 it polled `lib.mjs` itself, pushed JSON to the renderer over IPC through
  `preload.cjs` (removed) and spent the user's own odds keys.
- **Installers**: `npm run dist` locally, or push a `v*` tag and `release.yml` builds the
  Windows setup and both macOS `.dmg`s and attaches them to a GitHub release. File names
  carry no version (`Futbol-Lab-Setup.exe`, `Futbol-Lab-<arch>.dmg`), so the site's "Get app"
  link to `releases/latest/download/Futbol-Lab-Setup.exe` keeps working across releases.
- **`renderer.js`** (~1850 lines): five tabs, all drawn with `createElement` +
  `textContent`. **No `innerHTML` with feed strings, ever** — the CSP forbids inline script
  and the data is third-party.
- **`style.css`**: the Broadcast design system. See [DESIGN.md](DESIGN.md).
- **`make-icon.mjs`**: draws the Futbol Lab mark into `icon.ico/png` and the tray PNGs with
  no image library (analytic SVG geometry → RGBA → PNG via `node:zlib`).

### `cli.mjs`, `morning.mjs`
`cli.mjs` is the terminal tracker (same data layer, ANSI output). `morning.mjs` is what the
scheduled task runs at 10:00: build the card, record it, settle yesterday, write
`latest.txt`.

---

## Render pipeline (the part that surprises people)

`renderer.js` keeps one `last` payload and redraws from scratch on every push. `render()`
dispatches on `route`, parsed from the URL hash: `today` (`#/today[/day]`), `league`
(`#/league/<code>[/table|fixtures|builder]`), `match` (`#/match/<id>`) and `bets`
(`#/bets[/record[/<code>]]`). `go(route)` pushes a history entry (or replaces it — sub-tabs,
days, filters, the league switch); `popstate` re-applies, and `history.state.d` counts depth
so ◀ knows when there's nowhere back to go. League pages fetch per league code through `wc`
(`getStandings(code)`, `getParlayMenu(code)`, `getRecord(code)`) into caches kept ten
minutes. A page's header (league name, switch and sub-tabs; Bets' tabs; a match's
breadcrumb) goes in `#hub`, above the lower third and outside the scrolling body.

The **match view** is assembled as a flat array of `blocks`, then laid out:

1. Sections are delimited by `.label` nodes — everything between one label and the next
   becomes one card.
2. `flushCards(blocks, late)` splits them: nodes before the first label are the header
   (stat strip, pitch, sheet), labelled sections flow into two balanced columns,
   `.label.full` sections span full width, `late` nodes go under the columns, the
   disclaimer last.
3. **Order changes with game state.** Before kickoff the pitch has no shots to plot, so the
   pitch and match sheet move into `late` and the model's read leads. Once the game is on,
   the pitch leads again.

Compact mode (phones, narrow windows) renders the same blocks and hides most with CSS; the
title bar's Today · Leagues · Bets move to the bottom bar (`#bnav`). If you add a section,
decide what compact does with it.

---

## Files on disk

Under `DATA_DIR` (repo when run from source, per-user app data when installed):

| File | What |
|---|---|
| `odds.config.json` | **gitignored.** Optional API keys + `"competition"`. Never commit. |
| `bets/<competition>/log.json` | the bet record: days → parlays → legs, with results and closing prices |
| `bets/<competition>/predictions.json` | the model scorecard (below) |
| `bets/<competition>/pregame.json` | pre-match projection snapshots, graded against final box scores |
| `bets/<competition>/latest.txt` | the morning card as plain text |

Each competition keeps its own folder, so calibrations never bleed across tournaments.

### Where the records live — `store.mjs`
`log`, `predictions` and `pregame` go through `store.mjs`'s synchronous `get`/`set`, never `fs`.
By default that is the files above (widget, `cli.mjs`, `morning.mjs`). The website's publisher
calls `useRemote()` with a Firestore backend: `load()` pulls every record into memory, the data
layer reads and writes the in-memory copies, `save()` writes back only the records that changed
(gzipped JSON in a bytes field at `competitions/<COMP.key>/store/<name>`). The publisher is the
only writer — one workflow run at a time — so there's no merge logic. `latest.txt` is file-only.

---

## The website — GitHub Pages + Firebase (free tier) + Vercel

The browser can't run the data layer (the feeds refuse cross-origin calls, the odds keys would be
public), and the Firebase project stays on the free Spark plan (no Cloud Functions). So:

```
 GitHub Actions cron (5 min)            Vercel function (on demand)
 publisher/publish.mjs live · keyed     api/live/<code>.mjs ?q=<event>
        │ writes views + records               │ fresh match view, read-only
        ▼                                      │
   Firestore  competitions/<COMP.key>/…        │
        │ onSnapshot / getDoc                  │ fetch, polled 30 s live
        └──────────────► web/wc.js ◄───────────┘
                     (window.wc for renderer.js)  →  GitHub Pages / Vercel
```

| Piece | What |
|---|---|
| `publisher/publish.mjs` + `.github/workflows/publish.yml` | Every 5 min (GitHub often runs it late), one pass per competition (`COMPETITIONS` in the workflow, `COMPETITION=<code>` per process). `live` — no odds keys: logs slips, publishes the slate, rebuilds match views by urgency (live every run, <2 h to kickoff every run, <36 h every 30 min, finished at FT + once 2 h later) within a 150 s budget, the table every 30 min, the record hourly or when something finished. `keyed` — the only step with the keys: the 10:00 America/Los_Angeles card (settled, recorded, published with the builder), one card/builder refresh ≤90 min before the day's first kickoff, closing prices only for pending legs inside the CLV window, at most every 30 min. OddsPapi calls are counted against the competition's `oddspapiBudget` for the month (in `publisher/jobs`). The schedule lives in `publisher/jobs`, because every run is a fresh process and the in-memory TTLs protect nothing. |
| `api/live/<code>.mjs` + `api/_live.mjs` (Vercel, `vercel.json`) | `GET /api/live/<code>?q=<ESPN id>` → `lib.getWidgetState` on demand. Each competition is its own function: the wrapper sets `COMPETITION` before loading the shared handler, so the data layer binds to it. Loads the records (frozen call, pregame snapshot, goals bias) but never saves them; no odds keys, so traffic can't spend quota. CDN `s-maxage=20`. |
| `web/build.mjs` → `site/` | assembles the site from `widget/renderer.js`, `style.css`, `icon.png` and a transformed `index.html` (browser CSP, `wc.js` instead of the renderer tag, the Get app and sign-in buttons) plus `site-config.js` (the site's competitions and the live API base) — the widget's front end stays the single source. Run by `.github/workflows/pages.yml` and Vercel's build. |
| `web/wc.js` | `window.wc` for the browser. Reads every competition's slate at once and merges them (rows tagged `compCode`/`compShort`/`compName`) for Today; `wc.competitions` lists the site's leagues in order and the payload's `comps` carries each one's meta. There is no *active* competition: everything league-specific takes a code — `getStandings(code)`, `getParlayMenu(code)`, `getRecord(code)`, `trackParlay(payload, code)`. `setMatch(id)` opens the game a match page asks for (Firestore snapshot + the live function while it's live / ≤90 min out / just finished) and `setMatch(null)` stops it when the page closes; the payload's `matchId` says which game `match` belongs to. Adds `uclWeek` on Monday–Thursday of a week with Champions League games (the renderer leads Today with it and sets the `ucl-week` skin). The card is merged across competitions. The table and builder come from `view/*`, the card and record from `private/*` (owner); `trackParlay` queues a `slips` doc the next run logs. Expand is a toggle; pin/hide/quit are no-ops. |
| `firestore.rules` | public read `view/{slate,standings,menu,status}` and `games/*`; owner read `private/{record,parlays}`; publisher-only `store/*` and `publisher/jobs`; slips created by the owner (strict schema), read + deleted by the publisher; `owners/{uid}` enrolled only by the publisher. Every write validated. |
| Auth | Google sign-in for the owner; email/password only for the publisher account (uid pinned in the rules). Enrol an owner: `node publisher/add-owner.mjs <uid>` (the page shows the uid). |
| Secrets | GitHub: `ODDS_API_KEY`, `ODDSPAPI_KEY`, `FUTBOL_PUBLISHER_EMAIL`, `FUTBOL_PUBLISHER_PASSWORD`. Vercel: the two publisher ones. Locally: `publisher/credentials.json` (gitignored). |
| One-offs | `node publisher/import-logs.mjs` copied the desktop records into Firestore. |

Firebase: project `champions-league-a650f`, Firestore `(default)` Standard in `nam5`. Every
competition has its own subtree (`competitions/<COMP.key>/…`), so records, jobs and slips
never mix. Adding a competition to the site: an entry in `competition.mjs` +
`SITE_COMPETITIONS`, the `COMPETITIONS` list in `publish.yml`, and `api/live/<code>.mjs`.

### The predictions store — how the model gets judged
`predictions.json` is one entry per event:

```jsonc
{
  "<espnEventId>": {
    "game": "MUN v BODO", "date": "…", "homeAbbr": "MUN", "awayAbbr": "BODO",
    "pred": { "ph": 2, "pa": 1, "wH": .74, "wD": .14, "wA": .12,
              "pOver25": .83, "pBTTS": .70, "basis": "market + form" },
    "scorers": { "home": [{ "name": "Luis Díaz", "p": .48, "scored": true }], "away": [] },
    "frozenAt": 1757…, "actual": { "h": 3, "a": 1 }, "graded": true
  }
}
```

**First freeze wins.** The first pre-match sight of a game locks the call so a later refresh
can't quietly revise it; subsequent calls may only *fill in* fields the first one lacked
(the slate's market call has no totals or scorers, the fuller match-view call does).
Nothing freezes more than **48 hours before kickoff** (`FREEZE_HORIZON_H`): the website's
publisher sees every fixture weeks ahead, and a call locked before lines and team news exist
would poison the training set.
`gradePredictions()` grades finished games from the box score, and scorers from the
finished game's shot map. This file is the training set for the engine rewrite — treat it
as append-only data, never regenerate it wholesale.

---

## Invariants

Break these and something silently rots:

1. **Data layer never touches the DOM; renderer never fetches.** New data goes into the
   `getWidgetState` payload first.
2. **Every feed call is best-effort.** Wrap it, return `null`, let the caller degrade.
3. **All club-name matching goes through `teams.mjs`.** No substring tests on names.
4. **No `innerHTML` with feed data** in the renderer.
5. **Competition specifics live in `competition.mjs`.**
6. **Frozen predictions are immutable.** Fill missing fields only.
7. **The card is paper.** Nothing in the pick path should imply proven edge before CLV
   says so — see the honest-bar section in MODEL.md.
8. **API quotas are shared** with another project. The Odds API free tier is 500
   req/month and OddsPapi 250; the morning card must never call them per-game in a loop.
9. **Records go through `store.mjs`.** No `fs` reads or writes of the bet log, predictions or
   pregame snapshots anywhere else — the website's publisher keeps them in Firestore.
10. **Odds keys only in the rationed `keyed` step.** The `live` step and the Vercel function run
   keyless; a fresh process per run means an in-memory TTL is no quota protection.

---

## Working on it

```sh
npm install            # first time
npm run widget         # launch the widget from source
node cli.mjs           # terminal tracker
node morning.mjs       # build + record today's card (what the scheduler runs)
npm run dist           # Windows installer into dist/
node --check <file>    # the whole test suite, honestly
```

There is **no test framework**. Verification is `node --check`, one-off `node -e` scripts
against the live feeds, and for the widget a Playwright `_electron` launch with
`--user-data-dir` pointed at a scratch folder (so it doesn't fight the running copy's
single-instance lock). If you add tests, that's a welcome change; don't let their absence
stop you checking behaviour against real data before committing.

**Don't restart the user's running widget** to test a change. Say it needs a restart.
