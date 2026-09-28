// teams — ONE strict club-name matcher for every feed (ESPN ↔ FotMob / Action Network / FanDuel /
// OddsPapi / The Odds API). Every feed spells clubs a little differently, and the old per-module
// matchers accepted any substring — including a 3-letter abbreviation inside a longer name —
// which paired Bayern Munich (ESPN "MUN") with Dort-MUN-d and Manchester United ("MAN") with
// MANchester City, so the wrong players, form and prices flowed in. Rules here:
//   · fold diacritics (München → munchen, Bodø → bodo), drop generic tokens (fc, sc, club …)
//   · canonicalise the few names the feeds disagree on (Inter / Internazionale, Man Utd, PSG …)
//   · match when every distinctive token of the shorter name appears in the longer one
//   · an abbreviation matches only by EXACT equality against a feed's own abbreviation field
import { pathToFileURL } from "node:url";

const FULL_ALIAS = {
  "psg": "paris saint germain", "paris sg": "paris saint germain",
  "man city": "manchester city", "man utd": "manchester united", "man united": "manchester united",
  "sporting lisbon": "sporting cp", "sporting clube de portugal": "sporting cp",
  "bruges": "club brugge", "slavia praha": "slavia prague", "bayern": "bayern munchen",
  "nottm forest": "nottingham forest", "nott m forest": "nottingham forest", "spurs": "tottenham hotspur", "wolves": "wolverhampton wanderers",
  // ESPN and FanDuel call Deportivo La Coruña just "Deportivo", whose one token also sits inside
  // "Deportivo Alavés" — so FotMob's and Action Network's Alavés matched La Coruña
  "deportivo": "deportivo la coruna",
  // national teams (Nations League): the feeds disagree on a handful. FotMob's bare "Ireland" is the
  // Republic — left alone, its one token also sits inside "Northern Ireland" — and ESPN's short
  // "N Ireland" loses "N" to the 3-letter floor, which would leave just "ireland" the other way
  "ireland": "republic of ireland", "rep ireland": "republic of ireland", "rep of ireland": "republic of ireland", "republic ireland": "republic of ireland", "ireland republic": "republic of ireland",
  "n ireland": "northern ireland",
  "turkey": "turkiye", "czech republic": "czechia", "holland": "netherlands", "faroes": "faroe islands",
  "bosnia": "bosnia and herzegovina", "bosnia herz": "bosnia and herzegovina", "macedonia": "north macedonia", "fyr macedonia": "north macedonia",
};
const TOKEN_ALIAS = { internazionale: "inter", munich: "munchen", muenchen: "munchen", praha: "prague", atletico: "atletico", atlético: "atletico" };
const GENERIC = new Set(["fc", "cf", "sc", "ac", "afc", "club", "de", "the", "and", "of", "sk", "fk", "sv", "bk", "if", "ss", "us", "ud", "cd", "rc", "rcd", "bsc", "tsv", "sl", "cp", "rb", "as", "ssc", "ogc", "rsc", "kaa", "krc", "losc", "stade", "olympique", "fotball", "fotballklubb", "fussball", "calcio", "1907", "1899", "1900", "1904", "1909", "1913", "1914"]);

export const fold = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/ø/g, "o").replace(/æ/g, "ae").replace(/ß/g, "ss").replace(/ł/g, "l").replace(/đ/g, "d").replace(/ı/g, "i")
  .replace(/[^a-z0-9]+/g, " ").trim();
export function tokens(s) {
  const f = fold(s);
  return (FULL_ALIAS[f] || f).split(" ").map((t) => TOKEN_ALIAS[t] || t).filter((t) => t.length >= 3 && !GENERIC.has(t));
}
// UEFA's national teams. A country name matches only the same country, never by subset: the
// mixed boards (FanDuel in-play, Action Network) carry "Austria Wien", "Spain U21", "England
// Women", and subset matching would hand any of them Austria's or Spain's prices
const key = (T) => [...T].sort().join(" ");
const NATIONS = new Set(["Albania", "Andorra", "Armenia", "Austria", "Azerbaijan", "Belarus", "Belgium", "Bosnia and Herzegovina", "Bulgaria", "Croatia", "Cyprus", "Czechia", "Denmark", "England", "Estonia", "Faroe Islands", "Finland", "France", "Georgia", "Germany", "Gibraltar", "Greece", "Hungary", "Iceland", "Israel", "Italy", "Kazakhstan", "Kosovo", "Latvia", "Liechtenstein", "Lithuania", "Luxembourg", "Malta", "Moldova", "Montenegro", "Netherlands", "North Macedonia", "Northern Ireland", "Norway", "Poland", "Portugal", "Republic of Ireland", "Romania", "Russia", "San Marino", "Scotland", "Serbia", "Slovakia", "Slovenia", "Spain", "Sweden", "Switzerland", "Türkiye", "Ukraine", "Wales"].map((n) => key(tokens(n))));
// do two club (or national-team) names refer to the same side?
export function teamMatch(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.length || !B.length) return false;
  if (NATIONS.has(key(A)) || NATIONS.has(key(B))) return key(A) === key(B);
  const sub = (X, Y) => X.every((t) => Y.includes(t));
  return sub(A, B) || sub(B, A);
}
// does a feed's team (any of its name spellings, plus its own abbreviation field) match an ESPN
// ref { name, abbr }? Abbreviations only ever match exactly.
export function refMatch(names, ref, feedAbbr = null) {
  if (!ref) return false;
  const given = [].concat(names).filter(Boolean);
  if (given.some((n) => teamMatch(n, ref.name))) return true;
  // a national team whose names didn't match is a different side ("England Women", "Spain U21"),
  // however its abbreviation reads - so the abbreviation fallback never overrides the country rule
  if (given.length && isNation(ref.name)) return false;
  return !!(feedAbbr && ref.abbr && String(feedAbbr).toUpperCase() === String(ref.abbr).toUpperCase());
}
// is this one of UEFA's national teams (exact country, after aliases)?
export const isNation = (name) => NATIONS.has(key(tokens(name)));
// "Home v Away" / "Home vs Away" / "Home @ Away" / "Home - Away" → [home, away] or null
export function splitFixtureName(s) {
  const m = String(s || "").split(/\s+(?:v|vs|vs\.|@|-|–|—)\s+/i);
  return m.length === 2 ? m : null;
}

