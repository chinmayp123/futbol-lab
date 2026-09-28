// Vercel live function for the Nations League: GET /api/live/unl?q=<espnEventId>. See ../_live.mjs.
// The data layer picks its competition once, when it loads, so every competition is its own
// function (its own instances) and sets COMPETITION before loading it.
export async function GET(request) {
  process.env.COMPETITION ||= "unl";
  return (await import("../_live.mjs")).GET(request);
}
