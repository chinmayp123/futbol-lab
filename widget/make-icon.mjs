// make-icon — draw the Futbol Lab mark into the app's icons with no dependencies:
//   tray.png (16px) + tray@2x.png (32px)  — the mark on transparent, for the tray
//   icon.png (256px) + icon.ico (16…256)  — the same mark, for the window, taskbar, shortcut, favicon
//   icon-1024.png                         — the macOS app icon (electron-builder refuses anything under 512px)
//   icon-192 / icon-512 / icon-maskable-512 — the installable web app's icons (web/build.mjs)
//   mark.svg                              — the vector mark (the title bar inlines the same drawing)
// The mark: a white ball with classic navy panels — a pentagon in the middle, five more out along its
// corners, seams between them — circled by a blue orbit that passes in front of the ball's lower half
// and behind its upper half (the "lab"). 100-unit geometry. Rasterised analytically (point-in-polygon,
// segment and ellipse distance) with supersampled coverage, written as RGBA PNGs via node:zlib; the
// .ico wraps the PNGs.
//
//   node widget/make-icon.mjs

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const NAVY = [0x07, 0x0b, 0x1f], WHITE = [0xff, 0xff, 0xff], ACCENT = [0x4f, 0x8d, 0xff];
const hex = (c) => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;

// ── geometry (100-unit space) ───────────────────────────────────────────────
const C = 50, R = 36, OUTLINE = 3.2, SEAM = 2.5;
const ORBIT = { rx: 48, ry: 15, deg: -24, w: 3.6, gap: 1.6 };

const poly = (cx, cy, r, n, rotDeg) =>
  Array.from({ length: n }, (_, i) => { const a = (rotDeg + (i * 360) / n) * Math.PI / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; });
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// centre pentagon (point up) and a rim pentagon out along each of its corners
const CENTRE = poly(C, C, 11.5, 5, -90);
const RIM = CENTRE.map(([vx, vy]) => {
  const a = Math.atan2(vy - C, vx - C);
  return poly(C + 30 * Math.cos(a), C + 30 * Math.sin(a), 10.5, 5, (a * 180) / Math.PI + 180);
});
// seams: each centre corner to its rim pentagon, and each rim pentagon to its neighbour
const nearest = (pts, p) => pts.reduce((b, q) => (dist(q, p) < dist(b, p) ? q : b));
const SEAMS = CENTRE.flatMap((v, k) => {
  const rim = RIM[k], next = RIM[(k + 1) % 5];
  let best = null;
  for (const p of rim) for (const q of next) if (!best || dist(p, q) < best.d) best = { d: dist(p, q), p, q };
  return [[v, nearest(rim, v)], [best.p, best.q]];
});

// ── raster ──────────────────────────────────────────────────────────────────
function inPoly(x, y, p) {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i], [xj, yj] = p[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function segDist(x, y, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}
// distance to the orbit ellipse (first-order), and whether the point is on its front (lower) half
function orbitAt(x, y) {
  const r = (-ORBIT.deg * Math.PI) / 180, dx = x - C, dy = y - C;
  const u = dx * Math.cos(r) - dy * Math.sin(r), v = dx * Math.sin(r) + dy * Math.cos(r);
  const f = (u * u) / ORBIT.rx ** 2 + (v * v) / ORBIT.ry ** 2 - 1;
  return { d: Math.abs(f) / (2 * Math.hypot(u / ORBIT.rx ** 2, v / ORBIT.ry ** 2)), front: v > 0 };
}
function ink(x, y) {
  const d = Math.hypot(x - C, y - C), o = orbitAt(x, y);
  if (o.front && o.d <= ORBIT.w / 2) return "accent";
  if (d <= R + OUTLINE / 2) {
    if (o.front && o.d <= ORBIT.w / 2 + ORBIT.gap) return "navy"; // a hairline between the orbit and the ball
    if (d > R - OUTLINE / 2) return "navy";
    if (inPoly(x, y, CENTRE) || RIM.some((p) => inPoly(x, y, p))) return "navy";
    if (SEAMS.some(([a, b]) => segDist(x, y, a, b) <= SEAM / 2)) return "navy";
    return "white";
  }
  return o.d <= ORBIT.w / 2 ? "accent" : null;
}
// pad: leave this fraction of the canvas empty on each side (a maskable icon's safe zone — Android
// crops the corners off, so the mark has to sit inside the middle ~80%). bg: fill behind it.
function raster(size, ss = 8, { pad = 0, bg = null } = {}) {
  const px = new Uint8Array(size * size * 4), col = { navy: NAVY, white: WHITE, accent: ACCENT };
  const inset = size * pad, span = size - inset * 2, k = 100 / span;
  for (let py = 0; py < size; py++) for (let pxi = 0; pxi < size; pxi++) {
    let n = 0, r = 0, g = 0, b = 0;
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const h = ink((pxi + (sx + 0.5) / ss - inset) * k, (py + (sy + 0.5) / ss - inset) * k);
      if (!h) continue;
      n++; r += col[h][0]; g += col[h][1]; b += col[h][2];
    }
    const o = (py * size + pxi) * 4;
    const cover = n / (ss * ss);
    if (bg) { // composite the mark over the background, so the icon is opaque corner to corner
      px[o] = n ? Math.round((r / n) * cover + bg[0] * (1 - cover)) : bg[0];
      px[o + 1] = n ? Math.round((g / n) * cover + bg[1] * (1 - cover)) : bg[1];
      px[o + 2] = n ? Math.round((b / n) * cover + bg[2] * (1 - cover)) : bg[2];
      px[o + 3] = 255;
    } else if (n) { px[o] = r / n; px[o + 1] = g / n; px[o + 2] = b / n; px[o + 3] = Math.round(255 * cover); }
  }
  return px;
}

