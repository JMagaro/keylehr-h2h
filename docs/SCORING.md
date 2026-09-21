# Scoring

How a DraftKings leaderboard becomes a win, a Points-Against total, and ultimately a playoff
seed. This is the load-bearing path of the whole app: every public page, every payout, and the
frozen historical seasons all come out the far end of it.

It is documented here because it was **not** documented anywhere before, and that gap is the
direct reason a set of live-season scoring bugs shipped unnoticed. If you are about to touch
`src/lib/scores/`, `src/lib/standings/`, or anything that reads `scores` / `matchups`, read
[§3 the derivation principle](#3-the-derivation-principle) and [§6 settled weeks](#6-settled-weeks-the-safety-property)
first.

## 1. The chain, end to end

```text
DraftKings leaderboard (Chrome extension, or a backfill sheet)
      │  src/lib/scores/ingest.ts        ingestLeaderboard / writeTeamScores
      │    match entry name → owner_seasons
      │    derive isBye from nfl_games          ← §5
      │    derive isExhibition from the week    ← §2
      │    chunked upsert on (ownerSeasonId, week) + a score_import_runs audit row
      ▼
scores            (one row per owner-season + week)
      │
      │  src/lib/standings/query.ts       getSeasonStandingsData  ← the hub
      │    load scores + matchups + nfl_games + the season's rules
      │    weekIsFinal per week  → settledWeeks                   ← §6
      │    deriveForfeits(derived ∪ stored)                       ← §7
      │    assembleMatchupResults(...)                            ← §8
      ▼
MatchupResult[]   (the pure engine's input: isFinal, points, forfeitBy, opponentFacesPoints)
      │  src/lib/standings/standings.ts   computeStandings        ← §9
      ▼
StandingRow[]     (W-L-T, PF, PA, win%, streak)
      │  src/lib/standings/tiebreakers.ts rankStandings           ← §10
      ▼
ranked order
      │  src/lib/standings/seeding.ts     computeConferenceSeeds  ← §11
      ▼
playoff seeds → src/lib/playoffs/service.ts (bracket) → src/lib/awards/ (payouts)  ← §12
```

Everything from `getSeasonStandingsData` onward is **pure** — no DB imports — which is why it is
unit-tested. `query.ts` is the only module that loads the rows.

> A **second, parallel** path is being built to show in-progress points during the games, computed
> from a public NFL stat feed rather than from DraftKings. It deliberately does **not** join this
> chain at any point — see [§15](#15-live-in-progress-scoring-an-estimate-never-a-score).

## 2. The three week namespaces

`week` is a plain integer on `nfl_games`, `matchups`, and `scores`, and it carries three
disjoint meanings. Getting this wrong is how playoff scores leak into regular-season records.

| Namespace | Weeks | Where the schedule lives | Flags |
| --------- | ----- | ------------------------ | ----- |
| **Regular season** | `1 .. seasons.regularSeasonWeeks` (18 today) | `matchups` | `isPlayoff = false`, `isExhibition = false` |
| **Playoffs** | `19`–`22` (`PLAYOFF_ROUND_WEEKS` in `src/lib/playoffs/service.ts`); week 22 carries **two** games — see [§12](#12-the-bracket-and-the-game-that-decides-3rd) | `playoff_matchups` — **not** `matchups` | scores written with `isBye = false` |
| **Preseason exhibition** | `101`–`103` = `PRESEASON_WEEK_BASE (100) + preseasonWeek` | `matchups` with `isExhibition = true` | `isExhibition = true` everywhere |

Consequences that trip people up:

- **`matchups` holds regular-season rows only.** "This owner has no `matchups` row" is therefore
  meaningless in weeks 19–22 and 101–103 — it does not mean a bye, it means the schedule for
  that week lives elsewhere. See [§5](#5-byes).
- **`POST /api/ingest/draftkings` accepts two disjoint ranges**, `1–25` and `101–103`, and
  rejects everything in between, so a typo can never land a preseason score in a real week.
- The week namespace is the **only** signal needed to flag an exhibition sync;
  `ingestLeaderboard` derives `isExhibition` from it.

Helpers: `src/lib/schedule/preseason.ts` (`toExhibitionWeek` / `fromExhibitionWeek` /
`isExhibitionWeek` / `exhibitionWeekLabel`).

> **Exhibition: creation removed, isolation permanent.** As of `ed6ef78` the league can no longer
> *create* an exhibition week — Admin → Preseason, `src/lib/preseason/query.ts` and
> `syncPreseasonWeek` are gone, and `SEASON_TYPE_PRESEASON` has **zero consumers**. That is
> deliberate: the league does not want exhibitions.
>
> **The isolation stays, and must.** The `isExhibition` columns, every query filter, the `101`–`103`
> range on the ingest endpoint, and `src/lib/schedule/preseason.ts` are all untouched — because
> **exhibition rows exist in the database** (week 102 carries 16 matchups, 12 scores and 6 lineup
> snapshots as of 2026-08-15). The namespace is what keeps that data out of standings, seeding,
> playoffs, payouts and all-time records. Deleting the isolation because "we don't do preseason any
> more" would let that test data silently pollute every historical number. Leave it in place.
>
> `/live` still renders those weeks like any other, and the extension's **Preseason** toggle still
> posts a `101`–`103` week, so the existing rows remain viewable and re-scorable.

## 3. The derivation principle

> **`scores.isBye` and `scores.isForfeit` are persisted hints, not the source of truth.**

Both columns are *derivations* of facts that live in other tables (`nfl_games`, `matchups`),
written once at ingest with no recompute trigger. A persisted derivation that never re-derives
drifts, and both of these did:

- `isForfeit` was written by the two historical backfill scripts and by **nothing else**. The
  live DraftKings ingest never sets it, so on a live season the league's entire missed-lineup
  rule silently did not apply.
- `isBye` was computed from whether a `matchups` row existed **at ingest time**. Sync a week's
  scores before generating its matchups and all 32 owners were written `isBye = true`, erasing
  that week's Points For and its weekly-high prize.

The fix is not "also write the column at ingest" — that cannot reach the worst case, an owner
with **no `scores` row at all**. Instead:

| Fact | Written at ingest | Recomputed at read time | Composition |
| ---- | ----------------- | ----------------------- | ----------- |
| `isBye` | Yes — from `nfl_games` ([§5](#5-byes)) | Yes — reconciled against `matchups` | stored flag honored **only if** it does not contradict the schedule |
| `isForfeit` | **Never** by any ingest path | Yes — from the schedule, gated on a settled week ([§7](#7-forfeits-missed-lineups)) | **derived ∪ stored** |
| `isExhibition` | Yes — from the week | No | authoritative; the week is the source |

`derived ∪ stored` for forfeits is deliberate: a manually set `scores.isForfeit = true` is the
**commissioner's override** and is always honored, whatever the points say. Nothing in the read
path ever drops one.

This also makes the read path self-healing. A late score, a re-sync, matchups generated after
ingest — all of them just change what the next render computes. And it is what makes the
change provably a no-op on the frozen seasons: `npm run verify` asserts that the derived
forfeit set equals the stored `isForfeit` set for 2023–2025 (see [§13](#13-what-verify-proves)).

## 4. Ingest (write time)

`src/lib/scores/ingest.ts` has two entry points that converge on the same upsert:

- **`ingestLeaderboard`** — the live path. The DK Sync Chrome extension scrapes the shared
  private contest leaderboard and POSTs it to `POST /api/ingest/draftkings`; the route calls
  this. See [`DRAFTKINGS.md`](DRAFTKINGS.md) and [`../extension/README.md`](../extension/README.md).
- **`writeTeamScores`** — keyed by NFL team name instead of DK entry name. Used by the historical
  season importers. (It also backed the old Admin → Preseason paste form, which no longer exists —
  see [§2](#2-the-three-week-namespaces).)

Both:

1. Resolve each entry to an `owner_seasons` row. `ingestLeaderboard` matches
   case-insensitively and trimmed against `owner_seasons.dkEntryName`, falling back to
   `owners.dkUsername` when that key does not collide. Unmatched entries are **reported, not
   persisted**.
2. Write a `score_import_runs` audit row **first**, so the scores can reference its id.
3. Resolve the week's byes ([§5](#5-byes)).
4. Upsert `scores` on the `(ownerSeasonId, week)` unique index in **chunked multi-row
   statements** (batches of 100). Every Neon HTTP query is a network round-trip; 32 sequential
   inserts eat a serverless function's time budget — the failure mode that once broke the
   schedule pull.
5. **Never write `isForfeit`.**

Re-running converges: the upsert is idempotent on `(ownerSeasonId, week)`.

### ⚠️ The wrong week silently overwrites a real one

That same idempotence is the hazard. The upsert key is `(ownerSeasonId, week)` and nothing else —
not the contest id, not the capture time — so **syncing a contest against the wrong week replaces
that week's real scores with this contest's numbers, with no error and nothing to notice.** The
week is just a number in a text box; a typo, or a stale toggle, is all it takes.

It is recoverable — re-sync the correct contest against that week, and `score_import_runs` keeps
the raw payload of every run ([`DRAFTKINGS.md` §6](DRAFTKINGS.md#6-audit-log-score_import_runs)) —
but nothing tells you it happened, so the defence has to be *before* the sync. That is what
`GET /api/current-week` is for: the app derives the week from the synced NFL schedule, and the
extension shows the dates it covers ("Preseason Week 2 · Aug 13 – Aug 16 · 16 games") next to the
week you picked, warning when the two disagree. See
[Which week is it?](#which-week-is-it--detecting-it-from-the-schedule) below and
[`RUNBOOK.md`](RUNBOOK.md#-the-wrong-week-overwrites-a-real-one).

### Which week is it — detecting it from the schedule

The extension used to **guess** the week two ways, and both failed in practice:

- parse a trailing `#N` out of the DraftKings contest name — but a contest name need not contain
  one. A real one, "DraftKings - Test 2 by Colts0094", did not, so the parse silently found
  nothing;
- fall back to `seasons.currentWeek` — a hand-maintained column nobody remembers to advance.

**And the preseason toggle was never detected at all.** It simply remembered whatever it was last
left on, which is how a capture landed in week 102 while that day's scores went to 103.

`nfl_games` already holds every kickoff *and* an `isExhibition` flag per row, so the schedule can
answer both questions without guessing:

| Module | Role |
| ------ | ---- |
| `src/lib/schedule/current-week.ts` | **Pure**, no DB and no clock of its own: `pickWeek(games, now)` and `rangeForWeek(games, week)`. Types `ScheduleGame`, `WeekRange`, `DetectedWeek`. 11 unit tests. |
| `src/lib/schedule/current-week-query.ts` | The DB half, **read-only**: `detectCurrentWeek(seasonId, now?)` and `getWeekRange(seasonId, week)`. |
| `src/app/api/current-week/route.ts` | `GET /api/current-week` — what the extension calls. Bearer `INGEST_TOKEN`, CORS as `/api/seasons`. Contract in [`DRAFTKINGS.md` §13](DRAFTKINGS.md#13-the-week-detection-endpoint-implemented). |

`pickWeek` tries three rules in order, and reports which one it used as `basis`:

| `basis` | Rule |
| ------- | ---- |
| `in-progress` | A week already under way — its first kickoff is in the past and within the week's span. The **latest** such week wins, so a Thursday opener doesn't hand the answer back to the week just gone. |
| `upcoming` | Otherwise, the next week to start. |
| `last` | Otherwise, the last week of the season — everything has finished. |

A week counts as "under way" for **5.5 days** after its first kickoff (`WEEK_SPAN_MS`), sized to
cover Thursday night through the following Monday night so the answer doesn't flip the moment
Sunday's games end.

> **No games, no answer.** `pickWeek` returns `null` for a season with no synced schedule, and the
> caller must treat that as *unknown* and leave the week alone. Defaulting to 1 would reintroduce
> exactly the confident-wrong-week failure above.

## 5. Byes

A bye is a property of **the NFL schedule**, so it is derived from `nfl_games` — never from
`matchups`, which is itself derived and is the wrong authority in three situations that all
really happen (matchups not generated yet; a game skipped because one team is unassigned;
playoff weeks whose games are not in `matchups` at all).

**Write time** — `resolveByes` in `src/lib/scores/ingest.ts`:

1. Exhibition week (`isExhibitionWeek`) → nobody is a bye.
2. `week > seasons.regularSeasonWeeks` (a playoff week) → nobody is a bye. This matches what
   the playoff importers write.
3. Otherwise: an owner is on a bye when their `owner_seasons.nflTeamId` appears in **no**
   `nfl_games` row for that `(seasonId, week)`.
4. **Safety valve** — if the week has **zero** `nfl_games` rows, write nobody as a bye. We
   simply do not know yet (most likely the schedule has not been pulled). Marking all 32 owners
   as byes is the direction that destroys a week of data; marking none is benign and
   self-corrects on the next sync.

**Read time** — `isEffectiveBye` in `src/lib/standings/forfeit-derive.ts`:

> A stored `isBye = true` is honored **only** when the owner has no regular-season `matchups`
> row that week, and never past `regularSeasonWeeks`.

An owner who has a matchup that week was, by definition, not idle, so a row flagged bye for
them is self-contradictory and the flag is ignored. This is what protects a week whose scores
were ingested before its matchups existed: the score counts toward Points For anyway, and the
bad rows repair themselves on the next sync.

A bye score never counts toward W-L-T or Points Against. It reaches Points For **only** when the
season's `byeWeek.countsTowardPointsFor` rule is on (it is off for the league) — see
[`RULES.md`](RULES.md).

## 6. Settled weeks (the safety property)

This is the single most important safety property in the scoring path.

> A week is **settled** when it has at least one `nfl_games` row and **every one of them is
> final**, **and** at least one owner has posted a real (non-bye) score for it. Forfeit
> derivation runs for settled weeks only — **and so does counting the week's games toward
> W/L at all** ([§8](#8-matchup-assembly)).

`computeSettledWeeks` (`src/lib/standings/forfeit-derive.ts`) applies **both** halves, and each
one guards a different window in which every owner is legitimately on zero:

1. **Every game final.** If the extension syncs at 11am on Sunday, all 32 owners sit on 0.00 —
   and the week would resolve as 32 forfeits, each triggering an auto-loss and charging its
   opponent the league benchmark, with the double-loss rule cascading through the standings.
2. **At least one real score on record**, i.e. the DraftKings sync for that week has landed.
   Otherwise there is a window *every single week*, from the last game going final until the
   commissioner syncs, where the games are over and `scores` is still empty — so all 32 owners
   look like they failed to submit, which is a double loss in all 16 games.

Drop either half and the result is a league-wide false forfeit. With both, a week that is
in progress or finished-but-unsynced simply resolves as unplayed, which is the truth.

`src/lib/schedule/final.ts` gives "is it over?" **one** definition, shared by the scoring engine
and the admin sync dashboard so they cannot drift apart:

- `statusIsFinal(status)` — an explicit ESPN status always wins
  (`final` / `complete` / `full-time` / `postgame`, case-insensitive). Returns `null` for a
  missing, unrecognized, **or merely pre-game** status — see the trap below.
- `gameIsFinal(game, now)` — falls back to "kicked off at least `FINAL_FALLBACK_MS` (6 hours)
  ago" whenever the status is unknown or stale.
- `weekIsFinal(games, now)` — at least one game, and all of them final. **A week with no games
  is NOT final**, or a week whose NFL schedule has not been pulled yet would read as final and
  start deriving forfeits for owners who never had a game to miss.

`now` is always passed in — the module keeps no clock of its own, so tests are deterministic.

### ⚠️ `STATUS_SCHEDULED` is the default, not a claim — and it froze this gate shut

**The gate silently failed to open for the entire first half of the 2026 season**, which is
worth understanding before you touch `final.ts`, because the failure was invisible.

`nfl_games.status` has exactly **one** writer, `syncSeasonSchedule`, and it is only reachable
by hand — Admin → Schedule, or `npm run schedule:pull` — which [`RUNBOOK.md`](RUNBOOK.md) lists
as **pre-season** setup, not part of the weekly loop. So the 2026 rows froze at
`STATUS_SCHEDULED` in August and stayed there: all 288 of them, including played-and-scored
weeks. `statusIsFinal` read that as an explicit "not finished", which **outranks** the kickoff
fallback, so `weekIsFinal` was permanently `false`, so nothing ever settled, so missed-lineup
derivation — the feature this whole section exists for — never ran once.

The fix (`4a5f73e`) classifies a status by whether it is **evidence**:

| Status | Written by | Verdict |
| ------ | ---------- | ------- |
| `STATUS_SCHEDULED`, pre-game | Nothing — it is the **default** every row carries | `null`, defer to kickoff age |
| `STATUS_IN_PROGRESS`, `halftime`, `STATUS_POSTPONED` | Only a **refresh** — so it is fresh | `false`, still wins outright |
| `STATUS_FINAL`, `postgame` | A refresh | `true` |

A game stuck in-progress therefore still cannot be aged into "final" by the fallback; only the
status meaning "nothing has been written here yet" defers to the clock.

> **The hole this leaves.** A game **postponed and never refreshed** reads final 6 hours after
> its *original* kickoff. Closing it properly means refreshing `status` as part of the weekly
> sync rather than trusting a column that nothing writes during a season.

> **Why 2023–2025 never caught it:** their importers run `syncSeasonSchedule` *after* the season
> is over, so every historical row carries `STATUS_FINAL` and settles exactly as it always did.
> The frozen snapshot stayed byte-identical through both fixes — which is precisely why a green
> `verify` could not have told you the live season was broken.

> **Operational note.** The second half of the gate needs only **one** score, so a *partially*
> synced week is settled. Every owner who is missing a row at that point derives as a missed
> lineup until the rest of the week lands. That is the correct reading — the alternative is
> letting a genuinely absent owner escape — but it means a half-finished sync makes
> `/standings` temporarily wrong. Finish the week's sync in one go and confirm `/admin/sync`
> reads `32/32`. See [`RUNBOOK.md`](RUNBOOK.md).

## 7. Forfeits (missed lineups)

`deriveForfeits` in `src/lib/standings/forfeit-derive.ts` returns the set of
`${ownerSeasonId}:${week}` keys to treat as missed lineups:

**Derived** — for a *settled* regular-season week only, an owner who holds a regular-season
`matchups` row that week **and**:

- has **no `scores` row at all**, or
- has a non-bye row worth exactly `0`.

**Union stored** — every row with `scores.isForfeit = true`, regardless of week or points. This
is the commissioner's manual override, and it is also what makes the derivation provably
equal to the stored set on the frozen seasons (their importers set the flag using exactly this
rule).

Never derived: bye weeks, owners with no matchup that week, playoff weeks, exhibition weeks,
unsettled weeks.

### Why a forfeit with no `scores` row is scored 0, not left unscored

`assembleMatchupResults` backfills `0` for any derived forfeit that has no row
(`assemble.ts`, step 2). This matters more than it looks.

A matchup is `isFinal` only when **both** sides have points. Previously an owner who never
entered the contest left no row, so the matchup was not final and was **dropped entirely** —
which:

1. denied the opponent the win the league rule owes them, and
2. shrank the opponent's `gamesPlayed`, which feeds `winPct`, which is the tiebreaker cohort key
   ([§10](#10-tiebreakers)).

So the person who ghosted the season silently improved everyone else's tiebreaker position. An
owner who never submits a lineup must **lose**, not erase the game.

## 8. Matchup assembly

`assembleMatchupResults` (`src/lib/standings/assemble.ts`, pure) turns raw `scores` + `matchups`
rows into the engine's `MatchupResult[]`. It is the step that decides what a forfeit's opponent
plays against, and therefore decides wins, Points Against and ultimately playoff seeds. In
order:

1. **Points per owner-week**, with byes reconciled against the schedule ([§5](#5-byes)). A bye
   or a null score becomes `null` ("no score"). Bye points are accumulated separately into
   `byePointsForByOwner` for the `byeWeek.countsTowardPointsFor` rule.
2. **Backfill derived forfeits with `0`** ([§7](#7-forfeits-missed-lineups)).
3. **Per-week league average and median** of the counted scores. **Forfeits and byes are
   excluded** from both, so a 0 cannot drag the benchmark the forfeiter's opponent has to beat.
4. **Apply the season's `missedLineup` rule**, translating it into the engine's generic fields:
   - `missedLineup.result === 'auto_loss'` → set `forfeitBy` (`'home'` / `'away'` / `'both'`).
     `'none'` leaves the matchup alone.
   - `missedLineup.opponentScores` → `opponentFacesPoints`: `league_average` → that week's mean,
     `league_median` → that week's median, `zero` → `0`, `actual` → the forfeiter's own points
     (which is the "no special handling" case and short-circuits before `forfeitBy` is set).

Playoff rows and non-final rows are never given forfeit fields.

### What makes a matchup `isFinal`

```ts
homePoints !== null && awayPoints !== null && (m.isPlayoff || settledWeeks.has(m.week))
```

Both owners scored **and** the week is over ([§6](#6-settled-weeks-the-safety-property)). The
second half is not redundant: **scores arrive during play.** The extension's Live Sync "ALWAYS
posts the leaderboard" on every poll and the ingest upserts `dkPoints`, so `scores` fills up
while games are still being played — "both owners have a score" says nothing about whether
either lineup has *finished*.

Without the week gate, `/standings` published W-L off half-played lineups and quietly rewrote
it as the afternoon went on. It was reported as *"week 2 is not over yet but every team shows 2
games played"* — on a Monday, with that week's Monday night game not yet kicked off, and the
league's DraftKings contest running through it. Right by Tuesday, wrong all Sunday, and
self-healing enough that nobody would ever file it (`f8e7126`).

> **Playoff rows are EXEMPT**, deliberately. Playoff weeks (19–22) hold no `nfl_games` rows, so
> `computeSettledWeeks` can never include them and gating them would strand the entire bracket
> at unplayed.

> **The gate decides *when* a week counts, not how *fresh* its scores are.** A week whose last
> sync was mid-Sunday settles on partial DraftKings numbers the moment its games age out. The
> post-Monday-night sync is what makes the two line up — see
> [`RUNBOOK.md` §2](RUNBOOK.md#2-the-weekly-loop).

> **Rejected: per-matchup finality** ("count it once both these lineups are done"). It needs
> per-player game state, which lives in `src/lib/live/`, and the module graph deliberately
> forbids the scoring chain from depending on the live estimate
> ([ARCHITECTURE.md](ARCHITECTURE.md)). Week-level gating gives the same answer except for a
> matchup whose owners both finish before Monday night, at no architectural cost.

## 9. Standings

`computeStandings(entries, results, byePointsFor?)` (`src/lib/standings/standings.ts`, pure)
produces one `StandingRow` per owner. Only `isFinal`, non-playoff, non-exhibition results count.

`resolveMatchup` is the exported single resolver, so per-game views (`/my-team`, history)
display exactly the outcome the standings counted rather than re-deriving it from raw points.
Its forfeit branch is where the asymmetry lives:

| Case | Forfeiter | Opponent |
| ---- | --------- | -------- |
| One side forfeits | automatic **L**; PF = own raw points (usually 0); PA = opponent's raw points | **W** if own points `>=` `opponentFacesPoints`, else **L**; PA = `opponentFacesPoints`, *not* the forfeiter's 0 |
| Both forfeit | automatic **L** each; PA = `opponentFacesPoints` each | — |

Because the opponent can *lose* to the benchmark, **a single forfeit can produce a double
loss**, and league wins need not equal league losses. That is the league's rule, not a bug —
`scripts/import-season.ts` reports the double-loss count per season for exactly this reason.

Ties count as half a win: `winPct = (wins + 0.5 * ties) / gamesPlayed`. Results are tallied in
deterministic chronological order so `streak` (e.g. `"W3"`) is stable.

## 10. Tiebreakers

`src/lib/standings/tiebreakers.ts` is a faithful port of the league's original R `resolve_ties`
(committed as `tiebreaker_functions.R`).

**Cohorts are grouped by win percentage alone**, matching the R's `group_by(Win_Percentage)`.
Raw win count is deliberately *not* part of the key: byes are staggered and any non-final
matchup has the same effect, so owners play unequal numbers of games from about week 5 onward.
An owner at 2-2 and one at 1-1 are both .500 and genuinely tied under the league rule — keying
on wins as well would split them and hand it to the extra win without ever consulting
head-to-head or Points For.

Within a cohort the order is resolved **iteratively**:

1. Build the head-to-head grid among only the tied owners. An owner wins the series when it has
   more wins than losses against the other (a split, or never having played, counts as neither).
2. If an owner is head-to-head **dominant** — a winning series against *every* other tied owner —
   place it next. A single series loss disqualifies H2H regardless of group size (3-1 in a
   5-way tie does not qualify).
3. Otherwise place the owner with the most Points For.
4. Remove it and repeat, recomputing the grid each pass.

So the chain is **win% → head-to-head dominance → Points For**. Points Against is an inert final
fallback for an exact PF tie, then `ownerSeasonId` for determinism. The `h2h`/`pf`/`pa` order
itself is a per-season rule (`rules.tiebreakers`) and is never hardcoded.

> Do **not** "simplify" a multi-way tie to a single win% comparison — H2H dominance is
> non-transitive and that simplification mis-seeded 2024 in a previous implementation. The
> divergence from the R at 5+ way ties is intentional and documented in `pickTop`.

## 11. Seeding

`computeConferenceSeeds` (`src/lib/standings/seeding.ts`, pure) mirrors the NFL and is fully
config-driven from `rules.playoffs`:

1. Rank each division with the chain above; the top owner is the division leader.
2. Rank the four leaders among themselves; the first `divisionWinnersPerConference` become seeds
   1..N. Any surplus leader drops back into the wild-card pool.
3. The best remaining non-winners fill up to `wildCardsPerConference`, capped by
   `teamsPerConference`.
4. Seeds `<= topSeedByes` get `isBye = true` (a first-round bye).

`getStandingsView` withholds playoff tags until at least one regular-season week is final —
before that every owner is 0-0 and the chain falls through to `ownerSeasonId` order, which would
render an arbitrary "seeding" that misleads.

## 12. The bracket, and the game that decides 3rd

Seeds go to `src/lib/playoffs/service.ts`, which writes `playoff_matchups` and scores each round
from that week's `scores` exactly like a regular-season week. Two mappings govern it:

| Constant | Contents | What it is |
| -------- | -------- | ---------- |
| `PLAYOFF_ROUND_WEEKS` | `wild_card` 19 · `divisional` 20 · `conference` 21 · `championship` 22 · **`third_place` 22** | Which week each round is scored from. |
| `PLAYOFF_ROUND_ORDER` | `wild_card` → `divisional` → `conference` → `championship` | The **advancement chain** only. |

**3rd and 4th are decided on the field.** The two beaten conference finalists play a consolation
game in championship week; its winner takes 3rd and its loser 4th. `advanceBracket('conference', …)`
therefore returns **two** games — the championship, paired from the round's winners, and the
`third_place` game, paired from its losers (`resolveLoser` in `src/lib/standings/playoffs.ts`).
Both are cross-conference, so both carry `conference = null`.

Because it shares week 22, the consolation game is scored from the **same DraftKings contest** as
the championship: Admin → Playoffs still configures one contest per playoff week (19–22), and
syncing week 22 resolves both games at once.

> **`third_place` is a leaf, not a step in the chain — keep it out of `PLAYOFF_ROUND_ORDER`.**
> `advancePlayoffs` walks that list and breaks at the first round that has no rows or is not
> fully scored. A consolation game sitting in the chain would therefore stop the walk **before**
> the championship whenever it is missing or unplayed, and nothing advances out of it anyway.
> It is resolved explicitly in the same pass as the championship instead: `resolveRoundGames`
> was extracted so both week-22 games are settled by the same code.

`loadBracketOutcome` (`src/lib/awards/service.ts`) then reads the resolved consolation row —
winner → `third`, loser → `fourth` — so the $300/$150 placements are recorded live alongside the
champion and runner-up. `import:awards --third=<ownerSeasonId>` survives **only** as a fallback
for seasons imported before the game was modelled: 2023–2025 have no consolation row, and they
are frozen. See [`RUNBOOK.md` §3](RUNBOOK.md#3-recomputing-awards).

## 13. What `verify` proves

`npm run verify` (see [`RUNBOOK.md`](RUNBOOK.md)) carries two TRUTH checks that exist specifically
to keep this path honest:

- **historical snapshot unchanged** — `scripts/verify.ts` diffs the engine's full derived output
  for 2023–2025 against `scripts/fixtures/standings-baseline.json`: every owner's record and
  PF/PA, the full ranked ORDER per division and conference, both conferences' seeds, the
  weekly-high and most-points leaders, and the whole `season_awards` ledger. Exact — the only
  slack is a 4-decimal rounding so float noise cannot fail the gate. Any diff names the year and
  field that moved.
- **engine no-op proofs** — four preconditions that make the derivation model provably safe on
  history rather than merely observed to be: derived forfeits equal the stored `isForfeit` set;
  schedule-derived byes equal the stored `isBye` flags; every owner played the same number of
  games (so equal win% implies equal wins, and the cohort key can drop `wins`); and 2023–2025 are
  still on `league_average`.

Frozen seasons must not move. Re-baselining is a deliberate, sign-off-required act — see
[`RUNBOOK.md` §6](RUNBOOK.md#6-the-snapshot-gate).

## 14. If you add a query that reads `scores` or `matchups`

Four rules, all of which have been broken at least once:

1. **Filter exhibition rows** — `eq(scores.isExhibition, false)` /
   `eq(matchups.isExhibition, false)`. There is no schema-level guard; a preseason blow-up
   otherwise becomes a league record. `src/lib/history.ts` is the usual place this is missed.
2. **Do not re-derive standings facts.** Wins, Points For, forfeits, weeks played and the ranked
   order all have one authoritative source: `getSeasonStandingsData` /
   `getRankedSeasonStandings` / the `forfeitByOwnerWeek` set they return. Re-deriving is how
   `/history` came to contradict `/standings` on the same page.
3. **Cap the week** against the *canonical* `seasons.regularSeasonWeeks` column for anything
   labelled "regular season", or playoff weeks 19–22 leak in.
4. **Reconcile byes** with `isEffectiveBye` rather than filtering the raw `isBye` column in SQL.

App code (`src/app/**`, `src/lib/history.ts`) should prefer the request-scoped
`*Cached` exports from `standings/query.ts`. **Scripts must not** — `scripts/import-season3.ts`
mutates the database and reads standings back to validate them, and a memo outliving the write
would hand the ground-truth replay stale rows.

## 15. Live in-progress scoring (an estimate, never a score)

> **Status: built (Phases 0–5).** The scoring **engine** and its ESPN adapter ship in
> `src/lib/dfs/`; roster **capture and storage** ship in `src/lib/lineups/`, behind
> `POST /api/ingest/lineups` and Admin → Lineups; the Chrome extension (v1.5.0) captures scores
> **and** rosters from one **Sync** click, and its Live Sync loop now
> [re-reads rosters by itself](#keeping-the-capture-fresh-without-asking-anyone) when the app says
> a kickoff has revealed players the estimate is missing; `src/lib/live/` joins the two halves and
> [**`/live`**](#rendering-it--live-phases-45) renders them. Whether the result actually agrees
> with DraftKings is [audited on demand](#does-the-estimate-agree-with-draftkings--the-drift-audit)
> from numbers every capture already stores.
>
> Migration `drizzle/0010_polite_nicolaos.sql` (the two capture tables) is **applied** to production.
>
> **Proven end to end** on a real capture — season 1, week 102 (an exhibition week): 6/6 owners,
> 54 slots, 24 revealed, all enriched to teams, 16/16 games loaded, zero unresolved, and a
> reconciliation against DraftKings' own per-owner numbers of **max |delta| 0.00**. That is the
> estimate agreeing exactly with the authority it must never replace — **on a preseason contest
> with 6 owners.** It proves the wiring, not the engine's precision across a full Sunday; see
> [Remaining gaps](#remaining-gaps). That reconciliation was done **by hand, once**. It is now a
> page: Admin → Scoring re-runs it against week 102 and returns the same verdict — 54 slots, 54
> agree, max |delta| 0.00 — without anyone opening a spreadsheet.
>
> **Then proven on a real regular-season week** — season 1, week 1 (2026): **288 slots across 32
> owners, every one of DraftKings' own per-player numbers reproduced to the cent**, max |delta|
> **0.00**, and **`pointsAllowedMode: 'raw'` settled** against the one game in the slate where the
> two modes disagree (ATL/PIT — DraftKings paid the raw tier). **No scoring rule was
> changed to get there.** The week did not start out looking like that: it rendered as 288
> *unresolved* slots with every owner on 0.00, and the cause was **identity, not arithmetic** —
> see [When identity fails, the whole week fails](#when-identity-fails-the-whole-week-fails).
>
> Not to be confused with the **live-scoring remediation** (`docs/HANDOFF.md`), which was a
> different piece of work with its own Phase 0–4 numbering. That one fixed §3–§7 of *this* chain;
> this one sits outside the chain entirely.

A week's authoritative score is the DraftKings contest leaderboard, captured by the Chrome
extension from the commissioner's logged-in browser ([§4](#4-ingest-write-time)). That capture
needs a live session, so keeping the numbers moving *during* the games means leaving a machine
on all week.

The alternative, now built: capture each owner's DraftKings **roster** (still authenticated, still
from the commissioner's browser — a handful of times a week, not continuously), then recompute
DraftKings points **server-side** from ESPN's public boxscore API. No DK auth on the server, no
cron, machine can be off between captures. See
[`DRAFTKINGS.md` §11](DRAFTKINGS.md#11-endpoint-inventory--what-is-public-and-what-needs-auth)
for why the stat feed has to be ESPN and not DraftKings.

### The safety invariant

> **A computed live figure is an ESTIMATE.** It must never be written to `scores`, never reach
> `computeStandings`, and never feed `weekIsFinal`. When DraftKings' leaderboard lands, DK wins —
> unconditionally, even if our number looks more right.

The estimate and the real score differ for reasons that are known and will not go away
([exact vs best-effort](#exact-vs-best-effort) below), and every consumer of `scores` — records,
payouts, seeds, the frozen 2023–2025 snapshot — assumes the number in that column is DraftKings'
own. Blending the two would corrupt the chain silently, in a way `npm run verify` cannot catch,
because a plausible-looking estimate is not a diff.

Two things hold the invariant up, and they are different in kind:

- **Structurally:** nothing in `src/lib/dfs/` imports the database, the Drizzle client, or
  `src/lib/standings/`. The engine *cannot* reach the chain.
- **Mechanically:** the capture path *does* need the database, so it gets a test instead.
  `src/lib/lineups/no-write.test.ts` scans every non-test `.ts` under `src/lib/dfs`,
  `src/lib/lineups` and `src/lib/live` — **and the `src/app/live` route itself**, because a server
  component can reach the database directly and "the lib layer is clean" would be an incomplete
  proof. It fails if any of them writes to `scores`, `matchups`, `playoff_matchups`, `season_awards`
  or `nfl_games`, or calls `ingestLeaderboard` / `writeTeamScores`. **Every module in those
  directories is scanned — the list is discovered, not enumerated, so a new file is covered the
  moment it lands.** It also asserts it found something to scan, so a guard that silently checks
  nothing fails loudly. 30 tests — a count that **grows on its own** as modules land, because the
  list is discovered rather than written down. The drift audit's two modules pushed it from 24 to
  26 the moment they were saved, with no edit to the test; widening the scan to the two admin/API
  surfaces took it to 30.

  > **The ROUTES are scanned too, not just the libraries behind them**, because a server component
  > or route handler can reach the database directly and "the lib layer is clean" would be an
  > incomplete proof. `guardedRouteDirs` covers `src/app/live`, `src/app/api/live-status` and
  > `src/app/admin/(panel)/scoring`. **Add any new live-scoring surface to that list** — unlike the
  > library dirs, routes are enumerated, not discovered.

Reads are deliberately allowed — a live view is *supposed* to read `scores` and show DraftKings'
authoritative number beside the estimate. Only writes are forbidden.

If that test ever fails, the fix is almost always **a new table, not a write to an existing one**.
Keep it that way — a live page renders an estimate *beside* the score, never *into* it.

### What ships today — the engine (Phase 1)

| Module | Role |
| ------ | ---- |
| `src/lib/dfs/rules.ts` | DK Classic NFL scoring as **frozen data**: `DK_CLASSIC_NFL`, `DK_CLASSIC_SALARY_CAP` (50,000), `DK_CLASSIC_SLOTS` (QB · RB · RB · WR · WR · WR · TE · FLEX · DST — **no kicker**). |
| `src/lib/dfs/stat-line.ts` | `PlayerStatLine` / `DstStatLine` — the source-agnostic input contract, named after DK's rules rather than any provider's JSON. |
| `src/lib/dfs/score.ts` | The pure engine: `scorePlayer`, `scoreDst`, `scoreLineup`, `pointsAllowedPoints`, `round2`. |
| `src/lib/dfs/sources/espn-boxscore.ts` | The keyless ESPN summary client: `fetchGameSummary(espnEventId, ttlSeconds)`, `BOXSCORE_TTL_SECONDS`. |
| `src/lib/dfs/sources/espn-extract.ts` | Pure ESPN payload → stat lines: `extractGame`, plus the play-text helpers. |
| `src/lib/nfl/team-keys.ts` | `normalizeTeamKey()` — one copy, shared by the DK, Sleeper and ESPN adapters. |

73 unit tests cover the two pure modules (41 in `score.test.ts`, 32 in `espn-extract.test.ts`), the
latter against two trimmed real payloads in `scripts/fixtures/` (CHI @ MIN 2025 week 1, and a 2026
preseason DET @ CIN game). The ESPN *client* has 12 of its own in `espn-boxscore.test.ts`, which
exist mainly to pin the retry and its `AbortSignal` ([below](#a-dropped-boxscore-is-retried-not-painted-as-)).

Three engine properties are load-bearing:

- **An unresolved slot is `null`, never `0`.** `scoreLineup` returns `points: null` for a roster
  slot it could not match to a stat line and reports `unresolvedCount`; the lineup total sums only
  what resolved. A matching failure must **understate**, never invent — a fabricated 0.00 is
  indistinguishable from a genuine goose egg. Any UI must surface `unresolvedCount`.
- **Rounding happens once, at the boundary.** Intermediate sums stay at full float precision;
  only the returned total is `round2`-ed. Rounding per rule drifts, and 32 owners × 9 slots
  compounds it.
- **`pointsAllowedMode` ships `'raw'`, and `'raw'` is SETTLED — measured against the case that
  separates the two modes.** DraftKings' published rule reads as though it carves out points the
  DST itself was not on the field for (a pick-six thrown by *your own* offense). No free feed
  implements that, so the rule set shipped `'raw'` (the opponent's final score) with
  `'exclude_scores_against_offense'` defined but unimplemented — and **2026 week 1 contained the
  divergence case outright**:

  > **Atlanta's DST conceded 20 to Pittsburgh, and 7 of those points — a defensive touchdown plus
  > the extra point — were scored by PITTSBURGH'S DEFENSE against Atlanta's own offense.** Under
  > the carve-out Atlanta allows 13 and DraftKings pays the `7-13 PA` tier, **+4**. DraftKings'
  > own captured stat line reads `14-20 PA = 1(1)` — the **raw 20**, tier **+1**. Our engine
  > scored that DST at **5.00** against DraftKings' **5.00**.

  **So do not "fix" this to `exclude_scores_against_offense` on the strength of the rules page**;
  the measurement disagrees with that reading, and it was taken against DK's own numbers. Every
  other DST agreed too: 32 DST slots across **11 distinct rostered defenses** (JAX MIA PHI PIT TEN
  NYJ ATL LV HOU LAC CLE), all matching to the cent, including one that conceded **36** and landed
  in the bottom `35+ PA` tier at **−4**. Re-checking no longer needs a hand audit: a wrong mode
  lands a DST exactly one tier off in a game with a defensive or return touchdown, and
  [the drift audit](#does-the-estimate-agree-with-draftkings--the-drift-audit) reports that as
  `ruleDrift` with the points-allowed component named. (`npm run dfs:selftest` will **not** catch
  it — that compares QB/RB/WR/TE only.) The authority is the `PointsAllowedMode` doc comment in
  `src/lib/dfs/rules.ts`.

### Exact vs best-effort

Straight out of ESPN's boxscore, no inference — roughly 99% of DK scoring by volume:

> passing / rushing / receiving yards and TDs · receptions · interceptions thrown · fumbles lost ·
> kick and punt return TDs · sacks · defensive interceptions · defensive TDs · points allowed

Best-effort, because ESPN exposes them **only as English play text** in `drives[].plays[].text`
and `scoringPlays[]`:

> 2-point conversions · safeties · blocked kicks

Each is worth 2 points and touches a handful of players league-wide per week. 2-pt conversions are
attributed through ESPN's abbreviated gamebook names ("P.Mahomes"), which is inherently fuzzy; DK
pays +2 to the passer **and** the receiver on a successful conversion pass. A miss costs ±2 on one
player and is corrected the moment the official DraftKings total lands — which is exactly why the
estimate must never *become* the score.

Known gap: a blocked-kick *return* touchdown is a special-teams TD to DraftKings but is not
separable from other return TDs in ESPN's data. Rare enough to accept.

#### Which ESPN number is the right one — a DST reads the OPPONENT's totals

"Straight out of the boxscore" hides a choice, because ESPN reports the same event from both
sides and **the per-player rows are not always the authority**. Two DST stats are therefore read
from the **opponent's team totals**, not from our own defenders' rows:

| DST stat | Read from | Why not the obvious field |
| -------- | --------- | ------------------------- |
| `sacks` | opponent's `sacksYardsLost` (`"3-16"` → 3) | ESPN's per-player `defensive` rows **settle later than the aggregate** and can be short a sack the team total already carries. |
| `fumbleRecoveries` | opponent's `fumblesLost` | Our own `fumblesRecovered` also counts recovering *our own* team's fumble, which DraftKings does not pay for. |

`sacksYardsLost` on a team means sacks **that team's offense took**, so the defense being scored
reads the other team's row. That is the same relationship `fumbleRecoveries` already used; the sack
rule was brought into line with it in `cadf15f`.

**Measured, not assumed.** 2026 week 2 surfaced it: Atlanta's offense was sacked three times
(`"sacksYardsLost": "3-16"`), DraftKings paid the Carolina DST for **3**, and Carolina's player
rows summed to **2**. One point — and it was the entire gap between an owner reading **116.62**
here and **117.72** on DraftKings. Across every DST in weeks 1–2 with a DK sack count on a final
game, the **opponent total is right 17/17** and the player sum **16/17**, so the team total leads
and the player sum is only the fallback for a missing row. Two further checks, because a fix that
is right for the wrong reason is a trap:

- Cross-checked against the opponent quarterbacks' own `sacks-sackYardsLost` per-player stat — a
  different part of the payload entirely — over every final game in both weeks. **No disagreement.**
- Confirmed the team stat populates **during play**, not only at Final: 6 in-progress games, **12
  of 12** defenses had it and all matched. A stat that only appeared after the whistle would have
  regressed live scoring, which is the only thing this path is for.

> **`teamPairedStat` exists because `teamStat` cannot read these rows.** `parseStat` sees `"3-16"`,
> fails `Number()`, and returns **0** — indistinguishable from a real "no sacks" — and ESPN sends
> `value: "-"` on paired rows, so the numeric branch does not save it either. `teamPairedStat`
> returns `null` for an absent row so the caller can tell that apart from a genuine `"0-0"`.

#### ⚠️ Near a yardage bonus, one yard is worth THREE POINTS

**This will recur every week, it is not a bug, and it is the single most likely reason a `/live`
number differs from the DraftKings app.** We score from ESPN; DraftKings scores from its own feed.
The two occasionally disagree by a yard — and a yard is normally worth 0.1, *except* at 100 and 300
where it also decides a **+3 bonus**.

Live example from 2026 week 2: **DraftKings had Jaxon Smith-Njigba at 100 receiving yards and ESPN
had 99** — consistently 99, across its boxscore row, its play-by-play (82 + 10 + 7) and its leaders
block, so there was nothing to "fix" on our side. 0.1 of yardage plus 3.0 of bonus = **3.1 points
of divergence on one yard.**

Nothing in this repo can close that gap: it is two feeds disagreeing about what happened, which
[the drift audit](#does-the-estimate-agree-with-draftkings--the-drift-audit) classifies as
`statDrift` — **explicitly not our bug, and deliberately not flagged as needing attention**. The
DraftKings leaderboard remains the official score; the estimate is an estimate. Say so when someone
reports it, and do not go looking for a rule bug in `rules.ts`.

### Checking the engine against something

The engine has no upstream to check itself against until DK's leaderboard lands at the end of the
week, so `npm run dfs:selftest` (`scripts/dfs-selftest.ts`) builds one out of two independent
free feeds:

```bash
npm run dfs:selftest                          # 2025 regular-season week 1
npm run dfs:selftest -- --year=2025 --week=4
npm run dfs:selftest -- --year=2025 --week=4 --verbose
```

```text
ESPN boxscore  ──▶ our engine          ──▶ DK points
Sleeper stats  ──▶ Sleeper's own math  ──▶ pts_ppr
```

DK Classic and full PPR differ by a **known, enumerable** set of rules, so every per-player delta
must decompose into that set; anything left over is printed as a real bug. The known differences:

- **DK adds** +3 for 300+ passing, 100+ rushing, and 100+ receiving yards.
- **Sleeper adds** +1 per special-teams solo tackle (`st_tkl_solo`). DK Classic pays nothing for
  those, so the lower number is ours and it is correct. Ben Skowronek, 2025 week 1 — dk 9.20 vs
  ppr 10.20 — is the canonical example.

The script exits non-zero above a 5% unexplained rate. **Verified 2026-08-14: 100% explained on
2025 weeks 1, 4 and 12 — 592 players compared, 0 unexplained.**

Sleeper is a *reconciler*, not a live feed: six preseason games that had been final for 14 hours
still returned zero rows while ESPN had complete boxscores. It is a batch feed and cannot drive a
live page.

> **This is one of two checks, and they are not redundant.** The self-test compares us against
> *Sleeper's* rules and reconciles the known delta; the
> [drift audit](#does-the-estimate-agree-with-draftkings--the-drift-audit) compares us against
> **DraftKings' own per-player numbers**, which every capture already stores. The self-test needs
> no captured roster and covers a whole week; the audit needs a capture and covers only the players
> the league actually started. Run the self-test when you touch `rules.ts`; read the audit after a
> real Sunday.

### Capturing the rosters (Phase 2)

The engine needs to know **who each owner started**. That is the one thing only DraftKings knows and
only a logged-in browser can read, so it is captured and stored rather than fetched on demand.

| Module | Role |
| ------ | ---- |
| `src/lib/lineups/normalize.ts` | `normalizeRosterPayload(envelope, fallbackName?)` — any DK roster payload → `LineupInput[]`. Pure. |
| `src/lib/lineups/enrich.ts` | `applyDraftableIndex(lineups, index)` (pure) / `enrichLineups(lineups, draftGroupId)` — `draftableId` → `(name, teamKey, position)`. |
| `src/lib/lineups/ingest.ts` | `ingestLineups(params)` — enrichment + identity backfill from the week's earlier captures + owner matching + the audit row + chunked snapshot upserts. |
| `src/lib/lineups/query.ts` | `getCaptureStatus(seasonId, week)` — the newest snapshot per owner, plus recent capture runs. |
| `src/lib/lineups/no-write.test.ts` | The safety invariant, enforced as a test (above). |
| `src/lib/draftkings/draftables.ts` | `fetchDraftableIndex(draftGroupId)` → `Map<draftableId, DraftableIdentity>`, sharing one raw fetch with the salary view. **Returns an empty map on failure** — see [below](#when-identity-fails-the-whole-week-fails). |
| `scripts/repair-lineup-identities.ts` | Refills `name` / `teamKey` / `position` on snapshots a capture stored as null. Dry-run by default; `--write` applies. [Below](#when-identity-fails-the-whole-week-fails). |
| `src/app/api/ingest/lineups/route.ts` | `POST /api/ingest/lineups`, bearer `INGEST_TOKEN`. Contract: [`DRAFTKINGS.md` §12](DRAFTKINGS.md#12-the-roster-ingest-endpoint-implemented). |
| `src/app/admin/(panel)/lineups/` | Admin → Lineups: capture status, the paste fallback, the capture-run audit table. |

Storage is two tables — `lineup_capture_runs` (audit) and `lineup_snapshots` (the rosters) — fully
specified in [`DATA_MODEL.md`](DATA_MODEL.md#live-scoring-lineup_capture_runs--lineup_snapshots).
Migration 0010 is **applied**.

Six decisions are load-bearing:

- **Snapshots are append-only, versioned by `capturedAt`.** DK Classic sets `allowLateSwap: true`,
  so an owner can swap a player until *that player's* game kicks off; one lock-time capture goes
  stale for later games. The roster "in effect" is the **newest row per `(ownerSeason, week)`** —
  `getCaptureStatus` takes it with Postgres `DISTINCT ON`, one round-trip. The upsert key is
  `(ownerSeasonId, week, capturedAt)`, so a retried post is idempotent while a genuinely newer
  capture adds a version. `capturedAt` is **when DraftKings was read**, not when the row was
  written; late-swap resolution depends on it.
- **Normalization is shape-agnostic, by necessity.** DK's roster endpoint is undocumented, so
  `normalizeRosterPayload` identifies roster rows **structurally** — an object carrying a player id
  plus a slot or a name — and walks the tree for them, the same technique the extension's
  leaderboard extractor uses. It handles a bulk leaderboard with embedded rosters, a single entry
  with a roster, and a bare roster array (which needs `entryName` supplied, because a roster nobody
  can be attributed to is surfaced as skipped rather than guessed at). **The endpoint probe
  therefore CONFIRMS the shape rather than defining it** — and it did: the real payload landed as
  `scripts/fixtures/dk-roster-entry.json` and the normalizer passed it unchanged. 37 unit tests
  cover it.
- **DraftKings' own numbers are captured but never scored from.** Each revealed slot stores
  `dkScore` (DK's points) and `dkStats` (DK's per-stat breakdown, verbatim, keyed by DK's own
  abbreviations). They exist **only at capture time** — the authenticated roster endpoint is the
  only source and it ages out with the contest — and they are the reconciliation checkpoint for the
  ESPN-derived estimate. `dkStats` is the sharp one: a matching *total* can hide two compensating
  errors, a per-stat diff cannot, which is also how `pointsAllowedMode` (above) was settled
  empirically. `null` means "no breakdown in the payload"; `[]` means "DK says nothing has happened
  yet" — do not collapse the two.
- **A concealed slot is not an empty one.** DraftKings hides a player from opponents until that
  player's game kicks off; the row arrives as `{ rosterPosition, draftableId: 0, isSwappable: true,
  yetToPlay: true }` with no name, and normalization marks it `revealed: false` (id `0` means
  *absent*, not "player number zero"). Three things follow, and getting any of them wrong reads as a
  bug that isn't one: a capture of 32/32 owners can legitimately reveal only a fraction of the 288
  players; a concealed player has scored nothing by definition, so **no points are ever missing from
  a capture, only names**; and because concealment tracks swappability exactly, anyone you *can* see
  is already locked, so **revealed data never goes stale**. Concealed slots are also never
  de-duplicated — they are identity-less by construction, and collapsing them would turn a nine-man
  lineup into a five-man one.
- **Identity is resolved at CAPTURE time, not read time — from three independent sources.** DK's
  roster payload carries no `teamAbbreviation` and no player position, and scoring reaches ESPN by
  `(normalizeName, teamKey)`, so a slot with no team is not scorable — not now, and not months
  later once DK has expired the draft group. Identity is therefore pinned *before* the snapshot is
  written, which is the whole architecture in miniature: authenticate once for *who was started*,
  then compute all week from public data. Three sources are tried, and the capture only needs
  **one** of them to work:

  1. **The payload itself — TEAM only.** `normalizeSlotObject` reads the player's own team out of
     DK's `competition.nameDisplay[]`, whose fragments for the player's side are flagged
     `isEmphasized` ([`DRAFTKINGS.md` §11](DRAFTKINGS.md#the-roster-endpoint-found--this-is-the-one)).
     No network call, nothing to expire. **Primary since 2026 week 1** — and team is the part
     scoring cannot do without, since the ESPN join is `(normalizeName, teamKey)`.
  2. **The public draftables endpoint.** `enrichLineups` indexes it by `draftableId` and fills
     what is left — and it is the **only** source of a player's `position`, which DK's roster
     payload does not carry. It runs at capture because DK expires draftables for old draft groups.
  3. **This week's earlier captures.** `backfillIdentities` (in `ingest.ts`) carries a
     `draftableId` that was already resolved forward into a later capture, so **a newer capture
     can never know less than an older one**.

  Values already in DK's payload always win, source 3 only ever fills nulls, the draftables fetch
  never throws, and unresolved ids are **reported, never silently zeroed**. A capture that still
  ends up storing a revealed slot with no team is recorded `status: 'partial'` with the reason in
  `error` — it is not a success. Admin → Lineups has its own **DK draft group id** field, so a
  pasted capture uses source 2 too when it is filled in; left blank, only sources 1 and 3 apply,
  which is usually enough to score but leaves positions unresolved. See
  [When identity fails, the whole week fails](#when-identity-fails-the-whole-week-fails).
- **Both ingests resolve owner names through one module.** `loadOwnerNameMap` /
  `normalizeEntryName` moved out of `scores/ingest.ts` into `src/lib/scores/owner-match.ts` and are
  now shared. If score matching and roster matching ever diverge, an owner's roster and their score
  land on different rows and a live view shows one person's lineup against another's total.
  Unmatched entry names are reported, never dropped — the usual cause is a changed
  `owner_seasons.dkEntryName`.
- **`isExhibition` is derived from the week**, never supplied, exactly as `scores` does it
  ([§2](#2-the-three-week-namespaces)). Preseason rosters stay isolated for free.

Auth and the week contract are shared with the score ingest, not re-implemented:
`src/lib/ingest/auth.ts` (`isAuthorized`, `timingSafeEqual` — a server with no `INGEST_TOKEN`
rejects everything rather than falling open) and `src/lib/ingest/week-schema.ts` (`weekSchema`,
`MAX_REGULAR_WEEK` 25, `MIN_EXHIBITION_WEEK` 101, `MAX_EXHIBITION_WEEK` 103). Both were extracted
from `src/app/api/ingest/draftkings/route.ts` with no behaviour change.

#### When identity fails, the whole week fails

**2026 week 1 rendered as 288 unresolved slots — every owner on 0.00 — and nothing reported a
problem.** The scoring engine was never implicated: replaying that same week with identity restored
reproduces DraftKings' own number on all 288 slots and all 32 owner totals, exactly. The chain is
worth reading in full, because every link in it looked reasonable on its own:

1. A capture identifies each drafted player by **`draftableId` alone**. Team came solely from DK's
   public draftables endpoint, fetched at capture time.
2. `fetchDraftableIndex` **swallows its errors and returns an EMPTY MAP**. `enrichLineups` then
   passed the lineups through untouched, so the week's fourth capture stored every slot with
   `teamKey: null`.
3. A slot with no team cannot be matched to an ESPN boxscore, so it scores `unresolved` — and that
   is **not recoverable at read time**.
4. `/live` scores the **newest** capture per owner and nothing else, so that one bad capture
   **discarded three good ones** taken earlier the same day.
5. The capture run logged `status: 'success'` with no error, because "the lookup failed" and
   "nothing needed enriching" produced byte-identical results.

Four changes close it, layered on purpose rather than collapsed into one fix:

- **The network left the critical path.** Team now comes from the payload itself — source 1
  [above](#capturing-the-rosters-phase-2).
- **A failed lookup became distinguishable.** `EnrichResult.indexUnavailable` separates "we learned
  nothing at all" from "there was nothing to learn".
- **Captures became monotonic.** `backfillIdentities` carries earlier identity forward, so a newer
  capture can never know less than an older one.
- **The failure became loud.** `ingestLineups` counts revealed slots stored without a team and
  records the run `partial` with an explicit `error`. `IngestLineupsResult` gains
  `backfilledSlots`, `draftablesUnavailable` and `slotsWithoutTeam` (the HTTP response shape of
  `POST /api/ingest/lineups` is unchanged — these are for the capture-run audit row and callers in
  process).

**Snapshots already stored team-less are repaired by `scripts/repair-lineup-identities.ts`**, not
by re-capturing — DK expires draftables for old draft groups, so by the time anyone notices, the
endpoint that would have answered no longer does:

```bash
npx tsx scripts/repair-lineup-identities.ts                          # dry run — report only
npx tsx scripts/repair-lineup-identities.ts --write                  # apply
npx tsx scripts/repair-lineup-identities.ts --season=1 --week=1 --write
```

It tries the same three sources in the same order — the capture's **own stored `rawPayload`** (via
the fixed normalizer) first, then sibling captures of the same week, then the public draftables
endpoint. It writes only `lineup_snapshots.slots`, only ever **fills nulls**, and is idempotent; a
second run reports nothing left to do. Run against production it repaired **288 slots across 32
snapshots** for 2026 week 1, after which the drift audit reads **288 compared, 288 agree, 0 rule
drift, 0 stat drift, 0 unmapped, 0 unmatched, 0 skipped, max |delta| 0.00**. Operational detail:
[`RUNBOOK.md`](RUNBOOK.md#repairing-a-capture-that-stored-no-teams).

> **The generalisable lesson: a swallowed error is only safe if the caller can tell it happened.**
> `fetchDraftableIndex` returning an empty map rather than throwing was the right call — a capture
> that stores names without teams beats a capture that fails outright. What was missing was any way
> for the caller to *know*, and a silent degradation four layers upstream surfaced as an entire week
> of zeros with four green capture runs behind it.

### Rendering it — `/live` (Phases 4–5)

`src/lib/live/` joins the two halves — *who they started* (captured) and *what those players did*
(public) — and `/live` renders the result.

| Module | Role |
| ------ | ---- |
| `src/lib/live/stats.ts` | The week's ESPN stat index. `buildLiveStatIndex(games)` (unwrapped, for scripts/tests) and `getLiveStatsForWeek(seasonId, week, games)` (cached). Plus `playerStatKey(name, teamKey)` and `liveTag(seasonId, week)`. Types: `LiveStatIndex`, `LivePlayerStat`, `LiveDstStat`, `LiveGameSummary`, `LiveGameRef`. |
| `src/lib/live/assemble.ts` | `assembleLive(matchups, snapshots, index)` — **pure**: no DB, no network, no clock. Types: `LiveView`, `LiveMatchup`, `LiveTeam`, `LiveSlot`, `LiveSlotStatus`. 17 unit tests. |
| `src/lib/live/query.ts` | The only DB module behind `/live`, and **read-only**: `getLiveWeekData(seasonId, week)`, `getDefaultLiveWeek(seasonId)`, `getMatchupLocation(matchupId)`, type `LiveTeamContext`. |
| `src/lib/live/staleness.ts` | **Pure.** `assessCaptureStaleness(input)` and `countConcealedSlots(matchups)` — detects a capture that has been overtaken by kickoffs. 8 unit tests. See [below](#the-staleness-problem--one-capture-is-not-enough). |
| `src/lib/live/minutes.ts` | **Pure.** How much football is left: `minutesLeftInGame(clock)`, `lineupMinutes(slots, clockByTeam)`, plus `parseClockMinutes` / `formatMinutes`. Types `GameClock`, `LineupMinutes`. 12 unit tests. See [below](#minutes-remaining--how-much-football-is-left). |
| `src/lib/live/projection.ts` | **Pure.** Projected finals and who is winning: `projectSlot`, `projectLineup`, `winProbability`, `formatWinProbability`. Types `LineupProjection`, `WinProbability`. 20 unit tests. See [below](#projections--win-probability--draftkings-own-formula). |
| `src/lib/live/reconcile.ts` | **Pure.** Do we agree with DraftKings, player by player: `reconcileSlot`, `reconcileWeek`, `RECONCILE_TOLERANCE = 0.01`, and the `DK_TO_OUR_KEY` stat map. Types `ReconcileVerdict`, `SlotReconciliation`, `ReconcileSummary`. 19 unit tests. See [below](#does-the-estimate-agree-with-draftkings--the-drift-audit). |
| `src/lib/live/reconcile-query.ts` | The DB half of that audit, **reads only**: `reconcileWeekFromDb`, `buildReconciliation`, `getReconcilableSeasons`, `getCapturedWeeks`. Holds `ASSUMED_GAME_LENGTH_MS` — the one approximation in the feature. |

**The join is `(normalizeName, teamKey)`** — Phase 4, and it lives in `playerStatKey`. The team
component is not optional: name alone collides on real players (Bijan vs Brian Robinson, Travis vs
Trevor Etienne, Josh vs Jonathan Allen) and produced 18 phantom mismatches in the self-test before
the team key was added. Phase 2's capture-time enrichment is what puts that team key on a snapshot.

#### The five slot states — the load-bearing concept

**A slot we could not score is NEVER 0.00.** Zero is a real DraftKings result — a player can
genuinely score nothing — so every *other* reason a number is missing gets its own state, and the
team total is a **floor** with the reason attached. A mid-Sunday page where everyone sits near zero
must never be readable as "everyone forfeited"; that is the same class of bug this whole document
exists to prevent, avoided here by never producing the ambiguous value in the first place.

| `LiveSlotStatus` | Meaning | `points` |
| ---------------- | ------- | -------- |
| `scored` | We have the player's stat line. Real — and **may legitimately be 0**. | a number |
| `pending` | Their game has not kicked off. Contributes nothing *yet*, and says so. | `null` |
| `concealed` | DraftKings hid the pick when the roster was read, so we do not know **who** it is. Same arithmetic as `pending`, **opposite meaning** — see below. | `null` |
| `noStats` | Their game **is** underway **and** we loaded its boxscore, but they have no row in it. | `0` |
| `unresolved` | Their game did not load at all, so we genuinely do not know. **The only bad state.** | `null` |

**Why `noStats` is separate from `unresolved`** — this was measured, not guessed. ESPN lists only
players who *recorded* a stat, so a missing row in a **loaded** boxscore means the player has done
nothing, which DraftKings pays as exactly 0. In the first real capture, **13 of 24 revealed players
had no ESPN row and every one was worth 0.00 per DraftKings.** Calling those `unresolved` would
paint `?` over half of every roster and make a working page read as broken; calling them `scored`
would hide a genuine name-matching failure. They are a third thing: scored as 0, counted separately.

**A missing DEFENSE is `unresolved`, not `noStats`.** Points allowed alone guarantees a defense a
row in any loaded boxscore, so its absence really does mean we don't know.

##### 🛑 `pending` and `concealed` have identical arithmetic and OPPOSITE meanings

They are both worth `null`, which is why they were merged in the UI and summed as **"to play"** —
and that label is true of one and a lie about the other:

- **`pending`** — we know exactly who this is, and their game has not started. The total below is
  **complete right now**.
- **`concealed`** — DraftKings hid the pick at capture time, so we do not know who it is. If their
  game **has since started**, they are scoring points the total does **not** include. The total is
  a **floor**.

**2026 week 2 is the worked example.** The only capture was taken at 1:08pm and nobody re-synced,
so the entire late slate stayed concealed. The page read *"7 playing · 2 to play"* and showed
**56.02** against DraftKings' **78.42** — and the two "to play" players were **CeeDee Lamb (19.90)
and a Washington back (2.50)**, 22.40 between them, both on the field at that moment. **The scoring
was exact. The label said the gap was fine.**

So the two are now reported separately, and `src/app/live/roster-summary.ts` owns the wording
because it was independently wrong in **both** the week list and the detail page:

| Function | Contract |
| -------- | -------- |
| `rosterSummaryParts(team)` | `["7 playing", "2 to play", "2 unknown", "1 unresolved"]` — clauses in reading order, omitting any that is 0. Returns the **parts**, not a joined string, so the detail page can prepend its own minutes-remaining clause without re-deriving the counts. |
| `isFloorTotal(team)` | `hasSnapshot && concealed + unresolved > 0`. **`pending` is deliberately excluded** — a player who has not kicked off is worth nothing yet, so the total is complete. Only points we *cannot see* make the number an understatement. |

A floor total renders with a **trailing `+`** (`56.02+`), matching the projection marker already in
the detail page — one mark, one meaning. The two callers must never describe the same roster
differently again, which is the entire reason the module exists rather than two copies of a
`join('·')`.

#### The staleness problem — one capture is not enough

**This is the most consequential way the live estimate can be quietly wrong**, and it is not a bug
in the scoring — it is a property of when the roster was read.

DraftKings conceals a player until *that player's* game kicks off. So a capture taken at 1pm
legitimately hides the entire late slate: those slots carry no identity and contribute nothing.
**That is honest at 1pm and wrong at 5pm.** By then those games have started, DraftKings would now
reveal the players, and the only reason they are still missing is that nobody re-captured. Every one
of them is scoring points the estimate excludes, so the totals are silently *low* — and low in a way
that looks like a normal quiet afternoon.

> The UI used to call these slots **"to play"**, which made exactly that misreading the default.
> They now read **"N unknown"** with a trailing `+` on the total —
> [above](#-pending-and-concealed-have-identical-arithmetic-and-opposite-meanings).

Measured on the real capture: **14 of 16 games had started while 30 roster spots were still
concealed.**

**The test is precise, not a heuristic.** A slot is concealed at capture time `T` exactly when its
player's game starts after `T`. Therefore a re-capture reveals more **iff** some game kicked off
after `T` and has since started — which is what `assessCaptureStaleness` computes. It leans on the
same property that makes revealed data trustworthy in the first place: concealment tracks kickoff
exactly ([Phase 2](#capturing-the-rosters-phase-2)).

That precision is what keeps it quiet in the **lookalike** case: right after a 1pm capture, the
early games have started and the late-slate players are concealed — but no game has kicked off
*since* the capture, so there is nothing to re-capture yet and no warning is shown.

When it does fire, **both** `/live` and `/live/[matchupId]` say **"These totals are low — re-sync to
fix"**, naming how many games have kicked off since the capture and how many roster spots are still
unknown.

> **The detail page got that banner late, and the scoping is deliberate.** `/live` has carried it
> since the feature shipped, but the matchup page is where people actually sit during a game and it
> was the one rendering a quietly low number with nothing to explain it. It counts **this
> matchup's** concealed slots (a week-wide count would cry wolf on a matchup whose players are all
> accounted for) and judges them against **this matchup's** capture time, not the week's newest:
> concealment is a property of when *these two rosters* were read, so comparing them to somebody
> else's later capture would under-warn. "Games started since" stays week-wide, because that is a
> property of the capture rather than of one roster.

> **Operationally: sync again after the last kickoff of the day**, or the late slate scores zero.
> See [`RUNBOOK.md`](RUNBOOK.md#roster-capture--what-feeds-live). With **Live Sync** running, the
> extension now does this for you — [below](#keeping-the-capture-fresh-without-asking-anyone).

##### Keeping the capture fresh without asking anyone

The rule above is correct and nobody should have to remember it. Since extension **v1.5.0** the
Live Sync loop refreshes rosters on its own — but *conditionally*, and the condition is the whole
design, so it is worth stating why the obvious alternative is wrong.

**Polling scores is free. Polling rosters is not.** The leaderboard is **one** request, and
`scores` upserts on `(ownerSeasonId, week)`, so re-reading it every few minutes costs one HTTP call
and zero new rows. Rosters are the exact opposite on both axes: DraftKings has **no bulk roster
endpoint** ([`DRAFTKINGS.md` §11](DRAFTKINGS.md#11-endpoint-inventory--what-is-public-and-what-needs-auth)),
so one refresh is **one credentialed request per entry** — 32 of them — and `lineup_snapshots` is
**append-only**, so every refresh is 32 more rows kept forever. Refreshing on every poll across a
Sunday is on the order of **4,000 requests against the commissioner's own DraftKings account** and
roughly **250 MB a season** of near-identical snapshots. Measured: ~2.2 KB per entry per capture,
so a 32-owner capture is ~71 KB of raw payload plus ~37 KB of snapshot rows.

**And it would buy nothing**, because a roster only changes when DraftKings *reveals* someone, and
that happens at a kickoff. The conditional version does ~6–8 refreshes a week — roughly one per
kickoff wave, landing within one poll of each — and is **exactly as fresh**.

So the extension asks first. `GET /api/live-status?season=<id>&week=<n>`
(`src/app/api/live-status/route.ts`, bearer `INGEST_TOKEN`, CORS mirroring `/api/current-week`)
runs the same read path as `/live` and answers `shouldRecapture` with a human `reason`. It
introduces **no new predicate**: it calls the already-tested `assessCaptureStaleness` above. It
adds exactly one case that staleness cannot express — **a week with matchups but no capture at
all**, where there is no `capturedAt` to compare kickoffs against, so staleness correctly returns
false and the extension correctly wants to capture anyway. Contract:
[`DRAFTKINGS.md` §14](DRAFTKINGS.md#14-the-capture-staleness-endpoint-implemented).

> **The final poll is unconditional.** When DraftKings reports the contest complete, the extension
> refreshes rosters whether or not the app asked for it. That is the one capture where **every**
> player is revealed and DraftKings' own per-player numbers are **final** — which is precisely what
> the [drift audit](#does-the-estimate-agree-with-draftkings--the-drift-audit) reconciles against.
> A mid-game capture would compare a half-finished DraftKings number against a finished one of ours
> and report drift that does not exist.

**The roster half is best-effort, end to end.** It must never stop the score loop, never stop the
poll timer, and never cast doubt on a score sync that already succeeded — so it reports into its
own **Rosters:** line in the popup, separate from the score line. A roster problem is a roster
problem. See [`../extension/README.md`](../extension/README.md#3-live-sync--optional--keep-draftkings-own-totals-fresh).

#### Minutes remaining — how much football is left

A score on its own does not describe a live matchup. **40 points with 300 minutes left is a
completely different position from 40 points with 12**, and the page had no way to say which one
you were looking at.

ESPN's `status.period` and `status.displayClock` are now carried through `extractGame`
(`ExtractedGame.period` / `.displayClock`) into `LiveStatIndex.teamState`, which is what makes the
remaining time computable per team, and therefore per roster slot:

```text
minutesLeftInGame = (4 − period) × 15 + minutes left in the current quarter
```

Three rules are worth knowing, because each one encodes a judgement:

- **Overtime clamps to 0.** It is extra football beyond the 60 this metric is denominated in;
  counting it negative would make a lineup total misleading.
- **A missing clock mid-game means the quarter is over** (halftime, or between quarters), so only
  the whole quarters ahead are counted.
- **A concealed slot counts as a full 60.** DraftKings conceals a player *exactly* until their game
  kicks off, so a concealed slot at capture time had a whole game ahead of it. That inference is
  only as fresh as the capture — which is precisely what
  [staleness detection](#the-staleness-problem--one-capture-is-not-enough) flags.

Slots we cannot place at all are counted as `unknownSlots` and **excluded** from `minutesLeft`
rather than assumed — the same "never invent a number" rule as the [five slot
states](#the-five-slot-states--the-load-bearing-concept).

> **`formatMinutes` renders `"223m"`, not `"223 min"`** (changed in `e4c2984`; two callers). It
> sits in a phone-width meta line beside two other clauses — `223m left · 7 playing · 2 unknown` —
> and those four characters are the difference between one line and two.
>
> **The lesson behind that is worth more than the format.** That line was `truncate`, and the
> longer wording clipped to `…2 unkn…` at 390px — losing precisely the clause that had just been
> added to say the total below is a floor. **Nothing failed:** the tests passed, the previous
> wording had fitted, and the fix quietly defeated itself. It was caught only by screenshotting at
> **390×844**. A correctness fix that lands in a fixed-width line is not done until it has been
> *seen* at phone width.

> **This is our computation, not DraftKings' PMR.** DK shows its own "Points Minutes Remaining",
> and its `maxTimeRemaining: 540` (9 slots × 60) confirms the same model. One captured sample
> looked like a *different* rule — Mario Williams reading 60 with his game at "15:00 3rd", where
> the formula gives 30 — but his record carried `eTag: "1"` against another player's `137`/`193`.
> DraftKings only refreshes a player's row when something changes, and he had recorded nothing all
> game, so that 60 was **stale data, not a different rule**. Ours is derived from ESPN's clock, so
> it is the fresher number and it keeps moving between captures.

#### Projections + win probability — DraftKings' own formula

**The projection formula is DraftKings', reverse-engineered exactly — not an invention.** DK's
roster payload carries both a `pregameProjection` and a `realTimeProjection`, and the relationship
between them was pinned from three captured samples, matching to **nine decimal places**:

```text
projected = score + pregameProjection × (minutesRemaining / 60)
```

| Player | Banked | Pregame | Minutes left | Computed | DraftKings |
| ------ | ------ | ------- | ------------ | -------- | ---------- |
| Trammell | 1.50 | 14.6667 | 34.35 | 9.896667 | 9.896667 |
| Trammell | 3.80 | 14.6667 | 30.00 | 11.133333 | 11.133333 |
| Williams | 0.00 | 14.6667 | 60.00 | 14.666667 | 14.666667 |

In words: **a player is expected to keep earning at their pregame rate for whatever game time is
left.** Those three cases are pinned in `src/lib/live/projection.test.ts`, so if DraftKings ever
changes how it projects, the tests fail rather than the page quietly drifting.

**Why the pregame number is captured and the live one is not.** `dkProjection` on
`LineupSlotInput` holds DK's *pregame* projection, stored at capture time because it only exists
while the contest is live ([`DRAFTKINGS.md` §12](DRAFTKINGS.md#12-the-roster-ingest-endpoint-implemented)).
The live figure is **recomputed** from ESPN's clock on every render rather than stored, so it moves
with no machine on — the same property that makes the whole live estimate work.

A slot whose `dkProjection` is `null` — a concealed player — contributes **what it has banked and
nothing more**, and is counted in `unprojectedSlots`. We report what a player has; we do not invent
what they will get.

> ✅ **FIXED in `0b2f686`.** A snapshot captured *before* `dkProjection` existed has no such key —
> `undefined`, not `null` — and `=== null` let it through, projecting to **`NaN`** which propagated
> to the team total, the win probability ("NaN%") and `/live`'s closeness sort. Fixed at the READ
> BOUNDARY: `hydrateStoredSlot` / `hydrateStoredSlots` in `src/lib/lineups/normalize.ts` normalize
> stored jsonb into a well-formed slot, and both query modules use them. `projection.ts` also
> switched to `== null` so it no longer trusts its caller. Three regression tests pin the exact
> shape that was in the database. **The lesson generalises: `slots` is jsonb, so ANY field added
> later is `undefined` on older rows — hydrate on read, never cast.**

##### Win probability is a MODEL, not a measurement

`winProbability(homeProjected, awayProjected, minutesLeftTotal)` runs a normal CDF over the
projected margin, with a standard deviation that **shrinks as the clock runs down** — with a full
slate ahead almost anything can happen; at zero minutes the margin *is* the result.

The one number that makes it a model rather than a fact is isolated deliberately:

```ts
// src/lib/live/projection.ts
const LINEUP_SD_FULL_SLATE = 40;
```

That is a **rough industry figure** for a Classic NFL lineup, not something measured from this
league. The margin between two independent lineups therefore has sd ≈ 40 × √2 ≈ 57 with a full
slate ahead. It is a single tunable constant on purpose: **once a season of real results exists,
fit it and the whole model improves without touching anything else.**

Two display rules follow from being a model:

- **It must be labelled an estimate wherever it appears.** It sits next to a score that is itself
  already an estimate; presenting a modelled probability as a measurement would compound that.
- **It never renders 0% or 100% mid-game.** `formatWinProbability` clamps to 1–99 while any time
  remains, and only switches to `Won` / `Lost` once `settled` is true (no minutes left). A live
  page claiming certainty it does not have is worse than no number.

Win probability is also only computed when **both** lineups are captured — a probability against an
unknown roster is not a probability.

#### Caching, and the one thing not to do

`getLiveStatsForWeek` wraps the whole ESPN fan-out in `unstable_cache`
(`LIVE_INDEX_REVALIDATE_SECONDS = 30`, tagged with `liveTag()`), so **one warm entry serves every
viewer** — 32 owners refreshing is not 32× the upstream traffic, and Vercel's Data Cache is shared
across instances. The cache key includes the event ids, so a schedule correction produces a new
entry rather than serving a stale slate. `cacheComponents` is not enabled in `next.config.ts`, so
`use cache` is unavailable and `unstable_cache` is the correct tool.

The index stores **stat lines, not points**. The cached payload stays small, and a scoring-rule fix
takes effect immediately instead of waiting out a cache TTL.

The fan-out runs at **concurrency 6** with `Promise.allSettled` semantics: one failed game degrades
to "15 of 16 loaded" — surfaced in the UI — rather than throwing the page. Players in a game that
did not load become `unresolved`, never 0.

##### Three caches are stacked, and they add up

A number on `/live` can be up to about a minute behind the field, and that is by design rather than
by accident. Measured in production during live play: **~21–31s of lag, then it converges.**

| Layer | Window | Where |
| ----- | ------ | ----- |
| ESPN summary, per game (Data Cache) | `BOXSCORE_TTL_SECONDS` — `pre` 300s · **`in` 45s** · `post` 86,400s | `src/lib/dfs/sources/espn-boxscore.ts` |
| The assembled week index (`unstable_cache`) | `LIVE_INDEX_REVALIDATE_SECONDS = 30` | `src/lib/live/stats.ts` |
| The page itself (`router.refresh()`) | `REFRESH_MS = 30_000`, paused while the tab is hidden | `src/app/live/live-refresh.tsx` |

Each layer is individually justified — one warm ESPN entry serves every viewer, a finished game is
cached for a day, a hidden tab costs nothing — but **do not reason about any of them in isolation
when someone reports "the app is ahead of the site"**. A capture busts the index tag; nothing busts
the per-game Data Cache early.

##### A dropped boxscore is retried, not painted as `?`

A failed summary does **not** degrade into one missing stat: `buildLiveStatIndex` skips the whole
game, so every player in it loses their `teamState` and renders `unresolved` — **up to nine rosters
from a single dropped request**. And it is *sticky*, because the assembled index is memoised for
30s, so the partial result is served to everyone until that window rolls. The reported symptom was
exactly that: *"question marks on random players, need to keep re-loading until it shows."* **The
reload was the retry.**

`fetchGameSummary` now makes **3 attempts** with **150ms / 400ms** backoff and a **6s timeout**
where there was none at all. Backoff is short on purpose — these routes budget `maxDuration = 30`
for a 16-game slate, so a patient retry would trade one broken render for a timed-out one. **404
and 403 are not retried**: a wrong event id is wrong every time, and 403 is the User-Agent trap
documented at the top of that file, not a blip.

> 🛑 **The `AbortSignal` is load-bearing beyond the timeout, and without it the retry is a NO-OP
> inside a render.** This was written once without it, on the strength of a docs line, and silently
> did nothing — every test still passed, because tests stub `fetch` below Next's layer.
> From `node_modules/next/dist/server/lib/dedupe-fetch.js`:
>
> - It memoises by `(url, method, headers, mode, redirect, credentials, referrer, referrerPolicy,
>   integrity)` for the whole render pass, and pushes the entry **before the promise settles**. An
>   identical retry therefore re-awaits the **same rejected promise** and never reaches the network.
>   A non-OK response is worse: it *resolved*, so the retry gets a clone of the same 503.
> - **`cache` and `next` are deliberately excluded from that key**, so `cache: 'no-store'` on the
>   retry would **not** bust it. Only a signal (or a differing header) does.
> - That same file **opts out of deduping entirely when a signal is present** — the documented
>   escape hatch, and exactly what a retry needs.
>
> Losing dedupe costs nothing here: it only helps when one URL is fetched twice in a render, and
> `buildLiveStatIndex` fetches each event exactly once. **The Data Cache is unaffected** —
> `patch-fetch.js` passes `next.revalidate` through and only drops the signal when background-
> revalidating a stale entry — so a finished game is still cached for a day. The test asserts the
> signal is present on every attempt, so removing it fails loudly instead of quietly disabling the
> retry.

> **Do NOT add `export const dynamic = 'force-dynamic'` to either `/live` route.** Every other data
> page in this repo sets it, so copying the idiom is the obvious mistake — and here it is actively
> harmful: `force-dynamic` implies `fetchCache = 'force-no-store'`, which silently disables the Data
> Cache for **every** fetch on the route (bundled Next 16.2.9 docs,
> `caching-without-cache-components.md:97-99`). The sharing above would collapse into one ESPN
> fan-out per viewer. Both routes are already dynamic because they await `searchParams`/`params`.
> Both set `runtime = 'nodejs'` and `maxDuration = 30` (a cold render fans out to ~16 summaries).

#### The routes

- **`/live`** — the week's matchups as cards; the whole card is a `<Link>` to the detail page.
  Shows `N/M games loaded`, "lineups as of …", and names any owner with **no capture** rather than
  showing them as `0.00`. Each side carries its roster summary —
  [`rosterSummaryParts`](#-pending-and-concealed-have-identical-arithmetic-and-opposite-meanings),
  e.g. `7 playing · 2 unknown` — and a **trailing `+`** on the total when that total is a floor.
  `?season=` and `?week=` override the defaults.
  > **The "not captured" notice names at most `MAX_NAMED_MISSING = 6` owners, then counts the
  > rest** ("… and 20 more"). Spelling out 26 names filled an entire phone screen and pushed every
  > matchup below it, to repeat something each card already says on its own row. **The count is the
  > alarming part; the names are a courtesy.** The notice itself is never suppressed — an owner
  > with no capture is still never an owner with `0.00`. The card grid is two-up from `md`.
  > **Cards are ordered by CLOSENESS, not by matchup id** — by each matchup's distance from a coin
  > flip (`|winProbability − 0.5|`), so a dead heat sorts first and a decided blowout last. On a
  > Sunday afternoon the interesting cards are the ones that could still go either way, and burying
  > them below settled ones wastes the top of the page. **Matchups where either side has no capture
  > sort last** — there is nothing to be close about.
- **`/live/[matchupId]`** — the head-to-head: both rosters mirrored around a centre slot rail,
  each row carrying the player's points, a plain-English stat line, and their game state (or their
  opponent and kickoff time if it hasn't started).
  > **The mirrored rail is `sm` and up only, and that is not a styling preference.** Three columns
  > at 390px leave each player roughly **70px** once the logo and the points column are subtracted
  > — enough for `J. Jeffe…` and nothing else, with the stat line dropped entirely. Below `sm` the
  > same data renders **stacked**: one block per roster slot, both players full width beneath it,
  > each keeping its name, stat line and game state.
  > **Two layouts, ONE data source** — everything is computed once and rendered twice. Do not let
  > the variants drift into computing different things.
  >
  > 🛑 **Stacking removes the left/right cue the mirror gives you for free, and ONE cue is not
  > enough.** The first version marked ownership with a 4×14px chip, dim grey against green. Two
  > owners routinely start the same player — in one week-2 matchup **both sides started Carson
  > Wentz *and* Bijan Robinson** — so a slot rendered as two identical rows: same name, same stat
  > line, same points, and no usable way to tell whether it was a duplicate render or both rosters.
  > There are now **three reinforcing cues**: a full-height coloured left border, a background tint
  > on the home side, and **the owner's name on the row**. The name is the one that settles it; the
  > others make it fast. Colour alone was never enough — not for the ~8% of men with a red-green
  > deficiency, and not for anyone glancing at a phone in daylight.
  >
  > Each side's header carries its **minutes left**
  and, under the score, its **projected final**; the centre shows the **win-probability estimate**.
  The **largest single-slot gap** is highlighted as the difference-maker (≥ 5 points, and only where
  both sides are actually scored — a gap against an unknown is not a gap). It resolves the matchup's
  week and then goes through the **same** `getLiveWeekData` + `getLiveStatsForWeek` path as the
  list, so clicking in costs **no extra ESPN traffic** however many people do it.
  - **Navigation is `matchup-nav.tsx`** (renamed from `matchup-switcher.tsx`): prev/next are real
    `<Link>`s that wrap at both ends, each showing **both owners with team logos, their running
    scores and the minutes left** — enough to tell what you are stepping into. The dropdown carries
    the scores as text, since a native `<select>` cannot render logos.
    > **Below `sm` the rich cards collapse to two 44px arrows flanking the dropdown.** Two stacked
    > preview cards push the scoreboard — the one thing you opened the page for — below the fold,
    > and the dropdown already names every matchup with both owners and both scores, so nothing is
    > lost but height. The arrows are sized to a **tap target**, not to their icon.
    >
    > ⚠️ **`block` on the dropdown's `<label>` is load-bearing.** A `<label>` is inline by default,
    > so `w-full` on it did nothing and the `<select>` fell back to its **intrinsic** width — which
    > a native select takes from its **longest option** ("Chris deMartino 141.20 — 138.40 Josh
    > Lehr"). That pushed the whole page wider than a phone viewport and scrolled the header off
    > screen. Verified with Chrome DevTools device emulation at 360 / 390 / 768px:
    > `document.documentElement.scrollWidth` equals the viewport width and no element exceeds it.
  - **The page deliberately has no `PageHeader`.** The matchup was named three more times below (nav
    bar, dropdown, scoreboard) and the week twice, and removing the duplication is what pulls the
    actual scores back above the fold. The "live estimate, DraftKings is official" line moved to the
    footnote beside `N/M games loaded`.

Exhibition weeks render like any other week — `getLiveWeekData` derives `isExhibition` from the week
and applies it as a **required** filter ([§2](#2-the-three-week-namespaces)). `/live` opens on the
most recently **captured** week rather than `seasons.currentWeek`, because a capture is a deliberate
act aimed at a specific week; during preseason the season pointer still says week 1 while the only
rosters that exist are exhibition ones, and opening on an empty week looks like a broken feature.

**`/live` cannot leak an information advantage.** A concealed slot has no identity *stored*, so the
page can only ever show what DraftKings had already unlocked to everyone.

**A capture busts the stat index.** `POST /api/ingest/lineups` calls
`revalidateTag(liveTag(seasonId, week), 'max')` after a successful ingest — the only caller of
`liveTag`. A capture is the one moment we *know* the roster changed, and it usually happens because
games are underway, so newly-revealed players are scored against current stats rather than an index
cached up to 30s ago. (The snapshots themselves are read uncached, so the new roster would appear
regardless; this is about the stat side.)

> ⚠️ **Next 16 changed `revalidateTag`'s signature: the cache-life profile is a REQUIRED second
> argument.** `'max'` means stale-while-revalidate. The bundled
> `caching-without-cache-components.md` guide still shows the one-argument form, which does **not**
> typecheck — `node_modules/next/cache.d.ts` is the authority. See
> [`NEXTJS16_NOTES.md` §5](NEXTJS16_NOTES.md#5-data-fetching--caching-cachecomponents-off).

### Does the estimate agree with DraftKings? — the drift audit

> **Admin → Scoring** (`/admin/scoring?season=<id>&week=<n>`,
> `src/app/admin/(panel)/scoring/page.tsx`). **Reads only.** Nothing on this page writes, and
> nothing it computes is stored.

`/live` computes DK Classic points from ESPN box scores. **If one of those rules were wrong,
nothing in the system would ever say so** — the page would render slightly wrong numbers forever
and look completely healthy doing it. `npm run dfs:selftest`
([above](#checking-the-engine-against-something)) checks the engine against Sleeper, which is a
different scoring system reconciled through a known rule delta. This checks it against
**DraftKings itself**, which is the authority the estimate is trying to imitate.

**It costs nothing to run, because the data was already collected.** Every roster capture stores
DraftKings' own per-player score *and* DraftKings' own stat line (`dkScore` / `dkStats` on
`LineupSlotInput` — see [Phase 2](#capturing-the-rosters-phase-2) for why those were captured in
the first place). That is DK's unmediated account of the same game we scored from ESPN. Comparing
the two is arithmetic over rows already in the database: **no new collection, no new table, no
background job.** It is computed on demand precisely so there is no third copy to keep in sync.

#### The verdicts, and why they are separate

The point of the audit is not "the numbers differ" — a total-only comparison would say that and
send someone to the wrong file. Each verdict names **whose problem it is**:

| Verdict | What it means | Where the fix lives |
| ------- | ------------- | ------------------- |
| `agree` | Within `RECONCILE_TOLERANCE` (0.01 — DraftKings publishes 2dp). | Nowhere. |
| `ruleDrift` | The two sources agree on **what happened** and disagree on **what it is worth**. | **Ours.** `src/lib/dfs/rules.ts`. The per-stat breakdown names the component. |
| `statDrift` | They disagree on what happened — ESPN says 7 receptions, DK says 8. | **Nobody's.** Recorded so it is never mistaken for the row above. |
| `unmapped` | DraftKings paid for a stat key the audit's `DK_TO_OUR_KEY` map does not know, so the gap **cannot be attributed**. | The **map**, in `src/lib/live/reconcile.ts` — *not* the scoring rules. |
| `unmatched` | We produced no score at all: the ESPN `(name, teamKey)` join failed for that player. | The identity join. |
| `notComparable` | Skipped — see the trap below. | Nowhere; counted so the sample size is honest. |

**`unmapped` exists to stop a false alarm.** If an unknown DK key were quietly folded into the
totals, an audit that has simply never seen a blocked kick would surface as a *phantom rule bug*
and send someone hunting a defect in `rules.ts` that does not exist. Naming it separately is the
difference between "our rules are wrong" and "we have not taught the audit about this stat yet".
`needsAttention` is true for `ruleDrift`, `unmapped` and `unmatched` — the three that mean
something is genuinely unresolved. `statDrift` deliberately does **not** raise it.

**The key map was built from real captured payloads, not from documentation.** Keys observed so
far, the vocabulary now confirmed across a full regular-season slate (2026 week 1): `PaYds PaTD INT
RuYds RuTD REC RecYds RecTD FUM SACK DFR DefTD BLK 2PT Targets`, the three yardage-bonus keys
`300+Pass` `100+Rush` `100+Rec`, and DraftKings' points-allowed tier rows (`0 PA`, `1-6 PA`,
`7-13 PA`, `14-20 PA`, …). Five subtleties are worth knowing before extending it:

- **`INT` is two different stats sharing one key** — *thrown* for a quarterback, *caught* for a
  defense. It is resolved by the slot (`resolveOurKey(dkKey, isDst)`), because DraftKings does not
  disambiguate it.
- **Yardage bonuses are compared on POINTS only.** DK bills each bonus as its own stat row with
  value `1` — "1 × `100+Rec`, 3 pts" — while our engine emits a `bonus.*` component carrying the
  **yardage** that earned it (182). Both mean the same thing and the two numbers will never agree,
  so `BONUS_OUR_KEYS` compares the points and ignores the value. Until the three keys were mapped
  at all, a single 100-yard receiver produced **two** phantom findings — DK's row read as
  `unmapped`, *and* our matching component read as something DraftKings never paid for — both
  blaming rules that were correct.
- **Points-allowed rows are compared on POINTS, never on value.** DK's row is a *flag* — value `1`,
  named for the range it fell in — while ours records the actual points conceded. Comparing the
  values would report a difference on every DST in the league.
- **DK ships the whole points-allowed LADDER, not just the tier that was awarded.** A defense that
  conceded 13 arrives as `0 PA=0(0) 1-6 PA=0(0) 7-13 PA=1(4)`; only the row with value `1` is the
  award, the rest are "not this tier" markers. `isUnawardedTierRow` skips any points-allowed row
  with value 0 *and* points 0. Without it, every DST in 2026 week 1 reported two or three phantom
  differences against our single `pointsAllowed` component.
- **`Targets` is ignored on purpose.** DK lists it at 0 points because DK Classic does not pay for
  targets. Skipping it keeps the diff about scoring.

A stat **we** scored that DraftKings never listed is also reported. That case is invisible to a
loop that only walks DK's rows — and bonuses were exactly it, until they were mapped above.

#### The trap: `dkScore` is a snapshot, ours is live

**This is the one thing to understand before reading a result.** `dkScore` is whatever DraftKings
said at the moment the roster was **captured**; our number is recomputed from current stats on
**every render**. Comparing a mid-game capture against a finished game measures the gap between
two moments in time, not an error — and would report drift on very nearly every player.

So a slot is judged only when **its game is final** *and* **the capture postdates that game
ending**. Everything else is `notComparable`, and the page reports how many were skipped so a
reassuring "0 rule bugs" over a sample of nine is not mistaken for a clean bill of health.

```ts
// src/lib/live/reconcile-query.ts
const ASSUMED_GAME_LENGTH_MS = 4 * 60 * 60 * 1000;
```

**That constant is the one approximation in the whole feature**, and it exists because neither ESPN
nor our own schedule records when a game **ENDED** — only when it started and whether it is final
now. Four hours is deliberately generous (an NFL game averages about 3h05 including overtime), so
it errs toward declaring a slot *not* comparable. That is the safe direction: the cost of being
wrong is a slot silently skipped, whereas the other direction **invents drift** by comparing a
half-finished DraftKings number against a finished one of ours. It is also why
[the final Live Sync poll always re-captures](#keeping-the-capture-fresh-without-asking-anyone) —
a post-contest capture makes every slot comparable at once.

#### What it says today

Run against **season 1, week 102** (preseason): **54 slots, 54 agree, 0 rule drift, 0 unmapped,
0 unmatched, 0 skipped, max |delta| 0.00 across 6 owners.** That reproduces, automatically and
repeatably, the hand-done reconciliation that Phase 5 closed on — which is the entire point.

Run against **season 1, week 1** (2026, a full regular-season Sunday): **288 slots, 288 agree,
0 rule drift, 0 stat drift, 0 unmapped, 0 unmatched, 0 skipped, max |delta| 0.00 across 32
owners.** That is the check the preseason run could not be: 32 owners, the whole slate, 11 distinct
defenses, the yardage bonuses, and DK's points-allowed ladder — **and it found no rule wrong.** It
did find two classes of *audit* bug, both now fixed and both of which blamed correct rules: the
[unmapped bonus keys and the unawarded tier rows](#the-verdicts-and-why-they-are-separate).
Getting to a comparable week at all needed
[`scripts/repair-lineup-identities.ts`](#when-identity-fails-the-whole-week-fails) first — the
capture had stored no teams, so every slot was `unmatched`.

#### Two things we deliberately did NOT do

Both were considered and rejected. They are recorded here so nobody re-litigates them from scratch.

- **Making DraftKings' official totals the headline number on `/live`.** They are more
  authoritative — and they are also **frozen between polls**, which means the page would sit still
  whenever the commissioner's machine is asleep. `/live` working *with every machine switched off*
  is the entire reason the roster-capture architecture exists; replacing the estimate with a
  periodically-refreshed official number gives that away to fix a discrepancy measured at 0.00.
  DraftKings stays the authority for `scores`; the estimate stays the thing that moves.
- **Truing up per-player scores on every poll.** Doing that would mean re-engineering the capture
  write path from **append-only to update-in-place**, plus recording per-game state on each slot so
  a half-finished DK number never overwrites a finished one — a large change to the most
  safety-critical write path in the live feature, to correct a difference that measures **0.00**.
  This audit is how we would find out if that ever stops being true. **Only then** is it worth
  reopening.

### Phase log

All five phases are **done**. Kept as the design record — each row says what the phase settled.
Genuine remaining gaps are listed [below the table](#remaining-gaps).

| Phase | Scope | State |
| ----- | ----- | ----- |
| 0 | Prove which DK endpoints are reachable; add the extension's roster-endpoint diagnosis | **Done** — see [`DRAFTKINGS.md` §11](DRAFTKINGS.md#11-endpoint-inventory--what-is-public-and-what-needs-auth) and [`../extension/README.md`](../extension/README.md) |
| 1 | Pure scoring engine + ESPN adapter + self-test | **Done** — the table above |
| 2 | Roster storage + server-side ingest (API, admin paste, normalizer, the no-write guard) | **Done** — [above](#capturing-the-rosters-phase-2). Migration 0010 is applied. |
| 3 | Capturing all rosters from the extension in one click | **Done** — and folded into the single **Sync** button at v1.3.0: leaderboard → entry keys → one authenticated roster request per entry (concurrency 4), POSTed raw as `rawLineups`. See [`../extension/README.md`](../extension/README.md#lineups-captured-automatically-by-sync). |
| 4 | Matching captured DK players to ESPN athletes at scale | **Done** — `playerStatKey(name, teamKey)` in `src/lib/live/stats.ts`, matching on `(normalizeName, teamKey)`. Validated 172/172 against a live slate's DK draftables; **the team key is mandatory** (see above). No separate `identity.ts` was needed: the key *is* the index key. |
| 5 | A `/live` page, and reconciling the estimate against DK's final number | **Done** — [`/live` and `/live/[matchupId]`](#rendering-it--live-phases-45). Reconciled against DraftKings' own numbers on a real capture at **max &#124;delta&#124; 0.00** across 6 owners, 0 unresolved, 16/16 games loaded. That reconciliation is no longer a one-off: it is [Admin → Scoring](#does-the-estimate-agree-with-draftkings--the-drift-audit), and it reproduces the same verdict on demand. |

#### Remaining gaps

Real, specific, and none of them blocking:

- **✅ CLOSED — the 0.00 reconciliation is no longer preseason-only.** It used to rest on a
  **6-owner preseason contest**, which proved the wiring and not the engine. **2026 week 1** ran the
  same audit over a full regular-season Sunday: **288 slots, 32 owners, 288 agree, max |delta|
  0.00** ([above](#what-it-says-today)). The engine is now checked against DraftKings itself at
  slate scale, not just wired correctly.
- **✅ CLOSED — `pointsAllowedMode: 'raw'` is SETTLED, against the divergence case itself.** 2026
  week 1 contained a game where the two modes give different answers — **7 of the 20 points
  Atlanta's DST conceded were scored by Pittsburgh's defense against Atlanta's own offense** — and
  DraftKings paid the **raw** tier (`14-20 PA`, +1), not the carve-out tier (`7-13 PA`, +4). All 32
  DST slots across 11 distinct rostered defenses matched to the cent. No residual caveat: this was
  measured, not inferred. Details in
  [What ships today](#what-ships-today--the-engine-phase-1) and in the `PointsAllowedMode` doc
  comment in `src/lib/dfs/rules.ts`.
- **The drift audit's `ASSUMED_GAME_LENGTH_MS = 4h` is an approximation**, because nothing we have
  records when a game *ended*. It errs toward skipping a slot rather than inventing drift, so its
  failure mode is a smaller sample, not a wrong answer — but a slot skipped is a slot unchecked.
  Read the "N of M compared" line, not just the verdict counts.
- **`DK_TO_OUR_KEY` is built from observed payloads, not documentation.** A stat DraftKings has
  never paid for in a captured week is simply absent, and shows up as `unmapped` the first time it
  appears. That is the designed behaviour, not a bug — but it means the audit's coverage grows with
  the seasons rather than being complete on day one. 2026 week 1 is the clearest example so far: the
  first real slate added the three yardage-bonus keys and the points-allowed *ladder*, neither of
  which a preseason contest had ever produced.
- ✅ **CLOSED — `src/app/api/live-status/route.ts` and `src/app/admin/(panel)/scoring/page.tsx` are
  inside `no-write.test.ts`'s scan.** They used to sit outside it with only a header comment as
  their proof; both are now in `guardedRouteDirs` alongside `src/app/live`, and each route dir is
  asserted individually so a typo'd path cannot silently scan nothing. The residual, minor: route
  dirs are **enumerated**, not discovered, so a new live surface must be added by hand.
- **No capture has ever carried `dkProjection`**, so the projected finals and the win-probability
  line have only ever run on unit-test fixtures. All 216 stored slots across the four week-102
  captures have it `null`: the mid-slate captures predate the field, and **DraftKings strips its
  projection once the game is over** — the post-game raw payload carries
  `"projection": { "valueIcon": "" }`. That is structural rather than accidental: the capture that
  is ideal for the drift audit (post-game, everything revealed and final) is exactly the one that
  cannot carry a projection. A **mid-game** capture on a real slate is what closes it.
- ✅ **CLOSED — a full 16-game slate has now rendered in production.** 2026 week 2 served
  `16/16 games loaded` live, and the fan-out now also carries a **6s per-request timeout** so one
  hung socket can no longer hold a wave until `maxDuration` kills the render. Measured cache lag
  during live play: **~21–31s**, converging. If a cold Sunday render ever does time out, the
  concurrency-6 fan-out is still the first thing to look at.
- **A pasted capture is only enriched if someone fills in the draft group id.** Admin → Lineups has
  the field and passes it through, but it is optional. Left blank, the capture is usually still
  **scorable** — the team comes from DK's own `competition` block — but nothing supplies a player's
  `position`, and a payload that carried no `competition` block would leave slots team-less. The
  form now reports that outcome directly rather than guessing from whether enrichment ran.
- **2-pt conversions, safeties and blocked kicks stay best-effort**, by nature of the source ([exact vs best-effort](#exact-vs-best-effort)).
- **`LINEUP_SD_FULL_SLATE = 40` has never been fitted** — it is a rough industry figure, so win
  probability is calibrated by assumption, not by evidence. One season of real weekly results is
  enough to fit it; it is isolated as one constant precisely so that day is a one-line change. See
  [Projections + win probability](#projections--win-probability--draftkings-own-formula).
- **The projection assumes a constant scoring rate.** DraftKings' own formula does too, which is why
  ours reproduces theirs exactly — but it means a player who is being blown out, benched, or
  injured still projects at their pregame rate until the clock says otherwise.

**The DraftKings roster endpoint is now known** —
`scores/v2/entries/{draftGroupId}/{entryKey}?format=json&embed=roster`, credentialed, one request
per entry because DK has no bulk roster endpoint. `lineup_capture_runs.sourceUrlTemplate` records it
on every capture so the answer lives in the database and not only in a doc: the extension sends its
template automatically, and the admin paste form has a **Source URL** field for the same purpose.
See [`DRAFTKINGS.md` §11](DRAFTKINGS.md#11-endpoint-inventory--what-is-public-and-what-needs-auth).
