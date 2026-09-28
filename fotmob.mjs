// fotmob — free xG / shot-level + match data for the active competition.
//
// FotMob is a Next.js app. Its /api/* endpoints are gated behind a rotating signed
// `x-mas` header, but the public pages embed the same server-rendered data in a
// <script id="__NEXT_DATA__"> tag, which is NOT gated. We read that JSON: no key, no auth.
//
// One match-page fetch (cached) yields shots, momentum, team stats (real xG / xGOT / big
// chances), top players, and recent form. Unofficial source — best-effort: any failure
// returns null and callers fall back to their proxy. Never throws to callers.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
import { COMP } from "./competition.mjs";
// FotMob league(s) for the active competition — usually one; the Nations League is one per tier (A–D)
const FM_LEAGUES = COMP.fotmob.leagues || [COMP.fotmob];
const FIXTURES_TTL = 10 * 60 * 1000;   // fixture list changes rarely
const MATCH_TTL = 45 * 1000;           // a live match's data updates as it plays

async function getHtml(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en-US" } });
  if (!res.ok) throw new Error(`FotMob HTTP ${res.status}`);
  return res.text();
}

// every FotMob page embeds its server props here — `props.pageProps` is the payload
function nextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]).props?.pageProps ?? null; } catch { return null; }
}

import { teamMatch } from "./teams.mjs";
// ESPN ref { name, abbr } ↔ FotMob team name — strict (see teams.mjs); abbreviations never match
const nameMatch = teamMatch;
const sideMatch = (anName, t) => teamMatch(anName, t?.name);

let _fixtures = { at: 0, data: null };
// full WC fixture list: [{ id, pageUrl, home:{id,name}, away:{id,name}, utcTime, finished, started }]
export async function fetchFotmobFixtures() {
  const now = Date.now();
  if (_fixtures.data && now - _fixtures.at < FIXTURES_TTL) return _fixtures.data;
  // every league page in parallel; one dead tier just drops its games, all dead throws as before
  const pages = await Promise.allSettled(FM_LEAGUES.map((l) => getHtml(`https://www.fotmob.com/leagues/${l.leagueId}/matches/${l.slug}`).then(nextData)));
  if (!pages.some((p) => p.status === "fulfilled")) throw pages[0].reason;
  const all = pages.flatMap((p) => (p.status === "fulfilled" ? p.value?.fixtures?.allMatches || [] : []));
  const data = all.map((m) => ({
    id: String(m.id),
    pageUrl: m.pageUrl,
    round: m.round != null ? Number(m.round) || null : null, // league-phase matchday (1–8)
    home: { id: m.home?.id, name: m.home?.name },
    away: { id: m.away?.id, name: m.away?.name },
    utcTime: m.status?.utcTime || null,
    finished: !!m.status?.finished,
    started: !!m.status?.started,
  }));
  _fixtures = { at: now, data };
  return data;
}

const _matches = new Map(); // pageUrl -> { at, data }
// raw match content (cached): teams, shots, momentum series, stats blob, top players, form
export async function fetchFotmobMatch(pageUrl) {
  if (!pageUrl) return null;
  const now = Date.now();
  const hit = _matches.get(pageUrl);
  if (hit && now - hit.at < MATCH_TTL) return hit.data;
  const pp = nextData(await getHtml(`https://www.fotmob.com${pageUrl}`));
  const g = pp?.general, content = pp?.content;
  if (!g || !content) return null;
  const data = {
    homeTeam: { id: g.homeTeam?.id, name: g.homeTeam?.name },
    awayTeam: { id: g.awayTeam?.id, name: g.awayTeam?.name },
    shots: content.shotmap?.shots || [],
    momentum: content.momentum?.main?.data || content.matchFacts?.momentum?.main?.data || [],
    stats: content.stats,
    topPlayers: content.matchFacts?.topPlayers,
    teamForm: content.matchFacts?.teamForm,
    lineup: content.lineup || null,               // formations + starters with pitch coordinates
    attackingZones: content.attackingZones || null, // % of attacks down the left / centre / right
  };
  _matches.set(pageUrl, { at: now, data });
  return data;
}

