// betlog — persists the daily parlays, auto-settles each leg from final scores, and tracks
// calibration. The per-leg model probabilities (not just parlay win/loss) are what "trains"
// the model: every leg is a probability-vs-outcome data point for the calibration loop.

import { summary, statMap, ml2prob, poissonCdf } from "./lib.mjs";
import { actionPublicBetting } from "./actionnetwork.mjs";
import { fanduelBTTS } from "./fanduel.mjs";
import { oddspapiBTTS, oddspapiSides } from "./oddspapi.mjs";
import { get as storeGet, set as storeSet } from "./store.mjs";

// the log is per competition, so a new tournament starts a clean record (its calibrations must not
// inherit another competition's biases). store.mjs keeps it in bets/<competition>/log.json on disk,
// or in Firestore when this runs as the Cloud Functions backend.
function read() { return storeGet("log", { days: [] }); }
function write(data) { storeSet("log", data); }

// append a day's bets (from generateDailyParlays). Only the straight SINGLES are tracked — the
// for-fun longshot is display-only and never logged, so the record/calibration reflect the real
// strategy. Idempotent per date — re-running the same morning replaces that date's entry.
export function recordDay(out) {
  const data = read();
  const parlays = [];
  for (const g of out.singles || []) if (g.bet) parlays.push({ type: "single", game: g.game, ...g.bet, settled: false, result: null });
  // recordDay only owns the auto SINGLES — keep any user-tracked builder parlays already logged for
  // this date so re-running the morning routine doesn't wipe a parlay the user built in the widget.
  const prior = (data.days || []).find((d) => d.date === out.date);
  const keptBuilders = (prior?.parlays || []).filter((p) => p.type === "builder");
  data.days = (data.days || []).filter((d) => d.date !== out.date);
  data.days.push({ date: out.date, stake: out.stake, parlays: [...parlays, ...keptBuilders] });
  data.days.sort((a, b) => a.date.localeCompare(b.date));
  write(data);
  return data;
}

// persist a user-built parlay from the widget's Parlay Builder so it settles + shows in the Record
// view exactly like the daily card. Appended to its slate `date` (preserving the auto singles and
// any other tracked parlays); re-tracking an identical leg set on the same date replaces it rather
// than duplicating. Legs carry the event `id` so settle() can grade them from the final summary.
//
// `real: true` marks a ticket the owner actually placed with their own money, as opposed to the
// model's paper card. The distinction is load-bearing, not cosmetic: a real ticket can hold legs
// the model never picked (its first one was five FanDuel scorer legs, a market this app labels
// display-only), and folding those into legHitRate / brier / fade / edgeTrust would have the model
// graded on somebody else's opinions. So every statistic that measures THE MODEL is computed over
// paper only, and real money gets its own tally — see stats() at the bottom of this file.
const amToDecimal = (ml) => (ml == null ? null : ml > 0 ? ml / 100 + 1 : 100 / -ml + 1);
const decToAmerican = (d) => (d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)));
export function trackParlay({ legs, stake = 10, date, real = false } = {}) {
  if (!Array.isArray(legs) || !legs.length || !date) return { error: "need legs + date" };
  const plLegs = legs.map((l) => ({
    id: l.id, game: l.game, market: l.market, pick: l.pick,
    modelProb: l.modelProb, ml: l.ml, edge: l.edge ?? null, rawEdge: l.rawEdge ?? null, why: l.why || null,
  }));
  const dec = legs.reduce((p, l) => p * (l.dec || amToDecimal(l.ml) || 1), 1);
  const modelProb = plLegs.reduce((p, l) => p * (l.modelProb ?? 1), 1);
  const payout = stake * dec;
  const ev = stake * (modelProb * dec - 1);
  const b = dec - 1;
  const kelly = b > 0 ? Math.min(0.05, Math.max(0, (b * modelProb - (1 - modelProb)) / b / 2)) : 0;
  const data = read();
  data.days = data.days || [];
  let day = data.days.find((d) => d.date === date);
  if (!day) { day = { date, stake, parlays: [] }; data.days.push(day); data.days.sort((a, b) => a.date.localeCompare(b.date)); }
  const sig = plLegs.map((l) => `${l.game}|${l.market}|${l.pick}`).sort().join("~");
  const games = [...new Set(plLegs.map((l) => l.game))];
  // replace an identical re-track - but a real ticket and a paper one with the same legs on the
  // same date are two different bets, so they never replace each other
  day.parlays = (day.parlays || []).filter((p) => !(p.type === "builder" && p._sig === sig && !!p.real === !!real));
  day.parlays.push({
    type: "builder", _sig: sig, real: !!real, game: games.length > 1 ? `${games.length} games` : games[0],
    legs: plLegs, dec, americanOdds: decToAmerican(dec), modelProb, stake, payout, ev, kelly,
    settled: false, result: null,
  });
  write(data);
  return { ok: true, date, real: !!real, legs: plLegs.length, dec, americanOdds: decToAmerican(dec), modelProb, payout, ev };
}

