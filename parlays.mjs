// parlays — daily $10 STRAIGHT-SINGLES generator for the FanDuel bankroll experiment.
//
// For each upcoming game it builds candidate legs (moneyline + total + corners + BTTS + scorer
// + DNB + team totals + Asian handicap) from the model's probabilities priced against real book
// odds, then bets up to TWO straight singles per game: the best in-band leg on the RESULT axis
// (ML/DNB/Spread) and on the GOALS axis (Total/TeamTotal/BTTS) — never a correlated pair.
// Singles are the tracked card: they let a real edge express itself instead of compounding the
// book's margin across correlated same-game legs. A single cross-game longshot (one leg per
// game) is still produced, but purely "for fun" — it is NOT logged or settled.
//
// WHY SINGLES: a 3-leg same-game parlay multiplies both the model's probabilities AND its errors,
// and the legs are correlated (Under + Draw + BTTS-No all die together when a game runs hot), so
// the parlay concentrates risk instead of spreading it. Singles fix the structurally-low hit rate.
//
// WHY THE EDGE BAND: every leg's edge is measured vs the real FanDuel price. Below EDGE_MIN there's
// no value; at/above EDGE_MAX the "edge" is almost certainly model error against a sharp market, so
// the leg is DISCARDED (the old model capped these and then bet them — and ranked by edge, so it
// picked the biggest model errors first). MAX_EDGE now only shrinks the prob used for EV/Kelly.

import { scoreboardOn, ymd, summary, scorePrediction, pregameProjections, matchConditions, poissonCdf } from "./lib.mjs";
import { COMP } from "./competition.mjs";
import { fotmobXG, fotmobPlayerSOT } from "./fotmob.mjs";
import { actionPublicBetting } from "./actionnetwork.mjs";
import { fanduelCorners, fanduelBTTS, fanduelProps } from "./fanduel.mjs";
import { oddspapiCorners, oddspapiBTTS, oddspapiSides } from "./oddspapi.mjs";

const amToDec = (ml) => (ml == null ? null : ml > 0 ? ml / 100 + 1 : 100 / -ml + 1);
const decToAm = (d) => (d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)));
const fmtAm = (ml) => (ml == null ? "-" : ml > 0 ? `+${ml}` : `${ml}`);
// believable BAND for a single leg's edge vs the real market price. Below EDGE_MIN there's no
// real value worth betting; at/above EDGE_MAX the disagreement with a sharp book is almost
// certainly model error, so the leg is discarded (NOT bet). Selection now lives entirely in this
// band — we no longer rank by edge and pick the biggest disagreement first.
const EDGE_MIN = 0.03;
const EDGE_MAX = 0.07;
// MAX_EDGE only shrinks the probability used for EV/Kelly so a wildly over-confident model number
// can't inflate the math. It no longer drives selection (the band does). Kept below EDGE_MAX so
// in-band legs near the top of the band still get a conservative prob.
const MAX_EDGE = 0.05;
// a Draw is allowed back into the card (even when it isn't the predicted result) only if its raw
// edge clears this — i.e. a real value draw, not every coin-flip. Must still pass the band above.
const DRAW_MIN_EDGE = 0.05;
// two guards learned from the first UCL card (2026-09-09):
//  · LONGEST_PRICE — never bet a leg longer than +400 (dec 5.0). Long shots are where the
//    favourite–longshot bias lives and where a Poisson tail masquerades as an edge.
//  · MARKET_GAP — pre-match the model is BUILT from the market (prices → goal rates → Poisson),
//    and a Poisson can't represent a heavy favourite (Barcelona -1500 came back as 74/14/12 vs
//    the market's 90/7/3). When the rebuilt 1X2 sits more than 8 points from the de-vigged
//    market on any side, every leg of that game is a modelling artefact, not information: skip.
const LONGEST_PRICE = 5.0;
const MARKET_GAP = 0.08;