// ── cross-feed audit (checked live 2026-09-28): every UEFA nation as ESPN spells it, then each other
// spelling a feed was seen using. ESPN displayName / shortDisplayName, FotMob, FanDuel, OddsPapi
// name / shortName; plus The Odds API's and Action Network's older forms. Russia is suspended but
// stays so a stray "Russia U21" can't slip through. Add a row whenever a feed shows a new spelling.
export const NATION_SPELLINGS = [
  ["Albania"], ["Andorra"], ["Armenia"], ["Austria"], ["Azerbaijan"], ["Belarus"], ["Belgium"],
  ["Bosnia-Herzegovina", "Bosnia-Herz", "Bosnia and Herzegovina", "Bosnia & Herzegovina", "Bosnia"],
  ["Bulgaria"], ["Croatia"], ["Cyprus"], ["Czechia", "Czech Republic"], ["Denmark"], ["England"], ["Estonia"],
  ["Faroe Islands", "Faroes"], ["Finland"], ["France"], ["Georgia"], ["Germany"], ["Gibraltar"], ["Greece"],
  ["Hungary"], ["Iceland"], ["Israel"], ["Italy"], ["Kazakhstan"], ["Kosovo"], ["Latvia"], ["Liechtenstein"],
  ["Lithuania"], ["Luxembourg"], ["Malta"], ["Moldova"], ["Montenegro"], ["Netherlands", "Holland"],
  ["North Macedonia", "Macedonia", "FYR Macedonia"], ["Northern Ireland", "N Ireland", "N. Ireland"],
  ["Norway"], ["Poland"], ["Portugal"],
  ["Republic of Ireland", "Rep Ireland", "Ireland", "Rep. of Ireland", "Ireland Republic"],
  ["Romania"], ["Russia"], ["San Marino"], ["Scotland"], ["Serbia"], ["Slovakia"], ["Slovenia"], ["Spain"],
  ["Sweden"], ["Switzerland"], ["Türkiye", "Turkiye", "Turkey"], ["Ukraine"], ["Wales"],
];
// names that must match NO nation: the mixed boards' youth, women's and club sides
const NOT_NATIONS = ["Austria Wien", "Spain U21", "England Women", "Wales U21", "Georgia Southern", "Malta U19", "Slovan Bratislava", "Roma"];
// returns a list of problems (empty = clean). Each spelling must match its own country and no other
// — the second is how LaLiga's "Real" and "Deportivo" bugs would have been caught.
export function auditNations() {
  const bad = [];
  NATION_SPELLINGS.forEach(([canon, ...alts], i) => {
    if (!isNation(canon)) bad.push(`${canon}: not in NATIONS`);
    for (const s of [canon, ...alts]) {
      if (!teamMatch(s, canon)) bad.push(`${s}: doesn't match ${canon}`);
      NATION_SPELLINGS.forEach(([other], j) => { if (j !== i && teamMatch(s, other)) bad.push(`${s}: also matches ${other}`); });
    }
  });
  for (const s of NOT_NATIONS) for (const [canon] of NATION_SPELLINGS) if (teamMatch(s, canon)) bad.push(`${s}: matches ${canon}`);
  return bad;
}
// `node teams.mjs` runs the audit
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const bad = auditNations();
  console.log(bad.length ? bad.join("\n") : `teams.mjs: ${NATION_SPELLINGS.flat().length} spellings of ${NATION_SPELLINGS.length} nations, all clean`);
  process.exitCode = bad.length ? 1 : 0;
}