// grade a single leg against a final result { hs, as, hAbbr, aAbbr, corners }.
// Returns true (hit) / false (miss) / "push" (stake refunded — DNB draw, line landed exactly) /
// null (can't grade — e.g. player props, or corner data missing)
function gradeLeg(leg, f) {
  if (leg.market === "Moneyline") {
    const winner = f.hs > f.as ? f.hAbbr : f.as > f.hs ? f.aAbbr : "Draw";
    return leg.pick === winner;
  }
  if (leg.market === "DNB") {
    if (f.hs === f.as) return "push"; // draw refunds the stake
    const winner = f.hs > f.as ? f.hAbbr : f.aAbbr;
    return leg.pick.replace(/\s*DNB$/i, "") === winner;
  }
  if (leg.market === "TeamTotal") {
    const m = /^(\S+)\s+(Over|Under)\s+([\d.]+)/i.exec(leg.pick || "");
    if (!m) return null;
    const goals = m[1] === f.hAbbr ? f.hs : m[1] === f.aAbbr ? f.as : null;
    if (goals == null) return null;
    const L = parseFloat(m[3]);
    if (goals === L) return "push"; // we only bet half-lines, but grade integer lines safely
    return /over/i.test(m[2]) ? goals > L : goals < L;
  }
  if (leg.market === "Spread") {
    const m = /^(\S+)\s+([+-][\d.]+)/.exec(leg.pick || "");
    if (!m) return null;
    const own = m[1] === f.hAbbr ? f.hs : m[1] === f.aAbbr ? f.as : null;
    const opp = m[1] === f.hAbbr ? f.as : m[1] === f.aAbbr ? f.hs : null;
    if (own == null) return null;
    const adj = own + parseFloat(m[2]) - opp;
    if (adj === 0) return "push";
    return adj > 0;
  }
  if (leg.market === "Total") {
    const L = parseFloat(leg.pick.replace(/[^0-9.]/g, ""));
    const total = f.hs + f.as;
    return /over/i.test(leg.pick) ? total > L : total < L;
  }
  if (leg.market === "BTTS") {
    const both = f.hs >= 1 && f.as >= 1;
    return /yes/i.test(leg.pick) ? both : !both;
  }
  if (leg.market === "Corners") {
    if (f.corners == null) return null; // corner stats not available
    const L = parseFloat(leg.pick.replace(/[^0-9.]/g, ""));
    return /over/i.test(leg.pick) ? f.corners > L : f.corners < L;
  }
  if (leg.market === "Scorer") {
    // anytime-scorer: did the named player appear among the game's goal scorers? `f.scorers` is the
    // list of scorer names parsed from the summary's goal events (null = couldn't parse -> ungraded).
    if (f.scorers == null) return null;
    const nrm = (s) => (s || "").toLowerCase().replace(/[^a-z]/g, "");
    const lastTok = (s) => nrm((s || "").split(/\s+/).filter(Boolean).pop());
    const name = leg.pick.replace(/anytime/i, "").trim();
    const a = nrm(name), at = lastTok(name);
    if (!a) return null;
    return f.scorers.some((sc) => { const b = nrm(sc); return !!b && (a === b || a.includes(lastTok(sc)) || b.includes(at)); });
  }
  return null; // SOT / other player props still can't be graded from the team score
}

