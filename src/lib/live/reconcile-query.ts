/**
 * The database half of the scoring-drift audit. The rules live in ./reconcile (pure); this
 * file only gathers the two sides and decides which slots may fairly be compared.
 *
 * NOTHING HERE WRITES. It runs the same read path as /live.
 */
import { and, desc, eq } from 'drizzle-orm';

import { db, lineupSnapshots, seasons } from '@/db';

import { assembleLive } from './assemble';
import { getLiveWeekData, type LiveWeekData } from './query';
import { reconcileWeek, type ReconcileInput, type ReconcileSummary } from './reconcile';
import { getLiveStatsForWeek, type LiveStatIndex } from './stats';

/**
 * How long after kickoff a game is certainly over.
 *
 * THE ONE APPROXIMATION IN THIS FILE, and it exists because neither ESPN nor our schedule
 * records when a game ENDED — only when it started and whether it is final now. To compare
 * DraftKings' captured number against ours, the capture has to postdate the whistle, and this
 * is how that is judged.
 *
 * Four hours is deliberately generous: an NFL game averages about 3h05 including overtime, so
 * this errs toward declaring a slot NOT comparable. That is the safe direction — the cost of
 * being wrong is a slot silently skipped, whereas the other direction invents drift by
 * comparing a half-finished DraftKings number with a finished one.
 */
const ASSUMED_GAME_LENGTH_MS = 4 * 60 * 60 * 1000;

export interface WeekReconciliation extends ReconcileSummary {
  seasonId: number;
  week: number;
  /** When the rosters being audited were read from DraftKings. */
  capturedAt: Date | null;
  /** Owners with a captured roster in this week. */
  owners: number;
  gamesLoaded: number;
  gamesTotal: number;
}

/** Seasons that have at least one captured roster, newest first — what the picker offers. */
export async function getReconcilableSeasons(): Promise<{ id: number; name: string }[]> {
  const rows = await db
    .selectDistinctOn([seasons.id], { id: seasons.id, name: seasons.name, year: seasons.year })
    .from(lineupSnapshots)
    .innerJoin(seasons, eq(seasons.id, lineupSnapshots.seasonId))
    .orderBy(seasons.id);
  return rows.sort((a, b) => b.year - a.year).map((r) => ({ id: r.id, name: r.name }));
}

/** Weeks with captured rosters for a season, newest capture first. */
export async function getCapturedWeeks(seasonId: number): Promise<number[]> {
  const rows = await db
    .selectDistinctOn([lineupSnapshots.week], {
      week: lineupSnapshots.week,
      capturedAt: lineupSnapshots.capturedAt,
    })
    .from(lineupSnapshots)
    .where(eq(lineupSnapshots.seasonId, seasonId))
    .orderBy(lineupSnapshots.week, desc(lineupSnapshots.capturedAt));
  return rows.map((r) => r.week).sort((a, b) => b - a);
}

/**
 * Reconcile one week: every captured slot's ESPN-derived score against DraftKings' own.
 *
 * Computed ON DEMAND rather than stored. Both inputs are already persisted — the captured
 * rosters and the public box scores — so a stored copy would be a third thing to keep in sync
 * for no gain.
 */
export async function reconcileWeekFromDb(
  seasonId: number,
  week: number,
): Promise<WeekReconciliation> {
  const data = await getLiveWeekData(seasonId, week);
  const index = await getLiveStatsForWeek(seasonId, week, data.games);
  return buildReconciliation(seasonId, week, data, index);
}

/**
 * Everything except the two fetches — kept separate so the comparability rule can be exercised
 * against real captures from a plain script, where `unstable_cache` (and therefore
 * `getLiveStatsForWeek`) cannot run for want of a request scope.
 */
export function buildReconciliation(
  seasonId: number,
  week: number,
  data: LiveWeekData,
  index: LiveStatIndex,
): WeekReconciliation {
  const view = assembleLive(data.matchups, data.snapshots, index);

  const inputs: ReconcileInput[] = [];
  const seen = new Set<number>();

  for (const matchup of view.matchups) {
    for (const team of [matchup.home, matchup.away]) {
      // An owner can only appear once a week, but a defensive guard keeps a schedule oddity
      // from double-counting them into the summary.
      if (!team.hasSnapshot || seen.has(team.ownerSeasonId)) continue;
      seen.add(team.ownerSeasonId);

      for (const slot of team.slots) {
        const state = slot.teamKey ? index.teamState[slot.teamKey] : undefined;
        const kickoff = slot.teamKey ? data.teamContext[slot.teamKey]?.kickoff : null;
        const capturedAt = team.capturedAt;

        // Comparable only when the game is over AND the capture came after it ended. See
        // ASSUMED_GAME_LENGTH_MS for why the second half is an approximation.
        const comparable =
          state?.state === 'post' &&
          capturedAt !== null &&
          kickoff !== null &&
          kickoff !== undefined &&
          capturedAt.getTime() >= kickoff.getTime() + ASSUMED_GAME_LENGTH_MS;

        inputs.push({ slot, comparable });
      }
    }
  }

  return {
    ...reconcileWeek(inputs),
    seasonId,
    week,
    capturedAt: view.latestCapturedAt,
    owners: seen.size,
    gamesLoaded: view.gamesLoaded,
    gamesTotal: view.gamesTotal,
  };
}