// candidate legs for one event: each { game, market, pick, modelProb, ml, dec, impl, edge }
async function matchLegs(ev, goalsBias = 1, trust = 0.5) {
  const comp = ev.competitions[0];
  const h = comp.competitors.find((t) => t.homeAway === "home");
  const a = comp.competitors.find((t) => t.homeAway === "away");
  const homeRef = { name: h.team.displayName, abbr: h.team.abbreviation };
  const awayRef = { name: a.team.displayName, abbr: a.team.abbreviation };
  const game = `${h.team.abbreviation} v ${a.team.abbreviation}`;
  const sum = await summary(ev.id);
  const [publicBetting, priors, conditions] = await Promise.all([
    actionPublicBetting(homeRef, awayRef),
    pregameProjections(homeRef, awayRef),
    matchConditions(ev, homeRef, awayRef),
  ]);
  const pred = scorePrediction(ev, sum, null, null, priors?.xgPrior, conditions?.tilt, goalsBias);
  const fd = publicBetting?.fanduel;
  if (!pred || !fd) return null;
  // market-consistency guard (see MARKET_GAP): compare the model's 1X2 to the de-vigged book
  let guard = null;
  {
    const raw = [fd.home?.ml, fd.draw?.ml, fd.away?.ml].map((ml) => { const d = amToDec(ml); return d ? 1 / d : null; });
    if (raw.every((x) => x != null)) {
      const sum1 = raw[0] + raw[1] + raw[2];
      const mkt = raw.map((x) => x / sum1);
      const gap = Math.max(Math.abs(pred.wH - mkt[0]), Math.abs(pred.wD - mkt[1]), Math.abs(pred.wA - mkt[2]));
      if (gap > MARKET_GAP) guard = `model ${Math.round(gap * 100)} pts off the market — can't represent this price, skipped`;
    }
  }

  // the model's central prediction, used to tag each leg as coherent (agrees with the predicted
  // game script) or not. We never bet against our own prediction: no underdog ML, no Over when
  // the model leans Under, etc.
  const lamT = pred.expH + pred.expA;
  const mainLine = fd.total && fd.total.line != null ? fd.total.line : 2.5;
  const pOverMain = 1 - poissonCdf(Math.floor(mainLine), lamT);
  const mlFav = pred.wH >= pred.wD && pred.wH >= pred.wA ? h.team.abbreviation
    : pred.wA >= pred.wD ? a.team.abbreviation : "Draw";
  const totalFav = pOverMain >= 0.5 ? "Over" : "Under";
  const bttsFav = (pred.pBTTS ?? 0) >= 0.5 ? "Yes" : "No";

  // Action Network sharp signal: when the public is piling tickets on a side but the money lags
  // there (sharper/bigger bets lean elsewhere), that side is flagged `fade`. We won't bet a
  // moneyline the sharps are fading — using the splits we already fetch, not just the model.
  const fade = publicBetting?.fade; // { publicSide, sharpSide } | null
  const mlSideKey = (pick) => (pick === h.team.abbreviation ? "home" : pick === a.team.abbreviation ? "away" : "draw");
  const fadePublic = (pick) => !!(fade && mlSideKey(pick) === fade.publicSide);

  const cands = [];
  // push a candidate leg. `group` is what pickMix dedupes on (one per group). The edge is SHRUNK
  // toward the market at MAX_EDGE, and modelProb is the shrunk probability, so a wildly
  // over-confident model number can't inflate selection, EV, or Kelly. `coherent` marks whether
  // the leg agrees with the model's predicted script; `fadePublic` flags a side sharps are fading.
  const pushLeg = (market, pick, rawProb, ml, group, coherent, fade = false) => {
    const dec = amToDec(ml);
    if (dec == null || rawProb == null) return;
    const impl = 1 / dec;
    const rawEdge = rawProb - impl; // uncapped: this is what selection's band is judged on
    // derived-market probs (Poisson on the model's lambdas) ran ~15pts hot over the first 55
    // settled legs (hit 41% vs claimed 57% across Total/BTTS/Corners), while market-anchored
    // ML probs ran honest — so only a LEARNED fraction of the model-vs-market disagreement is
    // claimed on derived markets (betlog.edgeTrust: outcomes regressed on claimed edges, shrunk
    // toward 0.5, clamped [0.2, 1]). Selection still bands on rawEdge; this fixes the claimed
    // prob, EV, Kelly and the calibration data we log going forward, and earns trust back
    // automatically if the model's edges start landing.
    // DNB is a pure renormalisation of the same market-anchored win probs the ML legs use, so it
    // shares Moneyline's "honest" status; every Poisson-derived market gets the learned shrink.
    const honest = market === "Moneyline" || market === "DNB";
    const trusted = honest ? rawEdge : rawEdge * trust;
    const edge = Math.sign(trusted) * Math.min(Math.abs(trusted), MAX_EDGE); // capped, for EV/Kelly only
    const tooLong = dec > LONGEST_PRICE;
    cands.push({ id: ev.id, game, market, pick, group, modelProb: impl + edge, ml, dec, impl, edge, rawEdge, coherent, fadePublic: fade,
      guard: guard || (tooLong ? `longer than +${Math.round((LONGEST_PRICE - 1) * 100)} — long shots are never bet` : null) });
  };
  // a scorer candidate: priced at FanDuel's REAL anytime ML when the book posts one, else the
  // model's own FAIR price (dec = 1/scoreProb, edge 0, flagged `fair`). The fair case carries no
  // edge so it never qualifies for the tracked card (bettable needs a real edge) — it only enriches
  // the builder menu so the user can add a scorer the book hasn't priced and still see the model %.
  const pushScorer = (player, scoreProb, fdMl) => {
    if (!(scoreProb > 0 && scoreProb < 1)) return;
    const fair = fdMl == null;
    const dec = fair ? 1 / scoreProb : amToDec(fdMl);
    if (dec == null || dec <= 1) return;
    const ml = fair ? decToAm(dec) : fdMl;          // ml is display-only in the fair case
    const impl = 1 / dec;
    const rawEdge = scoreProb - impl;               // exactly 0 when fair
    const edge = Math.sign(rawEdge) * Math.min(Math.abs(rawEdge), MAX_EDGE);
    cands.push({ id: ev.id, game, market: "Scorer", pick: `${player} anytime`, group: "Scorer",
      modelProb: fair ? scoreProb : impl + edge, ml, dec, impl, edge, rawEdge, coherent: true, fadePublic: false, fair });
  };

  pushLeg("Moneyline", h.team.abbreviation, pred.wH, fd.home?.ml, "Moneyline", h.team.abbreviation === mlFav, fadePublic(h.team.abbreviation));
  pushLeg("Moneyline", "Draw", pred.wD, fd.draw?.ml, "Moneyline", mlFav === "Draw", fadePublic("Draw"));
  pushLeg("Moneyline", a.team.abbreviation, pred.wA, fd.away?.ml, "Moneyline", a.team.abbreviation === mlFav, fadePublic(a.team.abbreviation));
  // value-draw exception: a Draw isn't usually the predicted result, but if the model's draw
  // probability clears the price by a real margin, let it back in (underdog TEAM MLs stay out).
  const drawLeg = cands.find((l) => l.group === "Moneyline" && l.pick === "Draw");
  if (drawLeg && drawLeg.rawEdge >= DRAW_MIN_EDGE) drawLeg.coherent = true;
  if (fd.total && fd.total.line != null) {
    const L = fd.total.line, pOver = 1 - poissonCdf(Math.floor(L), lamT);
    pushLeg("Total", `Over ${L}`, pOver, fd.total.over, "Total", totalFav === "Over");
    pushLeg("Total", `Under ${L}`, 1 - pOver, fd.total.under, "Total", totalFav === "Under");
  }

  // anytime-scorer legs: the model's TOP 5 predicted scorers (opponent-adjusted xG -> anytime-goal
  // probability), priced against FanDuel's REAL anytime price where the book posts one, else at the
  // model's own fair price. Surfacing the top 5 lets the builder include scorers even when FanDuel
  // hasn't posted them; the fair-priced ones carry no edge so they never reach the tracked card
  // (bettable needs a real edge in the band) — only the FanDuel-matched ones can.
  try {
    const [hp, ap] = await Promise.all([fotmobPlayerSOT(homeRef, awayRef), fotmobPlayerSOT(awayRef, homeRef)]);
    const model = [...(hp || []), ...(ap || [])]
      .filter((p) => p && p.name && p.scoreProb > 0)
      .sort((x, y) => y.scoreProb - x.scoreProb)
      .slice(0, 5);
    if (model.length) {
      let fdScorers = [];
      try { fdScorers = (await fanduelProps(homeRef, awayRef))?.scorers || []; } catch { /* no book price posted */ }
      const nrm = (s) => (s || "").toLowerCase().replace(/[^a-z]/g, "");
      const lastTok = (s) => nrm((s || "").split(/\s+/).filter(Boolean).pop());
      const priceFor = (name) => {
        const hit = fdScorers.find((s) => {
          const a = nrm(name), b = nrm(s.player); if (!a || !b) return false;
          return a === b || a.includes(lastTok(s.player)) || b.includes(lastTok(name));
        });
        return hit && hit.ml != null ? hit.ml : null;
      };
      for (const p of model) pushScorer(p.name, p.scoreProb, priceFor(p.name));
    }
  } catch { /* no model scorers for this game — the builder just won't show scorer legs */ }

  // real total-corners line (OddsPapi multi-book, FanDuel public API as fallback) vs our
  // INDEPENDENT corner projection (recent form -> Poisson) — model-vs-market edge
  try {
    const fdc = (await oddspapiCorners(homeRef, awayRef)) || (await fanduelCorners(homeRef, awayRef));
    if (fdc && fdc.line != null && priors?.corners?.total != null) {
      const pOver = 1 - poissonCdf(Math.floor(fdc.line), priors.corners.total);
      pushLeg("Corners", `Over ${fdc.line}`, pOver, fdc.over, "Corners", pOver >= 0.5);
      pushLeg("Corners", `Under ${fdc.line}`, 1 - pOver, fdc.under, "Corners", pOver < 0.5);
    }
  } catch { /* no corner market posted — fine */ }

  // real both-teams-to-score price (OddsPapi multi-book, FanDuel fallback) vs the model's
  // INDEPENDENT pBTTS (P(home scores) x P(away scores))
  try {
    const btts = (await oddspapiBTTS(homeRef, awayRef)) || (await fanduelBTTS(homeRef, awayRef));
    if (btts && btts.yes != null && pred.pBTTS != null) {
      pushLeg("BTTS", "Yes", pred.pBTTS, btts.yes, "BTTS", bttsFav === "Yes");
      if (btts.no != null) pushLeg("BTTS", "No", 1 - pred.pBTTS, btts.no, "BTTS", bttsFav === "No");
    }
  } catch { /* no BTTS market — fine */ }

  // Draw No Bet / team totals / Asian handicap — markets the cached OddsPapi response already
  // carried but we previously threw away, priced at the best line across configured books.
  try {
    const ex = await oddspapiSides(homeRef, awayRef);
    if (ex) {
      // DNB: the model's win probs renormalised over "no draw" (a draw refunds the stake, so the
      // bet lives in the conditional space). Same market-anchored numbers as the ML legs.
      const pNoDraw = pred.wH + pred.wA;
      if (ex.dnb && pNoDraw > 0) {
        if (ex.dnb.home != null)
          pushLeg("DNB", `${h.team.abbreviation} DNB`, pred.wH / pNoDraw, ex.dnb.home, "DNB", h.team.abbreviation === mlFav, fadePublic(h.team.abbreviation));
        if (ex.dnb.away != null)
          pushLeg("DNB", `${a.team.abbreviation} DNB`, pred.wA / pNoDraw, ex.dnb.away, "DNB", a.team.abbreviation === mlFav, fadePublic(a.team.abbreviation));
      }
      // team totals: the most balanced posted line per side, priced off that side's own lambda —
      // isolates the half of the Poisson we trust more than the joint scoreline.
      const ttLeg = (side, lam, abbr) => {
        const posted = (ex.teamTotals?.[side] || []).filter((l) => l.line % 1 !== 0); // half-lines: no pushes
        if (!posted.length || !(lam > 0)) return;
        const bal = posted.slice().sort((x, y) => Math.abs(1 / amToDec(x.over) - 0.5) - Math.abs(1 / amToDec(y.over) - 0.5))[0];
        const pOver = 1 - poissonCdf(Math.floor(bal.line), lam);
        pushLeg("TeamTotal", `${abbr} Over ${bal.line}`, pOver, bal.over, `TT-${abbr}`, pOver >= 0.5);
        pushLeg("TeamTotal", `${abbr} Under ${bal.line}`, 1 - pOver, bal.under, `TT-${abbr}`, pOver < 0.5);
      };
      ttLeg("home", pred.expH, h.team.abbreviation);
      ttLeg("away", pred.expA, a.team.abbreviation);
      // Asian handicap (half-lines only, so no pushes): model prob from the Poisson margin
      // distribution. Handicaps are quoted from the home side's perspective; "home h" covers when
      // margin + h > 0. A side GETTING goals is also coherent on a predicted draw (it wins then).
      const pmf = (lam) => {
        const p = [Math.exp(-lam)];
        for (let k = 1; k <= 12; k++) p.push(p[k - 1] * lam / k);
        return p;
      };
      const pmH = pmf(pred.expH), pmA = pmf(pred.expA);
      const pMarginGT = (x) => { // P(homeGoals - awayGoals > x)
        let p = 0;
        for (let i = 0; i <= 12; i++) for (let j = 0; j <= 12; j++) if (i - j > x) p += pmH[i] * pmA[j];
        return p;
      };
      const fmtH = (v) => (v > 0 ? `+${v}` : `${v}`);
      // a ±0.5 handicap IS the moneyline: a line-shop price that beats FanDuel's ML on the same
      // outcome by more than a few cents is a stale line, not an edge (today's "ARS -0.5 at -125"
      // vs FanDuel Arsenal -165). Such legs stay on the menu but carry a guard.
      const impl = (ml) => { const d = amToDec(ml); return d ? 1 / d : null; };
      const stale = (spreadMl, fdMl) => { const a = impl(spreadMl), b = impl(fdMl); return a != null && b != null && b - a > 0.04; };
      for (const s of ex.spreads || []) {
        const pCover = pMarginGT(-s.hcap);
        const cohH = h.team.abbreviation === mlFav || (mlFav === "Draw" && s.hcap > 0);
        const cohA = a.team.abbreviation === mlFav || (mlFav === "Draw" && s.hcap < 0);
        const half = Math.abs(s.hcap) === 0.5;
        if (s.home != null) {
          const n = cands.length;
          pushLeg("Spread", `${h.team.abbreviation} ${fmtH(s.hcap)}`, pCover, s.home, "Spread", cohH, fadePublic(h.team.abbreviation));
          if (cands.length > n && half && s.hcap < 0 && stale(s.home, fd.home?.ml)) cands[n].guard = cands[n].guard || "line-shop price beats FanDuel's moneyline on the same outcome — stale line";
        }
        if (s.away != null) {
          const n = cands.length;
          pushLeg("Spread", `${a.team.abbreviation} ${fmtH(-s.hcap)}`, 1 - pCover, s.away, "Spread", cohA, fadePublic(a.team.abbreviation));
          if (cands.length > n && half && s.hcap > 0 && stale(s.away, fd.away?.ml)) cands[n].guard = cands[n].guard || "line-shop price beats FanDuel's moneyline on the same outcome — stale line";
        }
      }
    }
  } catch { /* no extra markets posted — fine */ }

  return { id: ev.id, game, date: ev.date, candidates: cands };
}