// aggregate the shotmap into team + per-player xG, oriented to FotMob's own home/away.
export function aggregateShotmap(shots, homeId, awayId) {
  const side = (teamId) => (teamId === homeId ? "home" : teamId === awayId ? "away" : null);
  const team = { home: { xg: 0, shots: 0, sot: 0, goals: 0 }, away: { xg: 0, shots: 0, sot: 0, goals: 0 } };
  const byPlayer = new Map();
  for (const s of shots || []) {
    const sd = side(s.teamId);
    if (!sd) continue;
    const xg = Number(s.expectedGoals) || 0;
    const isGoal = s.eventType === "Goal";
    team[sd].xg += xg; team[sd].shots += 1;
    if (s.isOnTarget) team[sd].sot += 1;
    if (isGoal) team[sd].goals += 1;
    const key = `${s.playerName}|${sd}`;
    const p = byPlayer.get(key) || { name: s.playerName, side: sd, xg: 0, shots: 0, sot: 0, goals: 0 };
    p.xg += xg; p.shots += 1;
    if (s.isOnTarget) p.sot += 1;
    if (isGoal) p.goals += 1;
    byPlayer.set(key, p);
  }
  return { home: team.home, away: team.away, players: [...byPlayer.values()].sort((a, b) => b.xg - a.xg) };
}

// pull a {home, away} numeric pair for a stat by title from FotMob's stats blob
function statPair(stats, ...titles) {
  const groups = stats?.Periods?.All?.stats || [];
  const want = titles.map((t) => t.toLowerCase());
  for (const g of groups) {
    for (const s of g.stats || []) {
      if (want.includes((s.title || "").toLowerCase()) && Array.isArray(s.stats) && s.stats[0] != null) {
        return { home: Number(s.stats[0]), away: Number(s.stats[1]) };
      }
    }
  }
  return null;
}

// top 3 players by rating per side: [{ name, rating }]
function parseTopPlayers(tp) {
  const conv = (obj) => Object.values(obj || {})
    .map((p) => ({ name: p?.name?.fullName || p?.name, rating: Number(p?.playerRating) || Number(p?.playerRatingRounded) || null }))
    .filter((p) => p.name && p.rating != null)
    .sort((a, b) => b.rating - a.rating)
    .slice(0, 3);
  if (!tp) return null;
  return { home: conv(tp.homeTopPlayers), away: conv(tp.awayTopPlayers) };
}

// recent form as ["W","D","L",...] (most recent last), per side
function parseForm(tf) {
  if (!Array.isArray(tf)) return null;
  const code = { 1: "W", 0: "D", 2: "L" };
  const fmt = (arr) => (arr || []).map((x) => x.resultString || code[x.result] || "").filter(Boolean).slice(-5);
  return { home: fmt(tf[0]), away: fmt(tf[1]) };
}

const orientPair = (pair, aligned) => (!pair ? null : aligned ? pair : { home: pair.away, away: pair.home });

// ── a club's recent matches across EVERY competition ────────────────────────────────────────
// On matchday 1 nobody has Champions League history, so form, priors and scorer projections were
// empty. FotMob's team page lists the club's whole season (league, cup, Europe) with the same
// match-page links the xG parser reads, so recent form comes from wherever the club last played.
// Friendlies are skipped. Falls back to the competition's own fixture list if the page fails.
const TEAM_TTL = 30 * 60 * 1000;
const _teams = new Map(); // teamId -> { at, fixtures }
async function fetchTeamFixtures(teamId) {
  const now = Date.now();
  const hit = _teams.get(teamId);
  if (hit && now - hit.at < TEAM_TTL) return hit.fixtures;
  const pp = nextData(await getHtml(`https://www.fotmob.com/teams/${teamId}`));
  const team = pp?.fallback?.[`team-${teamId}`];
  const all = team?.fixtures?.allFixtures?.fixtures || [];
  const fixtures = all.map((f) => ({
    id: String(f.id), pageUrl: f.pageUrl,
    home: { id: f.home?.id, name: f.home?.name, score: f.home?.score ?? null }, away: { id: f.away?.id, name: f.away?.name, score: f.away?.score ?? null },
    utcTime: f.status?.utcTime || null, finished: !!f.status?.finished,
    competition: f.tournament?.name || "", friendly: /friendl/i.test(f.tournament?.name || ""),
  }));
  _teams.set(teamId, { at: now, fixtures });
  return fixtures;
}
// FotMob id for an ESPN ref { name, abbr }, from the competition's fixture list
async function teamId(team) {
  const fixtures = await fetchFotmobFixtures();
  for (const f of fixtures) { if (sideMatch(f.home.name, team)) return f.home.id; if (sideMatch(f.away.name, team)) return f.away.id; }
  return null;
}
// the club's last `lookback` finished competitive matches, newest first, from any competition
export async function recentMatches(team, lookback = 3) {
  const ucl = (await fetchFotmobFixtures()).filter((f) => f.finished && (sideMatch(f.home.name, team) || sideMatch(f.away.name, team)));
  let pool = ucl;
  try {
    const id = await teamId(team);
    if (id) {
      const all = (await fetchTeamFixtures(id)).filter((f) => f.finished && !f.friendly && f.pageUrl);
      if (all.length) pool = all;
    }
  } catch { /* team page unavailable — the competition list will do */ }
  return pool.sort((a, b) => String(b.utcTime || "").localeCompare(String(a.utcTime || ""))).slice(0, lookback);
}