// settle every unsettled parlay whose games are final; grades each leg + the parlay
export async function settle() {
  const data = read();
  const cache = new Map();
  const finalOf = async (id) => {
    if (cache.has(id)) return cache.get(id);
    let res = null;
    try {
      const sum = await summary(id);
      const comp = sum.header?.competitions?.[0];
      if (comp?.status?.type?.completed) {
        const h = comp.competitors.find((c) => c.homeAway === "home");
        const a = comp.competitors.find((c) => c.homeAway === "away");
        // total corners from the box score (best-effort) so Corners legs can settle
        let corners = null;
        try {
          const teams = sum.boxscore?.teams || [];
          const hc = parseInt(statMap(teams.find((t) => t.team.id === h.team.id) || teams[0] || {}).wonCorners || 0, 10) || 0;
          const ac = parseInt(statMap(teams.find((t) => t.team.id === a.team.id) || teams[1] || {}).wonCorners || 0, 10) || 0;
          if (hc || ac) corners = hc + ac;
        } catch { /* no corner stats */ }
        // goal scorers (for anytime-scorer legs): names on goal keyEvents, excluding own goals. If
        // the game is final but no scorer names parse, distinguish a true 0-0 (empty list -> "no"
        // grades correctly) from a data gap on a game with goals (null -> leave the leg ungraded).
        let scorers = null;
        try {
          const names = [];
          for (const e of sum.keyEvents || []) {
            const t = (e.type?.text || "").toLowerCase();
            // ESPN labels a converted spot kick "Penalty - Scored", which does NOT contain "goal" —
            // so the old filter graded a player who scored ONLY from the spot as a miss. A missed or
            // saved penalty ("Penalty - Missed"/"Saved") must still not count, hence the "scored" test.
            const scored = (t.includes("goal") && !t.includes("own")) || (t.includes("penalt") && t.includes("scored"));
            if (!scored) continue; // own goals don't credit a scorer
            const who = (e.participants || [])[0]?.athlete?.displayName;
            if (who) names.push(who);
          }
          const totalGoals = Number(h.score) + Number(a.score);
          scorers = names.length ? names : totalGoals === 0 ? [] : null;
        } catch { scorers = null; }
        res = { hs: Number(h.score), as: Number(a.score), hAbbr: h.team.abbreviation, aAbbr: a.team.abbreviation, corners, scorers };
      }
    } catch { /* not final / fetch failed */ }
    cache.set(id, res);
    return res;
  };
  for (const day of data.days || []) {
    for (const p of day.parlays) {
      if (p.settled) continue;
      // settle only once EVERY leg is graded hit/miss/push. A leg that's final-but-ungradeable
      // (player prop with no scorer data, missing corner stats) keeps the whole parlay PENDING
      // rather than silently dropping it from the win test — which used to settle such parlays as
      // a false win. A PUSHED leg (DNB draw, line landed exactly) refunds: it drops out of the
      // payout multiplication; a parlay where every leg pushed settles as "push" (stake back).
      let allGraded = true, everyHit = true, anyPush = false, allPush = true;
      for (const leg of p.legs) {
        const f = await finalOf(leg.id);
        if (!f) { allGraded = false; continue; }
        const hit = gradeLeg(leg, f);
        leg.result = hit == null ? null : hit === "push" ? "push" : hit ? "hit" : "miss";
        leg.finalScore = `${f.hAbbr} ${f.hs}-${f.as} ${f.aAbbr}`;
        if (hit == null) allGraded = false;      // final but can't grade -> stay pending
        else if (hit === "push") anyPush = true;
        else { allPush = false; if (hit === false) everyHit = false; }
      }
      if (allGraded) {
        p.settled = true;
        p.result = !everyHit ? "loss" : allPush ? "push" : "win";
        if (p.result === "win" && anyPush) {
          const dec = p.legs.reduce((x, l) => x * (l.result === "push" ? 1 : (amToDecimal(l.ml) || 1)), 1);
          p.payout = p.stake * dec;
        }
      }
    }
  }
  write(data);
  return data;
}

