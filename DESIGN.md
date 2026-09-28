# Design system — "Broadcast", club-football night

Futbol Lab looks like a sports broadcast graphics package: near-black navy, one electric
blue, condensed type at size for names, monospace for numbers, square corners everywhere.
It was lifted from the sibling NFL project (`parlay-lab`) and re-skinned to night navy while
the app tracked only the Champions League (as Starball Lab); the website and the desktop
widget share it.

Everything structural lives in `widget/style.css`. Per-match colours (each club's kit) are
set inline from `widget/renderer.js`. There is no CSS framework and no build step.

---

## Principles

1. **A broadcast, not a dashboard.** Lower third for the game, a crawl for caveats, big
   condensed names, numbers in monospace so columns align.
2. **Square corners, flat fills, one accent.** No rounded cards, no gradients as decoration
   (the only gradient is the hero, painted from the two clubs' kit colours), no shadows
   except where something floats above the pitch.
3. **Numbers are the content.** Type scale exists to rank numbers, not to decorate. A value
   is condensed and large; its label is monospace, uppercase, wide-tracked and smaller —
   but never so faint it can't be read (the palette's faint greys were lifted a step for
   exactly this reason).
4. **Say what a number means.** No bare dashes between two teams' values: label the sides
   (`MAN 3.2 · SAB 1.3`, not `3.2–1.3`). Every bar gets a legend. Every projection says
   whose it is and what it's measured against.
5. **The colour is the verdict.** Green means it landed or the model likes it, amber means
   caution or a sharp signal, orange-red means fade, grey means pass. Colour is never
   decorative.

---

## Tokens

```css
/* surfaces, darkest → lightest */
--bg: #070b1f;      --panel: #0e1332;   --panel2: #121840;  --cell: #0a0f2a;
--line: #1c2450;    --line2: #283064;   --line3: #3b4685;

/* text, brightest → faintest */
--text: #ffffff;    --sub: #c3cbe8;     --dim: #9aa5cc;
--faint: #7f8ab5;   --faintest: #5b6499;

/* meaning */
--accent: #4f8dff;  /* the one blue: links, selection, the model's own numbers */
--bet: #3df089;     /* landed, or in the band */
--warn: #ffd23f;    /* caution, sharp money, cards */
--fade: #ff8a3d;    /* fade this */
--neg: #ff5a3c;     /* lost, missed */
--star: #dfe9ff;    /* silver — knockout accents */

/* per match, set inline from ESPN kit colours */
--home: …;          --away: …;
```

Kit colours are lifted toward legibility before use (`ensureVisible()` in the renderer)
because shirt colours are chosen for shirts, not dark UIs, and two similar kits are pushed
apart so a game never renders in one colour.

### Type

| Role | Family | Usage |
|---|---|---|
| `--cd` Barlow Condensed 700/800 | names, values, headings | uppercase, tight tracking, 13–60px |
| `--disp` Barlow 500/600 | prose, reasoning, warnings | 10–12px, sentence case |
| `--mono` JetBrains Mono 500/600 | every number, every label | tabular alignment; labels uppercase, 9–11px, 0.8–1.6px tracking |

Loaded from Google Fonts with real fallback stacks (`Arial Narrow`/Impact, system sans,
Consolas). The one CSP exception for external resources is the font host.

### Space and shape

Corners are square. Borders are 1px `--line`, dividers between zones 2px dashed `--line3`.
Cards are 12–14px padded. The slip rail is a fixed 300px. Gaps are 8/12/14px — flex and grid
with `gap`, never margins between siblings, so direct manipulation and reordering survive.

---

## Components

| Component | Class | Notes |
|---|---|---|
| Title bar | `#titlebar` | 50px: logo, context line, search, ◀, the three places (Today · Leagues ▾ · Bets, `.nav-tab`), Get app, sign-in; drag region in the desktop app; padding-right follows `env(titlebar-area-*)` so it never sits under the native caption buttons |
| Bottom bar | `#bnav` + `.bn` | compact only: Today · Leagues · Bets with icons, 64px; the active place white with a blue icon; Leagues shows the open league's short name |
| Leagues menu | `#lg-menu` + `.lgm-item` | one row per league — badge, name, its live or next game — under the tab; on phones it rises from the bottom bar |
| League badge | `.lbadge` (+ `.big`) | the league's short name on its colour (`--lg`, from a `c-<code>` class: PL `#b58cff`, LaLiga `#ff9f45`, UCL silver, UNL teal `#36d6c8`) |
| Hub header | `#hub` + `.lhead` / `.stabs` | above the lower third, outside the scroll: badge, league title and table line, the league switch (`.lchip`, keeps the tab), sub-tabs underlined in the league colour; Bets uses the same tabs; a match gets a breadcrumb (`.crumbs`) instead |
| Chips | `.chips` + `.lchip` | filters and switches (Fixtures' all/upcoming/results, the record's leagues); on = white with an inset league-colour underline |
| Lower third | `.third` | 62px, a 10px colour block in the home kit, matchup + status + fact columns |
| Crawl | `.ticker` | 24px strip of caveats and sources; `.tk.warn` for the honest warnings, `.tk.src` for feeds |
| Card | `.card` + `.card-h`/`.card-t`/`.card-s` | title left, subtitle right; subtitle carries the source and the basis |
| Stat tile | `.stat-grid` + `.stat`/`.sv`/`.sk` | 3–6 across; value condensed, label monospace |
| Ticket | `.tkt` | a bet: kind, game, legs, a 5-cell number strip (`.tk-nums`), then the reasoning |
| Verdict cell | `.cell.v-bet/.v-lean/.v-fade/.v-sharp/.v-pass` | 4px left spine carries the verdict colour |
| Board row | `.brow` + `.colhead` | Builder's market rows, one axis per block |
| Slip rail | `.rail` | price-compare boxes (`.pbox`), EV line, correlation warnings, actions |
| Table row | `.tr` | league table; rank gutter tinted by zone, `.cut` rows label each zone |
| Pitch | `.pitchwrap` | players `.pl`, shots `.shot`, hotspots `.hs`, one moving popover `.pop` |
| Bracket tie | `.brk-card` | two rows + meta; braces only drawn once a pairing fully resolves |
| Day strip | `.cal` + `.cal-day` | Today's calendar: a scrolling row of day chips (weekday, date, month on the first chip and the 1st, league marks), the chosen day inverted white; ◀ ▶ jump to the previous/next day with games |
| League section | `.lgsec` + `.lg-head` | Today's chosen day split by league: a header in the league's colour with a badge, the name (opens the league), game count and "Table ›", then that league's cards. The site's league order; the Champions League leads on its weeks |
| Overview | `.ov` | a league's week (2-across cards, weekday in the status) beside a mini table (`.tbl.mini`: #, crest, club, P, GD, Pts; a domestic league's top five, a `· · ·` gap, bottom three) |
| UCL week | `.ucl-banner`, `:root.ucl-week` | a silver-edged banner plus a page skin — the starball watermark and silver accents return for a Champions League week |
| Segmented control | `.seg` | layer switches (Lineups / Shots / Both) |

