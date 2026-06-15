/**
 * Owner-vs-owner matchup generation.
 *
 * Derives the league's head-to-head schedule from the real NFL schedule. Each owner
 * is assigned exactly one NFL team for the season (a row in `owner_seasons`). In a
 * given week, the owner of team A plays the owner of team B whenever A faces B in the
 * real NFL that week. If an owner's team is on a bye that week, that owner simply has
 * no `matchups` row — byes produce no matchup and are counted in the summary.
 *
 * Mapping: each `nfl_games` row becomes at most one `matchups` row. We carry the
 * NFL game's home/away orientation through to the matchup (home team's owner ->
 * homeOwnerSeason). Games where either team is not yet assigned to an owner are
 * skipped gracefully (the league may not have all 32 teams claimed yet).
 *
 * Idempotency key: the `matchups_season_week_home_uq` unique index on
 * (seasonId, week, homeOwnerSeasonId). On conflict we update the away owner and the
 * linked NFL game so re-running after roster or schedule changes converges cleanly.
 *
 * NOTE: this only generates regular-season matchups (isPlayoff defaults to false).
 * Playoff brackets are handled separately (`playoff_matchups`).
 */
import { eq, sql } from 'drizzle-orm';

import { db, matchups, nflGames, ownerSeasons, type NewMatchup } from '@/db';

/** Summary returned by {@link generateMatchups}. */
export interface GenerateSummary {
  /** Number of `matchups` rows inserted or updated. */
  matchupsUpserted: number;
  /**
   * Number of "bye slots": (owner, week) pairs where the owner had an assigned team
   * but that team had no NFL game that week. Reported for diagnostics/UI.
   */
  byes: number;
  /**
   * NFL games skipped because one or both teams were not yet assigned to an owner.
   * Expected to be non-zero until all 32 teams are claimed.
   */
  gamesSkippedUnassigned: number;
}

/**
 * Generate (or refresh) all owner-vs-owner matchups for a season from its NFL games.
 *
 * @param seasonId The local `seasons.id`.
 * @returns A {@link GenerateSummary}.
 */
export async function generateMatchups(seasonId: number): Promise<GenerateSummary> {
  // 1. team -> ownerSeason for this season.
  const assignments = await db
    .select({ ownerSeasonId: ownerSeasons.id, nflTeamId: ownerSeasons.nflTeamId })
    .from(ownerSeasons)
    .where(eq(ownerSeasons.seasonId, seasonId));

  const teamToOwnerSeason = new Map<number, number>();
  for (const a of assignments) teamToOwnerSeason.set(a.nflTeamId, a.ownerSeasonId);

  // 2. All NFL games for the season.
  const games = await db
    .select({
      id: nflGames.id,
      week: nflGames.week,
      homeTeamId: nflGames.homeTeamId,
      awayTeamId: nflGames.awayTeamId,
    })
    .from(nflGames)
    .where(eq(nflGames.seasonId, seasonId));

  // 3. Build matchup rows for games where BOTH teams have owners, and track which
  //    (owner, week) slots are filled so we can compute byes for the rest.
  const rows: NewMatchup[] = [];
  let gamesSkippedUnassigned = 0;
  /** week -> set of ownerSeasonIds that play that week. */
  const playingByWeek = new Map<number, Set<number>>();
  const weeks = new Set<number>();

  for (const game of games) {
    weeks.add(game.week);

    const homeOwnerSeasonId = teamToOwnerSeason.get(game.homeTeamId);
    const awayOwnerSeasonId = teamToOwnerSeason.get(game.awayTeamId);

    if (homeOwnerSeasonId === undefined || awayOwnerSeasonId === undefined) {
      gamesSkippedUnassigned += 1;
      continue;
    }

    rows.push({
      seasonId,
      week: game.week,
      homeOwnerSeasonId,
      awayOwnerSeasonId,
      nflGameId: game.id,
    });

    let playing = playingByWeek.get(game.week);
    if (!playing) {
      playing = new Set<number>();
      playingByWeek.set(game.week, playing);
    }
    playing.add(homeOwnerSeasonId);
    playing.add(awayOwnerSeasonId);
  }

  // 4. Upsert matchups idempotently.
  let matchupsUpserted = 0;
  for (const row of rows) {
    await db
      .insert(matchups)
      .values(row)
      .onConflictDoUpdate({
        target: [matchups.seasonId, matchups.week, matchups.homeOwnerSeasonId],
        set: {
          awayOwnerSeasonId: sql`excluded.away_owner_season_id`,
          nflGameId: sql`excluded.nfl_game_id`,
        },
      });
    matchupsUpserted += 1;
  }

  // 5. Compute byes: for every week that has games, any assigned owner who is not in
  //    that week's playing set is on a bye. We only count weeks that actually appear
  //    in the schedule so we never invent byes for weeks we have no data for.
  let byes = 0;
  const allOwnerSeasonIds = [...teamToOwnerSeason.values()];
  for (const week of weeks) {
    const playing = playingByWeek.get(week) ?? new Set<number>();
    for (const ownerSeasonId of allOwnerSeasonIds) {
      if (!playing.has(ownerSeasonId)) byes += 1;
    }
  }

  return { matchupsUpserted, byes, gamesSkippedUnassigned };
}
