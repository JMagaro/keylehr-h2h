# Session handoff — KeyLehr H2H

A running "where things stand" doc so a fresh Claude/context window (or contributor) can pick up
without re-deriving everything. Update the **Next up** and **Recent work** sections as you go.

_Last updated: 2026-08-10 (live-scoring remediation, Phases 0–3 — **all pushed, working tree
clean**; prior: preseason syncing from the DK Chrome extension, preseason exhibition games,
tiebreaker fix + 2023/2024 playoffs + per-season owner names + DK salary + model tracker)._

---

## Snapshot

- **Live app:** Vercel (`keylehr-h2h.vercel.app`), auto-deploys from `main`. The 10-commit
  live-scoring remediation (`d0ba364` … `65ecf4a`) is **pushed** — `main` and `origin/main` are
  both at `65ecf4a` and the working tree is **clean**. Those commit messages are the best
  explanation of each change and are worth reading before touching the scoring path.
- **Stack:** Next.js 16.2.9 (App Router, Turbopack) · React 19 · Tailwind v4 (CSS `@theme`, no
  config file) · Drizzle + Neon Postgres (**HTTP driver** — every query is a network round-trip) ·
  NextAuth (commissioner login) · a Chrome extension for DraftKings sync.
- **Verification:** `npm run verify` is **9/9 green** (typecheck · lint · **137 unit tests** ·
  production build · ESPN health · engine invariants · **historical snapshot unchanged** ·
  **engine no-op proofs** · 2025 ground-truth replay). The last two TRUTH checks are new — see
  the remediation DONE section below.
- **Seasons in DB:** 2023, 2024, 2025 fully imported (regular season **and** playoffs, validated
  against the sheets) and now **frozen behind a snapshot gate** + 2026 (upcoming; schedule synced,
  **all 32 owners assigned**, `missedLineup.opponentScores = league_median`, and 16 preseason
  **exhibition** matchups generated at week 102 — no exhibition scores ingested yet). 2023–2025
  carry `rules = NULL`, i.e. they run on `DEFAULT_SEASON_RULES`. The rebuild is feature-complete
  vs the original Google-Sheets workflow.
  Verified against the prod DB on 2026-08-10: 2023/2024/2025 carry **zero** exhibition rows, which is
  why adding the `isExhibition` exclusions can't move any historical number (the 2025 ground-truth
  replay is unchanged by them).
- **The DFS model:** owners are assigned an NFL team (drives the H2H *schedule* only); each week a score
  is the owner's **NFL-wide DraftKings lineup total**. Players were not tracked at all until Phase B.

## ✅ DONE — live-scoring remediation (Phases 0–3) + the freeze gate

Ten commits, `d0ba364` … `65ecf4a`, all pushed. An audit found that the live scoring path was
broken in ways that only appear **during a season** — the historical seasons looked fine because
their backfill scripts wrote the derived columns by hand. The full plan and the decisions locked
with the user are in the commit messages; the resulting behavior is documented in
**[`docs/SCORING.md`](SCORING.md)**.

**The core idea.** `scores.isBye` and `scores.isForfeit` are persisted *derivations* of facts that
live in other tables, written once at ingest with no recompute trigger — so they drift. They are
now **persisted hints, not the source of truth**:

- **Byes** come from `nfl_games` (the real NFL schedule) at write time, never from `matchups`
  (which may not exist yet, skips unassigned games, and holds no playoff rows), and are
  **reconciled at read time**: a row flagged bye for an owner who has a matchup that week is
  self-contradictory and the flag is ignored. Safety valve: a week with zero schedule rows marks
  **nobody** as a bye.
- **Missed lineups** are **derived at read time and UNIONed with any stored `isForfeit`**, so a
  manually-set flag remains the commissioner's override. The ingest path still never writes the
  column — the worst case is an owner who never enters the contest and therefore has no row to
  flag, which only derivation can reach.
- Derivation is gated on the week being **settled** (every NFL game final, `weekIsFinal` in
  `src/lib/schedule/final.ts`). **This is the single most important safety property in the
  system**: without it a mid-Sunday sync sees 32 owners on 0.00 and resolves the week as 32
  forfeits with cascading auto-losses.
- A derived forfeit with **no `scores` row is scored 0** rather than left unscored. Previously
  such a matchup was non-final and got dropped entirely, denying the opponent a win *and*
  shrinking their games played — which then fed the win% tiebreaker cohorts.

