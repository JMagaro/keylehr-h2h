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
 * Byes: an owner whose NFL team has no game that week is marked `isBye = true`, so the
 * standings engine ignores the row (a bye score must never count toward PF/PA or W-L-T).
 * Byes are derived from `nfl_games` — the actual NFL schedule — NOT from `matchups`, which
 * is itself derived and may be missing, incomplete, or structurally absent (see
 * {@link loadByeOwnerSeasonIds}). Playoff and preseason weeks never produce byes.
 *
 * Forfeits: this path deliberately does NOT write `scores.isForfeit`. A missed lineup is
 * derived at read time (`standings/forfeit-derive.ts`), because the worst case — an owner
 * who never enters the DK contest — leaves no row here to flag. A manually set
 * `isForfeit` is still honored as the commissioner's override.
 *
 * Idempotent: scores upsert on the `(ownerSeasonId, week)` unique index, and re-running
 * converges. Every call also writes a `scoreImportRuns` audit row.
 */
import { and, eq, sql } from 'drizzle-orm';

import {
  db,
  nflGames,
  nflTeams,
  owners,
  ownerSeasons,
  scoreImportRuns,
  scores,
  seasons,
} from '@/db';
import { isExhibitionWeek } from '@/lib/schedule/preseason';

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
  /** Owner-weeks marked as byes (a score was written, but their NFL team had no game). */
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

/**
 * The ownerSeasonIds on a BYE this week, derived from the NFL schedule.
 *
 * Deliberately reads `nfl_games`, not `matchups`. `matchups` is itself derived and is the
 * wrong authority in three situations that all really happen:
 *
 *   - it may not exist yet (scores synced before `generateMatchups` ran for the week), in
 *     which case every owner would look like a bye and lose their Points For;
 *   - it omits games whose teams are not both assigned to an owner (see
 *     `matchups/generate.ts`), so a playing owner could be mistaken for a bye;
 *   - it holds regular-season rows ONLY — playoff games live in `playoff_matchups` — so
 *     "no matchup row" is meaningless for weeks 19-22.
 *
 * A bye is a property of the NFL schedule: the owner's team simply has no game that week.
 */
async function loadByeOwnerSeasonIds(seasonId: number, week: number): Promise<Set<number>> {
  const [ownerRows, gameRows] = await Promise.all([
    db
      .select({ ownerSeasonId: ownerSeasons.id, nflTeamId: ownerSeasons.nflTeamId })
      .from(ownerSeasons)
      .where(eq(ownerSeasons.seasonId, seasonId)),
    db
      .select({ homeTeamId: nflGames.homeTeamId, awayTeamId: nflGames.awayTeamId })
      .from(nflGames)
      .where(and(eq(nflGames.seasonId, seasonId), eq(nflGames.week, week))),
  ]);

  // SAFETY VALVE: no schedule rows for this week means we simply do not know who is on a
  // bye — most likely the schedule has not been pulled yet. Marking all 32 owners as byes
  // is the catastrophic direction (it erases a whole week of Points For and the weekly-high
  // prize); marking none is benign and self-corrects on the next sync.
  if (gameRows.length === 0) return new Set();

  const playingTeams = new Set<number>();
  for (const g of gameRows) {
    playingTeams.add(g.homeTeamId);
    playingTeams.add(g.awayTeamId);
  }

  const byes = new Set<number>();
  for (const o of ownerRows) {
    if (!playingTeams.has(o.nflTeamId)) byes.add(o.ownerSeasonId);
  }
  return byes;
}

/**
 * Upsert a batch of `(ownerSeasonId → points)` scores for one season/week.
 * Shared by {@link ingestLeaderboard} and {@link writeTeamScores}. Returns how many
 * owner-weeks were written as byes.
 *
 * Byes come from the NFL schedule (see {@link loadByeOwnerSeasonIds}), and only ever apply
 * to the regular season: playoff weeks (19-22) and preseason exhibition weeks (101-103) are
 * written `isBye = false` unconditionally, matching what the playoff importers do.
 *
 * Note this never writes `isForfeit`. A missed lineup is derived at read time from the
 * schedule plus the settled-week gate (`standings/forfeit-derive.ts`), because it cannot be
 * known at ingest: the owner who forfeits hardest is the one who never enters the contest
 * at all, and so has no row here to flag.
 */
async function upsertScores(params: {
  seasonId: number;
  week: number;
  byOwnerSeason: Map<number, { points: number; entryKey?: string }>;
  source: ScoreSource;
  contestId?: string;
  importRunId: number;
  byeOwnerSeasonIds: ReadonlySet<number>;
}): Promise<number> {
  const { seasonId, week, byOwnerSeason, source, contestId, importRunId, byeOwnerSeasonIds } =
    params;
  // A preseason week (stored at the exhibition offset) → flag the scores as exhibition so
  // every standings/stats query excludes them, exactly like the matchups.
  const isExhibition = isExhibitionWeek(week);
  let byes = 0;

  const rows = [...byOwnerSeason].map(([ownerSeasonId, { points, entryKey }]) => {
    const isBye = byeOwnerSeasonIds.has(ownerSeasonId);
    if (isBye) byes += 1;
    return {
      seasonId,
      ownerSeasonId,
      week,
      dkPoints: points.toFixed(2),
      source,
      isBye,
      isExhibition,
      dkContestId: contestId ?? null,
      dkEntryKey: entryKey ?? null,
      importRunId,
    };
  });
  if (rows.length === 0) return 0;

  // Chunked multi-row upserts rather than one round-trip per owner. Every Neon HTTP query
  // is a network round-trip, so 32 sequential inserts eat a serverless function's budget —
  // the same failure mode that once broke the schedule pull. `byOwnerSeason` is already
  // keyed by ownerSeasonId, so the rows are unique on the conflict target.
  const UPSERT_BATCH = 100;
  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    await db
      .insert(scores)
      .values(rows.slice(i, i + UPSERT_BATCH))
      .onConflictDoUpdate({
        target: [scores.ownerSeasonId, scores.week],
        set: {
          dkPoints: sql`excluded.dk_points`,
          source: sql`excluded.source`,
          isBye: sql`excluded.is_bye`,
          isExhibition: sql`excluded.is_exhibition`,
          dkContestId: sql`excluded.dk_contest_id`,
          dkEntryKey: sql`excluded.dk_entry_key`,
          importRunId: sql`excluded.import_run_id`,
          updatedAt: new Date(),
        },
      });
  }

  return byes;
}

/**
 * The byes to apply when writing scores for a week. Regular-season weeks read the NFL
 * schedule; playoff and exhibition weeks never have byes.
 */
async function resolveByes(seasonId: number, week: number): Promise<Set<number>> {
  if (isExhibitionWeek(week)) return new Set();
  const [season] = await db
    .select({ regularSeasonWeeks: seasons.regularSeasonWeeks })
    .from(seasons)
    .where(eq(seasons.id, seasonId))
    .limit(1);
  if (week > (season?.regularSeasonWeeks ?? 18)) return new Set(); // playoff weeks
  return loadByeOwnerSeasonIds(seasonId, week);
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
  const byeOwnerSeasonIds = await resolveByes(seasonId, week);

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
    byeOwnerSeasonIds,
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

  const byeOwnerSeasonIds = await resolveByes(seasonId, week);

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
    byeOwnerSeasonIds,
  });

  return { matched, unmatched, byes, importRunId: run.id };
}