### The pitch, specifically

The one genuinely custom surface. Players are headshots ringed in the kit colour with a
number badge, a rating pill and event badges (a drawn pentagon football for goals, "A" for
an assist, card slivers, "OG"). Shots are dots at their real pitch coordinates sized by the
square root of xG, goals ringed amber. Landmarks — corner flags, goalmouths, penalty boxes,
the centre spot, both benches — are invisible hotspots.

There is exactly **one** popover element, moved to whatever is hovered and flipped above or
below depending on where it is; clicking pins it so a live refresh doesn't lose it. Pinning
a player dims everyone else and highlights that player's shots.

---

## Layout rules

- **Two-column card flow.** In the match view, sections are delimited by `.label` nodes and
  packed into whichever column is currently shorter, so short cards fill the gap under tall
  ones.
- **State changes order.** Pre-match the model's read leads and the pitch drops below it
  (nothing to plot yet); live and after full time the pitch leads.
- **Three places, always reachable.** Today, Leagues and Bets sit in the bar (the bottom bar
  in compact); a page's own tabs sit in the hub header, which never scrolls away.
- **Compact mode is the same DOM.** Phones start in it: the title bar is one row (mark,
  context, ◀, account), the search box and logo text disappear, the bottom bar appears,
  cards go single-column, tables shed columns and the pitch stays hidden. If you add a
  section, decide what compact does with it.
- **Nothing scrolls sideways.** Wide content (bracket, board) scrolls inside its own
  container.

---

## The mark

The app icon, the title-bar logo, the favicon and the faint background watermark are one
drawing: a white ball with classic navy panels — a pentagon in the middle, five more out
along its corners, seams between them — circled by a blue orbit that passes in front of the
ball's lower half and behind its upper half (the "lab"). It replaced the starball mark when
the app grew past the Champions League and became Futbol Lab (September 2026).

`widget/make-icon.mjs` holds the geometry. Run, it rasterises the mark analytically
(point-in-polygon, segment and ellipse distance, supersampled) into `tray.png`,
`tray@2x.png`, `icon.png` and a multi-size `icon.ico` with no image library, and writes
`mark.svg`. Its exported `markSvg()` generated the title-bar SVG in `widget/index.html` and
the `--wm` / `--wm-solid` watermark tokens in `style.css`; regenerate those too after
changing the geometry:

```sh
node widget/make-icon.mjs
```

The icon must stay recognisable at 16px — that requirement killed a seven-star version of
the old mark, whose rings turned to mush.

---

## Design history

The layout was explored on Claude Design canvases before it was built:

- Broadcast shell and views — <https://claude.ai/code/artifact/698cde4a-db9b-4b03-a98e-3d22156450c3>
- Pitch card, match sheet, icon options — <https://claude.ai/code/artifact/73139d8b-40e0-471e-b1db-c8ad408fc721>
- Table directions (the broadcast table was chosen) — <https://claude.ai/code/artifact/1c3a1829-7535-49f8-98bb-257fe9770bc0>
