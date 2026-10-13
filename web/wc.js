// wc — the website's stand-in for widget/preload.cjs. renderer.js draws whatever window.wc hands it;
// on the desktop that came from Electron's main process, here it comes from:
//   · Firestore — the views the GitHub Actions job publishes every ~5 minutes (slates, match views,
//     tables, builder menus, and the owner-only cards + records), pushed to the page as they change
//   · the Vercel live functions — a fresh match view for a game that's live or about to be, polled
//     like the widget did (30 s live, 2 min at the break), because the cron runs late
// Google sign-in unlocks the owner's records and cards and lets the builder queue slips.
//
// Every competition in site-config.js is read at once: Today shows all their games, each tagged with
// its league. Everything league-specific (table, builder menu, record, a tracked slip) is asked for by
// league code — the renderer's URL says which league a page is about, so there's no "active" one here.
// On a Champions League week (Monday–Thursday of a week with UCL games) the payload's `uclWeek` lets
// the renderer lead with it.

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { getFirestore, doc, onSnapshot, getDoc, addDoc, collection, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { COMPETITIONS, LIVE_BASE } from "./site-config.js";

const saved = {
  get(k) { try { return localStorage.getItem(`futbol.${k}`); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(`futbol.${k}`) : localStorage.setItem(`futbol.${k}`, v); } catch { /* private window */ } },
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const byCode = Object.fromEntries(COMPETITIONS.map((c) => [c.code, c]));
const refIn = (code, ...path) => doc(db, "competitions", byCode[code].key, ...path);
const parse = (snap) => (snap.exists() ? JSON.parse(snap.get("json")) : null);
const MIN = 60e3;
// the Vercel-hosted copy calls its own functions; GitHub Pages and localhost call them cross-origin
const liveUrlFor = (code) => (location.hostname.endsWith(".vercel.app") ? `/api/live/${code}` : `${LIVE_BASE}/${code}`);

// ── auth ─────────────────────────────────────────────────────────────────────
let user = null;
let authResolved = false;
const authReady = new Promise((resolve) => {
  onAuthStateChanged(auth, (u) => {
    // the renderer caches the card and record once fetched, so a sign-in/out after load starts clean
    if (authResolved && (u?.uid || null) !== (user?.uid || null)) { location.reload(); return; }
    user = u; authResolved = true;
    paintAuth();
    resolve();
  });
});
function paintAuth() {
  const btn = document.getElementById("btn-auth");
  if (!btn) return;
  btn.textContent = user ? (user.displayName || user.email || "Signed in").split(" ")[0] : "Sign in";
  btn.title = user ? `Signed in as ${user.email} · click to sign out` : "Sign in to see your record and track slips";
}
document.addEventListener("click", (e) => {
  if (!e.target.closest?.("#btn-auth")) return;
  if (user) signOut(auth);
  else signInWithPopup(auth, new GoogleAuthProvider()).catch((err) => console.warn("sign-in:", err.code || err.message));
});
const notEnrolled = () => `${user.email} isn't enrolled as the owner (uid ${user.uid})`;

// one league's owner-only view: signed out → a prompt, not enrolled → says so
async function privateView(code, name, what) {
  if (!byCode[code]) return { error: `no such league: ${code}` };
  await authReady;
  if (!user) return { error: `sign in (top right) to see ${what}` };
  try {
    return parse(await getDoc(refIn(code, "private", name))) || { error: `no ${what} published yet` };
  } catch (e) {
    return { error: e.code === "permission-denied" ? notEnrolled() : e.message };
  }
}
async function publicView(code, name, missing) {
  if (!byCode[code]) return { error: `no such league: ${code}` };
  try { return parse(await getDoc(refIn(code, "view", name))) || { error: missing }; }
  catch (e) { return { error: e.message }; }
}

// ── the slates: every competition, merged ─────────────────────────────────────
const slates = {}; // code → { matches, comp } | null when nothing is published
const allAnswered = () => COMPETITIONS.every((c) => c.code in slates);
const tagRow = (c, m) => ({ ...m, compCode: c.code, compShort: c.short, compName: c.name, compKey: c.key });
// every competition's rows, with the live overlay (below) laid over the published slate
const rows = () => COMPETITIONS.flatMap((c) => {
  const published = slates[c.code]?.matches || [];
  const live = liveSlates[c.code]?.byId;
  if (!live || !live.size) return published;
  const out = published.map((m) => live.get(String(m.id)) || m);
  const have = new Set(published.map((m) => String(m.id)));
  for (const [id, m] of live) if (!have.has(id)) out.push(m); // a fixture the publisher hasn't caught up with
  return out;
});

// Monday–Thursday of a week with Champions League games → { label } for the banner, else null
function uclWeek() {
  const ucl = slates.ucl?.matches || [];
  const now = new Date(), dow = (now.getDay() + 6) % 7; // Monday = 0
  if (!ucl.length || dow > 3) return null;
  const monday = new Date(now); monday.setHours(0, 0, 0, 0); monday.setDate(monday.getDate() - dow);
  const friday = new Date(monday); friday.setDate(monday.getDate() + 4);
  const games = ucl.filter((m) => { const t = new Date(m.date); return t >= monday && t < friday; });
  if (!games.length) return null;
  const days = [...new Set(games.map((m) => new Date(m.date).toDateString()))].map((s) => new Date(s)).sort((a, b) => a - b);
  const f = (d) => d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
  return { label: `${days.length > 1 ? `${f(days[0])} – ${f(days[days.length - 1])}` : f(days[0])} · ${games.length} games` };
}

for (const c of COMPETITIONS) {
  onSnapshot(refIn(c.code, "view", "slate"), (snap) => {
    const d = parse(snap);
    slates[c.code] = d ? { matches: (d.matches || []).map((m) => tagRow(c, m)), comp: d.comp || null } : null;
    // a freshly published slate is at least as new as any overlay we hold, so let it win; the next
    // tick (immediately, from onSlates) re-polls if anything is still live
    delete liveSlates[c.code];
    onSlates();
  }, () => {
    if (!(c.code in slates)) slates[c.code] = null;
    onSlates();
  });
}
function onSlates() {
  if (!allAnswered()) return;
  startSlatePolling();
  slateTick(); // a new published slate just landed: refresh the live overlay for anything still on
  // a match page opened before the slates arrived: its game can be found now
  const want = query && rows().find((m) => String(m.id) === query);
  if (want && String(cur.id ?? "") !== query) select(want);
  else push();
}

// ── the live slate ───────────────────────────────────────────────────────────
// The publisher writes the slate from GitHub Actions, but GitHub skips most of the 5-minute
// schedule — measured over 33 days it ran about every four hours — so a game that kicked off an
// hour ago can still read "not started" on Today. While any of a competition's games is inside its
// live window, ask the Vercel function for a fresh slate (keyless, CDN-cached 30 s, so viewers
// share one build) and lay those rows over the published ones. Best-effort: a failure leaves the
// published slate exactly as it was.
const SLATE_POLL = 45e3;
const liveSlates = {}; // code → { at, byId: Map(id → row) }
let slateTimer = null;

async function pollSlate(c) {
  try {
    const res = await fetch(`${liveUrlFor(c.code)}?slate=1`);
    const j = await res.json();
    if (!Array.isArray(j.matches) || !j.matches.length) return false;
    liveSlates[c.code] = { at: j.at || Date.now(), byId: new Map(j.matches.map((m) => [String(m.id), tagRow(c, m)])) };
    return true;
  } catch { return false; }
}
// does this competition have anything live, about to kick off, or just finished?
function needsLiveSlate(code) {
  const live = liveSlates[code]?.byId;
  const list = live && live.size ? [...live.values()] : (slates[code]?.matches || []);
  return list.some(wantsLive);
}
function slateTick() {
  if (document.visibilityState === "hidden") return; // nothing to update while nobody is looking
  for (const c of COMPETITIONS) {
    // nothing live any more: drop the overlay so yesterday's rows can never sit on top of the
    // published slate, and stop calling the function
    if (!needsLiveSlate(c.code)) { delete liveSlates[c.code]; continue; }
    pollSlate(c).then((ok) => { if (ok) push(); });
  }
}
function startSlatePolling() {
  if (slateTimer) return;
  slateTick();
  slateTimer = setInterval(slateTick, SLATE_POLL);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") slateTick(); });
}

// ── the open match: the one a match page asked for (setMatch), or none ─────────
let onUpdate = null;
let query = null;
let cur = { id: null };

// live, kicking off within 90 minutes, or finished within the last ~2.5 hours of kickoff+play
function wantsLive(m) {
  const kick = Date.parse(m.date), now = Date.now();
  return m.state === "in" || (m.state === "pre" && kick - now < 90 * MIN) || (m.state === "post" && now - kick < 150 * MIN);
}

function push() {
  if (!onUpdate || !allAnswered()) return;
  const all = rows().sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const comps = Object.fromEntries(COMPETITIONS.map((c) => [c.code, slates[c.code]?.comp || null]));
  if (!all.length) { onUpdate({ error: "nothing published yet — the data job runs every 5 minutes", matches: [], comps, comp: null }); return; }
  if (cur.id && !cur.loaded) return; // don't flash an empty match while its view is on the way
  const useLive = cur.live && cur.liveAt >= (cur.snapAt || 0);
  onUpdate({ match: cur.id ? (useLive ? cur.live : cur.snap) || null : null, matchId: cur.id, matches: all, comps, comp: slates[cur.code]?.comp || null, uclWeek: uclWeek() });
}

function select(row) {
  const id = row ? String(row.id) : null;
  if (cur.id === id) { push(); return; }
  cur.unsub?.();
  clearTimeout(cur.timer);
  cur = { id, code: row?.compCode || null, snap: null, snapAt: 0, live: null, liveAt: 0, loaded: !id, forced: false, unsub: null, timer: null };
  if (!id) { push(); return; }
  const code = cur.code;
  cur.unsub = onSnapshot(refIn(code, "games", id), (snap) => {
    if (cur.id !== id) return;
    cur.snap = parse(snap)?.match || null;
    cur.snapAt = snap.exists() ? (snap.get("publishedAt")?.toMillis?.() || Date.now()) : 0;
    // a game the job hasn't built yet (far-off fixture): ask the live function once
    if (!cur.snap && !cur.forced) { cur.forced = true; poll(id, true); return; }
    cur.loaded = true;
    push();
  }, () => { cur.loaded = true; push(); });
  poll(id);
}

async function poll(id, force = false) {
  clearTimeout(cur.timer);
  const m = rows().find((x) => String(x.id) === id);
  if (m && (force || wantsLive(m))) {
    try {
      const res = await fetch(`${liveUrlFor(m.compCode)}?q=${encodeURIComponent(id)}`);
      const j = await res.json();
      if (cur.id === id && j.match) { cur.live = j.match; cur.liveAt = j.at || Date.now(); }
    } catch { /* the Firestore view still stands */ }
    if (cur.id !== id) return;
    cur.loaded = true;
    push();
  }
  if (cur.id !== id) return;
  const shown = cur.live || cur.snap;
  const delay = !m || !wantsLive(m) ? 5 * MIN : shown?.halftime ? 2 * MIN : m.state === "in" ? 30e3 : MIN;
  cur.timer = setTimeout(() => poll(id), delay);
}

// ── the bridge renderer.js expects ───────────────────────────────────────────
let expanded = saved.get("expanded") != null ? saved.get("expanded") === "1" : innerWidth >= 700;
const amToDec = (ml) => (ml == null ? null : ml > 0 ? ml / 100 + 1 : 100 / -ml + 1);
const decToAm = (d) => (d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)));

