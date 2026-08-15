# Session handoff — KeyLehr H2H

A running "where things stand" doc so a fresh Claude/context window (or contributor) can pick up
without re-deriving everything. Update the **Snapshot**, **Recent work** and **Known open items**
sections as you go; **[Start here](#start-here-fresh-session)** is the entry point.

_Last updated: 2026-08-15 (**live in-progress scoring, Phases 0–3** — the pure DK engine + ESPN
adapter, roster capture/storage with migration `0010` now **applied**, the `draftableId` → identity
bridge, and one-click roster capture in **extension v1.2.0**, all uncommitted; prior: live-scoring
*remediation* Phases 0–4 + the playoff **3rd-place game**, preseason syncing from the DK Chrome
extension, preseason exhibition games, tiebreaker fix + 2023/2024 playoffs + per-season owner names
+ DK salary + model tracker)._

---

## Snapshot

- **Live app:** Vercel (`keylehr-h2h.vercel.app`), auto-deploys from `main`. This session is the
  12-commit run `d0ba364` … `e2a3f1a` (`git log d0ba364^..e2a3f1a`). **Those commit messages are
  the real design record** — read them before touching the scoring or playoff path; each one
  states the bug, the decision and what was rejected.
  > **Push check.** Everything through `a7ce23e` is pushed; `e2a3f1a` (the 3rd-place game) was
  > still local when this was written. Run `git log origin/main..main` — if it lists anything,
  > push it, and note that Vercel has not deployed it yet.
- **Stack:** Next.js 16.2.9 (App Router, Turbopack) · React 19 · Tailwind v4 (CSS `@theme`, no
  config file) · Drizzle + Neon Postgres (**HTTP driver** — every query is a network round-trip) ·
  NextAuth (commissioner login) · a Chrome extension for DraftKings sync.
- **Verification:** `npm run verify` is **9/9 green** (typecheck · lint · **255 unit tests**,
  21 files · production build · ESPN health · engine invariants · **historical snapshot
  unchanged** · **engine no-op proofs** · 2025 ground-truth replay), with the frozen-history
  snapshot byte-identical. The two TRUTH checks are from the remediation session — see the
  freeze-gate part of that DONE section below. It was 144 tests / 16 files at `e2a3f1a`; the extra
  111 are the **uncommitted** live-scoring work in the working tree — 63 engine (Phase 1) + 48
  capture/enrichment (Phases 2–3) — see Recent work. (Counted mid-session while Phase 5 was
  actively landing under `src/lib/live/`, so expect it to have grown; re-run rather than trust it.)
- **Migrations:** applied through **0010** — `0010_polite_nicolaos.sql` (the two live-scoring
  capture tables) is **applied to production**; `lineup_snapshots` and `lineup_capture_runs` exist
  with their unique + season/week indexes. It is purely additive (two new tables, no ALTERs), so it
  moved no score, no standing, and not the frozen snapshot. Both tables are still empty — no
  capture has been posted to production yet.
- **Seasons in DB:** 2023, 2024, 2025 fully imported (regular season **and** playoffs, validated
  against the sheets) and now **frozen behind a snapshot gate** + 2026 (upcoming; schedule synced,
  **all 32 owners assigned**, `missedLineup.opponentScores = league_median` — set by the user in
  Admin → Settings this session — and 16 preseason **exhibition** matchups generated at week 102,
  no exhibition scores ingested yet). 2023–2025 carry `rules = NULL`, i.e. they run on
  `DEFAULT_SEASON_RULES`. The rebuild is feature-complete vs the original Google-Sheets workflow.
  Verified against the prod DB on 2026-08-10: 2023/2024/2025 carry **zero** exhibition rows, which is
  why adding the `isExhibition` exclusions can't move any historical number (the 2025 ground-truth
  replay is unchanged by them).
- **The DFS model:** owners are assigned an NFL team (drives the H2H *schedule* only); each week a score
  is the owner's **NFL-wide DraftKings lineup total**. Players were not tracked at all until Phase B.