// W/D/L strip for the last `n` competitive games in any competition, oldest → newest
export async function fotmobRecentForm(team, n = 5) {
  try {
    const games = (await recentMatches(team, n)).filter((f) => f.home.score != null && f.away.score != null);
    return games.reverse().map((f) => {
      const mine = sideMatch(f.home.name, team) ? [f.home.score, f.away.score] : [f.away.score, f.home.score];
      return mine[0] > mine[1] ? "W" : mine[0] < mine[1] ? "L" : "D";
    });
  } catch { return []; }
}

// A team's recent form, AVERAGED over its last few finished matches (default 3, any competition) — far more
// stable than a single game, and it actually picks up scoring outbursts/droughts. Rates are
// oriented as for/against and include REAL goals (from the shotmap), not just xG, so a 7-goal
// blowout lifts the attack estimate the way the eye test expects. null if no finished match.
// team is { name, abbr }.
export async function fotmobTeamRates(team, lookback = 3) {
  try {
    const played = await recentMatches(team, lookback);
    if (!played.length) return null;
    const acc = { xgFor: [], xgAgainst: [], goalsFor: [], goalsAgainst: [], cornersFor: [], cornersAgainst: [], sotFor: [], sotAgainst: [], shotsFor: [], shotsAgainst: [] };
    for (const f of played) {
      const m = await fetchFotmobMatch(f.pageUrl);
      if (!m) continue;
      const isHome = sideMatch(m.homeTeam.name, team);
      const pick = (pair) => (pair ? (isHome ? { for: pair.home, against: pair.away } : { for: pair.away, against: pair.home }) : null);
      const push = (key, pair) => { if (pair) { acc[`${key}For`].push(pair.for); acc[`${key}Against`].push(pair.against); } };
      push("xg", pick(statPair(m.stats, "Expected goals (xG)", "Expected goals")));
      push("corners", pick(statPair(m.stats, "Corners")));
      push("sot", pick(statPair(m.stats, "Shots on target")));
      push("shots", pick(statPair(m.stats, "Total shots", "Shots")));
      if ((m.shots || []).length) {
        const sm = aggregateShotmap(m.shots, m.homeTeam.id, m.awayTeam.id);
        push("goals", isHome ? { for: sm.home.goals, against: sm.away.goals } : { for: sm.away.goals, against: sm.home.goals });
      }
    }
    const avg = (a, d) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : d);
    const games = Math.max(acc.xgFor.length, acc.goalsFor.length, acc.shotsFor.length);
    if (!games) return null;
    return {
      games, competitions: [...new Set(played.map((f) => f.competition).filter(Boolean))],
      xgFor: avg(acc.xgFor, 1.3), xgAgainst: avg(acc.xgAgainst, 1.3),
      goalsFor: avg(acc.goalsFor, 1.3), goalsAgainst: avg(acc.goalsAgainst, 1.3),
      cornersFor: avg(acc.cornersFor, 5), cornersAgainst: avg(acc.cornersAgainst, 5),
      sotFor: avg(acc.sotFor, 4), sotAgainst: avg(acc.sotAgainst, 4),
      shotsFor: avg(acc.shotsFor, 12), shotsAgainst: avg(acc.shotsAgainst, 12),
    };
  } catch {
    return null;
  }
}