**Also landed:** tiebreaker cohorts group by **win% alone** (matching the league's R
`resolve_ties`; requiring equal raw `wins` split genuinely-tied owners once byes made games played
uneven); `/rules` renders the missed-lineup rule from config; `getHighestWeeklyScore` returns
**every** owner tied at the top and caps to the regular season; awards extracted to a pure
`src/lib/awards/compute.ts` that splits ties evenly, caps `most_points` to the regular season and
sources it from the standings engine, honors per-season payout rules, and persists
insert-then-prune (Neon HTTP has no transactions); `upsertRoundGames` prunes superseded bracket
rows; and `/history` now uses the engine instead of re-deriving standings facts, reads the
canonical `seasons` columns, and loads seasons through request-scoped `cache()`.

**The freeze gate (read this before changing the engine).** 2023–2025 were played, validated
32/32 against the commissioner's sheets, and **paid out** — they are frozen; corrections apply
2026 forward.

- `scripts/snapshot-standings.ts` dumps, per frozen season, every owner's record and PF/PA, the
  full ranked **ORDER** per division and conference, both conferences' seeds, the weekly-high and
  most-points leaders, `missedLineup.opponentScores`, and the whole `season_awards` ledger. The
  committed baseline is **`scripts/fixtures/standings-baseline.json`**.
- `npm run verify`'s **historical snapshot unchanged** check diffs against it **exactly** (no
  tolerances) and names the year and field that moved: `HISTORY MOVED — 2025.seeds changed`. This
  closes the gap the ground-truth replay leaves open — that replay covers 2025 only, compares with
  tolerances, and **never asserts seed order**.
- `npm run verify`'s **engine no-op proofs** check asserts four preconditions that make the
  derivation model provably (not merely observably) safe on history: derived forfeits equal the
  stored `isForfeit` set; schedule-derived byes equal the stored `isBye` flags; every owner played
  the same number of games; and every frozen season is still on `league_average`.
- **Re-baselining requires sign-off.** `npm run verify:baseline` rewrites the fixture. Only do it
  when you can name in the commit message which number moved and why that is correct. The one
  legitimate case so far was a snapshot **shape** change (`version` is bumped in
  `snapshot-standings.ts` precisely to force that conversation) where no value moved. After a
  change to the write path, run the gate **twice** so the second run reads the data the
  ground-truth replay just rewrote.
- Read-only inspection: `npm run snapshot:standings`.

**The missed-lineup rule genuinely differs by season.** 2023–2025 were scored on
`league_average`; 2026 uses `league_median`. That is a real rule change, not an inconsistency —
"consistency-fixing" history to the median would rewrite three validated seasons, and PROOF 4
above fails if anyone does. Note 2023–2025 have no `rules` JSONB at all, so changing the **schema
default** in `src/lib/rules/schema.ts` is equivalent to editing history.

## ✅ DONE — preseason exhibition games (tracked, but never count)

The league can now run a for-fun **preseason exhibition** game — real owner-vs-owner matchups + DK
scores that show in the app but **never** count toward standings, playoff seeding, payouts, or
all-time records.

- **Data model (migration 0008):** an `isExhibition` boolean (NOT NULL, default `false`) on
  `nfl_games`, `matchups`, **and** `scores`. Preseason rows live at a **separate week namespace** —
  `week = 100 + preseasonWeek` (101/102/103) — so they can't collide with the regular season (1–18)
  or playoffs (19–22) in any `(…, week)` unique index. Pure helpers live in
  `src/lib/schedule/preseason.ts`: `PRESEASON_WEEK_BASE = 100`, `toExhibitionWeek` /
  `fromExhibitionWeek` / `isExhibitionWeek` / `exhibitionWeekLabel`.
- **Pipeline:** the ESPN client (`src/lib/espn/client.ts`) is now parameterized by `seasonType`
  (regular = 2, preseason = 1 → exported `SEASON_TYPE_PRESEASON`). `src/lib/schedule/sync.ts` gained
  `syncPreseasonWeek(seasonId, year, preseasonWeek)`, which pulls one preseason week as exhibition
  games; `generateMatchups` carries the flag from the game onto the matchup; and the scores ingest
  (`src/lib/scores/ingest.ts`) auto-flags scores written at an exhibition week.