// is a leg worth betting at all? It must (a) AGREE with the model's predicted side (coherent),
// (b) NOT be a side the sharps are fading, and (c) sit inside the believable edge band — big
// disagreements (>= EDGE_MAX) are discarded as model error rather than bet as value.
// Corners are BENCHED from the tracked card (2026-07-01): 36% hit vs 60% claimed over n=11
// (Under went 1/6, −$37), and the projection rests on 1–2 games of form. They stay in the
// candidates so the builder menu still prices them; re-evaluate if projAccuracy tightens up.
function bettable(l) {
  return l.market !== "Corners" && !l.guard && l.coherent && !l.fadePublic && l.rawEdge >= EDGE_MIN && l.rawEdge < EDGE_MAX;
}

// correlation guard: at most TWO singles per game, and never a correlated pair. Markets sort
// into two axes — RESULT (who wins: ML/DNB/Spread) and GOALS (how many: Total/TeamTotal/BTTS/
// Corners). Within an axis every market re-expresses the same model opinion, so a second leg
// from the same axis would double-stake one opinion, not diversify; one leg per axis max.
const AXIS = { Moneyline: "result", DNB: "result", Spread: "result", Total: "goals", TeamTotal: "goals", BTTS: "goals", Corners: "goals" };

// the best bettable leg per axis for a game (each staked as its own straight single), ranked
// by hit probability within the axis. Scorer legs have no axis — never auto-bet (display-only).
function bestSingles(cands) {
  const best = {};
  for (const l of cands.filter(bettable)) {
    const ax = AXIS[l.market];
    if (!ax) continue;
    if (!best[ax] || l.modelProb > best[ax].modelProb) best[ax] = l;
  }
  return [best.result, best.goals].filter(Boolean);
}

