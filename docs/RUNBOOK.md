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
   - Open the extension popup → pick the **Season**, **read the line under the Week box** ("Preseason
     Week 2 · Aug 13 – Aug 16 · 16 games") and confirm those dates are the week you mean → click
     **Sync Week N**.
   - The **Paste manually** expander is the guaranteed fallback if the leaderboard read fails
     (scores only — it does not capture rosters).

   > **The week and the Preseason toggle are now detected, not guessed.** The popup asks the app
   > (`GET /api/current-week`), which derives both from the synced NFL schedule. The old hints —
   > a trailing `#N` in the contest name, then `seasons.currentWeek` — survive **only** as a
   > fallback for when the app cannot answer (no synced schedule, or the app is unreachable). In
   > that case the popup can still offer a wrong week, but the week-info line reads
   > **"no NFL games found for this week"**, which is your signal to check it by hand.

   > **One button does both halves.** Since v1.3.0, **Sync** posts the official scores *and*
   > captures every owner's roster from the same DraftKings read. Scores go first; the roster half
   > is **best-effort** and reports into its own **Lineups** card, so a roster problem never blocks
   > or casts doubt on a score sync that worked. Rosters are what feed `/live` — see
   > [Roster capture](#roster-capture--what-feeds-live) below.

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

6. **Glance at Admin → Scoring** once the week's games are final and a post-game capture exists.
   It compares every captured player's ESPN-derived score against DraftKings' own number for the
   same player. Nothing to configure, nothing to collect — it reads what the capture already
   stored. **This is a health check on `/live`, not on the week's official scores**, which come
   from the leaderboard and are unaffected either way. See
   [below](#checking-that-our-scoring-still-agrees-with-draftkings).

### ⚠️ The wrong week overwrites a real one

**This is the most destructive mistake available in the weekly loop, and it is completely silent.**

`scores` upserts on `(ownerSeasonId, week)` and nothing else — not the contest id, not the time.
So syncing a contest against the wrong week **replaces that week's real scores with this contest's
numbers**. The sync reports success. `/admin/sync` shows the week as freshly imported. Nothing
anywhere says the previous numbers are gone.

It is recoverable: re-sync the correct contest against that week, and every run's raw payload is
kept in `score_import_runs`
([`DRAFTKINGS.md` §6](DRAFTKINGS.md#6-audit-log-score_import_runs)). But you have to *notice* first,
so the real defence is before the sync:

- **Read the date range under the Week box.** The popup shows the dates the selected week actually
  covers, straight from `nfl_games`. If it says "Aug 13 – Aug 16" and you meant last Sunday, stop.
- **Heed the mismatch warning.** When the week you have typed is not the week the schedule says it
  is, the popup warns in amber and names the week it expected.
- **"no NFL games found for this week"** means either a typo or an unsynced schedule — do not sync
  through it.

The historical version of this failure: the Preseason toggle was never detected, so it simply
remembered its last state — and a roster capture landed in week 102 while that day's scores went to
103. Both halves reported success. See
[`SCORING.md` §4](SCORING.md#which-week-is-it--detecting-it-from-the-schedule).

### Preseason exhibition weeks — no longer created

**The league does not run exhibitions any more, and the app can no longer set one up.** `ed6ef78`
removed Admin → Preseason, `src/lib/preseason/query.ts` and `syncPreseasonWeek`; nothing now pulls
an ESPN preseason week, so a *new* exhibition week's games and matchups cannot be generated. That is
intended, not a gap.

**What stays, and why it must:** the `isExhibition` columns and every query filter, the `101`–`103`
ingest range, and `src/lib/schedule/preseason.ts`. There is real exhibition data in the database
(week 102 — 16 matchups, 12 scores, 6 lineup snapshots as of 2026-08-15), and this isolation is the
only thing keeping it out of standings, seeding, playoffs, payouts and all-time records. **Do not
"clean up" the exhibition filters because preseason is retired** — that would let test data pollute
every historical number. Existing exhibition weeks still render on `/live`, and the extension's
**Preseason** toggle still posts a `101`–`103` week, so those rows stay viewable and re-scorable.

The regular (`1–25`) and exhibition (`101–103`) week ranges the ingest API accepts are
**disjoint**, so a typo cannot land a preseason score in a real week. Byes are never derived for
an exhibition week.

**The Preseason toggle is now set for you.** `nfl_games` stores `isExhibition` per row, so
`/api/current-week` reports whether the detected week is an exhibition one and the popup ticks the
box accordingly. Previously the toggle was never detected at all — it just remembered its last
state, which is how a capture and its scores ended up in two different weeks
([above](#-the-wrong-week-overwrites-a-real-one)).

### Roster capture — what feeds `/live`

> Captured lineups **never** touch standings, seeding, payouts or `scores`. They feed the `/live`
> estimate only. The weekly loop above is still correct without a single capture — you just get no
> live page.

**The normal path is the extension, and it is automatic.** Since v1.3.0 the popup's **Sync** button
captures rosters as part of the same DraftKings read it uses for scores: leaderboard → entry keys →
one authenticated roster request per entry, because DraftKings has no bulk roster endpoint. There
is no separate button to click. See
[`../extension/README.md`](../extension/README.md#lineups-captured-automatically-by-sync).

#### ⚠️ One capture is not enough — sync again after the last kickoff

This is the single most important operational rule for `/live`, and getting it wrong makes the page
quietly wrong rather than obviously broken.

> **Extension v1.5.0 automates it, if you leave Live Sync on.** The background loop now asks the
> app (`GET /api/live-status`) on every poll whether re-reading rosters would reveal anything, and
> re-captures only when the answer is yes — plus once more when DraftKings reports the contest
> complete. That is ~6–8 refreshes a week instead of ~1,000, at the same freshness. **The rule
> below still applies whenever Live Sync is off**, which is the default. See
> [`../extension/README.md`](../extension/README.md#why-the-roster-refresh-is-conditional-and-not-every-poll).

DraftKings conceals a player until *that player's* game kicks off. A capture taken at the 1pm lock
therefore hides the **entire late slate** — those roster spots have no identity at all and count as
nothing. That is honest at 1pm. **By 5pm it is wrong:** those players are on the field scoring
points that the estimate is not counting, so every affected owner's total is silently *low*. On the
first real capture, **14 of 16 games had started while 30 roster spots were still concealed.**

**So: hit Sync again after the last kickoff of the day** (and after any late-swap window you care
about — DK Classic allows swaps until each player's own kickoff). Captures are append-only and the
newest one wins, so re-syncing is always safe and never loses anything.

**The one capture worth having no matter what is the one AFTER the games end.** Every player is
revealed and DraftKings' own per-player numbers are final, which is what makes the week auditable
in [Admin → Scoring](#checking-that-our-scoring-still-agrees-with-draftkings). Live Sync takes that
capture automatically on its final poll; without Live Sync, run **Sync** once more after the last
game goes final.

`/live` detects this for you and says **"These totals are low — re-sync to fix"**, naming how many
games have kicked off since the last capture and how many roster spots are still unknown. It stays
quiet when re-capturing would not actually help — for example right after a 1pm capture, when the
early games are underway but nothing has kicked off *since* you captured.

**What "good" looks like on `/live`.** The page states `N/M games loaded` and names any owner with
no capture rather than showing them as `0.00` — **up to six of them by name, then a count**
("… and 20 more"), because spelling out 26 names filled an entire phone screen and pushed every
matchup below it. The notice itself is never suppressed; only the name list is capped. Players whose game is loaded but who have no ESPN row
score 0 (correctly — ESPN only lists players who recorded a stat); only players whose **game did not
load** read as *unresolved*, and that is the one state worth chasing. See
[`SCORING.md` §15](SCORING.md#the-five-slot-states--the-load-bearing-concept).

**How to read it.** Matchup cards are ordered by **closeness**, so whatever could still go either
way sits at the top and uncaptured matchups sit at the bottom. Each side shows its **minutes left**
and a **projected final** (DraftKings' own formula, recomputed from ESPN's clock), and the centre
shows a **win-probability estimate** — a model, not a measurement, so treat it as flavour and never
as a result. The detail page also flags the **biggest single-slot gap** as the difference-maker.
See [`SCORING.md` §15](SCORING.md#projections--win-probability--draftkings-own-formula).

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

### Checking that our scoring still agrees with DraftKings

**Admin → Scoring** (`/admin/scoring?season=<id>&week=<n>`) is the standing answer to a question
that otherwise never gets asked: *is `/live` actually computing DraftKings' scoring correctly?*

`/live` derives DK Classic points from ESPN box scores. If one of those rules were wrong, nothing
in the system would say so — the page would render slightly wrong numbers forever and look
perfectly healthy doing it. This page compares each captured player against **DraftKings' own
per-player score and stat line**, both of which every capture already stores. It reads only, writes
nothing, and computes on demand.

**How to read it.** The headline is *"N of M slots compared, max difference X"*. Read **both**
numbers: a spotless verdict over a sample of nine is not a clean bill of health. Then the counts:

| Verdict | What it means | Do you act? |
| ------- | ------------- | ----------- |
| **Agrees** | Our number matches DraftKings within 0.01. | No. |
| **Rule bug** | Both sources saw the same play; we priced it differently. | **Yes — this is ours.** Report it; the fix is in `src/lib/dfs/rules.ts`. |
| **Source differs** | ESPN and DraftKings disagree about what happened (7 receptions vs 8). | No. Not ours to fix, and deliberately not flagged as needing attention. |
| **Unknown stat** | DraftKings paid for a stat the audit cannot name, so the gap cannot be attributed. | **Yes, but not as a scoring bug** — the audit's key map needs teaching first. |
| **No ESPN match** | We produced no score for that player at all; the name/team join failed. | **Yes** — usually a name-matching problem, same family as an unmatched DK entry name. |
| **Skipped** | Not comparable: concealed at capture time, or the game had not finished when DraftKings was read. | No. |

> **Skipped is the normal state mid-week, and that is by design.** DraftKings' number is a snapshot
> from capture time; ours is live. Comparing a mid-game capture against a finished game measures the
> gap between two moments, not an error. So a slot is judged only when its game is final **and** the
> capture came after it. **Which is why the capture that matters is the one taken after the games
> end** — Live Sync takes it automatically on its final poll.

**When to look.** After a completed week, once a post-game capture exists. There is nothing to
watch mid-Sunday: almost everything will read *Skipped*, correctly.

**What it says today.** Season 1 week 102: 54 slots, 54 agree, 0 rule bugs, max difference 0.00
across 6 owners — the same result as the hand-done reconciliation that closed the live-scoring
work, reproduced by a page load. Full rationale, including the verdict definitions and the one
approximation involved:
[`SCORING.md` §15](SCORING.md#does-the-estimate-agree-with-draftkings--the-drift-audit).

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

## 7. Backups and recovery

> **The realistic threat is not hardware — it is a script.** The importers take `--season=` and
> `--sheet=` arguments, `db:push` and `db:migrate` change schema, and `verify`'s ground-truth
> replay writes to the database by design. A wrong flag damages real data. The
> [snapshot gate](#6-the-snapshot-gate) *detects* history moving; it cannot undo it. **Dump
> before anything that writes.**

### What is actually at risk

| Data | If the database were lost |
| ---- | ------------------------- |
| `lineup_snapshots`, `lineup_capture_runs` | **Gone forever.** DraftKings' authenticated roster endpoint is the only source and contests age out. Not re-fetchable at any price. |
| `scores` from 2026 on | **Gone in practice** — same reason. `score_import_runs` keeps the raw payloads, but *in the same database*, so it is no protection against losing that database. |
| `users`, `owners` | Small, but holds emails and bcrypt hashes. This is why a dump must never be committed. |
| 2023–2025, everything | **Recoverable.** The importers are idempotent and read the commissioner's Google Sheets, and `scripts/fixtures/standings-baseline.json` already records every derived fact in git. |
| `nfl_games`, `nfl_teams`, odds, model snapshots | Re-pullable from ESPN, or recomputable. |

Note the asymmetry: the snapshot gate protects **frozen** seasons only. The season currently
being played — the one writing irreplaceable DraftKings data every week — is deliberately
excluded because it moves. So in-season, the data most at risk has the least protection. That
is what the two commands below are for.

### The two commands

```
npm run db:dump                     # full data-only backup → backups/<timestamp>/ (gitignored)
npm run export:captures -- --write  # PII-free roster captures → scripts/fixtures/captures/ (COMMIT these)
```

**`db:dump`** writes every table as gzipped NDJSON plus a `manifest.json` naming the restore
order. The whole database is around 120 kB compressed, so there is no reason to skip it. It
needs nothing but the app's own dependencies — no `pg_dump`, no system packages — so it also
works on a machine you have just picked up in an emergency. It contains **owner emails and
password hashes**: never commit it, and remember this repository is public.

**`export:captures`** is the off-Neon copy of the one thing that cannot be re-fetched. It writes
one file per season-week (so a week lands once and git never rewrites it) containing the
NORMALIZED rosters: NFL player names, positions, teams, DraftKings' own per-player scores and
stat lines. It deliberately drops `dk_entry_key` and never exports `raw_payload`, because both
identify league members' DraftKings accounts and this repo is public. Run it after the week's
final sync, and commit the result.

### When to run them

| Moment | Command |
| ------ | ------- |
| Before `db:migrate`, `db:push`, or any importer | `npm run db:dump` |
| After the week's final sync, in season | both |
| Before re-baselining the snapshot gate | `npm run db:dump` |

### Neon's own safety net — check this and record it

Neon keeps a point-in-time restore window whose length depends on the plan. It is the fastest
way back from "I just ran the wrong importer", but only inside the window and only if you notice
in time.

1. Neon console → your project → **Settings → Storage** (or **Branches**), find the
   history/restore retention.
2. Record it here so nobody has to guess mid-incident:

   > **PITR retention: `____` (checked: `____`)** — project `ep-cool-union-ad0qzgkd`, `us-east-1`.

3. To restore: Neon console → **Branches → Restore**, pick the timestamp. Or create a branch
   *before* risky work — a Neon branch is a copy-on-write snapshot and is the cheapest possible
   undo button.

### Restoring from a dump

The dump is data-only, which is sufficient because the schema lives in git as drizzle
migrations:

1. Create an empty database and point `DATABASE_URL` at it.
2. `npm run db:migrate` — builds the schema.
3. Load each table in the `restoreOrder` given by `manifest.json` (front to back, so foreign
   keys are satisfied); each file is gzipped NDJSON, one row per line.
4. `npm run verify` — 9/9, and the **historical snapshot** check proves the frozen seasons came
   back byte-identical. That check is the restore's acceptance test.

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
| ------- | ------------ | --- |
| `/admin/sync` shows **`0/32` scored right after a successful sync** | Every owner was written as a bye — scores were ingested before `nfl_games` existed for that week | Pull the schedule, then re-sync the week. `/standings` should already be right: the read path ignores a bye flag for an owner who has a matchup. |
| Some owners show a loss for the most recent week and never scored | The week is settled (games final, *some* scores in) but their rows are missing — a partial sync | Re-sync the week and confirm `/admin/sync` reads `32/32` ([§2](#2-the-weekly-loop) step 3) |
| `/admin/sync` shows `partial` with unmatched entries | An owner submitted under a different DraftKings entry name | Fix `owner_seasons.dkEntryName` in Admin → Assignments, then re-sync. Unmatched entries are reported, never written. |
| An owner should be marked as missing a lineup but is not | They scored above 0, or the week is not settled | Set `scores.isForfeit = true` for that owner-week directly. A stored flag is always honored as the commissioner's override and is never overwritten by the ingest path. |
| Sync 401s | `INGEST_TOKEN` unset on the server, or the extension's token does not match | See [`DEPLOYMENT.md` §2](DEPLOYMENT.md#2-environment-variables) |
| **A week's scores changed to a different contest's numbers** | That contest was synced against the wrong week — `scores` upserts on `(ownerSeasonId, week)` and overwrites silently | Re-sync the **correct** contest against that week. The overwritten run's raw payload is still in `score_import_runs`. See [The wrong week overwrites a real one](#-the-wrong-week-overwrites-a-real-one). |
| The popup warns **"The schedule says it is Week N"** | The typed week is not the week `nfl_games` places today in | Do not sync through it — fix the week first, or confirm you really are re-scoring an older week. |
| The popup shows **"no NFL games found for this week"** | Either a typo, or the season's schedule was never pulled | Check the week; if the season genuinely has no schedule, run Admin → Schedule → **Pull / refresh NFL schedule**. |
| The Week box fills, but with no date line under it | The app could not answer `/api/current-week` — no synced schedule for that season, or the app is unreachable — so the popup fell back to the old contest-name / `currentWeek` guesses | **Do not trust the number.** Pull the schedule (Admin → Schedule) so detection can work, or set the week by hand after checking which week you actually mean. |
| **Admin → Lineups** errors on a missing relation (`lineup_snapshots` / `lineup_capture_runs`) | Migration `0010` has not been applied to *that* database (production has it) | `npm run db:migrate`. Nothing else depends on it; scoring is unaffected either way. |
| A capture reads **32/32 owners but only a few players revealed** | Not a fault — DraftKings conceals each player until their game kicks off | Nothing to do. Re-capture after later kickoffs; no points are missing, only names. |
| A capture reports **0 enriched slots** with revealed players | DK's public draftables lookup for that draft group failed, so no team keys were resolved — the snapshot is stored but not scorable | Re-run **Sync**. Confirm the draft group id resolves at `api.draftkings.com/contests/v1/contests/{contestId}?format=json`. |
| **Sync** reports scores fine but the Lineups card shows a failure | Expected behaviour, not a bug: the roster half is best-effort and reports separately so it cannot cast doubt on the scores | Re-run **Sync**. If it keeps failing, DraftKings may have moved the roster endpoint — use the popup's **Troubleshooting — DraftKings endpoints** panel and send the output to whoever maintains the app. |
| `/live` shows players as **unresolved** | Those players' games did not load from ESPN — the page says `N/M games loaded` | Usually transient; reload. Unresolved is never scored as 0, so a total showing unresolved slots is a **floor**, not a wrong number. |
| `/live` shows an owner's total as **—** | No roster was captured for them that week | Run **Sync** from the extension. The page names them rather than showing `0.00`, because zero would be indistinguishable from a forfeit. |
| `/live` says **"These totals are low — re-sync to fix"** | Games have kicked off since the last capture, so DraftKings would now reveal players it was hiding — those players are scoring and the estimate is excluding them | Hit **Sync** in the extension. This is the expected mid-Sunday workflow, not a fault — see [One capture is not enough](#-one-capture-is-not-enough--sync-again-after-the-last-kickoff). |
| Totals on `/live` look too low but there's **no** warning | Nothing has kicked off since your capture, so re-capturing would reveal nothing | Not a staleness problem. Check `N/M games loaded` and the unresolved count instead. |
| The `/live` "not captured" notice ends **"… and 20 more"** | Not a fault — the notice names at most 6 owners then counts the rest, so it cannot fill a phone screen | Nothing is hidden: every uncaptured owner still shows `—` on their own card. Run **Sync**. |
| Live Sync's popup says **`Rosters: none needed yet`** for hours | Expected. Rosters are re-read only when a kickoff has revealed players the estimate is missing — most polls legitimately need nothing | Nothing to do. Confirm scores are still ticking on the line above; the two are independent. |
| Live Sync shows **`⚠ Rosters: Could not ask the app: HTTP 401`** | The extension's Ingest Token does not match the server's, or `INGEST_TOKEN` is unset — `/api/live-status` uses the same token as everything else | Fix the token in the popup's settings. Scores are failing too if this is the cause; check the score line. See [`DEPLOYMENT.md` §2](DEPLOYMENT.md#2-environment-variables). |
| Live Sync shows **`⚠ Rosters: …`** but scores are syncing fine | Expected behaviour, not a bug: the roster half is best-effort and reported separately so it cannot cast doubt on scores | Re-run **Sync** by hand if `/live` looks stale. The score sync is unaffected. |
| **Admin → Scoring** reports **rule bugs** | Our scoring rules price a stat differently from DraftKings, on an identical stat line | **Report it.** The fix is in `src/lib/dfs/rules.ts`; the finding names the component. Official `scores` are unaffected — only the `/live` estimate is wrong. |
| **Admin → Scoring** reports **unknown stats** | DraftKings paid for a stat key the audit's map does not recognise, so it cannot attribute the gap | Not a scoring bug — the map in `src/lib/live/reconcile.ts` needs the key added. Do **not** go hunting in `rules.ts` first. |
| **Admin → Scoring** says **0 of 54 compared** | No slot is comparable yet: the games were not final when DraftKings was read, or the players were still concealed | Capture again after the games finish, then reload. Live Sync does this on its final poll. |
| **Admin → Scoring** shows **"No captured rosters yet"** | The season has no `lineup_snapshots` rows — the audit reads captures, it does not collect anything | Run a **Sync** from the extension for a week that has been played. |
| `verify` fails on **historical snapshot unchanged** | A change moved a frozen season | Stop. See [§6](#6-the-snapshot-gate). |
| `verify` fails on **engine no-op proofs** | A precondition that makes the derivation model safe on history no longer holds | Stop — the corresponding change is not safe and needs a fresh look. The message names the season and the proof. |