// "Shadow fade" experiment — what flat-staking the OPPOSITE of every leg would have done.
// The fade of a leg wins exactly when the model's pick lost, so it's a pure re-grade of data we
// already have (no extra bets logged, no API calls). Two-way markets (Total/BTTS/Corners) have a
// clean opposite, so we estimate $ P/L by inverting the logged price across an assumed two-way
// overround. Moneyline is 3-way — "fade the draw/dog" isn't a single bet — so it counts toward the
// hit-rate read but NOT the $ estimate. Legs are deduped (a cross leg repeats its same-game leg).
const FADE_TWO_WAY = new Set(["Total", "BTTS", "Corners", "TeamTotal", "Spread", "DNB"]);
const FADE_VIG = 1.045;   // assumed two-way overround, for inverting the model-side price
const FADE_STAKE = 10;    // hypothetical flat stake per faded leg
function fadeStats(days, keep = () => true) {
  const seen = new Set();
  const legs = [];
  for (const d of days) for (const p of (d.parlays || []).filter(keep)) for (const l of p.legs || []) {
    if (l.result !== "hit" && l.result !== "miss") continue;
    const k = `${d.date}|${l.game}|${l.market}|${l.pick}`;
    if (seen.has(k)) continue;
    seen.add(k);
    legs.push(l);
  }
  const byMarket = {};
  let hit = 0, staked = 0, returned = 0, betLegs = 0;
  for (const l of legs) {
    const fadeHit = l.result === "miss"; // fading wins iff the model's pick missed
    if (fadeHit) hit++;
    const bm = (byMarket[l.market] ??= { n: 0, hit: 0 });
    bm.n++; if (fadeHit) bm.hit++;
    if (FADE_TWO_WAY.has(l.market) && l.ml != null) {
      const fadeImpl = Math.min(0.98, Math.max(0.02, FADE_VIG - ml2prob(l.ml)));
      staked += FADE_STAKE; betLegs++;
      if (fadeHit) returned += FADE_STAKE / fadeImpl;
    }
  }
  return {
    legs: legs.length,
    hit,
    hitRate: legs.length ? hit / legs.length : null,
    byMarket: Object.entries(byMarket).map(([market, b]) => ({ market, n: b.n, hitRate: b.hit / b.n })),
    betLegs, staked, returned, profit: returned - staked,
    roi: staked ? (returned - staked) / staked : null,
  };
}

// --- goal-expectation calibration (the fix for the systematic LOW-SCORING bias) ---
// The model prices a pregame Over/Under as a Poisson on the match total, so each settled Total
// leg's modelProb inverts cleanly back to the total-goals lambda the model used for that game.
// Averaging those lambdas vs the REAL total goals reveals whether the model's goal expectation
// runs low — it does, which is why it over-fires Unders / BTTS-No / value-Draws and the shadow
// fade beats it. The ratio (real / model) becomes a multiplier fed back into scorePrediction's
// pregame lambdas: shrunk toward 1.0 for small samples, capped so one hot/cold run can't run away,
// and self-correcting (if the model later over-shoots, the ratio drops below 1 and pulls it back).
const GB_SHRINK = 8;                 // pseudo-games pulling the factor toward 1.0
const GB_MIN = 0.85, GB_MAX = 1.30;  // hard caps on the multiplier
// invert a Total leg (pick + modelProb) back to the total-goals lambda the model priced it at.
// P(Under line) = P(total <= floor(line)) = poissonCdf(floor(line), lambda), monotone-decreasing
// in lambda, so a bisection recovers it.
function totalLegLambda(pick, modelProb) {
  const m = /(Over|Under)\s+([\d.]+)/i.exec(pick || "");
  if (!m || !(modelProb > 0 && modelProb < 1)) return null;
  const k = Math.floor(parseFloat(m[2]));
  const pUnder = /over/i.test(m[1]) ? 1 - modelProb : modelProb;
  let lo = 0.1, hi = 10;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (poissonCdf(k, mid) > pUnder) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
// the calibration multiplier from RECENT settled Total legs (one per game, deduped). Windowed to
// the last GB_WINDOW slates rather than all-time: knockout football scores differently from the
// group stage (cagier, draws protected), so an all-time factor learned on groups would lag the
// tournament's character — a rolling window keeps the correction current and stays self-correcting.
const GB_WINDOW = 10;
export function goalsBias() {
  const days = (read().days || []).slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, GB_WINDOW);
  const seen = new Set();
  let sumModel = 0, sumReal = 0, n = 0;
  for (const d of days) for (const p of d.parlays || []) for (const l of (p.real ? [] : p.legs) || []) {
    if (l.market !== "Total" || (l.result !== "hit" && l.result !== "miss")) continue;
    const key = `${d.date}|${l.game}`;
    if (seen.has(key)) continue;
    const lam = totalLegLambda(l.pick, l.modelProb);
    const sc = /(\d+)\s*-\s*(\d+)/.exec(l.finalScore || "");
    if (lam == null || !sc) continue;
    seen.add(key);
    sumModel += lam; sumReal += Number(sc[1]) + Number(sc[2]); n++;
  }
  if (!n || sumModel <= 0) return { factor: 1, n: 0, modelMean: null, realMean: null };
  const ratio = sumReal / sumModel;
  const shrunk = 1 + (ratio - 1) * (n / (n + GB_SHRINK));
  const factor = Math.min(GB_MAX, Math.max(GB_MIN, shrunk));
  return { factor, n, modelMean: sumModel / n, realMean: sumReal / n };
}

