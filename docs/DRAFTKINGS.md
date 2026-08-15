# DraftKings scoring pipeline

> **Status: Implemented.** The scoring ingest (`src/app/api/ingest/draftkings/`, `src/lib/scores/`)
> + the **Chrome extension** (`extension/`) read a shared contest leaderboard and write each owner's
> weekly points into `scores`. Tables: `weekly_contests`, `scores`, `score_import_runs`.
> **The endpoint's request contract — including the two accepted `week` namespaces (regular/playoff
> and preseason exhibition) — is in [§10](#10-the-ingest-endpoint-implemented).**
>
> **Three distinct DraftKings integrations — don't conflate them:**
> 1. **Scoring** (this doc): the *leaderboard* of a shared private contest → owner weekly totals.
>    Needs the commissioner's authenticated DK session (via the extension).
> 2. **Salaries** (`src/lib/draftkings/`): the public, **keyless** *draftables* API gives per-player
>    salaries for a slate, used only by the **lineup builder** for cap-aware optimization. Server-side,
>    no auth. The slate is auto-detected from DK's lobby or pinned in Admin → Slates. See
>    `docs/HANDOFF.md`.
> 3. **Roster capture** (`src/lib/lineups/`): each owner's *lineup*, stored so the app can compute a
>    live **estimate** from ESPN's boxscore. Also needs a DK session. **It never writes a score** —
>    contract in [§12](#12-the-roster-ingest-endpoint-implemented), rationale in
>    [`SCORING.md` §15](SCORING.md#15-live-in-progress-scoring-an-estimate-never-a-score).
>
> **Which DK endpoints are actually reachable — and which need a session — is
> [§11](#11-endpoint-inventory--what-is-public-and-what-needs-auth).** Read it before designing
> anything that talks to DraftKings.

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

## 5. Cron flow (designed, then REJECTED — never built)

> **Nothing below exists.** There is no `vercel.json`, no `/api/cron/pull` route, and no
> `src/lib/dk` module, and none are planned — a server cannot read a private contest's leaderboard
> without the commissioner's session, which is why scoring runs through the browser extension
> ([§10](#10-the-ingest-endpoint-implemented)). `DEPLOYMENT.md`
> [§6](DEPLOYMENT.md#6-vercel-cron-for-the-weekly-pull--not-built) records the same decision. The
> sketch is kept only because it remains the shape any future unattended pull would take.

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
| `triggeredBy` (`extension` / `admin:preseason` / `backfill`) | Who/what initiated the run.                       |
| `error`                                        | Failure detail (e.g. auth/session expiry).                   |
| `rawPayload` (jsonb)                           | The raw leaderboard payload, retained for debugging/replay.   |

Individual `scores` rows reference the run that produced them via `scores.importRunId`, so a bad
run can be traced and corrected.

## 7. Manual fallback (mandatory)

Because the authenticated DK read is fragile and against ToS, the pipeline **must always offer a
manual fallback**:

1. **Paste leaderboard JSON.** Capture the leaderboard payload from the browser/DevTools and paste
   it into the extension's **Paste manually** box (see [`../extension/README.md`](../extension/README.md))
   or, for exhibition weeks, into **Admin → Preseason**. The same mapping → `scores` → audit logic
   runs. The `triggeredBy` values actually written today are **`extension`**, **`admin:preseason`**
   and **`backfill`** (`scoreImportRuns.triggeredBy` is free-form text) — there is no
   `'manual-paste'` value.
2. **Hand-enter scores.** *Not built* — there is no admin grid for typing a week's points, so the
   paste path above is the only in-app fallback.

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

Both are present in `.env.example` and left blank. **Neither is read by any code today** — the
implemented path is the browser extension (§10), which authenticates with **`INGEST_TOKEN`**.

## 10. The ingest endpoint (implemented)

`POST /api/ingest/draftkings` (`src/app/api/ingest/draftkings/route.ts`) is the endpoint that
actually scores a week. The leaderboard read happens in the commissioner's own browser — the
Chrome extension in [`extension/`](../extension/README.md) — so the server never holds DK
credentials, and sections 4–5 above (a stored `DK_SESSION_COOKIE` + a cron pull) describe a design
that was **not** built. The endpoint only accepts an already-captured leaderboard.

**Auth.** `Authorization: Bearer <INGEST_TOKEN>`, compared in constant time (`isAuthorized` in
`src/lib/ingest/auth.ts`, shared with the roster endpoint). A missing header, a wrong token, or a
server with no `INGEST_TOKEN` set all return `401 Unauthorized`.

> There is a second ingest endpoint on the same token — `POST /api/ingest/lineups`, which records
> **rosters** rather than scores. Its contract is
> [§12](#12-the-roster-ingest-endpoint-implemented).

**Body.**

| Field            | Type                                            | Required | Notes                                                                 |
| ---------------- | ----------------------------------------------- | -------- | --------------------------------------------------------------------- |
| `seasonId`       | positive int                                    | yes      | `seasons.id` (the extension picks it from `/api/seasons`).            |
| `week`           | int                                             | yes      | Two accepted namespaces — see below.                                  |
| `contestId`      | string                                          | no       | Stored on the scores + audit row for traceability.                    |
| `entries`        | `{ entryName, points, rank?, entryKey? }[]`     | either   | Already normalized to the app's shape.                                |
| `rawLeaderboard` | DK leaderboard objects                          | either   | DK's own field names, normalized server-side.                         |

At least one of `entries` / `rawLeaderboard` must be non-empty. If both are sent they are merged,
with explicit `entries` winning on duplicate names.

### The `week` contract — two disjoint namespaces

| Namespace              | Accepted    | Meaning                                                                      |
| ---------------------- | ----------- | ---------------------------------------------------------------------------- |
| Regular / playoff      | `1`–`25`    | Stored as-is. 18 regular weeks + playoffs 19–22, with headroom (`MAX_REGULAR_WEEK`). |
| Preseason exhibition   | `101`–`103` | `PRESEASON_WEEK_BASE + preseasonWeek` (`src/lib/schedule/preseason.ts`).      |

Everything else — including the whole gap `26`–`100` and anything above `103` — is a `400`:

```text
Week must be 1–25 (regular/playoff) or 101–103 (preseason exhibition).
```

The gap between the ranges is deliberate: a typo'd week can never silently land in the wrong
namespace. The refinement itself lives in `src/lib/ingest/week-schema.ts` (`weekSchema`,
`MAX_REGULAR_WEEK`, `MIN_EXHIBITION_WEEK`, `MAX_EXHIBITION_WEEK`) so that **both** ingest endpoints
and Admin → Lineups agree on what a legal week is. **Nothing else marks an exhibition sync** —
`ingestLeaderboard` derives `isExhibition`
from the week alone (`isExhibitionWeek`), so a week-`102` POST writes scores that surface on
`/live` (which renders exhibition weeks like any other) and are excluded from standings, seeding,
playoffs, payouts, and all-time records.
`src/lib/schedule/preseason.test.ts` pins these invariants; the extension mirrors the same
constants client-side (its **Preseason** toggle is what produces a 101–103 week).

**Example — scoring preseason week 2** (the body the extension sends with **Preseason** ticked;
both sync paths post normalized `entries`, so `normalizedFromRaw` stays `0`):

```json
{
  "seasonId": 4,
  "week": 102,
  "contestId": "182734567",
  "entries": [
    { "entryName": "Brandon", "points": 241.68, "rank": 1 },
    { "entryName": "Josh", "points": 198.42, "rank": 2 }
  ]
}
```

**Response (200).**

```json
{
  "matched": 2,
  "unmatched": [],
  "week": 102,
  "seasonId": 4,
  "total": 2,
  "byes": 0,
  "importRunId": 91,
  "normalizedFromRaw": 0,
  "skippedFromRaw": 0
}
```

**Errors.** `401 Unauthorized` · `400 Invalid JSON body` · `400 Validation failed` (with Zod
`issues`, e.g. the week message above) · `400` when no usable entries survive normalization ·
`500 Ingest failed: <message>`.

Every accepted call runs `ingestLeaderboard` with `source = 'auto'` and
`triggeredBy = 'extension'`, so it lands in the `score_import_runs` audit log (§6) like any other
run. Re-posting the same week is safe — scores upsert on `(ownerSeasonId, week)`.

## 11. Endpoint inventory — what is public and what needs auth

Written during **Phase 0 of live scoring** ([`SCORING.md` §15](SCORING.md#15-live-in-progress-scoring-an-estimate-never-a-score)),
which asked a single question: can the server compute in-progress points on its own, without the
commissioner's browser? Every line below was **probed**, not assumed. Re-probe before trusting it —
these are unofficial endpoints and DraftKings owes us nothing.

_Last probed: 2026-08-14; the roster endpoint confirmed against live traffic 2026-08-15._

### DraftKings — public (no session, works server-side)

| Endpoint | Returns | Used by |
| -------- | ------- | ------- |
| `GET www.draftkings.com/lobby/getcontests?sport=NFL` | The public lobby — used to auto-detect the main slate's draft group. | `src/lib/draftkings/draftables.ts` (`getMainNflDraftGroupId`). |
| `GET api.draftkings.com/draftgroups/v1/draftgroups/{draftGroupId}/draftables?format=json` | Per-player salaries + positions for a slate, keyed by both `playerId` and `draftableId`. | `src/lib/draftkings/draftables.ts` — `fetchDraftables` (lineup builder, deduped by `playerId`) and `fetchDraftableIndex` (roster enrichment, keyed by `draftableId`). One shared fetch, cached 15 min. |
| `GET api.draftkings.com/contests/v1/contests/{contestId}?format=json` | Contest metadata (entry counts, payouts, **draft group id**). Works for a contest you are not in. | `extension/page-hook.js` (`resolveDraftGroupId`) — the roster endpoint is keyed by draft group, not contest. |
| `GET api.draftkings.com/lineups/v1/gametypes/1/rules?format=json` | The Classic rule set. | Nothing — it is the evidence behind `src/lib/dfs/rules.ts`. |

> **We are using the same endpoint DraftKings' own UI does.** Watching the gamecenter's own network
> traffic shows it calling
> `draftgroups/v1/draftgroups/{draftGroupId}/draftables/{id,id,id}` — the comma-separated form of
> the public draftables endpoint above. Whatever DK's own page calls is by definition supported, so
> `draftableId` → identity enrichment is not relying on a back door.

The gametype-rules response is what pins the roster shape:

```text
gameTypeName   "Classic"
salaryCap.maxValue  50000          → DK_CLASSIC_SALARY_CAP
allowLateSwap  true
lineupTemplate [QB, RB, RB, WR, WR, WR, TE, FLEX, DST]   → DK_CLASSIC_SLOTS
```

Nine slots, **no kicker**.

### DraftKings — authenticated only

> **The entire `scores/*` namespace requires a DraftKings session.** Keyless it returns
> `SCO101 Invalid userKey` (HTTP 400) — *even for a public contest*:
>
> ```text
> $ curl --compressed 'https://api.draftkings.com/scores/v1/leaderboards/{contestId}?format=json&embed=leaderboard'
> {"errorStatus":{"code":"SCO101","developerMessage":"Invalid userKey."}, ...}
> ```

That covers both things a live page would want from DraftKings: **rosters** and **DK-computed
live player points**. This is the whole reason the extension exists (§10) and the reason live
scoring has to be recomputed from a third-party stat feed rather than read from DK.

#### The roster endpoint (found — this is the one)

```text
GET https://api.draftkings.com/scores/v2/entries/{draftGroupId}/{entryKey}?format=json&embed=roster
```

Credentialed (`credentials: 'include'`, from an open DK tab). Confirmed against DraftKings' own
gamecenter traffic and implemented in `extension/page-hook.js` as `ROSTER_URL_TEMPLATE`.

**Read the first path segment carefully: it is the DRAFT GROUP id, not the contest id.** Every
guess built around `{contestId}` failed, which is why the probe took as long as it did. The
extension resolves the draft group from the public contest-metadata endpoint above
(`contestDetail.draftGroupId`) before it asks for a single roster.

> ⚠️ **There is no bulk roster endpoint.** The obvious one —
> `scores/v1/leaderboards/{contestId}?format=json&embed=leaderboard,roster` — answers **HTTP 200
> with an empty `entryByEntryKey` map**. It looks like it works and returns nothing, so a
> status-code check alone will report success. **Re-confirmed on a live contest** during the first
> real capture — still `entryByEntryKey: {}`. Because of that, rosters are fetched **one
> authenticated request per entry**: leaderboard → entry keys → N rosters, at concurrency 4 with
> 150–300 ms of jitter.

You do **not** have to click into anyone's lineup first. The entry keys come from the same
leaderboard fetch the weekly score sync already does — and since extension v1.3.0 that fetch
happens **once** and serves both halves of **Sync**.

**Concealment.** DraftKings hides a player from opponents until that player's game kicks off. A
concealed slot arrives as `{ rosterPosition, draftableId: 0, isSwappable: true, yetToPlay: true }`
with no name. Three consequences, all easy to misread as bugs:

1. A capture of **32/32 owners** can legitimately show only a fraction of the 288 players revealed.
   That is not a partial capture.
2. A concealed player has by definition scored nothing, so **no points are ever missing from a
   capture — only names.** Re-capturing later fills them in.
3. Concealment tracks swappability exactly, so any player you *can* see is already locked and can
   no longer be late-swapped. **Revealed data never goes stale.**

A real captured entry is frozen at `scripts/fixtures/dk-roster-entry.json` (contest `193778304`,
draft group `152064`, captured 2026-08-15). Note what a *revealed* row does carry: `displayName`,
`rosterPosition`, `draftableId`, DK's own `score`, a `stats[]` breakdown and a `competition` block —
but **no team and no position**.

> **`stats[]` is worth keeping.** It is DraftKings' own per-stat account of the game
> (`{ key: "RecYds", value, points }`), and it exists **only at capture time** — the authenticated
> roster endpoint is the only place it appears, and it is gone once the contest ages out. Stored as
> `slots[].dkStats`, it is the sharpest available check on the ESPN extractor: a matching *total*
> can hide two compensating errors, a per-stat diff cannot. It is also how `pointsAllowedMode`
> ([`SCORING.md` §15](SCORING.md#15-live-in-progress-scoring-an-estimate-never-a-score)) gets
> settled empirically instead of by guesswork. It is never used to score.

**The payload identifies players by `draftableId` alone** — no team abbreviation, no player
position. Scoring reaches ESPN by `(normalizeName, teamKey)`, so a raw capture is not scorable
until those ids are resolved against the **public** draftables endpoint above. That bridge is
`src/lib/lineups/enrich.ts`, and it runs at **capture** time because DK expires draftables for old
draft groups — see [§12](#12-the-roster-ingest-endpoint-implemented).

The extension still ships that probe panel (added in v1.1.0, relabelled **Troubleshooting —
DraftKings endpoints** in v1.3.0) — it walks candidate URL templates from inside the DK page and,
failing that, reports every `api.draftkings.com` URL DK's own gamecenter requested. It is how the
template above was found and is kept for the day DraftKings moves it; it is **not** part of normal
use. See
[`../extension/README.md`](../extension/README.md#troubleshooting--draftkings-endpoints).

> **The database records the answer too.** Because "which URL worked" is exactly the fact most
> likely to be lost, every roster capture stores it: `lineup_capture_runs.sourceUrlTemplate`
> ([`DATA_MODEL.md`](DATA_MODEL.md#lineup_capture_runs)), sent as `sourceUrlTemplate` on
> [§12](#12-the-roster-ingest-endpoint-implemented) and shown in the Admin → Lineups audit table.
> This section and that column should agree; the column is the one that gets written on a Sunday.
> (The extension sends its `ROSTER_URL_TEMPLATE` automatically; the Admin → Lineups paste form has a
> **Source URL** field for the same purpose, left null when nobody fills it in.)

### NFL official feeds — all closed

| Probe | Result |
| ----- | ------ |
| `GET api.nfl.com/v1/games` | **401** |
| `GET feeds.nfl.com/feeds-rs/scores.json` | **403** |
| `GET nextgenstats.nfl.com/api/statboard/passing` | **401** |

DraftKings licenses official NFL data from **Genius Sports**, which holds exclusive NFL rights.
That is an enterprise contract, not a signup. There is no free official feed.

### ESPN — the live stat source, and its silent-failure trap

`GET site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event={espnEventId}` is public,
keyless, carries a complete per-player boxscore, and updates during games. It is the only free
source that does all four, which is why `src/lib/dfs/sources/espn-boxscore.ts` uses it.

> ⚠️ **Do NOT send a `user-agent` header.** ESPN's edge rejects browser-like and empty User-Agents
> on this API. Measured directly:
>
> ```text
> curl default UA        → HTTP 200
> Node/undici fetch      → HTTP 200
> -A "Mozilla/5.0 ..."   → HTTP 403
> -H "User-Agent:"       → HTTP 403
> ```
>
> Send **only** `accept`, as both `src/lib/espn/client.ts` and `espn-boxscore.ts` do.
> "Helpfully" adding a realistic User-Agent will take the live page down, and the failure looks
> like a bot block rather than a header bug.

Polling cadence is a Data-Cache `revalidate` window chosen from the game's own state —
`BOXSCORE_TTL_SECONDS` in `espn-boxscore.ts`: **300s** before kickoff, **45s** in progress,
**86,400s** once final. A finished boxscore is effectively immutable and must not be re-fetched
all week; only an in-progress game is worth polling.

Both ESPN endpoints we use are unofficial and undocumented; the same best-effort caveat as
DraftKings applies.

### Sleeper — a reconciler, not a live feed

`api.sleeper.app/v1/stats/nfl/regular/{year}/{week}` is public and keyless, but it lags. Observed
during Phase 0: six preseason games that had been final for **14 hours** still returned zero rows
while ESPN had complete boxscores. Use it after the fact — it is what `npm run dfs:selftest`
checks the engine against — never to drive a live page.

## 12. The roster ingest endpoint (implemented)

`POST /api/ingest/lineups` (`src/app/api/ingest/lineups/route.ts`) is the sibling of
[§10](#10-the-ingest-endpoint-implemented). That endpoint records what each owner **scored**; this
one records **who they started**, so the app can recompute a running total from ESPN's public
boxscore during games. It writes only `lineup_snapshots` / `lineup_capture_runs` — **never
`scores`**. See [`SCORING.md` §15](SCORING.md#15-live-in-progress-scoring-an-estimate-never-a-score).

> **Who calls it.** The Chrome extension posts `rawLineups` here — from the **Capture lineups**
> button in v1.2.0, and from the single **Sync** button since v1.3.0, which does scores and rosters
> off one leaderboard read. The **Admin → Lineups** paste box does *not* go through this endpoint — it calls the same
> `ingestLineups` directly from a server action with `triggeredBy = 'admin:paste'`, and it sends no
> `draftGroupId`, so **a pasted capture is never enriched**: it keeps only the names and teams DK's
> own payload happened to carry.

**Auth.** `Authorization: Bearer <INGEST_TOKEN>` — the same token and the same constant-time
comparison as §10, now shared via `src/lib/ingest/auth.ts`. Missing header, wrong token, or a server
with no `INGEST_TOKEN` set all return `401 Unauthorized`.

**Body.**

| Field               | Type                                          | Required | Notes                                                                 |
| ------------------- | --------------------------------------------- | -------- | --------------------------------------------------------------------- |
| `seasonId`          | positive int                                  | yes      | `seasons.id`.                                                         |
| `week`              | int                                           | yes      | Same two disjoint namespaces as §10 — `1`–`25` or `101`–`103`, validated by the shared `weekSchema`. |
| `rawRosters`        | whatever DraftKings returned                  | one of   | A **bulk** payload (e.g. a leaderboard with embedded rosters). Normalized server-side, **structurally** — see below. |
| `rawLineups`        | `{ entryName, entryKey?, roster }[]`          | one of   | **The shape the extension sends.** One element per entry: DK's per-entry roster response verbatim, paired with whose entry it is. |
| `lineups`           | `{ entryName, entryKey?, slots[] }[]`         | one of   | Already normalized. Each `slots` entry: `{ slot?, dkPlayerId?, draftableId?, name?, teamKey?, position?, revealed?, dkScore?, dkStats? }`, all nullable, at least one slot required. `revealed` defaults to "did you send any identity at all"; `dkStats` is `{ key, value, points }[]`. |
| `entryName`         | string                                        | no       | Attributes a **bare** `rawRosters` payload (a per-entry response carries no entry name of its own). |
| `capturedAt`        | ISO 8601 datetime with offset                 | no       | **When DK was read.** Defaults to the server's now. Pass the real read time — late-swap resolution depends on it. |
| `contestId`         | string                                        | no       | Stored on the snapshots + audit row.                                  |
| `draftGroupId`      | string                                        | no       | The DK slate the lineups were drafted from. **Supply it** — it is what enables `draftableId` resolution below. |
| `sourceUrlTemplate` | string                                        | no       | The DK URL template that produced this payload — recorded on the audit row (see [§11](#11-endpoint-inventory--what-is-public-and-what-needs-auth)). |

At least one of `rawRosters` / `rawLineups` / `lineups` must be present and usable. They are merged
in that order, so a later shape wins on a duplicate entry name — the same rule §10 uses.

**Why `rawLineups` exists.** DraftKings has **no bulk roster endpoint**
([§11](#11-endpoint-inventory--what-is-public-and-what-needs-auth)), so the extension fans out one
authenticated request per entry. Each response identifies no owner — the caller asked for a known
`entryKey` — hence the paired `entryName`. The first normalized lineup in each response is the one
that was asked for.

**Raw payloads are parsed by shape, not by path.** `normalizeRosterPayload`
(`src/lib/lineups/normalize.ts`) identifies roster rows structurally — an object with a player id
plus a slot or a name — and walks the tree for them. Posting DK's payload verbatim works even
though nobody has typed its schema, and keeping that parsing on the server means one tested
implementation instead of a second copy inside the extension.

**`draftableId` → identity happens here, at capture time.** DK's roster payload carries no team
abbreviation and no player position. When `draftGroupId` is supplied, `ingestLineups` calls
`enrichLineups` (`src/lib/lineups/enrich.ts`), which indexes the **public** draftables endpoint by
`draftableId` and fills in `name` / `teamKey` / `position` before the snapshot is written. Values
already present in DK's own payload always win. This runs on capture rather than on read because DK
expires draftables for old draft groups — a snapshot has to stand alone months later.

**Response (200).**

```json
{
  "matched": 32,
  "unmatched": [],
  "total": 32,
  "snapshots": 32,
  "captureRunId": 7,
  "week": 1,
  "seasonId": 4,
  "normalizedFromRaw": 32,
  "skippedFromRaw": 0,
  "enrichedSlots": 121,
  "unresolvedDraftableIds": []
}
```

`total` is how many lineups were submitted after the merge; `matched` is how many of those entry
names resolved to an owner, and `snapshots` is how many rows were written (the same number —
unmatched lineups are not stored). `unmatched` lists the names that failed to resolve — reported,
never written, and usually a stale `owner_seasons.dkEntryName`. `normalizedFromRaw` /
`skippedFromRaw` describe what the normalizer made of the raw payloads (skipped = roster groups with
no entry name, or no usable players).

`enrichedSlots` is how many slots gained a team key they did not have, and
`unresolvedDraftableIds` lists revealed ids the draft group did not know — surfaced, never silently
zeroed. **`enrichedSlots: 0` with a `draftGroupId` set and revealed players present means DK's slate
lookup failed**: the capture stored, but it is not yet scorable, so re-run it rather than trust it.
Both numbers are expected to be far below `9 × matched` early in a week — concealed players have no
id to resolve ([§11](#11-endpoint-inventory--what-is-public-and-what-needs-auth)).

**Errors.** `401 Unauthorized` · `400 Invalid JSON body` · `400 Validation failed` (with Zod
`issues`) · `400` when no usable lineups survive normalization (the message names the skipped count
and suggests `entryName` for a single-entry payload) · `500 Roster ingest failed: <message>`.

Every accepted call writes a `lineup_capture_runs` row with `triggeredBy = 'extension'`
(the admin paste form writes `'admin:paste'`), so captures are auditable exactly like score imports
([§6](#6-audit-log-score_import_runs)). Re-posting the **same** `capturedAt` updates the same
snapshots; a **new** `capturedAt` adds a version, which is how late swap is handled. The extension
stamps `capturedAt` **once, before the first roster request**, so all 32 lineups in a batch share one
honest "as of" time.