// the longest-priced bettable leg for a game (for the for-fun cross-game longshot), or null
function longLeg(cands) {
  return cands.filter(bettable).sort((a, b) => b.dec - a.dec)[0] || null;
}

// plain-English reason a leg was chosen, from its market, pick and (capped) edge vs the price
function legReason(l) {
  const mp = Math.round(l.modelProb * 100), im = Math.round(l.impl * 100), e = Math.round(l.edge * 100);
  // a fair-priced scorer has no market to measure against — report the bare anytime-goal estimate
  if (l.group === "Scorer" && l.fair)
    return `model's opponent-adjusted xG — ${mp}% to score anytime (no book price posted; shown at fair odds)`;
  const tag =
    l.group === "Moneyline" ? (l.pick === "Draw" ? "value draw — model rates it well above the price" : "backing the model's projected winner")
    : l.group === "Total" ? (/under/i.test(l.pick) ? "model projects a low-scoring game" : "model projects an open, high-scoring game")
    : l.group === "Corners" ? (/under/i.test(l.pick) ? "model projects few corners" : "model projects plenty of corners")
    : l.group === "BTTS" ? (/yes/i.test(l.pick) ? "model expects both teams to score" : "model expects at least one clean sheet")
    : l.group === "Scorer" ? "model rates this scorer vs the book's anytime price (opponent-adjusted xG)"
    : l.market === "DNB" ? "backing the model's winner with draw insurance (stake back on a draw)"
    : l.market === "TeamTotal" ? (/under/i.test(l.pick) ? "model projects this side kept quiet" : "model projects this side to score freely")
    : l.market === "Spread" ? "model's margin distribution clears this handicap"
    : "positive-edge spot";
  return `${tag} — model ${mp}% vs market ${im}% (${e >= 0 ? "+" : ""}${e}% edge)`;
}