// ── svg (same drawing) ──────────────────────────────────────────────────────
const pts = (p) => p.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
export function markSvg({ cls = "", idPrefix = "fl" } = {}) {
  const ellipse = (stroke, w) => `<ellipse cx="${C}" cy="${C}" rx="${ORBIT.rx}" ry="${ORBIT.ry}" fill="none" stroke="${stroke}" stroke-width="${w}"/>`;
  return `<svg${cls ? ` class="${cls}"` : ""} viewBox="0 0 100 100" aria-hidden="true">`
    + `<defs><clipPath id="${idPrefix}-ball"><circle cx="${C}" cy="${C}" r="${R + OUTLINE / 2}"/></clipPath>`
    + `<clipPath id="${idPrefix}-front"><rect x="-10" y="${C}" width="120" height="60"/></clipPath></defs>`
    + `<g transform="rotate(${ORBIT.deg} ${C} ${C})">${ellipse(hex(ACCENT), ORBIT.w)}</g>`
    + `<circle cx="${C}" cy="${C}" r="${R}" fill="#ffffff"/>`
    + `<g clip-path="url(#${idPrefix}-ball)" fill="${hex(NAVY)}">${[CENTRE, ...RIM].map((p) => `<polygon points="${pts(p)}"/>`).join("")}`
    + `<g stroke="${hex(NAVY)}" stroke-width="${SEAM}" stroke-linecap="round">${SEAMS.map(([a, b]) => `<line x1="${a[0].toFixed(2)}" y1="${a[1].toFixed(2)}" x2="${b[0].toFixed(2)}" y2="${b[1].toFixed(2)}"/>`).join("")}</g></g>`
    + `<circle cx="${C}" cy="${C}" r="${R}" fill="none" stroke="${hex(NAVY)}" stroke-width="${OUTLINE}"/>`
    + `<g transform="rotate(${ORBIT.deg} ${C} ${C})"><g clip-path="url(#${idPrefix}-front)">`
    + `<g clip-path="url(#${idPrefix}-ball)">${ellipse(hex(NAVY), ORBIT.w + ORBIT.gap * 2)}</g>${ellipse(hex(ACCENT), ORBIT.w)}</g></g>`
    + `</svg>`;
}

// ── PNG + ICO writers ───────────────────────────────────────────────────────
const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
// an .ico is a directory of images; Vista+ accepts PNG-compressed entries, which keeps it small
function ico(entries) {
  const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(entries.length, 4);
  let offset = 6 + 16 * entries.length;
  const dirs = [], blobs = [];
  for (const { size, data } of entries) {
    const d = Buffer.alloc(16);
    d[0] = size >= 256 ? 0 : size; d[1] = size >= 256 ? 0 : size; d[2] = 0; d[3] = 0;
    d.writeUInt16LE(1, 4); d.writeUInt16LE(32, 6); d.writeUInt32LE(data.length, 8); d.writeUInt32LE(offset, 12);
    dirs.push(d); blobs.push(data); offset += data.length;
  }
  return Buffer.concat([head, ...dirs, ...blobs]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(join(HERE, "tray.png"), png(16, raster(16)));
  writeFileSync(join(HERE, "tray@2x.png"), png(32, raster(32)));
  writeFileSync(join(HERE, "icon.png"), png(256, raster(256)));
  writeFileSync(join(HERE, "icon-1024.png"), png(1024, raster(1024, 4))); // 4×4 supersampling is plenty at this size
  writeFileSync(join(HERE, "icon.ico"), ico([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, data: png(size, raster(size)) }))));
  // the installable web app (web/build.mjs copies these into site/): Chrome wants 192 and 512, plus
  // a maskable one it can crop to a circle or a squircle without clipping the mark
  writeFileSync(join(HERE, "icon-192.png"), png(192, raster(192)));
  writeFileSync(join(HERE, "icon-512.png"), png(512, raster(512, 6)));
  writeFileSync(join(HERE, "icon-maskable-512.png"), png(512, raster(512, 6, { pad: 0.14, bg: NAVY })));
  writeFileSync(join(HERE, "mark.svg"), markSvg() + "\n");
  console.log("wrote widget/tray.png, tray@2x.png, icon.png, icon.ico, mark.svg");
}
