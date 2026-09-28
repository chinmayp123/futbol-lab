# The model

Every number the app shows, and where it comes from. This is a transparent statistical
model — Poisson goal distributions plus weighted heuristics — **not** a machine-learning
fit. Keep this doc in step with `lib.mjs` and `parlays.mjs`.

> ⚠ Model estimates, not betting advice. Sportsbook prices are negative expected value on
> average. The card in this app is **paper** until closing-line value says otherwise.

Feeds are listed in [DATA_SOURCES.md](DATA_SOURCES.md); the module map is in
[ARCHITECTURE.md](ARCHITECTURE.md).

---

## 1. Expected goals is the engine

Everything derives from an expected-goals rate **λ** per side, then goals modelled as two
Poisson distributions (`scorePrediction()`). Constants: full time `FT = 95` minutes,
neutral prior `AVG_TEAM = 1.35` goals per team.

### Before kickoff — "market + form"
1. **Market base.** From the over/under total `T` and the de-vigged win probabilities,
   split the total by the favourite's edge:
   `sup = 2.2 × (P(home) − P(away))`, `λ_home = (T + sup)/2`, `λ_away = (T − sup)/2`.
2. **Blend in recent form** (FotMob xG from each club's last three competitive games, any
   competition): `λ = 0.55 × λ_market + 0.45 × xgPrior`, where
   `xgPrior_home = mean(home xG created, away xG conceded)`, mirrored for the away side.
3. **Conditions tilt** — altitude, heat, rest days; small and capped
   (`matchConditions()`). Mostly dormant for club football.
4. **Goals-bias calibration** — multiply by the factor learned from settled totals
   (`betlog.goalsBias()`).

**The known weakness.** Pre-match the model is *built from the market*, so it holds no
independent opinion, and a Poisson cannot represent an extreme favourite: a −1500 side
(90% implied) comes back at ~74%. That gap is arithmetic, not insight. Guard 2 below exists
because the engine used to bet it.

### National teams — the Elo prior (Nations League only)
A national team plays 4–6 competitive games a year, and League C/D games are priced thinly or
not at all. With no line the recipe above used to split 2.7 goals 50/50, so Spain v Gibraltar
and Gibraltar v Malta came out as the same game. For `nations: true` competitions,
`nationPrior()` builds a prior from the **World Football Elo ratings** (eloratings.net,
`eloratings.mjs`):

1. **Rating gap.** `dr = Elo_home − Elo_away + 100` (the site's own home bonus; 0 at a
   neutral venue). Elo's expected result is `E = 1 / (1 + 10^(−dr/400))`, where a draw counts
   as half a win.
2. **Gap → goals.** Find the supremacy `s` whose Poisson expected result `P(win) + P(draw)/2`
   (Dixon–Coles corrected, as above) equals `E`, by bisection. The total `T` is ESPN's
   over/under when posted, else 2.6. The weaker side's rate is
   `max(0.3, (T − s)/2)` and the stronger side's is that plus `s`. Past the 0.3 floor a
   mismatch scores more rather than re-splitting the same total. `s` is capped at 4.5 goals,
   which is reached near 800 points apart.
   Examples (2026-09-28): 100 points ≈ 0.6 goals, 300 ≈ 1.7, 500 ≈ 2.8.
3. **Form nudge.** Over each side's last six finished games (FotMob team page, any
   competition, **friendlies included** at half weight), take the goal difference minus the
   Elo-implied supremacy, cap each at ±3, and shrink:
   `form = Σ w·residual / (Σ w + 4)`, capped at ±0.5. Then `s' = s + (form_home − form_away)/2`.
   The nudge is small on purpose. Elo has already moved on those same results, and each
   residual also carries the opponent's own mis-rating.