window.wc = {
  competitions: COMPETITIONS, // [{ code, key, short, name }] in the site's order
  onUpdate: (cb) => { onUpdate = cb; push(); },
  onConfig: (cb) => setTimeout(() => cb({ expanded, pinned: false }), 0),
  // open a match (its id) or close it (null): the page gets it in the next push
  setMatch: async (id) => {
    query = id ? String(id) : null;
    if (!allAnswered()) return query;
    if (!query) { select(null); return query; }
    const row = rows().find((m) => String(m.id) === query);
    if (row) select(row);
    else push(); // not on any slate: the page says so
    return query;
  },
  // tonight's card across every competition: each one's singles and notes, the longest longshot
  getParlays: async () => {
    await authReady;
    if (!user) return { error: "sign in (top right) to see tonight's card" };
    let cards = [];
    for (const c of COMPETITIONS) {
      try {
        const d = parse(await getDoc(refIn(c.code, "private", "parlays")));
        if (d) cards.push([c, d]);
      } catch (e) {
        if (e.code === "permission-denied") return { error: notEnrolled() };
      }
    }
    if (!cards.length) return { error: "no card published yet" };
    const date = cards.map(([, d]) => d.date).sort().pop();
    cards = cards.filter(([, d]) => d.date === date);
    const multi = cards.length > 1;
    return {
      date, stake: cards[0][1].stake,
      singles: cards.flatMap(([, d]) => d.singles || []),
      notes: cards.flatMap(([c, d]) => (d.notes || []).map((n) => ({ ...n, text: multi ? `${c.short} · ${n.text}` : n.text }))),
      longshot: cards.map(([, d]) => d.longshot).filter(Boolean).sort((a, b) => (b.legs?.length || 0) - (a.legs?.length || 0))[0] || null,
    };
  },
  // the builder's board: the published one while its games are still to play, otherwise built on
  // demand by the live function — the publisher only writes it with the 10:00 card, and GitHub runs
  // that job a handful of times a day, so the board was usually missing or a day old
  getParlayMenu: async (code) => {
    const stillToPlay = (id) => rows().some((m) => String(m.id) === String(id) && m.state === "pre");
    const pub = await publicView(code, "menu", "the builder is published with the 10:00 card");
    const live = (pub?.games || []).filter((g) => stillToPlay(g.id));
    if (live.length) return { ...pub, games: live, source: "published" };
    // building a board takes ~12 s, and a cold function can time out on the first ask; the second
    // lands on a warm instance (or the CDN), so one retry is the difference between a board and an
    // empty builder
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const j = await fetch(`${liveUrlFor(code)}?menu=1`).then((r) => r.json());
        if (j && Array.isArray(j.games)) return { ...j, source: "live" };
      } catch { /* retry once, then fall through to whatever was published */ }
    }
    return pub?.error ? pub : { ...pub, games: [], source: "published" };
  },
  getStandings: (code) => publicView(code, "standings", "the table hasn't been published yet"),
  getRecord: (code) => privateView(code, "record", "the bet record"),
  // the slip is queued in its league; the next publisher run logs it and it settles like the card
  trackParlay: async (payload, code) => {
    if (!byCode[code]) return { error: `no such league: ${code}` };
    await authReady;
    if (!user) return { error: "sign in with the owner account to track a slip" };
    try {
      await addDoc(collection(db, "competitions", byCode[code].key, "slips"), { payload: JSON.stringify(payload), uid: user.uid, createdAt: serverTimestamp() });
      const dec = (payload.legs || []).reduce((p, l) => p * (l.dec || amToDec(l.ml) || 1), 1);
      return { ok: true, queued: true, americanOdds: decToAm(dec) };
    } catch (e) {
      return { error: e.code === "permission-denied" ? "this account isn't enrolled as the owner" : e.message };
    }
  },
  toggleExpand: async () => { expanded = !expanded; saved.set("expanded", expanded ? "1" : "0"); return expanded; },
  togglePin: async () => false, // no always-on-top in a browser tab
  refresh: async () => {
    if (cur.id) poll(cur.id, true);
    await Promise.all(COMPETITIONS.filter((c) => needsLiveSlate(c.code)).map((c) => pollSlate(c)));
    push();
  },
  hide: async () => {},
  quit: async () => {},
};

