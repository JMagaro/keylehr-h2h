/**
 * DraftKings leaderboard ingest.
 *
 * Takes a parsed DraftKings contest leaderboard (a list of entries: entry name +
 * fantasy points) and records each owner's weekly `scores` row for one season/week.
 *
 * This is the production ingest path the DK Browser-Sync Chrome extension will reuse:
 * the extension scrapes the live leaderboard into the same `entries` shape and POSTs
 * it; the backfill script (Master Scores → {@link writeTeamScores}) reuses the same
 * upsert/bye logic. Both converge on identical `scores` rows.
 *
 * Matching: each leaderboard entry is matched to an owner by case-insensitive,
 * trimmed `entryName` against that season's `owner_seasons.dkEntryName` (falling back
 * to `owners.dkUsername`). Unmatched entries are reported, not persisted.
 *
 * Byes: an owner whose NFL team is on a bye that week has no `matchups` row that week.
 * Such an owner-week is marked `isBye = true` so the standings engine ignores it (a bye
 * score must never count toward PF/PA or W-L-T). Byes are derived from the `matchups`
 * table — the single source of truth for who actually plays a given week.
 *
 * Idempotent: scores upsert on the `(ownerSeasonId, week)` unique index, and re-running
 * converges. Every call also writes a `scoreImportRuns` audit row.
 */
import { and, eq, inArray } from 'drizzle-orm';

import {
  db,
  matchups,
  nflTeams,
  owners,
  ownerSeasons,
  scoreImportRuns,
  scores,
} from '@/db';

/** Score provenance, mirroring the `score_source` enum in the DB schema. */
export type ScoreSource = 'auto' | 'manual';

/** One parsed leaderboard entry (the shape the Chrome extension produces). */
export interface LeaderboardEntry {
  /** DraftKings entry/username as shown on the leaderboard. */
  entryName: string;
  /** Fantasy points for the week. */
  points: number;
  /** Leaderboard rank, if known (informational only). */
  rank?: number;
  /** DraftKings entry key/id, if known (stored for traceability). */
  entryKey?: string;
}

/** Parameters for {@link ingestLeaderboard}. */
export interface IngestParams {
  seasonId: number;
  week: number;
  entries: LeaderboardEntry[];
  /** DraftKings contest id this leaderboard came from, if known. */
  contestId?: string;
  /** Score provenance — 'auto' for the extension/cron, 'manual' for paste/backfill. */
  source: ScoreSource;
  /** Who/what triggered the import, e.g. 'cron' | 'admin:<email>' | 'backfill'. */
  triggeredBy?: string;
}

/** Result of an ingest run. */
export interface IngestResult {
  /** Number of leaderboard entries matched to an owner and written. */
  matched: number;
  /** Entry names that matched no owner this season (verbatim, for diagnosis). */
  unmatched: string[];
  /** Total leaderboard entries supplied. */
  total: number;
  /** Owner-weeks marked as byes (these had a written score but no matchup). */
  byes: number;
  /** The id of the `scoreImportRuns` audit row created. */
  importRunId: number;
}

/** An owner's season identity used for matching leaderboard entries. */
interface OwnerSeasonMatchRow {
  ownerSeasonId: number;
  dkEntryName: string | null;
  dkUsername: string | null;
}

/** Normalize an entry name for case-insensitive, trimmed matching. */
function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Load the season's owners and build a normalized-name → ownerSeasonId map.
 * Prefers `dkEntryName`; falls back to `dkUsername`. Both keys (when distinct) map
 * to the same owner so either form on the leaderboard matches.
 */
async function loadNameMap(seasonId: number): Promise<{
  byName: Map<string, number>;
  rows: OwnerSeasonMatchRow[];
}> {
  const rows = await db
    .select({
      ownerSeasonId: ownerSeasons.id,
      dkEntryName: ownerSeasons.dkEntryName,
      dkUsername: owners.dkUsername,
    })
    .from(ownerSeasons)
    .innerJoin(owners, eq(ownerSeasons.ownerId, owners.id))
    .where(eq(ownerSeasons.seasonId, seasonId));

  const byName = new Map<string, number>();
  for (const r of rows) {
    if (r.dkEntryName) byName.set(normalizeName(r.dkEntryName), r.ownerSeasonId);
    // Only fall back to username when it does not collide with an explicit entry name.
    if (r.dkUsername) {
      const key = normalizeName(r.dkUsername);
      if (!byName.has(key)) byName.set(key, r.ownerSeasonId);
    }
  }
  return { byName, rows };
}

/** Load the set of ownerSeasonIds that have a matchup (i.e. are NOT on bye) this week. */
async function loadPlayingOwnerSeasonIds(
  seasonId: number,
  week: number,
): Promise<Set<number>> {
  const rows = await db
    .select({
      home: matchups.homeOwnerSeasonId,
      away: matchups.awayOwnerSeasonId,
    })
    .from(matchups)
    .where(and(eq(matchups.seasonId, seasonId), eq(matchups.week, week)));

  const playing = new Set<number>();
  for (const r of rows) {
    playing.add(r.home);
    playing.add(r.away);
  }
  return playing;
}

/**
 * Upsert a batch of `(ownerSeasonId → points)` scores for one season/week.
 * Shared by {@link ingestLeaderboard} and {@link writeTeamScores}. Marks isBye for any
 * owner with no matchup that week. Returns how many byes were written.
 */
