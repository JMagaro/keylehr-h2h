/**
 * NFL schedule synchronization.
 *
 * Fetches a full regular-season schedule from ESPN and upserts it into `nfl_games`,
 * mapping ESPN team ids to our local `nfl_teams.id` via the `nfl_teams.espnId`
 * column. The operation is idempotent: re-running it updates kickoff/status/opponent
 * for existing rows rather than duplicating them.
 *
 * Idempotency key: the `nfl_games_season_week_home_uq` unique index on
 * (seasonId, week, homeTeamId). On conflict we update kickoff, status, espnEventId,
 * and awayTeamId — everything ESPN can revise for a rescheduled game while keeping
 * the same home team.
 */
import { sql } from 'drizzle-orm';

import { db, nflTeams, nflGames, type NewNflGame } from '@/db';
import {
  DEFAULT_REGULAR_SEASON_WEEKS,
  fetchSeasonSchedule,
} from '@/lib/espn/client';

/** Summary returned by {@link syncSeasonSchedule}. */
export interface SyncSummary {
  /** Distinct regular-season weeks that contained at least one upsertable game. */
  weeksProcessed: number;
  /** Number of `nfl_games` rows inserted or updated. */
  gamesUpserted: number;
  /**
   * ESPN team ids that could not be mapped to a local `nfl_teams` row. Should be
   * empty in normal operation; populated only if the teams table is out of date.
   */
  unmappedEspnTeamIds: string[];
}

/**
 * Synchronize one season's NFL schedule from ESPN into `nfl_games`.
 *
 * @param seasonId The local `seasons.id` to attach games to.
 * @param year     The NFL calendar year to pull from ESPN (e.g. 2026).
 * @param weeks    Number of regular-season weeks to pull (default 18).
 * @returns A {@link SyncSummary} describing what was processed.
 */
export async function syncSeasonSchedule(
  seasonId: number,
  year: number,
  weeks: number = DEFAULT_REGULAR_SEASON_WEEKS,
): Promise<SyncSummary> {
  // 1. Build the ESPN-team-id -> local-team-id map.
  const teams = await db
    .select({ id: nflTeams.id, espnId: nflTeams.espnId })
    .from(nflTeams);

  const espnToLocalId = new Map<string, number>();
  for (const team of teams) {
    if (team.espnId) espnToLocalId.set(team.espnId, team.id);
  }

  // 2. Pull the full schedule from ESPN.
  const games = await fetchSeasonSchedule(year, weeks);

  // 3. Resolve ESPN ids to local team ids; collect any that don't map.
  const rows: NewNflGame[] = [];
  const weeksSeen = new Set<number>();
  const unmapped = new Set<string>();

  for (const game of games) {
    const homeTeamId = espnToLocalId.get(game.homeEspnId);
    const awayTeamId = espnToLocalId.get(game.awayEspnId);

    if (homeTeamId === undefined) unmapped.add(game.homeEspnId);
    if (awayTeamId === undefined) unmapped.add(game.awayEspnId);

    // Skip games we can't fully resolve — never persist a dangling FK.
    if (homeTeamId === undefined || awayTeamId === undefined) continue;

    rows.push({
      seasonId,
      week: game.week,
      homeTeamId,
      awayTeamId,
      kickoff: game.kickoff,
      espnEventId: game.espnEventId,
      status: game.status,
    });
    weeksSeen.add(game.week);
  }

  // 4. Upsert. Drizzle batches a multi-row VALUES insert; the conflict target is the
  //    (season, week, home team) unique index. We update the volatile fields only.
  let gamesUpserted = 0;
  for (const row of rows) {
    await db
      .insert(nflGames)
      .values(row)
      .onConflictDoUpdate({
        target: [nflGames.seasonId, nflGames.week, nflGames.homeTeamId],
        set: {
          awayTeamId: sql`excluded.away_team_id`,
          kickoff: sql`excluded.kickoff`,
          espnEventId: sql`excluded.espn_event_id`,
          status: sql`excluded.status`,
        },
      });
    gamesUpserted += 1;
  }

  return {
    weeksProcessed: weeksSeen.size,
    gamesUpserted,
    unmappedEspnTeamIds: [...unmapped],
  };
}