- **Isolation (the whole point):** every real-stats query excludes `isExhibition` —
  `getSeasonStandingsData` (both the matchups and scores loads), `getHighestWeeklyScore`, My Team
  (`src/lib/team/query.ts`), and **every query in `src/lib/history.ts` that reads `scores` or
  `matchups`** (season history + per-season detail, rivalries, all-time leaders, weekly highs, game
  extremes, streaks, missed submissions, schedule luck). Plus defense-in-depth in the pure engine:
  `MatchupResult.isExhibition` + `resolveOutcome` / `buildTiebreakerContext` skip exhibition rows,
  pinned by a `standings.test.ts` case proving a 200-point exhibition game is ignored.
- **Maintenance rule — read this before adding an all-time/history query.** Any query that reads
  `scores` or `matchups` for cross-season stats **must** add `eq(scores.isExhibition, false)` /
  `eq(matchups.isExhibition, false)`, or preseason games silently leak into all-time records. This
  is not hypothetical: rebasing this work onto origin's History overhaul brought in four new
  functions that would have leaked — `getGameExtremes` (biggest blowout / closest game),
  `getStreakLeaders` (win & loss streaks), `getMissedSubmissions` (missed-lineup counts), and
  `getScheduleLuck` — and each had the filter added. To audit, list every `scores`/`matchups` select
  in the file and confirm each one's `where` carries the flag; the module header comment in
  `history.ts` repeats this rule where someone adding a query will actually see it.
  ```
  grep -n 'from(scores)\|from(matchups)' src/lib/history.ts   # every hit needs an isExhibition filter
  ```
- **Surfaces:** a public **`/preseason`** page (`src/app/preseason/page.tsx`, read model
  `src/lib/preseason/query.ts`) showing the exhibition matchups/scores/winners, labeled
  "exhibition — doesn't count"; and an admin **`/admin/preseason`**
  (`src/app/admin/(panel)/preseason/`) to pick the preseason week, sync + generate matchups, and
  enter scores. Nav gained **Preseason** (public + admin) — after origin's nav refresh the public
  order in `src/components/nav-links.ts` is Dashboard · My Team · Standings · Playoffs ·
  **Preseason** · Lineup Builder · Cohen's Corner · History · Rules. `npm run verify` 7/7.
