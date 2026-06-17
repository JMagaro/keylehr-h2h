# Session handoff — KeyLehr H2H

A running "where things stand" doc so a fresh Claude/context window (or contributor) can pick up
without re-deriving everything. Update the **Next up** and **Recent work** sections as you go.

_Last updated: 2026-06-17 (Phase B lineup builder + player news shipped)._

---

## Snapshot

- **Live app:** Vercel (`keylehr-h2h.vercel.app`), auto-deploys from `main`. Latest work is pushed.
- **Stack:** Next.js 16.2.9 (App Router, Turbopack) · React 19 · Tailwind v4 (CSS `@theme`, no
  config file) · Drizzle + Neon Postgres (**HTTP driver** — every query is a network round-trip) ·
  NextAuth (commissioner login) · a Chrome extension for DraftKings sync.
- **Verification:** `npm run verify` runs the whole gate (see below). It is **green** as of this
  handoff (typecheck · lint · 45 tests · production build · ESPN health · engine invariants ·
  2025 ground-truth replay).

## ✅ DONE — 2023 + 2024 seasons imported & validated

Both seasons are now backfilled into the prod DB and pass a full ground-truth replay against their
published `Standings` tabs. Done via a **new generic importer** `scripts/import-season.ts` (npm
script `import:season`); `import-season3.ts` was left untouched (it stays the `npm run verify`
anchor). To re-run (idempotent):

```
npm run import:season -- --year=2024 --sheet=1kWMn8Zbk4K7JitaOqxMjII_LKVsKRyqaeXhIJPFkJl8 --name="2024 Season"
npm run import:season -- --year=2023 --sheet=15KWmUsWkQuRgdOCJWUBfaImXZjGxnFp9Lv4UsNikDaA --name="2023 Season"
```

Results: **2024 → 32/32 PASS** (records + PF exact; 3 forfeit-opponent PA differences explained,
see below). **2023 → 32/32 PASS** (records + PF exact; 2 small AVERAGE() PA residuals). Seeding and
the double-loss balance (2024: 1; 2023: 2) all check out.

Key facts captured while doing this (useful if a 2022-or-earlier season is added later):
- The importer's `Owners`/`Standings` parsing is **header-driven** — it finds columns by header text
  ("NFL Team"/"Owner"/"DK Entry Name"/"Email Address"; in Standings it finds each `W,L,T,PF,PA` run
  and walks left to the nearest "Owner", so the team column = Owner−1). This absorbed BOTH layouts
  with no per-sheet code: 2024 has a leading blank column in Owners + a DK column in Standings; 2023
  has neither (so W/L/T/PF/PA sit one column left and the NFC block starts earlier).
- **Forfeit-opponent PA is a known cross-season inconsistency.** The engine consistently charges a
  forfeit's *opponent* the week's **league average** as Points Against (the documented rule; what
  2025 used everywhere). Some sheets are sloppier: for a forfeit opponent who clearly **won**, the
  2024 maintainer left that week's PA as the forfeiter's actual **0** (wk15 Colts, wk18 Commanders).
  Records + PF + the W/L (double-loss) result still match exactly; only PA differs by ~one week's
  average. The validator accepts this **only for confirmed forfeit-opponent owner-weeks**, capped at
  `FORFEIT_OPP_WEEK_PA_CAP` (200) pts/week, and reports it as `PASS†` — so a real PA bug on any other
  team can't hide. The engine's value is the *more* defensible one (consistent all season); the
  app's standings use it.

## ✅ DONE — Phase B: lineup builder + player news (shipped)

The first external **player-level** integration. Free sources only (Sleeper + ESPN; no key, no
paid projections), with the honest caveat carried into the UI: these are availability / waiver /
consensus signals, **not** point projections or DK salaries. Code lives under `src/lib/players/`:
- `sleeper.ts` — keyless Sleeper client. Player dictionary (`/players/nfl`, ~5 MB) is memoized
  in-process (12 h TTL) because it exceeds Next's 2 MB fetch-cache limit; trending add/drop lists go
  through the normal Next Data Cache (hourly). Normalizes Sleeper team abbrs to our `nfl_teams.key`
  (the one mismatch is **WAS → WSH**). Never throws — degrades to "signals unavailable".
- `recommend.ts` — **pure, unit-tested** risk-weighted engine (`safe` / `balanced` / `boom`). Ranks
  on consensus (Sleeper search rank → positional rank), availability (injury tags), role (depth
  order), waiver momentum (add/drop), light home/away edge. Gates out injured-out + bye players,
  fills a DK Classic lineup (QB/RB×2/WR×3/TE/FLEX/DST), and produces fades. Every pick carries the
  reasons it surfaced. 9 tests in `recommend.test.ts`.
