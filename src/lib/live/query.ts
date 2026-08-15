/**
 * The only database module behind /live. Four Neon round-trips, all reads.
 *
 * Neon's HTTP driver makes every query a network hop, so the shape here is deliberate:
 * four parallel queries rather than a chain, and `DISTINCT ON` to resolve "newest capture
 * per owner" in the database instead of over-fetching every version and sorting in JS.
 *
 * NOTHING HERE WRITES — not to `scores`, not to `matchups`, not to anything the standings
 * engine reads. Enforced mechanically by src/lib/lineups/no-write.test.ts.
 */
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import {
  db,
  lineupSnapshots,
  matchups,
  nflGames,
  nflTeams,
  owners,
  ownerSeasons,
  seasons,
} from '@/db';
import type { GameState } from '@/lib/dfs/sources/espn-boxscore';
import { hydrateStoredSlots, type LineupSlotInput } from '@/lib/lineups/normalize';
import { isExhibitionWeek } from '@/lib/schedule/preseason';

import type { AssembleMatchup, AssembleSnapshot } from './assemble';
import type { LiveGameRef } from './stats';

/**
 * Per-NFL-team context for a week: who they play, when, and their logo.
 *
 * This is what lets a roster row read "@LAC Sun 4:25 PM" instead of just a team code — the
 * detail page needs to say something useful about a player whose game has not started, and
 * ESPN's live status only exists once it has.
 */
export interface LiveTeamContext {
  teamKey: string;
  name: string | null;
  logoEspn: string | null;
  opponentKey: string | null;
  isHome: boolean;
  kickoff: Date | null;
}

export interface LiveWeekData {
  matchups: AssembleMatchup[];
  snapshots: AssembleSnapshot[];
  games: LiveGameRef[];
  /** Keyed by `nfl_teams.key`. */
  teamContext: Record<string, LiveTeamContext>;
}

/** Map DraftKings-adjacent status text onto the three states ESPN's TTL table uses. */
function toGameState(status: string | null): GameState | undefined {
  if (!status) return undefined;
  const s = status.toLowerCase();
  if (s.includes('final') || s === 'post' || s.includes('complete')) return 'post';
  if (s.includes('progress') || s === 'in' || s.includes('live') || s.includes('halftime')) {
    return 'in';
  }
  if (s.includes('sched') || s === 'pre') return 'pre';
  return undefined;
}

/**
 * Which week /live should open on.
 *
 * The most recently CAPTURED week wins over the season's `currentWeek`, because a capture is
 * a deliberate act aimed at a specific week — during preseason the season pointer still says
 * week 1 while the only rosters that exist are exhibition ones, and opening on an empty week
 * would look like the feature was broken.
 */
export async function getDefaultLiveWeek(seasonId: number): Promise<number> {
  const [captured] = await db
    .select({ week: lineupSnapshots.week })
    .from(lineupSnapshots)
    .where(eq(lineupSnapshots.seasonId, seasonId))
    .orderBy(desc(lineupSnapshots.capturedAt))
    .limit(1);
  if (captured) return captured.week;

  const [season] = await db
    .select({ currentWeek: seasons.currentWeek })
    .from(seasons)
    .where(eq(seasons.id, seasonId))
    .limit(1);
  return season?.currentWeek ?? 1;
}

/**
 * Locate a matchup so the detail page can load its week.
 *
 * The detail page then goes through the SAME `getLiveWeekData` + `getLiveStatsForWeek` path as
 * the list. That is deliberate: the week's stat index is already warm in the Data Cache, so
 * opening a matchup costs no additional ESPN traffic no matter how many people click through.
 */
export async function getMatchupLocation(
  matchupId: number,
): Promise<{ seasonId: number; week: number } | null> {
  const [row] = await db
    .select({ seasonId: matchups.seasonId, week: matchups.week })
    .from(matchups)
    .where(eq(matchups.id, matchupId))
    .limit(1);
  return row ?? null;
}

/**
 * Everything /live needs for one week.
 *
 * `isExhibition` is derived from the week and applied as a REQUIRED filter on matchups, not
 * a default. Exhibition weeks live at a separate namespace (101–103) and leaking them into a
 * regular-season read is precisely the bug the namespace exists to prevent.
 */