## 🛑 Two structural ideas — do not undo either

Both look like accidental complexity and both are load-bearing. If you are about to "simplify"
one of these, read [`docs/SCORING.md`](SCORING.md) first.

**1. `scores.isBye` / `scores.isForfeit` are persisted HINTS, not the source of truth.**
Byes are derived from `nfl_games` (the real NFL schedule) and reconciled at read time against
`matchups`; missed lineups are derived at read time and **UNIONed** with the stored `isForfeit`
flag, which stays the commissioner's manual override. Do not "fix" this by trusting either column
in a query, and do not drop the union — a stored flag must never be overwritten by derivation.
The worst case is an owner with **no `scores` row at all**, which only derivation can reach.

**2. The settled-week gate has TWO conjuncts. Both are required.**

> A week derives missed lineups only when **every one of its NFL games is final** *and* **at least
> one owner has posted a real (non-bye) score** for it. — `computeSettledWeeks`,
> `src/lib/standings/forfeit-derive.ts`

Each half guards a different window in which every owner is legitimately on zero: mid-Sunday
(games not over), and after the last game but **before the DK sync lands** (no scores yet). Drop
either one and a normal week resolves as a **league-wide false forfeit** — an auto-loss for all 32
owners, and because the opponent then plays the league benchmark, a **double loss in all 16
games**. The gate shipped with only the first conjunct (`1b3737a`) and was caught later the same
session while writing `SCORING.md` (`a7ce23e`) — it self-heals on sync and cannot touch the frozen
seasons, so nothing in `verify` went red. Both halves now have tests in `forfeit-derive.test.ts`.

Consequence worth knowing operationally: one score is enough to settle a week, so a **half-synced**
week derives forfeits for the owners still missing rows. Finish a week's sync in one go and
confirm `/admin/sync` reads `32/32`.

## ✅ DONE — the playoff 3rd-place game (`e2a3f1a`)

**The league plays a consolation game.** The two beaten conference finalists meet in championship
week, and that game decides 3rd and 4th. The bracket never modelled it, so those placements could
not be derived at all: the awards importer used a hardcoded map of past winners, and after that was
removed it asked the commissioner for `--third=<ownerSeasonId>` by hand. Both were working around
a game that actually gets played.

- **`third_place` on the `playoff_round` enum** (migration **0009**, additive `ALTER TYPE … ADD
  VALUE`, applied to prod). `PLAYOFF_ROUND_WEEKS.third_place = 22` — it **shares championship
  week**, so it is scored from the same week-22 DraftKings contest and Admin → Playoffs still
  configures one contest id per playoff week.
- `advanceBracket('conference', …)` now returns **two** games: the championship from the round's
  winners, and the consolation game from its losers (`resolveLoser`). Both are cross-conference
  (`conference = null`).
- **It is a LEAF, not a step in the chain.** It is deliberately **absent from
  `PLAYOFF_ROUND_ORDER`**: `advancePlayoffs` walks that list and breaks at the first round that
  has no rows or is not fully scored, so a consolation game sitting in the chain would stop the
  walk *before* the championship whenever it is missing or unplayed. It is resolved explicitly in
  the same pass instead — the per-round scoring was extracted into `resolveRoundGames` so both
  week-22 games are settled by the same code.
- **Awards:** `loadBracketOutcome` reads the resolved consolation row — winner → `third`, loser →
  `fourth` — so all four placements are recorded live when the championship resolves.
  **`--third` survives only as a fallback** for seasons imported before the game was modelled;
  it is ignored when a resolved 3rd-place game exists.
- 2023–2025 have **no** consolation row (their importers deliberately skip the sheets' "Round 3"
  consolation bracket) and are frozen, so nothing historical moved: 2025's bracket renders exactly
  as it did before. `verify` 9/9.