- `espn-news.ts` — ESPN NFL headlines (30-min cache).
- `query.ts` — orchestration: joins signals to the synced NFL schedule (`nfl_games`) for the chosen
  season+week to get each player's opponent / bye, then runs the engine. `getSpotlightData()` feeds
  the My Team strip; `getBuilderData()` feeds the wizard.

UI: `PlayerNewsStrip` (spotlight / fade risks / ESPN news + builder CTA) is on `/my-team`;
`/my-team/builder` is the wizard (season → week → risk via `LineupBuilderControls`, all query-param
driven + server-rendered). Shared presentational `PlayerCard`. Nav gained **Lineup Builder** (and the
home hero + Explore hub link to it); the nav now uses longest-prefix active matching so
`/my-team/builder` doesn't also light up `/my-team`, and the desktop bar switches to the hamburger
below `lg` (7 items). Verified: `npm run verify` 7/7 (54 unit tests).

Possible Phase B+ follow-ups (not requested yet): DK salary cap awareness (needs DK slate data —
not free/keyless), snapshotting trends so the builder works for *past* weeks too (Sleeper trending is
"now" only), and a "build for my matchup" mode tying the suggestion to the owner's H2H opponent.

## Open action items (need the USER, not code)

1. **Routine email** — the scheduled verifier (`keylehr-verify`,
   https://claude.ai/code/routines/trig_012WN7AoBzjC4jw2EqNDyrvD) is set to email
   `brandonmagaro@gmail.com` + `Joshua.lehr09@gmail.com`, but **no email connector is attached**.
   User must connect a Gmail connector at https://claude.ai/customize/connectors, then it can be
   attached to the routine (or add a Gmail-SMTP notifier script as an alternative).
2. **Routine can't run yet** until the user connects **GitHub** for `JMagaro/keylehr-h2h` (via
   `/web-setup`) and sets **`DATABASE_URL`** in the cloud environment (the DATA + TRUTH checks need
   it). CODE checks would still run without it.

## Conventions & gotchas learned this session (read before coding)

- **Always run `npm run verify` before pushing.** The **production build catches a class of errors
  that `next dev`, `tsc`, and ESLint all miss** — most notably **`'use server'` files may ONLY
  export async functions**. A stray `export const`/object in an actions file passes dev + typecheck
  but **fails the Vercel build**, which silently blocks every deploy. This actually happened
  (schedule actions exported `INITIAL_SCHEDULE_STATE`). Keep non-function values in a separate
  plain module.
- **Mobile / tables:** a table (or any wide content) inside a flex/grid item needs `min-w-0` on that
  item, or the no-wrap content blows the page width out instead of letting the inner
  `overflow-x-auto` scroll. The `Table` primitive already wraps in `overflow-x-auto`; the fix is on
  the **ancestor**. Verified pattern across standings/history/playoffs/my-team.
- **Neon HTTP driver → batch writes.** One query = one HTTP round-trip. Never loop per-row upserts
  (the schedule pull did ~272 sequential round-trips and timed out on Vercel). Use chunked multi-row
  `insert().onConflictDoUpdate()`, deduped by the conflict key.
- **Per-season rules now actually drive the engine** (this was the big correctness fix). Tiebreaker
  ORDER, bye-week toggles, and the playoff field size are threaded from `seasons.rules` →
  `getSeasonStandingsData()` (which returns `rankingOptions` + `playoffConfig`) → the standings /
  seeding / odds / playoffs code. If you add a new consumer of standings, pass those through.
- **Local `.next/* 2.*` files** are an iCloud/Finder duplication artifact on this machine; they make
  `tsc` throw bogus `RouteContext` errors. `find .next -name "* 2.*" -delete` before typecheck.
- Money is cents; points are `numeric` (strings). Use `formatMoney` / `formatPoints` in
  `src/lib/utils.ts`. `src/lib/standings/` stays pure (no DB imports).

## Recent work (this session, newest first)

- **Lineup models: versioning + performance tracker** (`src/lib/players/models.ts`, `grade.ts`,
  `performance.ts`, `model_snapshots` table, Admin → Models, `models:snapshot`/`models:grade`
  scripts). The 3 risk profiles are now **versioned models** — `Floor`/`Blend`/`Ceiling` v0.1.0,
  stage `heuristic`. Honest framing agreed with the user: they're hand-weighted heuristics today and
  will **graduate to trained (ML) v1.0** once a season of graded results exists. The tracker is
  forward-looking (inputs only exist "now", so no backtest): `snapshotWeek` records each model's
  lineup near lock; `gradeWeek` scores it vs actual player results (Sleeper stats, PPR proxy) and
  computes hindsight-optimal + chalk baselines (reusing the cap optimizer). Performance shows on the
  builder + Admin → Models. Also: **"Around the league" strip moved from My Team to the home-page
  bottom.**
