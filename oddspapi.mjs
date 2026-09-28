// oddspapi — Corners (O/U) and Both-Teams-To-Score markets for the active competition via the OddsPapi
// API (free tier, multi-book). FanDuel's public API is flaky to reach; OddsPapi reliably carries
// these for WC fixtures, so we use it as the PRIMARY source for corner + BTTS legs (FanDuel's
// public API stays a fallback). One odds-by-tournaments call covers every game, so it's light on
// the 250-req/month free quota. Never throws — returns null on any miss.
//
// Key lives in odds.config.json as "oddspapiKey" (gitignored), or the ODDSPAPI_KEY env var.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { COMP, readConfig } from "./competition.mjs";
import { teamMatch, isNation } from "./teams.mjs";

const API = "https://api.oddspapi.io/v4";
const SOCCER = 10, WC = COMP.oddspapiTournamentId; // "WC" = the active competition's tournamentId
const H = { Accept: "application/json", "User-Agent": "futbol-lab" };

const cfg = () => readConfig();
const KEY = process.env.ODDSPAPI_KEY || cfg().oddspapiKey || null;
// books to try in order for the price (the venue you bet first, then a liquid backup). Kept to
// two to limit how many calls a cache-miss can cost against the 250-req/month free quota.
const BOOKS = (process.env.ODDSPAPI_BOOKS || cfg().oddspapiBooks || "fanduel,bet365").split(",").map((s) => s.trim()).filter(Boolean);

// calls this process has made, and a cap the website's publisher sets from the competition's monthly
// budget (the free tier is shared with Pick Six). Past the cap every call fails like a dead feed.
export const oddspapiUsage = { calls: 0, cap: Infinity };
const get = async (path) => {
  if (oddspapiUsage.calls >= oddspapiUsage.cap) throw new Error("OddsPapi monthly budget for this competition is spent");
  oddspapiUsage.calls++;
  const r = await fetch(`${API}${path}${path.includes("?") ? "&" : "?"}apiKey=${KEY}`, { headers: H });
  if (!r.ok) throw new Error(`OddsPapi HTTP ${r.status}`);
  return r.json();
};
const arr = (j) => (Array.isArray(j) ? j : (j?.data || []));
const norm = (s) => (s || "").toLowerCase().replace(/[^a-z]/g, "");

// static market catalogue: marketId -> { marketName, marketType, handicap, outcomes } (cached 12h)
let _markets = { at: 0, map: null };
async function marketsRef() {
  const now = Date.now();
  if (_markets.map && now - _markets.at < 12 * 3600 * 1000) return _markets.map;
  const map = {};
  for (const m of arr(await get("/markets"))) map[m.marketId] = m;
  _markets = { at: now, map };
  return map;
}

// WC fixtures with team names/abbrs, keyed by fixtureId (cached 2h — fixtures don't change intraday)
let _fix = { at: 0, map: null };
async function fixtureNames() {
  const now = Date.now();
  if (_fix.map && now - _fix.at < 2 * 3600 * 1000) return _fix.map;
  const ymd = (off) => new Date(now + off * 86400000).toISOString().slice(0, 10);
  const map = {};
  for (const f of arr(await get(`/fixtures?sportId=${SOCCER}&tournamentIds=${WC}&from=${ymd(-2)}&to=${ymd(7)}`)))
    map[f.fixtureId] = { names: [f.participant1Name, f.participant2Name], abbrs: [f.participant1Abbr, f.participant2Abbr] };
  _fix = { at: now, map };
  return map;
}

// one bookmaker's odds for every WC fixture (all markets), cached per book (30 min — matches the
// parlay cache, and pre-match corner/BTTS lines barely move; keeps monthly call count low)
const _odds = new Map();
async function tournamentOdds(book) {
  const now = Date.now();
  const hit = _odds.get(book);
  if (hit && now - hit.at < 30 * 60 * 1000) return hit.data;
  const data = arr(await get(`/odds-by-tournaments?bookmaker=${book}&tournamentIds=${WC}`));
  _odds.set(book, { at: now, data });
  return data;
}

// the markets object for the first book that covers this ESPN match (home/away { name, abbr })
async function matchMarkets(home, away) {
  const all = await allBookMarkets(home, away, true);
  return all.length ? all[0] : null;
}

// the markets object for EVERY configured book that covers this match — the basis for line
// shopping (best price per outcome across books). `firstOnly` keeps the old single-book cost
// profile for callers that don't shop.
async function allBookMarkets(home, away, firstOnly = false) {
  if (!KEY) return [];
  const names = await fixtureNames();
  // strict club match on the fixture's names (teams.mjs); its abbr field only by exact equality
  // national teams never fall back to the abbreviation: "England Women" shares ENG with England
  const hit = (fx, ref) => fx && (fx.names.some((n) => teamMatch(n, ref.name)) || (!(fx.names.length && isNation(ref.name)) && fx.abbrs.some((a) => a && ref.abbr && a.toUpperCase() === ref.abbr.toUpperCase())));
  const out = [];
  for (const book of BOOKS) {
    let odds;
    try { odds = await tournamentOdds(book); } catch { continue; }
    const fx = odds.find((f) => {
      const toks = names[f.fixtureId];
      return f.bookmakerOdds?.[book] && toks && hit(toks, home) && hit(toks, away);
    });
    if (fx) {
      out.push({ markets: fx.bookmakerOdds[book].markets || {}, book });
      if (firstOnly) return out;
    }
  }
  return out;
}