4. **Blend.** Pre-match, with a market line: `λ = 0.75 × λ_market + 0.25 × λ_Elo`, basis
   "market + Elo". With no line, the Elo rates *are* the base (basis "Elo rating · no
   market"), and the pre-match read says it is display-only with nothing to judge it
   against. The xG form blend and calibration steps then apply as usual.

**None of these constants are fitted.** 0.25, 0.3, 4.5, the ±0.5 cap and the four phantom
games are stated guesses, and the frozen predictions grade them like every other call (the
basis string records which path made each one). For scale: Malta v Gibraltar came out
Elo 80/16/4 against ESPN's line 73/18/8. **The prior never reaches the card.**
`parlays.mjs` calls `scorePrediction` without it, so the card's picks, guards and number of
picks are unchanged. The Nations League card is empty today anyway: there is no Action
Network board. A missing rating (feed down, name not matched) leaves `rating` null and the
old path runs.

### Live — "run of play"
Trust the observed rate more as the game wears on: `w = min(1, elapsed / 70)`.

```
λ_remaining = w × (cumulativeXG / elapsed × minutesLeft)
            + (1 − w) × (AVG_TEAM × minutesLeft / 90)
```

`cumulativeXG` is real FotMob xG when available, else the shot proxy
`shotsOnTarget × 0.33 + otherShots × 0.04`.

### λ → outputs
`outcomeProbs()` sums the Poisson grid to 10 goals a side for win/draw/win, over 2.5
(`1 − PoissonCDF(2, λ_home + λ_away)`) and both-teams-to-score
(`(1 − e^−λ_home)(1 − e^−λ_away)`). The predicted scoreline is the rounded λ pair.

Before kickoff (0–0) a **Dixon–Coles low-score correction** applies (`ρ = −0.05`):
independent Poisson under-counts 0–0 and 1–1 and over-counts 1–0. Once goals are on the
board the in-play rates already carry that dependence, so the correction is dropped.

Knockout ties add a two-way **advance** probability — the draw is split toward the stronger
side to stand in for extra time and penalties.

---

## 2. Pre-match projections

`pregameProjections()` works from each club's recent competitive matches (`fotmobTeamRates`
over the last three games in **any** competition — league, cup, Europe; friendlies
skipped). Attack blends xG created with goals actually scored, defence blends xG and goals
conceded, so a side genuinely converting moves the estimate rather than just its chance
quality. Rates are regularised halfway toward a prior (`(v + prior)/2`; corners 5, shots
12, shots on target 4, xG 1.3) because three games is a small sample.

- **Shots / shots on target per side** = mean of own attacking rate and opponent's
  conceding rate.
- **Corners per side** = same construction; the total prices an over/under.
- **Keeper saves** = `max(0, expected shots on target faced − expected goals conceded)`.

Before this read from every competition, matchday one produced nothing at all — no form, no
projections, no scorer numbers, because no club had played in this competition yet.

---

## 3. Live projections blend pace with the prior

Corners and keeper saves were once pure extrapolation of the live rate, which produced 0.0
for a side with nothing yet after eight minutes and 9.5 for a keeper with one early save.
Both now blend in-game pace with the pre-match projection on a **30-minute half-life**:

```
weight(elapsed) = elapsed / (elapsed + 30)      # 10' → 25% pace, 45' → 60%, 90' → 75%
rate = weight × liveRate + (1 − weight) × priorTotal / FT
```

**Lines follow their projections.** No free feed carries a corners or keeper-saves market,
so pricing against a fixed 9.5 or 2.5 made the probability meaningless — every game read
"over 9.5". `centreLine(v) = floor(v) + 0.5` centres the line on the projection, so 10.3
projected corners prices *over 10.5 at 46%*, a real call.

---

## 4. Recommended bets (live) and pre-match picks

`bettingModel()` builds a **dominance index** — a weighted share of who is controlling play:

| Signal | Weight |
|---|---|
| xG (real FotMob, else proxy) | 40% |
| shots on target | 25% |
| total shots | 15% |
| possession | 10% |
| corners | 10% |