- **DraftKings salary + cap optimization** (`src/lib/draftkings/*`, `optimize.ts`): builder lineups
  are cap-valid DK Classic rosters. Salaries auto-detected from DK's main slate (lobby API) →
  admin-pinned (Admin → Slates) → `?dg=` override; falls back to signal-only when no salaries posted.
- **Phase B — lineup builder + player news** (`src/lib/players/*`, `/my-team/builder`,
  `PlayerNewsStrip`, `PlayerCard`, `LineupBuilderControls`): first player-level integration, free
  sources (Sleeper + ESPN), risk-weighted pure engine with 9 tests. Nav + home page updated to
  surface it (longest-prefix active matching; desktop nav now `lg`). See the DONE section above.
- **2023 + 2024 season backfill** (`scripts/import-season.ts`, npm `import:season`): a generic,
  header-driven importer that handled both sheet layouts; both seasons replayed to 32/32 ground-truth
  PASS. Surfaced + scoped a cross-season forfeit-opponent PA convention difference (see the DONE
  section above). `import-season3.ts` (2025 anchor) untouched; `npm run verify` still 7/7 green.
- **My Team dashboard** (`/my-team`, `src/lib/team/query.ts`, `src/components/team-*.tsx`):
  browse-any-team dropdown + season selector; stat tiles; custom-SVG charts (weekly scores vs
  league avg, rank-over-time, playoff-odds trend); schedule & results table. **Forfeits are flagged**
  (banner pill + "Missed lineup — auto-loss · FF" rows) using the engine's authoritative
  `resolveMatchup`. (Removed a redundant head-to-head table.)
- **Verification suite** (`scripts/verify.ts`, `npm run verify` / `verify:quick` /
  `verify:ground-truth`) + a twice-weekly **scheduled cloud agent** that runs it.
- **Rules → engine wiring**: tiebreaker order, bye-week (counts-toward-PF / weekly-high
  eligibility), and playoff field size now honored everywhere; +4 tests. `import-season3.ts` now
  exits non-zero on FAIL.
- **Dynamic Rules page** (`/rules`) driven by `seasons.rules`; playoffs page seed copy de-hardcoded.
- **Schedule pull fix**: batched upserts (6.5s→~1s) + `maxDuration`; **the actual deploy blocker was
  the `'use server'` export bug above**, now fixed.
- **Mobile-friendliness** pass (zero horizontal overflow 320–390px) and **branding** (KeyLehr logo
  in nav/footer/hero, badge favicon/app icons, faint stadium backdrop).

## Known minor follow-ups (not blocking)

- Dashboard **"Top of the standings"** mini-table (`getTopStandings`) still uses a simple
  win%→PF→PA sort, not the full configured tiebreaker chain. Fine for a glance; wire if desired.
- `regularSeasonWeeks` is now edited only on the admin **Season** card (the column the engine
  reads); the duplicate Rules-card field was removed.

## Map of the important code

- Standings/seeding/tiebreaker **engine** (pure, tested): `src/lib/standings/{standings,tiebreakers,seeding,types}.ts`
- DB adapter feeding the engine: `src/lib/standings/query.ts` (`getSeasonStandingsData` is the hub —
  returns `rankingOptions` + `playoffConfig`)
- Per-team dashboard data: `src/lib/team/query.ts`
- Player signals + lineup builder: `src/lib/players/{sleeper,espn-news,recommend,query}.ts`
  (`recommend.ts` is the pure engine; `query.ts` is the DB/schedule orchestration hub)
- DraftKings salaries + cap optimizer: `src/lib/draftkings/{draftables,match}.ts`, `src/lib/players/optimize.ts`
- Lineup-model versioning + performance: `src/lib/players/{models,grade,performance}.ts`
  (`grade.ts` is the pure grading math; `performance.ts` adds DB + Sleeper-stats I/O). Cmds:
  `npm run models:snapshot -- --season=<id> --week=<n>` and `models:grade`. Admin → Models drives it.
- Playoffs bracket service: `src/lib/playoffs/service.ts` · Odds sim: `src/lib/odds/`
- Rules schema (single source of truth): `src/lib/rules/schema.ts`
- DraftKings ingest: `src/lib/scores/`, `src/app/api/ingest/draftkings/` · Chrome ext: `extension/`
- Admin (commissioner): `src/app/admin/(panel)/` (auth-gated)
