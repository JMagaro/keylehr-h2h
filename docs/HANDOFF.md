# Session handoff — KeyLehr H2H

A running "where things stand" doc so a fresh Claude/context window (or contributor) can pick up
without re-deriving everything. Update the **Snapshot**, **Recent work** and **Known open items**
sections as you go; **[Start here](#start-here-fresh-session)** is the entry point.

_Last updated: 2026-08-23 (**three things landed and are NOT yet committed** — see
[Recent work](#recent-work-newest-first): a **mobile rebuild of `/live`** (presentation only, no
logic change), **Live Sync now refreshes rosters conditionally** via the new
**`GET /api/live-status`** (**extension 1.4.0 → 1.5.0**), and a **scoring-drift audit** at
**Admin → Scoring** that reconciles our per-player numbers against DraftKings' own. `verify` 9/9,
**349 tests**, typecheck + lint clean. Before that: **live in-progress scoring, Phases 0–5** — the
pure DK engine + ESPN adapter, roster capture/storage with migration `0010` **applied**, the
`draftableId` → identity bridge, `src/lib/live/` incl. **capture-staleness detection**, the
**`/live`** + **`/live/[matchupId]`** pages, one-button Sync in the extension, `liveTag` wired to
the capture, and the removal of **all** exhibition tooling (public page *and* admin setup). **Then,
on top:** schedule-derived **week detection** (`GET /api/current-week`) closing the silent
wrong-week-overwrite hazard, **minutes remaining** from ESPN's clock, and **projections +
win probability** using DraftKings' own reverse-engineered formula — all of which **are** pushed
and deployed. Prior: live-scoring *remediation* Phases 0–4 + the playoff
**3rd-place game**, preseason syncing from the DK Chrome extension, preseason exhibition games,
tiebreaker fix + 2023/2024 playoffs + per-season owner names + DK salary + model tracker)._

---

## Snapshot

- **Live app:** Vercel (`keylehr-h2h.vercel.app`), auto-deploys from `main`. The live-scoring
  session is the run `6559f0f` … `52c7d2b` (`git log -p 6559f0f^..HEAD`) — eleven commits, of which
  the last three (`ce25c78` week detection, `ec16bde` minutes, `52c7d2b` projections) came after the
  Phase 0–5 write-up — on top of the earlier 12-commit run `d0ba364` … `e2a3f1a`. **Those commit
  messages are the real design record** — read them before touching the scoring, live or playoff
  paths; each one states the bug, the decision and what was rejected.
  > **Push check.** ⚠️ **The 2026-08-23 work is UNCOMMITTED** — the mobile `/live` rebuild, the
  > Live Sync roster refresh (extension **1.5.0**) and the scoring-drift audit are all in the
  > working tree, not in a commit and not deployed. `git status` is the check; `git diff HEAD`
  > shows the lot. Everything before it is pushed: `54fcc22..0b2f686` went to `origin/main` on
  > 2026-08-16 and Vercel deployed it, verified in production (`/live` 200,
  > `/live/[matchupId]` 200, `/api/current-week` 200 — the local `INGEST_TOKEN` works against prod,
  > same value — and `/preseason` correctly 404). Always re-check with
  > `git log origin/main..main`; anything listed is unpushed work from a later session.
  >
  > **Nothing new needs a migration.** The audit adds no table and the endpoint adds no column —
  > both read what is already stored. Deploying is a push; there is no `db:migrate` step.

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
- **Surfaces — ALL GONE as of `ed6ef78`. Creation removed, isolation permanent.** Originally a
  public `/preseason` page plus an admin `/admin/preseason`. `d3cc2e9` removed the public page
  (arguing the admin tool should stay); **`ed6ef78` then removed the rest**, because the league
  decided it does not want exhibitions at all. Deleted: `src/app/preseason/`,
  `getPreseasonSeasonOptions`, `src/app/admin/(panel)/preseason/{page,actions,preseason-forms}.tsx`,
  the Admin nav entry, `src/lib/preseason/query.ts`, and **`syncPreseasonWeek`**.
  `SEASON_TYPE_PRESEASON` is now declared in `src/lib/espn/client.ts` with **zero consumers**, and
  `scripts/pull-schedule.ts` has no preseason flag — so **nothing can create a new exhibition week.**
  That is the intended end state.
  > 🛑 **The isolation is NOT dead code — do not remove it.** `isExhibition` columns, every query
  > filter, the `101`–`103` ingest range and `src/lib/schedule/preseason.ts` all stay, because
  > **exhibition rows exist in the database** (week 102: 16 matchups, 12 scores, 6 lineup snapshots
  > as of 2026-08-15). The namespace is the only thing keeping that test data out of standings,
  > seeding, playoffs, payouts and all-time records. Deleting the filters "because we don't do
  > preseason any more" would silently corrupt every historical number. `/live` still renders those
  > weeks and the extension's **Preseason** toggle still posts `101`–`103`.

  The public nav order in `src/components/nav-links.ts` is now Dashboard · My Team · **Live** ·
  Standings · Playoffs · Lineup Builder · Cohen's Corner · History · Rules, and the dashboard hero +
  Explore card link to `/live`.
- **Scoring a preseason week (updated — the extension now does it):** the DK Sync extension has a
  **Preseason** checkbox; the Week input then means preseason week 1–3 and the extension POSTs the
  offset week (101–103). `POST /api/ingest/draftkings` accepts **two disjoint week ranges** —
  `1–25` (regular/playoff) and `101–103` (preseason exhibition) — and rejects everything in
  between, so a typo can't land a preseason score in a real week. Nothing else flags the sync:
  `ingestLeaderboard` derives `isExhibition` from the week. (The Admin → Preseason paste form that
  used to be the fallback here no longer exists — see the Surfaces note above.) Live Sync
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

- **Scoring-drift audit: Admin → Scoring** (⚠️ **uncommitted**). Tests 333 → **349**. New pure
  module `src/lib/live/reconcile.ts` (`reconcileSlot` / `reconcileWeek`,
  `RECONCILE_TOLERANCE = 0.01`; 14 tests) and its read-only DB half `reconcile-query.ts`
  (`reconcileWeekFromDb`, `buildReconciliation`, `getReconcilableSeasons`, `getCapturedWeeks`).
  New page `src/app/admin/(panel)/scoring/page.tsx`, with a **Scoring** entry in the admin nav
  between Lineups and Playoffs. Written up in
  [`SCORING.md` §15](SCORING.md#does-the-estimate-agree-with-draftkings--the-drift-audit).
  - **The problem it solves is silence.** `/live` computes DK Classic points from ESPN. If one of
    those rules were wrong, **nothing would ever say so** — the page would render slightly wrong
    numbers forever and look perfectly healthy doing it. The one reconciliation that existed was
    done **by hand, once** (max |delta| 0.00 across 6 owners) and never repeated.
  - **It costs nothing, because both sides are already in the database.** Every capture stores
    DraftKings' own per-player `dkScore` **and** `dkStats`. No new collection, no new table, no
    migration — computed on demand, because a stored copy would be a third thing to keep in sync.
  - **The verdicts exist to route a finding to the right owner**, which is the whole reason a
    total-only diff isn't enough: `ruleDrift` (same stat line, different price — **our** bug, in
    `src/lib/dfs/rules.ts`) · `statDrift` (ESPN and DK saw different plays — not ours) ·
    `unmapped` (**DK paid for a key the audit's `DK_TO_OUR_KEY` map does not know — that points at
    the MAP, not at the scoring rules**, so nobody hunts a defect that does not exist) ·
    `unmatched` (the ESPN name/team join failed) · `agree` · `notComparable`.
  - **The key map was built from REAL captured payloads**, not documentation. Observed:
    `PaYds PaTD INT RuYds RuTD REC RecYds RecTD SACK DFR Targets` plus points-allowed tier rows
    (`0 PA`, `1-6 PA`, `7-13 PA`, `14-20 PA`). Two subtleties: **`INT` means thrown for a QB and
    caught for a DST**, resolved by the slot; and **points-allowed rows are compared on POINTS, not
    value**, because DK's row is a flag (value 1) named for its range while ours records the actual
    points conceded.
  - **🛑 THE TRAP: `dkScore` is a SNAPSHOT from capture time, ours is LIVE.** So a slot is judged
    only when its game is **final** *and* the capture **postdates** it. `ASSUMED_GAME_LENGTH_MS =
    4 hours` in `reconcile-query.ts` is the one approximation in the feature — neither ESPN nor our
    schedule records when a game **ENDED** — and it errs deliberately toward "not comparable",
    because the other direction *invents* drift by comparing a half-finished DK number with a
    finished one.
  - **RESULT ON REAL DATA.** Season 1 week 102: **54 slots, 54 agree, 0 rule drift, 0 unmapped,
    0 unmatched, 0 skipped, max |delta| 0.00 across 6 owners** — reproducing the earlier hand-done
    reconciliation automatically.
  - **🛑 EXPLICITLY REJECTED — do not re-litigate.** Two alternatives were considered and turned
    down. (1) **Making DraftKings' official totals the headline number on `/live`**: they are
    frozen between polls, so the page would stop moving whenever the machine sleeps — and `/live`
    working with every machine switched off is the entire reason the capture architecture exists.
    (2) **Truing up per-player scores on every poll**: that needs the capture write path
    re-engineered from **append-only to update-in-place**, plus per-game state recorded on each
    slot, to correct a discrepancy measured at **0.00**. This audit is how we would find out if
    that ever stops being true — **only then** is it worth reopening.
- **Live Sync now refreshes rosters, conditionally; `GET /api/live-status`** (⚠️ **uncommitted**,
  extension **1.4.0 → 1.5.0**). New route `src/app/api/live-status/route.ts` — bearer
  `INGEST_TOKEN`, CORS mirroring `/api/current-week`, returns
  `{ shouldRecapture, reason, hasCapture, capturedAt, concealedSlots, gamesStartedSinceCapture,
  gamesLoaded, gamesTotal, matchups, missingCaptures }`. Contract in
  [`DRAFTKINGS.md` §14](DRAFTKINGS.md#14-the-capture-staleness-endpoint-implemented); rationale in
  [`SCORING.md` §15](SCORING.md#keeping-the-capture-fresh-without-asking-anyone).
  - **🛑 WHY IT IS CONDITIONAL — this is the crux, and the obvious implementation is wrong.** The
    leaderboard is **one** request and `scores` upserts on `(ownerSeasonId, week)`, so polling
    scores costs nothing in traffic or storage. Rosters invert both: DraftKings has **no bulk
    roster endpoint** (documented in `extension/page-hook.js`, the "Roster capture (live scoring)"
    header above `ROSTER_URL_TEMPLATE`), so a refresh is **one credentialed request PER ENTRY —
    32** — and captures are **append-only**. Every poll would be
    **~4,000 requests against the commissioner's own DK account** across a Sunday and
    **~250 MB/season** of near-identical rows, versus **~6–8 refreshes/week and ~1 MB/week** for
    the conditional version — **at identical freshness**, because a roster only changes when
    DraftKings reveals players at a kickoff. Measured: ~2.2 KB per entry per capture → ~71 KB raw
    payload + ~37 KB snapshots per 32-owner capture.
  - **No new predicate.** The route reuses the already-tested `assessCaptureStaleness`. It adds
    exactly one case staleness cannot express: **a week with matchups but no capture at all**,
    where there is no `capturedAt` to compare kickoffs against.
  - **The final poll is UNCONDITIONAL**, and that is deliberate: when DK reports the contest
    complete, that is the one capture where **every player is revealed and DK's per-player numbers
    are final** — which is exactly what the new scoring audit reconciles against.
  - **The roster half is best-effort throughout.** It must never stop the score loop or the poll
    timer, and it reports into its **own** popup line (`Rosters:`) so a roster problem is never
    mistaken for a score problem. New `background.js` functions: `appUrl`, `postJson` (generalised
    out of `postIngest`), `shouldRefreshRosters`, `requestRosterCapture`, `maybeRefreshRosters`.
    New persisted state: `lastRosterSync`, `lastRosterError`. `popup.js` `renderLive()` shows them.
    The capture reuses the popup's **existing** `CAPTURE_ROSTERS` bridge — one tested capture path,
    not two.
- **Mobile rebuild of `/live` — no logic change** (⚠️ **uncommitted**). Presentation only; the data
  path, the five slot states and every number are untouched.
  - **`matchup-detail.tsx`:** the mirrored `grid-cols-[1fr_auto_1fr]` layout is now **`sm:` and up
    only**. Below `sm` the same data renders **STACKED** — one block per roster slot with both
    players full width beneath it, plus a **two-tone legend** identifying which row belongs to which
    owner. Reason: at 390px the mirrored layout left **~70px per player**, truncating names and
    dropping the stat line entirely. **Two layouts, ONE data source** — everything is computed once
    and rendered twice; do not let the variants drift.
  - **`matchup-nav.tsx`:** prev/next collapse to two **44px** arrow buttons flanking the jump
    dropdown below `sm`; full cards from `sm` up. **Also fixed a real bug:** the `<label>` around
    the jump `<select>` was **inline**, so `w-full` did nothing and the select fell back to its
    **intrinsic** width (its longest option), pushing the whole page wider than a phone viewport.
    It is now `block w-full`.
  - **`matchup-card.tsx`:** tighter padding below `sm`, roster summary truncates, footer wraps. The
    "not captured" badge was shortened from a sentence naming the owner to
    **"1 lineup not captured" / "Neither lineup captured"** — the row directly above already says
    which side is missing and shows `—`.
  - **`live/page.tsx`:** the "N lineups not captured" notice now names at most **six** owners then
    counts the rest (`MAX_NAMED_MISSING = 6`); listing 26 names filled an entire phone screen before
    any matchup appeared. Card grid is `md:grid-cols-2` (was `lg:`). Tighter page padding below
    `sm`.
  - **Verified with Chrome DevTools Protocol device emulation at 360 / 390 / 768px:**
    `document.documentElement.scrollWidth` equals the viewport width and no element exceeds it.
- **Projections + win probability, closeness sort, difference-maker** (`52c7d2b`). Tests 315 →
  **330**. New pure module `src/lib/live/projection.ts` (`projectSlot`, `projectLineup`,
  `winProbability`, `formatWinProbability`; 14 tests). Written up in
  [`SCORING.md` §15](SCORING.md#projections--win-probability--draftkings-own-formula).
  - **The formula is DraftKings' own, reverse-engineered EXACTLY** — not a model we invented. DK's
    roster payload carries both a `pregameProjection` and a `realTimeProjection`; three captured
    samples pin the relationship to **nine decimal places**:
    `projected = score + pregameProjection × (minutesRemaining / 60)`. Trammell 1.50 + 14.6667 ×
    (34.35/60) = 9.896667 (DK: 9.896667); 3.80 + 14.6667 × (30.00/60) = 11.133333 (DK: same);
    Williams 0.00 + 14.6667 × (60.00/60) = 14.666667 (DK: same). Those three cases are pinned in
    `projection.test.ts`, so **if DK changes how it projects, the tests fail** rather than the page
    drifting.
  - **Only the PREGAME number is stored.** `LineupSlotInput.dkProjection` captures it (it exists
    only at capture time, like draftables); the live figure is **recomputed from ESPN's clock every
    render**, so it keeps moving with no machine on — the same property the whole live estimate runs
    on. The `/api/ingest/lineups` schema accepts `dkProjection`.
  - **Win probability is a MODEL, and is labelled as one.** Normal CDF over the projected margin,
    sd shrinking with the minutes left. `LINEUP_SD_FULL_SLATE = 40` is a **rough industry figure,
    never fitted** — isolated as one constant precisely so that fitting it, once a season of real
    results exists, is a one-line change. It never renders 0%/100% mid-game, and it is only computed
    when **both** lineups are captured.
  - **`/live` now sorts by CLOSENESS** (`|winProbability − 0.5|`), uncaptured matchups last. The
    detail page highlights the **largest single-slot gap** (≥ 5 pts, both sides scored) as the
    difference-maker.
- **Minutes remaining; less duplication on the matchup page** (`ec16bde`). Tests 302 → **315**. New
  pure module `src/lib/live/minutes.ts` (`minutesLeftInGame`, `lineupMinutes`, `parseClockMinutes`,
  `formatMinutes`; 12 tests). ESPN's `status.period` / `status.displayClock` now flow through
  `extractGame` (new `period` / `displayClock` on `ExtractedGame`) into `LiveStatIndex.teamState`.
  - **Why it matters:** 40 points with 300 minutes left is a completely different position from 40
    with 12, and the page could not say which one you were looking at.
  - **Concealed slots count as a full 60** — DK conceals exactly until kickoff, so a concealed slot
    had a whole game ahead of it. **Overtime clamps to 0**, since the metric is denominated in 60.
  - **✅ The PMR discrepancy is RESOLVED — do not re-open it.** An earlier note said DK's rule could
    not be reproduced, because Mario Williams read 60 with his game at "15:00 3rd" where the formula
    gives 30. His record carried **`eTag: "1"`** against Trammell's `137`/`193`: DraftKings only
    refreshes a player's row when something changes, and Williams had recorded nothing all game, so
    that 60 was **stale data, not a different rule**. Our clock-derived number is the fresher one.
    The module is still named for our own computation, not "PMR", because that is what it is.
  - **`/live/[matchupId]` lost its `PageHeader`** — the matchup was named three times and the week
    twice, pushing the scores below the fold. `matchup-switcher.tsx` → **`matchup-nav.tsx`**, now
    carrying both owners, logos, scores and minutes on prev/next.
- **Week detection from the schedule** (`ce25c78`). Tests 291 → **302**. New pure module
  `src/lib/schedule/current-week.ts` (`pickWeek`, `rangeForWeek`; types `WeekRange`, `DetectedWeek`,
  `ScheduleGame`; 11 tests), its DB half `current-week-query.ts` (`detectCurrentWeek`,
  `getWeekRange`), and `GET /api/current-week` — bearer `INGEST_TOKEN`, CORS like `/api/seasons`.
  Contract in [`DRAFTKINGS.md` §13](DRAFTKINGS.md#13-the-week-detection-endpoint-implemented);
  rationale in [`SCORING.md` §4](SCORING.md#which-week-is-it--detecting-it-from-the-schedule).
  - **🛑 THE STAKES, and the reason this exists: `scores` upserts on `(ownerSeasonId, week)`, so
    syncing a contest against the wrong week SILENTLY OVERWRITES that week's real scores.** No
    error, HTTP 200, nothing to notice. Recoverable by re-syncing the right contest (and
    `score_import_runs` keeps every raw payload), but only if someone realises.
  - **Both old guesses were broken.** The extension parsed `#N` from the DK contest name — a real
    contest, "DraftKings - Test 2 by Colts0094", has no `#N` — and fell back to the hand-maintained
    `seasons.currentWeek`. **And the preseason toggle was never detected at all**: it just
    remembered its last state, which is how a capture landed in week **102** while that day's scores
    went to **103**.
  - **`nfl_games` already knew both answers** — every kickoff, plus `isExhibition` per row. The
    popup now shows the selected week's range ("Preseason Week 2 · Aug 13 – Aug 16 · 16 games") and
    warns in amber on a mismatch.
  - **Null means unknown, not week 1.** `pickWeek` returns null for a season with no synced
    schedule, and the caller must leave the week alone. Defaulting would reintroduce exactly the
    confident-wrong-week failure.
- **Stale-capture detection + `liveTag` wired** (`4a697ca`). Tests 283 → **291**. New pure module
  `src/lib/live/staleness.ts` (`assessCaptureStaleness`, `countConcealedSlots`, 8 tests).
  - **The problem it solves is the estimate's biggest silent failure.** DK conceals a player until
    their game kicks off, so a 1pm capture legitimately hides the late slate and the UI calls those
    slots "to play" — right at 1pm, **wrong at 5pm**, when those players are scoring points the
    estimate excludes and the only reason they're missing is that nobody re-captured. Measured:
    **14 of 16 games started while 30 roster spots were still concealed.**
  - **The test is precise, not heuristic:** a slot is concealed at capture time `T` exactly when its
    game starts after `T`, so a re-capture helps **iff** some game kicked off after `T` and has since
    started. That means it stays *quiet* in the lookalike case (just after a 1pm capture: early games
    underway, late players concealed, nothing to re-capture yet). `/live` renders
    **"These totals are low — re-sync to fix"**.
  - **`liveTag` is now wired.** `POST /api/ingest/lineups` calls
    `revalidateTag(liveTag(seasonId, week), 'max')` after a successful ingest — the only caller.
    ⚠️ **Next 16 requires that second cache-life argument**; the bundled
    `caching-without-cache-components.md` guide still shows the one-arg form, which does not
    typecheck. Recorded in
    [`NEXTJS16_NOTES.md` §5](NEXTJS16_NOTES.md#5-data-fetching--caching-cachecomponents-off).
- **Exhibition tooling removed; `/live` on the home page** (`ed6ef78`). The league decided it does
  not want exhibitions, so the **creation** path is gone entirely — Admin → Preseason (page/actions/
  forms), its nav entry, `src/lib/preseason/query.ts` and `syncPreseasonWeek`. This **reverses
  `d3cc2e9`'s stated decision** to keep the admin tool. `SEASON_TYPE_PRESEASON` now has zero
  consumers. **The `isExhibition` isolation deliberately stays** — see the preseason DONE section for
  why removing it would corrupt history. Also: `/live` links on the dashboard hero + Explore card,
  and `matchup-switcher.tsx` → `matchup-nav.tsx` (prev/next + dropdown in one component, labels now
  naming **both** owners, since one name doesn't identify a pairing).
- **Live in-progress scoring — Phases 4–5: `/live` ships** (`6559f0f` … `d3cc2e9`, ⚠️ **all seven
  commits local**). `src/lib/live/` joins captured rosters to ESPN stats and two routes render it.
  Tests 255 → **282**, verify 9/9, frozen snapshot byte-identical. Written up in
  [`SCORING.md` §15](SCORING.md#rendering-it--live-phases-45). Seven things to carry forward:
  - **The join is `playerStatKey(name, teamKey)`** — `(normalizeName, teamKey)`. No separate
    identity module was needed; the key *is* the index key. The team half is mandatory (Bijan vs
    Brian Robinson, Travis vs Trevor Etienne, Josh vs Jonathan Allen).
  - **Five slot states, and `noStats` is the subtle one.** `scored` · `pending` · `concealed` ·
    `noStats` (game loaded, player has no ESPN row → scores **0**, because ESPN only lists players
    who recorded a stat) · `unresolved` (that game did not load → **never** a zero). Measured, not
    guessed: in the first real capture **13 of 24 revealed players had no ESPN row and every one was
    worth 0.00 per DraftKings**. Collapsing `noStats` into `unresolved` would paint `?` over half of
    every roster; collapsing it into `scored` would hide a real matching failure. A missing
    **defense** stays `unresolved` — points allowed alone guarantees a DST a row in a loaded
    boxscore.
  - **Do NOT add `dynamic = 'force-dynamic'` to either live route.** It implies
    `fetchCache = 'force-no-store'`, which kills the Data Cache for every fetch on the route — one
    warm ESPN fan-out serving all viewers becomes one per viewer. Both routes carry the comment and
    the Next 16.2.9 doc reference. They are already dynamic via `searchParams`/`params`, and both
    set `runtime = 'nodejs'` + `maxDuration = 30`.
  - **The index stores STAT LINES, not points**, behind `unstable_cache` at 30s. Small payload, and
    a scoring-rule fix takes effect without waiting out a TTL. Fan-out is concurrency 6 with
    `Promise.allSettled` semantics, so a failed game degrades to "15 of 16 loaded", never a thrown
    page.
  - **The detail page reuses the list's data path** (`getLiveWeekData` + `getLiveStatsForWeek`), so
    clicking into a matchup costs **no** extra ESPN traffic.
  - **PROVEN END TO END.** Season 1 week 102 (exhibition): 6/6 owners, 54 slots, 24 revealed, all
    enriched to teams, 16/16 games loaded, 0 unresolved, and **max |delta| 0.00** against
    DraftKings' own per-owner numbers.
  - **`/live` cannot leak an information advantage** — a concealed slot has no identity *stored*, so
    the page can only ever show what DK had already unlocked.
- **One Sync button; the public `/preseason` page retired** (`d3cc2e9`, extension **1.3.0**; now **1.5.0**).
  **Sync** now posts scores *and* lineups off a single DraftKings read (`captureRosters` returns
  `entries` alongside `lineups`); scores go first, lineups are best-effort and report in their own
  card, and an outright roster failure falls back to the plain leaderboard read. `onCaptureLineups`
  and its button are gone, replaced by `saveCapturedLineups(cap, season, week, contestId)`.
  `postIngestTo` now **always** produces an error message — an HTML error page makes `res.json()`
  fail and `statusText` is empty over HTTP/2, which used to render "Saving failed —" and nothing
  else. The probe panel is now "Troubleshooting — DraftKings endpoints" and says it is not part of
  normal use; Live Sync is documented as **optional** (it keeps DK's OFFICIAL totals fresh and needs
  the machine awake — `/live` does not).
  > ~~**Admin → Preseason STAYS.**~~ **SUPERSEDED by `ed6ef78`, one commit later.** At the time,
  > only the public page was removed and the admin setup tool was kept deliberately. The league then
  > decided it does not want exhibitions at all, so `ed6ef78` removed the admin page,
  > `src/lib/preseason/query.ts` and `syncPreseasonWeek` too. Kept here because `d3cc2e9`'s commit
  > message still argues for keeping it, and that is the one place in the log where a later commit
  > reverses an earlier stated decision.
- **Live in-progress scoring — Phase 3: one-click roster capture** (committed in `6559f0f`). The DK
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
- **Live in-progress scoring — Phase 2: roster capture + storage** (committed in `6559f0f`, on top of
  the Phase 0–1 tree below). Two new tables (`lineup_capture_runs`, `lineup_snapshots`; migration
  `0010_polite_nicolaos.sql`, **now applied to production**), `src/lib/lineups/`
  (`normalize.ts` → `ingest.ts` → `query.ts`), `POST /api/ingest/lineups`, and **Admin → Lineups**
  (capture status `N/32` owners *and* `R/S` players revealed, a paste fallback, a capture-run audit
  table showing which DK URL worked). Tests 207 → **234**. Three things to carry forward:
  - **`lineup_snapshots` is append-only, versioned by `capturedAt`.** DK Classic sets
    `allowLateSwap: true`, so the roster in effect is the *newest* row per `(ownerSeason, week)`
    (`DISTINCT ON`). Do not "simplify" it to one row per owner-week.
  - **`no-write.test.ts` is the safety invariant made mechanical** — it scans every module under
    `src/lib/dfs`, `src/lib/lineups`, `src/lib/live` **and the `src/app/live` route** (discovered,
    not enumerated, so new files are covered automatically) and fails on any write to
    `scores`/`matchups`/`playoff_matchups`/`season_awards`/`nfl_games` or any call to
    `ingestLeaderboard`/`writeTeamScores`. Reads are fine. If it fires, you want a new table.
  - **Three modules were extracted, behaviour unchanged:** `src/lib/ingest/auth.ts` and
    `src/lib/ingest/week-schema.ts` out of the DK route, and `src/lib/scores/owner-match.ts` out of
    `scores/ingest.ts` (both ingests MUST match entry names identically).
- **Live in-progress scoring — Phases 0 and 1 only** (committed in `6559f0f`; described here as the
  working tree it was at the time of writing: `src/lib/dfs/`, `src/lib/nfl/`, `scripts/dfs-selftest.ts`, two ESPN fixtures, and the
  extension at v1.1.0). A pure DraftKings Classic scoring engine fed by ESPN's public boxscore API,
  so in-progress points can be computed **server-side** without a DK session or a machine left on.
  **It is an ESTIMATE and must never enter the scoring chain** — nothing in `src/lib/dfs/` imports
  the DB or `src/lib/standings/`, and nothing there writes a row. (Phase 2, above, added the
  capture path, which does use the DB — hence the no-write guard. Phases 4–5 — DK→ESPN player
  matching and the `/live` page — landed later in this same run; see the top entry.) Also extracted
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
  `src/lib/schedule/preseason.ts`; `syncPreseasonWeek`; `/preseason` (since retired — see the DONE
  section) + Admin → Preseason): tracked
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

- **`pointsAllowedMode` is still unsettled.** It ships `'raw'`; DK has historically excluded points
  its DST was not on the field for. The 0.00 reconciliation was on a **preseason** contest with 6
  owners, which barely exercises the DST tiers. `dkStats` is the instrument — and **Admin → Scoring
  is now the tool that reads it**: a wrong mode lands a DST exactly one tier off, which surfaces as
  a **rule bug** on that DST row with the points-allowed component named. Settle it on a
  regular-season week with a defensive or return TD.
- **⚠️ No capture has ever carried `dkProjection`, so projections and win probability have never
  run on real data.** All 216 stored slots across the four week-102 captures have it `null`.
  **Diagnosed 2026-08-25 — the parser is NOT at fault, and this is now well understood:**
  - Runs **1 and 2** (mid-game) *do* contain `"pregameProjection": 14.666…` in their stored
    `raw_payload`. They simply predate `readProjection`, which landed in `52c7d2b` at 23:35 UTC —
    about 90 minutes after the last of them.
  - Runs **3 and 4** (post-game) have the parser but no data: **DraftKings strips the numbers once
    a game ends**, leaving `"projection": { "valueIcon": "" | "ice" | "fire" }`.
  - **The current parser was replayed over run 1's stored payload and extracted 24 of 24 revealed
    slots.** The capture path works; only the timing was ever wrong.

  It closes itself: Live Sync's conditional refresh fires at kickoff waves, which is mid-game,
  which is exactly when DK publishes the number. And the overwrite you would expect — the 4:25
  capture replacing the 1pm players' now-stripped projections — is harmless, because
  `projectSlot` multiplies by `minutesLeft / 60` and a finished player has none. Every capture
  carries projections for precisely the players whose projections still count.

  > **TODO (deliberately deferred, 2026-08-25): pin the extraction with a regression test.**
  > Nothing currently proves the capture path reads this field — `projection.test.ts` covers the
  > arithmetic on synthetic fixtures only. If DraftKings renames `pregameProjection`, or someone
  > refactors `readProjection`, projections silently return to `null` and the page keeps looking
  > healthy. **Run 1's `raw_payload` is the fixture** (`select raw_payload from
  > lineup_capture_runs where id = 1`) and it yields 24/24 — extract it to
  > `src/lib/lineups/fixtures/` and assert against `normalizeRosterPayload`. This is the same
  > silent-failure class the settled-week gate and `no-write.test.ts` exist to prevent.

  ✅ **The misleading UI is FIXED (2026-08-25).** With every projection `null`, `projectLineup`
  returned `projected === current` and `/live` printed "proj 62.66" under a score of 62.66 —
  claiming we expected them to finish exactly where they stood. `LineupProjection` now carries
  `projectedSlots`; the detail page renders nothing when it is `0`, and marks a partial
  projection as a floor (`proj 141.20+`) rather than passing it off as complete.
- **The capture that proved the path was preseason, on one season.** Season 1 / week 102, 6 owners,
  54 slots. A full 32-owner regular-season Sunday has not been exercised end to end, and **a ~16-game
  cold render has never been tested against `maxDuration = 30`** (the fan-out runs at concurrency 6;
  the proving capture needed a fraction of that). If a cold Sunday render times out, start here.
  ✅ **Append-only versioning is no longer on this list** — week 102 now holds three capture
  versions per owner, newest winning, nothing overwritten.
- **The drift audit's coverage grows with the seasons, and two of its limits are worth knowing.**
  `DK_TO_OUR_KEY` in `src/lib/live/reconcile.ts` was built from **observed** payloads, so a stat
  DraftKings has never paid for in a captured week reads as `unmapped` the first time it appears —
  by design, but it means "0 unmapped" is not a completeness proof. And
  `ASSUMED_GAME_LENGTH_MS = 4h` in `reconcile-query.ts` can only make the sample **smaller**, never
  wrong; read the "N of M compared" line, not just the verdict counts.
- ✅ **Two live-scoring surfaces outside `no-write.test.ts`'s scan — FIXED before the push.**
  `src/app/api/live-status/route.ts` and `src/app/admin/(panel)/scoring/page.tsx` are now scanned
  alongside `src/lib/{dfs,lineups,live}` and `src/app/live`, and **each route dir is asserted
  individually** — a guard that silently scans nothing passes, so a typo'd path had to be made
  impossible to miss. 24 → 30 assertions.
- **A pasted capture is never enriched.** Admin → Lineups sends no `draftGroupId`, so
  `ingestLineups` skips `enrichLineups` and the snapshot keeps only whatever names/teams DK's payload
  carried — which for a real DK roster payload is *none*. That makes a pasted capture unscorable by
  design. Either thread a draft-group id through the form or accept the paste box as a
  store-the-evidence fallback only.
- ✅ **`dkProjection` NaN on legacy snapshots — FIXED in `0b2f686`.** `slots` is jsonb, so the
  field needed no migration and older rows simply lack the key; `undefined` slipped past an
  `=== null` guard and turned the projection arithmetic into `NaN`. Now hydrated on read via
  `hydrateStoredSlot` / `hydrateStoredSlots` (`src/lib/lineups/normalize.ts`), with `== null`
  guards in `projection.ts` as belt and braces, and three regression tests. **Generalise it: any
  field added to that jsonb later is `undefined` on older rows — hydrate, never cast.**
- **Win probability is calibrated by assumption.** `LINEUP_SD_FULL_SLATE = 40` in
  `src/lib/live/projection.ts` is a rough industry figure for a Classic lineup's spread, never
  fitted to this league. The *projection* it feeds is DraftKings' own formula and is exact; the
  *probability* on top is a model. It is isolated as one constant so fitting it — after a season of
  real weekly results — is a one-line change. Until then, keep it labelled an estimate in the UI.
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
3. **Check the repo state:** `git status` and `git log origin/main..main`. **As of 2026-08-23 the
   working tree is dirty on purpose** — the mobile `/live` rebuild, the Live Sync roster refresh
   (extension **1.5.0**) and the scoring-drift audit are written and verified but **not committed**
   (see the push check in Snapshot). `git diff HEAD` is the whole of it.

The rebuild is **feature-complete** vs the old Google-Sheets workflow. Importers are idempotent;
2023–2025 (regular season + playoffs) are in, validated, and gated against moving.

**Live in-progress scoring is DONE (Phases 0–5)** — the pure engine + ESPN adapter, roster
capture/storage (`src/lib/lineups/`, `POST /api/ingest/lineups`, Admin → Lineups), the join and read
model (`src/lib/live/`), and the **`/live`** + **`/live/[matchupId]`** pages. Migration `0010` is
applied. The extension is at **v1.5.0**, where one **Sync** button posts scores and rosters from a
single DraftKings read, and **Live Sync additionally re-reads rosters when `GET /api/live-status`
says a kickoff has revealed something** — plus always on the final poll. A real capture reconciled
against DraftKings' own numbers at **max |delta| 0.00** across 6 owners with zero unresolved slots;
that check is now a page (**Admin → Scoring**) rather than a one-off.

Before touching any of it, read
[`SCORING.md` §15](SCORING.md#15-live-in-progress-scoring-an-estimate-never-a-score). Three things
there are not optional:

- **The estimate must never be written to `scores`.** `src/lib/lineups/no-write.test.ts` fails the
  build if you cross it — and it now scans the `src/app/live` route too, not just the libraries.
- **A slot we could not score is never `0.00`.** The five states (`scored` · `pending` ·
  `concealed` · `noStats` · `unresolved`) exist because a fabricated zero is indistinguishable from
  a real one, and a page full of zeroes reads as a league of forfeits.
- **Do not add `dynamic = 'force-dynamic'` to `/live`.** Every other data page sets it; here it
  would disable the Data Cache for every fetch on the route and turn one shared ESPN fan-out into
  one per viewer. Both live routes carry a comment saying so.

Other likely asks: **2026 in-season operations** (the season is `upcoming` and fully
assigned — [`docs/RUNBOOK.md`](RUNBOOK.md) is the weekly loop, plus the scheduled `keylehr-verify`
routine); the bracket-rendering gap for the 3rd-place game (first item under "Known open items");
training the lineup models into ML `v1.0` once 2026 produces graded weeks; or the My Team
"team-builder wizard Phase B+" follow-ups noted above.

Conventions that will bite you if you skip them: run `verify` **before** pushing (the production
build catches `'use server'` export errors nothing else does); `src/lib/standings/` stays pure (no
DB imports); every `scores`/`matchups` query needs the `isExhibition` filter; and the Neon HTTP
driver means one query = one round-trip, so batch writes.

## ▶ Next session: start here

Live scoring is **built and deployed**; the 2026-08-23 work on top of it (mobile `/live`, the
conditional roster refresh, the drift audit) is **written, verified and uncommitted**. The
remaining work is confirmation, not construction.

**0. Commit and push the working tree.** `git status` lists nine modified files and four new ones.
`npm run verify` is 9/9 and 349 tests pass as it stands. **No migration is involved** — the audit
adds no table and `/api/live-status` adds no column. Read
[Recent work](#recent-work-newest-first) for what each piece decided and what was rejected; that is
the design record until these land as commits.

**1. ✅ CLOSED — the second week-102 capture has landed.** Older notes here asked for it. The
database now holds **four** captures for season 1 / week 102: two mid-slate on 2026-08-15
(24 of 54 slots revealed) and two after the games finished on 2026-08-16, both **54/54 revealed**.
So two things previously listed as untested are now exercised on real data:

  - **Append-only versioning works in production** — three `capturedAt` versions per owner-week,
    newest winning, nothing overwritten.
  - **The reconciliation is automatic now.** Admin → Scoring on that week reports **54 slots, 54
    agree, 0 rule drift, 0 unmapped, 0 unmatched, 0 skipped, max |delta| 0.00 across 6 owners** —
    the same answer the hand-done check gave, without the hand.

**2. ⚠️ NOT closed, and the old note predicted the opposite: no capture has ever carried
`dkProjection`.** All **216** stored slots across all four week-102 captures have it `null`. The
mid-slate captures predate the field; the post-game ones cannot carry it, because **DraftKings
strips its projection once the game is over** — in run 4's raw payload the object reads
`"projection": { "valueIcon": "" }` against a competition of `CompetitionOver`.
**The consequence is structural, and worth understanding before chasing it as a bug:** the capture
that is best for the [drift audit](SCORING.md#does-the-estimate-agree-with-draftkings--the-drift-audit)
(post-game, everything revealed and final) is exactly the capture that carries **no** projection,
and vice versa. `/live`'s projected finals and win probability have therefore **never run on real
captured data** — only on unit-test fixtures. **A mid-game capture during a real regular-season
Sunday is what closes this**, and Live Sync's conditional refresh now produces those as a
side effect.

**3. Do NOT re-fix these.** They read like open bugs in older notes and are closed:
the `dkProjection` `NaN` (fixed in `0b2f686`, hydrated on read — that is the *NaN*, distinct from
item 2 above, which is about the value never being *present*), the paste path not enriching
(fixed — the form takes a draft group id), and DraftKings' PMR "different rule" (it was a stale
`eTag` row, not a rule).

**What is genuinely still open** is the risks in *Open items* below: `pointsAllowedMode`
unconfirmed (**Admin → Scoring is now the instrument for settling it** — a wrong mode lands a DST
one tier off and surfaces as a rule bug on that row), `dkProjection` never captured, a 16-game cold
render untested against `maxDuration = 30`, and the win-probability standard deviation being an
assumed constant. None blocks use; all of them want a real regular-season week.

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
  `preseason.test.ts`) — **that is all that's left.** `syncPreseasonWeek`,
  `src/lib/preseason/query.ts` and both preseason routes were removed in `ed6ef78`; no new
  exhibition week can be created. The view for existing ones is `/live`, which renders them like any
  other week. Rows carry `isExhibition` (migration 0008) and are excluded
  from every stats query. Scores arrive through the normal ingest endpoint at the offset week —
  `POST /api/ingest/draftkings` accepts `1–25` **or** `101–103` — driven by the extension's
  **Preseason** toggle (`extension/popup.js`, which mirrors the constants) and now **auto-set** from
  the schedule, see below.
- Which week is it: `src/lib/schedule/current-week.ts` (**pure**, `pickWeek` / `rangeForWeek`, 11
  tests) + `current-week-query.ts` (reads `nfl_games`), exposed as `GET /api/current-week` for the
  extension. It answers **both** the week number and whether that week is exhibition, so neither is
  guessed. Guarding against the silent wrong-week overwrite of `scores` is the whole point —
  [`SCORING.md` §4](SCORING.md#-the-wrong-week-silently-overwrites-a-real-one).
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
  extension is `page-hook.js` `captureRosters()` (which since v1.3.0 also returns the leaderboard
  `entries`, so one read serves both halves of **Sync**).
- **Joining the two halves and rendering them:** `src/lib/live/` — `stats.ts` (the cached ESPN stat
  index; `buildLiveStatIndex`, `getLiveStatsForWeek`, `playerStatKey`, `liveTag`,
  `LIVE_INDEX_REVALIDATE_SECONDS = 30`) · `assemble.ts` (**pure**, `assembleLive`, 17 tests, and the
  home of the five slot states) · `staleness.ts` (**pure**, `assessCaptureStaleness` /
  `countConcealedSlots`, 8 tests — the "re-sync, your totals are low" detector) · `minutes.ts`
  (**pure**, `minutesLeftInGame` / `lineupMinutes`, 12 tests — how much football is left) ·
  `projection.ts` (**pure**, `projectSlot` / `projectLineup` / `winProbability`, 14 tests —
  DraftKings' own projection formula plus a labelled win-probability **model**) ·
  `reconcile.ts` (**pure**, `reconcileSlot` / `reconcileWeek`, 14 tests — do we agree with
  DraftKings, player by player) · `reconcile-query.ts` (**reads only**: `reconcileWeekFromDb`,
  `buildReconciliation`, `getReconcilableSeasons`, `getCapturedWeeks`; holds
  `ASSUMED_GAME_LENGTH_MS`, the feature's one approximation) · `query.ts`
  (**reads only**: `getLiveWeekData`, `getDefaultLiveWeek`, `getMatchupLocation`). Routes:
  `src/app/live/` (list, ordered by **closeness**) and `src/app/live/[matchupId]/` (head-to-head
  detail, no `PageHeader`; `matchup-nav.tsx` = prev/next + dropdown, carrying both owners, logos,
  scores and minutes). **Both pages have two layouts below/above `sm` sharing ONE data source** —
  the mirrored roster rail and the rich prev/next cards do not fit a 390px screen; see
  [`SCORING.md` §15](SCORING.md#the-routes). **Neither route may set `dynamic = 'force-dynamic'`**
  — see [`SCORING.md` §15](SCORING.md#rendering-it--live-phases-45). `liveTag` is invalidated by
  `POST /api/ingest/lineups`.
- **Is the estimate right?** `GET /api/live-status` (`src/app/api/live-status/route.ts`,
  **read-only**) tells the extension whether re-reading all 32 rosters would reveal anything —
  [`DRAFTKINGS.md` §14](DRAFTKINGS.md#14-the-capture-staleness-endpoint-implemented). **Admin →
  Scoring** (`src/app/admin/(panel)/scoring/page.tsx`, **read-only**) reconciles our per-player
  points against DraftKings' own `dkScore`/`dkStats` —
  [`SCORING.md` §15](SCORING.md#does-the-estimate-agree-with-draftkings--the-drift-audit). Neither
  is covered by `no-write.test.ts`, whose scan stops at `src/lib/{dfs,lineups,live}` +
  `src/app/live`; both carry an explicit read-only header instead.
- Admin (commissioner): `src/app/admin/(panel)/` — Owners · Assignments · Schedule · **Preseason** ·
  Sync · **Lineups** · **Scoring** · Playoffs · **Slates** · **Models** · Settings · Users (all
  auth-gated). **Scoring** is the odd one out: no server action, no writes — it is a read-only
  audit of whether `/live` agrees with DraftKings.
- Season importers (idempotent): `scripts/import-season{,3}.ts` (regular season; `import-season3.ts` is
  the 2025 verify anchor — do NOT modify), `scripts/import-playoffs{,-2025}.ts` (brackets)