export async function getLiveWeekData(seasonId: number, week: number): Promise<LiveWeekData> {
  const isExhibition = isExhibitionWeek(week);

  const homeOwner = ownerSeasons;
  // `nfl_teams` is joined twice in the games query (home and away), so it needs two aliases.
  const homeTeam = alias(nflTeams, 'home_team');
  const awayTeam = alias(nflTeams, 'away_team');
  const [matchupRows, snapshotRows, gameRows] = await Promise.all([
    // Matchups with both sides' display data. Two joins per side, so this is one round-trip
    // rather than one per participant.
    db
      .select({
        id: matchups.id,
        homeOwnerSeasonId: matchups.homeOwnerSeasonId,
        awayOwnerSeasonId: matchups.awayOwnerSeasonId,
      })
      .from(matchups)
      .where(
        and(
          eq(matchups.seasonId, seasonId),
          eq(matchups.week, week),
          eq(matchups.isExhibition, isExhibition),
        ),
      )
      .orderBy(matchups.id),

    // Newest capture per owner. Late swap makes snapshots append-only, so "the roster in
    // effect" is the most recent row — DISTINCT ON resolves that in the database.
    db
      .selectDistinctOn([lineupSnapshots.ownerSeasonId], {
        ownerSeasonId: lineupSnapshots.ownerSeasonId,
        capturedAt: lineupSnapshots.capturedAt,
        slots: lineupSnapshots.slots,
      })
      .from(lineupSnapshots)
      .where(and(eq(lineupSnapshots.seasonId, seasonId), eq(lineupSnapshots.week, week)))
      .orderBy(lineupSnapshots.ownerSeasonId, desc(lineupSnapshots.capturedAt)),

    // The week's NFL games: ESPN event ids, a starting guess at each game's state, and both
    // teams' identity — the last of which is what makes a roster row able to say who a player
    // is playing and when.
    db
      .select({
        espnEventId: nflGames.espnEventId,
        status: nflGames.status,
        kickoff: nflGames.kickoff,
        homeKey: homeTeam.key,
        homeName: homeTeam.name,
        homeLogo: homeTeam.logoEspn,
        awayKey: awayTeam.key,
        awayName: awayTeam.name,
        awayLogo: awayTeam.logoEspn,
      })
      .from(nflGames)
      .innerJoin(homeTeam, eq(nflGames.homeTeamId, homeTeam.id))
      .innerJoin(awayTeam, eq(nflGames.awayTeamId, awayTeam.id))
      .where(
        and(
          eq(nflGames.seasonId, seasonId),
          eq(nflGames.week, week),
          isNotNull(nflGames.espnEventId),
        ),
      ),
  ]);

  const teamContext: Record<string, LiveTeamContext> = {};
  for (const g of gameRows) {
    teamContext[g.homeKey] = {
      teamKey: g.homeKey,
      name: g.homeName,
      logoEspn: g.homeLogo,
      opponentKey: g.awayKey,
      isHome: true,
      kickoff: g.kickoff,
    };
    teamContext[g.awayKey] = {
      teamKey: g.awayKey,
      name: g.awayName,
      logoEspn: g.awayLogo,
      opponentKey: g.homeKey,
      isHome: false,
      kickoff: g.kickoff,
    };
  }

  // Owner display data for everyone appearing in a matchup.
  const ownerRows = await db
    .select({
      ownerSeasonId: homeOwner.id,
      ownerName: owners.name,
      displayName: homeOwner.displayName,
      teamKey: nflTeams.key,
      logoEspn: nflTeams.logoEspn,
    })
    .from(homeOwner)
    .innerJoin(owners, eq(homeOwner.ownerId, owners.id))
    .leftJoin(nflTeams, eq(homeOwner.nflTeamId, nflTeams.id))
    .where(eq(homeOwner.seasonId, seasonId));

  const byOwnerSeason = new Map(
    ownerRows.map((r) => [
      r.ownerSeasonId,
      {
        ownerSeasonId: r.ownerSeasonId,
        // Per-season display name wins, mirroring the rest of the app.
        ownerName: r.displayName ?? r.ownerName,
        teamKey: r.teamKey ?? null,
        logoEspn: r.logoEspn ?? null,
      },
    ]),
  );

  const unknown = (id: number) => ({
    ownerSeasonId: id,
    ownerName: 'Unknown owner',
    teamKey: null,
    logoEspn: null,
  });

  return {
    matchups: matchupRows.map((m) => ({
      id: m.id,
      home: byOwnerSeason.get(m.homeOwnerSeasonId) ?? unknown(m.homeOwnerSeasonId),
      away: byOwnerSeason.get(m.awayOwnerSeasonId) ?? unknown(m.awayOwnerSeasonId),
    })),
    snapshots: snapshotRows.map((s) => ({
      ownerSeasonId: s.ownerSeasonId,
      capturedAt: s.capturedAt,
      slots: hydrateStoredSlots(s.slots),
    })),
    games: gameRows
      .filter((g) => Boolean(g.espnEventId))
      .map((g) => ({ espnEventId: g.espnEventId as string, state: toGameState(g.status) })),
    teamContext,
  };
}
