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
                          │   ├─ Server Actions     (admin mutations)     │
                          │   ├─ Route Handlers     (/api/...)            │
                          │   └─ middleware.ts      (/admin auth gate)    │
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
      DraftKings leaderboard ──▶ extension/ ──▶ POST /api/ingest/draftkings
                                            ──▶ src/lib/scores/ingest ──▶ scores
      DraftKings draftables  ──▶ src/lib/draftkings (salaries, server-side, keyless)
      Sleeper + ESPN news    ──▶ src/lib/players   (lineup builder signals)
      ESPN boxscore API      ──▶ src/lib/dfs       (live DK-points ESTIMATE — never
                                                    written to scores; see §9)
```

All four App Router surfaces ship today. See [§2](#2-request-flow) for the counts.

## 2. Request flow

- **Public pages:** rendered as async Server Components that query Postgres through the Drizzle
  client and render server-side. Because `cacheComponents` is off, live pages opt into dynamic
  rendering (`export const dynamic = 'force-dynamic'` or `export const revalidate = N`) so they
  reflect the latest scores. Shipped: the dashboard, Standings, Playoffs, **Live** (`/live` and
  `/live/[matchupId]`), My Team (plus the lineup Builder), History (index, per-season,
  head-to-head), Rules, and Cohen's Corner.
  > **`/live` is the deliberate exception: it must NOT set `force-dynamic`.** That flag implies
  > `fetchCache = 'force-no-store'`, which would disable the Data Cache for every fetch on the
  > route and turn one shared ESPN fan-out into one per viewer. It is already dynamic because it
  > awaits `searchParams`. See [§9](#9-live-in-progress-scoring-built).
- **Admin pages (`src/app/admin/(panel)/`):** gated behind Auth.js. CRUD runs as **Server
  Actions** that mutate the database and call `revalidatePath()`. Shipped: the dashboard, Owners
  (list + detail), Assignments, Schedule, Preseason, Sync, **Lineups**, Playoffs, Slates, Models,
  Settings and Users, plus the `/admin/login` route.
- **Route handlers (`src/app/api/.../route.ts`):** `POST /api/ingest/draftkings` (the extension's
  score ingest, bearer `INGEST_TOKEN`), `POST /api/ingest/lineups` (roster capture for the live
  estimate — same token, **never** writes a score; see [§9](#9-live-in-progress-scoring-built)),
  `GET /api/seasons` (the extension's season picker / connection probe), and the Auth.js catch-all.
  GET handlers are **not** cached by default in Next 16.
- **`middleware.ts`:** gates `/admin/*` (except `/admin/login`) — see [§6](#6-auth--admin-model-implemented).
- **CLI scripts (`scripts/`, `src/db/seed/`):** run via `tsx` outside the request lifecycle
  for seeding, the schedule/matchup pull, the season/playoff/award importers, the odds
  simulation, and the verification gate. They load env through `@/load-env` (`dotenv`).

Request-scoped caching: `standings/query.ts` exports `*Cached` variants (React `cache()`) for
the pages that fan out over the same season repeatedly — `/history` in particular. **App code may
use these; scripts must not**, because `scripts/import-season3.ts` mutates the database and reads
standings back to validate them.

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

> Preseason **exhibition** games used to go through the same two stages via `syncPreseasonWeek`.
> **That path was removed** (`ed6ef78`) — no new exhibition week can be created. Existing
> `isExhibition` rows are untouched and still filtered out of every stats query. See below and
> [`SCORING.md` §2](SCORING.md#2-the-three-week-namespaces).

### `src/lib/espn/`

- **`client.ts`** — a thin, typed wrapper over ESPN's public site scoreboard endpoint
  (`/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2&week=N&dates=YYYY`). It fetches the
  **schedule only** (home/away team ids, kickoff, status) and deliberately ignores ESPN scores,
  since scoring comes from DraftKings. Exposes `fetchWeekGames` and `fetchSeasonSchedule`, plus
  `buildScoreboardUrl` (exported for testing) and an `EspnFetchError`. All three take an optional
  `seasonType` that defaults to the regular season (`2`). `SEASON_TYPE_PRESEASON` (`1`) is still
  exported but has **zero consumers** since the exhibition sync was removed — nothing pulls a
  preseason week today.
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

> **There is no exhibition counterpart any more.** `syncPreseasonWeek` and Admin → Preseason were
> removed in `ed6ef78` — the league does not run exhibitions, so **nothing pulls an NFL preseason
> week (`seasontype=1`) and no new exhibition schedule or matchups can be created.**
> `SEASON_TYPE_PRESEASON` remains declared in `src/lib/espn/client.ts` with zero consumers.
>
> **The `isExhibition` isolation stays and must not be removed.** Exhibition rows exist in the
> database (week 102), stored at the offset week `100 + preseasonWeek`
> (`src/lib/schedule/preseason.ts`) so they can never collide with the regular season (1–18) or
> playoffs (19–22) on the same unique index. Every standings/stats query filters them out; that
> filter is the only thing keeping old test data out of all-time records. See
> [`SCORING.md` §2](SCORING.md#2-the-three-week-namespaces).

Scoring an **existing** exhibition week uses the **same ingest path as any other week** — no
separate pipeline. The ingest endpoint accepts two disjoint `week` namespaces (`1–25` and
`101–103`), and the Chrome extension's **Preseason** toggle posts the offset value; `isExhibition`
is derived from the week alone. See
[`DRAFTKINGS.md` §10](DRAFTKINGS.md#10-the-ingest-endpoint-implemented).

### `src/lib/matchups/generate.ts`

`generateMatchups(seasonId)` maps each season's `owner_seasons` to NFL teams, then converts each
`nfl_games` row where **both** teams are assigned to an owner into a `matchups` row, preserving
the NFL home/away orientation. Idempotency key: `matchups_season_week_home_uq` on
`(season_id, week, home_owner_season_id)`. It returns a summary of `matchupsUpserted`, `byes`
(assigned owners with no game that week), and `gamesSkippedUnassigned` (games where a team isn't
yet claimed — expected until all 32 teams are assigned). It processes every `nfl_games` row for the
season, **carrying `isExhibition` from the game onto the matchup**, so it covers preseason
exhibition weeks as well as the regular season. Playoff brackets are handled separately.

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

- **`forfeit-derive.ts`** — pure derivation of byes and missed lineups from the schedule.
  `scores.isBye` / `scores.isForfeit` are persisted *hints*, not the source of truth; see
  [`SCORING.md` §3](SCORING.md#3-the-derivation-principle).
- **`assemble.ts`** — `assembleMatchupResults()`: raw `scores` + `matchups` rows →
  `MatchupResult[]`, applying the season's `missedLineup` rule and computing each week's league
  average/median. This step decides what a forfeit's opponent plays against, and therefore decides
  wins, Points Against and ultimately seeds.
- **Playoff seeding & bracket** (`seeding.ts`, `tiebreakers.ts`, `playoffs.ts`) — **implemented and
  unit-tested**. Encodes: 7 seeds per conference (4 division winners + 3 wild cards), a bye for
  the #1 seed, NFL-style reseeding each round (lowest remaining seed faces #1), the league's
  recursive `resolve_ties` (win% cohorts → head-to-head dominance → Points For), and a
  postseason-matchup tie broken by higher **regular-season Points For**. The engine is pure: the
  caller supplies seeds/results and persists the output.
  Advancing the conference round produces **two** games: the championship, from its winners, and
  the `third_place` consolation game, from its losers. That one is a **leaf** — same week as the
  championship (22), scored from the same contest, and deliberately outside
  `PLAYOFF_ROUND_ORDER` so the advancement walk cannot stop on it. See
  [`SCORING.md` §12](SCORING.md#12-the-bracket-and-the-game-that-decides-3rd).

`src/lib/schedule/final.ts` sits alongside as the single definition of "is this game/week
finished?", shared by the scoring engine and the admin sync dashboard so they cannot drift apart.

`src/lib/standings/query.ts` is the **only** DB adapter: `getSeasonStandingsData()` is the hub
that loads the rows, derives byes/forfeits, assembles the results, and returns
`rankingOptions` + `playoffConfig` + `forfeitByOwnerWeek` for every consumer.

> **Read [`SCORING.md`](SCORING.md)** before changing anything in this path — it documents the
> full chain (ingest → bye derivation → forfeit derivation → assembly → standings → tiebreakers
> → seeding), the three week namespaces, and the settled-week safety property.

> **Configurable per season:** structural rules (playoff size, byes, tiebreakers, bye-week &
> missed-lineup behavior, payouts) are read from each season's `rules` JSONB, validated by
> `seasonRulesSchema` (`src/lib/rules/schema.ts`) with `DEFAULT_SEASON_RULES`. The admin Settings
> page edits them; every key is documented in [`RULES.md`](RULES.md).

## 6. Auth / admin model (Implemented)

- **Auth.js (`next-auth` v5)** with a **single commissioner/admin login** for v1, using the
  split-config pattern: `src/auth.config.ts` is edge-safe (used by middleware) and `src/auth.ts`
  adds the Credentials provider (Node runtime, uses `bcryptjs`). Sessions are stateless JWTs.
- The admin email is `ADMIN_EMAIL` and the password is stored as a **bcrypt hash** in
  `ADMIN_PASSWORD_HASH` (never the plaintext; generate with `npm run admin:hash -- "<password>"`).
- **`middleware.ts`** gates `/admin/*` (except `/admin/login`) via the `authorized` callback,
  redirecting unauthenticated requests to the login page. Every admin Server Action additionally
  calls `requireAdmin()` (`src/lib/auth-helpers.ts`) as defense in depth.
- **Additional admins** can be added without a redeploy via the `users` table
  (`npm run admin:create`, or Admin → Users). The env bootstrap admin
  (`ADMIN_EMAIL` / `ADMIN_PASSWORD_HASH`) is **not** stored there and always works as a fallback,
  so the commissioner can sign in before any rows exist.
- **Per-owner logins are a deliberate later follow-up**, not part of v1.

`npm run admin:hash` (`scripts/hash-password.ts`) generates the bcrypt hash for
`ADMIN_PASSWORD_HASH`; see [`DEPLOYMENT.md` §5](DEPLOYMENT.md#5-admin-password-hash).

## 7. DraftKings scoring pipeline (Implemented — via the browser extension)

> **What actually runs today:** the **Chrome extension** (`extension/`) reads the shared private
> contest leaderboard from the commissioner's logged-in DraftKings session and POSTs it to
> `POST /api/ingest/draftkings` (bearer `INGEST_TOKEN`), which matches entries to owners and
> upserts `scores` via `src/lib/scores/ingest.ts`. The `week` field accepts a regular/playoff week
> (`1–25`) **or** a preseason exhibition week (`101–103`), which is how preseason games are scored
> — see [`DRAFTKINGS.md` §10](DRAFTKINGS.md#10-the-ingest-endpoint-implemented) for the full
> contract and [`extension/README.md`](../extension/README.md) for the operator's guide.

The originally designed **server-side cron pull** below was **not** built — there is no
`/api/cron/pull` route and no `src/lib/dk` module, and `DK_SESSION_COOKIE` is unused. It is kept
here because it remains the shape any future unattended pull would take:

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
caveats, and mitigations — including [§11](DRAFTKINGS.md#11-endpoint-inventory--what-is-public-and-what-needs-auth),
the probed inventory of which DK endpoints work without a session.

A separate path shows points *while games are in progress*. It has its own tables and is
**read-only with respect to this pipeline** — it never writes `scores` — see
[§9](#9-live-in-progress-scoring-built).

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
| `playoff_odds_snapshots` | Monte-Carlo playoff odds per owner-week, for the trend chart.     |
| `model_snapshots`   | Lineup-model recommendations + their graded results.                  |
| `users`             | Admin logins for the commissioner panel (separate from `owners`).     |
| `lineup_snapshots`  | Captured DK rosters for the live **estimate** — append-only, versioned. Never a score. |
| `lineup_capture_runs` | Audit log of each roster capture, incl. which DK URL worked.        |

Full column-level detail is in [`DATA_MODEL.md`](DATA_MODEL.md). The two `lineup_*` tables arrived
in migration `0010`, which is applied — see [§9](#9-live-in-progress-scoring-built).

## 9. Live in-progress scoring (built)

> **Shipped (Phases 0–5):** a pure DraftKings scoring engine and a public-ESPN stat adapter under
> `src/lib/dfs/`; roster capture and storage under `src/lib/lineups/` (`POST /api/ingest/lineups`
> + Admin → Lineups), fed by the Chrome extension's single **Sync** button (v1.3.0); and the join
> + read model under `src/lib/live/`, rendered by **`/live`** and **`/live/[matchupId]`**. It is
> still an **estimate** — DraftKings' leaderboard remains the sole authority for `scores`. Full
> detail — [`SCORING.md` §15](SCORING.md#15-live-in-progress-scoring-an-estimate-never-a-score).

The scoring pipeline in [§7](#7-draftkings-scoring-pipeline-implemented--via-the-browser-extension)
needs the commissioner's browser, so a week's *official* numbers only move when someone syncs. The
in-progress path breaks that dependency: capture each owner's DK **roster** from that same browser
(a few times a week — DK Classic allows late swap, so captures are versioned rather than
overwritten), then recompute the points server-side from ESPN's public boxscore API — no DK session
on the server, no cron, **machine can be off in between**. That asymmetry is the whole design:
authenticate once for *who was started*, then compute all week from public data.

```text
WHO THEY STARTED (authenticated, re-captured)        WHAT THEY DID (public, recomputed on demand)

DraftKings roster payload  (1 request per entry)     ESPN summary API (keyless — accept header
      │  POST /api/ingest/lineups                          ONLY, never a user-agent)
      │  or Admin → Lineups paste                          │  src/lib/dfs/sources/espn-boxscore.ts
      │  src/lib/lineups/normalize.ts  (pure, structural)  │     fetchGameSummary(id, ttlSeconds)
      │  src/lib/lineups/enrich.ts     (draftableId →      │
      │                                 name/team/pos)     │
      │  src/lib/lineups/ingest.ts     (owner matching)    ▼
      ▼                                              EspnSummaryResponse
lineup_snapshots  (append-only, newest wins)               │  src/lib/dfs/sources/espn-extract.ts
lineup_capture_runs  (audit)                               │     extractGame  (pure)
      │  src/lib/lineups/query.ts  getCaptureStatus        ▼
      │                                              PlayerStatLine / DstStatLine
      └──────────────────┬─────────────────────────────────┘   (src/lib/dfs/stat-line.ts)
                         ▼
        src/lib/live/stats.ts    the week's stat index, keyed (normalizeName, teamKey)
                                 unstable_cache, 30s — ONE fan-out serves every viewer
                         ▼
        src/lib/live/assemble.ts assembleLive(matchups, snapshots, index)  (pure)
        src/lib/dfs/score.ts     scorePlayer / scoreDst / scoreLineup      (pure)
        src/lib/dfs/rules.ts     DK_CLASSIC_NFL  (frozen rule data)
                         ▼
        /live  and  /live/[matchupId]
            an ESTIMATE — displayed only, never written to `scores`
```

The join between the two halves — matching a captured DK player to an ESPN athlete — is
`playerStatKey(name, teamKey)` in `src/lib/live/stats.ts`. Both parts are mandatory: name alone
collides on real players league-wide. DK's roster payload names nobody and no team, only a
`draftableId`, so `enrich.ts` resolves that against the **public** draftables endpoint at capture
time (DK expires draftables for old draft groups, so a snapshot must stand alone). That is what puts
the `(name, teamKey)` pair on the snapshot the index matches against.

`assembleLive` is **pure** — no DB, no network, no clock — which is what makes the display rules
unit-testable. The rule that matters: **a slot we could not score is never rendered as `0.00`.**
Zero is a real DraftKings result, so the five slot states (`scored`, `pending`, `concealed`,
`noStats`, `unresolved`) keep "he scored nothing" apart from "we don't know", and a team total is a
floor with the reason attached. Full rationale, including why `noStats` is its own state, is in
[`SCORING.md` §15](SCORING.md#the-five-slot-states--the-load-bearing-concept).

Three architectural constraints, all deliberate:

- **The estimate cannot enter the scoring chain.** `src/lib/dfs/` imports no database and no
  `src/lib/standings/`, so the module graph forbids it outright. The capture path *does* need the
  database, so it is fenced by a test instead: `src/lib/lineups/no-write.test.ts` scans every module
  under `src/lib/dfs`, `src/lib/lineups` and `src/lib/live` — **and the `src/app/live` route**,
  since a server component can reach the database directly — and fails on any write to `scores`,
  `matchups`, `playoff_matchups`, `season_awards` or `nfl_games`. Reads are allowed; writes are not.
  DraftKings' leaderboard remains the sole authority for `scores`.
- **The engine is pure and the rule set is data**, so both are exhaustively unit-tested (63 tests)
  and DK's published rules can be diffed against `rules.ts` by eye.
- **The adapter is source-agnostic.** `stat-line.ts` names its fields after DraftKings' rules, not
  ESPN's JSON, so a second provider can feed the same engine without touching `score.ts`.

`src/lib/nfl/team-keys.ts` holds the one `normalizeTeamKey()` — it existed as three private copies
(DraftKings draftables, Sleeper players, and the live-scoring stat adapters) and was pulled up
here. Drift between copies silently fails to join a player to their stats or their salary, and
surfaces as a mysterious zero rather than an error. Our canonical keys follow ESPN's
abbreviations, so ESPN input is a pass-through; the fixups cover DK's `JAC`/`WAS`, Sleeper's
`WAS`, and the historical relocations.

`npm run dfs:selftest` validates the engine across a whole week against Sleeper's independently
computed `pts_ppr`. Cross-source caveats (including why Sleeper cannot be the live feed) are in
[`DRAFTKINGS.md` §11](DRAFTKINGS.md#11-endpoint-inventory--what-is-public-and-what-needs-auth).

On the capture side, two shapes are worth knowing before touching it:

- **`lineup_snapshots` is append-only, versioned by `capturedAt`.** DK Classic allows late swap, so
  the roster in effect is the *newest* row per `(ownerSeason, week)` — one `DISTINCT ON` in
  `src/lib/lineups/query.ts`. Collapsing it to one row per owner-week would delete the history the
  feature runs on.
- **The normalizer is deliberately shape-agnostic.** `src/lib/lineups/normalize.ts` finds roster
  rows structurally instead of by path, because DK's roster endpoint is undocumented — the same
  technique the extension's leaderboard extractor uses, and the reason a raw DK payload can be
  posted (or pasted) verbatim.
- **Capture is a fan-out, and half of it is invisible.** DraftKings has no bulk roster endpoint (the
  `embed=leaderboard,roster` form returns 200 with an empty map), so the extension issues one
  authenticated request per entry. DK also *conceals* each player until their game kicks off, so a
  complete 32/32 capture routinely stores mostly nameless slots. That is expected: a concealed player
  has scored nothing, so only names are missing, never points — and anyone visible is already locked
  past late swap. `revealed` is stored per slot so no UI can render a concealed player as `0.00`.

Auth and week validation are **shared with the score ingest**, not duplicated:
`src/lib/ingest/{auth,week-schema}.ts`, extracted from the DraftKings route with no behaviour
change. Owner-name matching is shared too (`src/lib/scores/owner-match.ts`) — if the two ingests
ever resolved a DK entry name differently, an owner's roster and their score would land on
different rows.
