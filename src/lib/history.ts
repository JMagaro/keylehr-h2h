/**
 * History & all-time analytics (server-only).
 *
 * Powers the public `/history` page: per-season "champions & records" summaries
 * plus all-time, cross-season analytics aggregated by PERSON (owners.id), not by
 * per-season `ownerSeason`. The same person owning different NFL teams across
 * seasons rolls up to a single owner identity here.
 *
 * Standings ordering reuses the pure engine via `getSeasonStandings` (winPct →
 * Points For → Points Against), so the "top finisher" matches the rest of the app.
 * We have no playoff results persisted, so the season top finisher is labelled
 * "Regular-season #1"; if `seasonAwards` carries a `champion` row for a season we
 * surface that owner as the Champion instead (the table may be empty — tolerated).
 *
 * Numeric `numeric(7,2)` columns come back from the driver as strings; we convert
 * with `Number` exactly once, here.
 *
 * This module imports `@/db` and must only be used from server-side code.
 */
import { eq, inArray, sql } from 'drizzle-orm';

import {
  db,
  matchups,
  nflTeams,
  owners,
  ownerSeasons,
  scores,
  seasonAwards,
  seasons,
} from '@/db';

import {
  getSeasonOptions,
  getSeasonStandings,
  type SeasonStandingRow,
} from '@/lib/standings/query';

/* -------------------------------------------------------------------------- */
/* Per-season history (champions & records)                                    */
/* -------------------------------------------------------------------------- */

/** The owner who notched a single notable record in a season. */
export interface SeasonRecordHolder {
  ownerId: number;
  ownerName: string;
  teamKey: string;
  teamName: string;
  logoEspn: string | null;
}

/** A season's final summary: top finisher + that season's notable records. */
export interface SeasonHistory {
  seasonId: number;
  year: number;
  seasonName: string;
  status: 'upcoming' | 'active' | 'completed';
  /** Regular-season weeks with at least one finalized matchup. */
  weeksPlayed: number;
  ownerCount: number;
  /**
   * The headline finisher. `isChampion` is true when sourced from a
   * `seasonAwards` champion row; otherwise it's the regular-season #1.
   */
  topFinisher:
    | (SeasonRecordHolder & {
        isChampion: boolean;
        wins: number;
        losses: number;
        ties: number;
        pointsFor: number;
        winPct: number;
      })
    | null;
  /** Highest single-week score posted in the season. */
  highestWeek: (SeasonRecordHolder & { week: number; points: number }) | null;
  /** Most regular-season Points For. */
  pointsLeader: (SeasonRecordHolder & { pointsFor: number }) | null;
  /** Best regular-season record (by winPct → PF). */
  bestRecord:
    | (SeasonRecordHolder & {
        wins: number;
        losses: number;
        ties: number;
        winPct: number;
      })
    | null;
}

/** Internal: ownerSeasonId → owner identity for a season. */
type OwnerIdentityRow = {
  ownerSeasonId: number;
  ownerId: number;
  ownerName: string;
  teamKey: string;
  teamName: string;
  logoEspn: string | null;
};

async function loadOwnerIdentities(seasonId: number): Promise<Map<number, OwnerIdentityRow>> {
  const rows = await db
    .select({
      ownerSeasonId: ownerSeasons.id,
      ownerId: owners.id,
      ownerName: sql<string>`coalesce(${ownerSeasons.displayName}, ${owners.name})`,
      teamKey: nflTeams.key,
      teamName: nflTeams.name,
      logoEspn: nflTeams.logoEspn,
    })
    .from(ownerSeasons)
    .innerJoin(owners, eq(ownerSeasons.ownerId, owners.id))
    .innerJoin(nflTeams, eq(ownerSeasons.nflTeamId, nflTeams.id))
    .where(eq(ownerSeasons.seasonId, seasonId));
  return new Map(rows.map((r) => [r.ownerSeasonId, { ...r, logoEspn: r.logoEspn ?? null }]));
}

function holderFrom(id: OwnerIdentityRow): SeasonRecordHolder {
  return {
    ownerId: id.ownerId,
    ownerName: id.ownerName,
    teamKey: id.teamKey,
    teamName: id.teamName,
    logoEspn: id.logoEspn,
  };
}

