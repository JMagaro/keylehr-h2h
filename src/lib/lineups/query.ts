/**
 * Read model for captured rosters.
 *
 * READ-ONLY with respect to the scoring chain: this module reads `lineup_snapshots`,
 * `lineup_capture_runs` and owner display data. It never touches `scores` or `matchups`.
 * See docs/SCORING.md §15.
 */
import { and, desc, eq, sql } from 'drizzle-orm';

import {
  db,
  lineupCaptureRuns,
  lineupSnapshots,
  nflTeams,
  owners,
  ownerSeasons,
} from '@/db';

import type { LineupSlotInput } from './normalize';

export interface CapturedLineup {
  ownerSeasonId: number;
  ownerName: string;
  teamKey: string | null;
  dkEntryName: string | null;
  capturedAt: Date;
  slots: LineupSlotInput[];
  dkEntryKey: string | null;
}

export interface CaptureRunSummary {
  id: number;
  status: string;
  entriesTotal: number;
  entriesMatched: number;
  entriesUnmatched: number;
  triggeredBy: string | null;
  sourceUrlTemplate: string | null;
  error: string | null;
  createdAt: Date;
}

export interface CaptureStatus {
  seasonId: number;
  week: number;
  /** How many owners are in this season — the denominator for "captured N/32". */
  expected: number;
  /** Newest snapshot per owner, most recently captured first. */
  lineups: CapturedLineup[];
  /** Most recent capture runs for this week, newest first. */
  runs: CaptureRunSummary[];
}

/**
 * The roster in effect for each owner this week.
 *
 * `lineup_snapshots` is append-only (DK Classic allows late swap, so a lock-time capture can
 * go stale), which means "the current roster" is the NEWEST row per owner. Postgres
 * `DISTINCT ON` does that in one round-trip — important on Neon's HTTP driver, where every
 * query is a network hop.
 */
export async function getCaptureStatus(seasonId: number, week: number): Promise<CaptureStatus> {
  const [expectedRows, lineupRows, runRows] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(ownerSeasons)
      .where(eq(ownerSeasons.seasonId, seasonId)),

    db
      .selectDistinctOn([lineupSnapshots.ownerSeasonId], {
        ownerSeasonId: lineupSnapshots.ownerSeasonId,
        capturedAt: lineupSnapshots.capturedAt,
        slots: lineupSnapshots.slots,
        dkEntryKey: lineupSnapshots.dkEntryKey,
        ownerName: owners.name,
        displayName: ownerSeasons.displayName,
        dkEntryName: ownerSeasons.dkEntryName,
        teamKey: nflTeams.key,
      })
      .from(lineupSnapshots)
      .innerJoin(ownerSeasons, eq(lineupSnapshots.ownerSeasonId, ownerSeasons.id))
      .innerJoin(owners, eq(ownerSeasons.ownerId, owners.id))
      .leftJoin(nflTeams, eq(ownerSeasons.nflTeamId, nflTeams.id))
      .where(and(eq(lineupSnapshots.seasonId, seasonId), eq(lineupSnapshots.week, week)))
      .orderBy(lineupSnapshots.ownerSeasonId, desc(lineupSnapshots.capturedAt)),

    db
      .select({
        id: lineupCaptureRuns.id,
        status: lineupCaptureRuns.status,
        entriesTotal: lineupCaptureRuns.entriesTotal,
        entriesMatched: lineupCaptureRuns.entriesMatched,
        entriesUnmatched: lineupCaptureRuns.entriesUnmatched,
        triggeredBy: lineupCaptureRuns.triggeredBy,
        sourceUrlTemplate: lineupCaptureRuns.sourceUrlTemplate,
        error: lineupCaptureRuns.error,
        createdAt: lineupCaptureRuns.createdAt,
      })
      .from(lineupCaptureRuns)
      .where(and(eq(lineupCaptureRuns.seasonId, seasonId), eq(lineupCaptureRuns.week, week)))
      .orderBy(desc(lineupCaptureRuns.createdAt))
      .limit(10),
  ]);

  const lineups: CapturedLineup[] = lineupRows
    .map((r) => ({
      ownerSeasonId: r.ownerSeasonId,
      // Per-season display name wins, mirroring the rest of the app.
      ownerName: r.displayName ?? r.ownerName,
      teamKey: r.teamKey ?? null,
      dkEntryName: r.dkEntryName,
      capturedAt: r.capturedAt,
      slots: (r.slots as LineupSlotInput[]) ?? [],
      dkEntryKey: r.dkEntryKey,
    }))
    .sort((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime());

  return {
    seasonId,
    week,
    expected: expectedRows[0]?.count ?? 0,
    lineups,
    runs: runRows,
  };
}
