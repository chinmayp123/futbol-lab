// Vercel live function — GET /api/live/<code>?q=<espnEventId> → a fresh match view, or
// ?slate=1 → a fresh slate (every row for the competition, with live scores and clocks).
//
// The GitHub Actions job publishes every match view to Firestore, but GitHub starts its cron runs
// late, so a live or imminent game would lag. The page asks this function instead: it runs
// lib.getWidgetState() on demand, exactly like the desktop widget's poll did.
//
// Read-only on the records. It loads the bet log / predictions / pregame snapshots (for the frozen
// call, the saved pregame projection and the goals calibration) but never saves them — the publisher
// is their only writer. No odds keys here either, so on-demand traffic can't spend the Odds API or
// OddsPapi quotas (the view falls back to ESPN's line and FanDuel's public props, as the widget does
// without keys). The CDN caches each game's view for 20 s, so viewers share one build.
//
// The slate mode exists because GitHub skips most of the publisher's 5-minute schedule — measured
// over 33 days it actually ran about every four hours — so the published slate can show a game that
// kicked off hours ago as "not started". While anything is in its live window the page polls this
// and merges the scores over the published rows (web/wc.js). CDN: 30 s.

import * as store from "../store.mjs";
import { getWidgetState, listMatchesData } from "../lib.mjs";
import { connect } from "../publisher/firestore.mjs";

const RECORDS_TTL = 60e3;
const ALLOWED = [/^https:\/\/chinmayp123\.github\.io$/, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];

let connecting = null;
let loading = null, loadedAt = 0;
async function records() {
  connecting ||= connect().then((fb) => store.useRemote({ load: fb.store.load, save: async () => {} }));
  await connecting;
  if (!loading || Date.now() - loadedAt > RECORDS_TTL) {
    loadedAt = Date.now();
    loading = store.load().catch((e) => { loading = null; throw e; });
  }
  await loading;
}

export async function GET(request) {
  const origin = request.headers.get("origin") || "";
  const cors = ALLOWED.some((rx) => rx.test(origin)) ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {};
  const params = new URL(request.url).searchParams;
  if (params.get("slate") === "1") {
    try {
      await records();
      const matches = await listMatchesData();
      return Response.json({ matches, at: Date.now() }, {
        headers: { ...cors, "Cache-Control": "public, max-age=0, s-maxage=30, stale-while-revalidate=60" },
      });
    } catch (e) {
      return Response.json({ error: String(e?.message || e) }, { status: 500, headers: cors });
    }
  }
  const q = params.get("q") || "";
  if (!/^\d{1,12}$/.test(q)) return Response.json({ error: "q must be an ESPN event id" }, { status: 400, headers: cors });
  try {
    await records();
    const state = await getWidgetState(q);
    if (state.error || !state.match) return Response.json({ error: state.error || "match not found" }, { status: 502, headers: cors });
    return Response.json({ match: state.match, at: Date.now() }, {
      headers: { ...cors, "Cache-Control": "public, max-age=0, s-maxage=20, stale-while-revalidate=40" },
    });
  } catch (e) {
    return Response.json({ error: String(e?.message || e) }, { status: 500, headers: cors });
  }
}
