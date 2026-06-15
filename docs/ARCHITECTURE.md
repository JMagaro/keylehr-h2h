# Architecture

This document describes how KeyLehr H2H is put together: where data lives, how a request
flows, and the data pipelines that drive the league. It reflects what is **implemented today**
and explicitly marks parts that are **Planned (Phase N)**.

## 1. High-level shape

KeyLehr H2H is a single Next.js 16 (App Router) application deployed on Vercel, backed by a
Neon serverless Postgres database accessed through Drizzle ORM. There is no separate backend
service: data access, mutations, and scheduled jobs all run inside the Next.js app (Server
Components, Server Actions, Route Handlers, and `tsx` CLI scripts).

```text
                          ┌───────────────────────────────────────────────┐
   Browser  ───────────▶  │                Vercel (Next.js 16)             │
   (public + admin)       │                                               │
                          │  App Router                                   │
                          │   ├─ Server Components (read DB directly)      │
                          │   ├─ Server Actions     (admin mutations)     │ Planned (P1/P2)
                          │   ├─ Route Handlers     (/api/...)            │
                          │   └─ middleware.ts      (/admin auth gate)    │ Planned (P1)
                          │              │                                │
                          │              ▼                                │
                          │   src/db (Drizzle client, Node runtime)       │
                          └──────────────┼────────────────────────────────┘
                                         │
                          ┌──────────────▼────────────┐
                          │   Neon Postgres (serverless)│
                          └────────────────────────────┘

      External systems
      ────────────────
      ESPN scoreboard API  ──▶ src/lib/espn ──▶ src/lib/schedule ──▶ nfl_games
      DraftKings API       ──▶ src/lib/dk (Planned P3) ───────────▶ scores
      Vercel Cron          ──▶ /api/cron/pull (Planned P3)
```

## 2. Request flow

- **Public pages (Planned, Phase 2):** rendered as async Server Components that query Postgres
  through the Drizzle client and render server-side. Because `cacheComponents` is off, live
  pages opt into dynamic rendering (`export const dynamic = 'force-dynamic'` or
  `export const revalidate = N`) so they reflect the latest scores.
- **Admin pages (Planned, Phase 1):** gated behind Auth.js. CRUD operations run as **Server
  Actions** that mutate the database and call `revalidatePath()`.
- **Route handlers (`src/app/api/.../route.ts`):** used for the cron-triggered DraftKings pull
  (Planned, Phase 3) and any JSON endpoints. GET handlers are **not** cached by default in
  Next 16.
- **CLI scripts (`scripts/`, `src/db/seed/`):** run via `tsx` outside the request lifecycle
  for seeding and the schedule/matchup pull. They load env through `dotenv/config`.

Today, only the scaffolded landing page (`src/app/page.tsx`) is served; the public/admin
surfaces above are forthcoming.

## 3. The database layer

`src/db/index.ts` constructs the single shared Drizzle client:

```ts
const sql = neon(process.env.DATABASE_URL);
export const db = drizzle({ client: sql, schema, casing: 'snake_case' });
```

Key points:

- **Neon HTTP driver.** Uses `@neondatabase/serverless` with `drizzle-orm/neon-http`, which is
  well suited to serverless/edge-style cold starts but **requires the Node.js runtime** for the
  Drizzle client we use. `src/db/index.ts` documents this: never import it into a `'use client'`
  module or an Edge route.
- **Fail-fast config.** If `DATABASE_URL` is missing, the module throws immediately with a clear
  message rather than surfacing an obscure driver error mid-request.
- **`snake_case` casing.** The schema is written with camelCase keys but the database columns
  are `snake_case`. Both the runtime client and `drizzle.config.ts` set `casing: 'snake_case'`,
  so the mapping is automatic. Hand-written raw SQL (e.g. `excluded.<column>` in upserts) must
  use the snake_case column names.
- **Migrations.** `drizzle.config.ts` points drizzle-kit at `src/db/schema.ts` and writes
  migrations to `drizzle/`. `strict: true` and `verbose: true` are enabled. The initial
  migration is committed (`drizzle/0000_*.sql`).

The schema and all tables are documented in [`DATA_MODEL.md`](DATA_MODEL.md).

## 4. ESPN schedule sync → matchup generation

This is the implemented heart of Phase 1. It is a two-stage, idempotent pipeline that turns the
real NFL schedule into the league's head-to-head matchups.

