# Deployment

How to deploy KeyLehr H2H to **Vercel** with a **Neon** Postgres database, configure environment
variables, run migrations against production, and schedule the weekly score pull.

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
| `DK_SESSION_COOKIE`   | P3 only         | Authenticated DraftKings session for the leaderboard read. Leave blank until Phase 3. See [`DRAFTKINGS.md`](DRAFTKINGS.md). |
| `CRON_SECRET`         | P3 only         | Secret guarding the Vercel Cron score-pull endpoint. Generate with `openssl rand -base64 32`.          |
| `NEXTAUTH_URL`        | Yes             | Base URL of the deployed app (used for absolute links / Auth.js). `http://localhost:3000` locally; your production URL on Vercel. |

> **Secrets:** `.env*` files are git-ignored. Never commit `DATABASE_URL`, `AUTH_SECRET`,
> `ADMIN_PASSWORD_HASH`, `DK_SESSION_COOKIE`, or `CRON_SECRET`.

> **Note on `NEXTAUTH_URL`:** the variable shipped in `.env.example` is `NEXTAUTH_URL` (the
> NextAuth v4 name). This project uses `next-auth` v5 (beta), which generally prefers `AUTH_URL`
> and can auto-detect the URL on Vercel. Confirm the exact variable when the auth work lands in
> Phase 1; if v5 expects `AUTH_URL`, set that too (or rename). This is flagged so it can be
> reconciled.

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
  migration file you then commit. The current schema's migration (`drizzle/0000_*.sql`) is already
  committed.
- `npm run db:push` syncs the schema directly without a migration file — fine for a personal dev
  database, **not recommended for production**. Prefer `db:migrate` in production so changes are
  versioned.
- You can run these locally against prod, from a CI step, or any environment that has the
  production `DATABASE_URL`.

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

## 6. Configure Vercel Cron for the weekly pull — Planned (Phase 3)

The automated DraftKings pull (see [`DRAFTKINGS.md`](DRAFTKINGS.md)) runs on a schedule via Vercel
Cron, hitting a route handler guarded by `CRON_SECRET`. Add a `vercel.json` at the repo root with
a cron entry pointing at the (Planned) pull endpoint:

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
  // app/api/cron/pull/route.ts  (Planned, Phase 3)
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

There is **no `vercel.json` in the repo yet** — add it when the pull endpoint is built in Phase 3.

## 7. Post-deploy checklist

- [ ] `DATABASE_URL` set (pooled Neon URL) and reachable.
- [ ] `npm run db:migrate` applied against production.
- [ ] `npm run db:seed` run (32 teams + current season present).
- [ ] Auth env vars set (`AUTH_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH`, URL var) — Phase 1.
- [ ] `npm run schedule:pull -- --year=<year>` run once the season's owners are assigned.
- [ ] (Phase 3) `DK_SESSION_COOKIE` + `CRON_SECRET` set and `vercel.json` cron configured.
