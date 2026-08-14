# Data model

This document describes every table in [`src/db/schema.ts`](../src/db/schema.ts) — the single
source of truth for the schema. Column names below are the camelCase Drizzle keys; the actual
database columns are `snake_case` (the client and drizzle-kit are configured with
`casing: 'snake_case'`, so the mapping is automatic).

All tables use an `integer` primary key with `GENERATED ALWAYS AS IDENTITY`.

## ER overview

```text
            seasons ──────────────────────────────────────────────┐
              │ 1                                                  │ 1
              │                                                    │
   ┌──────────┼──────────────┬───────────────┬──────────────┐     │
   │ *        │ *            │ *            │ *            │ *      │ *
owner_seasons nfl_games   matchups     weekly_contests  scores  season_awards
   │   │   ▲     │ ▲          │  │           │             │ ▲        │
   │   │   │     │ │          │  │           │             │ │        │
owners │   └─────┘ │  ┌───────┘  │           │      score_import_runs │
   *   │  nfl_teams│  │          │           │             ▲          │
       │   (home/  │  │ home/away│  nfl_game │             └──────────┤ (importRunId)
       │    away)  │  │ owner_   │           │                        │
       └───────────┘  │ season   │           │                  playoff_matchups
   nfl_teams (team)   └──────────┘           │                  (high/low/winner
                                             │                   owner_season)
                            scores ──────────┘
                       (owner_season, week)

Legend:  1 = one,  * = many.  Arrows point to the referenced (parent) table.
```

Relationships at a glance:

- A **season** has many `owner_seasons`, `nfl_games`, `matchups`, `weekly_contests`, `scores`,
  `season_awards`, and `playoff_matchups`.
- An **owner** has many `owner_seasons` (one per season they play).
- An **owner_season** is the join of `owner` + `season` + `nfl_team`, and has many `scores`.
- Every league row that belongs to a specific owner-in-a-season references `owner_seasons`, not
  `owners` directly (so all-time identity and per-season alignment stay distinct).
- Not drawn above (they hang off `seasons` the same way): `playoff_odds_snapshots` and
  `model_snapshots`. **`users` stands alone** — it is the admin-login table and has no
  relationship to `owners`.

## Enums

| Enum             | Values                                                                                  | Used by                          |
| ---------------- | --------------------------------------------------------------------------------------- | -------------------------------- |
| `season_status`  | `upcoming`, `active`, `completed`                                                        | `seasons.status`                 |
| `conference`     | `AFC`, `NFC`                                                                             | `nfl_teams`, `playoff_matchups`  |
| `division`       | `East`, `North`, `South`, `West`                                                         | `nfl_teams`                      |
| `score_source`   | `auto`, `manual`                                                                         | `scores.source`                  |
| `contest_status` | `pending`, `locked`, `pulling`, `final`, `error`                                         | `weekly_contests.status`         |
| `matchup_status` | `scheduled`, `final`                                                                     | `matchups.status`                |
| `import_status`  | `success`, `partial`, `failed`                                                           | `score_import_runs.status`       |
| `award_type`     | `champion`, `runner_up`, `third`, `fourth`, `weekly_high`, `season_high`, `most_points`, `other` | `season_awards.type`     |
| `playoff_round`  | `wild_card`, `divisional`, `conference`, `championship`, `third_place`                   | `playoff_matchups.round`         |

---

## `nfl_teams`

The 32 NFL teams. Static reference data, seeded once via `npm run db:seed`
(`src/db/seed/teams.ts`).

| Column       | Type           | Notes                                                          |
| ------------ | -------------- | -------------------------------------------------------------- |
| `id`         | identity PK    |                                                                |
| `key`        | varchar(4)     | **NOT NULL, UNIQUE.** Abbreviation, e.g. `MIA`. Matches ESPN.  |
| `location`   | varchar(64)    | NOT NULL. City/region, e.g. `Miami`.                           |
| `name`       | varchar(64)    | NOT NULL. Nickname, e.g. `Dolphins`.                           |
| `conference` | `conference`   | NOT NULL.                                                      |
| `division`   | `division`     | NOT NULL.                                                      |
| `espnId`     | varchar(16)    | ESPN team id (string) — robust join key to the ESPN schedule.  |

Branding metadata (all nullable), added by migration `0004` and backfilled from
`src/db/seed/team-meta.ts` via `npm run team:meta`:

