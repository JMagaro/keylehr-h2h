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
import type { LineupSlotInput } from '@/lib/lineups/normalize';
import { isExhibitionWeek } from '@/lib/schedule/preseason';

import type { AssembleMatchup, AssembleSnapshot } from './assemble';
import type { LiveGameRef } from './stats';

export interface LiveWeekData {
  matchups: AssembleMatchup[];
  snapshots: AssembleSnapshot[];
  games: LiveGameRef[];
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
 * Everything /live needs for one week.
 *
 * `isExhibition` is derived from the week and applied as a REQUIRED filter on matchups, not
 * a default. Exhibition weeks live at a separate namespace (101–103) and leaking them into a
 * regular-season read is precisely the bug the namespace exists to prevent.
 */
export async function getLiveWeekData(seasonId: number, week: number): Promise<LiveWeekData> {
  const isExhibition = isExhibitionWeek(week);

  const homeOwner = ownerSeasons;
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

    // The week's NFL games, for ESPN event ids and a starting guess at each game's state.
    db
      .select({ espnEventId: nflGames.espnEventId, status: nflGames.status })
      .from(nflGames)
      .where(
        and(
          eq(nflGames.seasonId, seasonId),
          eq(nflGames.week, week),
          isNotNull(nflGames.espnEventId),
        ),
      ),
  ]);

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
      slots: (s.slots as LineupSlotInput[]) ?? [],
    })),
    games: gameRows
      .filter((g): g is { espnEventId: string; status: string | null } => Boolean(g.espnEventId))
      .map((g) => ({ espnEventId: g.espnEventId, state: toGameState(g.status) })),
  };
}
