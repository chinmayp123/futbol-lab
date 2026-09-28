# Working on this project

Notes for anyone — human or AI coding agent — picking this up. Read
[ARCHITECTURE.md](ARCHITECTURE.md) for the module map, [MODEL.md](MODEL.md) for the maths,
[DESIGN.md](DESIGN.md) for the visual system, [DATA_SOURCES.md](DATA_SOURCES.md) for the
feeds. This file is about *how to work here* without breaking things.

---

## What this is

**Futbol Lab** (Starball Lab until September 2026): a football match tracker that runs a
betting model against the **Premier League**, **LaLiga**, the **2026-27 Champions
League** and the **2026-27 UEFA Nations League**, with MLS next. One shared data layer in plain ESM, one renderer file, no framework, no
bundler, zero runtime dependencies in the data layer.

The owner uses **the website** (<https://futbol-lab.vercel.app>,
<https://chinmayp123.github.io/futbol-lab/>), which runs the desktop widget's own renderer
over Firestore — see the website section of ARCHITECTURE.md. New features still belong in
`lib.mjs` + `widget/renderer.js`; the site and the widget pick them up together. `cli.mjs`
still works and shares the data layer, but don't spend effort there unless asked.

---

## Setup

```sh
npm install         # Electron + electron-builder (dev only)
npm run widget      # launch from source
node morning.mjs    # build + record today's card
node cli.mjs        # terminal tracker
node web/build.mjs  # build the website into site/
COMPETITION=epl node publisher/publish.mjs live   # one publisher pass (needs publisher/credentials.json)
```

No key is needed for anything essential. `odds.config.json` (gitignored) holds two optional
keys and the active competition.

---

## The ten rules

1. **The data layer never touches the DOM; the renderer never fetches.** To show something
   new, add it to the payload in `lib.mjs` first, then draw it.
2. **Every feed call is best-effort.** Wrap it, return `null` on any failure, let the caller
   degrade. A dead feed must never break a view.
3. **All club-name matching goes through `teams.mjs`.** Never write a substring test on team
   names — that bug paired Bayern Munich with Dortmund and Manchester United with City for
   a day, because ESPN's three-letter codes appear inside other clubs' names.
4. **No `innerHTML` with feed data.** The renderer builds DOM with `createElement` and
   `textContent`. The CSP blocks inline script; the data is third-party.
5. **Competition specifics live in `competition.mjs`.** Never hardcode a league id, round
   name, zone boundary, table wording or bet-log path anywhere else. Adding a competition
   to the website is that entry plus `SITE_COMPETITIONS`, the `COMPETITIONS` list in
   `publish.yml`, and an `api/live/<code>.mjs` wrapper.
6. **Frozen predictions are immutable.** `bets/*/predictions.json` is the model's training
   set. The first pre-match freeze wins; later passes may only fill fields that were
   missing. Never regenerate the file wholesale, never backfill a call after a result is
   known.
7. **Respect the quotas.** The Odds API (500/month) and OddsPapi (250/month) free tiers are
   *shared with another project*. Cache, and never call them per game in a loop. On the
   website only the rationed `keyed` publisher step holds the keys, and each competition
   has a monthly OddsPapi budget (`oddspapiBudget`) it can't exceed. ESPN, FotMob, Action
   Network and FanDuel are keyless but unofficial — be gentle and cache.
8. **Don't restart the owner's running widget** to test something, and don't spawn extra
   Electron instances unprompted. Say "needs a restart" and let them do it. (If you must
   launch one for QA, pass `--user-data-dir` pointing at a scratch folder so it doesn't
   fight the single-instance lock.)
9. **Never commit `odds.config.json`, `publisher/credentials.json`, `bets/`, or `dist/`.** They're gitignored. The repo is
   public.
10. **Stay honest.** See the next section — this is the one that matters most here.

---

## The honesty rule

This app gives betting reads. The owner's trust depends on it never overclaiming, and
several parts exist purely to enforce that:

- The pre-match model is mostly a re-expression of the market's own prices. Its apparent
  "edges" are frequently its own rounding error. Three guards catch the worst of it (no
  prices longer than +400, skip games where the model can't reproduce the market, flag
  stale line-shop prices).
- An **empty card is a valid, good answer.** Never widen a band, weaken a guard or invent a
  fallback pick to make the card look busy. If a day produces nothing, the UI explains why,
  game by game.
- Anything without a real market to be judged against — scorers, corners, keeper saves — is
  labelled **display-only** and never bet.
- The bar for "the model works" is the 1X2 Brier trending toward ~0.55, the result rate
  above the bookmaker's ~55%, and positive closing-line value across dozens of bets. Not
  "lots of green ticks". If you ever produce a number that looks too good, suspect a bug
  first.

When you change anything in the pick path, say plainly what it does to the number of picks
and why.

---

## Conventions

- **ESM everywhere** in the data layer (`.mjs`), CommonJS in the Electron main/preload
  (`.cjs`), plain script in the renderer.
- **Comments explain *why*, and especially why-not.** The codebase is full of notes like
  "an earlier version ranked by edge and bet the biggest disagreements first" — those are
  load-bearing. Preserve them; add to them when you learn something the hard way.
- Two-space indent, double quotes, semicolons, trailing commas in multi-line literals.
  Long single-purpose lines are fine and common here.
- Functions do one thing and return plain data. No classes in the data layer.
- **Commits**: a one-line summary in the imperative, then a paragraph explaining the *why*
  and the failure mode being fixed. Look at `git log` — that history is documentation.

---

## Verifying a change

There is **no test framework**. Be honest about that rather than pretending coverage
exists. What actually works:

```sh
node --check <file>                    # syntax, every touched file
node -e "import('./lib.mjs').then(…)"  # exercise a function against live feeds
node morning.mjs                       # end-to-end: card + record + settle
```

For the widget, a Playwright `_electron` launch (playwright-core is already a dev
dependency) with `--user-data-dir` set to a scratch folder. Useful pattern: override an IPC
handler from the main process to feed canned data instead of hitting live feeds, so a view
can be checked out of season:

```js
await app.evaluate(({ ipcMain }, d) => {
  ipcMain.removeHandler("get-record");
  ipcMain.handle("get-record", async () => d.record);
}, data);
```

Check real numbers, not just that it renders. Most bugs found here were wrong values in a
view that looked fine: a keeper projected at 0.0, a "72% draw" at +3000, a fixed 9.5
corners line, Dortmund's players on Bayern's page.

---

## Current state (September 2026)

Working: the website (Firestore + GitHub Actions publisher + Vercel live functions) for the
Premier League, LaLiga, the Champions League and the Nations League (no card — see
DATA_SOURCES.md), live tracking, xG, pitch with lineups and shot map,
five tabs, the card with its guards, the bet record with CLV, the model scorecard with scorer
grading, installers, cross-competition form and projections.

Next competition: **MLS** (ESPN `usa.1`, Odds API `soccer_usa_mls`, OddsPapi 242, FanDuel
141 — conference tables, plus a playoff bracket the renderer doesn't draw yet). Those ids
were verified in September 2026.

Before adding any league, run every ESPN club in it against every feed's club names (FotMob,
FanDuel, The Odds API's free events list, Action Network's dated boards) and look for two
things: clubs with no match, and one feed name matching several clubs. The second is how
LaLiga's bugs were caught — "Real Sociedad" had been reduced to "Real" (matching Real Madrid
and Betis) and ESPN's bare "Deportivo" swallowed "Deportivo Alavés".

Known gaps, roughly in priority order:

1. **The pre-match engine.** Replace the market re-expression with a Dixon–Coles fit on
   club history using the closing line as a prior. `predictions.json` is the collected
   training data. This is the change that would make the card worth betting.
2. **Team pages.** Click a crest, see that club's recent games with scores, xG and
   opponents, plus head-to-head with the next opponent. Data path already exists
   (`fotmob.recentMatches`).
3. **Evening preview.** The card and Builder only price games on the current betting day,
   so both go quiet once the day's games kick off. Price tomorrow's slate once lines post.
4. **Live scorecard grading.** Grade a prediction the moment it's mathematically decided
   rather than waiting for full time.
5. **Signed installers**, if the app is ever handed to people who shouldn't see a
   SmartScreen warning.

Historical context for the model's caution lives in `POST-WC-PLAN.md` — the World Cup
retrospective, including the finding that the engine showed negative skill over its first
settled sample. That's why the guards and the paper-only stance exist.
