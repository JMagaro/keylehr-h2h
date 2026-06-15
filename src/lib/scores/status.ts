/**
 * Sync-status query (server-only) — powers the admin "Sync" page and the dashboard
 * alert banner.
 *
 * It answers, per week, a single operational question for the commissioner: did the
 * DraftKings score sync for this week complete, or does it need a re-sync? The answer
 * is derived from four facts the rest of the system already records:
 *
 *  - `matchups`        — which owners are scheduled to play that week (bye owners have
 *                        no matchup row, so they are excluded from "expected").
 *  - `scores`          — which owners actually have a non-bye, non-null DraftKings score.
 *  - `nflGames`        — whether the real NFL games for the week are final (so an
 *                        unscored owner means "needs sync", not merely "not played yet").
 *  - `scoreImportRuns` — the audit log of the last leaderboard pull (success/partial/
 *                        failed + matched/total/unmatched counts).
 *
 * Numeric columns (`numeric(7,2)` etc.) come back from the Neon driver as strings; we
 * convert with `Number` exactly once, here. This module is the only place that touches
 * the DB for sync status — the page and dashboard consume the typed result.
 */
import { and, eq, isNotNull } from 'drizzle-orm';

import { db, matchups, nflGames, scores, scoreImportRuns, seasons } from '@/db';

/** Derived per-week health, in roughly increasing severity for display ordering. */
export type SyncHealth =
  | 'no_schedule' // no matchups generated for the week yet
  | 'upcoming' // games not final and nothing scored (future / not started)
  | 'live' // games not final but partially scored (in progress)
  | 'complete' // ✅ final, everyone scored, last run clean
  | 'partial' // ⚠️ final but some owners missing / unmatched / partial run
  | 'needs_sync'; // ❌ final but nobody scored, or last run failed

/** The most recent `scoreImportRuns` row for a week, normalized for display. */
export interface WeekLastRun {
  status: 'success' | 'partial' | 'failed';
  matched: number;
  total: number;
  unmatched: number;
  triggeredBy: string | null;
  createdAt: Date;
  error: string | null;
}

/** One week's full sync picture. */
export interface WeekSyncStatus {
  week: number;
  /** Distinct owners who have a matchup this week (byes excluded). */
  expectedOwners: number;
  /** Owners with a non-null, non-bye score this week. */
  scoredOwners: number;
  /** True when there ARE nfl games this week and ALL of them are final. */
  gamesFinal: boolean;
  /** Most recent import run for the week, or null if none has ever run. */
  lastRun: WeekLastRun | null;
  health: SyncHealth;
}

/** Season-level rollup for the summary tiles and the dashboard banner. */
export interface SeasonSyncSummary {
  /** Count of weeks by derived health. */
  byHealth: Record<SyncHealth, number>;
  /** partial + needs_sync — the weeks a commissioner should act on. */
  weeksNeedingAttention: number;
  /** Most recent import-run timestamp across all weeks, or null. */
  lastSyncAt: Date | null;
}

/** The full per-season sync status returned to the page. */
export interface SeasonSyncStatus {
  seasonId: number;
  regularSeasonWeeks: number;
  weeks: WeekSyncStatus[];
  summary: SeasonSyncSummary;
}

/** A safe margin after kickoff before we assume a game with no status is over. */
const FINAL_FALLBACK_MS = 6 * 60 * 60 * 1000; // 6 hours

/** True when an ESPN status string (e.g. "STATUS_FINAL") indicates a finished game. */
function statusIsFinal(status: string | null): boolean | null {
  if (!status) return null;
  return /final|complete|full[-_ ]?time|postgame/i.test(status);
}

/** Empty health tally, for accumulation. */
function zeroHealth(): Record<SyncHealth, number> {
  return {
    no_schedule: 0,
    upcoming: 0,
    live: 0,
    complete: 0,
    partial: 0,
    needs_sync: 0,
  };
}

/**
 * Derive a week's health from its computed facts. Pure — given the same facts it
 * always returns the same health, so it can be reasoned about and unit-tested.
 */
function deriveHealth(args: {
  hasMatchups: boolean;
  gamesFinal: boolean;
  expectedOwners: number;
  scoredOwners: number;
  lastRun: WeekLastRun | null;
}): SyncHealth {
  const { hasMatchups, gamesFinal, scoredOwners, expectedOwners, lastRun } = args;

  if (!hasMatchups) return 'no_schedule';

  // A failed run is always a hard "needs sync", regardless of game state.
  if (lastRun?.status === 'failed') return 'needs_sync';

  if (!gamesFinal) {
    return scoredOwners > 0 ? 'live' : 'upcoming';
  }

  // From here on, the week's NFL games are final.
  if (scoredOwners === 0) return 'needs_sync';

  const everyoneScored = scoredOwners >= expectedOwners;
  const runClean = !lastRun || lastRun.status === 'success';
  const noUnmatched = !lastRun || lastRun.unmatched === 0;

  if (everyoneScored && runClean && noUnmatched) return 'complete';

  // Partially scored, or the last run reported problems (partial / leftover unmatched).
  return 'partial';
}

/**
 * Compute the per-week DraftKings sync status for a season.
 *
 * @param seasonId  The season to inspect.
 * @param now       The current time, passed in so this stays a pure-ish helper (the
 *                  calling Server Component supplies `new Date()`). Defaults to now
 *                  for convenience in scripts.
 */