```text
ESPN scoreboard API
      │  src/lib/espn/client.ts   (fetchSeasonSchedule → NormalizedGame[])
      ▼
NormalizedGame[]  (espnEventId, week, homeEspnId, awayEspnId, kickoff, status)
      │  src/lib/schedule/sync.ts (syncSeasonSchedule)
      │    maps ESPN team id → nfl_teams.id via nfl_teams.espn_id
      │    upserts on (season_id, week, home_team_id)
      ▼
nfl_games        (the real NFL schedule for the season)
      │  src/lib/matchups/generate.ts (generateMatchups)
      │    maps nfl_teams → owner_seasons for this season
      │    each NFL game with BOTH teams assigned → one matchup
      │    owners with no game that week are counted as byes
      ▼
matchups         (owner-vs-owner head-to-head schedule)
```

### `src/lib/espn/`

- **`client.ts`** — a thin, typed wrapper over ESPN's public site scoreboard endpoint
  (`/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2&week=N&dates=YYYY`). It fetches
  only the **regular-season schedule** (home/away team ids, kickoff, status) and deliberately
  ignores ESPN scores, since scoring comes from DraftKings. Exposes `fetchWeekGames` and
  `fetchSeasonSchedule`, plus `buildScoreboardUrl` (exported for testing) and an `EspnFetchError`.
  Defensive parsing skips unusable events instead of crashing. Uses `fetch(..., { next: { revalidate: 3600 } })`
  so the schedule is re-validated at most hourly (the `next` option is harmlessly ignored under
  plain Node/`tsx`).
- **`types.ts`** — narrow TypeScript interfaces for only the subset of the (large) ESPN payload
  the sync consumes, plus the flattened `NormalizedGame` shape the rest of the app uses.

> **Caveat:** ESPN's scoreboard API is **unofficial and undocumented**. The endpoint and shapes
> are confirmed against real responses but can change without notice.

### `src/lib/schedule/sync.ts`

`syncSeasonSchedule(seasonId, year, weeks)` builds an `espnId → nfl_teams.id` map, pulls the
season schedule, resolves teams, and upserts `nfl_games`. The idempotency key is the
`nfl_games_season_week_home_uq` unique index on `(season_id, week, home_team_id)`; on conflict
it updates the volatile fields (`away_team_id`, `kickoff`, `espn_event_id`, `status`). Games
whose teams can't be mapped are skipped and reported in `unmappedEspnTeamIds` (which should be
empty if the team seed data is current).

### `src/lib/matchups/generate.ts`

`generateMatchups(seasonId)` maps each season's `owner_seasons` to NFL teams, then converts each
`nfl_games` row where **both** teams are assigned to an owner into a `matchups` row, preserving
the NFL home/away orientation. Idempotency key: `matchups_season_week_home_uq` on
`(season_id, week, home_owner_season_id)`. It returns a summary of `matchupsUpserted`, `byes`
(assigned owners with no game that week), and `gamesSkippedUnassigned` (games where a team isn't
yet claimed — expected until all 32 teams are assigned). It generates **regular-season** matchups
only; playoff brackets are handled separately.

### Orchestration

`scripts/pull-schedule.ts` (`npm run schedule:pull`) runs both stages for one season. It resolves
the target season (`--year=YYYY`, else the `active`, else the soonest `upcoming` season), then
calls `syncSeasonSchedule` followed by `generateMatchups`, logging a summary. The target season
must already exist in `seasons` (run `npm run db:seed` first).

## 5. Standings / playoff engine (pure, decoupled)

`src/lib/standings/` is intentionally **pure and DB-decoupled**: it defines plain input/output
shapes and pure functions only. It does **not** import the schema or the Drizzle client. The
caller loads rows from the database, maps them into these structures, runs the computation, and
persists results. This keeps the engine fast and trivially unit-testable.

- **`types.ts`** — the vocabulary and shapes: `OwnerEntry`, `MatchupResult`, `StandingRow`,
  `RankedStandingRow`, `SeededOwner`, `PlayoffGame`, `PlayoffGameResult`, `AdvancingOwner`,
  and the `Conference`/`Division`/`PlayoffRound` unions (mirroring, but not importing, the DB
  enums).
- **`standings.ts`** — `computeStandings(entries, results)`, **implemented**. Produces one
  `StandingRow` per owner (W-L-T, Points For/Against, win% with ties as half a win, and a
  current streak code like `"W3"`). Only `isFinal`, non-playoff results count. The winner is
  taken from `winnerOwnerSeasonId` when supplied (admin override / forfeit / explicit tie via
  `null`), otherwise derived from points (higher finite points wins; equal is a tie). Results are
  processed in deterministic chronological order so streaks are stable.

