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
  gets a bye, and the bracket reseeds each round.

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
| External data  | ESPN unofficial scoreboard API (NFL schedule)               |
| Scoring source | DraftKings unofficial API (Planned, Phase 3)                |
| Hosting / cron | Vercel + Vercel Cron                                         |
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
| `npm run odds:compute`   | `tsx scripts/compute-odds.ts` | Monte-Carlo playoff-odds snapshots for the `/playoffs` trend chart.     |
| `npm run verify`         | `tsx scripts/verify.ts`       | **Full verification gate** — typecheck · lint · tests · production build · ESPN health · engine invariants · 2025 ground-truth replay. Exits non-zero on any failure. |
| `npm run verify:quick`   | `tsx scripts/verify.ts --quick`| Same, minus the slow build + ground-truth replay (no DB writes).       |
| `npm run verify:ground-truth` | `tsx scripts/import-season3.ts` | Replay the 2025 season vs the league's published standings.        |
| `npm run import:season`  | `tsx scripts/import-season.ts` | Backfill a season's regular season from its Google Sheet (`--year --sheet --name`). |
| `npm run import:playoffs`| `tsx scripts/import-playoffs.ts`| Backfill a season's playoff bracket from its sheet (`--season --sheet`).             |
| `npm run models:snapshot`| `tsx scripts/models.ts --action=snapshot` | Snapshot the 3 lineup models for a week (`--season --week`).               |
| `npm run models:grade`   | `tsx scripts/models.ts --action=grade` | Grade a week's model snapshots vs actual player results.                      |

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
│  ├─ ARCHITECTURE.md
│  ├─ DATA_MODEL.md
│  ├─ DRAFTKINGS.md
│  ├─ DEPLOYMENT.md
│  └─ NEXTJS16_NOTES.md
├─ scripts/
│  └─ pull-schedule.ts          # CLI: ESPN schedule sync + matchup generation
├─ src/
│  ├─ app/                      # Next.js App Router (layout, page, globals.css)
│  ├─ db/
│  │  ├─ index.ts               # Drizzle/Neon client (Node runtime only)
│  │  ├─ schema.ts              # The data model (single source of truth)
│  │  └─ seed/                  # Seed data: 32 NFL teams + current season
│  └─ lib/
│     ├─ espn/                  # ESPN scoreboard client + types
│     ├─ schedule/              # syncSeasonSchedule → upserts nfl_games
│     ├─ matchups/              # generateMatchups → derives matchups from nfl_games
│     ├─ standings/             # Pure standings/seeding/tiebreaker engine + types
│     ├─ playoffs/              # Bracket service (generate/advance/read)
│     ├─ rules/                 # Per-season rules schema + defaults (seasons.rules)
│     ├─ players/               # Lineup builder: Sleeper/ESPN signals, recommend, optimize, models, performance
│     ├─ draftkings/            # DK draftables (salaries) client + Sleeper matcher
│     └─ utils.ts               # cn(), formatPoints(), formatMoney(), winPct()
├─ drizzle.config.ts
├─ .env.example
└─ package.json
```

## Status / roadmap

| Phase  | Scope                                                                  | Status                                                                                          |
| ------ | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **P0** | Scaffold + deploy (Next 16, Tailwind v4, Vercel)                      | **Done.** Deployed on Vercel, auto-deploy from `main`; KeyLehr branding + landing dashboard.    |
| **P1** | Data model + admin panel + schedule auto-pull + matchup generation    | **Done.** Schema, seed, ESPN sync (batched upserts), matchup generation, and the commissioner admin panel (assignments, owners, users, settings, schedule, playoffs, sync, data-status) with NextAuth login. |
| **P2** | Public pages                                                          | **Done.** Dashboard, Standings, Playoffs (picture + odds chart + bracket), History, **Rules (rules-driven)**, and the **per-team My Team dashboard**. Mobile-friendly. |
| **P3** | DraftKings scoring pipeline + manual fallback                        | **Done.** Ingest API + the **Chrome extension** (live sync) feed `scores`; standings/seeding honor the season's configured rules. |
| **P4** | Playoffs / history                                                    | **Done.** Config-driven seeding + bracket, history/all-time pages, playoff-odds Monte-Carlo.    |
| **P5** | Migrate prior season(s) from the Google Sheet                         | **Done for 2023–2025** (regular season **and** playoff brackets) — `import-season3.ts` (2025, the verify anchor) + the generic `import-season.ts` / `import-playoffs.ts`. Each validates against the published sheets. |
| **P6** | My Team Phase B — lineup builder + player news                        | **Done.** Free Sleeper/ESPN signals, 3 risk models, **DraftKings salary + $50k cap optimization**, a player-news strip, and a **model-performance tracker** (Admin → Models) that the models will train into ML v1.0 from. |
| **Next** | —                                                                   | Rebuild is feature-complete vs the Sheets workflow; no task queued. See [`docs/HANDOFF.md`](docs/HANDOFF.md). |

## Documentation

- [`docs/HANDOFF.md`](docs/HANDOFF.md) — **current state, what's next, and gotchas — start here.**
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system architecture and data flow.
- [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) — every table, constraint, and relationship.
- [`docs/DRAFTKINGS.md`](docs/DRAFTKINGS.md) — the DraftKings scoring pipeline design.
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — deploying to Vercel + Neon, env vars, cron.
- [`docs/NEXTJS16_NOTES.md`](docs/NEXTJS16_NOTES.md) — Next.js 16 conventions and gotchas.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — dev workflow, conventions, and migrations.
