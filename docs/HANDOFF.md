# Session handoff — KeyLehr H2H

A running "where things stand" doc so a fresh Claude/context window (or contributor) can pick up
without re-deriving everything. Update the **Next up** and **Recent work** sections as you go.

_Last updated: 2026-06-17 (tiebreaker fix + 2023/2024 playoffs + per-season owner names + DK salary
+ model performance tracker)._

---

## Snapshot

- **Live app:** Vercel (`keylehr-h2h.vercel.app`), auto-deploys from `main`. Latest work is pushed.
- **Stack:** Next.js 16.2.9 (App Router, Turbopack) · React 19 · Tailwind v4 (CSS `@theme`, no
  config file) · Drizzle + Neon Postgres (**HTTP driver** — every query is a network round-trip) ·
  NextAuth (commissioner login) · a Chrome extension for DraftKings sync.
- **Verification:** `npm run verify` runs the whole gate (see below). It is **green** as of this
  handoff (typecheck · lint · **~68 unit tests** · production build · ESPN health · engine invariants ·
  2025 ground-truth replay).
- **Seasons in DB:** 2023, 2024, 2025 fully imported (regular season **and** playoffs, validated
  against the sheets) + 2026 (upcoming; schedule synced, no owners yet). The rebuild is feature-complete
  vs the original Google-Sheets workflow.
- **The DFS model:** owners are assigned an NFL team (drives the H2H *schedule* only); each week a score
  is the owner's **NFL-wide DraftKings lineup total**. Players were not tracked at all until Phase B.

## ✅ DONE — tiebreaker engine fixed to the league's real rule + 2023/2024 playoffs imported

**The tiebreaker was wrong for multi-way ties** and it surfaced while importing the playoff brackets.
The user provided the league's original R code (`tiebreaker_functions.R`, committed for reference).
The engine now faithfully ports its `resolve_ties` (see `src/lib/standings/tiebreakers.ts`):

> Within a cohort tied on win%, iteratively pick the **head-to-head dominant** owner — for a 2-team
> tie, whoever won the season series; for a 3+-team tie, an owner with a winning series vs **more than
> half** the group — else the owner with the most **Points For**; remove and repeat.

This replaced a non-transitive "H2H win% across the whole group" that mis-seeded 2024 (it ranked
Seahawks over Vikings even though Vikings won head-to-head). It is **rule-driven, not hardcoded**: the
tiebreaker ORDER (h2h/pf/pa) still comes from `seasons.rules` and the pf/pa order stays configurable.
The engine now reproduces the **published seeds for 2023, 2024 AND 2025** (the 2025 ground-truth replay
is unchanged). New test pins the non-transitive 2024 case.

**Playoffs importer** `scripts/import-playoffs.ts` (npm `import:playoffs`): generic + sheet-faithful.
Seeds from the (now-correct) engine, writes each round's DK scores for only the 14 playoff teams
(skips the sheet's "Round 3" consolation bracket), advances, sets the champion from the sheet's
Champion cell (the title game carries no points). Resolves each bracket cell to an owner by **team OR
owner name via the DB** (handles cells that carry only one of the two, and co-owner names). 2023 + 2024
brackets reproduce the sheets exactly (every round, the Super Bowl, the champions). Re-run:
```
npm run import:playoffs -- --season=9  --sheet=1kWMn8Zbk4K7JitaOqxMjII_LKVsKRyqaeXhIJPFkJl8   # 2024
npm run import:playoffs -- --season=11 --sheet=15KWmUsWkQuRgdOCJWUBfaImXZjGxnFp9Lv4UsNikDaA   # 2023
```
(2025 playoffs keep their own `scripts/import-playoffs-2025.ts`, which has hardcoded validation.)

## ✅ DONE — per-season owner display names

Owners are GLOBAL (one row per person, deduped by email) with a single name, so a co-owner who joined
only some seasons bled onto all of them (the 2024 champion showed "Chris deMartino **and Zack Herman**"
because the 2025 sheet, where Zack co-owns, last wrote the shared name). Added
`owner_seasons.displayName` (migration 0007) = the name as **that season's** sheet listed it; the
generic importer populates it (backfilled 2023/2024/2025). Season-scoped views render
`coalesce(owner_seasons.displayName, owners.name)` — standings, seeding/playoffs (incl. champion +
bracket), my-team, odds, per-season history, admin data-status. **All-time per-person aggregates and
the global owner-management pages intentionally keep `owners.name`.**

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

**DK salary + $50k cap is now DONE** (`src/lib/draftkings/{draftables,match}.ts`, `optimize.ts`): the
builder's suggested lineup is a cap-valid DK Classic roster. Salaries come from DK's free, keyless
draftables API; the slate is resolved override(`?dg=`) → admin-pinned (**Admin → Slates**) →
auto-detected main NFL slate (DK lobby). Falls back to signal-only when no salaries are posted (e.g.
the offseason). Pure cap optimizer + matcher are unit-tested.

**Model performance tracker is now DONE** (`src/lib/players/{models,grade,performance}.ts`,
`model_snapshots` table, **Admin → Models**, `models:snapshot`/`models:grade`). The 3 risk profiles are
versioned models — `Floor`/`Blend`/`Ceiling` v0.1.0, stage `heuristic` — and (per the user) will
**graduate to trained ML v1.0** once a season of graded results exists. Forward-looking: `snapshotWeek`
records each model's lineup near lock, `gradeWeek` scores it vs actual player results (Sleeper stats,
PPR proxy) and computes hindsight-optimal + "pay-up chalk" baselines (reusing the cap optimizer). Shown
as a minimizable table inside the builder's model card + Admin → Models. Pure grading math in `grade.ts`.

