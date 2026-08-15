/**
 * Persist captured DraftKings rosters.
 *
 * Deliberately mirrors `src/lib/scores/ingest.ts`: audit row first, shared owner matching,
 * `isExhibition` derived from the week alone, chunked multi-row upserts (every Neon HTTP
 * query is a network round-trip, so 32 sequential inserts would eat a serverless function's
 * budget).
 *
 * SAFETY INVARIANT: this module writes ONLY to `lineup_snapshots` and `lineup_capture_runs`.
 * It must never touch `scores`, `matchups`, or anything the standings engine reads. Rosters
 * feed an ESTIMATE; the authoritative weekly number stays the DraftKings leaderboard.
 * See docs/SCORING.md §15.
 */
import { eq, sql } from 'drizzle-orm';

import { db, lineupCaptureRuns, lineupSnapshots } from '@/db';
import { isExhibitionWeek } from '@/lib/schedule/preseason';
import { loadOwnerNameMap, normalizeEntryName } from '@/lib/scores/owner-match';

import { enrichLineups } from './enrich';
import type { LineupInput, LineupSlotInput } from './normalize';

export interface IngestLineupsParams {
  seasonId: number;
  /** Regular/playoff (1–25) or preseason exhibition (101–103). */
  week: number;
  lineups: LineupInput[];
  /**
   * When DraftKings' roster was READ — not when this row is written. Late-swap resolution
   * compares this against each player's kickoff, so a wrong value silently mislabels slots
   * as locked. Callers that don't know it should pass `new Date()` at fetch time.
   */
  capturedAt: Date;
  contestId?: string;
  draftGroupId?: string;
  /** The DK URL template that produced this payload, for documentation. */
  sourceUrlTemplate?: string;
  /** 'extension' | 'admin:paste' | … */
  triggeredBy?: string;
  /** Raw payload retained for debugging/replay. */
  rawPayload?: unknown;
}

export interface IngestLineupsResult {
  matched: number;
  /** DraftKings entry names we could not resolve to an owner — surfaced, never dropped. */
  unmatched: string[];
  total: number;
  snapshots: number;
  captureRunId: number;
  /** Slots that gained a team key from the public draftables endpoint. */
  enrichedSlots: number;
  /** Revealed draftableIds the draft group didn't know — surfaced, never silently zeroed. */
  unresolvedDraftableIds: string[];
}

/** How many snapshot rows to write per round-trip. */
const UPSERT_BATCH = 100;

/**
 * Match each captured lineup to an owner and store it as a versioned snapshot.
 *
 * Idempotent per `(ownerSeasonId, week, capturedAt)`: re-posting the same capture updates
 * that row rather than accumulating duplicates, so a retried extension sync is harmless.
 * A capture with a NEW `capturedAt` inserts a new version — that is what makes late-swap
 * resolution possible.
 */
export async function ingestLineups(
  params: IngestLineupsParams,
): Promise<IngestLineupsResult> {
  const {
    seasonId,
    week,
    lineups,
    capturedAt,
    contestId,
    draftGroupId,
    sourceUrlTemplate,
    triggeredBy,
    rawPayload,
  } = params;

  // Resolve draftableIds to (name, team, position) BEFORE storing. DK expires draftables for
  // old draft groups, so a snapshot that doesn't carry teams is unscorable forever after.
  const {
    lineups: resolved,
    enriched: enrichedSlots,
    unresolvedIds: unresolvedDraftableIds,
  } = draftGroupId
    ? await enrichLineups(lineups, draftGroupId)
    : { lineups, enriched: 0, unresolvedIds: [] as string[] };

  const { byName } = await loadOwnerNameMap(seasonId);

  const byOwnerSeason = new Map<number, LineupInput>();
  const unmatched: string[] = [];

  for (const lineup of resolved) {
    const ownerSeasonId = byName.get(normalizeEntryName(lineup.entryName));
    if (ownerSeasonId === undefined) {
      unmatched.push(lineup.entryName);
      continue;
    }
    // Last write wins if a name appears twice (shouldn't, but be deterministic).
    byOwnerSeason.set(ownerSeasonId, lineup);
  }

  const matched = byOwnerSeason.size;
  const status = unmatched.length === 0 ? 'success' : 'partial';

  // Record the audit run first so snapshots can reference its id.
  const [run] = await db
    .insert(lineupCaptureRuns)
    .values({
      seasonId,
      week,
      dkContestId: contestId ?? null,
      status,
      entriesTotal: lineups.length,
      entriesMatched: matched,
      entriesUnmatched: unmatched.length,
      triggeredBy: triggeredBy ?? null,
      sourceUrlTemplate: sourceUrlTemplate ?? null,
      rawPayload: (rawPayload ?? lineups) as object,
    })
    .returning({ id: lineupCaptureRuns.id });

  // A preseason week (stored at the exhibition offset) flags the snapshot as exhibition, so
  // the live view isolates it exactly like scores and matchups do.
  const isExhibition = isExhibitionWeek(week);

  const rows = [...byOwnerSeason].map(([ownerSeasonId, lineup]) => ({
    seasonId,
    ownerSeasonId,
    week,
    isExhibition,
    dkContestId: contestId ?? null,
    dkDraftGroupId: draftGroupId ?? null,
    dkEntryKey: lineup.entryKey ?? null,
    capturedAt,
    slots: lineup.slots as unknown as object,
    captureRunId: run.id,
  }));

  // The audit row was written optimistically above so snapshots could reference its id. If a
  // batch now fails, that row would otherwise sit there claiming 'success' forever — an audit
  // log that lies about whether the data landed is worse than none. Mark it 'failed' and
  // re-throw so the caller still surfaces the error.
  try {
    for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
      await db
        .insert(lineupSnapshots)
        .values(rows.slice(i, i + UPSERT_BATCH))
        .onConflictDoUpdate({
          target: [lineupSnapshots.ownerSeasonId, lineupSnapshots.week, lineupSnapshots.capturedAt],
          set: {
            slots: sql`excluded.slots`,
            isExhibition: sql`excluded.is_exhibition`,
            dkContestId: sql`excluded.dk_contest_id`,
            dkDraftGroupId: sql`excluded.dk_draft_group_id`,
            dkEntryKey: sql`excluded.dk_entry_key`,
            captureRunId: sql`excluded.capture_run_id`,
          },
        });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await db
        .update(lineupCaptureRuns)
        .set({ status: 'failed', error: message })
        .where(eq(lineupCaptureRuns.id, run.id));
    } catch {
      // Best-effort: if the DB is unreachable we cannot annotate the run, but the original
      // error is what matters and is re-thrown below.
    }
    throw err;
  }

  return {
    matched,
    unmatched,
    total: lineups.length,
    snapshots: rows.length,
    captureRunId: run.id,
    enrichedSlots,
    unresolvedDraftableIds,
  };
}

/** Re-exported so callers don't need two imports to describe a lineup. */
export type { LineupInput, LineupSlotInput };
