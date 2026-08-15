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
  season importers and the Admin → Preseason paste fallback.

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
> derivation runs for settled weeks only.

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
  missing or unrecognized status.
- `gameIsFinal(game, now)` — falls back to "kicked off at least `FINAL_FALLBACK_MS` (6 hours)
  ago" only when the status is unknown.
- `weekIsFinal(games, now)` — at least one game, and all of them final. **A week with no games
  is NOT final**, or a week whose NFL schedule has not been pulled yet would read as final and
  start deriving forfeits for owners who never had a game to miss.

`now` is always passed in — the module keeps no clock of its own, so tests are deterministic.

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

> **Status: partly built (Phases 0–3 of 5).** The scoring **engine** and its ESPN adapter ship in
> `src/lib/dfs/`; roster **capture and storage** ship in `src/lib/lineups/`, behind
> `POST /api/ingest/lineups` and Admin → Lineups; the Chrome extension (v1.2.0) captures all 32
> rosters in one click. Nothing yet matches captured players to ESPN athletes, and there is no
> `/live` page — see [what is not built yet](#what-is-not-built-yet) at the end of this section.
>
> Migration `drizzle/0010_polite_nicolaos.sql` (the two capture tables) is **applied** to production.
>
> Not to be confused with the **live-scoring remediation** (`docs/HANDOFF.md`), which was a
> different piece of work with its own Phase 0–4 numbering. That one fixed §3–§7 of *this* chain;
> this one sits outside the chain entirely.

A week's authoritative score is the DraftKings contest leaderboard, captured by the Chrome
extension from the commissioner's logged-in browser ([§4](#4-ingest-write-time)). That capture
needs a live session, so keeping the numbers moving *during* the games means leaving a machine
on all week.

The alternative being built: capture each owner's DraftKings **roster** (still authenticated, still
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
  `src/lib/lineups` and `src/lib/live` (a directory that does not exist yet is skipped) and fails if
  any of them writes to `scores`, `matchups`, `playoff_matchups`, `season_awards` or `nfl_games`, or
  calls `ingestLeaderboard` / `writeTeamScores`. **Every module in those directories is scanned —
  the list is discovered, not enumerated, so a new file is covered the moment it lands.** It also
  asserts it found something to scan, so a guard that silently checks nothing fails loudly.

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

63 unit tests cover the two pure modules (`score.test.ts`, `espn-extract.test.ts`), the latter
against two trimmed real payloads in `scripts/fixtures/` (CHI @ MIN 2025 week 1, and a 2026
preseason DET @ CIN game).

Three engine properties are load-bearing:

- **An unresolved slot is `null`, never `0`.** `scoreLineup` returns `points: null` for a roster
  slot it could not match to a stat line and reports `unresolvedCount`; the lineup total sums only
  what resolved. A matching failure must **understate**, never invent — a fabricated 0.00 is
  indistinguishable from a genuine goose egg. Any UI must surface `unresolvedCount`.
- **Rounding happens once, at the boundary.** Intermediate sums stay at full float precision;
  only the returned total is `round2`-ed. Rounding per rule drifts, and 32 owners × 9 slots
  compounds it.
- **`pointsAllowedMode` is an open question, defaulted honestly.** DraftKings has historically
  carved out points its DST was not on the field for (a pick-six thrown by *your own* offense).
  No free feed implements that, so the rule set ships `'raw'` (the opponent's final score) with
  `'exclude_scores_against_offense'` defined but unimplemented. **This is unconfirmed and must be
  settled empirically** — the signature of getting it wrong is a DST landing exactly one tier off
  in a game with a defensive or return touchdown.

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

### Capturing the rosters (Phase 2)

The engine needs to know **who each owner started**. That is the one thing only DraftKings knows and
only a logged-in browser can read, so it is captured and stored rather than fetched on demand.

| Module | Role |
| ------ | ---- |
| `src/lib/lineups/normalize.ts` | `normalizeRosterPayload(envelope, fallbackName?)` — any DK roster payload → `LineupInput[]`. Pure. |
| `src/lib/lineups/enrich.ts` | `applyDraftableIndex(lineups, index)` (pure) / `enrichLineups(lineups, draftGroupId)` — `draftableId` → `(name, teamKey, position)`. |
| `src/lib/lineups/ingest.ts` | `ingestLineups(params)` — enrichment + owner matching + the audit row + chunked snapshot upserts. |
| `src/lib/lineups/query.ts` | `getCaptureStatus(seasonId, week)` — the newest snapshot per owner, plus recent capture runs. |
| `src/lib/lineups/no-write.test.ts` | The safety invariant, enforced as a test (above). |
| `src/lib/draftkings/draftables.ts` | `fetchDraftableIndex(draftGroupId)` → `Map<draftableId, DraftableIdentity>`, sharing one raw fetch with the salary view. |
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
  `scripts/fixtures/dk-roster-entry.json` and the normalizer passed it unchanged. 30 unit tests
  cover it.
- **DraftKings' own numbers are captured but never scored from.** Each revealed slot stores
  `dkScore` (DK's points) and `dkStats` (DK's per-stat breakdown, verbatim, keyed by DK's own
  abbreviations). They exist **only at capture time** — the authenticated roster endpoint is the
  only source and it ages out with the contest — and they are the reconciliation checkpoint for the
  ESPN-derived estimate. `dkStats` is the sharp one: a matching *total* can hide two compensating
  errors, a per-stat diff cannot, which is also how `pointsAllowedMode` (above) gets settled
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
- **`draftableId` is resolved at CAPTURE time, not read time.** DK's roster payload carries no team
  abbreviation and no player position, and scoring reaches ESPN by `(normalizeName, teamKey)`, so a
  raw capture is not scorable. `enrichLineups` indexes the **public** draftables endpoint by
  `draftableId` and fills the gaps before the snapshot is written — which is the whole architecture
  in miniature: authenticate once for *who was started*, then compute all week from public data.
  It runs on capture because DK expires draftables for old draft groups; a snapshot must stand alone
  months later. Values already in DK's payload always win, the fetch never throws (an empty index
  passes lineups through untouched), and unresolved ids are **reported, never silently zeroed**.
  Note that Admin → Lineups sends no `draftGroupId`, so **a pasted capture is not enriched**.
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

### What is NOT built yet

Everything below is **planned**. Do not read the code as finished.

| Phase | Scope | State |
| ----- | ----- | ----- |
| 0 | Prove which DK endpoints are reachable; add the extension's roster-endpoint diagnosis | **Done** — see [`DRAFTKINGS.md` §11](DRAFTKINGS.md#11-endpoint-inventory--what-is-public-and-what-needs-auth) and [`../extension/README.md`](../extension/README.md) |
| 1 | Pure scoring engine + ESPN adapter + self-test | **Done** — the table above |
| 2 | Roster storage + server-side ingest (API, admin paste, normalizer, the no-write guard) | **Done** — [above](#capturing-the-rosters-phase-2). Migration 0010 is applied. |
| 3 | Capturing all 32 rosters from the extension in one click | **Done** — extension v1.2.0's **Capture lineups** button: leaderboard → entry keys → one authenticated roster request per entry (concurrency 4), POSTed raw as `rawLineups`. See [`../extension/README.md`](../extension/README.md#capture-lineups-roster-capture-for-live-scoring). |
| 4 | Matching captured DK players to ESPN athletes at scale | Not built. No `src/lib/dfs/identity.ts`. On a real slate, DK → ESPN matching on `(normalizeName, teamKey)` hit 172/172 during design — **the team key is mandatory**; an initial+surname key without it collides league-wide (Bijan vs Brian Robinson, Travis vs Trevor Etienne, Josh vs Jonathan Allen). Phase 2's enrichment is what puts that team key on a snapshot in the first place. |
| 5 | A `/live` page, and reconciling the estimate against DK's final number | **In progress, undocumented.** `src/lib/live/` now exists and is being written; the no-write guard already covers it. There is still **no `/live` route**, so the `revalidatePath('/live')` in the admin action remains a forward reference — harmless, but not evidence a page exists. ⚠️ Nothing in `src/lib/live/` is described in these docs yet: it was mid-write at the last docs pass. Document it before relying on it. |

**The DraftKings roster endpoint is now known** —
`scores/v2/entries/{draftGroupId}/{entryKey}?format=json&embed=roster`, credentialed, one request
per entry because DK has no bulk roster endpoint. `lineup_capture_runs.sourceUrlTemplate` records it
on every capture so the answer lives in the database and not only in a doc: the extension sends its
template automatically, and the admin paste form has a **Source URL** field for the same purpose.
See [`DRAFTKINGS.md` §11](DRAFTKINGS.md#11-endpoint-inventory--what-is-public-and-what-needs-auth).