// american price for the first outcome whose name matches rx, via the market catalogue
function priceByName(market, ref, rx) {
  for (const o of ref.outcomes || []) {
    if (rx.test(o.outcomeName)) {
      const p = Object.values(market.outcomes?.[o.outcomeId]?.players || {})[0];
      if (p?.priceAmerican != null) return Number(p.priceAmerican);
    }
  }
  return null;
}
const implied = (ml) => (ml == null ? null : ml > 0 ? 100 / (ml + 100) : -ml / (-ml + 100));

// full-match total corners over/under for a match → { line, over, under } (main line) or null
export async function oddspapiCorners(home, away) {
  try {
    const mm = await matchMarkets(home, away);
    if (!mm) return null;
    const ref = await marketsRef();
    const lines = [];
    for (const id of Object.keys(mm.markets)) {
      const r = ref[id];
      if (!r || r.marketType !== "totals-corners" || /half/i.test(r.marketName)) continue;
      const over = priceByName(mm.markets[id], r, /over/i), under = priceByName(mm.markets[id], r, /under/i);
      if (r.handicap != null && over != null) lines.push({ line: r.handicap, over, under });
    }
    if (!lines.length) return null;
    // main line = the most balanced (over-implied closest to 50%) — the book's headline number
    lines.sort((a, b) => Math.abs(implied(a.over) - 0.5) - Math.abs(implied(b.over) - 0.5));
    return { ...lines[0], source: "oddspapi" };
  } catch { return null; }
}

// Draw No Bet + team totals + Asian handicap for a match, from the SAME cached
// odds-by-tournaments response the corner/BTTS calls use — these markets were always in the
// payload, we just threw them away. Prices are the BEST across configured books (line shopping);
// outcome names per the catalogue: 1x2-style markets use "1"/"2", totals use "Over"/"Under",
// spread handicaps are from team 1's (home's) perspective. Only half-goal handicaps are kept so
// there are no pushes to model on spreads. Returns null on any miss, never throws.
// Shape: { dnb: {home,away}|null, teamTotals: {home:[{line,over,under}],away:[...]}, spreads:[{hcap,home,away}] }
export async function oddspapiSides(home, away) {
  try {
    const books = await allBookMarkets(home, away);
    if (!books.length) return null;
    const ref = await marketsRef();
    const dec = (ml) => (ml > 0 ? ml / 100 + 1 : 100 / -ml + 1);
    const better = (a, b) => (a == null ? b : b == null ? a : dec(b) > dec(a) ? b : a);
    const dnb = { home: null, away: null };
    const tt = { home: new Map(), away: new Map() };
    const sp = new Map();
    for (const { markets } of books) {
      for (const id of Object.keys(markets)) {
        const r = ref[id];
        if (!r || /half/i.test(r.marketName)) continue;
        if (r.marketType === "drawnobet") {
          dnb.home = better(dnb.home, priceByName(markets[id], r, /^1$/));
          dnb.away = better(dnb.away, priceByName(markets[id], r, /^2$/));
        } else if ((r.marketType === "teamtotals-team1" || r.marketType === "teamtotals-team2") && r.handicap != null) {
          const side = r.marketType.endsWith("team1") ? "home" : "away";
          const cur = tt[side].get(r.handicap) || { line: r.handicap, over: null, under: null };
          cur.over = better(cur.over, priceByName(markets[id], r, /over/i));
          cur.under = better(cur.under, priceByName(markets[id], r, /under/i));
          tt[side].set(r.handicap, cur);
        } else if (r.marketType === "spreads" && r.handicap != null && Math.abs(r.handicap % 1) === 0.5 && Math.abs(r.handicap) <= 2.5) {
          const cur = sp.get(r.handicap) || { hcap: r.handicap, home: null, away: null };
          cur.home = better(cur.home, priceByName(markets[id], r, /^1$/));
          cur.away = better(cur.away, priceByName(markets[id], r, /^2$/));
          sp.set(r.handicap, cur);
        }
      }
    }
    const lines = (m) => [...m.values()].filter((l) => l.over != null && l.under != null).sort((a, b) => a.line - b.line);
    const out = {
      dnb: dnb.home != null || dnb.away != null ? dnb : null,
      teamTotals: { home: lines(tt.home), away: lines(tt.away) },
      spreads: [...sp.values()].filter((s) => s.home != null || s.away != null).sort((a, b) => a.hcap - b.hcap),
      source: "oddspapi",
    };
    return out.dnb || out.teamTotals.home.length || out.teamTotals.away.length || out.spreads.length ? out : null;
  } catch { return null; }
}

// full-match both-teams-to-score for a match → { yes, no } or null
export async function oddspapiBTTS(home, away) {
  try {
    const mm = await matchMarkets(home, away);
    if (!mm) return null;
    const ref = await marketsRef();
    for (const id of Object.keys(mm.markets)) {
      const r = ref[id];
      if (!r || r.marketType !== "bothteamsscore" || /half/i.test(r.marketName)) continue;
      const yes = priceByName(mm.markets[id], r, /yes/i), no = priceByName(mm.markets[id], r, /no/i);
      if (yes != null) return { yes, no, source: "oddspapi" };
    }
    return null;
  } catch { return null; }
}
