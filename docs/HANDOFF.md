# Session handoff — KeyLehr H2H

A running "where things stand" doc so a fresh Claude/context window (or contributor) can pick up
without re-deriving everything. Update the **Next up** and **Recent work** sections as you go.

_Last updated: 2026-06-17._

---

## Snapshot

- **Live app:** Vercel (`keylehr-h2h.vercel.app`), auto-deploys from `main`. Latest work is pushed.
- **Stack:** Next.js 16.2.9 (App Router, Turbopack) · React 19 · Tailwind v4 (CSS `@theme`, no
  config file) · Drizzle + Neon Postgres (**HTTP driver** — every query is a network round-trip) ·
  NextAuth (commissioner login) · a Chrome extension for DraftKings sync.
- **Verification:** `npm run verify` runs the whole gate (see below). It is **green** as of this
  handoff (typecheck · lint · 45 tests · production build · ESPN health · engine invariants ·
  2025 ground-truth replay).

## Next up (do FIRST) — import 2023 + 2024 seasons

Goal: backfill the 2023 and 2024 seasons into the DB the same way 2025 was done
(`scripts/import-season3.ts`), each validated against its sheet's published `Standings` tab.

Both sheets are now **public + accessible**. Year mapping confirmed from their titles:
- **2024 = Sheet `1kWMn8Zbk4K7JitaOqxMjII_LKVsKRyqaeXhIJPFkJl8`** ("2024 DFS H2H Fantasy Football").
  **Matches the 2025 format exactly** — the `import-season3.ts` parsers work on it unchanged:
  - `Owners` header: `["","DK Entry Name","NFL Team","Owner","Paid?","Email Address"]` → DK=col1, team=col2, owner=col3, email=col5.
  - `Standings`: AFC block base col 1, NFC block base col 12; per block: Team@base, Owner@base+1, **DK@base+2**, W@base+3, L@+4, T@+5, PF@+6, PA@+7, STRK@+8.
- **2023 = Sheet `15KWmUsWkQuRgdOCJWUBfaImXZjGxnFp9Lv4UsNikDaA`** ("2023 DFS H2H Fantasy Football").
  ⚠️ **DIFFERENT column layout** — the parsers must be adapted:
  - `Owners` header: `["DK Entry Name","NFL Team","Owner","Paid?","Email Address",""]` (NO leading blank col) → DK=col0, team=col1, owner=col2, email=col4.
  - `Standings`: **NO DK-entry column**. AFC block base col 1, NFC block **base col 11** (not 12); per block: Team@base, Owner@base+1, W@base+2, L@+3, T@+4, PF@+5, PA@+6, STRK@+7.
- `Master Scores` is the **same in both**: team@col0, `Week 1..Week 18` at cols 1..18.

