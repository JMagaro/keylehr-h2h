# DraftKings scoring pipeline — **Planned (Phase 3)**

> **Status: Planned (Phase 3).** This document describes the design of the automated scoring
> pipeline. The supporting **database tables already exist** (`weekly_contests`, `scores`,
> `score_import_runs`) and the environment variables are reserved (`DK_SESSION_COOKIE`,
> `CRON_SECRET`), but the **pipeline code, cron route, and manual-fallback UI are not yet
> implemented.** Nothing in `src/lib` reads DraftKings today.

> ⚠️ **Terms-of-Service caveat (read this).** DraftKings does **not** publish a public API. The
> endpoints this design relies on are **unofficial, undocumented, and using them is against
> DraftKings' Terms of Service.** They can change or break without notice, and automated access
> may be rate-limited or blocked. This pipeline is a convenience over manual entry and **must
> always degrade to a manual fallback** (see below). Treat any DK automation as best-effort.

## 1. Goal

Replace manual Google Sheets score entry with an automated weekly pull: read one shared
DraftKings contest leaderboard, map each entry to a league owner, and write each owner's weekly
fantasy points into `scores`.

## 2. The shared-private-contest approach

- All 32 owners join **one shared weekly DraftKings contest** (recorded in `weekly_contests`,
  one row per `(season, week)`, keyed by `dkContestId` / optional `dkDraftGroupId`).
- The pipeline pulls **that contest's leaderboard**, which yields, per entry, roughly:
  `user_name` (the DK entry/display name) and `fantasy_points` (the lineup's DFS points).
- Each leaderboard `user_name` is mapped to an owner via the locked
  **`owner_seasons.dkEntryName`** (see mapping below), and the matched `fantasy_points` is written
  to that owner's `scores` row for the week.

Because every owner is in the same contest, a single leaderboard read scores the whole league for
the week.

## 3. Mapping leaderboard → owners

The contest leaderboard identifies players by their DraftKings entry name, **not** by our
internal owner id. The mapping key is:

```
leaderboard.user_name  ───matched to───▶  owner_seasons.dk_entry_name
```

- `owner_seasons.dkEntryName` stores the **exact** DK entry/username each owner will use this
  season. Matching should be exact (optionally case-insensitive/trimmed) to avoid mis-assignment.
- **League rule:** an owner's DK entry name must **not change mid-season**, because it is the only
  stable join key. The commissioner sets/locks `dkEntryName` for every owner before week 1.
- Matched rows write `scores.dkPoints` (with `source = 'auto'`, plus `dkContestId` and
  `dkEntryKey` for traceability). Owners on a bye get an `isBye = true` row that does not count.
- **Unmatched entries** (a leaderboard name with no corresponding `dkEntryName`, or vice versa)
  are counted in the audit run and surfaced to the commissioner to resolve manually — they are
  never silently dropped.

## 4. The authenticated-session requirement

The shared contest is **PRIVATE**, so reading its leaderboard requires an **authenticated
DraftKings session**. This is the pipeline's single biggest fragility (token expiry + DK bot
detection).

- The captured session is supplied via the **`DK_SESSION_COOKIE`** environment variable (cookie
  or token from a logged-in DK session). It is left blank until Phase 3.
- **It will expire** and will need periodic refresh by the commissioner.

### Capturing / refreshing `DK_SESSION_COOKIE` (commissioner)

This is a manual, browser-assisted step (exact cookie names TBD during Phase 3
implementation):

1. Log in to DraftKings in a desktop browser as an account that can view the shared private
   contest.
2. Open the browser DevTools → **Network** tab, and load the contest's leaderboard page.
3. Find the authenticated leaderboard request and copy the relevant **session cookie(s)** /
   auth token from its request headers.
4. Paste that value into `DK_SESSION_COOKIE`:
   - **Locally:** in `.env.local`.
   - **Production:** in Vercel → Project Settings → Environment Variables, then redeploy (or
     trigger the next cron run) so the new value is picked up.
5. When a pull fails with an auth error (the run is logged `failed` with an auth-related
   `error`), repeat these steps to refresh the cookie.

> Keep `DK_SESSION_COOKIE` secret. It grants access to the DK account session; never commit it.

## 5. Cron flow (Planned)

