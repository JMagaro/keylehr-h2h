# Runbook — running a season

The commissioner's operational guide: what to do before the season, what to do every week, and
what to check when something looks wrong. Companion docs: [`SCORING.md`](SCORING.md) explains
*why* each step matters, [`RULES.md`](RULES.md) covers the per-season settings, and
[`../extension/README.md`](../extension/README.md) is the full guide to the DK Sync extension.

## 1. Before the season

Do these once, in this order.

| # | Step | Where | Notes |
| - | ---- | ----- | ----- |
| 1 | Create the season | Admin → Settings | Name, status, `currentWeek`, **regular-season weeks**, entry fee. These are the canonical columns. |
| 2 | Set the season's rules | Admin → Settings → Rules | Tiebreakers, playoff structure, bye handling, **missed lineup**, payouts. **2026 onward uses `league_median`** — see [`RULES.md` §5](RULES.md#5-missed-lineups-missedlineup). |
| 3 | Assign all 32 owners to NFL teams | Admin → Assignments | Also set each owner's **DK entry name** — the scoring pipeline matches the leaderboard against it, exactly. |
| 4 | Sync the NFL schedule | Admin → Schedule → **Pull / refresh NFL schedule**, or `npm run schedule:pull -- --year=2026` | Writes `nfl_games` from ESPN. |
| 5 | Generate matchups | Admin → Schedule → **Generate owner matchups** (the CLI does both stages) | Derives `matchups` from `nfl_games`. Games where either team is unassigned are skipped and reported. |
| 6 | Confirm | Admin (dashboard) | The data-status checklist names anything missing: unassigned teams, owners with no DK entry name, incomplete weeks. |

Step 5 must be re-run after any late assignment change — a matchup is only created once **both**
teams belong to owners.

## 2. The weekly loop

### Order matters

> **Generate matchups before scores are ingested for a week.**

