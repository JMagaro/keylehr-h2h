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
| `playoff_round`  | `wild_card`, `divisional`, `conference`, `championship`                                  | `playoff_matchups.round`         |

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

**Used by:** `owner_seasons.nflTeamId`, `nfl_games.homeTeamId`/`awayTeamId`.

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
| `createdAt`          | timestamptz    | NOT NULL, default `now()`.                              |

**Children (`onDelete: cascade` from season):** `owner_seasons`, `nfl_games`, `matchups`,
`weekly_contests`, `scores`, `score_import_runs`, `season_awards`, `playoff_matchups`.

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

**Constraints/indexes:**

- `nfl_games_season_week_home_uq` — UNIQUE `(seasonId, week, homeTeamId)`. **Upsert key** for the
  schedule sync.
- `nfl_games_season_week_idx` — INDEX `(seasonId, week)` for week lookups.

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

**Constraints/indexes:**

- `matchups_season_week_home_uq` — UNIQUE `(seasonId, week, homeOwnerSeasonId)`. **Upsert key** for
  matchup generation.
- `matchups_season_week_idx` — INDEX `(seasonId, week)`.

## `weekly_contests`

The shared DraftKings contest used to score a given week. (DraftKings pipeline — Planned, Phase 3.)

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

Audit log: one row per DraftKings leaderboard pull (auto or manual). (Planned, Phase 3.)

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
| `triggeredBy`      | varchar(64)     | e.g. `cron`, `admin:<email>`, `manual-paste`.               |
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
| `isBye`         | boolean         | NOT NULL, default `false`. True when the team is on bye (doesn't count). |
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
conference). (Seeding/bracket logic — Planned, Phase 4.)

| Column                  | Type           | Notes                                                       |
| ----------------------- | -------------- | ----------------------------------------------------------- |
| `id`                    | identity PK    |                                                             |
| `seasonId`              | integer FK     | NOT NULL → `seasons.id`, `onDelete: cascade`.               |
| `round`                 | `playoff_round`| NOT NULL.                                                   |
| `conference`            | `conference`   | Nullable. Set for intra-conference rounds; null for the championship. |
| `week`                  | integer        | Nullable.                                                   |
| `highSeed`              | integer        | Nullable. Better seed number.                               |
| `lowSeed`               | integer        | Nullable. Worse seed number.                                |
| `highOwnerSeasonId`     | integer FK     | Nullable → `owner_seasons.id`.                              |
| `lowOwnerSeasonId`      | integer FK     | Nullable → `owner_seasons.id`.                              |
| `highPoints`            | numeric(7,2)   | Nullable.                                                   |
| `lowPoints`             | numeric(7,2)   | Nullable.                                                   |
| `winnerOwnerSeasonId`   | integer FK     | Nullable → `owner_seasons.id`.                              |

## Drizzle relations & inferred types

`schema.ts` also declares Drizzle relations (for the relational query API) for `seasons`,
`owners`, `owner_seasons`, `nfl_teams`, `nfl_games`, `matchups`, `scores`, and `weekly_contests`,
and exports `$inferSelect` / `$inferInsert` types for every table (e.g. `Season`/`NewSeason`,
`Score`/`NewScore`). Import these from `@/db` rather than redefining row shapes.
