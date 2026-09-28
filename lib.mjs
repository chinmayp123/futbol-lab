// lib — shared data + model layer for Futbol Lab (the competition comes from competition.mjs).
// Both the CLI (cli.mjs) and the desktop widget (widget/) import from here, so the
// fetching, odds, predictions, keeper-saves model, and betting reads live in ONE place.
// Everything here returns plain data — no terminal ANSI, no DOM — so any front end can use it.

import { get as storeGet, set as storeSet } from "./store.mjs";
import { fotmobXG, fotmobTeamRates, fetchFotmobFixtures, fotmobPlayerSOT, fotmobMatchday, fotmobPitch, fotmobRecentForm } from "./fotmob.mjs";
import { actionPublicBetting } from "./actionnetwork.mjs";
import { fanduelProps } from "./fanduel.mjs";
import { COMP, isPhaseSlug, compMeta, clubLeague, groupRules, readConfig } from "./competition.mjs";
import { teamMatch } from "./teams.mjs";

// every competition-specific id lives in competition.mjs — repoint the tool there, not here
export const BASE = `https://site.api.espn.com/apis/site/v2/sports/soccer/${COMP.espn}`;
const STANDINGS_URL = `https://site.api.espn.com/apis/v2/sports/soccer/${COMP.espn}/standings`;
const SPORT_BASE = `https://api.the-odds-api.com/v4/sports/${COMP.oddsApiSport}`;
const ODDS_BASE = `${SPORT_BASE}/odds`;

// Optional live-odds key (The Odds API). Read from env or a gitignored config file next to
// this module — never hard-coded, so the public repo stays clean.
function loadOddsKey() {
  if (process.env.ODDS_API_KEY) return process.env.ODDS_API_KEY.trim();
  return (readConfig().oddsApiKey || "").trim() || null;
}
export const ODDS_KEY = loadOddsKey();

