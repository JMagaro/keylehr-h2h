# Deployment

How to deploy KeyLehr H2H to **Vercel** with a **Neon** Postgres database, configure environment
variables, and run migrations against production. Weekly score syncing is a manual, in-browser
step run by the commissioner — see [`RUNBOOK.md`](RUNBOOK.md), not this document.

## 1. Create the Neon database

1. Sign in at <https://console.neon.tech> and create a project (any region close to your Vercel
   region).
2. Open **Connection Details** and copy the **pooled** connection string (recommended for
   serverless). It looks like:

   ```
   postgresql://user:password@ep-xxx-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```

3. This value is your `DATABASE_URL`.

> The app uses Neon's serverless HTTP driver on the Node.js runtime. Keep `sslmode=require`.

## 2. Environment variables

Set these in **Vercel → Project Settings → Environment Variables** (and in `.env.local` for local
dev). They mirror [`.env.example`](../.env.example).

| Variable              | Required        | What it's for                                                                                          |
| --------------------- | --------------- | ------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`        | **Yes**         | Neon Postgres connection string (pooled). The Drizzle client throws on startup if unset.               |
| `AUTH_SECRET`         | Yes (P1 auth)   | Auth.js signing secret. Generate with `openssl rand -base64 32`.                                       |
| `ADMIN_EMAIL`         | Yes (P1 auth)   | The single commissioner/admin login email for v1.                                                      |
| `ADMIN_PASSWORD_HASH` | Yes (P1 auth)   | **Bcrypt hash** of the admin password (never the plaintext). See [§5](#5-admin-password-hash).         |
| `INGEST_TOKEN`        | **Yes, to score** | Bearer token the DK Sync Chrome extension sends to `POST /api/ingest/draftkings` (and `/api/seasons`). The same token guards `POST /api/ingest/lineups` (roster capture). **Without it every sync 401s** — the server rejects all ingest when it's unset. Same value in the extension's Settings screen. See [`extension/README.md`](../extension/README.md). |
| `DK_SESSION_COOKIE`   | Unused          | Was to hold an authenticated DraftKings session for a server-side leaderboard read. **That design was rejected** — the read happens in the commissioner's browser instead, so nothing reads this variable. See [§6](#6-vercel-cron-for-the-weekly-pull--not-built). Safe to leave unset. |
| `CRON_SECRET`         | Unused          | Was to guard a Vercel Cron score-pull endpoint. **That route was never built and won't be** — see [§6](#6-vercel-cron-for-the-weekly-pull--not-built). Safe to leave unset. |
| `AUTH_URL`            | Local dev       | Base URL of the app for Auth.js v5. Set it locally (`http://localhost:3000`); **auto-detected on Vercel**, so it is optional in production. |

> **Secrets:** `.env*` files are git-ignored. Never commit `DATABASE_URL`, `AUTH_SECRET`,
> `ADMIN_PASSWORD_HASH`, `INGEST_TOKEN`, or `DK_SESSION_COOKIE`.

> **It is `AUTH_URL`, not `NEXTAUTH_URL`.** This project uses `next-auth` v5, whose variable is
> `AUTH_URL`; `.env.example` ships that name and no code reads `NEXTAUTH_URL`. If you have an
> old deployment carrying `NEXTAUTH_URL`, it is doing nothing — rename it.

## 3. Deploy to Vercel

1. Push the repo to GitHub/GitLab/Bitbucket and **Import Project** in Vercel.
2. Framework preset: **Next.js** (auto-detected). Build command `next build`, output handled by
   Vercel automatically.
3. Add the environment variables from [§2](#2-environment-variables) for the **Production** (and
   **Preview**, if desired) environments.
4. Deploy.

## 4. Run migrations against production

The schema is managed by drizzle-kit. Migrations are committed in `drizzle/`.

Run migrations against the **production** database by pointing `DATABASE_URL` at Neon and running:

```bash
# From your machine, with DATABASE_URL set to the PRODUCTION Neon URL:
npm run db:migrate     # applies committed drizzle/*.sql migrations

# Then seed the static reference data (idempotent — safe to re-run):
npm run db:seed        # 32 NFL teams + the current season
```