// roll legs into a parlay with model prob, payout, EV and a capped half-Kelly stake fraction
function buildParlay(legs, stake) {
  if (!legs.length) return null;
  const dec = legs.reduce((p, l) => p * l.dec, 1);
  const modelProb = legs.reduce((p, l) => p * l.modelProb, 1); // independence approximation
  const payout = stake * dec;
  const ev = stake * (modelProb * dec - 1);
  const b = dec - 1;
  const kelly = b > 0 ? Math.min(0.05, Math.max(0, (b * modelProb - (1 - modelProb)) / b / 2)) : 0;
  const rationale = legs.length > 1
    ? `${legs.length} positive-edge legs, each siding with the model; combined ${Math.round(modelProb * 100)}% to hit.`
    : `single positive-edge leg; ${Math.round(modelProb * 100)}% to hit.`;
  return {
    legs: legs.map((l) => ({ id: l.id, game: l.game, market: l.market, pick: l.pick, modelProb: l.modelProb, ml: l.ml, edge: l.edge, rawEdge: l.rawEdge, why: legReason(l) })),
    dec, americanOdds: decToAm(dec), modelProb, stake, payout, ev, kelly, rationale,
  };
}

// betting "day": a game that kicks off before BETTING_DAY_CUTOFF_HRS (local) belongs to the
// PREVIOUS calendar day's slate — e.g. a 12:00am Tue kickoff is bet as part of Monday's card.
// We shift the kickoff back by the cutoff, then take the local date.
const BETTING_DAY_CUTOFF_HRS = 6;
const localDay = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
};
const bettingDay = (d) => localDay(new Date(d).getTime() - BETTING_DAY_CUTOFF_HRS * 3600 * 1000);