export async function getSeasonSyncStatus(
  seasonId: number,
  now: Date = new Date(),
): Promise<SeasonSyncStatus> {
  const [season] = await db
    .select({ regularSeasonWeeks: seasons.regularSeasonWeeks })
    .from(seasons)
    .where(eq(seasons.id, seasonId))
    .limit(1);

  const regularSeasonWeeks = season?.regularSeasonWeeks ?? 18;

  // 1. Matchups → distinct expected owners per week (each owner appears once as home
  //    and/or away; bye owners simply have no row).
  const matchupRows = await db
    .select({
      week: matchups.week,
      homeOwnerSeasonId: matchups.homeOwnerSeasonId,
      awayOwnerSeasonId: matchups.awayOwnerSeasonId,
    })
    .from(matchups)
    .where(eq(matchups.seasonId, seasonId));

  const expectedByWeek = new Map<number, Set<number>>();
  for (const m of matchupRows) {
    const set = expectedByWeek.get(m.week) ?? new Set<number>();
    set.add(m.homeOwnerSeasonId);
    set.add(m.awayOwnerSeasonId);
    expectedByWeek.set(m.week, set);
  }

  // 2. Scores → count of non-null, non-bye scored owners per week.
  const scoreRows = await db
    .select({ week: scores.week, ownerSeasonId: scores.ownerSeasonId })
    .from(scores)
    .where(
      and(
        eq(scores.seasonId, seasonId),
        eq(scores.isBye, false),
        isNotNull(scores.dkPoints),
      ),
    );

  const scoredByWeek = new Map<number, Set<number>>();
  for (const s of scoreRows) {
    const set = scoredByWeek.get(s.week) ?? new Set<number>();
    set.add(s.ownerSeasonId);
    scoredByWeek.set(s.week, set);
  }

  // 3. NFL games → per week, do games exist and are they ALL final?
  const gameRows = await db
    .select({ week: nflGames.week, kickoff: nflGames.kickoff, status: nflGames.status })
    .from(nflGames)
    .where(eq(nflGames.seasonId, seasonId));

  const gamesByWeek = new Map<number, { total: number; final: number }>();
  for (const g of gameRows) {
    const cur = gamesByWeek.get(g.week) ?? { total: 0, final: 0 };
    cur.total += 1;
    const explicit = statusIsFinal(g.status);
    const isFinal =
      explicit === true ||
      // Status missing/unknown: fall back to "kicked off long enough ago".
      (explicit === null &&
        g.kickoff != null &&
        now.getTime() - g.kickoff.getTime() >= FINAL_FALLBACK_MS);
    if (isFinal) cur.final += 1;
    gamesByWeek.set(g.week, cur);
  }

  // 4. Import runs → most recent run per week (rows are scanned, latest createdAt wins).
  const runRows = await db
    .select({
      week: scoreImportRuns.week,
      status: scoreImportRuns.status,
      entriesTotal: scoreImportRuns.entriesTotal,
      entriesMatched: scoreImportRuns.entriesMatched,
      entriesUnmatched: scoreImportRuns.entriesUnmatched,
      triggeredBy: scoreImportRuns.triggeredBy,
      error: scoreImportRuns.error,
      createdAt: scoreImportRuns.createdAt,
    })
    .from(scoreImportRuns)
    .where(eq(scoreImportRuns.seasonId, seasonId));

  const lastRunByWeek = new Map<number, WeekLastRun>();
  let lastSyncAt: Date | null = null;
  for (const r of runRows) {
    if (lastSyncAt === null || r.createdAt > lastSyncAt) lastSyncAt = r.createdAt;
    const existing = lastRunByWeek.get(r.week);
    if (!existing || r.createdAt > existing.createdAt) {
      lastRunByWeek.set(r.week, {
        status: r.status,
        matched: Number(r.entriesMatched),
        total: Number(r.entriesTotal),
        unmatched: Number(r.entriesUnmatched),
        triggeredBy: r.triggeredBy,
        createdAt: r.createdAt,
        error: r.error,
      });
    }
  }

  // 5. Assemble weeks 1..regularSeasonWeeks.
  const byHealth = zeroHealth();
  const weeks: WeekSyncStatus[] = [];
  for (let week = 1; week <= regularSeasonWeeks; week++) {
    const expectedSet = expectedByWeek.get(week);
    const hasMatchups = expectedSet !== undefined && expectedSet.size > 0;
    const expectedOwners = expectedSet?.size ?? 0;
    const scoredOwners = scoredByWeek.get(week)?.size ?? 0;
    const games = gamesByWeek.get(week);
    const gamesFinal = games !== undefined && games.total > 0 && games.final === games.total;
    const lastRun = lastRunByWeek.get(week) ?? null;

    const health = deriveHealth({
      hasMatchups,
      gamesFinal,
      expectedOwners,
      scoredOwners,
      lastRun,
    });
    byHealth[health] += 1;

    weeks.push({ week, expectedOwners, scoredOwners, gamesFinal, lastRun, health });
  }

  const summary: SeasonSyncSummary = {
    byHealth,
    weeksNeedingAttention: byHealth.partial + byHealth.needs_sync,
    lastSyncAt,
  };

  return { seasonId, regularSeasonWeeks, weeks, summary };
}