The system self-heals if you get this wrong — byes are derived from `nfl_games` at write time and
reconciled against `matchups` at read time, so a week synced before its matchups existed still
counts toward Points For and repairs itself on the next sync (see
[`SCORING.md` §5](SCORING.md#5-byes)). It is still the correct order, and getting it right means
`/admin/sync` tells you the truth the first time.

### Every week

1. **Confirm the week's matchups exist.** They should, from the pre-season pull. Re-run
   Admin → Schedule → **Generate owner matchups** if the schedule moved (flexed games, a rescheduled
   kickoff) or if an assignment changed. Idempotent.

2. **Wait for the week to finish.** Scoring only treats a week as *settled* once **every** NFL
   game that week is final **and** at least one real score has been ingested for it; until then
   no missed lineup is derived
   ([`SCORING.md` §6](SCORING.md#6-settled-weeks-the-safety-property)).

3. **Sync scores with the DK Sync extension**, ideally right after Monday night's game:
   - Log in to DraftKings, open the shared contest's `/contest/gamecenter/{contestId}`
     **Standings** tab.
   - Open the extension popup → pick the **Season**, confirm the auto-filled **Week** → click
     **Sync Week N**.
   - The **Paste manually** expander is the guaranteed fallback if the leaderboard read fails.

   > **Sync a week in one go.** A finished-but-unsynced week is safe — it is not *settled* until
   > at least one real score exists, so it simply reads as unplayed. A **half-synced** week is
   > not: it is settled, and every owner still missing a row derives as a missed lineup until the
   > rest lands. It self-heals on the next successful sync, but `/standings` and any
   > `import:awards` run in that window are wrong
   > ([`SCORING.md` §6](SCORING.md#6-settled-weeks-the-safety-property)).

4. **Check `/admin/sync`.** Every week gets a derived health:

   | Health | Meaning | Action |
   | ------ | ------- | ------ |
   | `no_schedule` | No matchups generated for the week | Run **Generate owner matchups** |
   | `upcoming` | Games not final, nothing scored | None — not played yet |
   | `live` | Games not final, partially scored | None — in progress |
   | `complete` | Games final, everyone scored, last run clean | None |
   | `partial` | Games final but some owners missing, or the last run reported unmatched entries | Re-sync; check the unmatched names against `owner_seasons.dkEntryName` |
   | `needs_sync` | Games final and **nobody** scored, or the last run failed | Re-sync |

   Each row shows **scored / expected** owners for the week (byes are excluded from "expected")
   plus the last import run. The number to eyeball is that ratio: it should read `32/32` on a
   fully-played, fully-synced regular-season week. A week that reads `0/32` **immediately after a
   successful sync** is the signature of the old bye bug — every owner was written as a bye, so
   nobody counts as scored. Re-pull the schedule and re-sync.

5. **Spot-check `/standings` and `/my-team`.** They read the same derived forfeit set, so they
   must agree. A missed lineup shows as an auto-loss on `/standings` and a
   "Missed lineup — auto-loss · FF" row on `/my-team`, with the opponent's Points Against equal
   to that week's league median (2026 rule).

### Preseason exhibition weeks

Preseason games are tracked but **never** count toward standings, seeding, playoffs, payouts, or
all-time records.

1. Admin → **Preseason**: choose the preseason week (1–3) and click **Sync & generate matchups** — this pulls that ESPN
   preseason week (`seasontype=1`) into `nfl_games` at the offset week `100 + preseasonWeek` and
   regenerates matchups in one action.
2. Score it with the extension: tick the **Preseason** checkbox. The Week input now means
   *preseason week* (1–3) and the extension POSTs the offset week (101–103). The paste form on
   Admin → Preseason remains as a fallback.
3. Results show on the public `/preseason` page.

The regular (`1–25`) and exhibition (`101–103`) week ranges the ingest API accepts are
**disjoint**, so a typo cannot land a preseason score in a real week. Byes are never derived for
an exhibition week.

### Roster capture — not part of the weekly loop yet

> **Skip this unless you are working on live scoring.** Capturing rosters changes nothing an owner
> sees: there is no `/live` page, and captured lineups never touch standings, seeding, payouts or
> `scores`. The weekly loop above is complete without it.

**The normal path is the extension.** With the contest's gamecenter tab open, the popup's
**Capture lineups** button (v1.2.0+) reads the leaderboard for entry keys and then fetches every
owner's roster — one authenticated request each, because DraftKings has no bulk roster endpoint.
See [`../extension/README.md`](../extension/README.md#capture-lineups-roster-capture-for-live-scoring).

**Admin → Lineups** (`/admin/lineups?season=<id>&week=<n>`, defaulting to week 1) shows three
things: how many DraftKings rosters have been captured for the week (`captured N/32` — the
denominator is the season's owner count) alongside how many individual players are **revealed**, the
newest capture per owner with anything under 9 **slots** flagged **incomplete**, and an audit table
of recent capture runs including which DraftKings URL actually returned the rosters.

> **"Revealed" is not "captured".** DraftKings hides a player from opponents until that player's game
> kicks off, so a perfect 32/32 capture taken at the 1pm lock can show only a handful of the 288
> players by name, with the rest listed as *N yet to play*. **That is not a partial capture** — a
> concealed player has scored nothing, so no points are missing, only names. Re-capture later and
> they fill in. Fewer than 9 **slots**, on the other hand, is a genuinely short payload.

The **Paste rosters** box is the manual fallback: paste whatever a DraftKings roster response
contains and it is parsed structurally, so the exact shape does not matter. Supply **Entry name**
only when the payload is a single roster with nobody named in it, and fill in **Source URL** when
you know which DraftKings URL produced it.

Two things to know before trying it:

- **Re-capturing later in the week is not a mistake.** DraftKings Classic allows late swap, every
  capture is kept, and the newest one wins per owner-week.
- **A paste is not enriched.** The extension sends the DK draft-group id, which is what lets the
  server resolve each `draftableId` to a name and team; the paste form does not, so a pasted capture
  keeps only whatever names and teams the payload itself carried.

Unmatched DraftKings entry names are listed back to you rather than dropped — by the extension's
result banner and by the paste form alike. Fix them the same way as a score mismatch: set the
owner's **DK entry name** in Admin → Assignments, then capture again.

See [`SCORING.md` §15](SCORING.md#15-live-in-progress-scoring-an-estimate-never-a-score).

### Playoff weeks

Playoff rounds are scored at weeks 19–22 (`PLAYOFF_ROUND_WEEKS`). Generate and advance the
bracket from **Admin → Playoffs**; sync each round's contest with the extension using the plain
week number (19, 20, 21, 22 — no Preseason toggle).

**Championship week resolves two games.** When the conference round is advanced, the bracket
generates the championship from that round's winners *and* the **consolation game** between its
two losers — the game that decides 3rd and 4th. Both are played in week 22 and are scored from
the **same** DraftKings contest, so there is still only one contest id per playoff week on
Admin → Playoffs and one sync to run. When the championship resolves, `advancePlayoffs` settles
the consolation game in the same pass and recomputes the season's award ledger automatically, so
champion, runner-up, 3rd and 4th all land live. See
[`SCORING.md` §12](SCORING.md#12-the-bracket-and-the-game-that-decides-3rd).

## 3. Recomputing awards

`season_awards` is the league's payout ledger. Recompute it with:

```bash
npm run import:awards -- --dry-run              # preview every season with owners; writes nothing
npm run import:awards -- --season=<id>          # one season
npm run import:awards -- --season=<id> --third=<ownerSeasonId>   # legacy fallback, see below
npm run import:awards -- --force                # include the frozen 2023-2025 seasons
```

| Flag | Effect |
| ---- | ------ |
| `--dry-run` | Compute and print the ledger; write nothing. **Always run this first and read the diff.** |
| `--season=<id>` | Restrict to one season id. Without it, every season that has owners is processed. |
| `--third=<ownerSeasonId>` | **Legacy fallback — not the normal path.** 3rd and 4th come from the resolved consolation game. This flag names which conference-round loser finished 3rd, and is only for a season imported **before** that game was modelled (2023–2025, which have no consolation row). It is ignored when a resolved 3rd-place game exists, and it refuses a value that is not one of the two conference-round losers. |
| `--force` | Required to touch **2023, 2024, 2025**. They were played and paid under the rules of their day and are frozen. |

Behavior worth knowing:

- It **inserts first and prunes afterwards**, so an interrupted run leaves duplicate rows
  (visible, fixed by re-running), never an empty ledger. The Neon HTTP driver has no
  transactions, which is why the old delete-then-insert was dangerous.
- It only prunes the award types it owns (`champion`, `runner_up`, `third`, `fourth`,
  `weekly_high`, `season_high`, `most_points`). Manual `other` rows survive.
- Payouts come from **each season's own rules**, so Admin → Settings overrides apply.
- Exact ties split the prize evenly, one row per owner.
- It is idempotent — running it twice converges on the same ledger.

`advancePlayoffs` calls the same service when the championship resolves, so champion, runner-up,
3rd and 4th all carry real amounts live — the placements come off the consolation game, which is
settled in the same pass ([§2](#2-the-weekly-loop), "Playoff weeks").

## 4. Verification

```bash
npm run verify          # the full gate — run this before every push
npm run verify:quick    # skip the production build + the ground-truth replay
```

The full gate is **9 checks**:

| Group | Check |
| ----- | ----- |
| CODE | typecheck · lint · unit tests · **production build** |
| DATA | ESPN schedule API reachable · standings/seeding engine invariants (read-only) |
| TRUTH | historical snapshot unchanged · engine no-op proofs · 2025 ground-truth replay |

Notes:

- The **production build is non-negotiable**: it catches production-only errors — most notably
  that a `'use server'` file may export *only* async functions — that `next dev`, `tsc` and
  ESLint all let through, and which silently block a Vercel deploy.
- The DATA and TRUTH checks need `DATABASE_URL`; the CODE checks need no secrets.
- The ground-truth replay (`scripts/import-season3.ts`) **writes to the database** — it re-imports
  the frozen 2025 season. That is by design and idempotent, but it is why `verify:quick` exists.
- On this machine, delete the iCloud duplicate files first or `tsc` throws bogus `RouteContext`
  errors:

  ```bash
  find .next -name "* 2.*" -delete
  ```

## 5. Reading the standings snapshot

```bash
npm run snapshot:standings      # read-only: print a summary of the frozen seasons
```

Prints, per frozen season, the owner count, the missed-lineup convention, distinct games-played
values, both conferences' seeds, the highest weekly score, the most-points leader and the award
count. It writes nothing to the database and nothing to disk. Useful as a quick "what does the
engine currently think?" check.

## 6. The snapshot gate

`npm run verify`'s **historical snapshot unchanged** check diffs the engine's derived output for
2023–2025 against the committed baseline at
[`scripts/fixtures/standings-baseline.json`](../scripts/fixtures/standings-baseline.json). It is
exact — no tolerances, only a 4-decimal rounding so float noise cannot fail the gate — and
covers every owner's record and PF/PA, the full ranked ORDER per division and conference, both
conferences' seeds, the weekly-high and most-points leaders, the season's
`missedLineup.opponentScores`, and the entire `season_awards` ledger. A failure names the
year and the field that moved:

```text
HISTORY MOVED — 2025.seeds changed
```

**If that check fires, the default assumption is that you broke something.** The frozen seasons
are validated against the commissioner's own spreadsheets and were paid out on those numbers.

Re-baselining exists, but it is a deliberate act that needs sign-off:

```bash
npm run verify:baseline         # rewrites scripts/fixtures/standings-baseline.json
```

Before running it you must be able to say, in the commit message, **which** number moved and why
that is correct. The one legitimate reason so far has been a *shape* change to the snapshot
(the `version` field is bumped in `scripts/snapshot-standings.ts` to force exactly this
conversation), where no value moved. Run the gate **twice** after a change to the write path, so
the second run's snapshot reads the data the ground-truth replay just rewrote through the new
code.

## 7. Troubleshooting

| Symptom | Likely cause | Fix |
| ------- | ------------ | --- |
| `/admin/sync` shows **`0/32` scored right after a successful sync** | Every owner was written as a bye — scores were ingested before `nfl_games` existed for that week | Pull the schedule, then re-sync the week. `/standings` should already be right: the read path ignores a bye flag for an owner who has a matchup. |
| Some owners show a loss for the most recent week and never scored | The week is settled (games final, *some* scores in) but their rows are missing — a partial sync | Re-sync the week and confirm `/admin/sync` reads `32/32` ([§2](#2-the-weekly-loop) step 3) |
| `/admin/sync` shows `partial` with unmatched entries | An owner submitted under a different DraftKings entry name | Fix `owner_seasons.dkEntryName` in Admin → Assignments, then re-sync. Unmatched entries are reported, never written. |
| An owner should be marked as missing a lineup but is not | They scored above 0, or the week is not settled | Set `scores.isForfeit = true` for that owner-week directly. A stored flag is always honored as the commissioner's override and is never overwritten by the ingest path. |
| Sync 401s | `INGEST_TOKEN` unset on the server, or the extension's token does not match | See [`DEPLOYMENT.md` §2](DEPLOYMENT.md#2-environment-variables) |
| **Admin → Lineups** errors on a missing relation (`lineup_snapshots` / `lineup_capture_runs`) | Migration `0010` has not been applied to *that* database (production has it) | `npm run db:migrate`. Nothing else depends on it; scoring is unaffected either way. |
| A capture reads **32/32 owners but only a few players revealed** | Not a fault — DraftKings conceals each player until their game kicks off | Nothing to do. Re-capture after later kickoffs; no points are missing, only names. |
| A capture reports **0 enriched slots** with revealed players | DK's public draftables lookup for that draft group failed, so no team keys were resolved — the snapshot is stored but not scorable | Re-run **Capture lineups**. Confirm the draft group id resolves at `api.draftkings.com/contests/v1/contests/{contestId}?format=json`. |
| `verify` fails on **historical snapshot unchanged** | A change moved a frozen season | Stop. See [§6](#6-the-snapshot-gate). |
| `verify` fails on **engine no-op proofs** | A precondition that makes the derivation model safe on history no longer holds | Stop — the corresponding change is not safe and needs a fresh look. The message names the season and the proof. |