// --- learned edge-trust factor (replaces the hand-picked "trust half the edge" rule) ---
// How much of the model-vs-market disagreement on DERIVED markets (Total/BTTS/Corners/TeamTotal/
// Spread — everything Poisson-priced; DNB is market-anchored like ML and stays out) has been
// real? Regress outcomes on the claimed edge: hit ≈ implied + β·edge. β̂ = Σe·(hit−impl) / Σe²
// over settled derived legs. β=1 → edges fully real, β=0 → pure noise, β<0 → anti-signal.
// Shrunk toward 0.5 for small samples (same pattern as goalsBias), clamped to [0.2, 1.0] so the
// model always claims SOME edge on legs it selects but can never claim more than the raw number.
// Self-correcting: if the model's edges start landing, β rises and earns the trust back.
const TRUST_MARKETS = new Set(["Total", "BTTS", "Corners", "TeamTotal", "Spread"]);
const TRUST_SHRINK = 30;                 // pseudo-legs pulling β toward 0.5
const TRUST_MIN = 0.2, TRUST_MAX = 1.0;
export function edgeTrust() {
  const days = read().days || [];
  const seen = new Set();
  let num = 0, den = 0, n = 0;
  for (const d of days) for (const p of d.parlays || []) for (const l of (p.real ? [] : p.legs) || []) {
    if (!TRUST_MARKETS.has(l.market) || (l.result !== "hit" && l.result !== "miss")) continue;
    if (l.ml == null || l.edge == null || !l.edge) continue;
    const k = `${d.date}|${l.game}|${l.market}|${l.pick}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const impl = ml2prob(l.ml);
    const o = l.result === "hit" ? 1 : 0;
    num += l.edge * (o - impl);
    den += l.edge * l.edge;
    n++;
  }
  if (!n || den <= 0) return { trust: 0.5, beta: null, n: 0 };
  const beta = Math.max(0, Math.min(1.5, num / den));
  const shrunk = 0.5 + (beta - 0.5) * (n / (n + TRUST_SHRINK));
  return { trust: Math.min(TRUST_MAX, Math.max(TRUST_MIN, shrunk)), beta, n };
}

// --- closing line value (CLV) capture ---
// The fastest read on whether the model has real edge: compare the price we BET at to the price
// just before kickoff. Consistently beating the close = real edge, even through a losing run;
// consistently failing to = no hot streak should be trusted. Best-effort: the widget's poll loop
// calls this (throttled here), and for any pending leg whose game kicks off inside the window we
// snapshot the current FanDuel price for that market ONCE (closeMl) and never overwrite it.
// Corners/Scorer legs are skipped (no reliable free close source) — they just carry no CLV.
const CLV_EVERY_MS = 4 * 60 * 1000;         // at most one capture pass per ~poll window
const CLV_BEFORE = 45 * 60 * 1000;          // start snapshotting 45 min before kickoff
const CLV_AFTER = 30 * 60 * 1000;           // keep trying briefly after (late line reads)
let _clvLastRun = 0;
const _clvGame = new Map(); // event id -> { date, homeRef, awayRef } | null
export async function captureClosing() {
  const now = Date.now();
  if (now - _clvLastRun < CLV_EVERY_MS) return { skipped: true };
  _clvLastRun = now;
  const data = read();
  const byGame = new Map(); // event id -> pending legs still missing a close
  for (const day of data.days || []) for (const p of day.parlays || []) {
    if (p.settled) continue;
    for (const l of p.legs || []) {
      if (l.closeMl != null || l.id == null) continue;
      (byGame.get(l.id) || byGame.set(l.id, []).get(l.id)).push(l);
    }
  }
  if (!byGame.size) return { captured: 0 };
  let captured = 0;
  for (const [id, legs] of byGame) {
    let meta = _clvGame.get(id);
    if (meta === undefined) {
      try {
        const sum = await summary(id);
        const comp = sum.header?.competitions?.[0];
        const h = comp?.competitors?.find((c) => c.homeAway === "home");
        const a = comp?.competitors?.find((c) => c.homeAway === "away");
        meta = comp && h && a ? {
          date: new Date(comp.date).getTime(),
          homeRef: { name: h.team?.displayName, abbr: h.team?.abbreviation },
          awayRef: { name: a.team?.displayName, abbr: a.team?.abbreviation },
        } : null;
      } catch { meta = null; }
      _clvGame.set(id, meta);
    }
    if (!meta || now < meta.date - CLV_BEFORE || now > meta.date + CLV_AFTER) continue;
    const wantBTTS = legs.some((l) => l.market === "BTTS");
    const wantSides = legs.some((l) => l.market === "DNB" || l.market === "TeamTotal" || l.market === "Spread");
    // BTTS/DNB/TeamTotal/Spread closes from the SAME chain the bets were priced on (OddsPapi
    // primary, FanDuel fallback for BTTS) — the FanDuel public path alone stopped matching WC
    // games, which silently skipped BTTS closes. OddsPapi's 30-min odds cache is shared with the
    // parlay generator, so this costs ~no quota.
    const [pb, btts, sides] = await Promise.all([
      actionPublicBetting(meta.homeRef, meta.awayRef),
      wantBTTS ? oddspapiBTTS(meta.homeRef, meta.awayRef).then((r) => r || fanduelBTTS(meta.homeRef, meta.awayRef)).catch(() => null) : null,
      wantSides ? oddspapiSides(meta.homeRef, meta.awayRef).catch(() => null) : null,
    ]);
    const fd = pb?.fanduel;
    for (const l of legs) {
      let close = null;
      if (l.market === "Moneyline" && fd) {
        close = l.pick === "Draw" ? fd.draw?.ml
          : l.pick === meta.homeRef.abbr ? fd.home?.ml
          : l.pick === meta.awayRef.abbr ? fd.away?.ml : null;
      } else if (l.market === "Total" && fd?.total?.line != null) {
        // only comparable if the line hasn't moved — a different total is a different bet
        const L = parseFloat((l.pick.match(/[\d.]+/) || [])[0]);
        if (L === fd.total.line) close = /over/i.test(l.pick) ? fd.total.over : fd.total.under;
      } else if (l.market === "BTTS" && btts) {
        close = /yes/i.test(l.pick) ? btts.yes : btts.no;
      } else if (l.market === "DNB" && sides?.dnb) {
        const side = l.pick.replace(/\s*DNB$/i, "");
        close = side === meta.homeRef.abbr ? sides.dnb.home : side === meta.awayRef.abbr ? sides.dnb.away : null;
      } else if (l.market === "TeamTotal" && sides?.teamTotals) {
        // only comparable at the SAME line — a different team total is a different bet
        const m = /^(\S+)\s+(Over|Under)\s+([\d.]+)/i.exec(l.pick || "");
        if (m) {
          const list = m[1] === meta.homeRef.abbr ? sides.teamTotals.home : m[1] === meta.awayRef.abbr ? sides.teamTotals.away : [];
          const line = (list || []).find((x) => x.line === parseFloat(m[3]));
          if (line) close = /over/i.test(m[2]) ? line.over : line.under;
        }
      } else if (l.market === "Spread" && sides?.spreads) {
        // handicaps are quoted from the home side's perspective; an away pick at +1.5 lives on
        // the market whose (home) handicap is -1.5
        const m = /^(\S+)\s+([+-][\d.]+)/.exec(l.pick || "");
        if (m) {
          const v = parseFloat(m[2]);
          const isHome = m[1] === meta.homeRef.abbr;
          const row = sides.spreads.find((s) => s.hcap === (isHome ? v : -v));
          if (row) close = isHome ? row.home : row.away;
        }
      }
      if (close != null) { l.closeMl = close; l.closeAt = new Date(now).toISOString(); captured++; }
    }
  }
  if (captured) write(data);
  return { captured };
}

// calibration + performance over a given list of logged days, restricted to the parlays `keep`
// accepts (paper only, real only, or everything) - see stats()
function computeStats(days, keep = () => true) {
  const pool = (d) => (d.parlays || []).filter(keep);
  const legs = days.flatMap(pool).flatMap((p) => p.legs).filter((l) => l.result === "hit" || l.result === "miss");
  const buckets = Array.from({ length: 10 }, () => ({ n: 0, hit: 0, psum: 0 }));
  let brier = 0, hits = 0;
  for (const l of legs) {
    const o = l.result === "hit" ? 1 : 0;
    brier += (l.modelProb - o) ** 2;
    hits += o;
    const b = Math.min(9, Math.max(0, Math.floor(l.modelProb * 10)));
    buckets[b].n++; buckets[b].hit += o; buckets[b].psum += l.modelProb;
  }
  const settled = days.flatMap(pool).filter((p) => p.settled);
  let staked = 0, returned = 0, wins = 0;
  for (const p of settled) {
    staked += p.stake;
    if (p.result === "win") { returned += p.payout; wins++; }
    else if (p.result === "push") returned += p.stake; // refunded, not lost
  }
  // CLV: implied prob at close minus at bet — positive = we beat the close (got the longer price
  // on the same side). Counted for every leg with a captured close, settled or not: CLV is known
  // at kickoff, which is exactly why it reads edge faster than results do. Deduped like fadeStats.
  const clvSeen = new Set();
  let clvSum = 0, clvBeat = 0, clvN = 0;
  for (const d of days) for (const p of pool(d)) for (const l of p.legs || []) {
    if (l.closeMl == null || l.ml == null) continue;
    const k = `${d.date}|${l.game}|${l.market}|${l.pick}`;
    if (clvSeen.has(k)) continue;
    clvSeen.add(k);
    const c = ml2prob(l.closeMl) - ml2prob(l.ml);
    clvSum += c; if (c > 0) clvBeat++; clvN++;
  }
  return {
    clv: clvN ? { n: clvN, avgPts: clvSum / clvN, beatRate: clvBeat / clvN } : null,
    legs: legs.length,
    legHitRate: legs.length ? hits / legs.length : null,
    brier: legs.length ? brier / legs.length : null,
    calibration: buckets.map((b, i) => ({ bucket: `${i * 10}-${i * 10 + 10}%`, n: b.n, predicted: b.n ? b.psum / b.n : null, actual: b.n ? b.hit / b.n : null })).filter((b) => b.n > 0),
    parlays: settled.length, parlayWins: wins, staked, returned, profit: returned - staked,
    roi: staked ? (returned - staked) / staked : null,
    fade: fadeStats(days, keep),
  };
}

// paper vs real money. The TOP-LEVEL numbers are the PAPER card and nothing else, because every
// one of them is a claim about the model: legHitRate, brier, calibration, the shadow fade and CLV
// all only mean something over legs the model itself selected. `real` is the owner's own placed
// tickets, tallied separately, and `combined` is the two together for the bankroll view - money is
// money regardless of who picked it. Both are null until a real ticket exists, so a log with no
// real money reads exactly as it did before the split.
const isPaper = (p) => !p.real;
const isReal = (p) => !!p.real;
const anyReal = (days) => days.some((d) => (d.parlays || []).some(isReal));

// all-time calibration + performance across everything settled
export function stats() {
  const days = read().days || [];
  const real = anyReal(days);
  return {
    ...computeStats(days, isPaper),
    real: real ? computeStats(days, isReal) : null,
    combined: real ? computeStats(days) : null,
  };
}

// rolling window: stats over just the most recent `nDays` logged days, so a single old lucky
// hit stops skewing the picture as more data comes in. Includes the date range it covers.
export function statsRecent(nDays = 7) {
  const days = (read().days || []).slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, nDays);
  return { ...computeStats(days, isPaper), windowDays: days.length, from: days[days.length - 1]?.date || null, to: days[0]?.date || null };
}

export function readLog() { return read(); }