| Column            | Type        | Notes                                                     |
| ----------------- | ----------- | --------------------------------------------------------- |
| `primaryColor`    | varchar(9)  | Hex, e.g. `#00338D`. Rendered as the team accent color.   |
| `secondaryColor`  | varchar(9)  | Hex.                                                       |
| `tertiaryColor`   | varchar(9)  | Hex (source may be empty).                                 |
| `quaternaryColor` | varchar(9)  | Hex (source may be empty).                                 |
| `draftkingsLabel` | varchar(64) | DraftKings display label, e.g. `MIA Dolphins`.            |
| `nflTeamId`       | varchar(8)  | NFL.com team id, e.g. `0610`.                              |
| `logoEspn`        | text        | ESPN crest URL — **the primary logo shown on-site.**       |
| `logoWordmark`    | text        | nflverse wordmark logo URL.                                |
| `logoSquared`     | text        | nflverse squared logo URL.                                 |
| `logoWikipedia`   | text        | Wikipedia logo URL.                                        |

**Used by:** `owner_seasons.nflTeamId`, `nfl_games.homeTeamId`/`awayTeamId`. `logoEspn` +
`primaryColor` are carried through `getSeasonStandingsData()` as display-only `brandingById` —
they are never inputs to the standings engine.

> Seed gotcha: ESPN abbreviations differ from some conventions (e.g. Washington = `WSH`, not
> `WAS`). The seed file documents these.

## `seasons`

One row per league season (mirrors an NFL season/year).

| Column               | Type           | Notes                                                   |
| -------------------- | -------------- | ------------------------------------------------------- |
| `id`                 | identity PK    |                                                         |
| `year`               | integer        | **NOT NULL, UNIQUE.** Calendar year, e.g. `2026`.       |
| `name`               | varchar(64)    | NOT NULL. Display name, e.g. `Season 4 (2026)`.         |
| `status`             | `season_status`| NOT NULL, default `upcoming`.                           |
| `regularSeasonWeeks` | integer        | NOT NULL, default `18`.                                 |
| `currentWeek`        | integer        | NOT NULL, default `1`. Drives "live" views.             |
| `entryFeeCents`      | integer        | NOT NULL, default `15500` ($155), stored in **cents**.  |
| `rules`              | jsonb          | Nullable. Per-season, editable rules (tiebreaker order, playoff structure, bye & missed-lineup handling, payouts). See note below. |
| `createdAt`          | timestamptz    | NOT NULL, default `now()`.                              |

> **`seasons.rules` is validated, not free-form.** The schema and every default live in
> [`src/lib/rules/schema.ts`](../src/lib/rules/schema.ts) (`seasonRulesSchema`,
> `DEFAULT_SEASON_RULES` = the canonical 2025-and-earlier config) — treat that file as the source of
> truth rather than duplicating the key list here. Null or missing keys fall back to the defaults, so
> a season with `rules = NULL` behaves exactly like `DEFAULT_SEASON_RULES` — which is the case for
> 2023–2025. The values are threaded into the pure engine by `getSeasonStandingsData()`;
> Admin → Settings edits them. Every key, its default, its readers and its editor are documented
> in [`RULES.md`](RULES.md).