// "Get app": the desktop installers from the latest GitHub release — the Windows setup file directly,
// the release page elsewhere (the Mac build comes in two architectures)
function paintDownload() {
  const a = document.getElementById("btn-download");
  if (!a) return;
  document.documentElement.classList.toggle("touch", matchMedia("(pointer: coarse)").matches && !matchMedia("(pointer: fine)").matches);
  const latest = "https://github.com/chinmayp123/futbol-lab/releases/latest";
  a.href = /Windows/i.test(navigator.userAgent) ? `${latest}/download/Futbol-Lab-Setup.exe` : latest;
  a.title = /Windows/i.test(navigator.userAgent) ? "Download the Futbol Lab app for Windows" : "Download the Futbol Lab desktop app";
}

// ── installing it as an app ──────────────────────────────────────────────────
// Chrome fires beforeinstallprompt once the page is installable (manifest + service worker, https).
// Until it does there is nothing to click, so the button stays hidden rather than lying about it.
// Inside the installed app (display-mode: standalone) there is nothing left to install.
let installPrompt = null;
function paintInstall() {
  const btn = document.getElementById("btn-install");
  if (!btn) return;
  const installed = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  btn.hidden = !installPrompt || installed;
}
addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installPrompt = e; paintInstall(); });
addEventListener("appinstalled", () => { installPrompt = null; paintInstall(); });
document.addEventListener("click", async (e) => {
  if (!e.target.closest?.("#btn-install") || !installPrompt) return;
  const prompt = installPrompt;
  installPrompt = null;
  paintInstall();
  try { await prompt.prompt(); } catch { /* the user dismissed it */ }
});

// the service worker is what makes it installable, and what lets it open without a network
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch((e) => console.warn("sw:", e.message)));
}

paintAuth();
paintDownload();
paintInstall();
// renderer.js registers its callbacks as it loads, so it must run after window.wc exists
const script = document.createElement("script");
script.src = "renderer.js";
document.body.appendChild(script);
