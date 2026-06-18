/**
 * Admin "data status" query (server-only) — powers the commissioner dashboard
 * checklist at `/admin`.
 *
 * For a single season it answers one operational question per data area: is the
 * data that the rest of the app depends on actually THERE, and if not, exactly
 * what is missing? Each area returns a derived `ok` flag, a short status label,
 * the relevant counts, and — when incomplete — the SPECIFIC missing items
 * (unassigned NFL teams, owners without a DK entry name, incomplete score weeks)
 * so the dashboard can name them inline instead of just showing a red X.
 *
 * The score area reuses `getSeasonSyncStatus`/`incompleteWeeks` so the dashboard
 * and the Sync page never disagree about which weeks need attention.
 *
 * Numeric columns come back from the Neon driver as strings; the only `Number`
 * conversions needed here are on `count(*)` aggregates, which we cast to `::int`
 * in SQL and read as numbers.
 */
import { and, eq, sql } from 'drizzle-orm';

import {
  db,
  matchups,
  nflGames,
  nflTeams,
  ownerSeasons,
  owners,
  seasonAwards,
  seasons,
} from '@/db';
import {
  getSeasonSyncStatus,
  incompleteWeeks,
  type SeasonSyncStatus,
} from '@/lib/scores/status';

/** The league always targets all 32 NFL teams / owners for a full season. */
export const FULL_LEAGUE_SIZE = 32;
/** A complete 18-week NFL regular season is 272 games (16 per week × 17). */
export const FULL_SCHEDULE_GAMES = 272;

/** A single NFL team, for the "unassigned teams" list. */
export interface UnassignedTeam {
  key: string;
  name: string;
  logoEspn: string | null;
}

/** An owner missing their DK entry name, for the "missing DK name" list. */
export interface MissingDkEntry {
  ownerName: string;
  teamKey: string;
  teamName: string;
}

/** Owners area: how many owner-season rows exist vs the league target. */
export interface OwnersStatus {
  ok: boolean;
  label: string;
  count: number;
  target: number;
}

/** Team assignments area: assigned count + the teams NOT yet assigned. */
export interface AssignmentsStatus {
  ok: boolean;
  label: string;
  assigned: number;
  target: number;
  unassignedTeams: UnassignedTeam[];
}

/** DK entry names area: how many owners have one + who is missing it. */
export interface DkEntryNamesStatus {
  ok: boolean;
  label: string;
  withName: number;
  total: number;
  missing: MissingDkEntry[];
}

/** Schedule area: NFL games loaded + whether that looks like a full season. */
export interface ScheduleStatus {
  ok: boolean;
  label: string;
  games: number;
  expected: number;
  scheduleLoaded: boolean;
}

/** Matchups area: head-to-head matchup rows generated for the season. */
export interface MatchupsStatus {
  ok: boolean;
  label: string;
  count: number;
}

/** Weekly scores area: a thin projection of the shared sync status. */
export interface ScoresStatus {
  ok: boolean;
  label: string;
  weeksComplete: number;
  regularSeasonWeeks: number;
  incompleteWeeks: number[];
  weeksNeedingAttention: number;
  lastSyncAt: Date | null;
}

/** Champion area: whether a `champion` award row is recorded for the season. */
export interface AwardsStatus {
  ok: boolean;
  label: string;
  championRecorded: boolean;
}

/** Bare season identity carried alongside the status for the page header. */
export interface SeasonMeta {
  id: number;
  name: string;
  status: 'upcoming' | 'active' | 'completed';
  currentWeek: number;
  regularSeasonWeeks: number;
}

/** The full per-season data status returned to the dashboard. */
export interface SeasonDataStatus {
  season: SeasonMeta;
  owners: OwnersStatus;
  assignments: AssignmentsStatus;
  dkEntryNames: DkEntryNamesStatus;
  schedule: ScheduleStatus;
  matchups: MatchupsStatus;
  scores: ScoresStatus;
  awards: AwardsStatus;
}