- **Playoff seeding & bracket** (`seeding.ts`, `tiebreakers.ts`, `playoffs.ts`) — **implemented and
  unit-tested** (30 tests). Encodes: 7 seeds per conference (4 division winners + 3 wild cards), a
  bye for the #1 seed, NFL-style reseeding each round (lowest remaining seed faces #1), the
  head-to-head → Points For → Points Against tiebreaker ordering (2-way and multi-way), and a
  postseason-matchup tie broken by higher **regular-season Points For**. The engine is pure: the
  caller supplies seeds/results and persists the output.

> **Configurable per season:** structural rules (playoff size, byes, tiebreakers, bye-week &
> missed-lineup behavior, payouts) are read from each season's `rules` JSONB, validated by
> `seasonRulesSchema` (`src/lib/rules/schema.ts`) with `DEFAULT_SEASON_RULES`. The admin Settings
> page edits them; see `docs/DATA_MODEL.md`.

## 6. Auth / admin model (Implemented)

- **Auth.js (`next-auth` v5)** with a **single commissioner/admin login** for v1, using the
  split-config pattern: `src/auth.config.ts` is edge-safe (used by middleware) and `src/auth.ts`
  adds the Credentials provider (Node runtime, uses `bcryptjs`). Sessions are stateless JWTs.
- The admin email is `ADMIN_EMAIL` and the password is stored as a **bcrypt hash** in
  `ADMIN_PASSWORD_HASH` (never the plaintext; generate with `npm run admin:hash -- "<password>"`).
- **`middleware.ts`** gates `/admin/*` (except `/admin/login`) via the `authorized` callback,
  redirecting unauthenticated requests to the login page.
- The admin CRUD pages and Settings (rules) editor are the remaining Phase 1 UI work.
- Admin CRUD (owners, seasons, owner-team assignments, manual score entry) will run as Server
  Actions.
- **Per-owner logins are a deliberate later follow-up**, not part of v1.

The `npm run admin:hash` script declared in `package.json` (to generate `ADMIN_PASSWORD_HASH`)
is part of this phase and **not yet present** in the repo.

## 7. DraftKings scoring pipeline (Planned, Phase 3)

The automated scoring pipeline is fully designed in [`DRAFTKINGS.md`](DRAFTKINGS.md) and its
**database tables already exist** (`weekly_contests`, `scores`, `score_import_runs`), but the
pipeline code, cron route, and manual-fallback UI are not yet built. In brief:

```text
Vercel Cron (weekly)
      │  POST /api/cron/pull   (guarded by CRON_SECRET)        ← Planned route
      ▼
src/lib/dk pull               ← Planned module
      │  authenticated DK session (DK_SESSION_COOKIE) reads the
      │  shared PRIVATE contest leaderboard: (user_name, fantasy_points)
      ▼
map user_name → owner_seasons.dk_entry_name
      ▼
upsert scores (one per owner_season + week)
      │  every run is logged to score_import_runs (audit + raw payload)
      ▼
recompute standings (src/lib/standings)

Manual fallback: commissioner pastes leaderboard JSON or hand-enters scores
                 (still logged to score_import_runs, source = 'manual').
```

The DraftKings API is **unofficial, undocumented, and against DK's Terms of Service**, and the
authenticated-session requirement (token expiry + bot detection) is the single biggest fragility.
A manual fallback is therefore mandatory. See [`DRAFTKINGS.md`](DRAFTKINGS.md) for the full design,
caveats, and mitigations.

## 8. Key tables (quick reference)

| Table               | Role                                                                  |
| ------------------- | --------------------------------------------------------------------- |
| `seasons`           | One league season (mirrors an NFL year); tracks status/current week.  |
| `nfl_teams`         | The 32 NFL teams; static reference, seeded once. Joins to ESPN.       |
| `owners`            | People in the league; persist across seasons for all-time stats.      |
| `owner_seasons`     | An owner's team assignment for a season + their locked DK entry name.  |
| `nfl_games`         | The real NFL schedule for a season (from ESPN).                       |
| `matchups`          | Owner-vs-owner H2H games derived from `nfl_games`.                     |
| `weekly_contests`   | The shared DK contest used to score each week.                        |
| `scores`            | An owner's weekly DK fantasy points (one per owner_season + week).     |
| `score_import_runs` | Audit log of each leaderboard pull (auto or manual).                  |
| `season_awards`     | Payouts/records (champion, weekly high, most points, ...).            |
| `playoff_matchups`  | The league playoff bracket.                                           |

Full column-level detail is in [`DATA_MODEL.md`](DATA_MODEL.md).