**Plan (write a NEW generic importer; do NOT modify `import-season3.ts` — it's the verify anchor):**
1. Create `scripts/import-season.ts`, parameterized via CLI: `--year=YYYY --sheet=ID --name="YYYY Season" [--weeks=18]`.
   Reuse `import-season3.ts`'s logic, but make the `Owners` + `Standings` parsing **header-driven**
   (locate columns by their header text: "DK Entry Name"/"NFL Team"/"Owner"/"Email Address"; and in
   Standings locate each division-label column then detect whether a "DK Entry Name" column precedes
   W) so it handles BOTH layouts above. `Master Scores`/`backfillScores`/`markForfeits` reuse as-is.
2. **Generic validation** (drop the 2025-specific assertions): compare record + PF + PA vs the
   `Standings` tab; assert league (losses − wins) is **even and ≥ 0** (= N double-losses; no fixed
   count); report highest weekly score + seeding without a hardcoded expectation. Exit non-zero on
   any per-owner FAIL or odd/negative balance.
3. Add npm script `import:season`. Run for **2024 first** (easy, matches 2025 parsers) then **2023**
   (validate the header-driven parsing). Confirm `OVERALL: PASS` for each.
4. Gotchas: owners are GLOBAL (deduped by email then name) so cross-season reuse is fine; ESPN has
   2023/2024 schedules (games return `STATUS_FINAL`); sheet team names must match `nfl_teams.name`.
   Writes to the prod DB but idempotent. Sheet Standings PF/PA are rounded to 1 decimal (tolerance
   ~0.2; forfeit-opponent weeks may need a ~3.0 PA residual tolerance like 2025).

## Then — Phase B: team-builder wizard + player news (NOT started)

The `/my-team` page now has the analytics dashboard (Phase A). The remaining feature the user wants:

- **Player-news strip** on `/my-team`: injuries / trending adds-drops (Sleeper API — free, no key) +
  ESPN news, framed as "in the spotlight / fade risks."
- **Team-builder wizard**: a step flow — pick week → choose **risk level** (safe / balanced /
  boom-or-bust) → suggests players to target/avoid weighting recent news + injury status + matchup.

**Decisions already made with the user (don't re-ask):**
- Data source: **free sources first** — Sleeper API + ESPN. (Paid projection APIs were declined.)
- "X sources" meant **various reputable sources**, not X/Twitter specifically.
- Honest caveat to carry into the UI: free sources are strong on **injuries/news/trends** but weak
  on true weekly **point projections**, so v1 leans on news + matchup signals, made transparent.

Note: the app has **no player-level data today** — it only tracks team-owner DraftKings lineup
*totals*. Phase B introduces the first external player-data integration (Sleeper is the place to
start; it's public, keyless: player metadata, injury_status, trending players).

## Open action items (need the USER, not code)

1. **Routine email** — the scheduled verifier (`keylehr-verify`,
   https://claude.ai/code/routines/trig_012WN7AoBzjC4jw2EqNDyrvD) is set to email
   `brandonmagaro@gmail.com` + `Joshua.lehr09@gmail.com`, but **no email connector is attached**.
   User must connect a Gmail connector at https://claude.ai/customize/connectors, then it can be
   attached to the routine (or add a Gmail-SMTP notifier script as an alternative).
2. **Routine can't run yet** until the user connects **GitHub** for `JMagaro/keylehr-h2h` (via
   `/web-setup`) and sets **`DATABASE_URL`** in the cloud environment (the DATA + TRUTH checks need
   it). CODE checks would still run without it.

## Conventions & gotchas learned this session (read before coding)

- **Always run `npm run verify` before pushing.** The **production build catches a class of errors
  that `next dev`, `tsc`, and ESLint all miss** — most notably **`'use server'` files may ONLY
  export async functions**. A stray `export const`/object in an actions file passes dev + typecheck
  but **fails the Vercel build**, which silently blocks every deploy. This actually happened
  (schedule actions exported `INITIAL_SCHEDULE_STATE`). Keep non-function values in a separate
  plain module.
- **Mobile / tables:** a table (or any wide content) inside a flex/grid item needs `min-w-0` on that
  item, or the no-wrap content blows the page width out instead of letting the inner
  `overflow-x-auto` scroll. The `Table` primitive already wraps in `overflow-x-auto`; the fix is on
  the **ancestor**. Verified pattern across standings/history/playoffs/my-team.
- **Neon HTTP driver → batch writes.** One query = one HTTP round-trip. Never loop per-row upserts
  (the schedule pull did ~272 sequential round-trips and timed out on Vercel). Use chunked multi-row
  `insert().onConflictDoUpdate()`, deduped by the conflict key.
- **Per-season rules now actually drive the engine** (this was the big correctness fix). Tiebreaker
  ORDER, bye-week toggles, and the playoff field size are threaded from `seasons.rules` →
  `getSeasonStandingsData()` (which returns `rankingOptions` + `playoffConfig`) → the standings /
  seeding / odds / playoffs code. If you add a new consumer of standings, pass those through.
- **Local `.next/* 2.*` files** are an iCloud/Finder duplication artifact on this machine; they make
  `tsc` throw bogus `RouteContext` errors. `find .next -name "* 2.*" -delete` before typecheck.
- Money is cents; points are `numeric` (strings). Use `formatMoney` / `formatPoints` in
  `src/lib/utils.ts`. `src/lib/standings/` stays pure (no DB imports).

## Recent work (this session, newest first)

- **My Team dashboard** (`/my-team`, `src/lib/team/query.ts`, `src/components/team-*.tsx`):
  browse-any-team dropdown + season selector; stat tiles; custom-SVG charts (weekly scores vs
  league avg, rank-over-time, playoff-odds trend); schedule & results table. **Forfeits are flagged**
  (banner pill + "Missed lineup — auto-loss · FF" rows) using the engine's authoritative
  `resolveMatchup`. (Removed a redundant head-to-head table.)
- **Verification suite** (`scripts/verify.ts`, `npm run verify` / `verify:quick` /
  `verify:ground-truth`) + a twice-weekly **scheduled cloud agent** that runs it.
- **Rules → engine wiring**: tiebreaker order, bye-week (counts-toward-PF / weekly-high
  eligibility), and playoff field size now honored everywhere; +4 tests. `import-season3.ts` now
  exits non-zero on FAIL.
- **Dynamic Rules page** (`/rules`) driven by `seasons.rules`; playoffs page seed copy de-hardcoded.
- **Schedule pull fix**: batched upserts (6.5s→~1s) + `maxDuration`; **the actual deploy blocker was
  the `'use server'` export bug above**, now fixed.
- **Mobile-friendliness** pass (zero horizontal overflow 320–390px) and **branding** (KeyLehr logo
  in nav/footer/hero, badge favicon/app icons, faint stadium backdrop).

## Known minor follow-ups (not blocking)

- Dashboard **"Top of the standings"** mini-table (`getTopStandings`) still uses a simple
  win%→PF→PA sort, not the full configured tiebreaker chain. Fine for a glance; wire if desired.
- `regularSeasonWeeks` is now edited only on the admin **Season** card (the column the engine
  reads); the duplicate Rules-card field was removed.

## Map of the important code

- Standings/seeding/tiebreaker **engine** (pure, tested): `src/lib/standings/{standings,tiebreakers,seeding,types}.ts`
- DB adapter feeding the engine: `src/lib/standings/query.ts` (`getSeasonStandingsData` is the hub —
  returns `rankingOptions` + `playoffConfig`)
- Per-team dashboard data: `src/lib/team/query.ts`
- Playoffs bracket service: `src/lib/playoffs/service.ts` · Odds sim: `src/lib/odds/`
- Rules schema (single source of truth): `src/lib/rules/schema.ts`
- DraftKings ingest: `src/lib/scores/`, `src/app/api/ingest/draftkings/` · Chrome ext: `extension/`
- Admin (commissioner): `src/app/admin/(panel)/` (auth-gated)
