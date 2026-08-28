/**
 * History & all-time analytics (server-only).
 *
 * Powers the public `/history` page: per-season "champions & records" summaries
 * plus all-time, cross-season analytics aggregated by PERSON (owners.id), not by
 * per-season `ownerSeason`. The same person owning different NFL teams across
 * seasons rolls up to a single owner identity here.
 *
 * Standings ordering reuses the pure engine via `getRankedSeasonStandings`, which
 * applies the season's FULL configured tiebreaker chain (win% cohorts →
 * head-to-head dominance → Points For), so the "top finisher" matches the seeding
 * and the rest of the app. Do not re-sort with a local winPct → PF → PA
 * comparator: that silently drops the head-to-head step, which is exactly how this
 * page used to crown one owner while the bracket beside it seeded another.
 * The season top finisher is labelled "Regular-season #1"; if `seasonAwards`
 * carries a `champion` row for a season we surface that owner as the Champion
 * instead (the table may be empty — tolerated).
 *
 * Numeric `numeric(7,2)` columns come back from the driver as strings; we convert
 * with `Number` exactly once, here.
 *
 * !! EXHIBITION FILTER — REQUIRED ON EVERY NEW QUERY !!
 * Preseason exhibition games live in `scores`/`matchups` alongside real ones (see
 * `src/lib/schedule/preseason.ts`) and must never reach an all-time record. There is
 * no schema-level guard, so EVERY read of `scores` or `matchups` in this module adds
 * `eq(scores.isExhibition, false)` / `eq(matchups.isExhibition, false)`. If you add a
 * leaderboard here and forget it, preseason blowouts silently become league records.
 * To audit: list every `scores`/`matchups` select in this file and check each one's
 * `where` carries the flag.
 *
 * This module imports `@/db` and must only be used from server-side code.
 */
import { and, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';

import {
  db,
  matchups,
  nflTeams,
  owners,
  ownerSeasons,
  playoffMatchups,
  scores,
  seasonAwards,
  seasons,
} from '@/db';

import {
  // Request-scoped variants: /history fans out over the same seasons from ~11 aggregates,
  // and on the Neon HTTP driver each repeat is another network round-trip. Safe here
  // because this module is only ever imported by server components, never by scripts.
  getRankedSeasonStandingsCached as getRankedSeasonStandings,
  getSeasonOptionsCached as getSeasonOptions,
  getSeasonStandingsDataCached as getSeasonStandingsData,
  getSeasonStandingsCached as getSeasonStandings,
  type SeasonStandingRow,
} from '@/lib/standings/query';
import { getSeasonRules } from '@/lib/rules/schema';

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
  /** Team's primary brand color (hex), e.g. for chart line coloring. */
  color: string | null;
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
      color: nflTeams.primaryColor,
    })
    .from(ownerSeasons)
    .innerJoin(owners, eq(ownerSeasons.ownerId, owners.id))
    .innerJoin(nflTeams, eq(ownerSeasons.nflTeamId, nflTeams.id))
    .where(eq(ownerSeasons.seasonId, seasonId));
  return new Map(
    rows.map((r) => [r.ownerSeasonId, { ...r, logoEspn: r.logoEspn ?? null, color: r.color ?? null }]),
  );
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

/**
 * The season leader.
 *
 * `rows` MUST already be ordered by {@link getRankedSeasonStandings}, i.e. by the league's
 * real chain (win% → head-to-head dominance → Points For). This used to re-sort with a local
 * winPct → PF → PA comparator, which silently skips the head-to-head step — so the season
 * card could name one owner "Regular-season #1" while the playoff bracket on the same page,
 * which does use the real chain, seeded someone else first.
 */
function topByStandings(rows: SeasonStandingRow[]): SeasonStandingRow | null {
  return rows[0] ?? null;
}

/**
 * For EVERY season that has data (owners assigned), the final regular-season
 * summary + notable records, newest year first.
 */
