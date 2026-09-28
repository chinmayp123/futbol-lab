# Data sources

Every feed the app reads, what it provides, what it costs, and how it fails. All of them are
wrapped so a failure returns `null` and the caller degrades — see the best-effort rule in
[AGENTS.md](AGENTS.md).

Competition-specific ids for each feed live in `competition.mjs`, one entry per competition
(Premier League, LaLiga, Champions League, Nations League; the World Cup kept), so adding one is a
config change plus a publisher pass and a live function on the website.

---

## In use

### ESPN — the backbone (`lib.mjs`, no key)
`site.api.espn.com/apis/site/v2/sports/soccer/<league>` plus the standings endpoint.
Provides live score and clock, box-score stats (shots, shots on target, possession,
**corners per side**, fouls, cards, passes, tackles), keeper stats, key events (goals,
cards, subs, shootout kicks), the standings table, and an inline pre-match odds line. No
player xG and no shot-level data.

`fixturePool()` covers the whole visible window in **one ranged call**
(`dates=YYYYMMDD-YYYYMMDD&limit=300`), so the slate, the picker and search all share a
single fetch. Refresh is every 30 s while a game is live.

**On 2026-09-28 ESPN began answering every ranged query with a 400** — every league, past
spans included — while whole months (`dates=YYYYMM&limit=300`) still worked. `scoreboardRange()`
now falls back to the months a span covers (trimmed to the span) and skips the ranged call for
an hour after a failure. If ranges come back, it uses them again on its own.

### FotMob — xG, lineups, form (`fotmob.mjs`, no key)
FotMob's `/api/*` endpoints are gated behind a rotating signed `x-mas` header, but its
public pages embed the same server-rendered payload in `<script id="__NEXT_DATA__">`, which
isn't gated. That's what the module reads.

| Page | Gives |
|---|---|
| league matches | fixture list with matchday numbers and match-page links |
| match page | **shot map** (every shot with pitch coordinates, xG, xGOT, type, situation, keeper), team xG/xGOT/big chances, momentum series, **lineups with formations, pitch slots, live ratings and events**, attacking zones, team form |
| team page | the club's whole season across **every competition** (league, cup, Europe) with the same match-page links |

The team page is what makes matchday one work: `recentMatches()` takes a club's last three
competitive games from wherever it last played (friendlies skipped — except for national
teams, whose friendlies are half their games), so form, corner and
saves projections and scorer numbers exist before a competition has any history of its own.

League ids: 42 Champions League, 47 Premier League, 87 LaLiga. The **Nations League is four
FotMob leagues**, one per tier — 9806 `nations-league-a`, 9807 `-b`, 9808 `-c`, 9809 `-d`
(48 + 48 + 48 + 12 = all 156 league-phase games, rounds 1–6) — so a competition entry may list
`fotmob.leagues` and `fetchFotmobFixtures()` reads them all, dropping a dead tier rather than
the lot.

Unofficial and brittle if the pages restructure. Player headshots come from
`images.fotmob.com/image_resources/playerimages/<id>.png` with an initials fallback.

### eloratings.net — national-team strength (`eloratings.mjs`, no key)
The World Football Elo Ratings, the Nations League path's rating prior (MODEL.md §1). The
site's own pages load two plain TSV files, and the module reads the same ones:
`World.tsv` (rank, rank, two-letter code, rating, …) and `en.teams.tsv` (code, then every
spelling the site uses). No key; `robots.txt` answered 404 on 2026-09-28, so nothing is
disallowed. Read at most once a day and kept in `DATA_DIR/cache/eloratings.json`; a failed
fetch falls back to a copy up to two weeks old, then to `null` (the market-only behaviour).
On a read-only disk (the Vercel functions) the copy is skipped and the day's cache is in
memory only.

Names go through `teams.mjs`, and a name matching more than one rated team gets no rating.
That rule caught the only clash on 2026-09-28: the site also rates Northern Cyprus, spelt
"N Cyprus", which folds to plain "cyprus" — now aliased like "N Ireland". All 72 spellings
of the 55 UEFA nations in `NATION_SPELLINGS` resolve to exactly one rated team.