/** Read a single `count(*)::int` for a table filtered to the season. */
async function countForSeason(
  table: typeof nflGames | typeof matchups | typeof ownerSeasons,
  seasonId: number,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(table)
    .where(eq(table.seasonId, seasonId));
  return row?.n ?? 0;
}

/**
 * Compute the full data-status checklist for one season.
 *
 * @param seasonId  The season to inspect.
 * @returns         Per-area counts, missing-item lists, and derived `ok` flags,
 *                  plus the season meta. Throws if the season does not exist.
 */
export async function getSeasonDataStatus(seasonId: number): Promise<SeasonDataStatus> {
  const [seasonRow] = await db
    .select({
      id: seasons.id,
      name: seasons.name,
      status: seasons.status,
      currentWeek: seasons.currentWeek,
      regularSeasonWeeks: seasons.regularSeasonWeeks,
    })
    .from(seasons)
    .where(eq(seasons.id, seasonId))
    .limit(1);

  if (!seasonRow) {
    throw new Error(`Season ${seasonId} not found`);
  }

  const season: SeasonMeta = {
    id: seasonRow.id,
    name: seasonRow.name,
    status: seasonRow.status,
    currentWeek: seasonRow.currentWeek,
    regularSeasonWeeks: seasonRow.regularSeasonWeeks,
  };

  // Owner-season rows for the season, joined to owner + team identity. This one
  // query feeds the owners count, the assignments count, and the DK-name gaps.
  const osRows = await db
    .select({
      ownerName: sql<string>`coalesce(${ownerSeasons.displayName}, ${owners.name})`,
      teamId: nflTeams.id,
      teamKey: nflTeams.key,
      teamName: nflTeams.name,
      dkEntryName: ownerSeasons.dkEntryName,
    })
    .from(ownerSeasons)
    .innerJoin(owners, eq(ownerSeasons.ownerId, owners.id))
    .innerJoin(nflTeams, eq(ownerSeasons.nflTeamId, nflTeams.id))
    .where(eq(ownerSeasons.seasonId, seasonId));

  // The NFL teams already assigned this season, for the unassigned-teams diff.
  const assignedTeamIds = new Set(osRows.map((r) => r.teamId));

  // All 32 teams, so we can list the ones NOT yet assigned (name + key + logo).
  const allTeams = await db
    .select({
      id: nflTeams.id,
      key: nflTeams.key,
      name: nflTeams.name,
      logoEspn: nflTeams.logoEspn,
    })
    .from(nflTeams)
    .orderBy(nflTeams.name);

  const unassignedTeams: UnassignedTeam[] = allTeams
    .filter((t) => !assignedTeamIds.has(t.id))
    .map((t) => ({ key: t.key, name: t.name, logoEspn: t.logoEspn }));

  // --- Owners --------------------------------------------------------------
  const ownerCount = osRows.length;
  const ownersStatus: OwnersStatus = {
    ok: ownerCount >= FULL_LEAGUE_SIZE,
    label:
      ownerCount >= FULL_LEAGUE_SIZE
        ? 'All owners added'
        : `${FULL_LEAGUE_SIZE - ownerCount} owner${FULL_LEAGUE_SIZE - ownerCount === 1 ? '' : 's'} to add`,
    count: ownerCount,
    target: FULL_LEAGUE_SIZE,
  };

  // --- Team assignments ----------------------------------------------------
  const assignedCount = assignedTeamIds.size;
  const assignmentsStatus: AssignmentsStatus = {
    ok: unassignedTeams.length === 0 && assignedCount === FULL_LEAGUE_SIZE,
    label:
      unassignedTeams.length === 0 && assignedCount === FULL_LEAGUE_SIZE
        ? 'All 32 teams assigned'
        : `${unassignedTeams.length} team${unassignedTeams.length === 1 ? '' : 's'} unassigned`,
    assigned: assignedCount,
    target: FULL_LEAGUE_SIZE,
    unassignedTeams,
  };

  // --- DK entry names ------------------------------------------------------
  const missing: MissingDkEntry[] = osRows
    .filter((r) => !r.dkEntryName || r.dkEntryName.trim() === '')
    .map((r) => ({ ownerName: r.ownerName, teamKey: r.teamKey, teamName: r.teamName }));
  const withName = ownerCount - missing.length;
  const dkEntryNamesStatus: DkEntryNamesStatus = {
    // OK only when there are owners and every one has a non-empty DK entry name.
    ok: ownerCount > 0 && missing.length === 0,
    label:
      ownerCount === 0
        ? 'No owners yet'
        : missing.length === 0
          ? 'All DK entry names set'
          : `${missing.length} missing DK entry name${missing.length === 1 ? '' : 's'}`,
    withName,
    total: ownerCount,
    missing,
  };

  // --- Schedule ------------------------------------------------------------
  const gameCount = await countForSeason(nflGames, seasonId);
  const scheduleLoaded = gameCount >= FULL_SCHEDULE_GAMES;
  const scheduleStatus: ScheduleStatus = {
    ok: scheduleLoaded,
    label: scheduleLoaded
      ? 'Full schedule loaded'
      : gameCount === 0
        ? 'No schedule loaded'
        : `Partial schedule (${gameCount} / ${FULL_SCHEDULE_GAMES} games)`,
    games: gameCount,
    expected: FULL_SCHEDULE_GAMES,
    scheduleLoaded,
  };

  // --- Matchups ------------------------------------------------------------
  const matchupCount = await countForSeason(matchups, seasonId);
  const matchupsStatus: MatchupsStatus = {
    ok: matchupCount > 0,
    label:
      matchupCount > 0
        ? `${matchupCount} matchups generated`
        : 'No matchups generated',
    count: matchupCount,
  };

  // --- Weekly scores (reuse the shared sync status) ------------------------
  const sync: SeasonSyncStatus = await getSeasonSyncStatus(seasonId, new Date());
  const incomplete = incompleteWeeks(sync);
  const weeksComplete = sync.summary.byHealth.complete;
  const scoresStatus: ScoresStatus = {
    // OK when no week needs attention (games-final-but-unscored / partial).
    ok: sync.summary.weeksNeedingAttention === 0,
    label:
      sync.summary.weeksNeedingAttention === 0
        ? weeksComplete > 0
          ? `${weeksComplete} week${weeksComplete === 1 ? '' : 's'} scored, none need attention`
          : 'No weeks need attention yet'
        : `${sync.summary.weeksNeedingAttention} week${sync.summary.weeksNeedingAttention === 1 ? '' : 's'} need a re-sync`,
    weeksComplete,
    regularSeasonWeeks: sync.regularSeasonWeeks,
    incompleteWeeks: incomplete,
    weeksNeedingAttention: sync.summary.weeksNeedingAttention,
    lastSyncAt: sync.summary.lastSyncAt,
  };

  // --- Champion award ------------------------------------------------------
  const championRows = await db
    .select({ id: seasonAwards.id })
    .from(seasonAwards)
    .where(and(eq(seasonAwards.seasonId, seasonId), eq(seasonAwards.type, 'champion')))
    .limit(1);
  const championRecorded = championRows.length > 0;
  const awardsStatus: AwardsStatus = {
    ok: championRecorded,
    label: championRecorded ? 'Champion recorded' : 'No champion recorded',
    championRecorded,
  };

  return {
    season,
    owners: ownersStatus,
    assignments: assignmentsStatus,
    dkEntryNames: dkEntryNamesStatus,
    schedule: scheduleStatus,
    matchups: matchupsStatus,
    scores: scoresStatus,
    awards: awardsStatus,
  };
}