export async function getSeasonHistory(): Promise<SeasonHistory[]> {
  const [options, ownerSeasonRows, championRows, seasonRulesRows] = await Promise.all([
    getSeasonOptions(),
    db.select({ seasonId: ownerSeasons.seasonId }).from(ownerSeasons),
    db
      .select({ seasonId: seasonAwards.seasonId, ownerId: seasonAwards.ownerId })
      .from(seasonAwards)
      .where(eq(seasonAwards.type, 'champion')),
    db
      .select({ id: seasons.id, rules: seasons.rules, regularSeasonWeeks: seasons.regularSeasonWeeks, entryFeeCents: seasons.entryFeeCents })
      .from(seasons),
  ]);

  const seasonsWithData = new Set(ownerSeasonRows.map((r) => r.seasonId));

  const championBySeason = new Map<number, number>();
  for (const r of championRows) {
    if (r.ownerId !== null && !championBySeason.has(r.seasonId)) {
      championBySeason.set(r.seasonId, r.ownerId);
    }
  }

  const regularWeeksBySeason = new Map(
    // The canonical column — `rules.regularSeasonWeeks` is a mirror the Settings page
    // deliberately leaves untouched, so the two drift.
    seasonRulesRows.map((r) => [r.id, r.regularSeasonWeeks ?? getSeasonRules(r.rules).regularSeasonWeeks]),
  );

  const validSeasons = options.filter((s) => seasonsWithData.has(s.id));

  const out = await Promise.all(
    validSeasons.map(async (season) => {
      const regularSeasonWeeks = regularWeeksBySeason.get(season.id) ?? 18;

      const [identities, ranked, scoreRows] = await Promise.all([
        loadOwnerIdentities(season.id),
        getRankedSeasonStandings(season.id),
        db
          .select({
            ownerSeasonId: scores.ownerSeasonId,
            week: scores.week,
            dkPoints: scores.dkPoints,
            isBye: scores.isBye,
          })
          .from(scores)
          .where(and(
            eq(scores.seasonId, season.id),
            lte(scores.week, regularSeasonWeeks),
            eq(scores.isExhibition, false),
          )),
      ]);

      const standings = ranked.rows;
      const standingByOwnerSeason = new Map(standings.map((s) => [s.ownerSeasonId, s]));
      // Distinct finalized weeks, not max(gamesPlayed) — the latter is one short for any
      // season past the byes, since every owner sits out exactly one week.
      const weeks = ranked.weeksPlayed;

      const championOwnerId = championBySeason.get(season.id);
      let topFinisher: SeasonHistory['topFinisher'] = null;
      if (championOwnerId !== undefined) {
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

      // Regular-season only (week <= regularSeasonWeeks).
      let highestWeek: SeasonHistory['highestWeek'] = null;
      for (const s of scoreRows) {
        if (s.isBye || s.dkPoints === null) continue;
        const pts = Number(s.dkPoints);
        const id = identities.get(s.ownerSeasonId);
        if (!id) continue;
        if (!highestWeek || pts > highestWeek.points) {
          highestWeek = { ...holderFrom(id), week: s.week, points: pts };
        }
      }

      let pointsLeader: SeasonHistory['pointsLeader'] = null;
      for (const s of standings) {
        const id = identities.get(s.ownerSeasonId);
        if (!id) continue;
        if (!pointsLeader || s.pointsFor > pointsLeader.pointsFor) {
          pointsLeader = { ...holderFrom(id), pointsFor: s.pointsFor };
        }
      }

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

      // Before a season has played a week, every owner is 0-0 with 0 points, so
      // "top finisher", "points leader", and "best record" would just be whoever
      // sorts first by id — a misleading crown. Withhold them until games exist.
      if (weeks === 0) {
        topFinisher = null;
        pointsLeader = null;
        bestRecord = null;
      }

      return {
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
      };
    }),
  );

  return out;
}

/**
 * Single-season summary for the per-season detail page. Same data as one
 * entry from `getSeasonHistory` but only runs queries for the one season,
 * avoiding N round-trips over every season in the DB.
 */
export async function getSeasonHistoryById(seasonId: number): Promise<SeasonHistory | null> {
  const options = await getSeasonOptions();
  const season = options.find((s) => s.id === seasonId);
  if (!season) return null;

  const identities = await loadOwnerIdentities(seasonId);
  if (identities.size === 0) return null;

  const [ranked, championRow, seasonRulesRow] = await Promise.all([
    getRankedSeasonStandings(seasonId),
    db
      .select({ ownerId: seasonAwards.ownerId })
      .from(seasonAwards)
      .where(and(eq(seasonAwards.seasonId, seasonId), eq(seasonAwards.type, 'champion')))
      .limit(1),
    db
      .select({ rules: seasons.rules, regularSeasonWeeks: seasons.regularSeasonWeeks })
      .from(seasons)
      .where(eq(seasons.id, seasonId))
      .limit(1),
  ]);

  const regularSeasonWeeks =
    seasonRulesRow[0]?.regularSeasonWeeks ?? getSeasonRules(seasonRulesRow[0]?.rules).regularSeasonWeeks;
  const standings = ranked.rows;
  const standingByOwnerSeason = new Map(standings.map((s) => [s.ownerSeasonId, s]));
  const weeks = ranked.weeksPlayed;
  const championOwnerId = championRow[0]?.ownerId ?? undefined;

  let topFinisher: SeasonHistory['topFinisher'] = null;
  if (championOwnerId !== undefined) {
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

  // Regular-season only (week <= regularSeasonWeeks).
  const scoreRows = await db
    .select({
      ownerSeasonId: scores.ownerSeasonId,
      week: scores.week,
      dkPoints: scores.dkPoints,
      isBye: scores.isBye,
    })
    .from(scores)
    .where(and(
      eq(scores.seasonId, seasonId),
      lte(scores.week, regularSeasonWeeks),
      eq(scores.isExhibition, false),
    ));

  let highestWeek: SeasonHistory['highestWeek'] = null;
  for (const s of scoreRows) {
    if (s.isBye || s.dkPoints === null) continue;
    const pts = Number(s.dkPoints);
    const id = identities.get(s.ownerSeasonId);
    if (!id) continue;
    if (!highestWeek || pts > highestWeek.points) {
      highestWeek = { ...holderFrom(id), week: s.week, points: pts };
    }
  }

  let pointsLeader: SeasonHistory['pointsLeader'] = null;
  for (const s of standings) {
    const id = identities.get(s.ownerSeasonId);
    if (!id) continue;
    if (!pointsLeader || s.pointsFor > pointsLeader.pointsFor) {
      pointsLeader = { ...holderFrom(id), pointsFor: s.pointsFor };
    }
  }

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

  // See getSeasonHistory: withhold 0-0 "leaders" until a week has been played.
  if (weeks === 0) {
    topFinisher = null;
    pointsLeader = null;
    bestRecord = null;
  }

  return {
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
  };
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
  /** Most-played rivalries (descending meetings), full sorted list. */
  mostPlayed: () => Rivalry[];
  /**
   * Most lopsided rivalries: largest win-share gap among pairs with at least
   * `minMeetings` games (descending dominance, then meetings), full sorted list.
   */
  mostLopsided: (minMeetings?: number) => Rivalry[];
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
      ownerName: sql<string>`coalesce(${ownerSeasons.displayName}, ${owners.name})`,
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
    .from(scores)
    .where(eq(scores.isExhibition, false));
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
    .from(matchups)
    .where(eq(matchups.isExhibition, false));

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

  const mostPlayed = (): Rivalry[] =>
    [...rivalries].sort((a, b) => b.meetings - a.meetings);

  const dominance = (r: Rivalry): number => {
    const decisive = r.aWins + r.bWins;
    if (decisive === 0) return 0;
    return Math.abs(r.aWins - r.bWins) / decisive;
  };
  const mostLopsided = (minMeetings = 3): Rivalry[] =>
    [...rivalries]
      .filter((r) => r.meetings >= minMeetings && r.aWins + r.bWins > 0)
      .sort((a, b) => {
        const d = dominance(b) - dominance(a);
        if (d !== 0) return d;
        return b.meetings - a.meetings;
      });

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
  /** Sorted by total wins (desc) only — ties are intentionally preserved. */
  byWins: () => AllTimeLeader[];
  /** Sorted by total points (desc). */
  byPoints: () => AllTimeLeader[];
  /** Sorted by best single-week score (desc). */
  byBestWeek: () => AllTimeLeader[];
  /** Sorted by championship count (desc), tiebreak by win pct. */
  byChampionships: (limit?: number) => AllTimeLeader[];
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

  const seasonDataAll = await Promise.all(
    seasonsWithData.map(async (seasonId) => {
      const [identities, standings] = await Promise.all([
        loadOwnerIdentities(seasonId),
        getSeasonStandings(seasonId),
      ]);
      return { seasonId, identities, standings };
    }),
  );

  for (const { seasonId, identities, standings } of seasonDataAll) {
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
  //
  // Week-capped per season: playoff scores live in this same table at weeks 19-22 and are
  // written non-bye by the playoff importers, so without the cap a championship-week score
  // could be reported as an owner's best REGULAR-season week — under a heading that says
  // "regular season", and contradicting the season card on the same page. The sibling
  // getWeeklyHighScores already caps; this one was missed.
  const seasonWeekRows = await db
    .select({ id: seasons.id, rules: seasons.rules, regularSeasonWeeks: seasons.regularSeasonWeeks })
    .from(seasons);
  const regularWeeksBySeasonId = new Map(
    seasonWeekRows.map((r) => [r.id, r.regularSeasonWeeks ?? getSeasonRules(r.rules).regularSeasonWeeks]),
  );
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
      .where(and(inArray(scores.seasonId, seasonsWithData), eq(scores.isExhibition, false)));
    for (const s of scoreRows) {
      if (s.isBye || s.dkPoints === null) continue;
      if (s.week > (regularWeeksBySeasonId.get(s.seasonId) ?? 18)) continue;
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

  const byWins = (): AllTimeLeader[] =>
    [...leaders].sort((a, b) => b.totalWins - a.totalWins);

  const byPoints = (): AllTimeLeader[] =>
    [...leaders].sort((a, b) => b.totalPoints - a.totalPoints);

  const byBestWeek = (): AllTimeLeader[] =>
    [...leaders]
      .filter((l) => l.bestWeek !== null)
      .sort((a, b) => (b.bestWeek?.points ?? 0) - (a.bestWeek?.points ?? 0));

  const byChampionships = (limit = 10): AllTimeLeader[] =>
    [...leaders]
      .filter((l) => l.championships > 0)
      .sort((a, b) => b.championships - a.championships || winPctOf(b) - winPctOf(a))
      .slice(0, limit);

  return { leaders, byWins, byPoints, byBestWeek, byChampionships };
}

/* -------------------------------------------------------------------------- */
/* Owner trends over time (cross-season, by person)                            */
/* -------------------------------------------------------------------------- */

/** One owner's per-season win count + average Points For, for the trend charts. */
export interface OwnerSeasonTrendOwner {
  ownerId: number;
  ownerName: string;
  teamKey: string | null;
  teamName: string | null;
  logoEspn: string | null;
  /** Most-recent team's primary brand color (hex), used to color the owner's line. */
  color: string | null;
  /**
   * Regular-season win count per year, aligned index-for-index with
   * {@link OwnerSeasonTrends.years}. `null` = the owner didn't play that season.
   */
  wins: (number | null)[];
  /** Average regular-season Points For per game played, same alignment as `wins`. */
  avgPointsFor: (number | null)[];
}

export interface OwnerSeasonTrends {
  /** Season years with data, ascending (oldest first — natural left-to-right reading). */
  years: number[];
  owners: OwnerSeasonTrendOwner[];
}

/**
 * Every owner's win count + average Points For for every season with data, aggregated
 * by PERSON (owners.id) so a co-owned/renamed team across years still rolls up to one
 * line. Powers the "Owner trends" overlaid line charts on `/history`.
 */
export async function getOwnerSeasonTrends(): Promise<OwnerSeasonTrends> {
  const options = await getSeasonOptions(); // newest year first

  const ownerSeasonRows = await db
    .select({ seasonId: ownerSeasons.seasonId })
    .from(ownerSeasons);
  const seasonsWithData = new Set(ownerSeasonRows.map((r) => r.seasonId));

  // Only completed seasons feed the trend charts. An in-progress season has
  // partial win totals (everyone at 2-3 wins mid-season), which would drag every
  // line down to a fake trough at the right edge and skew the whole read — the
  // wins chart especially, since wins is an absolute count, not a per-game rate.
  // The season re-appears with its full totals once it's marked completed.
  // Chronological (oldest first) so the chart reads left-to-right naturally.
  const dataSeasons = options
    .filter((s) => seasonsWithData.has(s.id) && s.status === 'completed')
    .sort((a, b) => a.year - b.year);
  const years = dataSeasons.map((s) => s.year);

  const byOwner = new Map<number, OwnerSeasonTrendOwner>();
  /** Track the latest year seen per owner so identity (team/color) uses their most recent team. */
  const latestYearByOwner = new Map<number, number>();

  const seasonDataAll = await Promise.all(
    dataSeasons.map(async (season, i) => {
      const [identities, standings] = await Promise.all([
        loadOwnerIdentities(season.id),
        getSeasonStandings(season.id),
      ]);
      return { i, season, identities, standings };
    }),
  );

  for (const { i, season, identities, standings } of seasonDataAll) {
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
          color: id.color,
          wins: new Array(years.length).fill(null),
          avgPointsFor: new Array(years.length).fill(null),
        };
        byOwner.set(id.ownerId, agg);
      }
      const seen = latestYearByOwner.get(id.ownerId);
      if (seen === undefined || season.year >= seen) {
        latestYearByOwner.set(id.ownerId, season.year);
        agg.ownerName = id.ownerName;
        agg.teamKey = id.teamKey;
        agg.teamName = id.teamName;
        agg.logoEspn = id.logoEspn;
        agg.color = id.color;
      }
      agg.wins[i] = s.wins;
      agg.avgPointsFor[i] = s.gamesPlayed > 0 ? s.pointsFor / s.gamesPlayed : null;
    }
  }

  return { years, owners: [...byOwner.values()] };
}

/* -------------------------------------------------------------------------- */
/* Championship roll (per-championship-season name, not all-time latest name) */
/* -------------------------------------------------------------------------- */

export interface ChampionLeader {
  ownerId: number;
  /** Name as it appeared in the season(s) they won — not the current all-time name. */
  ownerName: string;
  logoEspn: string | null;
  teamKey: string | null;
  teamName: string | null;
  championships: number;
  /** Calendar years of each title, for tooltip / display. */
  years: number[];
}

/**
 * Championship roll: one entry per owner who has won a title. Uses the name
 * from the season they actually won so co-owner names don't bleed in from
 * seasons they weren't part of. If an owner won under different names (solo
 * one year, co-owned another), the most recent winning season's name is shown.
 */
export async function getChampionLeaders(): Promise<ChampionLeader[]> {
  const rows = await db
    .select({
      ownerId: owners.id,
      ownerName: sql<string>`coalesce(${ownerSeasons.displayName}, ${owners.name})`,
      logoEspn: nflTeams.logoEspn,
      teamKey: nflTeams.key,
      teamName: nflTeams.name,
      year: seasons.year,
    })
    .from(seasonAwards)
    .innerJoin(owners, eq(seasonAwards.ownerId, owners.id))
    .innerJoin(ownerSeasons, and(
      eq(ownerSeasons.ownerId, owners.id),
      eq(ownerSeasons.seasonId, seasonAwards.seasonId),
    ))
    .innerJoin(nflTeams, eq(ownerSeasons.nflTeamId, nflTeams.id))
    .innerJoin(seasons, eq(seasonAwards.seasonId, seasons.id))
    .where(eq(seasonAwards.type, 'champion'))
    .orderBy(seasons.year);

  const byOwner = new Map<number, ChampionLeader>();
  for (const r of rows) {
    let entry = byOwner.get(r.ownerId);
    if (!entry) {
      entry = { ownerId: r.ownerId, ownerName: r.ownerName, logoEspn: r.logoEspn ?? null,
        teamKey: r.teamKey, teamName: r.teamName, championships: 0, years: [] };
      byOwner.set(r.ownerId, entry);
    }
    entry.championships += 1;
    entry.years.push(r.year);
    // Use the most recent winning season's name.
    entry.ownerName = r.ownerName;
    entry.logoEspn = r.logoEspn ?? null;
    entry.teamKey = r.teamKey;
    entry.teamName = r.teamName;
  }

  return [...byOwner.values()].sort((a, b) => b.championships - a.championships);
}

/* -------------------------------------------------------------------------- */
/* Playoff appearances & record (per person, cross-season)                     */
/* -------------------------------------------------------------------------- */

export interface PlayoffStat {
  ownerId: number;
  ownerName: string;
  teamKey: string | null;
  teamName: string | null;
  logoEspn: string | null;
  /** Distinct seasons where the owner appeared in at least one playoff game. */
  appearances: number;
  playoffWins: number;
  playoffLosses: number;
}

export async function getPlayoffStats(): Promise<PlayoffStat[]> {
  const seasonOptions = await getSeasonOptions();
  const yearById = new Map(seasonOptions.map((s) => [s.id, s.year]));

  const [pmRows, osRows] = await Promise.all([
    db
      .select({
        seasonId: playoffMatchups.seasonId,
        highOwnerSeasonId: playoffMatchups.highOwnerSeasonId,
        lowOwnerSeasonId: playoffMatchups.lowOwnerSeasonId,
        winnerOwnerSeasonId: playoffMatchups.winnerOwnerSeasonId,
      })
      .from(playoffMatchups),
    db
      .select({
        ownerSeasonId: ownerSeasons.id,
        seasonId: ownerSeasons.seasonId,
        ownerId: owners.id,
        ownerName: sql<string>`coalesce(${ownerSeasons.displayName}, ${owners.name})`,
        teamKey: nflTeams.key,
        teamName: nflTeams.name,
        logoEspn: nflTeams.logoEspn,
      })
      .from(ownerSeasons)
      .innerJoin(owners, eq(ownerSeasons.ownerId, owners.id))
      .innerJoin(nflTeams, eq(ownerSeasons.nflTeamId, nflTeams.id)),
  ]);

  type Identity = { ownerId: number; ownerName: string; teamKey: string | null; teamName: string | null; logoEspn: string | null; seasonId: number };
  const identityByOwnerSeason = new Map<number, Identity>();
  for (const r of osRows) {
    identityByOwnerSeason.set(r.ownerSeasonId, {
      ownerId: r.ownerId, ownerName: r.ownerName, teamKey: r.teamKey,
      teamName: r.teamName, logoEspn: r.logoEspn ?? null, seasonId: r.seasonId,
    });
  }

  const appearanceSeasons = new Map<number, Set<number>>();
  type Agg = PlayoffStat & { latestYear: number };
  const byOwner = new Map<number, Agg>();

  for (const pm of pmRows) {
    for (const osId of [pm.highOwnerSeasonId, pm.lowOwnerSeasonId]) {
      if (osId === null) continue;
      const identity = identityByOwnerSeason.get(osId);
      if (!identity) continue;
      const year = yearById.get(identity.seasonId) ?? 0;

      let agg = byOwner.get(identity.ownerId);
      if (!agg) {
        agg = { ownerId: identity.ownerId, ownerName: identity.ownerName, teamKey: identity.teamKey,
          teamName: identity.teamName, logoEspn: identity.logoEspn, appearances: 0,
          playoffWins: 0, playoffLosses: 0, latestYear: 0 };
        byOwner.set(identity.ownerId, agg);
      }
      if (year > agg.latestYear) {
        agg.latestYear = year;
        agg.ownerName = identity.ownerName; agg.teamKey = identity.teamKey;
        agg.teamName = identity.teamName; agg.logoEspn = identity.logoEspn;
      }

      let seasons = appearanceSeasons.get(identity.ownerId);
      if (!seasons) { seasons = new Set(); appearanceSeasons.set(identity.ownerId, seasons); }
      seasons.add(identity.seasonId);
      agg.appearances = seasons.size;

      if (pm.winnerOwnerSeasonId !== null) {
        if (pm.winnerOwnerSeasonId === osId) agg.playoffWins += 1;
        else agg.playoffLosses += 1;
      }
    }
  }

  return [...byOwner.values()].sort(
    (a, b) => b.appearances - a.appearances || b.playoffWins - a.playoffWins,
  );
}

/* -------------------------------------------------------------------------- */
/* Weekly high scores (most times posting the top score leaguewide)           */
/* -------------------------------------------------------------------------- */

export interface WeeklyHighStat {
  ownerId: number;
  ownerName: string;
  teamKey: string | null;
  teamName: string | null;
  logoEspn: string | null;
  /** Number of weeks where this owner posted the highest score in the league. */
  count: number;
}

export async function getWeeklyHighScores(): Promise<WeeklyHighStat[]> {
  const seasonOptions = await getSeasonOptions();
  const yearById = new Map(seasonOptions.map((s) => [s.id, s.year]));
  const allSeasonIds = seasonOptions.map((s) => s.id);
  if (allSeasonIds.length === 0) return [];

  const [scoreRows, osRows, seasonRules] = await Promise.all([
    db
      .select({ seasonId: scores.seasonId, ownerSeasonId: scores.ownerSeasonId, week: scores.week, dkPoints: scores.dkPoints, isBye: scores.isBye })
      .from(scores)
      .where(and(inArray(scores.seasonId, allSeasonIds), eq(scores.isExhibition, false))),
    db
      .select({ ownerSeasonId: ownerSeasons.id, seasonId: ownerSeasons.seasonId, ownerId: owners.id,
        ownerName: sql<string>`coalesce(${ownerSeasons.displayName}, ${owners.name})`,
        teamKey: nflTeams.key, teamName: nflTeams.name, logoEspn: nflTeams.logoEspn })
      .from(ownerSeasons)
      .innerJoin(owners, eq(ownerSeasons.ownerId, owners.id))
      .innerJoin(nflTeams, eq(ownerSeasons.nflTeamId, nflTeams.id)),
    db
      .select({ id: seasons.id, rules: seasons.rules, regularSeasonWeeks: seasons.regularSeasonWeeks, entryFeeCents: seasons.entryFeeCents })
      .from(seasons),
  ]);

  const regularWeeksBySeason = new Map(
    // Canonical column; see the note in getSeasonHistory.
    seasonRules.map((r) => [r.id, r.regularSeasonWeeks ?? getSeasonRules(r.rules).regularSeasonWeeks]),
  );

  type Identity = { ownerId: number; ownerName: string; teamKey: string | null; teamName: string | null; logoEspn: string | null; seasonId: number };
  const identityByOwnerSeason = new Map<number, Identity>();
  for (const r of osRows) {
    identityByOwnerSeason.set(r.ownerSeasonId, { ownerId: r.ownerId, ownerName: r.ownerName,
      teamKey: r.teamKey, teamName: r.teamName, logoEspn: r.logoEspn ?? null, seasonId: r.seasonId });
  }

  // Find the top scorer for each regular-season (season, week).
  const maxPerWeek = new Map<string, { ownerSeasonId: number; points: number }>();
  for (const s of scoreRows) {
    if (s.isBye || s.dkPoints === null) continue;
    if (s.week > (regularWeeksBySeason.get(s.seasonId) ?? 18)) continue;
    const key = `${s.seasonId}:${s.week}`;
    const pts = Number(s.dkPoints);
    const cur = maxPerWeek.get(key);
    if (!cur || pts > cur.points) maxPerWeek.set(key, { ownerSeasonId: s.ownerSeasonId, points: pts });
  }

  type Agg = WeeklyHighStat & { latestYear: number };
  const byOwner = new Map<number, Agg>();
  for (const { ownerSeasonId } of maxPerWeek.values()) {
    const identity = identityByOwnerSeason.get(ownerSeasonId);
    if (!identity) continue;
    const year = yearById.get(identity.seasonId) ?? 0;
    let agg = byOwner.get(identity.ownerId);
    if (!agg) {
      agg = { ownerId: identity.ownerId, ownerName: identity.ownerName, teamKey: identity.teamKey,
        teamName: identity.teamName, logoEspn: identity.logoEspn, count: 0, latestYear: 0 };
      byOwner.set(identity.ownerId, agg);
    }
    if (year > agg.latestYear) {
      agg.latestYear = year; agg.ownerName = identity.ownerName; agg.teamKey = identity.teamKey;
      agg.teamName = identity.teamName; agg.logoEspn = identity.logoEspn;
    }
    agg.count += 1;
  }

  return [...byOwner.values()].sort((a, b) => b.count - a.count);
}

/* -------------------------------------------------------------------------- */
/* Single-game extremes (closest match & biggest blowout, regular season)     */
/* -------------------------------------------------------------------------- */

export interface GameExtreme {
  winnerOwnerName: string;
  loserOwnerName: string;
  winnerTeamKey: string;
  loserTeamKey: string;
  winnerLogoEspn: string | null;
  loserLogoEspn: string | null;
  winnerPoints: number;
  loserPoints: number;
  margin: number;
  year: number;
  week: number;
}

export interface GameExtremes {
  closest: GameExtreme | null;
  biggestBlowout: GameExtreme | null;
}

export async function getGameExtremes(): Promise<GameExtremes> {
  const seasonOptions = await getSeasonOptions();
  const yearById = new Map(seasonOptions.map((s) => [s.id, s.year]));
  const seasonsWithData = seasonOptions.map((s) => s.id);
  if (seasonsWithData.length === 0) return { closest: null, biggestBlowout: null };

  const [matchupRows, scoreRows, osRows] = await Promise.all([
    db
      .select({ seasonId: matchups.seasonId, week: matchups.week,
        homeOwnerSeasonId: matchups.homeOwnerSeasonId, awayOwnerSeasonId: matchups.awayOwnerSeasonId })
      .from(matchups)
      .where(and(eq(matchups.isPlayoff, false), eq(matchups.isExhibition, false))),
    db
      .select({ ownerSeasonId: scores.ownerSeasonId, week: scores.week, dkPoints: scores.dkPoints, isBye: scores.isBye })
      .from(scores)
      .where(and(inArray(scores.seasonId, seasonsWithData), eq(scores.isExhibition, false))),
    db
      .select({ ownerSeasonId: ownerSeasons.id, ownerId: owners.id,
        ownerName: sql<string>`coalesce(${ownerSeasons.displayName}, ${owners.name})`,
        teamKey: nflTeams.key, logoEspn: nflTeams.logoEspn })
      .from(ownerSeasons)
      .innerJoin(owners, eq(ownerSeasons.ownerId, owners.id))
      .innerJoin(nflTeams, eq(ownerSeasons.nflTeamId, nflTeams.id)),
  ]);

  const pointsByKey = new Map<string, number>();
  for (const s of scoreRows) {
    if (s.isBye || s.dkPoints === null) continue;
    pointsByKey.set(`${s.ownerSeasonId}:${s.week}`, Number(s.dkPoints));
  }

  type IdentitySmall = { ownerName: string; teamKey: string; logoEspn: string | null };
  const identityByOwnerSeason = new Map<number, IdentitySmall>();
  for (const r of osRows) {
    identityByOwnerSeason.set(r.ownerSeasonId, { ownerName: r.ownerName, teamKey: r.teamKey, logoEspn: r.logoEspn ?? null });
  }

  let closest: GameExtreme | null = null;
  let biggestBlowout: GameExtreme | null = null;

  for (const m of matchupRows) {
    const homePts = pointsByKey.get(`${m.homeOwnerSeasonId}:${m.week}`);
    const awayPts = pointsByKey.get(`${m.awayOwnerSeasonId}:${m.week}`);
    // Skip unscored games and forfeit games (score of 0 = missed lineup, not real play).
    if (homePts === undefined || awayPts === undefined) continue;
    if (homePts <= 0 || awayPts <= 0) continue;

    const margin = Math.abs(homePts - awayPts);
    const winnerIsHome = homePts >= awayPts;
    const winnerOsId = winnerIsHome ? m.homeOwnerSeasonId : m.awayOwnerSeasonId;
    const loserOsId = winnerIsHome ? m.awayOwnerSeasonId : m.homeOwnerSeasonId;
    const wi = identityByOwnerSeason.get(winnerOsId);
    const li = identityByOwnerSeason.get(loserOsId);
    if (!wi || !li) continue;

    const game: GameExtreme = {
      winnerOwnerName: wi.ownerName, loserOwnerName: li.ownerName,
      winnerTeamKey: wi.teamKey, loserTeamKey: li.teamKey,
      winnerLogoEspn: wi.logoEspn, loserLogoEspn: li.logoEspn,
      winnerPoints: winnerIsHome ? homePts : awayPts,
      loserPoints: winnerIsHome ? awayPts : homePts,
      margin, year: yearById.get(m.seasonId) ?? 0, week: m.week,
    };

    if (closest === null || margin < closest.margin) closest = game;
    if (biggestBlowout === null || margin > biggestBlowout.margin) biggestBlowout = game;
  }

  return { closest, biggestBlowout };
}

/* -------------------------------------------------------------------------- */
/* Win / loss streaks (all-time, cross-season)                                 */
/* -------------------------------------------------------------------------- */

export interface StreakRecord {
  ownerId: number;
  ownerName: string;
  streak: number;
  startYear: number;
  startWeek: number;
  endYear: number;
  endWeek: number;
}

export interface StreakLeaders {
  longestWinStreak: StreakRecord[];
  longestLossStreak: StreakRecord[];
}

/**
 * Longest winning and losing streaks per owner across all regular-season games.
 * Streaks reset at each season boundary. Ties count as neither W nor L and reset both counters.
 */
export async function getStreakLeaders(): Promise<StreakLeaders> {
  const seasonOptions = await getSeasonOptions();
  const yearById = new Map(seasonOptions.map((s) => [s.id, s.year]));
  const seasonsWithData = seasonOptions.map((s) => s.id);
  if (seasonsWithData.length === 0) return { longestWinStreak: [], longestLossStreak: [] };

  const [matchupRows, scoreRows, osRows] = await Promise.all([
    db
      .select({
        seasonId: matchups.seasonId,
        week: matchups.week,
        homeOwnerSeasonId: matchups.homeOwnerSeasonId,
        awayOwnerSeasonId: matchups.awayOwnerSeasonId,
      })
      .from(matchups)
      .where(and(eq(matchups.isPlayoff, false), eq(matchups.isExhibition, false))),
    db
      .select({
        ownerSeasonId: scores.ownerSeasonId,
        week: scores.week,
        dkPoints: scores.dkPoints,
        isBye: scores.isBye,
      })
      .from(scores)
      .where(and(inArray(scores.seasonId, seasonsWithData), eq(scores.isExhibition, false))),
    db
      .select({
        ownerSeasonId: ownerSeasons.id,
        seasonId: ownerSeasons.seasonId,
        ownerId: owners.id,
        ownerName: sql<string>`coalesce(${ownerSeasons.displayName}, ${owners.name})`,
      })
      .from(ownerSeasons)
      .innerJoin(owners, eq(ownerSeasons.ownerId, owners.id)),
  ]);

  const pointsByKey = new Map<string, number | null>();
  for (const s of scoreRows) {
    const pts = s.isBye || s.dkPoints === null ? null : Number(s.dkPoints);
    pointsByKey.set(`${s.ownerSeasonId}:${s.week}`, pts);
  }

  const osIdToOwnerId = new Map<number, number>();
  const latestSeasonByOwner = new Map<number, number>();
  const nameByOwner = new Map<number, string>();
  for (const r of osRows) {
    osIdToOwnerId.set(r.ownerSeasonId, r.ownerId);
    const prev = latestSeasonByOwner.get(r.ownerId) ?? -1;
    if (r.seasonId > prev) {
      latestSeasonByOwner.set(r.ownerId, r.seasonId);
      nameByOwner.set(r.ownerId, r.ownerName);
    }
  }

  type GameResult = { seasonId: number; year: number; week: number; result: 'W' | 'L' | 'T' };
  const gamesByOwner = new Map<number, GameResult[]>();

  for (const m of matchupRows) {
    const year = yearById.get(m.seasonId) ?? 0;
    const homePts = pointsByKey.get(`${m.homeOwnerSeasonId}:${m.week}`);
    const awayPts = pointsByKey.get(`${m.awayOwnerSeasonId}:${m.week}`);
    if (homePts === null || homePts === undefined || awayPts === null || awayPts === undefined) continue;

    let homeResult: 'W' | 'L' | 'T';
    let awayResult: 'W' | 'L' | 'T';
    if (homePts > awayPts) { homeResult = 'W'; awayResult = 'L'; }
    else if (homePts < awayPts) { homeResult = 'L'; awayResult = 'W'; }
    else { homeResult = 'T'; awayResult = 'T'; }

    for (const [osId, result] of [[m.homeOwnerSeasonId, homeResult], [m.awayOwnerSeasonId, awayResult]] as [number, 'W' | 'L' | 'T'][]) {
      const ownerId = osIdToOwnerId.get(osId);
      if (ownerId === undefined) continue;
      let games = gamesByOwner.get(ownerId);
      if (!games) { games = []; gamesByOwner.set(ownerId, games); }
      games.push({ seasonId: m.seasonId, year, week: m.week, result });
    }
  }

  const winStreaks: StreakRecord[] = [];
  const lossStreaks: StreakRecord[] = [];

  for (const [ownerId, games] of gamesByOwner) {
    games.sort((a, b) => a.year - b.year || a.week - b.week);
    const ownerName = nameByOwner.get(ownerId) ?? '';

    let curW = 0, curL = 0, maxW = 0, maxL = 0;
    let prevSeasonId: number | null = null;
    let wStart = games[0]!, lStart = games[0]!;
    let bestWStart = games[0]!, bestWEnd = games[0]!;
    let bestLStart = games[0]!, bestLEnd = games[0]!;

    for (const g of games) {
      // Reset at season boundaries — streaks are within a single season only.
      if (g.seasonId !== prevSeasonId) { curW = 0; curL = 0; prevSeasonId = g.seasonId; }

      if (g.result === 'W') {
        if (curW === 0) wStart = g;
        curW++; curL = 0;
        if (curW > maxW) { maxW = curW; bestWStart = wStart; bestWEnd = g; }
      } else if (g.result === 'L') {
        if (curL === 0) lStart = g;
        curL++; curW = 0;
        if (curL > maxL) { maxL = curL; bestLStart = lStart; bestLEnd = g; }
      } else {
        curW = 0; curL = 0;
      }
    }

    if (maxW > 0) winStreaks.push({ ownerId, ownerName, streak: maxW, startYear: bestWStart.year, startWeek: bestWStart.week, endYear: bestWEnd.year, endWeek: bestWEnd.week });
    if (maxL > 0) lossStreaks.push({ ownerId, ownerName, streak: maxL, startYear: bestLStart.year, startWeek: bestLStart.week, endYear: bestLEnd.year, endWeek: bestLEnd.week });
  }

  winStreaks.sort((a, b) => b.streak - a.streak);
  lossStreaks.sort((a, b) => b.streak - a.streak);

  return { longestWinStreak: winStreaks, longestLossStreak: lossStreaks };
}

/* -------------------------------------------------------------------------- */
/* Missed submissions (forfeits) per owner, all-time                          */
/* -------------------------------------------------------------------------- */

export interface MissedSubmission {
  ownerId: number;
  ownerName: string;
  count: number;
}

/**
 * Counts each owner's missed lineups across all seasons.
 *
 * Uses the SAME missed-lineup set the standings engine applies (schedule-derived, unioned
 * with any manually flagged `isForfeit`) rather than counting every 0.00 score. Counting
 * zeros over-reported: it swept in playoff-week zeros, owner-weeks with no matchup at all,
 * and placeholder zeros written by the historical importers for weeks that were never
 * played — so this table disagreed with the forfeit count on /my-team and with the
 * auto-losses on /standings.
 */
export async function getMissedSubmissions(): Promise<MissedSubmission[]> {
  const seasonOptions = await getSeasonOptions();
  const seasonsWithData = seasonOptions.map((s) => s.id);
  if (seasonsWithData.length === 0) return [];

  const [forfeitSets, osRows] = await Promise.all([
    Promise.all(
      seasonsWithData.map((id) =>
        getSeasonStandingsData(id).then((d) => d.forfeitByOwnerWeek),
      ),
    ),
    db
      .select({
        ownerSeasonId: ownerSeasons.id,
        seasonId: ownerSeasons.seasonId,
        ownerId: owners.id,
        ownerName: sql<string>`coalesce(${ownerSeasons.displayName}, ${owners.name})`,
      })
      .from(ownerSeasons)
      .innerJoin(owners, eq(ownerSeasons.ownerId, owners.id)),
  ]);

  const osIdToOwnerId = new Map<number, number>();
  const latestSeasonByOwner = new Map<number, number>();
  const nameByOwner = new Map<number, string>();
  for (const r of osRows) {
    osIdToOwnerId.set(r.ownerSeasonId, r.ownerId);
    const prev = latestSeasonByOwner.get(r.ownerId) ?? -1;
    if (r.seasonId > prev) {
      latestSeasonByOwner.set(r.ownerId, r.seasonId);
      nameByOwner.set(r.ownerId, r.ownerName);
    }
  }

  const countByOwner = new Map<number, number>();
  for (const forfeits of forfeitSets) {
    for (const key of forfeits) {
      const ownerSeasonId = Number(key.split(':')[0]);
      const ownerId = osIdToOwnerId.get(ownerSeasonId);
      if (ownerId === undefined) continue;
      countByOwner.set(ownerId, (countByOwner.get(ownerId) ?? 0) + 1);
    }
  }

  return [...countByOwner.entries()]
    .map(([ownerId, count]) => ({ ownerId, ownerName: nameByOwner.get(ownerId) ?? '', count }))
    .sort((a, b) => b.count - a.count);
}

/* -------------------------------------------------------------------------- */
/* Schedule luck (expected wins vs actual wins, regular season)               */
/* -------------------------------------------------------------------------- */

export interface ScheduleLuck {
  ownerId: number;
  ownerName: string;
  teamKey: string | null;
  teamName: string | null;
  logoEspn: string | null;
  /** Actual regular-season wins from the standings engine, all-time. */
  actualWins: number;
  /**
   * Expected wins: each week, how many of the other owners the owner would
   * have beaten with their score (ties split 0.5). Summed across all weeks
   * and seasons. On the same numerical scale as `actualWins`.
   */
  expectedWins: number;
  /** actualWins − expectedWins. Positive = lucky schedule; negative = unlucky. */
  luck: number;
}

/**
 * Schedule luck per owner, all-time. For every regular-season week, each
 * owner's score is ranked against every other owner's score that week; the
 * fraction of matchups they would have won becomes their "expected win"
 * contribution for that week. Aggregated across seasons and compared to their
 * actual win total to produce a luck differential. Sorted by luck descending.
 */
export async function getScheduleLuck(): Promise<ScheduleLuck[]> {
  const options = await getSeasonOptions();

  const ownerSeasonRows = await db
    .select({ seasonId: ownerSeasons.seasonId })
    .from(ownerSeasons);
  const seasonsWithData = [...new Set(ownerSeasonRows.map((r) => r.seasonId))];
  if (seasonsWithData.length === 0) return [];

  const seasonRulesRows = await db
    .select({ id: seasons.id, rules: seasons.rules, regularSeasonWeeks: seasons.regularSeasonWeeks })
    .from(seasons)
    .where(inArray(seasons.id, seasonsWithData));
  const regularWeeksBySeason = new Map(
    // The canonical column — `rules.regularSeasonWeeks` is a mirror the Settings page
    // deliberately leaves untouched, so the two drift.
    seasonRulesRows.map((r) => [r.id, r.regularSeasonWeeks ?? getSeasonRules(r.rules).regularSeasonWeeks]),
  );
  const yearBySeasonId = new Map(options.map((s) => [s.id, s.year]));

  const byOwner = new Map<number, {
    actualWins: number;
    expectedWins: number;
    latestYear: number;
    identity: OwnerIdentityRow;
  }>();

  const seasonDataAll = await Promise.all(
    seasonsWithData.map(async (seasonId) => {
      const regularSeasonWeeks = regularWeeksBySeason.get(seasonId) ?? 18;
      const [identities, standings, scoreRows] = await Promise.all([
        loadOwnerIdentities(seasonId),
        getSeasonStandings(seasonId),
        db
          .select({
            ownerSeasonId: scores.ownerSeasonId,
            week: scores.week,
            dkPoints: scores.dkPoints,
            isBye: scores.isBye,
          })
          .from(scores)
          .where(and(
            eq(scores.seasonId, seasonId),
            lte(scores.week, regularSeasonWeeks),
            eq(scores.isExhibition, false),
          )),
      ]);
      return { seasonId, identities, standings, scoreRows };
    }),
  );

  for (const { seasonId, identities, standings, scoreRows } of seasonDataAll) {
    const year = yearBySeasonId.get(seasonId) ?? 0;
    const winsByOwnerSeason = new Map(standings.map((s) => [s.ownerSeasonId, s.wins]));

    // Group valid scores by week (skip byes and unscored weeks).
    const weekScores = new Map<number, { ownerSeasonId: number; pts: number }[]>();
    for (const s of scoreRows) {
      if (s.isBye || s.dkPoints === null) continue;
      const pts = Number(s.dkPoints);
      let arr = weekScores.get(s.week);
      if (!arr) { arr = []; weekScores.set(s.week, arr); }
      arr.push({ ownerSeasonId: s.ownerSeasonId, pts });
    }

    // Expected wins: for each owner in each week, count how many others they
    // would have beaten (ties split as 0.5), divided by (n − 1).
    const expectedByOwnerSeason = new Map<number, number>();
    for (const weekGroup of weekScores.values()) {
      const n = weekGroup.length;
      if (n < 2) continue;
      for (const { ownerSeasonId, pts } of weekGroup) {
        let lower = 0, equal = 0;
        for (const { ownerSeasonId: otherId, pts: otherPts } of weekGroup) {
          if (otherId === ownerSeasonId) continue;
          if (otherPts < pts) lower++;
          else if (otherPts === pts) equal++;
        }
        const expWin = (lower + equal * 0.5) / (n - 1);
        expectedByOwnerSeason.set(ownerSeasonId, (expectedByOwnerSeason.get(ownerSeasonId) ?? 0) + expWin);
      }
    }

    // Roll up to person level using the most recent identity per owner.
    for (const [osId, identity] of identities) {
      const ownerId = identity.ownerId;
      const actual = winsByOwnerSeason.get(osId) ?? 0;
      const expected = expectedByOwnerSeason.get(osId) ?? 0;

      let agg = byOwner.get(ownerId);
      if (!agg) {
        agg = { actualWins: 0, expectedWins: 0, latestYear: 0, identity };
        byOwner.set(ownerId, agg);
      }
      if (year >= agg.latestYear) {
        agg.latestYear = year;
        agg.identity = identity;
      }
      agg.actualWins += actual;
      agg.expectedWins += expected;
    }
  }

  return [...byOwner.values()]
    .map(({ actualWins, expectedWins, identity }) => ({
      ownerId: identity.ownerId,
      ownerName: identity.ownerName,
      teamKey: identity.teamKey,
      teamName: identity.teamName,
      logoEspn: identity.logoEspn,
      actualWins,
      expectedWins,
      luck: actualWins - expectedWins,
    }))
    .sort((a, b) => b.luck - a.luck);
}

/* -------------------------------------------------------------------------- */
/* Biggest earners (all-time payout totals)                                   */
/* -------------------------------------------------------------------------- */

export interface NetEarningsLeader {
  ownerId: number;
  ownerName: string;
  /** Prize money won minus entry fees paid, in cents. */
  netCents: number;
  earnedCents: number;
  paidCents: number;
}

/**
 * Net earnings per owner (prize money minus entry fees) across all seasons,
 * descending. Every owner who has played at least one season is included.
 */
export async function getNetEarnings(): Promise<NetEarningsLeader[]> {
  const [seasonRows, ownerSeasonRows, earningsRows] = await Promise.all([
    db
      .select({ id: seasons.id, rules: seasons.rules, regularSeasonWeeks: seasons.regularSeasonWeeks, entryFeeCents: seasons.entryFeeCents })
      .from(seasons),
    db
      .select({
        ownerId: owners.id,
        ownerName: sql<string>`coalesce(${ownerSeasons.displayName}, ${owners.name})`,
        seasonId: ownerSeasons.seasonId,
      })
      .from(ownerSeasons)
      .innerJoin(owners, eq(ownerSeasons.ownerId, owners.id)),
    db
      .select({
        ownerId: seasonAwards.ownerId,
        earnedCents: sql<number>`cast(coalesce(sum(${seasonAwards.amountCents}), 0) as integer)`,
      })
      .from(seasonAwards)
      .where(isNotNull(seasonAwards.ownerId))
      .groupBy(seasonAwards.ownerId),
  ]);

  const entryFeeBySeason = new Map(
    // Canonical column; `rules.payouts.entryFeeCents` is a mirror the Settings page preserves.
    seasonRows.map((s) => [s.id, s.entryFeeCents ?? getSeasonRules(s.rules).payouts.entryFeeCents]),
  );

  const earnedByOwner = new Map(earningsRows.map((r) => [r.ownerId, r.earnedCents]));

  const paidByOwner = new Map<number, number>();
  const nameByOwner = new Map<number, string>();
  for (const r of ownerSeasonRows) {
    paidByOwner.set(r.ownerId, (paidByOwner.get(r.ownerId) ?? 0) + (entryFeeBySeason.get(r.seasonId) ?? 0));
    nameByOwner.set(r.ownerId, r.ownerName);
  }

  return [...paidByOwner.keys()]
    .map((ownerId) => {
      const earnedCents = earnedByOwner.get(ownerId) ?? 0;
      const paidCents = paidByOwner.get(ownerId) ?? 0;
      return { ownerId, ownerName: nameByOwner.get(ownerId) ?? '', netCents: earnedCents - paidCents, earnedCents, paidCents };
    })
    .sort((a, b) => b.netCents - a.netCents);
}

/* -------------------------------------------------------------------------- */
/* One owner's career — the consolidated per-person view                       */
/* -------------------------------------------------------------------------- */

/**
 * NOTE ON THE EXHIBITION FILTER: nothing below adds a new `scores`/`matchups` read.
 * `getOwnerCareer` composes the all-time aggregates above, each of which already carries
 * `eq(scores.isExhibition, false)` / `eq(matchups.isExhibition, false)`, and the one extra
 * query here reads `playoff_matchups`, which has no exhibition rows at all. That is
 * deliberate: composing filtered readers is how this view avoids re-litigating the filter
 * rule documented in the module header.
 */

/** One season line on an owner's career table. */
export interface OwnerCareerSeason {
  seasonId: number;
  year: number;
  seasonName: string;
  teamKey: string;
  teamName: string;
  logoEspn: string | null;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
  /** 1-based finish under the league's FULL tiebreaker chain (not a local re-sort). */
  finish: number;
  /** How many owners were in the league that year, so "4th" can be shown as "4th of 32". */
  fieldSize: number;
  madePlayoffs: boolean;
  isChampion: boolean;
  /**
   * Led the league in regular-season Points For that year — the season the $400
   * most-points prize pays out on. Sourced from the same `computeStandings` pointsFor the
   * award uses, so this cannot disagree with the ledger.
   */
  wonPointsTitle: boolean;
}

/** A single regular-season meeting, from the owner's own perspective. */
export interface OwnerCareerGame {
  year: number;
  week: number;
  points: number;
  oppPoints: number;
  opponent: OwnerIdentity;
}

/** One opponent's all-time line, from the owner's own perspective. */
export interface OwnerCareerRival {
  opponent: OwnerIdentity;
  wins: number;
  losses: number;
  ties: number;
  meetings: number;
}

/** Everything /history/career shows for one person. */
export interface OwnerCareer {
  owner: OwnerIdentity;
  seasonsPlayed: number;
  wins: number;
  losses: number;
  ties: number;
  winPct: number;
  pointsFor: number;
  pointsAgainst: number;
  /** Per game, so uneven games played (byes) don't distort a comparison. */
  pointsForPerGame: number;
  pointsAgainstPerGame: number;
  pointsDiffPerGame: number;
  bestWeek: { week: number; points: number; year: number } | null;
  championships: number;
  championYears: number[];
  playoffAppearances: number;
  playoffWins: number;
  playoffLosses: number;
  weeklyHighs: number;
  /** Actual vs expected wins. Positive luck = a kinder schedule than the scores earned. */
  luck: { actualWins: number; expectedWins: number; luck: number } | null;
  longestWinStreak: StreakRecord | null;
  longestLossStreak: StreakRecord | null;
  missedLineups: number;
  /**
   * Best (lowest) season finish and the year it happened. A finish is a whole-season
   * result, so unlike a per-game rate it stays meaningful at a three-season sample.
   */
  bestFinish: { finish: number; fieldSize: number; year: number } | null;
  /** Mean finish across seasons played, on the same 1..fieldSize scale. */
  averageFinish: number | null;
  /** Seasons leading the league in regular-season Points For, and which years. */
  pointsTitles: number;
  pointsTitleYears: number[];
  /**
   * Current playoff run, counted in SEASONS THE OWNER PLAYED — not calendar years. An owner
   * who sat out a season did not extend a drought through it, and saying otherwise would
   * invent a miss they were never eligible for.
   *
   * `berth` = that many consecutive appearances, most recent season first.
   * `drought` = that many consecutive misses since `lastBerthYear`.
   * `none` = has never reached the postseason; `count` is seasons played.
   */
  playoffRun: {
    kind: 'berth' | 'drought' | 'none';
    count: number;
    lastBerthYear: number | null;
    /**
     * For a `berth` run, the year the run STARTED — read off the season line rather than
     * derived as `lastBerthYear - count + 1`, because seasons played are not necessarily
     * consecutive calendar years and that subtraction would invent a year the owner sat out.
     */
    runStartYear: number | null;
  };
  /** Worst all-time record against (min 3 meetings). */
  nemesis: OwnerCareerRival | null;
  /** Best all-time record against (min 3 meetings). */
  favouriteVictim: OwnerCareerRival | null;
  /** Most-played opponents, descending. */
  topRivals: OwnerCareerRival[];
  /** Highest-scoring LOSS — the week they did everything right and lost anyway. */
  robbery: OwnerCareerGame | null;
  /** Lowest-scoring WIN — the week they got away with one. */
  heist: OwnerCareerGame | null;
  /** Newest season first. Seasons that have not been played yet are omitted. */
  seasons: OwnerCareerSeason[];
}

/**
 * Every owner who has ever been assigned a team, with their most-recent team identity,
 * sorted by name. This is the career page's picker: it must list EVERYONE, because the
 * whole point of the page is that an owner outside the top-10 leaderboards can still find
 * themselves.
 */
export async function getOwnerDirectory(): Promise<OwnerIdentity[]> {
  const rows = await db
    .select({
      ownerId: owners.id,
      ownerName: sql<string>`coalesce(${ownerSeasons.displayName}, ${owners.name})`,
      seasonYear: seasons.year,
      teamKey: nflTeams.key,
      teamName: nflTeams.name,
      logoEspn: nflTeams.logoEspn,
    })
    .from(ownerSeasons)
    .innerJoin(owners, eq(ownerSeasons.ownerId, owners.id))
    .innerJoin(seasons, eq(ownerSeasons.seasonId, seasons.id))
    .innerJoin(nflTeams, eq(ownerSeasons.nflTeamId, nflTeams.id));

  const byOwner = new Map<number, OwnerIdentity>();
  const latestYear = new Map<number, number>();
  for (const r of rows) {
    const seen = latestYear.get(r.ownerId);
    if (seen === undefined || r.seasonYear >= seen) {
      latestYear.set(r.ownerId, r.seasonYear);
      byOwner.set(r.ownerId, {
        ownerId: r.ownerId,
        ownerName: r.ownerName,
        teamKey: r.teamKey,
        teamName: r.teamName,
        logoEspn: r.logoEspn ?? null,
      });
    }
  }
  return [...byOwner.values()].sort((a, b) => a.ownerName.localeCompare(b.ownerName));
}

/** seasonId set per owner for seasons in which they appeared in at least one playoff game. */
async function loadPlayoffSeasonsByOwner(): Promise<Map<number, Set<number>>> {
  const [pmRows, osRows] = await Promise.all([
    db
      .select({
        seasonId: playoffMatchups.seasonId,
        highOwnerSeasonId: playoffMatchups.highOwnerSeasonId,
        lowOwnerSeasonId: playoffMatchups.lowOwnerSeasonId,
      })
      .from(playoffMatchups),
    db
      .select({ ownerSeasonId: ownerSeasons.id, ownerId: ownerSeasons.ownerId })
      .from(ownerSeasons),
  ]);
  const ownerByOwnerSeason = new Map(osRows.map((r) => [r.ownerSeasonId, r.ownerId]));
  const out = new Map<number, Set<number>>();
  const mark = (osId: number | null, seasonId: number) => {
    if (osId === null) return;
    const ownerId = ownerByOwnerSeason.get(osId);
    if (ownerId === undefined) return;
    let set = out.get(ownerId);
    if (!set) { set = new Set(); out.set(ownerId, set); }
    set.add(seasonId);
  };
  for (const p of pmRows) {
    mark(p.highOwnerSeasonId, p.seasonId);
    mark(p.lowOwnerSeasonId, p.seasonId);
  }
  return out;
}

const MIN_RIVALRY_MEETINGS = 3;

/**
 * One person's whole career, consolidated. Returns `null` for an owner id that has never
 * been assigned a team.
 *
 * Composed from the all-time aggregates above rather than from fresh SQL — see the note at
 * the top of this section for why. Season lines come from `getRankedSeasonStandings`, so the
 * finish shown is the league's real tiebreaker order and matches /standings and the bracket.
 */
export async function getOwnerCareer(ownerId: number): Promise<OwnerCareer | null> {
  const [
    directory,
    options,
    leaders,
    champions,
    playoffStats,
    weeklyHighs,
    streaks,
    luckRows,
    missedRows,
    rivalries,
    playoffSeasons,
  ] = await Promise.all([
    getOwnerDirectory(),
    getSeasonOptions(),
    getAllTimeLeaders(),
    getChampionLeaders(),
    getPlayoffStats(),
    getWeeklyHighScores(),
    getStreakLeaders(),
    getScheduleLuck(),
    getMissedSubmissions(),
    getAllTimeRivalries(),
    loadPlayoffSeasonsByOwner(),
  ]);

  const owner = directory.find((o) => o.ownerId === ownerId) ?? null;
  if (!owner) return null;

  const championEntry = champions.find((c) => c.ownerId === ownerId) ?? null;
  const championYears = championEntry ? [...championEntry.years].sort((a, b) => b - a) : [];
  const championYearSet = new Set(championYears);
  const myPlayoffSeasons = playoffSeasons.get(ownerId) ?? new Set<number>();

  // Season-by-season, newest first. A season nobody has played yet contributes nothing —
  // an 0-0 row for an upcoming season is noise, and mirrors how the season cards on
  // /history treat weeksPlayed === 0.
  const perSeason = await Promise.all(
    options.map(async (opt) => {
      const [identities, ranked] = await Promise.all([
        loadOwnerIdentities(opt.id),
        getRankedSeasonStandings(opt.id),
      ]);
      if (ranked.weeksPlayed === 0) return null;
      const idx = ranked.rows.findIndex((r) => identities.get(r.ownerSeasonId)?.ownerId === ownerId);
      if (idx === -1) return null;
      const row = ranked.rows[idx];
      const identity = identities.get(row.ownerSeasonId)!;
      // Points title = most regular-season Points For. Compared against the max rather than
      // by re-sorting, so an exact tie awards it to both — matching how the awards ledger
      // splits the prize instead of picking an arbitrary winner.
      const maxPointsFor = ranked.rows.reduce((m, r) => (r.pointsFor > m ? r.pointsFor : m), 0);
      const season: OwnerCareerSeason = {
        seasonId: opt.id,
        year: opt.year,
        seasonName: opt.name,
        teamKey: identity.teamKey,
        teamName: identity.teamName,
        logoEspn: identity.logoEspn,
        wins: row.wins,
        losses: row.losses,
        ties: row.ties,
        pointsFor: row.pointsFor,
        pointsAgainst: row.pointsAgainst,
        finish: idx + 1,
        fieldSize: ranked.rows.length,
        madePlayoffs: myPlayoffSeasons.has(opt.id),
        isChampion: championYearSet.has(opt.year),
        wonPointsTitle: ranked.rows.length > 0 && row.pointsFor === maxPointsFor,
      };
      return season;
    }),
  );
  const seasonRows = perSeason
    .filter((s): s is OwnerCareerSeason => s !== null)
    .sort((a, b) => b.year - a.year);

  const wins = seasonRows.reduce((n, s) => n + s.wins, 0);
  const losses = seasonRows.reduce((n, s) => n + s.losses, 0);
  const ties = seasonRows.reduce((n, s) => n + s.ties, 0);
  const pointsFor = seasonRows.reduce((n, s) => n + s.pointsFor, 0);
  const pointsAgainst = seasonRows.reduce((n, s) => n + s.pointsAgainst, 0);
  const games = wins + losses + ties;

  // Rivals, from the owner's own perspective (the stored pair is in canonical A/B order).
  const rivals: OwnerCareerRival[] = [];
  let robbery: OwnerCareerGame | null = null;
  let heist: OwnerCareerGame | null = null;
  for (const rv of rivalries.rivalries) {
    const isA = rv.ownerA.ownerId === ownerId;
    const isB = rv.ownerB.ownerId === ownerId;
    if (!isA && !isB) continue;
    const opponent = isA ? rv.ownerB : rv.ownerA;
    rivals.push({
      opponent,
      wins: isA ? rv.aWins : rv.bWins,
      losses: isA ? rv.bWins : rv.aWins,
      ties: rv.ties,
      meetings: rv.meetings,
    });
    for (const g of rv.games) {
      const points = isA ? g.aPoints : g.bPoints;
      const oppPoints = isA ? g.bPoints : g.aPoints;
      const game: OwnerCareerGame = { year: g.year, week: g.week, points, oppPoints, opponent };
      if (points < oppPoints && (robbery === null || points > robbery.points)) robbery = game;
      if (points > oppPoints && (heist === null || points < heist.points)) heist = game;
    }
  }

  // Nemesis / favourite victim need a minimum sample: a 1-0 record against someone is not a
  // rivalry, and surfacing it as one would make the most-played opponents look arbitrary.
  const decided = rivals.filter((r) => r.meetings >= MIN_RIVALRY_MEETINGS && r.wins + r.losses > 0);
  const share = (r: OwnerCareerRival) => (r.wins + r.ties * 0.5) / r.meetings;
  const ranked = [...decided].sort((a, b) => share(a) - share(b) || b.meetings - a.meetings);
  const nemesis = ranked.length > 0 && share(ranked[0]) < 0.5 ? ranked[0] : null;
  const best = ranked[ranked.length - 1] ?? null;
  const favouriteVictim = best && share(best) > 0.5 ? best : null;

  const leader = leaders.leaders.find((l) => l.ownerId === ownerId) ?? null;
  const playoffs = playoffStats.find((p) => p.ownerId === ownerId) ?? null;
  const luckRow = luckRows.find((l) => l.ownerId === ownerId) ?? null;

  // Best / average finish, from the season lines already assembled above.
  const bestSeason = seasonRows.reduce<OwnerCareerSeason | null>(
    (best, s) => (best === null || s.finish < best.finish ? s : best),
    null,
  );

  const pointsTitleYears = seasonRows.filter((s) => s.wonPointsTitle).map((s) => s.year);

  // Playoff run. seasonRows is newest-first, so the leading run of like results IS the
  // current streak; counting over played seasons is what keeps a year spent out of the
  // league from being scored as a miss.
  const everMade = seasonRows.some((s) => s.madePlayoffs);
  let playoffRun: OwnerCareer['playoffRun'];
  if (seasonRows.length === 0 || !everMade) {
    playoffRun = { kind: 'none', count: seasonRows.length, lastBerthYear: null, runStartYear: null };
  } else if (seasonRows[0].madePlayoffs) {
    let n = 0;
    while (n < seasonRows.length && seasonRows[n].madePlayoffs) n += 1;
    playoffRun = {
      kind: 'berth',
      count: n,
      lastBerthYear: seasonRows[0].year,
      runStartYear: seasonRows[n - 1].year,
    };
  } else {
    let n = 0;
    while (n < seasonRows.length && !seasonRows[n].madePlayoffs) n += 1;
    playoffRun = {
      kind: 'drought',
      count: n,
      lastBerthYear: seasonRows.find((s) => s.madePlayoffs)?.year ?? null,
      runStartYear: null,
    };
  }

  return {
    owner,
    seasonsPlayed: seasonRows.length,
    wins,
    losses,
    ties,
    winPct: games === 0 ? 0 : (wins + ties * 0.5) / games,
    pointsFor,
    pointsAgainst,
    pointsForPerGame: games === 0 ? 0 : pointsFor / games,
    pointsAgainstPerGame: games === 0 ? 0 : pointsAgainst / games,
    pointsDiffPerGame: games === 0 ? 0 : (pointsFor - pointsAgainst) / games,
    bestWeek: leader?.bestWeek ?? null,
    championships: championYears.length,
    championYears,
    playoffAppearances: playoffs?.appearances ?? 0,
    playoffWins: playoffs?.playoffWins ?? 0,
    playoffLosses: playoffs?.playoffLosses ?? 0,
    weeklyHighs: weeklyHighs.find((w) => w.ownerId === ownerId)?.count ?? 0,
    luck: luckRow
      ? { actualWins: luckRow.actualWins, expectedWins: luckRow.expectedWins, luck: luckRow.luck }
      : null,
    longestWinStreak: streaks.longestWinStreak.find((s) => s.ownerId === ownerId) ?? null,
    longestLossStreak: streaks.longestLossStreak.find((s) => s.ownerId === ownerId) ?? null,
    missedLineups: missedRows.find((m) => m.ownerId === ownerId)?.count ?? 0,
    bestFinish: bestSeason
      ? { finish: bestSeason.finish, fieldSize: bestSeason.fieldSize, year: bestSeason.year }
      : null,
    averageFinish:
      seasonRows.length === 0
        ? null
        : seasonRows.reduce((n, s) => n + s.finish, 0) / seasonRows.length,
    pointsTitles: pointsTitleYears.length,
    pointsTitleYears,
    playoffRun,
    nemesis,
    favouriteVictim,
    topRivals: [...rivals].sort((a, b) => b.meetings - a.meetings).slice(0, 5),
    robbery,
    heist,
    seasons: seasonRows,
  };
}