// Per-player shots-on-target + anytime-score projection from a team's recent shotmaps (last 3
// games). For each recent match we read the shotmap, keep this team's players, and average their
// SOT/xG per game. When `opponent` is given, each player's xG (and SOT) is scaled by how leaky
// that opponent's defence has been vs a tournament average — so the projection is matchup-aware,
// like the corner/shots/saves projections, instead of raw form. team/opponent are { name, abbr }.
// DISPLAY-ONLY: there's no free way to de-vig player props into a fair line, so it informs the eye.
export async function fotmobPlayerSOT(team, opponent = null, lookback = 3) {
  try {
    const played = await recentMatches(team, lookback);
    if (!played.length) return null;
    const agg = new Map(); // name -> { name, sot, shots, xg }
    let mp = 0; // matches with usable shotmap data
    for (const f of played) {
      const m = await fetchFotmobMatch(f.pageUrl);
      if (!m || !(m.shots || []).length) continue;
      mp += 1;
      const side = sideMatch(m.homeTeam.name, team) ? "home" : "away";
      const sm = aggregateShotmap(m.shots, m.homeTeam.id, m.awayTeam.id);
      for (const p of sm.players) {
        if (p.side !== side) continue;
        const rec = agg.get(p.name) || { name: p.name, sot: 0, shots: 0, xg: 0 };
        rec.sot += p.sot; rec.shots += p.shots; rec.xg += p.xg;
        agg.set(p.name, rec);
      }
    }
    if (!mp) return null;
    // opponent-defence adjustment: scale by how leaky the opponent has been vs a tournament
    // average (clamped so a noisy 3-game sample can't swing it wildly). 1 = no opponent given.
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    let xgFactor = 1, sotFactor = 1, adjusted = false;
    if (opponent) {
      const opp = await fotmobTeamRates(opponent, lookback).catch(() => null);
      if (opp) {
        if (opp.xgAgainst) xgFactor = clamp(opp.xgAgainst / 1.3, 0.6, 1.6);
        if (opp.sotAgainst) sotFactor = clamp(opp.sotAgainst / 4, 0.6, 1.6);
        adjusted = true;
      }
    }
    const players = [...agg.values()]
      .map((r) => {
        const xgPg = (r.xg / mp) * xgFactor;
        // anytime-score probability from (opponent-adjusted) xG/game (Poisson: P(>=1 goal) = 1 - e^-xg)
        return { name: r.name, projSOT: (r.sot / mp) * sotFactor, shotsPg: r.shots / mp, xgPg, scoreProb: 1 - Math.exp(-xgPg), games: mp, adjusted };
      })
      .filter((p) => p.projSOT > 0 || p.xgPg > 0)
      .sort((a, b) => b.xgPg - a.xgPg)
      .slice(0, 8);
    return players.length ? players : null;
  } catch {
    return null;
  }
}

// High-level resolver: real xG + match data for an ESPN match, oriented to ESPN home/away.
// home / away are { name, abbr }. Returns a rich object or null. Never throws.
export async function fotmobXG(home, away, dateISO) {
  try {
    const fixtures = await fetchFotmobFixtures();
    if (!fixtures?.length) return null;
    const cand = fixtures.filter((f) =>
      (sideMatch(f.home.name, home) && sideMatch(f.away.name, away)) ||
      (sideMatch(f.home.name, away) && sideMatch(f.away.name, home)));
    if (!cand.length) return null;
    const day = dateISO ? new Date(dateISO).toISOString().slice(0, 10) : null;
    const fx = (day && cand.find((f) => f.utcTime && f.utcTime.slice(0, 10) === day)) || cand[0];
    const m = await fetchFotmobMatch(fx.pageUrl);
    if (!m) return null;
    const agg = aggregateShotmap(m.shots, m.homeTeam.id, m.awayTeam.id);

    const aligned = sideMatch(m.homeTeam.name, home);
    const flip = (sd) => (aligned ? sd : sd === "home" ? "away" : "home");
    // prefer FotMob's published team xG; fall back to the shotmap sum
    const xgStat = orientPair(statPair(m.stats, "Expected goals (xG)", "Expected goals"), aligned);
    const shotsAgg = { home: aligned ? agg.home : agg.away, away: aligned ? agg.away : agg.home };
    const homeTeam = { ...shotsAgg.home, xg: xgStat ? xgStat.home : shotsAgg.home.xg };
    const awayTeam = { ...shotsAgg.away, xg: xgStat ? xgStat.away : shotsAgg.away.xg };

    const xgot = orientPair(statPair(m.stats, "xG on target (xGOT)"), aligned);
    const bigCh = orientPair(statPair(m.stats, "Big chances"), aligned);
    const bigChMissed = orientPair(statPair(m.stats, "Big chances missed"), aligned);

    // momentum: positive value = home pressure in FotMob orientation; flip sign if needed
    const momentum = (m.momentum || []).map((d) => ({
      min: d.minute ?? d.min ?? 0,
      v: (Number(d.value) || 0) * (aligned ? 1 : -1),
    }));

    const tp = parseTopPlayers(m.topPlayers);
    const form = parseForm(m.teamForm);

    return {
      source: "fotmob",
      matchId: fx.id,
      home: homeTeam,
      away: awayTeam,
      players: agg.players.map((p) => ({ ...p, side: flip(p.side) })),
      xgot, bigChances: bigCh, bigChancesMissed: bigChMissed,
      momentum,
      topPlayers: tp ? (aligned ? tp : { home: tp.away, away: tp.home }) : null,
      form: form ? (aligned ? form : { home: form.away, away: form.home }) : null,
    };
  } catch {
    return null;
  }
}