export async function getJSON(url) {
  const res = await fetch(url, { headers: { "User-Agent": "futbol-lab" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

export const scoreboard = () => getJSON(`${BASE}/scoreboard`);
export const scoreboardOn = (yyyymmdd) => getJSON(`${BASE}/scoreboard?dates=${yyyymmdd}`);
// one call for a whole date span (ESPN accepts YYYYMMDD-YYYYMMDD) — cheaper than a fetch per day
// when the picker window spans weeks between matchdays. On 2026-09-28 ESPN started answering every
// ranged query with a 400 (every league, past spans too) while whole months (dates=YYYYMM) still
// worked — so a failed range falls back to the months it spans, trimmed to the span, and skips the
// ranged call for an hour rather than paying a dead request on every pass.
let rangeDownUntil = 0;
export async function scoreboardRange(from, to) {
  let err = null;
  if (Date.now() >= rangeDownUntil) {
    try { return await getJSON(`${BASE}/scoreboard?dates=${from}-${to}&limit=300`); } catch (e) { err = e; rangeDownUntil = Date.now() + 3600e3; }
  }
  const months = [];
  for (let y = +from.slice(0, 4), m = +from.slice(4, 6); y * 100 + m <= +to.slice(0, 6); m === 12 ? (y++, m = 1) : m++) months.push(`${y}${String(m).padStart(2, "0")}`);
  const boards = await Promise.all(months.map((mo) => getJSON(`${BASE}/scoreboard?dates=${mo}&limit=300`).catch(() => null)));
  if (!boards.some(Boolean)) throw err || new Error(`ESPN scoreboard unreachable for ${from}-${to}`);
  const day = (iso) => iso.slice(0, 10).replace(/-/g, "");
  const events = boards.flatMap((b) => b?.events || []).filter((ev) => day(ev.date) >= from && day(ev.date) <= to);
  return { ...boards.find(Boolean), events };
}
export const summary = (id) => getJSON(`${BASE}/summary?event=${id}`);
export const allStandings = () => getJSON(STANDINGS_URL);

// YYYYMMDD for `daysAhead` days from today
export function ymd(daysAhead = 0) {
  const d = new Date(Date.now() + daysAhead * 86400000);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

// implied win % for each outcome, vig-stripped to sum to 100 (ESPN pickcenter shape)
export function impliedProbs(odds) {
  if (!odds || odds.homeTeamOdds?.moneyLine == null) return null;
  const ml2p = (ml) => (ml == null ? 0 : ml > 0 ? 100 / (ml + 100) : -ml / (-ml + 100));
  const raw = [ml2p(odds.homeTeamOdds.moneyLine), ml2p(odds.drawOdds?.moneyLine), ml2p(odds.awayTeamOdds?.moneyLine)];
  const sum = raw.reduce((a, b) => a + b, 0) || 1;
  return raw.map((p) => Math.round((p / sum) * 100));
}

export const ml2prob = (ml) => (ml == null ? null : ml > 0 ? 100 / (ml + 100) : -ml / (-ml + 100));
export const fmtAmerican = (ml) => (ml == null ? "-" : ml > 0 ? `+${ml}` : `${ml}`);

// --- The Odds API: live multi-book odds (FanDuel + best-of-book line shopping) ---
// The ONE feed that costs anything: 500 credits a month on the free tier, and the key is SHARED with
// Pick Six. The widget polls every 30s, and with a 2-minute cache an open widget spent ~120 credits an
// hour (2 for the events list + 2 for the tracked game's props every 2 minutes) — that is what emptied
// the month on 2026-09-08, not the morning card, which never touches this API. Lines do not move that
// fast: before kickoff 30 min, in play 5 min, and a finished game never again. An exhausted quota (or
// a refused key) is remembered for the process, so nothing further is spent on it.
export const oddsState = { remaining: null, exhausted: false, error: null };
const ODDS_TTL = { pre: 30 * 60e3, in: 5 * 60e3, post: 6 * 3600e3 };
export const oddsTtlFor = (state) => ODDS_TTL[state] ?? ODDS_TTL.pre;
async function oddsRefused(res) {
  let msg = ""; try { msg = (await res.json())?.message || ""; } catch { /* no body */ }
  oddsState.error = `Odds API HTTP ${res.status}` + (msg ? " — " + msg : "");
  // a spent free key answers 401 "API key is not valid"; a real quota message is 401/429 too
  if (res.status === 401 || res.status === 429) oddsState.exhausted = true;
  return new Error(oddsState.error);
}
let _oddsCache = { at: 0, events: null };
export async function fetchOddsEvents(ttl = ODDS_TTL.pre) {
  if (!ODDS_KEY) return null;
  const now = Date.now();
  if (_oddsCache.events && now - _oddsCache.at < ttl) return _oddsCache.events;
  if (oddsState.exhausted) return _oddsCache.events; // whatever we last saw, or null
  const url = `${ODDS_BASE}/?apiKey=${ODDS_KEY}&regions=us&markets=h2h,totals&oddsFormat=american`;
  const res = await fetch(url, { headers: { "User-Agent": "futbol-lab" } });
  if (!res.ok) throw await oddsRefused(res);
  _oddsCache = { at: now, events: await res.json() };
  oddsState.remaining = res.headers.get("x-requests-remaining");
  return _oddsCache.events;
}

// --- player props (The Odds API per-event endpoint) ---
// Real book markets, de-vigged. No saves/corners market exists for soccer; the props that
// DO exist are goal-scorer, shots, shots-on-target, assists, cards. We pull scorer + SoT.
// Cached per event (2 min) to respect the free-tier quota. Player props may require a paid
// plan — on a free key the request can 401/422, which we swallow (section just stays empty).
const PROP_MARKETS = "player_goal_scorer_anytime,player_shots_on_target";
const _propCache = new Map(); // oddsEventId -> { at, data }
const bestPrice = (arr) => arr.reduce((b, x) => (b == null || x.price > b.price ? x : b), null);
// the book the user actually bets on — shown first; others only flagged when they beat it
export const PRIMARY_BOOK = "fanduel";

// pick the primary book's price for a side, plus the best elsewhere and whether it beats primary
function priceView(side) {
  const fd = side.find((x) => x.book === PRIMARY_BOOK);
  const best = bestPrice(side);
  return {
    primary: fd ? fmtAmerican(fd.price) : null,
    primaryRaw: fd ? fd.price : null,
    best: best ? fmtAmerican(best.price) : null,
    bestBook: best?.book || null,
    bestRaw: best ? best.price : null,
    beats: best && fd ? best.price > fd.price : !!best && !fd, // another book wins (or FD absent)
    implied: fd ? ml2prob(fd.price) : best ? ml2prob(best.price) : null,
  };
}

// fair probability of side A, by de-vigging each book's two-sided price then averaging
function devigPair(sideA, sideB) {
  const mapB = new Map(sideB.map((x) => [x.book, x.price]));
  const probs = [];
  for (const a of sideA) {
    const bp = mapB.get(a.book);
    if (bp == null) continue;
    const pa = ml2prob(a.price), pb = ml2prob(bp);
    if (pa == null || pb == null) continue;
    probs.push(pa / (pa + pb)); // multiplicative de-vig
  }
  return probs.length ? probs.reduce((x, y) => x + y, 0) / probs.length : null;
}

function parsePlayerProps(ev) {
  if (!ev || !ev.bookmakers) return { scorers: [], sot: [] };
  const scorerAgg = new Map();  // player -> { player, yes:[], no:[] }
  const sotAgg = new Map();     // `player|line` -> { player, line, over:[], under:[] }
  for (const bk of ev.bookmakers) {
    for (const mk of bk.markets || []) {
      if (mk.key === "player_goal_scorer_anytime") {
        for (const o of mk.outcomes || []) {
          const p = o.description || o.name;
          if (!p) continue;
          const rec = scorerAgg.get(p) || { player: p, yes: [], no: [] };
          rec[/^no$/i.test(o.name) ? "no" : "yes"].push({ book: bk.key, price: o.price });
          scorerAgg.set(p, rec);
        }
      } else if (mk.key === "player_shots_on_target") {
        for (const o of mk.outcomes || []) {
          const p = o.description;
          if (!p) continue;
          const key = `${p}|${o.point}`;
          const rec = sotAgg.get(key) || { player: p, line: o.point, over: [], under: [] };
          rec[/under/i.test(o.name) ? "under" : "over"].push({ book: bk.key, price: o.price });
          sotAgg.set(key, rec);
        }
      }
    }
  }
  const scorers = [...scorerAgg.values()]
    .map((r) => ({ player: r.player, prob: devigPair(r.yes, r.no), price: priceView(r.yes), twoSided: r.no.length > 0 }))
    .filter((s) => s.price.primary || s.price.best)
    .sort((a, b) => (b.prob ?? b.price.implied ?? 0) - (a.prob ?? a.price.implied ?? 0))
    .slice(0, 6);
  const sot = [...sotAgg.values()]
    .map((r) => ({ player: r.player, line: r.line, fairOver: devigPair(r.over, r.under), price: priceView(r.over) }))
    .filter((s) => (s.price.primary || s.price.best) && s.fairOver != null)
    .sort((a, b) => b.fairOver - a.fairOver)
    .slice(0, 6);
  return { scorers, sot };
}

export async function fetchPlayerProps(oddsEventId, ttl = ODDS_TTL.pre) {
  if (!ODDS_KEY || !oddsEventId) return null;
  const now = Date.now();
  const hit = _propCache.get(oddsEventId);
  if (hit && now - hit.at < ttl) return hit.data;
  if (oddsState.exhausted) return hit ? hit.data : null;
  const url = `${SPORT_BASE}/events/${oddsEventId}/odds?apiKey=${ODDS_KEY}&regions=us&markets=${PROP_MARKETS}&oddsFormat=american`;
  const res = await fetch(url, { headers: { "User-Agent": "futbol-lab" } });
  if (!res.ok) throw await oddsRefused(res);
  oddsState.remaining = res.headers.get("x-requests-remaining");
  const data = parsePlayerProps(await res.json());
  _propCache.set(oddsEventId, { at: now, data });
  return data;
}

// strict club match (teams.mjs) — see the note there on why substrings were a bug
export const teamsMatch = (a, b) => teamMatch(a, b);

// find the odds-API event matching an ESPN match, build a per-outcome book comparison
export function matchOdds(events, homeName, awayName) {
  if (!events) return null;
  const ev = events.find(
    (e) =>
      (teamsMatch(e.home_team, homeName) && teamsMatch(e.away_team, awayName)) ||
      (teamsMatch(e.home_team, awayName) && teamsMatch(e.away_team, homeName))
  );
  if (!ev) return null;
  const outcomes = { home: [], draw: [], away: [] };
  for (const bk of ev.bookmakers || []) {
    const m = (bk.markets || []).find((mk) => mk.key === "h2h");
    if (!m) continue;
    for (const o of m.outcomes || []) {
      const slot = teamsMatch(o.name, ev.home_team) ? "home"
        : teamsMatch(o.name, ev.away_team) ? "away"
        : /draw/i.test(o.name) ? "draw" : null;
      if (slot) outcomes[slot].push({ book: bk.key, price: o.price });
    }
  }
  const book = (slot, key) => outcomes[slot].find((x) => x.book === key);
  const best = (slot) => outcomes[slot].reduce((b, x) => (b == null || x.price > b.price ? x : b), null);
  const live = new Date(ev.commence_time).getTime() < Date.now();
  return { ev, outcomes, book, best, live, swapped: teamsMatch(ev.away_team, homeName) };
}

export function findEvent(events, query) {
  const q = String(query).toLowerCase();
  return events.find((ev) =>
    ev.id === query ||
    ev.competitions[0].competitors.some(
      (t) =>
        t.team.displayName.toLowerCase().includes(q) ||
        (t.team.abbreviation || "").toLowerCase() === q
    )
  );
}

export const statMap = (team) =>
  Object.fromEntries((team.statistics || []).map((s) => [s.name, s.displayValue]));

// --- math helpers for the model ---
export function poissonCdf(k, lambda) {
  if (k < 0) return 0;
  let term = Math.exp(-lambda), sum = term;
  for (let i = 1; i <= k; i++) { term *= lambda / i; sum += term; }
  return sum;
}
export function poissonPmf(k, lambda) {
  if (k < 0) return 0;
  let t = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) t *= lambda / i;
  return t;
}
export function probToAmerican(p) {
  if (!(p > 0) || p >= 1) return null;
  return p > 0.5 ? Math.round((-p / (1 - p)) * 100) : Math.round(((1 - p) / p) * 100);
}
export function matchMinute(st) {
  if (st?.type?.name === "STATUS_HALFTIME") return 45;
  if (st?.type?.state === "post") return 90;
  if (st?.type?.state !== "in") return null;
  const m = /(\d+)/.exec(st.displayClock || st.type?.shortDetail || "");
  return m ? Number(m[1]) : null;
}

// live pace vs pre-match prior: how much to believe the in-game rate after `elapsed` minutes.
// A 30-minute half-life — 10' in the prior carries 75%, at half time it's 40%, at 90' 25% — so
// a keeper with 0 saves after 8 minutes projects near his pre-match number, not 0.0.
const paceWeight = (elapsed) => elapsed / (elapsed + 30);
const blendRate = (liveRate, priorTotal, elapsed, FT) => {
  if (priorTotal == null || !(priorTotal >= 0)) return liveRate;
  const w = paceWeight(elapsed);
  return w * liveRate + (1 - w) * (priorTotal / FT);
};

// model-derived saves line for a keeper (no book offers this market — model estimate only).
// `prior` = the pre-match projected full-match saves for this keeper, when we have one.
export function keeperSaveLine(saves, minute, state, line = null, prior = null) {
  const FT = 95;
  if (state === "post") { const l = line ?? centreLine(saves); return { proj: saves, settled: true, over: saves > l, line: l }; }
  if (minute == null) return null;
  const elapsed = Math.max(minute, 10);
  const rate = blendRate(saves / elapsed, prior, elapsed, FT);
  const remMin = Math.max(0, FT - minute);
  const lambdaRem = rate * remMin;
  const proj = saves + lambdaRem;
  if (line == null) line = centreLine(proj);   // no book offers keeper saves — centre on the projection
  const need = Math.ceil(line) - saves;
  const pOver = need <= 0 ? 1 : 1 - poissonCdf(need - 1, lambdaRem);
  return { proj, lambdaRem, pOver, need, line, settled: false };
}

// a half-goal line centred on a projection, so the O/U it prices is actually a close call.
// Fixed lines made the read useless: every game showed "over 9.5" whatever the projection, and a
// keeper projected 6.8 saves showed "over 2.5 · 98%" — true, and worth nothing.
export const centreLine = (v) => Math.max(0.5, Math.floor(Number(v) || 0) + 0.5);

// model-derived corners line per side + total O/U. Corners per side ARE real live data
// (ESPN box score); there's no corners betting market in the feed, so the O/U is a model
// estimate. Extrapolate each side's corner rate to full time; price the total via Poisson.
// `prior` = { home, away } pre-match projected corners per side, when we have them.
export function cornersModel(hC, aC, minute, state, line = null, prior = null) {
  const FT = 95;
  if (state === "post") { const total = hC + aC; const l = line ?? centreLine(total); return { settled: true, home: hC, away: aC, total, over: total > l, line: l }; }
  if (minute == null) return null; // pre-match: no corners yet
  const elapsed = Math.max(minute, 10);
  const remMin = Math.max(0, FT - minute);
  const rateH = blendRate(hC / elapsed, prior?.home, elapsed, FT);
  const rateA = blendRate(aC / elapsed, prior?.away, elapsed, FT);
  const projH = hC + rateH * remMin;
  const projA = aC + rateA * remMin;
  const lambdaRemTotal = (rateH + rateA) * remMin;
  // no book corners market in the free feeds, so the line follows the projection
  if (line == null) line = centreLine(projH + projA);
  const need = Math.ceil(line) - (hC + aC);
  const pOver = need <= 0 ? 1 : 1 - poissonCdf(need - 1, lambdaRemTotal);
  return { settled: false, home: hC, away: aC, projH, projA, totalProj: projH + projA, pOver, need, line, odds: probToAmerican(pOver) };
}

// Dixon–Coles low-score dependence correction (rho ≈ -0.05): independent Poisson under-counts
// 0-0/1-1 draws and over-counts 1-0/0-1. Applied only pre-kickoff (0-0), where it's the proper
// full-match scoreline; once goals are in, the in-play rates already carry the dependence.
const DC_RHO = -0.05;
function dcTau(fh, fa, lamH, lamA) {
  if (fh === 0 && fa === 0) return 1 - lamH * lamA * DC_RHO;
  if (fh === 0 && fa === 1) return 1 + lamH * DC_RHO;
  if (fh === 1 && fa === 0) return 1 + lamA * DC_RHO;
  if (fh === 1 && fa === 1) return 1 - DC_RHO;
  return 1;
}
export function outcomeProbs(remLamH, remLamA, hScore, aScore) {
  const pre = hScore === 0 && aScore === 0;
  let pH = 0, pD = 0, pA = 0;
  for (let i = 0; i <= 10; i++)
    for (let j = 0; j <= 10; j++) {
      let p = poissonPmf(i, remLamH) * poissonPmf(j, remLamA);
      const fh = hScore + i, fa = aScore + j;
      if (pre) p *= dcTau(fh, fa, remLamH, remLamA);
      if (fh > fa) pH += p; else if (fh < fa) pA += p; else pD += p;
    }
  const s = pH + pD + pA || 1;
  return [pH / s, pD / s, pA / s];
}

export function impliedFromOdds(sum, liveOdds) {
  if (liveOdds) {
    const sH = liveOdds.swapped ? "away" : "home", sA = liveOdds.swapped ? "home" : "away";
    const price = (slot) => liveOdds.book(slot, "fanduel")?.price;
    const raw = [price(sH), price("draw"), price(sA)].map(ml2prob);
    if (raw[0] != null) { const s = raw.reduce((a, b) => a + (b || 0), 0) || 1; return raw.map((p) => (p || 0) / s); }
  }
  const odds = (sum.pickcenter || sum.odds || [])[0];
  if (odds && odds.homeTeamOdds?.moneyLine != null) {
    const raw = [ml2prob(odds.homeTeamOdds.moneyLine), ml2prob(odds.drawOdds?.moneyLine), ml2prob(odds.awayTeamOdds?.moneyLine)];
    const s = raw.reduce((a, b) => a + (b || 0), 0) || 1;
    return raw.map((p) => (p || 0) / s);
  }
  return null;
}

// --- venue conditions (World Cup 2026 host stadiums; clubs get nothing here): altitude (m) + a heat-risk index (0 mild → 3
// extreme), allowing for air-conditioned/retractable roofs. Matched loosely by name/city. ---
const VENUES = [
  { k: /lumen|seattle/i, alt: 5, heat: 0 },
  { k: /gillette|foxboro|boston/i, alt: 90, heat: 1 },
  { k: /lincoln financial|philadelphia/i, alt: 12, heat: 2 },
  { k: /metlife|rutherford|new jersey|new york/i, alt: 5, heat: 2 },
  { k: /at&t|arlington|dallas/i, alt: 150, heat: 1 },     // retractable roof + AC
  { k: /nrg|houston/i, alt: 15, heat: 1 },                 // retractable roof + AC
  { k: /arrowhead|kansas city/i, alt: 270, heat: 3 },
  { k: /mercedes-benz|atlanta/i, alt: 320, heat: 1 },      // retractable roof + AC
  { k: /hard rock|miami/i, alt: 2, heat: 3 },
  { k: /levi'?s|santa clara|san francisco|bay/i, alt: 9, heat: 2 },
  { k: /sofi|inglewood|los angeles/i, alt: 30, heat: 0 },  // covered
  { k: /bmo|toronto/i, alt: 80, heat: 1 },
  { k: /bc place|vancouver/i, alt: 3, heat: 0 },           // retractable roof
  { k: /azteca|banorte|mexico city|ciudad de m/i, alt: 2240, heat: 1 },
  { k: /akron|guadalajara|zapopan/i, alt: 1566, heat: 2 },
  { k: /bbva|monterrey/i, alt: 500, heat: 3 },
];
function venueInfo(name, city) {
  const s = `${name || ""} ${city || ""}`;
  return VENUES.find((v) => v.k.test(s)) || null;
}
const HEAT_LABEL = ["mild", "warm", "hot", "extreme heat"];

// per-match physical conditions from the schedule + venue: rest days for each side, and the
// venue's altitude/heat. Returns a small λ tilt for the disadvantaged side (capped, since the
// effect is real but noisy) plus display fields. Best-effort; null if data is missing.
export async function matchConditions(ev, homeRef, awayRef) {
  try {
    const v = ev.competitions[0].venue;
    const venue = venueInfo(v?.fullName, v?.address?.city);
    const fixtures = await fetchFotmobFixtures();
    const curMs = new Date(ev.date).getTime();
    const restFor = (ref) => {
      if (!fixtures?.length || !curMs) return null;
      const played = fixtures.filter((f) => f.utcTime && new Date(f.utcTime).getTime() < curMs - 36e5 &&
        (teamsMatch(f.home.name, ref.name) || teamsMatch(f.away.name, ref.name)));
      if (!played.length) return null;
      played.sort((a, b) => new Date(b.utcTime) - new Date(a.utcTime));
      return Math.max(0, Math.round((curMs - new Date(played[0].utcTime).getTime()) / 864e5));
    };
    const restH = restFor(homeRef), restA = restFor(awayRef);
    // tilt: altitude saps pace for both sides; a short-rest side relative to the opponent is tilted down
    let tH = 1, tA = 1;
    if (venue && venue.alt >= 1500) { tH *= 0.96; tA *= 0.96; }
    if (venue && venue.heat >= 3) { tH *= 0.98; tA *= 0.98; }
    if (restH != null && restA != null) {
      if (restH <= 3 && restA - restH >= 2) tH *= 0.97;
      if (restA <= 3 && restH - restA >= 2) tA *= 0.97;
    }
    if (!venue && restH == null && restA == null) return null;
    return {
      venue: venue ? { name: v?.fullName || "", alt: venue.alt, heat: venue.heat, heatLabel: HEAT_LABEL[venue.heat] } : null,
      home: { restDays: restH }, away: { restDays: restA },
      tilt: { home: tH, away: tA },
    };
  } catch {
    return null;
  }
}

// model score prediction: run-of-play once live, market-implied pre-match.
// realXG (FotMob, optional) replaces the shot proxy with true cumulative xG when present.
// cond (optional) applies a small fatigue/altitude/heat tilt to expected goals.
export function scorePrediction(ev, sum, liveOdds, realXG = null, priors = null, cond = null, goalsBias = 1) {
  const comp = ev.competitions[0];
  const home = comp.competitors.find((t) => t.homeAway === "home");
  const away = comp.competitors.find((t) => t.homeAway === "away");
  const st = comp.status, state = st.type.state;
  if (state === "post") return null;
  const minute = matchMinute(st);
  const hScore = Number(home.score) || 0, aScore = Number(away.score) || 0;
  const FT = 95, AVG_TEAM = 1.35;
  const n = (v) => parseFloat(v) || 0;

  const teams = sum.boxscore?.teams || [];
  const hs = statMap(teams.find((t) => t.team.id === home.team.id) || teams[0] || {});
  const as = statMap(teams.find((t) => t.team.id === away.team.id) || teams[1] || {});
  const haveStats = Object.keys(hs).length > 0;
  const xg = (s) => n(s.shotsOnTarget) * 0.33 + Math.max(0, n(s.totalShots) - n(s.shotsOnTarget)) * 0.04;

  let remLamH, remLamA, basis;
  if (state === "in" && haveStats && minute != null && minute > 0) {
    const elapsed = Math.max(minute, 1), remMin = Math.max(0, FT - minute);
    const w = Math.min(1, elapsed / 70);
    const priorRem = AVG_TEAM * (remMin / 90);
    const useReal = realXG && typeof realXG.home?.xg === "number";
    const cumH = useReal ? realXG.home.xg : xg(hs);
    const cumA = useReal ? realXG.away.xg : xg(as);
    remLamH = w * ((cumH / elapsed) * remMin) + (1 - w) * priorRem;
    remLamA = w * ((cumA / elapsed) * remMin) + (1 - w) * priorRem;
    basis = useReal ? "run of play · real xG" : "run of play";
  } else {
    const probs = impliedFromOdds(sum, liveOdds);
    const odds = (sum.pickcenter || sum.odds || [])[0];
    const remMin = state === "pre" ? 90 : Math.max(0, FT - (minute ?? 0));
    const total = (Number(odds?.overUnder) || 2.7) * (remMin / 90);
    const sup = probs ? 2.2 * (probs[0] - probs[2]) * (remMin / 90) : 0;
    remLamH = Math.max(0.05, (total + sup) / 2);
    remLamA = Math.max(0.05, (total - sup) / 2);
    basis = "from market";
    // blend in each team's Round 1 xG form (FotMob) so the pregame line reflects how they
    // actually played, not just the market — market gets the majority weight (1 game is noisy)
    if (priors && state === "pre") {
      remLamH = 0.55 * remLamH + 0.45 * priors.home;
      remLamA = 0.55 * remLamA + 0.45 * priors.away;
      basis = "market + R1 form";
    }
    // goal-expectation calibration (pregame only): scale the line toward the realized scoring
    // environment so the model stops over-firing Unders / Draws / BTTS-No. 1.0 = no change. The
    // factor is learned from settled Total legs in betlog.goalsBias() and threaded in by the caller.
    if (state === "pre" && goalsBias && goalsBias !== 1) {
      remLamH *= goalsBias; remLamA *= goalsBias;
      basis += ` · cal ×${goalsBias.toFixed(2)}`;
    }
  }

  // conditions tilt (altitude/heat/rest fatigue) — small, capped
  if (cond && cond.home && cond.away) { remLamH *= cond.home; remLamA *= cond.away; }
  const expH = hScore + remLamH, expA = aScore + remLamA;
  const [wH, wD, wA] = outcomeProbs(remLamH, remLamA, hScore, aScore);
  const early = state === "pre" || (minute != null && minute < 25);
  // derived predictions (live-aware): goals already scored are certain, only the remaining
  // expectation is random.  BTTS = each team scores ≥1 by full time.
  const scored = hScore + aScore;
  const pHomeScore = hScore >= 1 ? 1 : 1 - Math.exp(-remLamH);
  const pAwayScore = aScore >= 1 ? 1 : 1 - Math.exp(-remLamA);
  const pBTTS = pHomeScore * pAwayScore;
  const needOver = Math.max(0, 3 - scored);
  const pOver25 = needOver === 0 ? 1 : 1 - poissonCdf(needOver - 1, remLamH + remLamA);
  // displayed scoreline = the MOST LIKELY exact score (the mode of each side's goal distribution,
  // = floor of expected goals), NOT each side rounded independently. Rounding both up inflated the
  // shown total above the expected total, so "predicted 2-1" could sit next to an Under 2.5 pick.
  // The mode keeps the scoreline consistent with the win % and totals (e.g. 1.66/0.84 -> 1-0).
  return { basis, early, ph: Math.floor(expH), pa: Math.floor(expA), expH, expA, wH, wD, wA, pBTTS, pOver25, remLamH, remLamA };
}

// betting model: run-of-play dominance vs market price → considerations (bet + reasoning).
// realXG (FotMob, optional) feeds true xG into the dominance index and the goals reads.
export function bettingModel(ev, sum, liveOdds, realXG = null, prediction = null) {
  const comp = ev.competitions[0];
  const home = comp.competitors.find((t) => t.homeAway === "home");
  const away = comp.competitors.find((t) => t.homeAway === "away");
  const st = comp.status;
  const halftime = st.type.name === "STATUS_HALFTIME";
  const teams = sum.boxscore?.teams || [];
  const hs = statMap(teams.find((t) => t.team.id === home.team.id) || teams[0] || {});
  const as = statMap(teams.find((t) => t.team.id === away.team.id) || teams[1] || {});
  if (!Object.keys(hs).length) return null;
  const n = (v) => parseFloat(v) || 0;
  const hScore = Number(home.score) || 0, aScore = Number(away.score) || 0;
  const HA = home.team.abbreviation, AA = away.team.abbreviation;

  const xg = (s) => n(s.shotsOnTarget) * 0.33 + Math.max(0, n(s.totalShots) - n(s.shotsOnTarget)) * 0.04;
  const hX = typeof realXG?.home?.xg === "number" ? realXG.home.xg : xg(hs);
  const aX = typeof realXG?.away?.xg === "number" ? realXG.away.xg : xg(as);
  const combinedX = hX + aX;

  const share = (h, a) => { const t = h + a; return t ? h / t : 0.5; };
  const weights = [
    [hX, aX, 0.40],
    [n(hs.shotsOnTarget), n(as.shotsOnTarget), 0.25],
    [n(hs.totalShots), n(as.totalShots), 0.15],
    [n(hs.possessionPct), n(as.possessionPct), 0.10],
    [n(hs.wonCorners), n(as.wonCorners), 0.10],
  ];
  const hDom = Math.round(weights.reduce((acc, [h, a, w]) => acc + share(h, a) * w, 0) * 100);
  const aDom = 100 - hDom;
  const domLeader = hDom >= aDom ? { abbr: HA, dom: hDom, side: "home" } : { abbr: AA, dom: aDom, side: "away" };

  let mkt = null;
  if (liveOdds) {
    const sH = liveOdds.swapped ? "away" : "home";
    const sA = liveOdds.swapped ? "home" : "away";
    const price = (slot) => liveOdds.book(slot, "fanduel")?.price;
    const pH = price(sH), pD = price("draw"), pA = price(sA);
    const raw = [pH, pD, pA].map(ml2prob);
    const sum2 = raw.reduce((x, y) => x + (y || 0), 0) || 1;
    mkt = {
      home: { price: pH, prob: Math.round((raw[0] / sum2) * 100) },
      draw: { price: pD, prob: Math.round((raw[1] / sum2) * 100) },
      away: { price: pA, prob: Math.round((raw[2] / sum2) * 100) },
    };
  }

  const recs = [];
  const leadByScore = hScore === aScore ? null : hScore > aScore ? "home" : "away";
  const domSide = domLeader.side, domAbbr = domLeader.abbr, domPct = domLeader.dom;
  const totalShots = n(hs.totalShots) + n(as.totalShots);
  const priceFor = (side) => (mkt ? `${fmtAmerican(mkt[side].price)} (${mkt[side].prob}%)` : "no live price");

  // looser thresholds at halftime — a full half of evidence and the 2nd-half market resets
  const domT = halftime ? 55 : 60, domStrongT = halftime ? 62 : 67;
  const whenLabel = halftime ? "first half" : "so far";
  // the scoreline model's win prob for the dominant side — gates the "to win" lean so it can
  // never contradict the win bar (a side dominating but trailing late may have ~no real chance)
  const WIN_FLOOR = 0.25;
  const domWin = prediction ? (domSide === "home" ? prediction.wH : prediction.wA) : null;
  if (domPct >= domT && leadByScore !== domSide && (domWin == null || domWin >= WIN_FLOOR)) {
    recs.push({
      conf: domPct >= domStrongT ? "Strong lean" : "Lean",
      bet: `${domAbbr} to win @ ${priceFor(domSide)}`,
      text:
        `${domAbbr} to win the match @ ${priceFor(domSide)} — controlling the game (${domPct}%, xG edge) ` +
        `but ${leadByScore ? "trailing" : "level"}${domWin != null ? `; scoreline model still gives them ${Math.round(domWin * 100)}%` : ""}. The run of play says they're the better side and haven't been rewarded yet.`,
    });
  } else if (domPct >= domT && leadByScore !== domSide && domWin != null && domWin < WIN_FLOOR) {
    // dominant but trailing late — the scoreline model says the comeback is unlikely, so this is
    // information, not a win lean (prevents the old "back TUR" vs "PAR 63%" contradiction)
    recs.push({
      conf: "Low value",
      bet: `${domAbbr} on top but unlikely to recover — model ${Math.round(domWin * 100)}%`,
      text:
        `${domAbbr} are controlling (${domPct}%) but trailing with little time/xG left — the scoreline ` +
        `model gives them only ${Math.round(domWin * 100)}%. Run-of-play dominance without enough runway; not a win lean.`,
    });
  } else if (domPct >= domT - 3 && leadByScore === domSide) {
    recs.push({
      conf: "Low value",
      bet: `${domAbbr} win — fair but priced in (${priceFor(domSide)})`,
      text: `${domAbbr} are both ahead and on top — the price (${priceFor(domSide)}) already reflects it. Fair, but little edge left.`,
    });
  }

  // goals + BTTS reads from the model probabilities (live-aware). Directional — no live
  // totals/BTTS market on the free tier — but they keep a read on the board at halftime.
  const scored = hScore + aScore;
  const bothScored = hScore >= 1 && aScore >= 1;
  if (prediction) {
    const ov = Math.round(prediction.pOver25 * 100);
    if (prediction.pOver25 >= 0.56 && scored <= 2) {
      recs.push({ conf: prediction.pOver25 >= 0.66 ? "Strong lean" : "Lean", bet: `Over 2.5 goals — model ${ov}%`,
        text: `Over 2.5 goals — model ${ov}% (${combinedX.toFixed(2)} combined xG ${whenLabel}, ${scored} scored). Directional.` });
    } else if (prediction.pOver25 <= 0.42) {
      recs.push({ conf: "Lean", bet: `Under 2.5 goals — model ${100 - ov}%`,
        text: `Under 2.5 goals — model ${100 - ov}% (sterile run of play, ${combinedX.toFixed(2)} combined xG ${whenLabel}). Directional.` });
    }
    const bt = Math.round(prediction.pBTTS * 100);
    if (!bothScored && prediction.pBTTS >= 0.55) {
      recs.push({ conf: prediction.pBTTS >= 0.66 ? "Strong lean" : "Lean", bet: `Both teams to score — model ${bt}%`,
        text: `Both teams to score (Yes) — model ${bt}%; both sides creating (${hX.toFixed(2)} / ${aX.toFixed(2)} xG) and ${bothScored ? "both have scored" : "not both on the board yet"}. Directional.` });
    } else if (!bothScored && prediction.pBTTS <= 0.38) {
      recs.push({ conf: "Lean", bet: `Both teams to score: No — model ${100 - bt}%`,
        text: `BTTS No — model ${100 - bt}%; one side offers little going forward (${hX.toFixed(2)} / ${aX.toFixed(2)} xG). Directional.` });
    }
  }
  if (!recs.length) {
    recs.push({
      conf: "No edge",
      bet: "No clear edge — sit this one out",
      text: "Even contest with no clear trend-vs-price gap — nothing stands out. Sit this one out.",
    });
  }

  return { recs, domLeader, hDom, aDom, hX, aX, combinedX, HA, AA, hScore, aScore };
}

// pre-match picks derived from the score prediction (the prediction is market-based before
// kickoff, so these are fair-value reads, not a claimed edge — labeled honestly).
export function prematchPicks(p, HA, AA) {
  const picks = [];
  const total = p.expH + p.expA;
  const favIsHome = p.wH >= p.wA;
  const favAbbr = favIsHome ? HA : AA;
  const favProb = Math.round((favIsHome ? p.wH : p.wA) * 100);

  // match result
  if (favProb >= 60) {
    picks.push({
      conf: favProb >= 70 ? "Strong lean" : "Lean",
      bet: `${favAbbr} to win — model ${favProb}%`,
      text: `${favAbbr} projected to win (model ${favProb}%, predicted ${p.ph}–${p.pa}). Pre-match read off the market line — fair value, not an edge.`,
    });
  } else {
    picks.push({
      conf: "Lean",
      bet: `Tight — double chance ${favAbbr}/Draw`,
      text: `No clear favourite (model ${favAbbr} ${favProb}%, predicted ${p.ph}–${p.pa}). Double chance ${favAbbr}/Draw is the safer pre-match lean.`,
    });
  }

  // total goals
  if (total >= 2.7) {
    picks.push({ conf: "Lean", bet: `Over 2.5 goals — proj ${total.toFixed(1)}`, text: `Model projects ${total.toFixed(1)} total goals (${p.ph}–${p.pa}) → Over 2.5 lean.` });
  } else if (total <= 2.1) {
    picks.push({ conf: "Lean", bet: `Under 2.5 goals — proj ${total.toFixed(1)}`, text: `Model projects ${total.toFixed(1)} total goals (${p.ph}–${p.pa}) → Under 2.5 lean.` });
  }

  // both teams to score
  if (p.expH >= 0.9 && p.expA >= 0.9) {
    picks.push({ conf: "Lean", bet: `Both teams to score — proj ${p.expH.toFixed(1)} / ${p.expA.toFixed(1)}`, text: `Both sides project ~1+ goal (${p.expH.toFixed(1)} / ${p.expA.toFixed(1)}) → BTTS lean.` });
  }
  return picks;
}

// --- structured views (no ANSI / no DOM) for any front end ---

// pregame projections from each team's Round 1 form (FotMob): expected corners O/U,
// keeper-saves O/U, and xG priors to blend into the scoreline. null if rates unavailable.
export async function pregameProjections(home, away) {
  const [hr, ar] = await Promise.all([fotmobTeamRates(home), fotmobTeamRates(away)]);
  if (!hr || !ar) return null;
  const mean = (a, b) => (a + b) / 2;
  // attack = blend of xG created and goals actually scored; defence = xG + goals conceded.
  // goals capture finishing/overperformance (a 7-1 lifts attack); falls back to xG if no goals.
  const att = (r) => mean(r.xgFor, r.goalsFor ?? r.xgFor);
  const def = (r) => mean(r.xgAgainst, r.goalsAgainst ?? r.xgAgainst);
  // only one game has been played, so regularize each rate toward a tournament prior
  // (50/50) — keeps a single 0-corner game from producing a nonsensical projection
  const shrink = (v, prior) => (v + prior) / 2;
  // corners: each side's expected count is the average of its own (shrunk) attacking rate and
  // the opponent's (shrunk) conceding rate; total drives an O/U 9.5 via Poisson
  const cH = mean(shrink(hr.cornersFor, 5), shrink(ar.cornersAgainst, 5));
  const cA = mean(shrink(ar.cornersFor, 5), shrink(hr.cornersAgainst, 5));
  const cTotal = cH + cA, cLine = centreLine(cTotal);
  const pOverC = 1 - poissonCdf(Math.floor(cLine), cTotal);
  // keeper saves: expected shots-on-target faced minus expected goals conceded (xG proxy)
  const sotFacedH = mean(shrink(ar.sotFor, 4), shrink(hr.sotAgainst, 4));
  const sotFacedA = mean(shrink(hr.sotFor, 4), shrink(ar.sotAgainst, 4));
  const gaH = mean(shrink(ar.xgFor, 1.3), shrink(hr.xgAgainst, 1.3));
  const gaA = mean(shrink(hr.xgFor, 1.3), shrink(ar.xgAgainst, 1.3));
  const savesH = Math.max(0, sotFacedH - gaH), savesA = Math.max(0, sotFacedA - gaA);
  const sLineH = centreLine(savesH), sLineA = centreLine(savesA);
  // projected shots + shots on target per side (own attacking rate vs opponent conceding rate)
  const shotsH = mean(shrink(hr.shotsFor, 12), shrink(ar.shotsAgainst, 12));
  const shotsA = mean(shrink(ar.shotsFor, 12), shrink(hr.shotsAgainst, 12));
  const sotH = mean(shrink(hr.sotFor, 4), shrink(ar.sotAgainst, 4));
  const sotA = mean(shrink(ar.sotFor, 4), shrink(hr.sotAgainst, 4));
  const pOverSH = 1 - poissonCdf(Math.floor(sLineH), savesH), pOverSA = 1 - poissonCdf(Math.floor(sLineA), savesA);
  return {
    basis: `recent form (${Math.max(hr.games, ar.games)}g · ${[...new Set([...(hr.competitions || []), ...(ar.competitions || [])])].slice(0, 2).join(", ") || "all comps"})`,
    shots: { home: { shots: shotsH, sot: sotH }, away: { shots: shotsA, sot: sotA } },
    corners: { home: cH, away: cA, total: cTotal, line: cLine, pOver: pOverC, odds: probToAmerican(pOverC) },
    saves: {
      home: { proj: savesH, line: sLineH, pOver: pOverSH, odds: probToAmerican(pOverSH) },
      away: { proj: savesA, line: sLineA, pOver: pOverSA, odds: probToAmerican(pOverSA) },
    },
    // attack/defence strength blends xG with REAL goals scored/conceded, so a team that has
    // actually been banging them in (or leaking) moves the scoreline prior — not just chance
    // quality. Each side's prior = its attack vs the opponent's defence.
    xgPrior: { home: mean(att(hr), def(ar)), away: mean(att(ar), def(hr)) },
  };
}

// one match → a complete plain-data view (scores, stats, odds, prediction, recs, keepers, events)
export function buildMatchView(ev, sum, liveOdds, realXG = null, publicBetting = null, priors = null, conditions = null, goalsBias = 1) {
  const comp = ev.competitions[0];
  const home = comp.competitors.find((t) => t.homeAway === "home");
  const away = comp.competitors.find((t) => t.homeAway === "away");
  const st = comp.status, state = st.type.state;
  const minute = matchMinute(st);
  const halftime = st.type.name === "STATUS_HALFTIME";

  const statusText = halftime ? "HALFTIME"
    : state === "in" ? `LIVE ${st.displayClock || st.type.shortDetail || ""}`.trim()
    : state === "post" ? "FULL TIME"
    : new Date(ev.date).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });

  const teamObj = (t) => ({
    id: t.team.id, name: t.team.displayName, abbr: t.team.abbreviation, league: clubLeague(t.team.displayName),
    score: state === "pre" ? null : Number(t.score) || 0,
    logo: t.team.logo || (t.team.logos && t.team.logos[0]?.href) || null,
    color: t.team.color ? `#${t.team.color}` : null,
    altColor: t.team.alternateColor ? `#${t.team.alternateColor}` : null,
    // penalty-shootout score — ESPN puts it on the competitor when a knockout game goes to pens
    shoot: t.shootoutScore != null ? Number(t.shootoutScore) : null,
  });

  // stats
  const teams = sum.boxscore?.teams || [];
  const hs = statMap(teams.find((t) => t.team.id === home.team.id) || teams[0] || {});
  const as = statMap(teams.find((t) => t.team.id === away.team.id) || teams[1] || {});
  const pct = (v) => `${Math.round(parseFloat(v || 0) * 100)}%`;
  let possession = null, stats = [];
  if (Object.keys(hs).length) {
    possession = { home: parseFloat(hs.possessionPct || "50"), away: parseFloat(as.possessionPct || "50"), homeAbbr: home.team.abbreviation, awayAbbr: away.team.abbreviation };
    const rows = [
      ["Shots (on target)", `${hs.totalShots} (${hs.shotsOnTarget})`, `${as.totalShots} (${as.shotsOnTarget})`, hs.totalShots, as.totalShots],
      ["Corners", hs.wonCorners, as.wonCorners, hs.wonCorners, as.wonCorners],
      ["Fouls / Offsides", `${hs.foulsCommitted} / ${hs.offsides}`, `${as.foulsCommitted} / ${as.offsides}`, hs.foulsCommitted, as.foulsCommitted],
      ["Yellow / Red", `${hs.yellowCards} / ${hs.redCards}`, `${as.yellowCards} / ${as.redCards}`, hs.yellowCards, as.yellowCards],
      ["Passes (acc)", `${hs.totalPasses} (${pct(hs.passPct)})`, `${as.totalPasses} (${pct(as.passPct)})`, hs.totalPasses, as.totalPasses],
      ["Tkl/Int/Clr", `${hs.totalTackles}/${hs.interceptions}/${hs.effectiveClearance}`, `${as.totalTackles}/${as.interceptions}/${as.effectiveClearance}`, hs.totalTackles, as.totalTackles],
    ];
    for (const [label, hv, av, hn, an] of rows) {
      if (hv == null || String(hv).includes("undefined")) continue;
      stats.push({ label, home: String(hv), away: String(av), homeLeads: Number(hn) > Number(an), awayLeads: Number(an) > Number(hn) });
    }
  }

  // odds (live multi-book if a key is set, else ESPN pre-match opening line)
  let odds = null;
  if (liveOdds) {
    const slotHome = liveOdds.swapped ? "away" : "home";
    const slotAway = liveOdds.swapped ? "home" : "away";
    const fd = (slot) => liveOdds.book(slot, "fanduel");
    const fdML = [fd(slotHome)?.price, fd("draw")?.price, fd(slotAway)?.price];
    const raw = fdML.map(ml2prob);
    const sumP = raw.reduce((a, b) => a + (b || 0), 0) || 1;
    const complete = raw.every((p) => p != null); // a suspended side can't be de-vigged around
    const probs = raw.map((p) => (p == null || !complete ? null : Math.round((p / sumP) * 100)));
    const mk = (slot, i) => {
      const b = liveOdds.best(slot);
      return {
        ml: fmtAmerican(fdML[i]), prob: probs[i],
        best: b ? fmtAmerican(b.price) : null, bestBook: b ? b.book : null, beatsFd: b ? b.book !== "fanduel" : false,
      };
    };
    odds = { source: liveOdds.live ? "live" : "pre", reqLeft: oddsState.remaining,
      home: mk(slotHome, 0), draw: mk("draw", 1), away: mk(slotAway, 2) };
  } else if (publicBetting?.fanduel) {
    // real FanDuel moneyline via Action Network (free, no Odds API quota)
    const f = publicBetting.fanduel;
    const complete = [f.home, f.draw, f.away].every((c) => c && c.ml != null);
    const cell = (c) => ({ ml: fmtAmerican(c.ml), prob: complete ? c.prob : null });
    odds = { source: "fanduel-an", home: cell(f.home), draw: cell(f.draw), away: cell(f.away) };
  } else {
    const o = (sum.pickcenter || sum.odds || [])[0];
    if (o && o.homeTeamOdds?.moneyLine != null) {
      const raw = [ml2prob(o.homeTeamOdds.moneyLine), ml2prob(o.drawOdds?.moneyLine), ml2prob(o.awayTeamOdds?.moneyLine)];
      const sumP = raw.reduce((a, b) => a + (b || 0), 0) || 1;
      const probs = raw.map((p) => (p == null ? null : Math.round((p / sumP) * 100)));
      odds = { source: "pre-espn", provider: o.provider?.name || "book",
        home: { ml: fmtAmerican(o.homeTeamOdds.moneyLine), prob: probs[0] },
        draw: { ml: fmtAmerican(o.drawOdds?.moneyLine), prob: probs[1] },
        away: { ml: fmtAmerican(o.awayTeamOdds?.moneyLine), prob: probs[2] } };
    }
  }

  // corners per side + model total O/U (per-side counts are real live data)
  let corners = null;
  if (Object.keys(hs).length) {
    const hC = parseInt(hs.wonCorners || 0, 10) || 0;
    const aC = parseInt(as.wonCorners || 0, 10) || 0;
    corners = cornersModel(hC, aC, minute, state, null, priors?.corners ? { home: priors.corners.home, away: priors.corners.away } : null);
  }

  // prediction + recommended bets — run-of-play model once live, market-based pre-match
  const prediction = scorePrediction(ev, sum, liveOdds, realXG, priors?.xgPrior, conditions?.tilt, goalsBias);
  const model = bettingModel(ev, sum, liveOdds, realXG, prediction);
  let recs = model ? model.recs : [];
  let recsBasis = model ? "run of play" : null;
  if ((!recs || !recs.length) && prediction && state !== "post") {
    recs = prematchPicks(prediction, home.team.abbreviation, away.team.abbreviation);
    recsBasis = "pre-match model";
  }
  const dominance = model ? { leader: model.domLeader.abbr, pct: model.domLeader.dom } : null;

  // model-vs-market gap (live only): where the run-of-play model's win prob diverges from
  // the de-vigged market price. A divergence signal, NOT a guaranteed edge.
  let valueEdges = null;
  if (prediction && state !== "post" && odds && odds.home?.prob != null) {
    const dec = (mlStr) => { const ml = Number(mlStr); if (!ml) return null; return ml > 0 ? ml / 100 + 1 : 100 / -ml + 1; };
    // half-Kelly stake (fraction of bankroll), capped at 5% — full Kelly is too aggressive and
    // large model "edges" are usually model error, not real value
    const kelly = (p, d) => { if (!d || d <= 1) return 0; const b = d - 1; return Math.min(0.05, Math.max(0, (b * p - (1 - p)) / b / 2)); };
    valueEdges = [
      { label: home.team.abbreviation, model: prediction.wH, mkt: odds.home.prob / 100, ml: odds.home.ml },
      { label: "Draw", model: prediction.wD, mkt: odds.draw?.prob != null ? odds.draw.prob / 100 : null, ml: odds.draw?.ml },
      { label: away.team.abbreviation, model: prediction.wA, mkt: odds.away?.prob != null ? odds.away.prob / 100 : null, ml: odds.away?.ml },
    ].filter((s) => s.mkt != null).map((s) => { const d = dec(s.ml); return { ...s, edge: s.model - s.mkt, dec: d, kelly: kelly(s.model, d) }; })
      .sort((a, b) => b.edge - a.edge);
  }

  // keepers with model saves line
  const keepers = [];
  for (const r of sum.rosters || []) {
    const abbr = r.team?.id === home.team.id ? home.team.abbreviation
      : r.team?.id === away.team.id ? away.team.abbreviation : r.team?.abbreviation || "";
    for (const p of r.roster || []) {
      if (p.position?.abbreviation !== "G") continue;
      const ps = Object.fromEntries((p.stats || []).map((s) => [s.name, s.value]));
      if (!ps.appearances) continue;
      const saves = ps.saves ?? 0;
      const side = r.team?.id === home.team.id ? "home" : r.team?.id === away.team.id ? "away" : null;
      const ln = keeperSaveLine(saves, minute, state, null, side && priors?.saves ? priors.saves[side]?.proj : null);
      keepers.push({
        abbr, name: p.athlete?.displayName || "?", saves, ga: ps.goalsConceded ?? 0, faced: ps.shotsFaced ?? 0,
        line: ln ? (ln.settled ? { settled: true, over: ln.over, value: ln.line }
          : { settled: false, proj: ln.proj, pOver: ln.pOver, need: ln.need, value: ln.line, odds: probToAmerican(ln.pOver) })
          : null,
      });
    }
  }

  // group standings for this match's group
  let group = null;
  const g = sum.standings?.groups?.[0];
  if (g?.standings?.entries?.length) {
    const stat = (e, nm) => (e.stats || []).find((s) => s.name === nm)?.displayValue ?? "";
    const teamName = (t) => (typeof t === "string" ? t : t?.displayName || t?.name || "?");
    const here = new Set([home.team.displayName, away.team.displayName]);
    const entries = [...g.standings.entries]
      .sort((a, b) => Number(stat(a, "rank")) - Number(stat(b, "rank")))
      .map((e) => ({
        rank: Number(stat(e, "rank")), name: teamName(e.team), gp: stat(e, "gamesPlayed"),
        record: stat(e, "overall"), gd: stat(e, "pointDifferential"), pts: stat(e, "points"),
        highlight: here.has(teamName(e.team)),
      }));
    group = { header: g.header || "Group", entries };
  }

  // penalty-shootout kicks (best-effort): ESPN's live shootout event naming isn't documented,
  // so match any keyEvent that mentions a shootout and infer scored/missed from the text. If a
  // shootout uses a shape we don't recognise, this stays empty and the UI just shows the totals.
  const shootoutKicks = [];
  for (const e of sum.keyEvents || []) {
    const t = `${e.type?.text || ""} ${e.text || ""}`.toLowerCase();
    if (!t.includes("shootout")) continue;
    const scored = !/(miss|saved|save\b|post|crossbar|off target|wide|over the bar)/.test(t);
    shootoutKicks.push({
      teamAbbr: e.team?.id === home.team.id ? home.team.abbreviation : e.team?.id === away.team.id ? away.team.abbreviation : "",
      scored,
      player: (e.participants || [])[0]?.athlete?.displayName || "",
    });
  }

  // events (goals, cards, subs)
  const events = (sum.keyEvents || [])
    .filter((e) => {
      const t = (e.type?.text || "").toLowerCase();
      if (t.includes("delay")) return false;
      return ["goal", "card", "substitution", "penalty", "kickoff", "halftime", "end"].some((k) => t.includes(k));
    })
    // every event: the widget draws a full-match timeline from these
    .map((e) => ({
      min: e.clock?.displayValue || "",
      type: e.type?.text || "",
      teamAbbr: e.team?.id === home.team.id ? home.team.abbreviation : e.team?.id === away.team.id ? away.team.abbreviation : "",
      players: (e.participants || []).map((p) => p.athlete?.displayName).filter(Boolean).join(", "),
    }));

  // real xG (FotMob) for display — team totals (incl. xGOT / big chances) + top per-player
  const xg = realXG && typeof realXG.home?.xg === "number"
    ? {
        source: realXG.source || "fotmob",
        home: realXG.home, away: realXG.away, players: (realXG.players || []).slice(0, 6),
        xgot: realXG.xgot || null, bigChances: realXG.bigChances || null, bigChancesMissed: realXG.bigChancesMissed || null,
      }
    : null;
  // live pressure series, top performers, recent form — all from the same FotMob fetch
  const momentum = realXG?.momentum?.length ? realXG.momentum : null;
  const topPlayers = realXG?.topPlayers || null;
  const form = realXG?.form || null;

  // knockout round tag (season.slug is the phase slug — "league-phase" / "group-stage" — until the
  // knockouts, then the round slug). Two-legged ties carry ESPN's leg marker.
  const slug = ev.season?.slug || "";
  const leg = comp.leg?.value ? { n: Number(comp.leg.value), label: comp.leg.displayValue || `Leg ${comp.leg.value}` } : null;
  const round = !isPhaseSlug(slug)
    ? { slug, label: `${KO_LABEL[slug] || slug.replace(/-/g, " ")}${leg ? ` · ${leg.label}` : ""}`, knockout: true, leg }
    : null;

  // advance probability (knockout, unfinished only): a 90-minute draw doesn't eliminate anyone —
  // it goes to extra time/pens — so fold wD into each side. The draw is split by relative
  // strength, but shrunk hard toward a coin flip (x0.4) because ET/pens are far closer to
  // 50/50 than regulation: legs tire, pens are near-random, favourites lose most of their edge.
  // Two-legged ties: a single leg decides nothing (the 2nd leg would need the aggregate), so the
  // advance bar only shows on one-off ties (WC knockouts, the UCL final).
  let advance = null;
  if (round && !leg && prediction && state !== "post") {
    const strength = prediction.wH + prediction.wA > 0 ? prediction.wH / (prediction.wH + prediction.wA) : 0.5;
    const etH = 0.5 + (strength - 0.5) * 0.4;
    advance = { home: prediction.wH + prediction.wD * etH, away: prediction.wA + prediction.wD * (1 - etH) };
  }

  return {
    id: ev.id, state, halftime, minute, statusText, venue: comp.venue?.fullName || "",
    date: ev.date, round, advance, shootoutKicks: shootoutKicks.length ? shootoutKicks : null,
    home: teamObj(home), away: teamObj(away),
    possession, stats, xg, momentum, topPlayers, form, odds, prediction, recs, recsBasis, dominance, valueEdges,
    publicBetting: publicBetting || null, pregameProj: priors || null, conditions: conditions || null, keepers, corners, group, events,
  };
}

// quick market-based predicted scoreline for a match, from an odds-API event's consensus
// h2h + totals lines. Cheap enough to run for every row in the picker. null if no odds.
function marketPrediction(oddsEv, homeName) {
  if (!oddsEv) return null;
  const homeP = [], drawP = [], awayP = [];
  let totalLine = null;
  for (const bk of oddsEv.bookmakers || []) {
    const h2h = (bk.markets || []).find((m) => m.key === "h2h");
    if (h2h) {
      let ph, pd, pa;
      for (const o of h2h.outcomes || []) {
        if (/draw/i.test(o.name)) pd = ml2prob(o.price);
        else if (teamsMatch(o.name, oddsEv.home_team)) ph = ml2prob(o.price);
        else pa = ml2prob(o.price);
      }
      if (ph != null && pa != null) {
        const s = ph + (pd || 0) + pa || 1;
        homeP.push(ph / s); drawP.push((pd || 0) / s); awayP.push(pa / s);
      }
    }
    if (totalLine == null) {
      const pt = (bk.markets || []).find((m) => m.key === "totals")?.outcomes?.find((o) => o.point != null)?.point;
      if (pt != null) totalLine = pt;
    }
  }
  if (!homeP.length) return null;
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  let pH = avg(homeP), pD = avg(drawP), pA = avg(awayP);
  if (teamsMatch(oddsEv.away_team, homeName)) { const t = pH; pH = pA; pA = t; } // map to ESPN home/away
  const total = totalLine != null ? Number(totalLine) : 2.7;
  const sup = 2.2 * (pH - pA);
  const lamH = Math.max(0.05, (total + sup) / 2), lamA = Math.max(0.05, (total - sup) / 2);
  const [wH, wD, wA] = outcomeProbs(lamH, lamA, 0, 0);
  return { ph: Math.round(lamH), pa: Math.round(lamA), wH, wD, wA };
}

// market-based predicted scoreline from ESPN's inline scoreboard odds (already on the row, so
// no extra fetch). The picker's fallback when The Odds API is unavailable (e.g. quota used up).
// home/away here are the ESPN home/away, so no swap is needed.
function espnMarketPrediction(ev) {
  const o = (ev.competitions?.[0]?.odds || [])[0];
  const ml = o?.moneyline;
  if (!ml) return null;
  const px = (s) => { const v = s?.current?.odds ?? s?.close?.odds ?? s?.open?.odds; return v == null ? null : Number(v); };
  const pH0 = ml2prob(px(ml.home)), pD0 = ml2prob(px(ml.draw)), pA0 = ml2prob(px(ml.away));
  if (pH0 == null || pA0 == null) return null;
  const s = pH0 + (pD0 || 0) + pA0 || 1;
  const pH = pH0 / s, pA = pA0 / s;
  const total = Number(o.overUnder) || 2.7;
  const sup = 2.2 * (pH - pA);
  const lamH = Math.max(0.05, (total + sup) / 2), lamA = Math.max(0.05, (total - sup) / 2);
  const [wH, wD, wA] = outcomeProbs(lamH, lamA, 0, 0);
  return { ph: Math.round(lamH), pa: Math.round(lamA), wH, wD, wA };
}

// today's matches (today + N days) as lightweight rows for a picker
// the widget's fixture pool: recent days (so finished games stay viewable) through the next
// matchweeks. Window sizes are per competition — a club competition plays Tue–Thu every 2–3
// weeks, so it looks weeks ahead where the WC looked days. One ranged ESPN call, de-duped.
// when the window holds nothing still to play, look this far ahead for the next matchday instead
const POOL_REACH_DAYS = 60;
export async function fixturePool({ back = COMP.lookBackDays, ahead = COMP.lookAheadDays } = {}) {
  let board = await scoreboardRange(ymd(-back), ymd(ahead)).catch(() => ({ events: [] }));
  // league-phase matchdays can sit over a month apart (UCL 26/27: MD1 8–10 Sep, MD2 13–14 Oct), which
  // left the slate with no upcoming game and the table with no "next" fixture between them
  const toPlay = (b) => (b.events || []).some((e) => e.competitions?.[0]?.status?.type?.state !== "post");
  if (!toPlay(board) && ahead < POOL_REACH_DAYS) {
    const far = await scoreboardRange(ymd(-back), ymd(POOL_REACH_DAYS)).catch(() => null);
    if (far && toPlay(far)) board = far;
  }
  const seen = new Set(), events = [];
  for (const ev of board.events || []) if (!seen.has(ev.id)) { seen.add(ev.id); events.push(ev); }
  events.sort((a, b) => new Date(a.date) - new Date(b.date));
  return events;
}

export async function listMatchesData(opts = {}) {
  const events = await fixturePool(opts);
  // one cached odds fetch covers every row's predicted scoreline
  let oddsEvents = null;
  if (ODDS_KEY) { try { oddsEvents = await fetchOddsEvents(); } catch { /* no predictions */ } }
  return events.map((ev) => {
    const comp = ev.competitions[0];
    const home = comp.competitors.find((t) => t.homeAway === "home");
    const away = comp.competitors.find((t) => t.homeAway === "away");
    const state = comp.status.type.state;
    let pred = null;
    if (oddsEvents) {
      const hn = home.team.displayName, an = away.team.displayName;
      const oe = oddsEvents.find((e) =>
        (teamsMatch(e.home_team, hn) && teamsMatch(e.away_team, an)) ||
        (teamsMatch(e.home_team, an) && teamsMatch(e.away_team, hn)));
      pred = marketPrediction(oe, hn);
    }
    if (!pred) pred = espnMarketPrediction(ev); // fallback: ESPN's inline line (works without the Odds API)
    // freeze the slate's pre-match calls too, so games never opened still get graded. The picker's
    // market prediction lacks totals; the match view's fuller call replaces nothing (first freeze wins)
    if (state === "pre" && pred) freezePrediction(ev, { ...pred, basis: "market (slate)" });
    return {
      id: ev.id, date: ev.date, state,
      home: home.team.displayName, homeAbbr: home.team.abbreviation, homeScore: Number(home.score) || 0,
      away: away.team.displayName, awayAbbr: away.team.abbreviation, awayScore: Number(away.score) || 0,
      homeLogo: home.team.logo || null, awayLogo: away.team.logo || null,
      homeColor: home.team.color ? `#${home.team.color}` : null, awayColor: away.team.color ? `#${away.team.color}` : null,
      homeLeague: clubLeague(home.team.displayName), awayLeague: clubLeague(away.team.displayName),
      live: state === "in", statusText: state === "in" ? (comp.status.displayClock || "LIVE") : state === "post" ? "FT" : null,
      pred,
    };
  });
}

// the day's $10 parlays for the widget's Parlays view. Generation is expensive (per-game
// model + odds + public-betting fetches), so cache it and rebuild at most every PARLAY_TTL.
// parlays.mjs imports from this module, so import it lazily to avoid a load-time cycle.
let parlayCache = { at: 0, data: null };
const PARLAY_TTL = 30 * 60 * 1000; // 30 min
export async function getDailyParlays(stake = 10) {
  const now = Date.now();
  if (parlayCache.data && now - parlayCache.at < PARLAY_TTL) return parlayCache.data;
  const { generateDailyParlays } = await import("./parlays.mjs");
  const data = await generateDailyParlays(stake);
  parlayCache = { at: now, data };
  return data;
}

// the parlay-builder menu for the widget: upcoming games + their full priced candidate legs, so
// the user can assemble any parlay and see the model's grade. Same per-game cost as the daily
// card, so reuse the same TTL. parlays.mjs imports from this module — lazy import avoids a cycle.
let parlayMenuCache = { at: 0, data: null };
export async function getParlayMenu() {
  const now = Date.now();
  if (parlayMenuCache.data && now - parlayMenuCache.at < PARLAY_TTL) return parlayMenuCache.data;
  const { parlayMenu } = await import("./parlays.mjs");
  const data = await parlayMenu();
  parlayMenuCache = { at: now, data };
  return data;
}

// shape FanDuel's single-book props into the same structure the Odds-API path returns, so the
// renderer draws them unchanged. No other book, so best = null (nothing "beats FanDuel").
function mapFanduelProps(fd) {
  const price = (ml, implied) => ({ primary: fmtAmerican(ml), primaryRaw: ml, best: null, bestBook: null, bestRaw: null, beats: false, implied: implied ?? ml2prob(ml) });
  return {
    scorers: fd.scorers.map((s) => ({ player: s.player, prob: null, twoSided: false, price: price(s.ml, s.implied) })),
    sot: fd.sot.map((s) => ({ player: s.player, line: s.line, fairOver: s.fairOver, price: price(s.over) })),
    source: "fanduel",
  };
}

// pregame projections are only computed before kickoff; snapshot them (store.mjs: disk or Firestore)
// so we can show them again (to compare against the live/final stats) once the game has started.
// Keyed by event. An unchanged projection isn't re-saved — the page polls every 30 s, and on
// Firestore every save is a billed write.
function loadPregameStore() { return storeGet("pregame", {}); }
function savePregame(id, proj) {
  try {
    const store = loadPregameStore();
    if (store[id] && JSON.stringify(store[id].proj) === JSON.stringify(proj)) return;
    store[id] = { savedAt: Date.now(), proj };
    storeSet("pregame", store);
  } catch { /* best-effort */ }
}
function loadPregame(id) { const e = loadPregameStore()[id]; return e ? e.proj : null; }

// ── predictions: the model's pre-match call for every game it sees, frozen the first time and
// graded once the game is final. This is the model's own scorecard (the bet record is the
// card's). One entry per event: { game, date, homeAbbr, awayAbbr, pred:{ph,pa,wH,wD,wA,pOver25,
// pBTTS,basis}, frozenAt, actual:{h,a}, graded }.
function loadPredStore() { return storeGet("predictions", {}); }
function savePredStore(store) { try { storeSet("predictions", store); } catch { /* best-effort */ } }
// freeze once — the first pre-match look wins, so a later refresh can't quietly revise the call
// ...but only inside FREEZE_HORIZON_H of kickoff. "First sight" used to mean someone opening the
// widget near the game; the website's publisher sees every fixture the moment it enters the pool,
// weeks out, and would lock a call made before lines, form or team news existed.
const FREEZE_HORIZON_H = 48;
export function freezePrediction(ev, pred, scorers = null) {
  if (!pred || !ev) return;
  if (Date.parse(ev.date) - Date.now() > FREEZE_HORIZON_H * 3600e3) return;
  const store = loadPredStore();
  const prior = store[ev.id];
  const packScorers = (pp) => pp ? { home: (pp.home || []).filter((p) => p.scoreProb > 0).slice(0, 6).map((p) => ({ name: p.name, p: p.scoreProb })), away: (pp.away || []).filter((p) => p.scoreProb > 0).slice(0, 6).map((p) => ({ name: p.name, p: p.scoreProb })) } : null;
  if (prior) {
    // the slate's market call has no totals; the fuller match-view call may fill ONLY those in
    // (the 1X2 and scoreline stay as first frozen)
    let filled = false;
    if (prior.pred.pOver25 == null && pred.pOver25 != null) { prior.pred.pOver25 = pred.pOver25; filled = true; }
    if (prior.pred.pBTTS == null && pred.pBTTS != null) { prior.pred.pBTTS = pred.pBTTS; filled = true; }
    // the scorer projections come with the fuller match-view call; freeze them once too
    if (!prior.scorers && scorers && ((scorers.home || []).length || (scorers.away || []).length)) { prior.scorers = packScorers(scorers); filled = true; }
    if (filled) savePredStore(store);
    return;
  }
  const comp = ev.competitions[0];
  const home = comp.competitors.find((t) => t.homeAway === "home"), away = comp.competitors.find((t) => t.homeAway === "away");
  store[ev.id] = {
    game: `${home.team.abbreviation} v ${away.team.abbreviation}`, date: ev.date,
    homeAbbr: home.team.abbreviation, awayAbbr: away.team.abbreviation, homeLogo: home.team.logo || null, awayLogo: away.team.logo || null,
    pred: { ph: pred.ph, pa: pred.pa, wH: pred.wH, wD: pred.wD, wA: pred.wA, pOver25: pred.pOver25 ?? null, pBTTS: pred.pBTTS ?? null, basis: pred.basis || "market" },
    scorers: packScorers(scorers),
    frozenAt: Date.now(), actual: null, graded: false,
  };
  savePredStore(store);
}
// grade frozen calls against the finished events in the fixture pool; returns every entry with its
// grades plus the running tallies. Cheap (no network) — the pool is passed in.
export async function gradePredictions(events) {
  const store = loadPredStore();
  let changed = false;
  const nrm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z]/g, "");
  const lastTok = (s) => nrm((s || "").split(/\s+/).filter(Boolean).pop());
  for (const ev of events || []) {
    const e = store[ev.id];
    if (!e || e.graded) continue;
    const comp = ev.competitions[0];
    if (comp.status.type.state !== "post") continue;
    const home = comp.competitors.find((t) => t.homeAway === "home"), away = comp.competitors.find((t) => t.homeAway === "away");
    e.actual = { h: Number(home.score) || 0, a: Number(away.score) || 0 };
    // scorers: who actually scored, from the finished game's shot map (own goals excluded)
    if (e.scorers) {
      try {
        const xg = await fotmobXG({ name: home.team.displayName, abbr: home.team.abbreviation }, { name: away.team.displayName, abbr: away.team.abbreviation }, ev.date);
        const scored = (xg?.players || []).filter((p) => p.goals > 0);
        const hit = (name, side) => scored.some((q) => q.side === side && (nrm(q.name) === nrm(name) || nrm(q.name).includes(lastTok(name))));
        for (const side of ["home", "away"]) for (const p of e.scorers[side] || []) p.scored = hit(p.name, side);
        e.scorers.actual = { home: scored.filter((q) => q.side === "home").map((q) => q.name), away: scored.filter((q) => q.side === "away").map((q) => q.name) };
      } catch { /* leave the scorer grades for the next pass */ }
    }
    e.graded = true; changed = true;
  }
  if (changed) savePredStore(store);
  const rows = Object.entries(store).map(([id, e]) => {
    const p = e.pred, r = { id, ...e };
    if (e.actual) {
      const { h, a } = e.actual;
      const result = h > a ? "home" : a > h ? "away" : "draw";
      const call = p.wH >= p.wD && p.wH >= p.wA ? "home" : p.wA >= p.wD ? "away" : "draw";
      const pResult = result === "home" ? p.wH : result === "away" ? p.wA : p.wD;
      r.grade = {
        result, call, resultHit: call === result, exact: p.ph === h && p.pa === a, pResult,
        // Brier over the 1X2 (0 perfect, 0.667 for a flat guess)
        brier: [["home", p.wH], ["draw", p.wD], ["away", p.wA]].reduce((s, [k, q]) => s + (q - (k === result ? 1 : 0)) ** 2, 0),
        over25: h + a > 2.5, over25Call: p.pOver25 != null ? p.pOver25 >= 0.5 : null, over25Hit: p.pOver25 != null ? (p.pOver25 >= 0.5) === (h + a > 2.5) : null,
        btts: h > 0 && a > 0, bttsCall: p.pBTTS != null ? p.pBTTS >= 0.5 : null, bttsHit: p.pBTTS != null ? (p.pBTTS >= 0.5) === (h > 0 && a > 0) : null,
      };
    }
    return r;
  }).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const g = rows.filter((r) => r.grade);
  const rate = (arr, k) => { const v = arr.map((r) => r.grade[k]).filter((x) => x != null); return v.length ? v.filter(Boolean).length / v.length : null; };
  const stats = g.length ? {
    n: g.length, resultRate: rate(g, "resultHit"), exactRate: rate(g, "exact"), over25Rate: rate(g, "over25Hit"), bttsRate: rate(g, "bttsHit"),
    brier: g.reduce((s, r) => s + r.grade.brier, 0) / g.length, logScore: g.reduce((s, r) => s + Math.log(Math.max(r.grade.pResult, 0.01)), 0) / g.length,
  } : { n: 0 };
  // scorer projections: every projected player with a grade, pooled across games
  const sc = g.flatMap((r) => r.scorers ? ["home", "away"].flatMap((side) => (r.scorers[side] || []).filter((p) => p.scored != null)) : []);
  if (sc.length) {
    const tops = g.filter((r) => r.scorers).flatMap((r) => ["home", "away"].map((side) => (r.scorers[side] || [])[0]).filter((p) => p && p.scored != null));
    const bucket = (lo, hi) => { const b = sc.filter((p) => p.p >= lo && p.p < hi); return b.length ? { n: b.length, projected: b.reduce((s, p) => s + p.p, 0) / b.length, actual: b.filter((p) => p.scored).length / b.length } : null; };
    stats.scorers = {
      n: sc.length, games: g.filter((r) => r.scorers).length,
      topRate: tops.length ? tops.filter((p) => p.scored).length / tops.length : null, topN: tops.length,
      expected: sc.reduce((s, p) => s + p.p, 0), actual: sc.filter((p) => p.scored).length,
      brier: sc.reduce((s, p) => s + (p.p - (p.scored ? 1 : 0)) ** 2, 0) / sc.length,
      buckets: [["under 20%", bucket(0, 0.2)], ["20–40%", bucket(0.2, 0.4)], ["40%+", bucket(0.4, 1.01)]].filter(([, b]) => b),
    };
  }
  return { rows, stats };
}

// grade saved pregame projections against the actual final box score (corners total + total
// shots), persisting actuals so finished games aren't refetched. Returns accuracy aggregates:
// { corners: { n, mae, projAvg, actualAvg }, shots: {...} } — answers "are these any good?"
export async function getProjectionAccuracy() {
  const store = loadPregameStore();
  const num = (v) => parseInt(v || 0, 10) || 0;
  let changed = false;
  for (const id of Object.keys(store)) {
    const e = store[id];
    if (e.graded || !e.proj) continue;
    try {
      const sum = await summary(id);
      if (!sum.header?.competitions?.[0]?.status?.type?.completed) continue;
      const teams = sum.boxscore?.teams || [];
      const hm = statMap(teams[0] || {}), am = statMap(teams[1] || {});
      const corners = num(hm.wonCorners) + num(am.wonCorners);
      const shots = num(hm.totalShots) + num(am.totalShots);
      e.actual = { cornersTotal: corners || null, shotsTotal: shots || null };
      e.graded = true; changed = true;
    } catch { /* not final / fetch failed */ }
  }
  if (changed) { try { storeSet("pregame", store); } catch { /* ignore */ } }
  const cP = [], cA = [], sP = [], sA = [];
  for (const id of Object.keys(store)) {
    const e = store[id];
    if (!e.graded || !e.actual || !e.proj) continue;
    if (e.actual.cornersTotal != null && e.proj.corners?.total != null) { cP.push(e.proj.corners.total); cA.push(e.actual.cornersTotal); }
    const sProj = (e.proj.shots?.home?.shots || 0) + (e.proj.shots?.away?.shots || 0);
    if (e.actual.shotsTotal != null && sProj) { sP.push(sProj); sA.push(e.actual.shotsTotal); }
  }
  const agg = (P, A) => P.length ? {
    n: P.length,
    mae: P.reduce((s, p, i) => s + Math.abs(p - A[i]), 0) / P.length,
    projAvg: P.reduce((s, p) => s + p, 0) / P.length,
    actualAvg: A.reduce((s, a) => s + a, 0) / A.length,
  } : null;
  return { corners: agg(cP, cA), shots: agg(sP, sA) };
}

// the bet record for the widget: settles finished games, then returns calibration/performance
// stats plus the logged parlay history (newest day first). Cached briefly (settle hits network).
// betlog.mjs imports from this module, so import it lazily to avoid a load-time cycle.
let recordCache = { at: 0, data: null };
const RECORD_TTL = 5 * 60 * 1000; // 5 min
export async function getRecord() {
  const now = Date.now();
  if (recordCache.data && now - recordCache.at < RECORD_TTL) return recordCache.data;
  try {
    const bl = await import("./betlog.mjs");
    await bl.settle().catch(() => {});
    const log = bl.readLog();
    const projAccuracy = await getProjectionAccuracy().catch(() => null);
    const predictions = await gradePredictions(await fixturePool().catch(() => []));
    const data = { stats: bl.stats(), recent: bl.statsRecent(7), projAccuracy, goalsBias: bl.goalsBias(), predictions, days: (log.days || []).slice().reverse() }; // newest first
    recordCache = { at: now, data };
    return data;
  } catch (e) {
    return { error: String(e?.message || e), stats: null, days: [] };
  }
}

// persist a user-built parlay from the widget's Parlay Builder, then invalidate the record cache so
// the next getRecord() re-reads the log (and settles it as games finish). betlog imports from this
// module, so import it lazily to avoid a load-time cycle.
export async function trackParlay(payload) {
  const bl = await import("./betlog.mjs");
  const res = bl.trackParlay(payload);
  if (res?.ok) recordCache = { at: 0, data: null };
  return res;
}

// snapshot closing FanDuel prices for pending legs near kickoff (CLV read). Called from the
// widget's poll loop; betlog throttles itself internally. Lazy import — betlog imports from
// this module, so a static import would create a load-time cycle.
export async function captureClosing() {
  try {
    const bl = await import("./betlog.mjs");
    return await bl.captureClosing();
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}

// knockout rounds in bracket order (ESPN season.slug) — per competition
const KO_ORDER = COMP.koOrder;
const KO_LABEL = COMP.koLabel;

// two-legged ties: fold both legs of a pairing into ONE bracket entry — aggregate score, winner
// from the decisive leg — so the bracket shows ties, not games. Oriented as the 1st leg's
// home/away. Single-leg games in the round (the final) pass through untouched.
function foldLegs(games) {
  games.sort((x, y) => new Date(x.date) - new Date(y.date));
  const ties = [], byPair = new Map();
  for (const g of games) {
    if (!g.leg) { ties.push(g); continue; }
    const key = [g.homeAbbr, g.awayAbbr].sort().join("|");
    let t = byPair.get(key);
    if (!t) { t = { legs: [] }; byPair.set(key, t); ties.push(t); }
    t.legs.push(g);
  }
  for (const t of ties) {
    if (!t.legs) continue;
    const [l1, l2] = t.legs;
    // leg-2 sides are swapped relative to leg 1, so leg-2 away goals belong to the leg-1 home side
    const hAgg = l1.homeScore + (l2 ? l2.awayScore : 0), aAgg = l1.awayScore + (l2 ? l2.homeScore : 0);
    const done = !!l2 && l2.state === "post", live = t.legs.some((l) => l.state === "in");
    const played = t.legs.some((l) => l.state === "post");
    let homeWin = false, awayWin = false;
    if (done) {
      if (hAgg > aAgg) homeWin = true; else if (aAgg > hAgg) awayWin = true;
      else { homeWin = l2.awayWin; awayWin = l2.homeWin; } // level on aggregate: ET/pens in leg 2
    }
    // click target: the live leg, else the most recent leg that has started, else the 1st leg
    const focus = t.legs.find((l) => l.state === "in") || [...t.legs].reverse().find((l) => l.state !== "pre") || l1;
    Object.assign(t, {
      id: focus.id, date: l1.date, leg: null,
      homeAbbr: l1.homeAbbr, awayAbbr: l1.awayAbbr, homeLogo: l1.homeLogo, awayLogo: l1.awayLogo,
      homeScore: hAgg, awayScore: aAgg, played,
      homeShoot: done && l2.awayShoot != null ? l2.awayShoot : null,
      awayShoot: done && l2.homeShoot != null ? l2.homeShoot : null,
      homeWin, awayWin,
      state: done ? "post" : live ? "in" : "pre",
      statusText: live ? (t.legs.find((l) => l.state === "in").statusText || "LIVE") : done ? "FT" : null,
      legScores: t.legs.map((l) => (l.state === "pre" ? null : `${l.homeScore}–${l.awayScore}`)),
      nextLeg: !done && l2 && l1.state === "post" ? l2.date : null,
      pred: !played ? l1.pred : null,
    });
  }
  return ties;
}

// scan fixtures for knockout games (season.slug not a phase slug), grouped by round. The whole
// knockout window is scanned in one ranged call — a rolling window anchored on today drops the
// early rounds off the bracket as the tournament progresses.
async function scanKnockout() {
  if (!COMP.knockoutWindow) return []; // a domestic league has no bracket
  const [from, to] = COMP.knockoutWindow;
  const board = await scoreboardRange(from, to).catch(() => ({ events: [] }));
  const seen = new Set(), byRound = new Map();
  for (const ev of board.events || []) {
    const slug = ev.season?.slug || "";
    // koSide: knockout games that aren't a bracket round (the Nations League's promotion/relegation
    // play-offs are ties between tiers — drawn as the bracket's first column they'd look like R16)
    if (isPhaseSlug(slug) || (COMP.koSide || []).includes(slug) || seen.has(ev.id)) continue;
    seen.add(ev.id);
    const c = ev.competitions[0];
    const home = c.competitors.find((t) => t.homeAway === "home"), away = c.competitors.find((t) => t.homeAway === "away");
    const st = c.status.type.state;
    (byRound.get(slug) || byRound.set(slug, []).get(slug)).push({
      id: ev.id, date: ev.date, leg: c.leg?.value ? Number(c.leg.value) : null,
      homeAbbr: home.team.abbreviation, awayAbbr: away.team.abbreviation, homeLogo: home.team.logo, awayLogo: away.team.logo,
      homeScore: Number(home.score) || 0, awayScore: Number(away.score) || 0,
      // shootout scores + explicit winner flags. With pens the 90' scores stay level, so the
      // bracket can't infer the winner from score — ESPN sets competitor.winner on finished games.
      homeShoot: home.shootoutScore != null ? Number(home.shootoutScore) : null,
      awayShoot: away.shootoutScore != null ? Number(away.shootoutScore) : null,
      homeWin: home.winner === true, awayWin: away.winner === true,
      state: st, statusText: st === "in" ? (c.status.displayClock || "LIVE") : st === "post" ? "FT" : null,
      // "model favors X%" chip on unplayed ties — ESPN's inline line, zero extra fetch cost
      pred: st === "pre" ? espnMarketPrediction(ev) : null,
    });
  }
  return [...byRound.entries()]
    .sort((a, b) => KO_ORDER.indexOf(a[0]) - KO_ORDER.indexOf(b[0]))
    .map(([slug, games]) => ({
      slug, label: KO_LABEL[slug] || slug,
      games: COMP.twoLegged ? foldLegs(games) : games.sort((x, y) => new Date(x.date) - new Date(y.date)),
    }));
}

// group standings (all 12 groups) + a knockout bracket once the group stage finishes. Cached.
let standingsCache = { at: 0, data: null };
const STANDINGS_TTL = 10 * 60 * 1000;
export async function getStandings() {
  const now = Date.now();
  if (standingsCache.data && now - standingsCache.at < STANDINGS_TTL) return standingsCache.data;
  try {
    const j = await getJSON(STANDINGS_URL);
    const num = (st, k) => (st[k] ? (st[k].value ?? parseFloat(st[k].displayValue)) : null);
    const groups = (j.children || []).map((g) => {
      const entries = (g.standings?.entries || []).map((e) => {
        const st = Object.fromEntries((e.stats || []).map((s) => [s.name, s]));
        return {
          abbr: e.team?.abbreviation || "", name: e.team?.displayName || "", logo: e.team?.logos?.[0]?.href || null, league: clubLeague(e.team?.displayName),
          rank: num(st, "rank"), played: num(st, "gamesPlayed") || 0,
          w: num(st, "wins") || 0, d: num(st, "ties") || 0, l: num(st, "losses") || 0,
          gd: st.pointDifferential?.displayValue ?? String(num(st, "pointDifferential") ?? "0"),
          pts: num(st, "points") || 0, advanced: num(st, "advanced") === 1,
        };
      }).sort((a, b) => (a.rank || 99) - (b.rank || 99));
      // qualification zone by rank (e.g. UCL: 1–8 straight through, 9–24 play-off) for row colouring.
      // A tiered competition (the Nations League) has its own zones, games and words per tier.
      const name = g.name || g.abbreviation || "Group";
      const rules = groupRules(name);
      for (const e of entries) e.zone = (rules.zones.find((z) => e.rank != null && e.rank <= z.upTo) || {}).cls || null;
      return { name, entries, games: rules.games, tier: rules.tier, zoneLabels: rules.zoneLabels, cuts: rules.cuts };
    });
    const groupStageDone = COMP.koOrder.length > 0 && groups.length > 0 && groups.every((g) => g.entries.length && g.entries.every((e) => e.played >= g.games));
    const knockout = await scanKnockout().catch(() => []);
    const data = { groups, groupStageDone, knockout, comp: compMeta() };
    standingsCache = { at: now, data };
    return data;
  } catch (e) {
    return { error: String(e?.message || e), groups: [], knockout: [] };
  }
}

// high-level state for the widget: a single match view (by query, or the lone live game),
// plus the day's match list for the picker. Never throws — returns { error } instead.
export async function getWidgetState(query) {
  try {
    // pull previous days + today + the next 2 (merged, de-duped) so BOTH past (finished) and
    // future games from the picker resolve — not just today's. Previously this used today-only
    // scoreboard(), so clicking a past or future game found nothing and showed a blank view.
    const events = await fixturePool();
    let ev = null;
    // a stale saved query (a match from a past window/competition) must not blank the widget —
    // fall through to the auto pick when it matches nothing
    if (query) ev = findEvent(events, query);
    if (!ev) {
      // auto: prefer a live game; otherwise fall back to the soonest upcoming one so the
      // widget always shows something useful
      const live = events.filter((e) => e.competitions[0].status.type.state === "in");
      if (live.length) ev = live[0];
      else {
        const upcoming = events
          .filter((e) => e.competitions[0].status.type.state === "pre")
          .sort((a, b) => new Date(a.date) - new Date(b.date));
        ev = upcoming[0] || events[0] || null;
      }
    }
    const matches = await listMatchesData().catch(() => []);
    if (!ev) return { match: null, matches, comp: compMeta() };

    const sum = await summary(ev.id);
    let liveOdds = null;
    if (ODDS_KEY) {
      try {
        const comp = ev.competitions[0];
        const h = comp.competitors.find((t) => t.homeAway === "home");
        const a = comp.competitors.find((t) => t.homeAway === "away");
        liveOdds = matchOdds(await fetchOddsEvents(oddsTtlFor(comp.status?.type?.state)), h.team.displayName, a.team.displayName);
      } catch { /* fall back to ESPN pre-match */ }
    }
    const comp0 = ev.competitions[0];
    const h0 = comp0.competitors.find((t) => t.homeAway === "home");
    const a0 = comp0.competitors.find((t) => t.homeAway === "away");
    const homeRef = { name: h0.team.displayName, abbr: h0.team.abbreviation };
    const awayRef = { name: a0.team.displayName, abbr: a0.team.abbreviation };
    // real xG once live; Action Network splits + FanDuel odds always; pregame projections
    // (corners/saves/xG priors from Round 1 form) only before kickoff — all best-effort, parallel
    const isPre = comp0.status.type.state === "pre";
    const [realXG, publicBetting, priors, conditions] = await Promise.all([
      isPre ? Promise.resolve(null) : fotmobXG(homeRef, awayRef, ev.date),
      actionPublicBetting(homeRef, awayRef),
      isPre ? pregameProjections(homeRef, awayRef) : Promise.resolve(null),
      matchConditions(ev, homeRef, awayRef),
    ]);
    // persist the pregame projection while still pre; once live/finished, re-attach the saved
    // snapshot so the section stays visible to compare against the actual stats. (scorePrediction
    // only blends priors when state==="pre", so a restored snapshot never alters the live model.)
    let pregame = priors;
    if (isPre && priors) savePregame(ev.id, priors);
    else if (!isPre) {
      const saved = loadPregame(ev.id);
      if (saved) pregame = { ...saved, basis: `${saved.basis || "pre"} · saved pre-kickoff` };
    }
    // goal-expectation calibration factor (learned from settled Total legs). Lazy import — betlog
    // imports from this module, so a static import would create a load-time cycle.
    const gb = await import("./betlog.mjs").then((b) => b.goalsBias().factor).catch(() => 1);
    const view = buildMatchView(ev, sum, liveOdds, realXG, publicBetting, pregame, conditions, gb);
    if (isPre && view.prediction) freezePrediction(ev, view.prediction);
    // (the scorer projections are built a little further down; they're frozen there)
    // the frozen pre-match call rides along so a live or finished game can show what was predicted
    view.frozen = loadPredStore()[ev.id] || null;
    // pre-match there's no FotMob match page to read form from — take the last five results from
    // the clubs' own fixture lists (any competition)
    if (!view.form) {
      const [fh, fa] = await Promise.all([fotmobRecentForm(homeRef), fotmobRecentForm(awayRef)]);
      if (fh.length || fa.length) view.form = { home: fh, away: fa };
    }
    // league-phase matchday pill (knockout games carry a round tag instead)
    if (!view.round) view.matchday = await fotmobMatchday(homeRef, awayRef, ev.date);
    // formations, per-player ratings and the shot map for the pitch card (pre-match too — the
    // confirmed XIs land about an hour out); same cached FotMob page fetch as the xG above
    view.pitch = await fotmobPitch(homeRef, awayRef, ev.date);
    // pre-match per-player projections (model est., display-only) from recent form — feeds both
    // the projected shots-on-target and predicted-scorer sections in the widget
    if (isPre) {
      try {
        // pass each side's opponent so the per-player projection is matchup-adjusted (home
        // players vs the away defence, and vice-versa)
        const [hp, ap] = await Promise.all([fotmobPlayerSOT(homeRef, awayRef), fotmobPlayerSOT(awayRef, homeRef)]);
        if ((hp && hp.length) || (ap && ap.length)) { view.playerProj = { home: hp || [], away: ap || [] }; if (view.prediction) freezePrediction(ev, view.prediction, view.playerProj); }
      } catch { /* best-effort */ }
    }
    // FanDuel's own public player props (computed once): used both for the props section fallback
    // and to show FanDuel's anytime-scorer price next to the model's predicted-scorer %.
    let fd = null;
    try { fd = await fanduelProps(homeRef, awayRef); } catch { fd = null; }
    // player props: prefer The Odds API (multi-book, de-vigged consensus). When it's
    // unavailable (no key / quota / 401), fall back to FanDuel's own public prices.
    let props = null;
    const gameState = comp0.status?.type?.state;
    if (liveOdds?.ev?.id && gameState !== "post") { try { props = await fetchPlayerProps(liveOdds.ev.id, oddsTtlFor(gameState)); } catch { props = null; } }
    if ((!props || (!props.scorers?.length && !props.sot?.length)) && fd && (fd.scorers.length || fd.sot.length)) props = mapFanduelProps(fd);
    view.playerProps = props;
    // FanDuel anytime-goalscorer prices [{ player, ml, implied }] for the predicted-scorer compare
    if (fd && fd.scorers?.length) view.fdScorers = fd.scorers;
    return { match: view, matches, comp: compMeta() };
  } catch (e) {
    return { error: String(e?.message || e), matches: [], comp: compMeta() };
  }
}
