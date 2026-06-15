# Contributing

Guidelines for developing KeyLehr H2H. Keep changes accurate to the code; this is a small,
single-maintainer project, so favor clarity over ceremony.

## Prerequisites & setup

See the [Quick start in the README](README.md#quick-start). In short: Node 20+, npm, a Neon
database, `cp .env.example .env.local`, then `npm install` → `db:migrate` → `db:seed` → `dev`.

## Dev workflow

1. Create a branch off the default branch for your change.
2. Make the change. Keep modules focused — mirror the existing `src/lib/<domain>/` layout.
3. Run the checks below locally before opening a PR.
4. Open a PR with a clear description; link the phase (P0–P5) it advances if relevant.

```bash
npm run dev          # local server at http://localhost:3000
npm run typecheck    # tsc --noEmit — must pass
npm run lint         # eslint (eslint-config-next) — must pass
npm run test         # vitest run
```

> There is **no test suite yet** (no `*.test.ts` files exist), but Vitest is configured and the
> `src/lib/` modules (especially the pure `standings` engine) are written to be unit-testable.
> New logic in `src/lib/` should ship with tests; place them next to the code as `*.test.ts`.

## Code style & conventions

- **TypeScript, strict.** Let `tsc` and ESLint guide you; don't suppress errors without reason.
- **Read [`docs/NEXTJS16_NOTES.md`](docs/NEXTJS16_NOTES.md) before writing routes/components.**
  Next.js 16 has breaking changes vs 13/14. The top gotchas:
  - `params` / `searchParams` are **Promises** — always `await`.
  - `cookies()` / `headers()` / `draftMode()` are **async**.
  - `fetch()` is **not** cached by default; opt in explicitly.
  - **No `tailwind.config.js`** — Tailwind v4 config lives in CSS via `@theme` in `globals.css`.
  - The **Edge runtime cannot run the DB client** — keep anything touching Postgres/Neon on the
    **Node.js runtime**.
  - Server Components are the default and may be `async`; add `'use client'` only for
    state/effects/handlers/browser APIs, and pass only serializable data across the boundary.
- **Database access is server-only.** Import `@/db` (and anything from `src/lib/schedule`,
  `src/lib/matchups`) only from Server Components, Server Actions, Route Handlers, or `tsx`
  scripts — **never** from a `'use client'` module or an Edge route. `src/db/index.ts` documents
  this; respect it.
- **Pure logic stays pure.** `src/lib/standings/` must remain DB-decoupled (no schema/ORM
  imports) so it stays fast and testable. Load rows in the caller and pass plain shapes in.
- **Schema casing.** Schema keys are camelCase; DB columns are `snake_case` (auto-mapped via
  `casing: 'snake_case'`). In raw SQL fragments (e.g. `excluded.<column>` in upserts) use the
  **snake_case** column name.
- **Money is cents**, **points are `numeric` (surfaced as strings)**. Use the helpers in
  `src/lib/utils.ts` (`formatMoney`, `formatPoints`, `winPct`, `cn`) rather than reformatting
  inline.
- **Idempotency.** Sync/generation/seed code is written to be safely re-runnable via upserts on a
  stable unique key. Preserve that property when extending it.
- **Use inferred types** from `@/db` (`Season`, `NewScore`, etc.) instead of redefining row shapes.

## Environment variables

- Server-only vars are plain (`DATABASE_URL`); only `NEXT_PUBLIC_*` reach the client. Secrets live
  in `.env.local` (git-ignored). Add any new var to [`.env.example`](.env.example) (blank/sample
  value) and document it in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Adding a database migration

The schema in [`src/db/schema.ts`](src/db/schema.ts) is the single source of truth. drizzle-kit
generates SQL migrations from it.

```bash
# 1. Edit src/db/schema.ts (add/alter tables, columns, enums, indexes).
# 2. Generate a migration from the change:
npm run db:generate          # writes a new drizzle/NNNN_*.sql + updates drizzle/meta

# 3. Review the generated SQL in drizzle/ — confirm it does what you intend.

# 4. Apply it to your dev database:
npm run db:migrate           # applies pending migrations to DATABASE_URL

# 5. Commit BOTH the schema change and the generated drizzle/ files together.
```

Notes:

- During fast iteration on a throwaway dev DB you may use `npm run db:push` to sync the schema
  without a migration file. **Always** generate a real migration (`db:generate`) before merging
  schema changes so production stays versioned — never `db:push` to production.
- `npm run db:studio` opens Drizzle Studio to inspect data while developing.
- If you add a new table that owners' data hangs off of, follow the existing pattern: cascade from
  `seasons`, reference `owner_seasons` (not `owners`) for per-season ownership, and add the
  appropriate unique index for idempotent upserts. See [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md).
- Update [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) when you change the schema.

## Branch & commit guidance

- Branch per change; do not commit directly to the default branch.
- Write imperative, scoped commit messages (e.g. `schedule: skip TBD kickoff dates`).
- Keep schema changes and their generated `drizzle/` migration in the same commit.
- Keep PRs small and focused on one phase/feature where practical.

## Where things live

| Area                              | Path                          |
| --------------------------------- | ----------------------------- |
| Data model (source of truth)      | `src/db/schema.ts`            |
| DB client (Node-only)             | `src/db/index.ts`             |
| Seed data                         | `src/db/seed/`                |
| ESPN client + types               | `src/lib/espn/`               |
| Schedule sync                     | `src/lib/schedule/sync.ts`    |
| Matchup generation                | `src/lib/matchups/generate.ts`|
| Standings engine (pure)           | `src/lib/standings/`          |
| Shared helpers                    | `src/lib/utils.ts`            |
| CLI: schedule pull + matchups     | `scripts/pull-schedule.ts`    |
| Migrations                        | `drizzle/`                    |

For architecture and the planned admin/auth and DraftKings work, see
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/DRAFTKINGS.md`](docs/DRAFTKINGS.md).