### Action Network — FanDuel prices and public money (`actionnetwork.mjs`, no key)
Public JSON. Provides FanDuel's moneyline, spread and total (book id 69 plus state
variants), and the **public betting splits**: share of tickets versus share of money per
outcome. The money-versus-tickets divergence is the only sharp-money signal in the free
stack. This is also the primary odds source when no Odds API key is set. Its undated
scoreboard lists only the games around "now" (4 of a Saturday's 37 in the small hours), so
today's and tomorrow's dated boards (`&date=YYYYMMDD`, US Eastern days) are read as well.

**It has no Nations League.** Checked 2026-09-27/28/29 and 2026-10-01 during the league phase:
the boards carried MLS only. That matters more than it sounds — the card and the Builder take
their FanDuel 1X2 from this feed, so a Nations League game never reaches the model and the card
says so per game ("not priced … not bet") instead of going quiet.

### FanDuel public sportsbook API — corners, BTTS, player prices (`fanduel.mjs`, no key)
The same JSON FanDuel's own site fetches, with a public app key. Provides **total match
corners** over/under, **both teams to score**, and **anytime scorer / shots on target**
prices. Prices sit at `runners[].winRunnerOdds.americanDisplayOdds.americanOdds`, lines at
`runners[].handicap`.

League events come off the soccer SPORT page
(`content-managed-page?page=SPORT&eventTypeId=1`) filtered by FanDuel's `competitionId` —
228 Champions League, 10932509 Premier League, 117 LaLiga, 11984200 UEFA Nations League (141
MLS); there are no custom competition pages (`customPageId=uefa-nations-league` is a 404). Player markets post late: early on a matchday an event can carry only
two markets, which reads as "no props", not as a matching failure. Optional config: `fanduelRegion` (your state
subdomain, default `nj`) and `fanduelWorldCupPageId` (only for competitions that do have a
custom page).

Single-book, so its player prices are **display-only** — there's no cross-book consensus to
de-vig against, therefore no honest edge.

### OddsPapi — best price across books (`oddspapi.mjs`, optional key)
250 requests a month on the free tier, all books in one response. Provides corners, BTTS,
draw-no-bet, team totals and Asian handicaps across books, which is what lets the Builder
show a real "best price" and the card price markets FanDuel alone doesn't cover. Books to
try are configurable (`oddspapiBooks`, default `fanduel,bet365`); responses are cached 30
minutes to 12 hours because pre-match lines barely move. Tournament ids: 7 Champions
League, 17 Premier League, 8 LaLiga, 23755 UEFA Nations League (`uefa-nations-league`, 156
future fixtures listed on 2026-09-28; not 36219, the simulated "SRL" copy) (242 MLS). Every
call is counted: the website's publisher caps each competition at its monthly
`oddspapiBudget` (Champions League 60, Premier League 90, LaLiga 50, Nations League 20 — 220 of
the 250, 30 left for the other project), because each run is a fresh process whose caches start
empty. Note `/fixtures` ignores `tournamentIds` (it answered with every soccer fixture), so its
names are only ever matched, never trusted to be the competition's.

**Watch for stale lines.** A ±0.5 handicap from a line shop that beats FanDuel's moneyline
on the same outcome is a stale price, not value — the card guards against exactly that.

### The Odds API — multi-book and props (`lib.mjs`, optional key)
500 requests a month, **shared with another project**. When present it becomes the primary
odds source: multi-book moneylines with a best-price comparison, plus anytime-scorer and
shots-on-target props for the tracked game. Spend is deliberately small: the events list
costs 2 credits and the tracked game's props 2, cached 30 minutes pre-match, 5 minutes in
play, and never refetched once a game is final. An exhausted key is remembered for the rest
of the process. The morning card never calls it.

Sport keys: `soccer_uefa_champs_league`, `soccer_epl`, `soccer_spain_la_liga`,
`soccer_uefa_nations_league` (active on 2026-09-28; its free events list had 26 games and no
League D side — Malta, Andorra, Gibraltar, Lithuania, Azerbaijan and Liechtenstein get ESPN's
line only).

---

## Honest gaps

- **No goalkeeper-saves market exists** in any feed reachable for free, so saves stay model
  estimates. The line is centred on the projection, which makes the probability meaningful,
  but there is nothing to beat.
- **Player props are single-book** unless The Odds API key is live, so scorer and
  shots-on-target numbers are display-only.
- **Corners have a real market** (FanDuel, OddsPapi) but the model's own corner projections
  proved badly calibrated (36% hit against 60% claimed over n=11), so corners are benched
  from the card and shown for reading only.
- **No expected lineups** before the confirmed XIs post, roughly an hour before kickoff.
- **The Nations League has no card.** Action Network doesn't list it (see above), so there's no
  FanDuel 1X2 for the model to be judged against. Match pages still show ESPN's line, FotMob's
  form and FanDuel's corners/BTTS/props where posted; the Odds API and OddsPapi price it on the
  keyed step, but neither feeds the card's 1X2. Should a board appear, **Leagues C and D stay
  off the card** anyway (`card: false` in `competition.mjs`): one book's line on Gibraltar v
  Malta is nothing to judge a model against.

---

## Team-name matching

Every feed spells clubs differently: `Bayern Munich` / `Bayern München`, `Internazionale` /
`Inter`, `Bodo/Glimt` / `Bodø/Glimt`, `Sporting CP` / `Sporting Lisbon`,
`Paris Saint-Germain` / `PSG`. `teams.mjs` is the single matcher — diacritics folded,
aliases canonicalised, generic tokens dropped, every distinctive token of the shorter name
required in the longer one, and **abbreviations matched only by exact equality**. All 36
Champions League clubs resolve against every feed, all 20 Premier League clubs against
FotMob and FanDuel (FanDuel's `Nottm Forest` needed an alias), and all 20 LaLiga clubs
against FotMob, FanDuel, The Odds API and Action Network. LaLiga needed two fixes that were
wrong-club bugs, not misses: `sociedad` used to be a generic token, which left "Real
Sociedad" as just "real" and matched it to Real Madrid, Real Betis and Racing Santander; and
ESPN's bare "Deportivo" (La Coruña) matched "Deportivo Alavés" until it was aliased to
`deportivo la coruna`.

**National teams** (Nations League, 2026-09-28): all 54 ESPN sides against FotMob's four tiers,
FanDuel, The Odds API's events and OddsPapi — no misses beyond League D's absence from The
Odds API, and no feed name matching two sides. The fixes: FotMob's bare "Ireland" is the
Republic and would otherwise also sit inside "Northern Ireland"; ESPN's short "N Ireland" and
"Rep Ireland" lose a token to the 3-letter floor; "Turkey"/"Türkiye", "Czech Republic"/"Czechia"
and FanDuel's "Bosnia" are aliased. And **a country name matches only that country, never by
subset**: the mixed boards (FanDuel in-play, Action Network) carry "Austria Wien", "Spain U21",
"England Women", and OddsPapi's fixture list carries "… SRL" simulated sides.

This is not a nicety. The earlier per-module substring matchers put Dortmund's players on
Bayern's page and City's on United's, because ESPN's `MUN` and `MAN` codes appear inside
those longer names.

---

## Evaluated and not used

| Source | Would give | Cost | Verdict |
|---|---|---|---|
| **API-Football** (api-sports.io) | expected + confirmed lineups, player stats, fixture stats, a predictions endpoint, pre and live odds | free 100/day, $19/mo for 7,500/day | Best free upgrade if expected lineups matter. No xG. |
| **Sportmonks** | real xG, expected lineups, pressure index | free tier limited, paid for full | Best data quality, but FotMob already gives xG for free. |
| **SofaScore** (unofficial) | xG, shot maps, ratings, lineups | scraping | Rich but brittle and ToS-risky. FotMob already fills this role. |
| **SportsGameOdds** | player props across ~9 books on the free tier | free, gated | The realistic route to *de-viggable* prop consensus, which would let scorer legs earn a real edge. |
| **OddsJam / OpticOdds** | props across 100+ books | $99–499/mo | Overkill for a personal tool. |
| **BetsAPI** (bet365) | corners and cards markets | ~£20–30/mo | Only if corners become a serious market again. |

The model is isolated in `lib.mjs`, so adding a richer source means feeding better numbers
into the same prediction and de-vig pipeline, not a rewrite.

---

## Reading

- Dixon–Coles team strength (the planned engine):
  <https://dashee87.github.io/football/python/predicting-football-results-with-statistical-modelling-dixon-coles-and-time-weighting/>
- Expected saves as an inverse of xG:
  <https://www.soccermetrics.net/goalkeeping-analytics/expected-saves-an-inverse-of-expected-goals>
- Corners as a compound Poisson process: <https://arxiv.org/abs/2112.13001>
- De-vigging and pricing player props:
  <https://betpredictionsite.com/blog/prop-betting-iq-price-player-props/>
- Odds API comparison 2026: <https://oddspapi.io/blog/best-odds-apis-2026-comparison/>