> **`regularSeasonWeeks` and `entryFeeCents` exist in BOTH a column and the `rules` JSONB.** The
> **columns are canonical**; the JSONB copies are ignored mirrors that the Settings page
> deliberately preserves rather than editing, so the two drift. Read
> `seasonRow.regularSeasonWeeks ?? rules.regularSeasonWeeks`. See
> [`RULES.md` §6](RULES.md#6-the-two-ignored-mirrors).

**Children (`onDelete: cascade` from season):** `owner_seasons`, `nfl_games`, `matchups`,
`weekly_contests`, `scores`, `score_import_runs`, `season_awards`, `playoff_matchups`,
`playoff_odds_snapshots`, `model_snapshots`.

## `users`

Admin accounts that can log in to the commissioner panel. **Intentionally separate from
`owners`** — most league members never need an admin login.

| Column         | Type          | Notes                                                       |
| -------------- | ------------- | ----------------------------------------------------------- |
| `id`           | identity PK   |                                                             |
| `email`        | varchar(256)  | **NOT NULL, UNIQUE.**                                       |
| `name`         | varchar(128)  | Nullable.                                                   |
| `passwordHash` | varchar(256)  | NOT NULL. **Raw bcrypt hash** (starts with `$2…`). Never exposed to the client. |
| `role`         | varchar(32)   | NOT NULL, default `admin`.                                  |
| `createdAt`    | timestamptz   | NOT NULL, default `now()`.                                  |

> The env bootstrap admin (`ADMIN_EMAIL` / `ADMIN_PASSWORD_HASH`) is **not** stored here. It
> always works as a fallback, so the commissioner can sign in before any rows exist. Manage rows
> with `npm run admin:create` or Admin → Users.

## `owners`

A person in the league. Persists **across seasons** so all-time stats work.

| Column       | Type          | Notes                                                  |
| ------------ | ------------- | ------------------------------------------------------ |
| `id`         | identity PK   |                                                        |
| `name`       | varchar(128)  | NOT NULL.                                              |
| `email`      | varchar(256)  | Nullable.                                              |
| `phone`      | varchar(32)   | Nullable.                                              |
| `dkUsername` | varchar(128)  | Nullable. The owner's DraftKings account/handle.       |
| `createdAt`  | timestamptz   | NOT NULL, default `now()`.                             |

> `owners.dkUsername` is the owner's account handle in general; the per-season entry name the
> scoring pipeline actually matches against is `owner_seasons.dkEntryName` (below).

## `owner_seasons`

An owner's assignment to one NFL team for one season. The central join row that almost every
other per-owner table points at.

| Column        | Type          | Notes                                                                |
| ------------- | ------------- | -------------------------------------------------------------------- |
| `id`          | identity PK   |                                                                      |
| `seasonId`    | integer FK    | NOT NULL → `seasons.id`, `onDelete: cascade`.                        |
| `ownerId`     | integer FK    | NOT NULL → `owners.id`, `onDelete: cascade`.                         |
| `nflTeamId`   | integer FK    | NOT NULL → `nfl_teams.id`.                                           |
| `dkEntryName` | varchar(128)  | The exact DK entry/username this owner uses in the weekly contest. **Scoring matches the leaderboard against this; league rule says it must not change mid-season.** |
| `displayName` | varchar(160)  | The owner's name **as that season's sheet listed it** (co-owners can change year to year). Season-scoped views render `coalesce(displayName, owners.name)` so a co-owner change doesn't bleed across seasons. Nullable; falls back to the global owner name. |
| `createdAt`   | timestamptz   | NOT NULL, default `now()`.                                           |

**Constraints/indexes:**

- `owner_seasons_season_owner_uq` — UNIQUE `(seasonId, ownerId)`: an owner appears once per season.
- `owner_seasons_season_team_uq` — UNIQUE `(seasonId, nflTeamId)`: each NFL team is assigned to at
  most one owner per season.

## `nfl_games`

The real NFL schedule for a season, auto-pulled from ESPN. Drives matchups.

| Column        | Type          | Notes                                                       |
| ------------- | ------------- | ----------------------------------------------------------- |
| `id`          | identity PK   |                                                             |
| `seasonId`    | integer FK    | NOT NULL → `seasons.id`, `onDelete: cascade`.               |
| `week`        | integer       | NOT NULL.                                                   |
| `homeTeamId`  | integer FK    | NOT NULL → `nfl_teams.id`.                                  |
| `awayTeamId`  | integer FK    | NOT NULL → `nfl_teams.id`.                                  |
| `kickoff`     | timestamptz   | Nullable (ESPN may emit TBD dates).                         |
| `espnEventId` | varchar(32)   | ESPN event id, used for idempotent upserts.                 |
| `status`      | varchar(32)   | Nullable, e.g. `STATUS_SCHEDULED`/`STATUS_FINAL`.           |
| `isExhibition`| boolean       | NOT NULL, default `false`. `true` for a **preseason exhibition** game (see note below). |

**Constraints/indexes:**

- `nfl_games_season_week_home_uq` — UNIQUE `(seasonId, week, homeTeamId)`. **Upsert key** for the
  schedule sync.
- `nfl_games_season_week_idx` — INDEX `(seasonId, week)` for week lookups.

> **Preseason exhibition namespace.** Preseason games are pulled as exhibition rows (`isExhibition =
> true`) and stored at an **offset week** — `week = 100 + preseasonWeek` (so 101/102/103) — so they
> can never collide with the regular season (weeks 1–18) or playoffs (19–22) in any `(…, week)`
> unique index. The `week` ↔ preseason-week mapping and detection live in
> [`src/lib/schedule/preseason.ts`](../src/lib/schedule/preseason.ts) (`PRESEASON_WEEK_BASE = 100`,
> `toExhibitionWeek` / `fromExhibitionWeek` / `isExhibitionWeek` / `exhibitionWeekLabel`). **Every
> standings/stats query excludes `isExhibition` rows**, so a preseason game is fully tracked
> (schedule, matchups, scores, a winner) yet never counts toward standings, seeding, playoffs,
> payouts, or all-time records. The same flag carries onto the derived `matchups` and `scores` rows.
>
> **If you add a query that reads `scores` or `matchups` for standings or all-time stats, you must
> filter it** — `eq(scores.isExhibition, false)` / `eq(matchups.isExhibition, false)` — or preseason
> games leak into the records. The exclusion is per-query, not enforced by the schema, so it is easy
> to miss on a new leaderboard (`src/lib/history.ts` is the usual place).

## `matchups`

Head-to-head owner matchups for a week, derived from `nfl_games`: each owner faces the owner whose
NFL team is their opponent that week. An owner on a bye has no row that week. `home`/`away` mirror
the underlying NFL game.

| Column              | Type             | Notes                                                  |
| ------------------- | ---------------- | ------------------------------------------------------ |
| `id`                | identity PK      |                                                        |
| `seasonId`          | integer FK       | NOT NULL → `seasons.id`, `onDelete: cascade`.          |
| `week`              | integer          | NOT NULL.                                              |
| `homeOwnerSeasonId` | integer FK       | NOT NULL → `owner_seasons.id`, `onDelete: cascade`.    |
| `awayOwnerSeasonId` | integer FK       | NOT NULL → `owner_seasons.id`, `onDelete: cascade`.    |
| `nflGameId`         | integer FK       | Nullable → `nfl_games.id` (link to source NFL game).   |
| `status`            | `matchup_status` | NOT NULL, default `scheduled`.                         |
| `isPlayoff`         | boolean          | NOT NULL, default `false`.                             |
| `isExhibition`      | boolean          | NOT NULL, default `false`. Carried from the source `nfl_games` row; `true` for preseason exhibition matchups (stored at week `100 + preseasonWeek`, **excluded from all stats** — see `nfl_games`). |

**Constraints/indexes:**

- `matchups_season_week_home_uq` — UNIQUE `(seasonId, week, homeOwnerSeasonId)`. **Upsert key** for
  matchup generation.
- `matchups_season_week_idx` — INDEX `(seasonId, week)`.

## `weekly_contests`

The shared DraftKings contest / slate for a given week. Written by **Admin → Slates**
(`dkDraftGroupId`, which pins the salary slate the lineup builder uses) and by **Admin →
Playoffs** (`dkContestId` per playoff week). Read by `src/lib/players/query.ts` when resolving
DraftKings salaries.

| Column          | Type             | Notes                                                |
| --------------- | ---------------- | ---------------------------------------------------- |
| `id`            | identity PK      |                                                      |
| `seasonId`      | integer FK       | NOT NULL → `seasons.id`, `onDelete: cascade`.        |
| `week`          | integer          | NOT NULL.                                            |
| `dkContestId`   | varchar(64)      | DK contest id whose leaderboard we pull.             |
| `dkDraftGroupId`| varchar(64)      | DK draft group id (slate), optional.                 |
| `name`          | varchar(256)     | Nullable.                                            |
| `lockTime`      | timestamptz      | Nullable.                                            |
| `status`        | `contest_status` | NOT NULL, default `pending`.                         |
| `lastPulledAt`  | timestamptz      | Nullable.                                            |

**Constraints:** `weekly_contests_season_week_uq` — UNIQUE `(seasonId, week)` (one contest per week).

## `score_import_runs`

Audit log: one row per DraftKings leaderboard pull (auto or manual). Written by every
`ingestLeaderboard` / `writeTeamScores` call — see [`DRAFTKINGS.md` §6](DRAFTKINGS.md#6-audit-log-score_import_runs).

| Column             | Type            | Notes                                                       |
| ------------------ | --------------- | ----------------------------------------------------------- |
| `id`               | identity PK     |                                                             |
| `seasonId`         | integer FK      | NOT NULL → `seasons.id`, `onDelete: cascade`.               |
| `week`             | integer         | NOT NULL.                                                   |
| `dkContestId`      | varchar(64)     | Nullable.                                                   |
| `status`           | `import_status` | NOT NULL (`success`/`partial`/`failed`).                    |
| `entriesTotal`     | integer         | NOT NULL, default 0. Leaderboard entries seen.              |
| `entriesMatched`   | integer         | NOT NULL, default 0. Mapped to an owner.                    |
| `entriesUnmatched` | integer         | NOT NULL, default 0. Could not be mapped.                   |
| `triggeredBy`      | varchar(64)     | Free-form; today `extension` (ingest API), `admin:preseason` (paste form), `backfill` (importers). |
| `error`            | text            | Nullable failure detail.                                    |
| `rawPayload`       | jsonb           | Raw leaderboard payload retained for debugging/replay.      |
| `createdAt`        | timestamptz     | NOT NULL, default `now()`.                                  |

## `scores`

An owner's weekly DraftKings fantasy points. One row per `(ownerSeason, week)`.

| Column          | Type            | Notes                                                                |
| --------------- | --------------- | -------------------------------------------------------------------- |
| `id`            | identity PK     |                                                                      |
| `seasonId`      | integer FK      | NOT NULL → `seasons.id`, `onDelete: cascade`.                        |
| `ownerSeasonId` | integer FK      | NOT NULL → `owner_seasons.id`, `onDelete: cascade`.                  |
| `week`          | integer         | NOT NULL.                                                            |
| `dkPoints`      | numeric(7,2)    | DK fantasy points (e.g. `241.68`). **Null until scored.**            |
| `source`        | `score_source`  | NOT NULL, default `manual` (`auto` vs `manual`).                     |
| `isBye`         | boolean         | NOT NULL, default `false`. True when the owner's NFL team had no game that week. A bye score never counts toward W-L-T or Points Against. **A persisted hint, not the source of truth** — see the note below. |
| `isForfeit`     | boolean         | NOT NULL, default `false`. True when the owner missed their lineup. The forfeiting owner's own `dkPoints` still records whatever they scored (usually 0); what their opponent plays against is the season's `missedLineup.opponentScores` rule. **Written only by the historical importers and by a commissioner acting manually** — never by any ingest path. |
| `isExhibition`  | boolean         | NOT NULL, default `false`. Auto-flagged for scores written at a preseason exhibition week (`100 + preseasonWeek`); **excluded from all stats** — see `nfl_games`. |
| `dkContestId`   | varchar(64)     | Nullable.                                                            |
| `dkEntryKey`    | varchar(64)     | Nullable. DK entry key for the matched leaderboard row.             |
| `note`          | text            | Nullable.                                                           |
| `importRunId`   | integer FK      | Nullable → `score_import_runs.id` (which run produced this score).   |
| `createdAt`     | timestamptz     | NOT NULL, default `now()`.                                          |
| `updatedAt`     | timestamptz     | NOT NULL, default `now()`.                                          |

**Constraints/indexes:**

- `scores_owner_season_week_uq` — UNIQUE `(ownerSeasonId, week)`. **Upsert key** for scoring.
- `scores_season_week_idx` — INDEX `(seasonId, week)`.

> `dkPoints` is `numeric`, surfaced by Drizzle as a **string**. Use `formatPoints()` in
> `src/lib/utils.ts` to render it.

> **`isBye` and `isForfeit` are persisted DERIVATIONS, not the source of truth.** Both describe
> facts that live in other tables (`nfl_games`, `matchups`) and are written once at ingest with
> no recompute trigger, so they drift. The read path re-derives both — byes from the NFL
> schedule, missed lineups from the schedule plus a settled-week gate — and composes forfeits as
> **derived ∪ stored**, so a manually set `isForfeit = true` is always honored as the
> commissioner's override. Never write a query that trusts either column on its own; use the
> `forfeitByOwnerWeek` set from `getSeasonStandingsData()` and `isEffectiveBye()`. The full rule
> is in [`SCORING.md`](SCORING.md).

## `season_awards`

Payouts and records for a season (champion, weekly high score, most points, ...).

| Column          | Type          | Notes                                                            |
| --------------- | ------------- | --------------------------------------------------------------- |
| `id`            | identity PK   |                                                                 |
| `seasonId`      | integer FK    | NOT NULL → `seasons.id`, `onDelete: cascade`.                   |
| `type`          | `award_type`  | NOT NULL.                                                       |
| `ownerId`       | integer FK    | Nullable → `owners.id`.                                         |
| `ownerSeasonId` | integer FK    | Nullable → `owner_seasons.id`.                                  |
| `week`          | integer       | Nullable. Set for weekly awards; null for season-long awards.   |
| `amountCents`   | integer       | Nullable. Payout in **cents**.                                  |
| `value`         | numeric(8,2)  | Nullable. Associated value, e.g. the points total for a record. |
| `note`          | text          | Nullable.                                                       |

## `playoff_matchups`

The league playoff bracket. Seeding mirrors the NFL (4 division winners + 3 wild cards per
conference) and is config-driven from `rules.playoffs`. Written by
`src/lib/playoffs/service.ts` (`generatePlayoffBracket` / `advancePlayoffs` / `setGameWinner`,
driven from Admin → Playoffs) and by the historical bracket importers.

| Column                  | Type           | Notes                                                       |
| ----------------------- | -------------- | ----------------------------------------------------------- |
| `id`                    | identity PK    |                                                             |
| `seasonId`              | integer FK     | NOT NULL → `seasons.id`, `onDelete: cascade`.               |
| `round`                 | `playoff_round`| NOT NULL.                                                   |
| `conference`            | `conference`   | Nullable. Set for intra-conference rounds; **null** for the two cross-conference games, `championship` and `third_place`. |
| `week`                  | integer        | Nullable.                                                   |
| `highSeed`              | integer        | Nullable. Better seed number.                               |
| `lowSeed`               | integer        | Nullable. Worse seed number.                                |
| `highOwnerSeasonId`     | integer FK     | Nullable → `owner_seasons.id`.                              |
| `lowOwnerSeasonId`      | integer FK     | Nullable → `owner_seasons.id`.                              |
| `highPoints`            | numeric(7,2)   | Nullable.                                                   |
| `lowPoints`             | numeric(7,2)   | Nullable.                                                   |
| `winnerOwnerSeasonId`   | integer FK     | Nullable → `owner_seasons.id`.                              |

> Rounds are scored at fixed weeks — `wild_card` 19, `divisional` 20, `conference` 21,
> `championship` 22 and `third_place` **also 22** (`PLAYOFF_ROUND_WEEKS`). Those weeks live in
> `scores` like any other, but they have **no `matchups` rows**, which is why "no matchup that
> week" never means "bye" past the regular season. `upsertRoundGames` matches on
> `(round, conference, highSeed, lowSeed)` and prunes superseded rows, so it is authoritative for
> the round it writes — otherwise an admin winner override left the old pairing behind as a
> phantom game. Pruning is scoped per `(round, conference)`, so the two week-22 games written in
> the same call do not evict each other.
>
> `third_place` is the **consolation game** between the two beaten conference finalists: it is
> generated from the conference round's losers at the same moment the championship is generated
> from its winners, shares championship week (so it needs no extra `weekly_contests` row), and
> its winner/loser are the season's 3rd and 4th place. It is a **leaf**, so it is absent from
> `PLAYOFF_ROUND_ORDER` and nothing advances out of it — see
> [`SCORING.md` §12](SCORING.md#12-the-bracket-and-the-game-that-decides-3rd).

## `playoff_odds_snapshots`

Monte-Carlo playoff probability per owner, snapshotted weekly, for the `/playoffs` trend chart.
Produced by `npm run odds:compute` (`src/lib/odds/`).

| Column          | Type          | Notes                                                    |
| --------------- | ------------- | -------------------------------------------------------- |
| `id`            | identity PK   |                                                          |
| `seasonId`      | integer FK    | NOT NULL → `seasons.id`, `onDelete: cascade`.            |
| `week`          | integer       | NOT NULL. The week the snapshot reflects.                |
| `ownerSeasonId` | integer FK    | NOT NULL → `owner_seasons.id`, `onDelete: cascade`.      |
| `oddsPct`       | numeric(5,2)  | NOT NULL. Playoff probability as a percent, `0.00`–`100.00`. |
| `computedAt`    | timestamptz   | NOT NULL, default `now()`.                               |

**Constraints/indexes:** `playoff_odds_snapshots_season_week_owner_uq` UNIQUE
`(seasonId, week, ownerSeasonId)`; `playoff_odds_snapshots_season_idx` on `seasonId`.

## `model_snapshots`

Performance tracking for the three lineup models (Floor/Blend/Ceiling). One row per
`(season, week, risk)`: a snapshot of the lineup the model recommended that week, plus — once the
games are played — how it actually scored. Produced by `snapshotWeek` / graded by `gradeWeek`
(`src/lib/players/performance.ts`); see also Admin → Models.

| Column          | Type          | Notes                                                                |
| --------------- | ------------- | -------------------------------------------------------------------- |
| `id`            | identity PK   |                                                                      |
| `seasonId`      | integer FK    | NOT NULL → `seasons.id`, `onDelete: cascade`.                        |
| `week`          | integer       | NOT NULL.                                                            |
| `risk`          | varchar(16)   | `safe` \| `balanced` \| `boom`.                                      |
| `modelVersion`  | varchar(32)   | e.g. `Floor@0.1.0`.                                                  |
| `draftGroupId`  | varchar(64)   | DK slate the salaries came from (null in signal-only mode).         |
| `salaryMode`    | boolean       | NOT NULL, default false.                                            |
| `salaryCap`     | integer       | Nullable.                                                           |
| `lineup`        | jsonb         | NOT NULL. The recommended roster: `[{ slot, playerId, name, position, teamKey, fit, salary }]`. |
| `pool`          | jsonb         | NOT NULL. Considered players for hindsight grading.                 |
| `createdAt`     | timestamptz   | NOT NULL, default `now()`.                                          |
| `gradedAt`      | timestamptz   | Nullable — set when graded.                                         |
| `actualPoints`  | numeric(8,2)  | Nullable. The recommended lineup's actual fantasy total.            |
| `optimalPoints` | numeric(8,2)  | Nullable. Best achievable from the pool under the cap (hindsight).  |
| `chalkPoints`   | numeric(8,2)  | Nullable. A naive "pay up" lineup's actual total.                   |
| `playersGraded` | integer       | Nullable. How many of the 9 had a stat line.                        |
| `gradeMeta`     | jsonb         | Nullable. Per-player actuals.                                       |

**Constraints/indexes:** `model_snapshots_season_week_risk_uq` UNIQUE `(seasonId, week, risk)`;
`model_snapshots_season_idx` on `seasonId`.

## Migration history

Migrations are generated by drizzle-kit from `src/db/schema.ts` and committed under `drizzle/`.
A fresh checkout applies them all with `npm run db:migrate`.

| File | What it does |
| ---- | ------------ |
| `0000_unknown_forgotten_one.sql` | Initial schema: all 9 enums plus `nfl_teams`, `seasons`, `owners`, `owner_seasons`, `nfl_games`, `matchups`, `weekly_contests`, `score_import_runs`, `scores`, `season_awards`, `playoff_matchups`. |
| `0001_nifty_dreaming_celestial.sql` | `scores.is_forfeit` boolean, NOT NULL default `false`. |
| `0002_rich_nekra.sql` | `seasons.rules` jsonb (nullable) — per-season league rules. |
| `0003_fuzzy_tomas.sql` | `users` table — admin logins for the commissioner panel. |
| `0004_ambiguous_nicolaos.sql` | The 10 `nfl_teams` branding columns (4 colors, `draftkings_label`, `nfl_team_id`, 4 logo URLs). |
| `0005_early_venom.sql` | `playoff_odds_snapshots` table + its unique/season indexes. |
| `0006_daffy_scourge.sql` | `model_snapshots` table + its unique/season indexes. |
| `0007_concerned_iron_patriot.sql` | `owner_seasons.display_name` — the owner's name as that season's sheet listed it. |
| `0008_shocking_lila_cheney.sql` | `is_exhibition` boolean on `matchups`, `nfl_games` **and** `scores` — the preseason namespace. |
| `0009_lyrical_firedrake.sql` | `third_place` added to the `playoff_round` enum (`ALTER TYPE … ADD VALUE`, additive) — the consolation game that decides 3rd/4th. |

To add one: edit `src/db/schema.ts`, run `npm run db:generate` (writes the SQL), review it, then
`npm run db:migrate`. Commit the generated file.

## Drizzle relations & inferred types

`schema.ts` also declares Drizzle relations (for the relational query API) for `seasons`,
`owners`, `owner_seasons`, `nfl_teams`, `nfl_games`, `matchups`, `scores`, and `weekly_contests`,
and exports `$inferSelect` / `$inferInsert` types for every table (e.g. `Season`/`NewSeason`,
`Score`/`NewScore`). Import these from `@/db` rather than redefining row shapes.