- **Scoring a preseason week (updated — the extension now does it):** the DK Sync extension has a
  **Preseason** checkbox; the Week input then means preseason week 1–3 and the extension POSTs the
  offset week (101–103). `POST /api/ingest/draftkings` accepts **two disjoint week ranges** —
  `1–25` (regular/playoff) and `101–103` (preseason exhibition) — and rejects everything in
  between, so a typo can't land a preseason score in a real week. Nothing else flags the sync:
  `ingestLeaderboard` derives `isExhibition` from the week. The paste form on Admin → Preseason is
  now the **fallback** (for when there's no DK contest to pull from), not the only path. Live Sync
  works in preseason mode with no change to `extension/background.js` — it carries the week through
  opaquely and auto-stops on DK contest completion, which is week-agnostic. **Gotcha:**
  `extension/popup.js` *mirrors* `PRESEASON_WEEK_BASE`/`MAX_PRESEASON_WEEK` (and the route's
  `MAX_REGULAR_WEEK`) as plain constants — an extension can't import app code, so those move
  together. `src/lib/schedule/preseason.test.ts` pins the invariants on the server side.

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
below `lg` (7 items at the time; **9 today** — Preseason and Cohen's Corner were added since).
Verified at the time: `npm run verify` 7/7 (54 unit tests).

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

- **`scores.isBye` / `scores.isForfeit` are hints, never the source of truth.** Do not write a
  query that trusts either column on its own — use the `forfeitByOwnerWeek` set from
  `getSeasonStandingsData()` and `isEffectiveBye()`. Any forfeit derivation must stay gated on the
  week being settled. [`docs/SCORING.md`](SCORING.md) is the contract.
- **The canonical `seasons` columns win.** `regularSeasonWeeks` and `entryFeeCents` exist in both
  a column and the `rules` JSONB; the Settings page writes the column and deliberately preserves
  the mirror, so they drift. Read `seasonRow.regularSeasonWeeks ?? rules.regularSeasonWeeks`.
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
  Cohorts are keyed on **win% alone** (matching the R's `group_by(Win_Percentage)`); do not add
  raw `wins` back to the key — that splits genuinely-tied owners whenever games played is uneven,
  which is the normal state of a season from about week 5 on.
- **DB migrations:** edit `src/db/schema.ts`, then `npm run db:generate` (writes SQL to `drizzle/`) and
  `npm run db:migrate` (applies to `DATABASE_URL`). Latest: 0006 `model_snapshots`, 0007
  `owner_seasons.displayName`, 0008 `isExhibition` on `nfl_games`/`matchups`/`scores`.
- **Owner names are per-season** via `coalesce(owner_seasons.displayName, owners.name)`; only all-time
  per-person views + the global owner-management pages use the bare `owners.name`. See the DONE section.
- **Local `.next/* 2.*` files** are an iCloud/Finder duplication artifact on this machine; they make
  `tsc` throw bogus `RouteContext` errors. `find .next -name "* 2.*" -delete` before typecheck.
- Money is cents; points are `numeric` (strings). Use `formatMoney` / `formatPoints` in
  `src/lib/utils.ts`. `src/lib/standings/` stays pure (no DB imports).

## Recent work (newest first)

- **Live-scoring remediation, Phases 0–3** (`d0ba364` … `65ecf4a`, **pushed**) — ten isolated
  commits: the snapshot freeze gate + `vitest.config.ts`; pure `schedule/final.ts`,
  `standings/forfeit-derive.ts`, `standings/assemble.ts`; byes from `nfl_games` + batched ingest
  upserts; read-time forfeit derivation and bye reconciliation; win%-only tiebreaker cohorts;
  `/rules` from config + tied weekly highs + a Settings form-remount fix; awards extracted to
  `src/lib/awards/` with split ties, a regular-season cap and per-season rules; safe award
  persistence + live recompute on the championship; bracket-row pruning; and three `/history`
  passes (use the engine, canonical columns, request-scoped caching). Tests 77 → **137**, verify
  7/7 → **9/9**. See the DONE section.
- **Documentation pass for the above** — new `docs/SCORING.md` (the scoring chain end to end),
  `docs/RULES.md` (every `seasons.rules` key), `docs/RUNBOOK.md` (the commissioner's weekly loop);
  corrections to `README.md`, `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`, `docs/DEPLOYMENT.md`.
- **Preseason syncing from the DK Chrome extension** (`extension/popup.{html,css,js}`,
  `src/app/api/ingest/draftkings/route.ts`, `src/lib/schedule/preseason.test.ts`). A **Preseason**
  checkbox in the popup switches the Week input to preseason weeks 1–3 and POSTs them offset
  (101–103); the ingest endpoint's `week` went from `min(1).max(25)` to a refinement accepting the
  two **disjoint** ranges `1–25` and `101–103`. Admin → Preseason card 2 is retitled "Scores" and
  now points at the extension, with the paste box as the fallback. `background.js` unchanged (Live
  Sync is week-agnostic). See the DONE section.
- **Preseason exhibition games** (migration 0008 `isExhibition` on `nfl_games`/`matchups`/`scores`;
  `src/lib/schedule/preseason.ts`; `syncPreseasonWeek`; `/preseason` + Admin → Preseason): tracked
  owner-vs-owner preseason matchups + DK scores at a separate week namespace (`week = 100 +
  preseasonWeek`) that **never** affect standings/seeding/playoffs/payouts/all-time. Every real-stats
  query and the pure engine exclude `isExhibition`; unit-tested. See the DONE section.
  **Rebased onto origin's History / Rules / Cohen's Corner work** — the merge point was
  `src/lib/history.ts`, whose new all-time analytics all had to pick up the exhibition filter (see
  the maintenance rule in the DONE section). `npm run verify` is 7/7 post-rebase. **Pushed** (see
  Snapshot).
- **History / Rules / Cohen's Corner (upstream, `origin/main`)** — landed while the preseason branch
  was out; **none of it is written up in these docs yet** (see "Known minor follow-ups"):
  - `/history` overhaul — per-season detail pages (`/history/[year]`), a head-to-head page
    (`/history/head-to-head`) with per-opponent drill-down, owner trends, and an all-time
    "Records & stats" section (game extremes, streaks, weekly highs, schedule luck, net earnings)
    with tie-aware ranks. Backed by the new analytics in `src/lib/history.ts` and a
    `season_awards` backfill (`npm run import:awards`).
  - Rules overhaul (`/rules`) — tiebreakers, missed-lineup penalties, DK scoring card, governance
    copy — plus a new `missedLineup.opponentScores` option **`league_median`** wired through the
    engine (`src/lib/rules/schema.ts` → `src/lib/standings/query.ts`).
  - `/cohens-corner` placeholder page (+ nav + Explore card), a branded 404
    (`src/app/not-found.tsx`) and route error boundary (`src/app/error.tsx`), a dashboard pre-season
    module for un-started seasons, and a nav/brand refresh.
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

- **The settled-week gate does not require that anything has been synced.** A week whose NFL games
  are all final but whose scores have not been ingested yet has, for every owner, a matchup + a
  settled week + no `scores` row — which derives as a league-wide missed lineup until the sync
  lands. It self-heals immediately on sync, but `/standings` and any `import:awards` run in that
  window are wrong. The approved design had a second conjunct ("**and** at least one owner has a
  non-bye score") that is not in `getSeasonStandingsData`. Either add it, or treat "sync promptly
  after Monday night" as the operating rule (documented in `docs/RUNBOOK.md`). **Decide before
  week 1 of 2026.**
- **`getCurrentSeason()` picks the OLDEST completed season, not the newest.** Its docstring says
  "otherwise the most recent completed", but it orders `seasons.year` ascending — correct for
  "soonest upcoming", wrong for the completed fallback. Latent today (2026 is `upcoming`, so it
  wins), but it would bite once every season is `completed`. Drives `/rules`, Admin → Settings and
  several admin pages.
- **The `/rules` page is not season-scoped.** It renders `getCurrentSeason()` with no selector, so
  owners cannot look up what 2024 was scored under — which now matters, because the missed-lineup
  rule genuinely differs by era.
- **Admin → Settings' read-only "Effective rules" panel shows `rules.regularSeasonWeeks`** (the
  ignored JSONB mirror) while the Season card above it edits the canonical column. If they ever
  diverge, that panel shows the stale number.
- **The $25/$50 missed-lineup fine ladder on `/rules` is hardcoded UI** — no key in
  `seasonRulesSchema`, no ledger, and the 2nd-offense suspension is not implemented (the
  commissioner enforces it by setting `scores.isForfeit` manually, which the read path honors).
  Deliberately not built; revisit only if the league wants it recorded.
- If `payouts.weeklyHighWeeks` ever diverges from `seasons.regularSeasonWeeks`, the **stricter**
  of the two caps the weekly-high prize. Which should be authoritative is an open league question.
- Dashboard **"Top of the standings"** mini-table (`getTopStandings`) still uses a simple
  win%→PF→PA sort, not the full configured tiebreaker chain. Fine for a glance; wire if desired.
- `docs/DRAFTKINGS.md` still has a §5 runbook for the rejected Vercel-Cron pull and a §7 that
  documents a `'manual-paste'` `triggeredBy` and a hand-entry grid that do not exist (real values
  are `extension`, `admin:preseason`, `backfill`). `src/db/schema.ts`'s comment on
  `scoreImportRuns.triggeredBy` repeats the stale list. `scripts/validate-dk-matcher.ts` has no
  npm alias and is undocumented.
- `regularSeasonWeeks` is edited only on the admin **Season** card (the column the engine reads);
  the duplicate Rules-card field was removed.

## Start here (fresh session)

The rebuild is **feature-complete** vs the old Google-Sheets workflow, and the live-scoring
remediation (Phases 0–3) is pushed and deployed — `main` and `origin/main` are both at `65ecf4a`
with a clean tree (confirm with `git status` / `git log origin/main..main`). There is no specific
task queued.

Read this doc, [`docs/SCORING.md`](SCORING.md) if you are going anywhere near scoring, and the
linked memories. Run `npm run verify` (must be **9/9**) before any push. The most likely future
asks: the settled-week decision in "Known minor follow-ups" (**before week 1 of 2026**); 2026
in-season operations (see [`docs/RUNBOOK.md`](RUNBOOK.md) and the scheduled `keylehr-verify`
routine); training the lineup models into ML `v1.0` once 2026 produces graded weeks; or the My
Team "team-builder wizard Phase B+" follow-ups noted above. Importers are idempotent; data for
2023–2025 (regular season + playoffs) is in, validated, and now gated against moving.

## Map of the important code

- **The scoring chain end to end: [`docs/SCORING.md`](SCORING.md).** Read it first.
- Standings/seeding/tiebreaker **engine** (pure, tested):
  `src/lib/standings/{standings,tiebreakers,seeding,types}.ts` (`tiebreakers.ts` = the league
  `resolve_ties`; `tiebreaker_functions.R` is the original reference), plus the newer pure pieces
  `src/lib/standings/{forfeit-derive,assemble}.ts` and `src/lib/schedule/final.ts` (the one
  definition of "is this game/week over?", shared with the sync dashboard).
- DB adapter feeding the engine: `src/lib/standings/query.ts` (`getSeasonStandingsData` is the hub —
  returns `rankingOptions` + `playoffConfig` + `regularSeasonWeeks` + `forfeitByOwnerWeek`; the
  `*Cached` exports are request-scoped and **for app code only, never scripts**)
- Payout ledger: `src/lib/awards/{compute,service}.ts` (pure math + the DB shell) driven by
  `scripts/import-awards.ts` and by `advancePlayoffs` when the championship resolves
- Freeze gate: `scripts/snapshot-standings.ts` + `scripts/fixtures/standings-baseline.json`,
  enforced by the two TRUTH checks in `scripts/verify.ts`
- Per-team dashboard data: `src/lib/team/query.ts`
- History & all-time analytics (server-only): `src/lib/history.ts` — powers `/history`,
  `/history/[year]`, `/history/head-to-head`. Aggregates by PERSON (`owners.id`), not per-season
  owner. **Every query here that touches `scores`/`matchups` must filter `isExhibition` —
  see the maintenance rule in the preseason DONE section.**
- Preseason (exhibition) games: `src/lib/schedule/preseason.ts` (week-namespace helpers, pure,
  `preseason.test.ts`), `src/lib/schedule/sync.ts` `syncPreseasonWeek`, `src/lib/preseason/query.ts`
  (public read model); routes `/preseason` (`src/app/preseason/`) + Admin → Preseason
  (`src/app/admin/(panel)/preseason/`). Rows carry `isExhibition` (migration 0008) and are excluded
  from every stats query. Scores arrive through the normal ingest endpoint at the offset week —
  `POST /api/ingest/draftkings` accepts `1–25` **or** `101–103` — driven by the extension's
  **Preseason** toggle (`extension/popup.js`, which mirrors the constants).
- Player signals + lineup builder: `src/lib/players/{sleeper,espn-news,recommend,query}.ts`
  (`recommend.ts` is the pure engine; `query.ts` is the DB/schedule orchestration hub)
- DraftKings salaries + cap optimizer: `src/lib/draftkings/{draftables,match}.ts`, `src/lib/players/optimize.ts`
- Lineup-model versioning + performance: `src/lib/players/{models,grade,performance}.ts`
  (`grade.ts` is the pure grading math; `performance.ts` adds DB + Sleeper-stats I/O). Cmds:
  `npm run models:snapshot -- --season=<id> --week=<n>` and `models:grade`. Admin → Models drives it.
- Playoffs bracket service: `src/lib/playoffs/service.ts` · Odds sim: `src/lib/odds/`
- Rules schema (single source of truth): `src/lib/rules/schema.ts` (`DEFAULT_SEASON_RULES` = the
  canonical 2025-and-earlier config, and what 2023–2025 actually run on since their `rules` is
  NULL; the admin preset button applies it). Every key is documented in
  [`docs/RULES.md`](RULES.md).
- DraftKings *scoring* ingest (leaderboard): `src/lib/scores/`, `src/app/api/ingest/draftkings/` · Chrome
  ext: `extension/` — distinct from DK *salaries* (`src/lib/draftkings/`, server-side, keyless)
- Admin (commissioner): `src/app/admin/(panel)/` — Owners · Assignments · Schedule · **Preseason** ·
  Sync · Playoffs · **Slates** · **Models** · Settings · Users (all auth-gated)
- Season importers (idempotent): `scripts/import-season{,3}.ts` (regular season; `import-season3.ts` is
  the 2025 verify anchor — do NOT modify), `scripts/import-playoffs{,-2025}.ts` (brackets)