Documented in [`SCORING.md` §12](SCORING.md#12-the-bracket-and-the-game-that-decides-3rd).

## ✅ DONE — live-scoring remediation (Phases 0–4) + the freeze gate

Eleven commits, `d0ba364` … `a7ce23e`. An audit found that the live scoring path was
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
- Derivation is gated on the week being **settled** — every NFL game final (`weekIsFinal` in
  `src/lib/schedule/final.ts`) **and** at least one real score ingested (`computeSettledWeeks`).
  **This is the single most important safety property in the system**; see "Two structural ideas"
  above for why both halves are needed and what breaks without them.
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

**Phase 4 was the documentation pass** (`a7ce23e`) — `docs/SCORING.md`, `docs/RULES.md`,
`docs/RUNBOOK.md` plus corrections to README/ARCHITECTURE/DATA_MODEL/DEPLOYMENT. Writing it found
three real bugs, which is the argument for writing it: the **missing half of the settled-week
gate** (above), `getCurrentSeason` ordering `year` ascending in every bucket so its "most recent
completed" fallback returned the **oldest** completed season, and Admin → Settings' read-only
"Effective rules" panel rendering the ignored `rules.regularSeasonWeeks` mirror while the editor
directly above it wrote the canonical column. **All three are fixed.**

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

> Note, in light of `e2a3f1a`: "skips the consolation bracket" is why 2023–2025 have no
> `third_place` row and therefore no 3rd/4th awards. Backfilling them would move the frozen
> snapshot — see "Known open items".

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
  `npm run db:migrate` (applies to `DATABASE_URL`). Latest: 0008 `isExhibition` on
  `nfl_games`/`matchups`/`scores`, 0009 `third_place` on the `playoff_round` enum, 0010
  `lineup_capture_runs` + `lineup_snapshots`. Every one is documented in
  [`docs/DATA_MODEL.md`](DATA_MODEL.md#migration-history).
- **Owner names are per-season** via `coalesce(owner_seasons.displayName, owners.name)`; only all-time
  per-person views + the global owner-management pages use the bare `owners.name`. See the DONE section.
- **Local `.next/* 2.*` files** are an iCloud/Finder duplication artifact on this machine; they make
  `tsc` throw bogus `RouteContext` errors. `find .next -name "* 2.*" -delete` before typecheck.
- Money is cents; points are `numeric` (strings). Use `formatMoney` / `formatPoints` in
  `src/lib/utils.ts`. `src/lib/standings/` stays pure (no DB imports).

## Recent work (newest first)

- **Live in-progress scoring — Phase 3: one-click roster capture** (⚠️ **uncommitted**). The DK
  roster endpoint was found, the extension went **1.1.0 → 1.2.0**, and captures are now enriched at
  write time. Tests 234 → **255**. Six things to carry forward:
  - **The endpoint is
    `scores/v2/entries/{draftGroupId}/{entryKey}?format=json&embed=roster`** — credentialed. The
    first path segment is the **draft group** id, not the contest id, which is why every
    contestId-shaped guess failed. Real payload frozen at `scripts/fixtures/dk-roster-entry.json`.
  - **There is NO bulk roster endpoint.** `scores/v1/leaderboards/{contestId}?embed=leaderboard,roster`
    returns **200 with an empty `entryByEntryKey` map** — a silent nothing, not an error. Hence one
    authenticated request per entry (concurrency 4, 150–300 ms jitter) in `page-hook.js`
    `captureRosters()`. Entry keys come from the leaderboard the score sync already fetches; nobody
    has to click into a lineup.
  - **Concealment is not a partial capture.** DK hides a player from opponents until that player's
    game kicks off (`draftableId: 0`, no name, `yetToPlay: true`). So 32/32 owners with 18/288
    players revealed is *correct*. A concealed player has scored nothing, so only names are ever
    missing — never points — and because concealment tracks swappability, anything visible is
    already locked and cannot go stale. `revealed` is stored per slot; never render one as `0.00`.
  - **`draftableId` → identity, at capture time.** DK's roster payload has no team and no position,
    and scoring joins ESPN on `(normalizeName, teamKey)`. `src/lib/lineups/enrich.ts` resolves ids
    against the **public** draftables endpoint before the snapshot is written, because DK expires
    draftables for old draft groups. `POST /api/ingest/lineups` reports `enrichedSlots` +
    `unresolvedDraftableIds`; **0 enriched with revealed players means the capture is not scorable.**
    Admin → Lineups sends no `draftGroupId`, so a *pasted* capture is never enriched.
  - **`/api/ingest/lineups` accepts a third body shape**, `rawLineups: [{ entryName, entryKey?,
    roster }]` — the per-entry fan-out. Merge order is `rawRosters` → `rawLineups` → `lineups`,
    later wins on a duplicate entry name.
  - **DK's own `score` and `stats[]` are captured but never scored from** (`slots[].dkScore` /
    `slots[].dkStats`). They exist ONLY at capture time — the authenticated roster endpoint is the
    only source and it ages out with the contest — and they are the reconciliation checkpoint for
    the ESPN estimate. `dkStats` is the sharp one: a matching total can hide two compensating
    errors, a per-stat diff cannot, and it is how `pointsAllowedMode` gets settled empirically.
    `null` = no breakdown in the payload; `[]` = DK says nothing has happened yet. Not the same
    thing.
- **Live in-progress scoring — Phase 2: roster capture + storage** (⚠️ **uncommitted**, on top of
  the Phase 0–1 tree below). Two new tables (`lineup_capture_runs`, `lineup_snapshots`; migration
  `0010_polite_nicolaos.sql`, **now applied to production**), `src/lib/lineups/`
  (`normalize.ts` → `ingest.ts` → `query.ts`), `POST /api/ingest/lineups`, and **Admin → Lineups**
  (capture status `N/32` owners *and* `R/S` players revealed, a paste fallback, a capture-run audit
  table showing which DK URL worked). Tests 207 → **234**. Three things to carry forward:
  - **`lineup_snapshots` is append-only, versioned by `capturedAt`.** DK Classic sets
    `allowLateSwap: true`, so the roster in effect is the *newest* row per `(ownerSeason, week)`
    (`DISTINCT ON`). Do not "simplify" it to one row per owner-week.
  - **`no-write.test.ts` is the safety invariant made mechanical** — it scans every module under
    `src/lib/dfs`, `src/lib/lineups`, `src/lib/live` (discovered, not enumerated, so new files are
    covered automatically) and fails on any write to
    `scores`/`matchups`/`playoff_matchups`/`season_awards`/`nfl_games` or any call to
    `ingestLeaderboard`/`writeTeamScores`. Reads are fine. If it fires, you want a new table.
  - **Three modules were extracted, behaviour unchanged:** `src/lib/ingest/auth.ts` and
    `src/lib/ingest/week-schema.ts` out of the DK route, and `src/lib/scores/owner-match.ts` out of
    `scores/ingest.ts` (both ingests MUST match entry names identically).
- **Live in-progress scoring — Phases 0 and 1 only** (⚠️ **uncommitted working tree** at the time
  of writing: `src/lib/dfs/`, `src/lib/nfl/`, `scripts/dfs-selftest.ts`, two ESPN fixtures, and the
  extension at v1.1.0). A pure DraftKings Classic scoring engine fed by ESPN's public boxscore API,
  so in-progress points can be computed **server-side** without a DK session or a machine left on.
  **It is an ESTIMATE and must never enter the scoring chain** — nothing in `src/lib/dfs/` imports
  the DB or `src/lib/standings/`, and nothing there writes a row. (Phase 2, above, added the
  capture path, which does use the DB — hence the no-write guard. **Phases 4–5 — DK→ESPN player
  matching and a `/live` page — are still not built.**) Also extracted
  `normalizeTeamKey()` out of three private
  copies into `src/lib/nfl/team-keys.ts`, and moved `DK_CLASSIC_SALARY_CAP` into
  `src/lib/dfs/rules.ts` (still re-exported from `draftkings/draftables.ts`, so every existing
  import is unchanged). Tests 144 → **207**. Written up in
  [`SCORING.md` §15](SCORING.md#15-live-in-progress-scoring-an-estimate-never-a-score) and the
  probed endpoint inventory in
  [`DRAFTKINGS.md` §11](DRAFTKINGS.md#11-endpoint-inventory--what-is-public-and-what-needs-auth).
  > **Naming clash, read this:** this is **not** the "live-scoring remediation Phases 0–4" DONE
  > section below. That was a fix to the *existing* chain; this is a new, separate feature with its
  > own phase numbering that sits outside the chain.
- **The playoff 3rd-place game** (`e2a3f1a`) — `third_place` round (migration 0009) generated from
  the conference-round losers alongside the championship, scored from the same week-22 contest;
  3rd/4th now come off a real game instead of `--third`. It is a **leaf**, kept out of
  `PLAYOFF_ROUND_ORDER`. See the DONE section.
- **Live-scoring remediation, Phases 0–4** (`d0ba364` … `a7ce23e`) — eleven isolated
  commits: the snapshot freeze gate + `vitest.config.ts`; pure `schedule/final.ts`,
  `standings/forfeit-derive.ts`, `standings/assemble.ts`; byes from `nfl_games` + batched ingest
  upserts; read-time forfeit derivation and bye reconciliation; win%-only tiebreaker cohorts;
  `/rules` from config + tied weekly highs + a Settings form-remount fix; awards extracted to
  `src/lib/awards/` with split ties, a regular-season cap and per-season rules; safe award
  persistence + live recompute on the championship; bracket-row pruning; three `/history`
  passes (use the engine, canonical columns, request-scoped caching); and Phase 4, the docs pass
  that found and fixed the missing half of the settled-week gate. Tests 77 → **144**, verify
  7/7 → **9/9**. See the DONE section.
- **Documentation pass** (`a7ce23e`, extended `e2a3f1a`+) — new `docs/SCORING.md` (the scoring
  chain end to end, incl. §12 the bracket and the consolation game),
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

## Known open items (honest list)

Nothing here blocks a deploy. Each is a real, specific gap — not a vague "could be nicer".

**Needs a decision or a fix**

- **`src/lib/live/` is undocumented.** Phase 5 (`stats.ts`, `assemble.ts`, `query.ts`) was being
  written *while* this docs pass ran, so nothing in it is described anywhere — not here, not in
  [`SCORING.md` §15](SCORING.md#15-live-in-progress-scoring-an-estimate-never-a-score). There is
  still no `/live` route. Run docs again once its shape settles; do not assume the modules do what
  their names suggest.
- **No capture has ever run against production.** Migration `0010` is applied and both tables are
  **empty**. The whole path — extension → `/api/ingest/lineups` → enrichment → Admin → Lineups — has
  not yet been exercised on a real Sunday, so its first live run is still a test. A dev database may
  still be on `0009`; run `npm run db:migrate` there.
- **A pasted capture is never enriched.** Admin → Lineups sends no `draftGroupId`, so
  `ingestLineups` skips `enrichLineups` and the snapshot keeps only whatever names/teams DK's payload
  carried — which for a real DK roster payload is *none*. That makes a pasted capture unscorable by
  design. Either thread a draft-group id through the form or accept the paste box as a
  store-the-evidence fallback only.
- **A resolved 3rd-place game does not reach the bracket UI.** `getPlayoffBracket` builds its
  `rounds` array as `PLAYOFF_ROUND_ORDER.filter(...)`, and `third_place` is deliberately not in
  that list, so the row is loaded into `byRound` and then dropped. The rendering branch added to
  `src/components/playoff-bracket.tsx` (and the `ROUND_LABELS.third_place` entries) is therefore
  unreachable today on `/playoffs`, `/history/[year]` **and** Admin → Playoffs. The awards path is
  unaffected — `loadBracketOutcome` reads `playoff_matchups` directly, so 3rd/4th still pay
  correctly. Not caught by the `e2a3f1a` check because 2025 has no consolation row to render.
  Fix is in `getPlayoffBracket` (emit the leaf after the chain), **not** in
  `PLAYOFF_ROUND_ORDER` — see the 3rd-place DONE section for why that list must stay four long.
- **2023–2025 have no 3rd/4th awards.** The league played those consolation games; the playoff
  importers skip the sheets' "Round 3" consolation bracket, so the rows do not exist and the
  ledger has no `third`/`fourth` for those years. Backfilling them would move the **frozen**
  snapshot, so it needs the user's sign-off and a deliberate `npm run verify:baseline`.
- **The $25/$50 missed-lineup fine ladder on `/rules` is hardcoded UI** — no key in
  `seasonRulesSchema`, no ledger (fines are recorded nowhere), and the 2nd-offense **suspension is
  deliberately not implemented**. A commissioner enforcing it sets `scores.isForfeit = true`
  manually for the remaining weeks, which the read path always honors as an override. Revisit only
  if the league wants it recorded.
- **The `/rules` page is not season-scoped.** It renders `getCurrentSeason()` with no selector, so
  owners cannot look up what 2024 was scored under — which now matters, because the missed-lineup
  rule genuinely differs by era.
- If `payouts.weeklyHighWeeks` ever diverges from `seasons.regularSeasonWeeks`, the **stricter**
  of the two caps the weekly-high prize. Which should be authoritative is an open league question.

**Stale docs / unpolished tooling**

- ~~`docs/DRAFTKINGS.md` §5 and §7 describe things that do not exist~~ — **fixed.** §5 is now
  explicitly labelled *designed, then rejected, never built* and points at
  `DEPLOYMENT.md` §6; §7 lists the real `triggeredBy` values (`extension`, `admin:preseason`,
  `backfill` — there is no `'manual-paste'`) and marks the hand-entry grid as not built. The two
  sketches are kept, clearly fenced, because they remain the shape any future unattended pull
  would take.
- `scripts/validate-dk-matcher.ts` has **no npm alias and no documentation** — it is invisible
  unless you list the directory.
- Dashboard **"Top of the standings"** mini-table (`getTopStandings`) still uses a simple
  win%→PF→PA sort, not the full configured tiebreaker chain. Fine for a glance; wire if desired.
- `regularSeasonWeeks` is edited only on the admin **Season** card (the column the engine reads);
  the duplicate Rules-card field was removed.

## Start here (fresh session)

Do these three things, in this order:

1. **Read this doc**, then [`docs/SCORING.md`](SCORING.md) — mandatory before touching anything in
   `src/lib/scores/`, `src/lib/standings/`, `src/lib/playoffs/` or `src/lib/awards/`. Pay
   attention to "Two structural ideas — do not undo either" above.
2. **Run `npm run verify`.** It must be **9/9**. It needs `DATABASE_URL`, and its ground-truth
   replay writes to the DB (idempotent, by design); `npm run verify:quick` skips that and the
   production build. If the **historical snapshot** check fires, stop — you moved a frozen season.
3. **Check the repo state:** `git status` and `git log origin/main..main`. `e2a3f1a` may still be
   unpushed (see the push check in Snapshot).

The rebuild is **feature-complete** vs the old Google-Sheets workflow. Importers are idempotent;
2023–2025 (regular season + playoffs) are in, validated, and gated against moving.

**The one task in flight is live in-progress scoring, and Phases 0–3 exist** (the pure engine + the
ESPN adapter, roster capture/storage — `src/lib/lineups/`, `POST /api/ingest/lineups`,
Admin → Lineups — and the extension's one-click **Capture lineups** at v1.2.0, with `draftableId`
resolved to name/team at capture time). Migration `0010` is applied. **Phases 4–5 — matching DK
players to ESPN athletes, and a `/live` page — are not built.** The next move is Phase 4:
`(normalizeName, teamKey)` → ESPN athlete, which the enriched snapshots now supply the inputs for.
Read [`SCORING.md` §15](SCORING.md#15-live-in-progress-scoring-an-estimate-never-a-score) before
touching it; the safety invariant there is not optional, and
`src/lib/lineups/no-write.test.ts` will fail the build if you cross it.

Other likely asks: **2026 in-season operations** (the season is `upcoming` and fully
assigned — [`docs/RUNBOOK.md`](RUNBOOK.md) is the weekly loop, plus the scheduled `keylehr-verify`
routine); the bracket-rendering gap for the 3rd-place game (first item under "Known open items");
training the lineup models into ML `v1.0` once 2026 produces graded weeks; or the My Team
"team-builder wizard Phase B+" follow-ups noted above.

Conventions that will bite you if you skip them: run `verify` **before** pushing (the production
build catches `'use server'` export errors nothing else does); `src/lib/standings/` stays pure (no
DB imports); every `scores`/`matchups` query needs the `isExhibition` filter; and the Neon HTTP
driver means one query = one round-trip, so batch writes.

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
- Playoffs bracket service: `src/lib/playoffs/service.ts` (`PLAYOFF_ROUND_WEEKS` /
  `PLAYOFF_ROUND_ORDER` / `advancePlayoffs` / `getPlayoffBracket`); the pure bracket math is
  `src/lib/standings/playoffs.ts` (`advanceBracket`, `resolveWinner`/`resolveLoser`). The
  consolation game is explained in
  [`SCORING.md` §12](SCORING.md#12-the-bracket-and-the-game-that-decides-3rd) · Odds sim:
  `src/lib/odds/`
- Rules schema (single source of truth): `src/lib/rules/schema.ts` (`DEFAULT_SEASON_RULES` = the
  canonical 2025-and-earlier config, and what 2023–2025 actually run on since their `rules` is
  NULL; the admin preset button applies it). Every key is documented in
  [`docs/RULES.md`](RULES.md).
- DraftKings *scoring* ingest (leaderboard): `src/lib/scores/`, `src/app/api/ingest/draftkings/` · Chrome
  ext: `extension/` — distinct from DK *salaries* (`src/lib/draftkings/`, server-side, keyless)
- Live in-progress **estimate** (a third, separate thing): `src/lib/dfs/` — `rules.ts` (DK Classic
  as frozen data) · `stat-line.ts` (the provider-agnostic input contract) · `score.ts` (the pure
  engine) · `sources/espn-{boxscore,extract,types}.ts` (the public ESPN adapter). Checked by
  `npm run dfs:selftest`. **It must never write to `scores` or reach `src/lib/standings/`** —
  [`SCORING.md` §15](SCORING.md#15-live-in-progress-scoring-an-estimate-never-a-score). Shared
  helper: `src/lib/nfl/team-keys.ts` (`normalizeTeamKey`, one copy for DK + Sleeper + ESPN)
- Roster **capture** for that estimate: `src/lib/lineups/` — `normalize.ts` (pure, structural,
  30 tests) · `enrich.ts` (`draftableId` → name/team/position, 7 tests) · `ingest.ts`
  (`ingestLineups`) · `query.ts` (`getCaptureStatus`, `DISTINCT ON`) ·
  **`no-write.test.ts` (the invariant, enforced)**. Routes: `src/app/api/ingest/lineups/` +
  `src/app/admin/(panel)/lineups/`. Tables `lineup_snapshots` / `lineup_capture_runs`
  (migration 0010, applied). Shared with the score ingest:
  `src/lib/ingest/{auth,week-schema}.ts` + `src/lib/scores/owner-match.ts`. The capture side of the
  extension is `page-hook.js` `captureRosters()`.
- Admin (commissioner): `src/app/admin/(panel)/` — Owners · Assignments · Schedule · **Preseason** ·
  Sync · **Lineups** · Playoffs · **Slates** · **Models** · Settings · Users (all auth-gated)
- Season importers (idempotent): `scripts/import-season{,3}.ts` (regular season; `import-season3.ts` is
  the 2025 verify anchor — do NOT modify), `scripts/import-playoffs{,-2025}.ts` (brackets)