A weekly **Vercel Cron** job triggers the pull (see [`DEPLOYMENT.md`](DEPLOYMENT.md) for the
`vercel.json` cron entry):

```text
Vercel Cron (scheduled weekly, after the slate finalizes)
      │  GET/POST /api/cron/pull        ← Planned route handler
      │  Authorization: Bearer ${CRON_SECRET}   (request rejected if it doesn't match)
      ▼
1. Resolve the current season + week and its weekly_contests row (dkContestId).
2. Set weekly_contests.status = 'pulling'.
3. Read the leaderboard using DK_SESSION_COOKIE.
4. Map each user_name → owner_seasons.dk_entry_name.
5. Upsert scores (one row per owner_season + week), source = 'auto'.
6. Write a score_import_runs row (audit + rawPayload).
7. Set weekly_contests.status = 'final' (or 'error' on failure); set lastPulledAt.
8. (Downstream) recompute standings from the updated scores.
```

The route is **guarded by `CRON_SECRET`** — the handler compares the incoming
`Authorization` header (or a query secret) against `process.env.CRON_SECRET` and rejects anything
that doesn't match, so the endpoint can't be triggered by the public.

## 6. Audit log (`score_import_runs`)

**Every** pull — automated or manual — writes one row to `score_import_runs`, so the commissioner
has a complete, replayable history. Key fields (full table in [`DATA_MODEL.md`](DATA_MODEL.md)):

| Field                                          | Purpose                                                        |
| ---------------------------------------------- | ------------------------------------------------------------- |
| `status` (`success`/`partial`/`failed`)        | Outcome of the run.                                           |
| `entriesTotal` / `entriesMatched` / `entriesUnmatched` | Reconciliation counts (expect 32 matched in steady state). |
| `triggeredBy` (`cron` / `admin:<email>` / `manual-paste`) | Who/what initiated the run.                          |
| `error`                                        | Failure detail (e.g. auth/session expiry).                   |
| `rawPayload` (jsonb)                           | The raw leaderboard payload, retained for debugging/replay.   |

Individual `scores` rows reference the run that produced them via `scores.importRunId`, so a bad
run can be traced and corrected.

## 7. Manual fallback (mandatory)

Because the authenticated DK read is fragile and against ToS, the pipeline **must always offer a
manual fallback**. Planned options for the commissioner:

1. **Paste leaderboard JSON.** Capture the leaderboard payload from the browser/DevTools and
   paste it into an admin form. The same mapping → `scores` → audit logic runs, with
   `triggeredBy = 'manual-paste'` and `score_source = 'manual'`.
2. **Hand-enter scores.** Type each owner's points directly into an admin grid for the week
   (`source = 'manual'`, still logged to `score_import_runs`).

Manual entries are first-class: `scores.source` distinguishes them, and they still flow through
the same audit and standings recomputation.

## 8. Fragility & mitigations

| Risk                                              | Mitigation                                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **DK ToS** — unofficial/undocumented API          | Treat as best-effort; never block scoring on it; always provide the manual fallback.        |
| **Session/token expiry** (`DK_SESSION_COOKIE`)    | Detect auth failures, log the run as `failed`, alert the commissioner to refresh the cookie. |
| **DK bot detection / rate limiting**              | One contest = one read per week; realistic headers; no aggressive polling; manual fallback. |
| **Endpoint/shape changes**                        | Keep `rawPayload` for every run; validate parsed shape (Zod) and fail loudly, not silently. |
| **Name-mapping drift** (renamed DK entry)         | Lock `dkEntryName` for the season; surface unmatched entries; never silently mis-assign.    |
| **Partial leaderboard** (missing owners)          | Record `partial` status with matched/unmatched counts; commissioner fills gaps manually.    |
| **Cron endpoint abuse**                           | Guard with `CRON_SECRET`; reject unauthenticated calls.                                     |

## 9. Reserved environment variables

| Variable            | Purpose                                                                 |
| ------------------- | ----------------------------------------------------------------------- |
| `DK_SESSION_COOKIE` | Authenticated DK session used to read the private contest leaderboard.  |
| `CRON_SECRET`       | Shared secret guarding the cron-triggered pull endpoint.                |

Both are present in `.env.example` and left blank until Phase 3.