Leans are flagged where dominance diverges from the scoreline or the market price (a side
controlling ≥60% but not yet ahead). Each rec carries a tag: `Strong lean`, `Lean`,
`Low value`, `No edge`. Plus two signals:

- **Model gap** — model win% minus de-vigged market% ≥ 8 points, with a half-Kelly stake
  fraction capped at 5% of bankroll. Labelled divergence, not proven value.
- **Fade the public** — Action Network splits where the most-backed side's ticket share
  exceeds its money share by ≥8 points; lean where the money is.

Before kickoff `prematchPicks()` produces the same shape from the market-based prediction.
At full time these are replaced by a settled Result card.

**Odds display priority:** The Odds API live multi-book (key + quota) → FanDuel via Action
Network (de-vigged) → ESPN's inline pre-match line. Implied percentages are only shown when
all three 1X2 prices exist; a suspended side after a goal used to de-vig the remaining two
into a nonsense "72% draw".

---

## 5. The daily card (`parlays.mjs`)

Straight singles only, at most two per game. Parlays multiply the book's margin *and* every
model error, and same-game legs correlate in ways an independent multiply ignores — so the
tracked card is singles. A cross-game longshot is generated "for fun" and is never logged
or settled.

### Candidate legs
Priced against real book prices: moneyline, draw-no-bet, Asian handicap, match total, team
totals, both-teams-to-score, corners, anytime scorer.

### The edge band
| Constant | Value | Why |
|---|---|---|
| `EDGE_MIN` | 3% | below this there's no value worth the vig |
| `EDGE_MAX` | 7% | at or above, disagreement with a sharp book is almost certainly model error — the leg is **discarded, not bet** |
| `MAX_EDGE` | 5% | only shrinks the probability used for EV and Kelly |
| `DRAW_MIN_EDGE` | 5% | lets a genuine value draw back in despite not being the predicted result |

Selection lives entirely in the band. An earlier version ranked by edge and bet the biggest
disagreements first — i.e. it bet its own worst errors.

### Edge trust on derived markets
Over the World Cup's first 55 settled legs, Poisson-derived markets (totals, BTTS, corners)
hit 41% against a claimed 57%, while market-anchored moneyline probabilities ran honest. So
only a **learned fraction** of the model-vs-market disagreement is claimed on derived
markets (`betlog.edgeTrust()`, clamped `[0.2, 1]`, earned back automatically if edges start
landing). Moneyline and draw-no-bet are exempt — DNB is a renormalisation of the same
market-anchored win probabilities.

### The three guards (added 2026-09-09, after the first Champions League card)
1. **`LONGEST_PRICE = 5.0`** — nothing longer than +400. Long shots are where the
   favourite–longshot bias lives and where a Poisson tail masquerades as an edge.
2. **`MARKET_GAP = 0.08`** — if the market-built model's win/draw/win sits more than 8
   points from the de-vigged market on any side, **every leg of that game is skipped**. The
   model has failed to represent that price, so its "edge" is an artefact. This killed a
   +1300 Barcelona draw the engine had recommended off a −1500 favourite.
3. **Stale-line guard** — a ±0.5 handicap *is* the moneyline, so a line-shop price beating
   FanDuel's moneyline on the same outcome by more than 4 points is flagged stale rather
   than treated as value.

Guarded legs stay visible on the Builder board with the reason on the cell, and never
qualify. `generateDailyParlays()` also returns `notes`: one line per game saying why it did
or didn't make the card, so an empty card explains itself.

### Correlation guard
Markets sort into two **axes** — result (ML, DNB, spread) and goals (total, team total,
BTTS, corners). Within an axis every market re-expresses the same opinion, so the card
takes at most one leg per axis per game. Corners are benched from the card entirely (36%
hit against 60% claimed over n=11 at the World Cup); scorers are never bet.

---

## 6. The two scorecards