// the day's card: one straight SINGLE per upcoming game (the best in-band leg), plus one for-fun
// cross-game longshot. The slate spans this calendar day plus tomorrow's post-midnight kickoffs
// (before the cutoff), so a "technically tomorrow" 12am game is bet today, not on tomorrow's card.
// `events` overrides the source (used for testing / a specific day's slate) — no day filter then.
export async function generateDailyParlays(stake = 10, events = null) {
  const slate = bettingDay(Date.now());
  let pool;
  if (events) {
    pool = events;
  } else {
    // today + tomorrow's boards so post-midnight games that belong to today's slate are visible
    const boards = await Promise.all([
      scoreboardOn(ymd(0)).catch(() => ({ events: [] })),
      scoreboardOn(ymd(1)).catch(() => ({ events: [] })),
    ]);
    const seen = new Set();
    pool = [];
    for (const b of boards) for (const e of b.events || []) {
      if (seen.has(e.id) || bettingDay(e.date) !== slate) continue;
      seen.add(e.id);
      pool.push(e);
    }
  }
  const upcoming = pool.filter((e) => e.competitions[0].status.type.state === "pre");
  // learned calibrations from the bet log: goal-expectation multiplier (low-scoring bias) +
  // edge-trust fraction (derived-market overconfidence). Lazy import to avoid a load-time cycle.
  const cal = await import("./betlog.mjs")
    .then((b) => ({ goalsBias: b.goalsBias().factor, trust: b.edgeTrust().trust }))
    .catch(() => ({ goalsBias: 1, trust: 0.5 }));
  const games = [], unpriced = [];
  for (const ev of upcoming) {
    const ml = await matchLegs(ev, cal.goalsBias, cal.trust).catch(() => null);
    if (ml && ml.candidates.length) games.push(ml);
    else unpriced.push(ev);
  }
  // PRIMARY (tracked): up to two straight singles per game — the best in-band leg on each of the
  // result and goals axes (never a correlated pair), each staked on its own so a real edge can
  // play out instead of compounding the book's margin across correlated legs.
  const singles = games.flatMap((g) =>
    bestSingles(g.candidates).map((l) => ({ game: g.game, date: g.date, bet: buildParlay([l], stake) })));
  // FOR FUN (NOT tracked / not logged): one cross-game longshot — the longest-priced in-band leg
  // per game, across DIFFERENT games so the legs are uncorrelated. Max payout, low hit rate.
  const longLegs = games.map((g) => longLeg(g.candidates)).filter(Boolean);
  const longshot = longLegs.length >= 2 ? buildParlay(longLegs, stake) : null;
  // why each game did or didn't make the card — so an empty card still explains itself
  const notes = games.map((g) => {
    const legs = g.candidates.filter((l) => l.market !== "Corners" && l.market !== "Scorer"); // neither is ever bet
    const bet = legs.filter(bettable);
    if (bet.length) return { game: g.game, ok: true, text: `${bet.length} leg${bet.length === 1 ? "" : "s"} in the band` };
    const guardAll = legs.length && legs.every((l) => l.guard) ? legs[0].guard : null;
    if (guardAll) return { game: g.game, ok: false, text: guardAll };
    const cands = legs.filter((l) => !l.guard && l.coherent && !l.fadePublic);
    const best = cands.sort((a, b) => b.rawEdge - a.rawEdge)[0];
    if (!best) return { game: g.game, ok: false, text: "every leg either fights the model's own script or sits where sharper money is fading" };
    const e = Math.round(best.rawEdge * 1000) / 10;
    return { game: g.game, ok: false, text: e >= EDGE_MAX * 100 ? `best edge ${best.pick} ${e >= 0 ? "+" : ""}${e}% is over the ${Math.round(EDGE_MAX * 100)}% ceiling — too good to be true`
      : `best edge ${best.market === "Moneyline" ? "" : best.market + " "}${best.pick} ${e >= 0 ? "+" : ""}${e}% is under the ${Math.round(EDGE_MIN * 100)}% floor` };
  });
  // games that never reached the model: no FanDuel 1X2 to judge it against. The prices come through
  // Action Network, which doesn't list every competition (none of the Nations League, checked
  // 2026-09-28) — without this line such a day's card was empty with no reason given
  for (const ev of unpriced) {
    const c = ev.competitions[0], ab = (side) => c.competitors.find((t) => t.homeAway === side)?.team.abbreviation;
    notes.push({ game: `${ab("home")} v ${ab("away")}`, ok: false, text: "not priced: no FanDuel 1X2 on Action Network's board to judge the model against (or no model call) — not bet" });
  }
  return { date: events ? bettingDay(events?.[0]?.date || Date.now()) : slate, stake, singles, longshot, notes };
}