- `npm run db:generate` only needs to be run when `src/db/schema.ts` changes; it writes a new
  migration file you then commit. Every migration to date (`drizzle/0000_*.sql` … `0010_*.sql`)
  is already committed — see [`DATA_MODEL.md`](DATA_MODEL.md#migration-history).
- `npm run db:push` syncs the schema directly without a migration file — fine for a personal dev
  database, **not recommended for production**. Prefer `db:migrate` in production so changes are
  versioned.
- You can run these locally against prod, from a CI step, or any environment that has the
  production `DATABASE_URL`.

> **Production is through `0010`** — the two live-scoring capture tables (`lineup_capture_runs`,
> `lineup_snapshots`), applied. It is purely additive: it alters no existing table, so it moved no
> score and no standing. A dev database still on `0009` works normally except for
> `POST /api/ingest/lineups` and Admin → Lineups, which fail against the missing relations.

> Run migrations **before** the new app version serves traffic that depends on the new schema.

## 5. Admin password hash

`ADMIN_PASSWORD_HASH` must be a **bcrypt** hash, not the plaintext password. `package.json`
declares:

```bash
npm run admin:hash -- "your-password"     # → prints a bcrypt hash to paste into ADMIN_PASSWORD_HASH
```

The script (`scripts/hash-password.ts`) hashes with bcrypt (cost 12) and refuses passwords
shorter than 8 characters. Paste the printed `ADMIN_PASSWORD_HASH=...` line into `.env.local`
(local) and the Vercel env vars (production). Set `ADMIN_EMAIL` to the commissioner's email.

> The printed value is the bcrypt hash **base64-encoded**. That is deliberate: a raw bcrypt hash
> starts with `$2…`, and dotenv-expand mangles `$`-prefixed values in local `.env` files. The
> base64 form has no `$` and works everywhere. `src/auth.ts` also accepts a raw `$2…` hash, which
> is fine if you paste one straight into Vercel's env UI.

Additional admins can be added **without a redeploy** through the `users` table —
`npm run admin:create`, or Admin → Users. The env admin above always works as a fallback.

## 6. Vercel Cron for the weekly pull — not built

> **This was designed and then rejected.** There is no `vercel.json`, no `/api/cron/pull` route,
> and no `src/lib/dk` module in the repo, and none are planned. The weekly scoring contest is
> **private**, so a server cannot read its leaderboard without the commissioner's authenticated
> DraftKings session — which is why scoring runs through the **Chrome extension** in the
> commissioner's own browser instead (see [`../extension/README.md`](../extension/README.md) and
> [`DRAFTKINGS.md`](DRAFTKINGS.md)). `CRON_SECRET` and `DK_SESSION_COOKIE` are leftovers from this
> design and are read by nothing.
>
> The sketch below is kept only because it remains the shape any future unattended pull would
> take. **Do not follow it as setup instructions.**

The pull would run on a schedule via Vercel Cron, hitting a route handler guarded by
`CRON_SECRET`, configured by a `vercel.json` at the repo root:

```json
{
  "crons": [
    {
      "path": "/api/cron/pull",
      "schedule": "0 11 * * 2"
    }
  ]
}
```

- `schedule` is standard cron (UTC). The example above runs **Tuesdays at 11:00 UTC** — after a
  typical NFL week's slates have finalized. Adjust to your league's cadence.
- Vercel Cron invokes the path on your deployment. The route handler must verify the request
  against `CRON_SECRET` before doing any work:

  ```ts
  // app/api/cron/pull/route.ts  (does not exist — illustrative only)
  export async function GET(request: Request) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return new Response('Unauthorized', { status: 401 });
    }
    // ... run the DraftKings pull (see docs/DRAFTKINGS.md) ...
    return Response.json({ ok: true });
  }
  ```

  > On Vercel, cron invocations include the `CRON_SECRET` as a bearer token automatically when the
  > env var is set, so the same check works for scheduled runs and rejects everyone else. The route
  > must use the **Node.js runtime** (it touches the database).

## 7. Post-deploy checklist

- [ ] `DATABASE_URL` set (pooled Neon URL) and reachable.
- [ ] `npm run db:migrate` applied against production — currently through **`0010`**
      (see [§4](#4-run-migrations-against-production)).
- [ ] `npm run db:seed` run (32 teams + current season present).
- [ ] Auth env vars set (`AUTH_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH`; `AUTH_URL` locally).
- [ ] Commissioner can sign in at `/admin/login`.
- [ ] **`INGEST_TOKEN` set** — without it every extension sync 401s and no week can be scored.
      Use the same value in the extension's Settings screen, and confirm with its **Test
      connection** button.
- [ ] `npm run schedule:pull -- --year=<year>` run once the season's owners are assigned.
- [ ] `npm run verify` green before the push that triggered this deploy — see
      [`RUNBOOK.md` §4](RUNBOOK.md#4-verification).