They answer different questions. Both live on the Record tab.

### The bet record (`betlog.mjs`)
Leg hit rate, Brier, profit, ROI, per-market calibration buckets, a **shadow-fade** check
(what flat-betting the *opposite* of every leg would have returned — a blunt test for
negative skill), projection accuracy, and **closing-line value**: the bet price against the
captured pre-kickoff close. CLV is knowable at kickoff, so it reads edge months before
results can.

### The model scorecard (`predictions.json`)
Every pre-match call frozen before kickoff and graded at full time: result-right rate,
exact-score rate, over-2.5 and BTTS call rates, and a 1X2 **Brier** score. Scorer
projections are logged the same way — the top six per side with their anytime-goal
percentages — graded from the finished game's shot map, giving a top-scorer hit rate and a
calibration check by band (do players given 20–40% actually score about 30% of the time?).

**The honest bar.** Bookmakers call the winner roughly 55% of the time in this competition.
A model showing 90% would mean a bug, not brilliance. Success looks like the 1X2 Brier
trending down toward ~0.55, the result rate above the book's, and CLV positive across
dozens of bets. Green ticks everywhere is a warning sign.

---

## 7. Deliberately display-only

- **Anytime scorers, shots on target.** Small samples, single-book prices, no free way to
  de-vig into a fair line, no closing line to check against.
- **Corners, keeper saves.** No book market in the free feeds, so the line is the model's
  own — there is nothing to beat.

These inform the eye. They never reach the card.

---

## 7b. What's at stake (Nations League groups)

Not a model: a count. `matchStakes()` takes a group's points, the games each team has played,
and the group games still to play (ESPN's league-phase fixtures). It enumerates every
win/draw/loss combination of the *other* remaining games, 3ⁿ of them. For each side and each
result of *this* game, it collects the final places still reachable **on points**. Level
points count as either order, because UEFA's head-to-head tie-breakers aren't modelled. The
places map to the tier's zones (`competition.mjs` → `leagues.<tier>.stakes`), and each side
gets its single sharpest true clause:

| Clause | Only said when |
|---|---|
| already certain of X | every result of every remaining game leaves the side in X |
| a draw is enough for X | a draw or a win lands in X, whatever else happens |
| a win secures X | a win lands in X, whatever else happens |
| a loss confirms Y | a loss lands in Y (its worst zone), whatever else happens |
| must win to keep X in reach | X is reachable after a win but not after a draw or a loss |
| a loss ends the hope of X | X is reachable after a win or draw, not after a loss |
| a win rules out Y | the worst zone Y is reachable after a draw or loss, not after a win |

"In reach" means reachable on points, possibly only through a tie-break. Nothing is said
when the table and the fixtures disagree: played + left ≠ games per team happens while ESPN
catches up after a final whistle. Nothing is said either with more than eight other group
games left, because nothing is ever settled that early. League A's 3rd and 4th depend on a
ranking across groups the table doesn't carry, so their names say so: "3rd (safe, or the
A/B play-off)".

---

## 8. Honest limitations

- Poisson treats goals as independent and ignores red cards, game state, fatigue and
  fixture congestion.
- **The market does nearly all the pre-match work.** The model's only additions are the
  form tilt and the public-money signal. National teams also get an Elo prior, which does
  the work when there is no line, and it isn't fitted either.
- Three games of form is a small sample; early-season projections are rough.
- FotMob, Action Network and FanDuel are unofficial endpoints read from public pages and
  can change shape without notice.

---

## 9. Next: replace the pre-match engine

The current pre-match model reshuffles the market's own prices, which is why its edges are
mostly rounding error and why the guards must catch them. The plan is a **Dixon–Coles fit**
on club match history with the closing line as a prior — club football provides the long,
dense history the World Cup never did. `predictions.json` is being collected as the
training and validation set for exactly that. Until it lands, a quiet card on a matchday is
the model being honest.