// Parlay BUILDER feed: every upcoming game with its full set of priced candidate legs (all
// markets, the model's prob vs the real FanDuel price), so the widget can let the user assemble
// any parlay and see the model's grade. Unlike generateDailyParlays this does NOT filter to
// in-band/bettable legs — the whole point is to let the user pick any leg, even ones the model
// dislikes, and see what it thinks. Reuses matchLegs (same goal-expectation calibration) so the
// numbers line up exactly with the tracked card.
export async function parlayMenu(events = null) {
  const slate = bettingDay(Date.now());
  let pool;
  if (events) {
    pool = events;
  } else {
    const boards = await Promise.all([
      scoreboardOn(ymd(0)).catch(() => ({ events: [] })),
      scoreboardOn(ymd(1)).catch(() => ({ events: [] })),
    ]);
    const seen = new Set();
    pool = [];
    for (const b of boards) for (const e of b.events || []) {
      if (seen.has(e.id) || bettingDay(e.date) !== slate) continue;
      seen.add(e.id);
      pool.push(e);
    }
  }
  const upcoming = pool.filter((e) => e.competitions[0].status.type.state === "pre");
  const cal = await import("./betlog.mjs")
    .then((b) => ({ goalsBias: b.goalsBias().factor, trust: b.edgeTrust().trust }))
    .catch(() => ({ goalsBias: 1, trust: 0.5 }));
  const games = [];
  for (const ev of upcoming) {
    const ml = await matchLegs(ev, cal.goalsBias, cal.trust).catch(() => null);
    if (!ml || !ml.candidates.length) continue;
    games.push({
      id: ml.id,
      game: ml.game,
      date: ml.date,
      legs: ml.candidates.map((l) => ({
        id: l.id, game: l.game, market: l.market, pick: l.pick, group: l.group,
        modelProb: l.modelProb, ml: l.ml, dec: l.dec, impl: l.impl,
        edge: l.edge, rawEdge: l.rawEdge, coherent: l.coherent, fadePublic: l.fadePublic,
        fair: l.fair || false, guard: l.guard || null, why: legReason(l),
      })),
    });
  }
  // the calibrations ride along so the builder's lower third can show what shrinks the claims
  return { date: slate, games, goalsBias: cal.goalsBias, trust: cal.trust };
}