Remaining Phase B+ follow-ups (not requested): snapshot Sleeper trends so the builder works for *past*
weeks (trending is "now" only); a "build for my H2H matchup" mode; exact DK scoring (the tracker uses
Sleeper PPR as a free proxy).

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
  Admin → Settings has an **"Apply 2025 & earlier rules"** preset button (`applyDefaultRulesAction`)
  that sets a season's rules to `DEFAULT_SEASON_RULES`.
- **Tiebreakers = the league's `resolve_ties`** (head-to-head dominance → Points For, recursive). Do
  NOT "simplify" multi-way ties to a win% — it's non-transitive and was the 2024 mis-seed. The pure
  logic lives in `tiebreakers.ts` (`rankCohort`/`pickTop`); `tiebreaker_functions.R` is the original.
- **DB migrations:** edit `src/db/schema.ts`, then `npm run db:generate` (writes SQL to `drizzle/`) and
  `npm run db:migrate` (applies to `DATABASE_URL`). Latest: 0006 `model_snapshots`, 0007
  `owner_seasons.displayName`.
- **Owner names are per-season** via `coalesce(owner_seasons.displayName, owners.name)`; only all-time
  per-person views + the global owner-management pages use the bare `owners.name`. See the DONE section.
- **Local `.next/* 2.*` files** are an iCloud/Finder duplication artifact on this machine; they make
  `tsc` throw bogus `RouteContext` errors. `find .next -name "* 2.*" -delete` before typecheck.
- Money is cents; points are `numeric` (strings). Use `formatMoney` / `formatPoints` in
  `src/lib/utils.ts`. `src/lib/standings/` stays pure (no DB imports).

## Recent work (newest first)

- **Per-season owner display names** (`owner_seasons.displayName`, migration 0007): season-scoped views
  coalesce it over the global `owners.name` so co-owner changes don't bleed across seasons (2024 champ
  now "Chris deMartino", not "…and Zack Herman"). See the DONE section.
- **Tiebreaker engine rewritten to the league's `resolve_ties`** (`tiebreakers.ts`) + **2023/2024
  playoff brackets imported** (`scripts/import-playoffs.ts`). Engine now matches published seeds for
  2023/2024/2025. See the DONE section. `tiebreaker_functions.R` committed as the reference.
- **Admin → Settings "Apply 2025 & earlier rules" preset** (`applyDefaultRulesAction`); tiebreaker
  order stays an editable rule variable.
- **Interactive + expandable My Team charts** (`team-charts.tsx` now `'use client'`,
  `expandable-chart.tsx`): hover/tap to highlight + tooltip, click to pin, Expand → modal.
- **DraftKings salary + $50k cap optimization** + **lineup-model performance tracker** (see the two
  DONE notes under Phase B). New tables: `model_snapshots`. New admin pages: **Slates**, **Models**.
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

## Start here (fresh session)

The rebuild is **feature-complete** vs the old Google-Sheets workflow — there is **no specific task
queued**. Read this doc + the linked memories, run `npm run verify` (must be 7/7) before any push, and
pick up from whatever the user asks. The most likely future asks: training the lineup models into ML
`v1.0` once the 2026 season produces graded weeks (the tracker collects the data), the My Team
"team-builder wizard Phase B+" follow-ups noted above, or 2026 in-season operations (the scheduled
`keylehr-verify` routine + DK score syncing). Importers are idempotent; data for 2023–2025 (regular
season + playoffs) is in and validated.

## Map of the important code

- Standings/seeding/tiebreaker **engine** (pure, tested): `src/lib/standings/{standings,tiebreakers,seeding,types}.ts`
  (`tiebreakers.ts` = the league `resolve_ties`; `tiebreaker_functions.R` is the original reference)
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
- Rules schema (single source of truth): `src/lib/rules/schema.ts` (`DEFAULT_SEASON_RULES` = the
  canonical 2025-and-earlier config; the admin preset button applies it)
- DraftKings *scoring* ingest (leaderboard): `src/lib/scores/`, `src/app/api/ingest/draftkings/` · Chrome
  ext: `extension/` — distinct from DK *salaries* (`src/lib/draftkings/`, server-side, keyless)
- Admin (commissioner): `src/app/admin/(panel)/` — Owners · Assignments · Schedule · Sync · Playoffs ·
  **Slates** · **Models** · Settings · Users (all auth-gated)
- Season importers (idempotent): `scripts/import-season{,3}.ts` (regular season; `import-season3.ts` is
  the 2025 verify anchor — do NOT modify), `scripts/import-playoffs{,-2025}.ts` (brackets)