// league-phase matchday for an ESPN match (home/away { name, abbr }, ISO date): FotMob's round
// number for the fixture on the same day. null if unmatched — the pill just stays hidden.
export async function fotmobMatchday(home, away, dateIso) {
  try {
    const day = String(dateIso || "").slice(0, 10);
    const fx = (await fetchFotmobFixtures()).find((f) =>
      String(f.utcTime || "").slice(0, 10) === day && sideMatch(f.home.name, home) && sideMatch(f.away.name, away));
    return fx?.round || null;
  } catch { return null; }
}

// ── pitch view: lineups + the shot map, oriented to ESPN's home/away ──────────────────────────
// FotMob's lineup carries each starter's slot as a fraction of their OWN half (x: 0 own goal →
// 1 halfway, y: 0 → 1 across) plus a live rating and events; the shot map has every shot in
// 105×68 pitch units with both teams attacking x = 105. The widget draws home attacking right.
const POS = { 0: "GK", 1: "DEF", 2: "MID", 3: "ATT" };
function parseSide(t) {
  if (!t) return null;
  const player = (p, starter) => ({
    id: p.id, name: p.name || "", short: p.lastName || p.name || "", num: p.shirtNumber || "",
    pos: POS[p.usualPlayingPositionId] ?? "",
    x: starter ? p.horizontalLayout?.x ?? null : null, y: starter ? p.horizontalLayout?.y ?? null : null,
    rating: p.performance?.rating ?? null,
    events: (p.performance?.events || []).map((e) => e.type).filter(Boolean),
  });
  return {
    id: t.id, name: t.name, formation: t.formation || null, rating: t.rating ?? null, coach: t.coach?.name || null,
    starters: (t.starters || []).map((p) => player(p, true)),
    subs: (t.subs || []).map((p) => player(p, false)),
    unavailable: (t.unavailable || []).map((p) => ({ name: p.name, reason: p.unavailability?.type || "", back: p.unavailability?.expectedReturn || "" })),
  };
}
// { lineups: { type, home, away } | null, shots: [...], zones: { home, away } | null } — null on
// any failure. Works pre-match too (confirmed lineups land about an hour before kickoff).
export async function fotmobPitch(home, away, dateISO) {
  try {
    const fixtures = await fetchFotmobFixtures();
    if (!fixtures?.length) return null;
    const cand = fixtures.filter((f) =>
      (sideMatch(f.home.name, home) && sideMatch(f.away.name, away)) ||
      (sideMatch(f.home.name, away) && sideMatch(f.away.name, home)));
    if (!cand.length) return null;
    const day = dateISO ? new Date(dateISO).toISOString().slice(0, 10) : null;
    const fx = (day && cand.find((f) => f.utcTime && f.utcTime.slice(0, 10) === day)) || cand[0];
    const m = await fetchFotmobMatch(fx.pageUrl);
    if (!m) return null;
    const aligned = sideMatch(m.homeTeam.name, home);
    const flip = (sd) => (aligned ? sd : sd === "home" ? "away" : "home");
    const lu = m.lineup;
    const sides = lu && (lu.homeTeam || lu.awayTeam) ? { home: parseSide(lu.homeTeam), away: parseSide(lu.awayTeam) } : null;
    const lineups = sides ? { type: lu.lineupType || "standard", home: sides[flip("home")], away: sides[flip("away")] } : null;
    const shots = (m.shots || []).map((s) => ({
      id: s.id, side: flip(s.teamId === m.homeTeam.id ? "home" : "away"),
      player: s.playerName || s.fullName || "", min: s.min ?? null, minAdded: s.minAdded ?? null,
      x: Number(s.x) || 0, y: Number(s.y) || 0,
      xg: Number(s.expectedGoals) || 0, xgot: s.expectedGoalsOnTarget != null ? Number(s.expectedGoalsOnTarget) : null,
      type: s.eventType || "", onTarget: !!s.isOnTarget, blocked: !!s.isBlocked, ownGoal: !!s.isOwnGoal, inBox: !!s.isFromInsideBox,
      situation: s.situation || "", shotType: s.shotType || "", period: s.period || "",
    }));
    const az = m.attackingZones;
    const zones = az && az.home && az.away ? { home: az[flip("home")].total || null, away: az[flip("away")].total || null } : null;
    return { lineups, shots, zones };
  } catch {
    return null;
  }
}