// grade an arbitrary set of builder-selected legs the same way buildParlay does (independence
// approximation across legs). Pure function over leg fields the menu already carries.
export function gradeParlay(legs, stake = 10) {
  if (!legs || !legs.length) return null;
  const dec = legs.reduce((p, l) => p * l.dec, 1);
  const modelProb = legs.reduce((p, l) => p * l.modelProb, 1);
  const impl = 1 / dec;                 // book's combined implied prob (vig included)
  const payout = stake * dec;
  const ev = stake * (modelProb * dec - 1);
  const edge = modelProb - impl;        // model prob minus the price's implied prob
  const b = dec - 1;
  const kelly = b > 0 ? Math.min(0.05, Math.max(0, (b * modelProb - (1 - modelProb)) / b / 2)) : 0;
  const fairDec = modelProb > 0 ? 1 / modelProb : null;
  return {
    dec, americanOdds: decToAm(dec), modelProb, impl, edge, payout, ev, kelly, stake,
    fairDec, fairAmerican: fairDec ? decToAm(fairDec) : null, legCount: legs.length,
  };
}

// a readable (ASCII-safe) text block for the morning routine / log
export function formatParlays(out) {
  const pct = (p) => `${Math.round(p * 100)}%`;
  const legLine = (l) => [
    `    - ${l.game} | ${l.market}: ${l.pick} (${fmtAm(l.ml)}, model ${pct(l.modelProb)}, edge ${l.edge >= 0 ? "+" : ""}${Math.round(l.edge * 100)}%)`,
    `        why: ${l.why}`,
  ].join("\n");
  const betBlock = (title, p) => {
    if (!p) return `${title}: (no qualifying bet)`;
    const k = p.kelly > 0.002 ? `Kelly ${(p.kelly * 100).toFixed(1)}% of bankroll` : "Kelly: skip (-EV)";
    return [
      `${title}  ${fmtAm(p.americanOdds)}  ($${p.stake} -> $${p.payout.toFixed(2)})`,
      ...p.legs.map(legLine),
      `    model ${pct(p.modelProb)} to hit | model EV ${p.ev >= 0 ? "+" : ""}$${p.ev.toFixed(2)} | ${k}`,
    ].join("\n");
  };
  const lines = [`${COMP.name} singles | ${out.date} | $${out.stake} each`, ""];
  if (!out.singles.length) lines.push("(no qualifying single-leg bets on this slate)", "");
  for (const g of out.singles) lines.push(betBlock(`> ${g.game}`, g.bet), "");
  if (out.longshot) lines.push("--- for fun (not tracked) ---", "", betBlock("> LONGSHOT (one leg per game, max payout)", out.longshot));
  return lines.join("\n");
}
