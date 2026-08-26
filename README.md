# KeyLehr H2H

A boutique, 32-owner head-to-head Daily Fantasy Football league app — a rebuild of an
existing Netlify + Google Sheets app into a Vercel web app with an **automated DraftKings
scoring pipeline** that replaces manual Google Sheets entry.

## The league concept

- **32 owners, one season.** Each owner is assigned exactly one NFL team for the season and
  plays that team's real NFL schedule.
- **Weekly scoring is DFS, not the NFL game.** Each week, an owner's score is the fantasy
  points of their DraftKings DFS lineup — _not_ the NFL team's result. The NFL schedule only
  decides **who plays whom** each week.
- **Head-to-head.** If your NFL team faces another owner's NFL team that week, you face that
  owner. Higher DFS points wins. Records are tracked as **W-L-T** with **Points For / Points
  Against**. A bye week (your NFL team is idle) means no matchup that week.
- **Tiebreakers:** head-to-head record → Points For → Points Against.
- **Playoffs mirror the NFL:** 4 division winners + 3 wild cards per conference, the #1 seed
  gets a bye, and the bracket reseeds each round. In championship week the two beaten conference
  finalists also play a **consolation game** that decides 3rd and 4th.

For the deeper design, see the docs linked below.

## Tech stack

| Concern        | Choice                                                        |
| -------------- | ------------------------------------------------------------ |
| Framework      | Next.js 16 (App Router, TypeScript), React 19                |
| Styling        | Tailwind CSS v4 (CSS-based config, no `tailwind.config.js`)  |
| Database       | Neon (serverless Postgres)                                   |
| ORM / migrate  | Drizzle ORM + drizzle-kit (`snake_case` casing)             |
| Auth           | Auth.js (`next-auth` v5 beta) — single commissioner login    |
| Validation     | Zod                                                          |
| External data  | ESPN unofficial APIs — scoreboard (NFL schedule) + summary/boxscore (live scoring estimate) |
| Scoring source | DraftKings unofficial leaderboard API, read by the Chrome extension in `extension/` |
| Hosting        | Vercel (auto-deploy from `main`). **No cron:** the weekly score sync is a manual, in-browser step — there is no `vercel.json` and no cron route. See [`docs/RUNBOOK.md`](docs/RUNBOOK.md). |
| Tests          | Vitest                                                       |

> Database access runs on the **Node.js runtime** only. The Neon serverless driver and the
> Drizzle client must never be imported into a `'use client'` module or an Edge route. See
> [`docs/NEXTJS16_NOTES.md`](docs/NEXTJS16_NOTES.md).

## Prerequisites

- **Node.js 20+** (matches `@types/node` ^20; Next.js 16 requires a modern Node).
- **npm** (the repo ships a `package-lock.json`).
- A **Neon** Postgres database (free tier is fine) — <https://console.neon.tech>.

## Quick start

```bash
# 1. Clone and install
git clone <repo-url> keylehr-h2h
cd keylehr-h2h
npm install

# 2. Configure environment
cp .env.example .env.local
#   Edit .env.local and set at least DATABASE_URL (your Neon connection string).
#   See docs/DEPLOYMENT.md for what every variable is for.

# 3. Create the schema in your database
npm run db:generate     # generate SQL migrations from src/db/schema.ts (already committed)
npm run db:migrate      # apply migrations to DATABASE_URL
npm run db:seed         # seed the 32 NFL teams + the current season

# 4. (Optional) pull the NFL schedule and generate matchups
npm run schedule:pull   # uses the active/upcoming season; or: npm run schedule:pull -- --year=2026

# 5. Run the app
npm run dev             # http://localhost:3000
```

> `db:generate` only needs to be re-run when you change `src/db/schema.ts`; the initial
> migration (`drizzle/0000_*.sql`) is already committed, so a fresh checkout can go straight
> to `db:migrate`. During early development you can use `npm run db:push` to sync the schema
> without writing a migration file (see [CONTRIBUTING.md](CONTRIBUTING.md)).

## npm scripts