async function upsertScores(params: {
  seasonId: number;
  week: number;
  byOwnerSeason: Map<number, { points: number; entryKey?: string }>;
  source: ScoreSource;
  contestId?: string;
  importRunId: number;
  playing: Set<number>;
}): Promise<number> {
  const { seasonId, week, byOwnerSeason, source, contestId, importRunId, playing } = params;
  let byes = 0;

  for (const [ownerSeasonId, { points, entryKey }] of byOwnerSeason) {
    const isBye = !playing.has(ownerSeasonId);
    if (isBye) byes += 1;

    await db
      .insert(scores)
      .values({
        seasonId,
        ownerSeasonId,
        week,
        dkPoints: points.toFixed(2),
        source,
        isBye,
        dkContestId: contestId ?? null,
        dkEntryKey: entryKey ?? null,
        importRunId,
      })
      .onConflictDoUpdate({
        target: [scores.ownerSeasonId, scores.week],
        set: {
          dkPoints: points.toFixed(2),
          source,
          isBye,
          dkContestId: contestId ?? null,
          dkEntryKey: entryKey ?? null,
          importRunId,
          updatedAt: new Date(),
        },
      });
  }

  return byes;
}

/**
 * Ingest a DraftKings leaderboard for one season/week.
 *
 * Matches each entry to an owner by entry name, upserts that owner's weekly score,
 * marks bye owners, and records a `scoreImportRuns` audit row. Unmatched entries are
 * reported (not written). Idempotent on `(ownerSeasonId, week)`.
 */
export async function ingestLeaderboard(params: IngestParams): Promise<IngestResult> {
  const { seasonId, week, entries, contestId, source, triggeredBy } = params;

  const { byName } = await loadNameMap(seasonId);
  const playing = await loadPlayingOwnerSeasonIds(seasonId, week);

  const byOwnerSeason = new Map<number, { points: number; entryKey?: string }>();
  const unmatched: string[] = [];

  for (const entry of entries) {
    const ownerSeasonId = byName.get(normalizeName(entry.entryName));
    if (ownerSeasonId === undefined) {
      unmatched.push(entry.entryName);
      continue;
    }
    // Last write wins if a name appears twice (shouldn't, but be deterministic).
    byOwnerSeason.set(ownerSeasonId, { points: entry.points, entryKey: entry.entryKey });
  }

  const matched = byOwnerSeason.size;
  const status = unmatched.length === 0 ? 'success' : 'partial';

  // Record the audit run first so scores can reference its id.
  const [run] = await db
    .insert(scoreImportRuns)
    .values({
      seasonId,
      week,
      dkContestId: contestId ?? null,
      status,
      entriesTotal: entries.length,
      entriesMatched: matched,
      entriesUnmatched: unmatched.length,
      triggeredBy: triggeredBy ?? null,
      rawPayload: entries as unknown as object,
    })
    .returning({ id: scoreImportRuns.id });

  const byes = await upsertScores({
    seasonId,
    week,
    byOwnerSeason,
    source,
    contestId,
    importRunId: run.id,
    playing,
  });

  return { matched, unmatched, total: entries.length, byes, importRunId: run.id };
}

/** Parameters for {@link writeTeamScores}. */
export interface WriteTeamScoresParams {
  seasonId: number;
  week: number;
  /** NFL team name (matches `nfl_teams.name`, e.g. "Colts") → fantasy points. */
  byTeam: Map<string, number>;
  source?: ScoreSource;
  triggeredBy?: string;
  contestId?: string;
}

/** Result of a {@link writeTeamScores} call. */
export interface WriteTeamScoresResult {
  matched: number;
  unmatched: string[];
  byes: number;
  importRunId: number;
}

/**
 * Backfill scores keyed by NFL team name (the shape of the league's "Master Scores"
 * sheet). Resolves each team name to that season's owner via `owner_seasons`, then
 * reuses the same upsert/bye logic as {@link ingestLeaderboard}.
 *
 * This is the bridge used to replay a historical season from the Google Sheet; it is
 * NOT how live weeks are scored (that is {@link ingestLeaderboard}).
 */
export async function writeTeamScores(
  params: WriteTeamScoresParams,
): Promise<WriteTeamScoresResult> {
  const { seasonId, week, byTeam, source = 'manual', triggeredBy, contestId } = params;

  // team name (lowercased) -> ownerSeasonId for this season.
  const teamRows = await db
    .select({
      ownerSeasonId: ownerSeasons.id,
      teamName: nflTeams.name,
    })
    .from(ownerSeasons)
    .innerJoin(nflTeams, eq(ownerSeasons.nflTeamId, nflTeams.id))
    .where(eq(ownerSeasons.seasonId, seasonId));

  const byTeamNameLc = new Map<string, number>();
  for (const r of teamRows) byTeamNameLc.set(r.teamName.trim().toLowerCase(), r.ownerSeasonId);

  const playing = await loadPlayingOwnerSeasonIds(seasonId, week);

  const byOwnerSeason = new Map<number, { points: number }>();
  const unmatched: string[] = [];
  for (const [teamName, points] of byTeam) {
    const ownerSeasonId = byTeamNameLc.get(teamName.trim().toLowerCase());
    if (ownerSeasonId === undefined) {
      unmatched.push(teamName);
      continue;
    }
    byOwnerSeason.set(ownerSeasonId, { points });
  }

  const matched = byOwnerSeason.size;
  const status = unmatched.length === 0 ? 'success' : 'partial';

  const [run] = await db
    .insert(scoreImportRuns)
    .values({
      seasonId,
      week,
      dkContestId: contestId ?? null,
      status,
      entriesTotal: byTeam.size,
      entriesMatched: matched,
      entriesUnmatched: unmatched.length,
      triggeredBy: triggeredBy ?? 'backfill',
    })
    .returning({ id: scoreImportRuns.id });

  const byes = await upsertScores({
    seasonId,
    week,
    byOwnerSeason,
    source,
    contestId,
    importRunId: run.id,
    playing,
  });

  return { matched, unmatched, byes, importRunId: run.id };
}