/** Rank standings rows: winPct → PF → PA, returning the leader (or null). */
function topByStandings(rows: SeasonStandingRow[]): SeasonStandingRow | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => {
    if (b.winPct !== a.winPct) return b.winPct - a.winPct;
    if (b.pointsFor !== a.pointsFor) return b.pointsFor - a.pointsFor;
    return a.pointsAgainst - b.pointsAgainst;
  });
  return sorted[0] ?? null;
}

/**
 * For EVERY season that has data (owners assigned), the final regular-season
 * summary + notable records, newest year first.
 */
export async function getSeasonHistory(): Promise<SeasonHistory[]> {
  const options = await getSeasonOptions(); // newest year first

  // Which seasons actually have owners (data to summarize)?
  const ownerSeasonRows = await db
    .select({ seasonId: ownerSeasons.seasonId })
    .from(ownerSeasons);
  const seasonsWithData = new Set(ownerSeasonRows.map((r) => r.seasonId));

  // Champion awards (if any) keyed by season → ownerId. Tolerates an empty table.
  const championRows = await db
    .select({ seasonId: seasonAwards.seasonId, ownerId: seasonAwards.ownerId })
    .from(seasonAwards)
    .where(eq(seasonAwards.type, 'champion'));
  const championBySeason = new Map<number, number>();
  for (const r of championRows) {
    if (r.ownerId !== null && !championBySeason.has(r.seasonId)) {
      championBySeason.set(r.seasonId, r.ownerId);
    }
  }

  const out: SeasonHistory[] = [];
  for (const season of options) {
    if (!seasonsWithData.has(season.id)) continue;

    const identities = await loadOwnerIdentities(season.id);
    const standings = await getSeasonStandings(season.id);

    // Index standings by ownerSeasonId for record lookups.
    const standingByOwnerSeason = new Map(standings.map((s) => [s.ownerSeasonId, s]));

    // weeksPlayed: the max games played by any owner approximates the number of
    // regular-season weeks that have been scored.
    const gamesByOwner = standings.map((s) => s.gamesPlayed);
    const weeks = gamesByOwner.length ? Math.max(...gamesByOwner) : 0;

    // Top finisher: prefer a champion award row, else regular-season #1.
    const championOwnerId = championBySeason.get(season.id);
    let topFinisher: SeasonHistory['topFinisher'] = null;
    if (championOwnerId !== undefined) {
      // Find the champion's standings row by matching ownerId via identities.
      const champSeason = [...identities.values()].find((i) => i.ownerId === championOwnerId);
      if (champSeason) {
        const row = standingByOwnerSeason.get(champSeason.ownerSeasonId);
        topFinisher = {
          ...holderFrom(champSeason),
          isChampion: true,
          wins: row?.wins ?? 0,
          losses: row?.losses ?? 0,
          ties: row?.ties ?? 0,
          pointsFor: row?.pointsFor ?? 0,
          winPct: row?.winPct ?? 0,
        };
      }
    }
    if (!topFinisher) {
      const leader = topByStandings(standings);
      const id = leader ? identities.get(leader.ownerSeasonId) : undefined;
      if (leader && id) {
        topFinisher = {
          ...holderFrom(id),
          isChampion: false,
          wins: leader.wins,
          losses: leader.losses,
          ties: leader.ties,
          pointsFor: leader.pointsFor,
          winPct: leader.winPct,
        };
      }
    }

    // Highest single-week score (non-bye, non-null) in the season.
    const scoreRows = await db
      .select({
        ownerSeasonId: scores.ownerSeasonId,
        week: scores.week,
        dkPoints: scores.dkPoints,
      })
      .from(scores)
      .where(eq(scores.seasonId, season.id));
    let highestWeek: SeasonHistory['highestWeek'] = null;
    for (const s of scoreRows) {
      if (s.dkPoints === null) continue;
      const pts = Number(s.dkPoints);
      const id = identities.get(s.ownerSeasonId);
      if (!id) continue;
      if (!highestWeek || pts > highestWeek.points) {
        highestWeek = { ...holderFrom(id), week: s.week, points: pts };
      }
    }

    // Points leader: most regular-season Points For.
    let pointsLeader: SeasonHistory['pointsLeader'] = null;
    for (const s of standings) {
      const id = identities.get(s.ownerSeasonId);
      if (!id) continue;
      if (!pointsLeader || s.pointsFor > pointsLeader.pointsFor) {
        pointsLeader = { ...holderFrom(id), pointsFor: s.pointsFor };
      }
    }

    // Best record: winPct → PF (already the standings leader ordering).
    const bestRow = topByStandings(standings);
    let bestRecord: SeasonHistory['bestRecord'] = null;
    if (bestRow) {
      const id = identities.get(bestRow.ownerSeasonId);
      if (id) {
        bestRecord = {
          ...holderFrom(id),
          wins: bestRow.wins,
          losses: bestRow.losses,
          ties: bestRow.ties,
          winPct: bestRow.winPct,
        };
      }
    }

    out.push({
      seasonId: season.id,
      year: season.year,
      seasonName: season.name,
      status: season.status,
      weeksPlayed: weeks,
      ownerCount: identities.size,
      topFinisher,
      highestWeek,
      pointsLeader,
      bestRecord,
    });
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* All-time rivalries (cross-season head-to-head, by person)                   */
/* -------------------------------------------------------------------------- */

/** One owner's public identity for all-time analytics (most recent team used). */
export interface OwnerIdentity {
  ownerId: number;
  ownerName: string;
  /** Most-recent team key the owner held, for a representative crest. */
  teamKey: string | null;
  teamName: string | null;
  logoEspn: string | null;
}

/** One individual meeting between two people (a single matchup), in canonical A/B order. */
export interface RivalryGame {
  seasonId: number;
  year: number;
  week: number;
  aPoints: number;
  bPoints: number;
}

/**
 * All-time head-to-head between two PEOPLE. `a`/`b` are ordered so `ownerA.ownerId
 * < ownerB.ownerId` for a stable key. `aWins`/`bWins`/`ties` and `aPoints`/`bPoints`
 * accumulate across every season the two have met. `games` is the chronological
 * per-meeting breakdown those aggregates are built from.
 */
export interface Rivalry {
  ownerA: OwnerIdentity;
  ownerB: OwnerIdentity;
  aWins: number;
  bWins: number;
  ties: number;
  meetings: number;
  aPoints: number;
  bPoints: number;
  games: RivalryGame[];
}

export interface AllTimeRivalries {
  /** All owner pairs that have met, unordered. */
  rivalries: Rivalry[];
  /** All known owner identities (by id), for lookups. */
  ownersById: Map<number, OwnerIdentity>;
  /** Most-played rivalries (descending meetings). */
  mostPlayed: (limit?: number) => Rivalry[];
  /**
   * Most lopsided rivalries: largest win-share gap among pairs with at least
   * `minMeetings` games (descending dominance, then meetings).
   */
  mostLopsided: (limit?: number, minMeetings?: number) => Rivalry[];
  /** A single person's aggregated all-time H2H record across all opponents. */
  ownerRecord: (ownerId: number) => { wins: number; losses: number; ties: number; meetings: number };
}

const pairKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);

/**
 * Compute owner-vs-owner all-time records across ALL seasons in one pass over
 * matchups + scores. Aggregated by PERSON (owners.id) so the same owner across
 * seasons rolls up. Byes/unscored games (a side with null/bye points) are skipped.
 */
export async function getAllTimeRivalries(): Promise<AllTimeRivalries> {
  // 1. ownerSeasonId → ownerId, and per-owner most-recent team identity.
  const osRows = await db
    .select({
      ownerSeasonId: ownerSeasons.id,
      ownerId: owners.id,
      ownerName: owners.name,
      seasonYear: seasons.year,
      teamKey: nflTeams.key,
      teamName: nflTeams.name,
      logoEspn: nflTeams.logoEspn,
    })
    .from(ownerSeasons)
    .innerJoin(owners, eq(ownerSeasons.ownerId, owners.id))
    .innerJoin(seasons, eq(ownerSeasons.seasonId, seasons.id))
    .innerJoin(nflTeams, eq(ownerSeasons.nflTeamId, nflTeams.id));

  const ownerIdByOwnerSeason = new Map<number, number>();
  const ownersById = new Map<number, OwnerIdentity>();
  /** Track the most-recent season year per owner so identity uses latest team. */
  const latestYearByOwner = new Map<number, number>();
  for (const r of osRows) {
    ownerIdByOwnerSeason.set(r.ownerSeasonId, r.ownerId);
    const seen = latestYearByOwner.get(r.ownerId);
    if (seen === undefined || r.seasonYear > seen) {
      latestYearByOwner.set(r.ownerId, r.seasonYear);
      ownersById.set(r.ownerId, {
        ownerId: r.ownerId,
        ownerName: r.ownerName,
        teamKey: r.teamKey,
        teamName: r.teamName,
        logoEspn: r.logoEspn ?? null,
      });
    } else if (!ownersById.has(r.ownerId)) {
      ownersById.set(r.ownerId, {
        ownerId: r.ownerId,
        ownerName: r.ownerName,
        teamKey: r.teamKey,
        teamName: r.teamName,
        logoEspn: r.logoEspn ?? null,
      });
    }
  }

  // 2. Scores → (seasonId, ownerSeasonId, week) → points (null when bye/unscored).
  const scoreRows = await db
    .select({
      seasonId: scores.seasonId,
      ownerSeasonId: scores.ownerSeasonId,
      week: scores.week,
      dkPoints: scores.dkPoints,
      isBye: scores.isBye,
    })
    .from(scores);
  const pointsByKey = new Map<string, number | null>();
  for (const s of scoreRows) {
    const pts = s.isBye || s.dkPoints === null ? null : Number(s.dkPoints);
    pointsByKey.set(`${s.seasonId}:${s.ownerSeasonId}:${s.week}`, pts);
  }

  // 3. Matchups (regular season only) → accumulate per owner-pair, by person.
  const seasonRows = await db.select({ id: seasons.id, year: seasons.year }).from(seasons);
  const yearBySeasonId = new Map(seasonRows.map((s) => [s.id, s.year]));

  const matchupRows = await db
    .select({
      seasonId: matchups.seasonId,
      week: matchups.week,
      homeOwnerSeasonId: matchups.homeOwnerSeasonId,
      awayOwnerSeasonId: matchups.awayOwnerSeasonId,
      isPlayoff: matchups.isPlayoff,
    })
    .from(matchups);

  const rivalryByPair = new Map<string, Rivalry>();
  for (const m of matchupRows) {
    if (m.isPlayoff) continue;
    const homeOwnerId = ownerIdByOwnerSeason.get(m.homeOwnerSeasonId);
    const awayOwnerId = ownerIdByOwnerSeason.get(m.awayOwnerSeasonId);
    if (homeOwnerId === undefined || awayOwnerId === undefined) continue;
    if (homeOwnerId === awayOwnerId) continue; // safety

    const homePts = pointsByKey.get(`${m.seasonId}:${m.homeOwnerSeasonId}:${m.week}`) ?? null;
    const awayPts = pointsByKey.get(`${m.seasonId}:${m.awayOwnerSeasonId}:${m.week}`) ?? null;
    if (homePts === null || awayPts === null) continue; // not a finalized game

    const key = pairKey(homeOwnerId, awayOwnerId);
    let rv = rivalryByPair.get(key);
    if (!rv) {
      const [aId, bId] = homeOwnerId < awayOwnerId ? [homeOwnerId, awayOwnerId] : [awayOwnerId, homeOwnerId];
      rv = {
        ownerA: ownersById.get(aId)!,
        ownerB: ownersById.get(bId)!,
        aWins: 0,
        bWins: 0,
        ties: 0,
        meetings: 0,
        aPoints: 0,
        bPoints: 0,
        games: [],
      };
      rivalryByPair.set(key, rv);
    }

    rv.meetings += 1;
    // Map home/away points onto the canonical A/B ordering.
    const homeIsA = homeOwnerId === rv.ownerA.ownerId;
    const aPts = homeIsA ? homePts : awayPts;
    const bPts = homeIsA ? awayPts : homePts;
    rv.aPoints += aPts;
    rv.bPoints += bPts;
    rv.games.push({
      seasonId: m.seasonId,
      year: yearBySeasonId.get(m.seasonId) ?? 0,
      week: m.week,
      aPoints: aPts,
      bPoints: bPts,
    });
    if (aPts > bPts) rv.aWins += 1;
    else if (bPts > aPts) rv.bWins += 1;
    else rv.ties += 1;
  }

  const rivalries = [...rivalryByPair.values()];
  for (const rv of rivalries) {
    rv.games.sort((a, b) => a.year - b.year || a.week - b.week);
  }

  const mostPlayed = (limit = 10): Rivalry[] =>
    [...rivalries].sort((a, b) => b.meetings - a.meetings).slice(0, limit);

  const dominance = (r: Rivalry): number => {
    const decisive = r.aWins + r.bWins;
    if (decisive === 0) return 0;
    return Math.abs(r.aWins - r.bWins) / decisive;
  };
  const mostLopsided = (limit = 10, minMeetings = 3): Rivalry[] =>
    [...rivalries]
      .filter((r) => r.meetings >= minMeetings && r.aWins + r.bWins > 0)
      .sort((a, b) => {
        const d = dominance(b) - dominance(a);
        if (d !== 0) return d;
        return b.meetings - a.meetings;
      })
      .slice(0, limit);

  const ownerRecord = (
    ownerId: number,
  ): { wins: number; losses: number; ties: number; meetings: number } => {
    let wins = 0;
    let losses = 0;
    let ties = 0;
    let meetings = 0;
    for (const r of rivalries) {
      if (r.ownerA.ownerId === ownerId) {
        wins += r.aWins;
        losses += r.bWins;
        ties += r.ties;
        meetings += r.meetings;
      } else if (r.ownerB.ownerId === ownerId) {
        wins += r.bWins;
        losses += r.aWins;
        ties += r.ties;
        meetings += r.meetings;
      }
    }
    return { wins, losses, ties, meetings };
  };

  return { rivalries, ownersById, mostPlayed, mostLopsided, ownerRecord };
}

/* -------------------------------------------------------------------------- */
/* All-time leaders (per-owner aggregates across seasons)                      */
/* -------------------------------------------------------------------------- */

/** One owner's all-time aggregate across every season they've played. */
export interface AllTimeLeader {
  ownerId: number;
  ownerName: string;
  teamKey: string | null;
  teamName: string | null;
  logoEspn: string | null;
  /** Total regular-season H2H wins across all seasons. */
  totalWins: number;
  totalLosses: number;
  totalTies: number;
  /** Total regular-season Points For across all seasons. */
  totalPoints: number;
  /** Seasons the owner has participated in. */
  seasonsPlayed: number;
  /** Champion awards earned (from seasonAwards; 0 when none recorded). */
  championships: number;
  /** Best single-week score and the week it happened. */
  bestWeek: { week: number; points: number; year: number } | null;
}

export interface AllTimeLeaders {
  leaders: AllTimeLeader[];
  /** Sorted by total wins (desc), tiebreak by win pct then points. */
  byWins: (limit?: number) => AllTimeLeader[];
  /** Sorted by total points (desc). */
  byPoints: (limit?: number) => AllTimeLeader[];
  /** Sorted by best single-week score (desc). */
  byBestWeek: (limit?: number) => AllTimeLeader[];
}

/**
 * All-time per-owner aggregates across every season with data. Wins/losses/ties
 * come from the standings engine per season (so forfeit rules apply consistently),
 * summed by person. Points and best-week come from a single scores pass.
 */
export async function getAllTimeLeaders(): Promise<AllTimeLeaders> {
  const options = await getSeasonOptions();

  const ownerSeasonRows = await db
    .select({ seasonId: ownerSeasons.seasonId })
    .from(ownerSeasons);
  const seasonsWithData = [...new Set(ownerSeasonRows.map((r) => r.seasonId))];

  // Champion awards per owner.
  const championRows = await db
    .select({ ownerId: seasonAwards.ownerId })
    .from(seasonAwards)
    .where(eq(seasonAwards.type, 'champion'));
  const championCountByOwner = new Map<number, number>();
  for (const r of championRows) {
    if (r.ownerId === null) continue;
    championCountByOwner.set(r.ownerId, (championCountByOwner.get(r.ownerId) ?? 0) + 1);
  }

  const byOwner = new Map<number, AllTimeLeader>();
  const yearBySeason = new Map(options.map((s) => [s.id, s.year]));
  /** Track latest year seen per owner so identity uses their most recent team. */
  const latestYearByOwner = new Map<number, number>();

  for (const seasonId of seasonsWithData) {
    const identities = await loadOwnerIdentities(seasonId);
    const standings = await getSeasonStandings(seasonId);
    const seasonYear = yearBySeason.get(seasonId) ?? 0;

    for (const s of standings) {
      const id = identities.get(s.ownerSeasonId);
      if (!id) continue;
      let agg = byOwner.get(id.ownerId);
      if (!agg) {
        agg = {
          ownerId: id.ownerId,
          ownerName: id.ownerName,
          teamKey: id.teamKey,
          teamName: id.teamName,
          logoEspn: id.logoEspn,
          totalWins: 0,
          totalLosses: 0,
          totalTies: 0,
          totalPoints: 0,
          seasonsPlayed: 0,
          championships: championCountByOwner.get(id.ownerId) ?? 0,
          bestWeek: null,
        };
        byOwner.set(id.ownerId, agg);
      }
      // Refresh display identity to the latest season's team.
      const seen = latestYearByOwner.get(id.ownerId);
      if (seen === undefined || seasonYear >= seen) {
        latestYearByOwner.set(id.ownerId, seasonYear);
        agg.teamKey = id.teamKey;
        agg.teamName = id.teamName;
        agg.logoEspn = id.logoEspn;
        agg.ownerName = id.ownerName;
      }
      agg.totalWins += s.wins;
      agg.totalLosses += s.losses;
      agg.totalTies += s.ties;
      agg.totalPoints += s.pointsFor;
      agg.seasonsPlayed += 1;
    }
  }

  // Best single-week score per owner, in one scores pass across all data seasons.
  if (seasonsWithData.length > 0) {
    const scoreRows = await db
      .select({
        seasonId: scores.seasonId,
        ownerSeasonId: scores.ownerSeasonId,
        week: scores.week,
        dkPoints: scores.dkPoints,
        isBye: scores.isBye,
        ownerId: owners.id,
      })
      .from(scores)
      .innerJoin(ownerSeasons, eq(scores.ownerSeasonId, ownerSeasons.id))
      .innerJoin(owners, eq(ownerSeasons.ownerId, owners.id))
      .where(inArray(scores.seasonId, seasonsWithData));
    for (const s of scoreRows) {
      if (s.isBye || s.dkPoints === null) continue;
      const agg = byOwner.get(s.ownerId);
      if (!agg) continue;
      const pts = Number(s.dkPoints);
      if (!agg.bestWeek || pts > agg.bestWeek.points) {
        agg.bestWeek = { week: s.week, points: pts, year: yearBySeason.get(s.seasonId) ?? 0 };
      }
    }
  }

  const leaders = [...byOwner.values()];

  const winPctOf = (l: AllTimeLeader): number => {
    const g = l.totalWins + l.totalLosses + l.totalTies;
    return g === 0 ? 0 : (l.totalWins + l.totalTies * 0.5) / g;
  };

  const byWins = (limit = 10): AllTimeLeader[] =>
    [...leaders]
      .sort((a, b) => {
        if (b.totalWins !== a.totalWins) return b.totalWins - a.totalWins;
        if (winPctOf(b) !== winPctOf(a)) return winPctOf(b) - winPctOf(a);
        return b.totalPoints - a.totalPoints;
      })
      .slice(0, limit);

  const byPoints = (limit = 10): AllTimeLeader[] =>
    [...leaders].sort((a, b) => b.totalPoints - a.totalPoints).slice(0, limit);

  const byBestWeek = (limit = 10): AllTimeLeader[] =>
    [...leaders]
      .filter((l) => l.bestWeek !== null)
      .sort((a, b) => (b.bestWeek?.points ?? 0) - (a.bestWeek?.points ?? 0))
      .slice(0, limit);

  return { leaders, byWins, byPoints, byBestWeek };
}