| Script                   | Command                       | Purpose                                                                 |
| ------------------------ | ----------------------------- | ----------------------------------------------------------------------- |
| `npm run dev`            | `next dev`                    | Start the local dev server.                                             |
| `npm run build`          | `next build`                  | Production build.                                                       |
| `npm run start`          | `next start`                  | Serve a production build locally.                                       |
| `npm run lint`           | `eslint`                      | Lint with `eslint-config-next`.                                         |
| `npm run typecheck`      | `tsc --noEmit`                | Type-check the whole project.                                           |
| `npm run test`           | `vitest run`                  | Run the test suite once.                                                |
| `npm run test:watch`     | `vitest`                      | Run tests in watch mode.                                                |
| `npm run db:generate`    | `drizzle-kit generate`        | Generate SQL migrations from the schema.                                |
| `npm run db:migrate`     | `drizzle-kit migrate`         | Apply pending migrations to `DATABASE_URL`.                             |
| `npm run db:push`        | `drizzle-kit push`            | Push the schema directly (dev convenience, no migration file).          |
| `npm run db:studio`      | `drizzle-kit studio`          | Open Drizzle Studio (DB browser).                                       |
| `npm run db:seed`        | `tsx src/db/seed/index.ts`    | Seed NFL teams + the current season (idempotent).                       |
| `npm run admin:hash`     | `tsx scripts/hash-password.ts`| Hash an admin password for `ADMIN_PASSWORD_HASH`.                       |
| `npm run admin:create`   | `tsx scripts/create-admin.ts` | Create/update a commissioner login in the `users` table.                |
| `npm run schedule:pull`  | `tsx scripts/pull-schedule.ts`| Pull the NFL schedule from ESPN and generate owner matchups.            |
| `npm run team:meta`      | `tsx scripts/update-team-meta.ts` | Backfill the `nfl_teams` branding columns (colors + logo URLs).     |
| `npm run odds:compute`   | `tsx scripts/compute-odds.ts` | Monte-Carlo playoff-odds snapshots for the `/playoffs` trend chart.     |
| `npm run verify`         | `tsx scripts/verify.ts`       | **Full verification gate (9 checks)** — typecheck · lint · tests · production build · ESPN health · engine invariants · frozen-season snapshot · engine no-op proofs · 2025 ground-truth replay. Exits non-zero on any failure. |
| `npm run verify:quick`   | `tsx scripts/verify.ts --quick`| Same, minus the slow build + ground-truth replay (no DB writes).       |
| `npm run verify:ground-truth` | `tsx scripts/import-season3.ts` | Replay the 2025 season vs the league's published standings.        |
| `npm run snapshot:standings` | `tsx scripts/snapshot-standings.ts` | **Read-only.** Print what the engine currently derives for the frozen seasons (records, ranked order, seeds, awards). |
| `npm run verify:baseline`| `tsx scripts/snapshot-standings.ts --write` | **Re-baseline** `scripts/fixtures/standings-baseline.json`. Needs sign-off — 2023–2025 are frozen. See [`docs/RUNBOOK.md`](docs/RUNBOOK.md#6-the-snapshot-gate). |
| `npm run import:season`  | `tsx scripts/import-season.ts` | Backfill a season's regular season from its Google Sheet (`--year --sheet --name`). |
| `npm run import:playoffs`| `tsx scripts/import-playoffs.ts`| Backfill a season's playoff bracket from its sheet (`--season --sheet`).             |
| `npm run playoffs:import-2025` | `tsx scripts/import-playoffs-2025.ts` | The 2025-specific bracket importer (hardcoded validation); kept alongside the generic one. |
| `npm run import:awards`  | `tsx scripts/import-awards.ts` | Recompute `season_awards` (champion, runner-up, 3rd/4th from the consolation game, weekly/season high, most points) + payouts. `-- --dry-run` previews; `--season=`, `--force`; `--third=` is a legacy fallback for seasons with no consolation game on record (2023–2025). |
| `npm run models:snapshot`| `tsx scripts/models.ts --action=snapshot` | Snapshot the 3 lineup models for a week (`--season --week`).               |
| `npm run models:grade`   | `tsx scripts/models.ts --action=grade` | Grade a week's model snapshots vs actual player results.                      |
| `npm run dfs:selftest`   | `tsx scripts/dfs-selftest.ts` | Check the DraftKings scoring engine (`src/lib/dfs/`) across a whole week against Sleeper's independently computed PPR. Network only, no DB writes. `-- --year=2025 --week=4 [--verbose]`; defaults to 2025 week 1. Exits non-zero above a 5% unexplained rate. |
| `npm run live:check`     | `tsx scripts/live-check.ts`   | Score every **in-progress** NFL game straight from ESPN and print the top DK scorers — the same engine `/live` uses, without the DB or any captured roster. Network only, no auth, no DB. `-- --watch` polls until the stats move (proving ESPN updates live); `-- --event=<espnId>`, `-- --seasontype=<1\|2>`. |

> **Run `npm run verify` before pushing.** Its production `build` step catches production-only
> errors (e.g. invalid `'use server'` exports) that `dev`, `typecheck`, and `lint` all let through —
> exactly the class of bug that can silently block a Vercel deploy.

## Project structure

```text
DailyFantasy/
├─ drizzle/                     # Generated SQL migrations + drizzle-kit metadata
│  ├─ 0000_*.sql
│  └─ meta/
├─ docs/                        # Project documentation (this folder)
│  ├─ HANDOFF.md                # Current state + gotchas — start here
│  ├─ SCORING.md                # Ingest → byes → forfeits → standings → seeds
│  ├─ RULES.md                  # Every per-season rule key
│  ├─ RUNBOOK.md                # The commissioner's weekly loop
│  ├─ ARCHITECTURE.md
│  ├─ DATA_MODEL.md
│  ├─ DRAFTKINGS.md
│  ├─ DEPLOYMENT.md
│  └─ NEXTJS16_NOTES.md
├─ extension/                   # Chrome extension (MV3): DK leaderboard → /api/ingest/draftkings, DK rosters → /api/ingest/lineups
├─ scripts/
│  ├─ pull-schedule.ts          # CLI: ESPN schedule sync + matchup generation
│  ├─ dfs-selftest.ts           # CLI: DK scoring engine vs Sleeper PPR, a whole week at a time
│  ├─ live-check.ts             # CLI: score in-progress games from ESPN (the /live engine, no DB)
│  └─ fixtures/                 # Frozen ESPN + DK payloads, and the standings baseline (verify's snapshot gate)
├─ src/
│  ├─ app/                      # Next.js App Router (layout, page, globals.css)
│  ├─ db/
│  │  ├─ index.ts               # Drizzle/Neon client (Node runtime only)
│  │  ├─ schema.ts              # The data model (single source of truth)
│  │  └─ seed/                  # Seed data: 32 NFL teams + current season
│  └─ lib/
│     ├─ espn/                  # ESPN scoreboard client + types (regular + preseason seasonType)
│     ├─ dfs/                   # Pure DK Classic scoring engine + ESPN boxscore adapter (live ESTIMATE only)
│     ├─ lineups/               # DK roster capture: normalize → ingest → query (+ the no-write guard test)
│     ├─ live/                  # /live read model: stats.ts (cached ESPN index) → assemble.ts + staleness.ts + minutes.ts + projection.ts + reconcile.ts (all pure) → query.ts + reconcile-query.ts (reads only)
│     ├─ ingest/                # auth.ts + week-schema.ts — shared by both ingest endpoints
│     ├─ nfl/                   # team-keys.ts — the one provider-abbreviation → nfl_teams.key normalizer
│     ├─ schedule/              # syncSeasonSchedule → upserts nfl_games; current-week.ts = which week is it (pure) + current-week-query.ts; preseason.ts = week-namespace helpers (isolation only)
│     ├─ matchups/              # generateMatchups → derives matchups from nfl_games
│     ├─ scores/                # DK leaderboard ingest + the admin sync-status query
│     ├─ standings/             # Pure standings/seeding/tiebreaker engine + the DB adapter (query.ts)
│     ├─ awards/                # Pure payout computation + the persistence service
│     ├─ playoffs/              # Bracket service (generate/advance/read)
│     ├─ rules/                 # Per-season rules schema + defaults (seasons.rules)
│     ├─ players/               # Lineup builder: Sleeper/ESPN signals, recommend, optimize, models, performance
│     ├─ draftkings/            # DK draftables (salaries) client + Sleeper matcher
│     ├─ history.ts             # All-time analytics for /history (excludes exhibition rows)
│     └─ utils.ts               # cn(), formatPoints(), formatMoney(), winPct()
├─ drizzle.config.ts
├─ .env.example
└─ package.json
```

## Status / roadmap

| Phase  | Scope                                                                  | Status                                                                                          |
| ------ | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **P0** | Scaffold + deploy (Next 16, Tailwind v4, Vercel)                      | **Done.** Deployed on Vercel, auto-deploy from `main`; KeyLehr branding + landing dashboard.    |
| **P1** | Data model + admin panel + schedule auto-pull + matchup generation    | **Done.** Schema, seed, ESPN sync (batched upserts), matchup generation, and the commissioner admin panel (assignments, owners, users, settings, schedule, **preseason**, playoffs, sync, data-status) with NextAuth login. |
| **P2** | Public pages                                                          | **Done.** Dashboard, Standings, Playoffs (picture + odds chart + bracket), History (all-time records, per-season pages, head-to-head), **Rules (rules-driven)**, the **per-team My Team dashboard**, and **Live** (`/live`, incl. exhibition weeks). Mobile-friendly. `/cohens-corner` ships as a routed **placeholder** ("coming soon") — content pending. |
| **P3** | DraftKings scoring pipeline + manual fallback                        | **Done.** Ingest API + the **Chrome extension** (live sync) feed `scores`; standings/seeding honor the season's configured rules. |
| **P4** | Playoffs / history                                                    | **Done.** Config-driven seeding + bracket, history/all-time pages, playoff-odds Monte-Carlo.    |
| **P5** | Migrate prior season(s) from the Google Sheet                         | **Done for 2023–2025** (regular season **and** playoff brackets) — `import-season3.ts` (2025, the verify anchor) + the generic `import-season.ts` / `import-playoffs.ts`. Each validates against the published sheets. |
| **P6** | My Team Phase B — lineup builder + player news                        | **Done.** Free Sleeper/ESPN signals, 3 risk models, **DraftKings salary + $50k cap optimization**, a player-news strip, and a **model-performance tracker** (Admin → Models) that the models will train into ML v1.0 from. |
| **P7** | Preseason exhibition games                                            | **Retired — creation removed, isolation permanent.** The league decided it doesn't want exhibitions, so `ed6ef78` removed the public `/preseason` page, Admin → Preseason and `syncPreseasonWeek`: **no new exhibition week can be created.** The `isExhibition` namespace (`week = 100 + preseasonWeek`, weeks `101–103`) **stays**, because exhibition rows exist in the DB and that isolation is what keeps them out of standings, seeding, playoffs, payouts and all-time records. Existing exhibition weeks still render on **`/live`** and can still be scored via the extension's **Preseason** toggle. |
| **P8** | Live-scoring remediation + freeze gate                                 | **Done.** Byes derived from the NFL schedule, missed lineups derived at read time behind a settled-week gate, win%-only tiebreaker cohorts, deterministic tie-splitting payouts, and `/history` routed through the engine — all behind a snapshot gate that proves 2023–2025 never move. See [`docs/SCORING.md`](docs/SCORING.md). |
| **P9** | Live in-progress scoring (an estimate, never a score)                  | **Done — Phases 0–5.** A pure, tested DK Classic engine fed by ESPN's public boxscore API (`src/lib/dfs/`), roster capture + storage (`src/lib/lineups/`, `POST /api/ingest/lineups`, **Admin → Lineups**), and the join + read model (`src/lib/live/`) behind **`/live`** and **`/live/[matchupId]`** — all behind a test that mechanically forbids the live path from writing a score. The Chrome extension (v1.3.0) posts scores **and** rosters from one **Sync** click. Because rosters are captured once and scoring comes from ESPN's keyless boxscore, `/live` keeps moving with every machine switched off. Reconciled against DraftKings' own numbers on a real capture at **max \|delta\| 0.00**. The computed figure is still an estimate: DraftKings' leaderboard stays the sole authority for `scores`. See [`docs/SCORING.md` §15](docs/SCORING.md#15-live-in-progress-scoring-an-estimate-never-a-score).<br><br>**Since then:** **minutes remaining** from ESPN's game clock, **projected finals** using DraftKings' own formula (`score + pregame × minutesLeft/60`, reverse-engineered exactly from captured samples), and a **win-probability estimate** — with `/live` ordered by closeness rather than matchup id. Plus schedule-derived **week detection** (`GET /api/current-week`), so a contest can no longer be synced against the wrong week and silently overwrite it.<br><br>**And since that:** the extension's **Live Sync** loop (v1.5.0) now refreshes rosters too, but only when `GET /api/live-status` says a kickoff has revealed players the estimate is missing — plus always on the final poll. Rosters cost one credentialed request *per entry* and are stored append-only, so refreshing them every poll would be ~4,000 requests and ~250 MB/season for no extra freshness. And **Admin → Scoring** audits the whole thing: every captured player's ESPN-derived score against DraftKings' own, from `dkScore`/`dkStats` that captures already store — read-only, no new table, computed on demand. It reproduces the hand-done 0.00 reconciliation automatically. |
| **Next** | Settle `pointsAllowedMode` empirically from `dkStats`                | Otherwise the rebuild is feature-complete vs the Sheets workflow. See [`docs/HANDOFF.md`](docs/HANDOFF.md). |

## Documentation

- [`docs/HANDOFF.md`](docs/HANDOFF.md) — **current state, what's next, and gotchas — start here.**
- [`docs/SCORING.md`](docs/SCORING.md) — **the scoring chain**: ingest → bye/forfeit derivation →
  standings → tiebreakers → seeding, the three week namespaces, and the settled-week rule.
  Required reading before touching `src/lib/scores/` or `src/lib/standings/`. §15 covers the
  **live in-progress estimate** and why it must never enter the chain.
- [`docs/RULES.md`](docs/RULES.md) — every per-season rule key: meaning, default, reader, editor.
- [`docs/RUNBOOK.md`](docs/RUNBOOK.md) — the commissioner's pre-season setup and weekly loop.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system architecture and data flow.
- [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) — every table, constraint, and relationship.
- [`docs/DRAFTKINGS.md`](docs/DRAFTKINGS.md) — the DraftKings scoring pipeline + the ingest endpoint contract.
- [`extension/README.md`](extension/README.md) — the DraftKings Sync Chrome extension (install, weekly + preseason syncs).
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — deploying to Vercel + Neon, env vars, migrations.
- [`docs/NEXTJS16_NOTES.md`](docs/NEXTJS16_NOTES.md) — Next.js 16 conventions and gotchas.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — dev workflow, conventions, and migrations.
