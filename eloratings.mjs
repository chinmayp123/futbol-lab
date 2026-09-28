// eloratings — World Football Elo Ratings (eloratings.net) for national teams, the rating prior the
// Nations League path blends into its pre-match read (MODEL.md §1, "national-team prior").
//
// Why a rating at all: a national team plays 4–6 competitive games a year, and League C/D sides are
// barely priced, so the club path — rebuild the market's own line, tilt it by three games of xG —
// often has no line to rebuild and a form sample that spans a year and three coaches. Elo carries
// every international result back decades and is the standard public strength measure for them.
//
// The site publishes its tables as plain TSV that its own pages load (World.tsv: rank, rank, code,
// rating, …; en.teams.tsv: code, then every spelling it uses). No key, no robots.txt (404 on
// 2026-09-28), so read both at most once a day and keep a copy in DATA_DIR/cache — the ratings only
// move when games are played. Best-effort like every feed: any failure returns null and the caller
// keeps the market-only behaviour. A stale copy up to two weeks old beats nothing.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./competition.mjs";
import { teamMatch } from "./teams.mjs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const BASE = "https://www.eloratings.net";
const TTL = 24 * 3600e3;          // ratings change after games, not by the hour
const STALE_OK = 14 * 24 * 3600e3; // a fetch failure falls back to a copy this old
const CACHE_FILE = join(DATA_DIR, "cache", "eloratings.json");

let mem = null; // { at, teams: [{ code, names[], rating, rank }] }

function readDisk() {
  try { return JSON.parse(readFileSync(CACHE_FILE, "utf8")); } catch { return null; }
}
function writeDisk(data) {
  // read-only filesystems (the Vercel live functions) just skip the disk copy
  try { mkdirSync(join(DATA_DIR, "cache"), { recursive: true }); writeFileSync(CACHE_FILE, JSON.stringify(data)); } catch { /* best-effort */ }
}
async function getText(path) {
  const res = await fetch(`${BASE}/${path}`, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`eloratings HTTP ${res.status}`);
  return res.text();
}
const rows = (tsv) => tsv.split(/\r?\n/).filter(Boolean).map((l) => l.split("\t"));

async function fetchTable() {
  const [world, names] = await Promise.all([getText("World.tsv"), getText("en.teams.tsv")]);
  const spell = new Map(rows(names).map(([code, ...alts]) => [code, alts.filter(Boolean)]));
  const teams = rows(world).map((r) => ({ code: r[2], rank: Number(r[0]) || null, rating: Number(r[3]) || null, names: spell.get(r[2]) || [] }))
    .filter((t) => t.code && t.rating && t.names.length);
  // a table with a handful of rows is a changed format, not the world's national teams
  if (teams.length < 150) throw new Error(`eloratings: only ${teams.length} rated teams`);
  return { at: Date.now(), teams };
}

// the whole table (cached): { at, teams } or null
export async function eloTable() {
  const now = Date.now();
  if (mem && now - mem.at < TTL) return mem;
  const disk = readDisk();
  if (disk?.teams?.length && now - disk.at < TTL) return (mem = disk);
  try {
    mem = await fetchTable();
    writeDisk(mem);
    return mem;
  } catch {
    const stale = [mem, disk].find((d) => d?.teams?.length && now - d.at < STALE_OK);
    return stale ? (mem = stale) : null;
  }
}

// one national team's rating by any feed's spelling (ESPN, FotMob …) → { rating, rank, name } | null.
// Matching goes through teams.mjs like every other feed, so "Ireland" is the Republic and never
// Northern Ireland; a name that matches no rated team, or more than one, gets no rating at all.
export async function eloRating(name) {
  const t = await eloTable();
  if (!t || !name) return null;
  const hits = t.teams.filter((x) => x.names.some((n) => teamMatch(n, name)));
  if (hits.length !== 1) return null;
  return { rating: hits[0].rating, rank: hits[0].rank, name: hits[0].names[0] };
}
