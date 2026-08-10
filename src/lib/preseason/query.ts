/**
 * Read model for the preseason (exhibition) view.
 *
 * Exhibition matchups/scores live under the `isExhibition` flag at the preseason week
 * namespace (see src/lib/schedule/preseason.ts) and are excluded from every standings/stats
 * query. This module is the ONE place that deliberately reads them, to render the `/preseason`
 * page + the Admin → Preseason results. Server-only.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';

import { db, matchups, nflTeams, owners, ownerSeasons, scores, seasons } from '@/db';
import { exhibitionWeekLabel, fromExhibitionWeek } from '@/lib/schedule/preseason';

export interface PreseasonSeasonOption {
  id: number;
  year: number;
  name: string;
}

/** Seasons that have at least one exhibition matchup, most recent (year) first. */
export async function getPreseasonSeasonOptions(): Promise<PreseasonSeasonOption[]> {
  const ids = await db
    .selectDistinct({ seasonId: matchups.seasonId })
    .from(matchups)
    .where(eq(matchups.isExhibition, true));
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: seasons.id, year: seasons.year, name: seasons.name })
    .from(seasons)
    .where(inArray(seasons.id, ids.map((r) => r.seasonId)))
    .orderBy(desc(seasons.year));
  return rows;
}

export interface PreseasonParticipant {
  ownerSeasonId: number;
  ownerName: string;
  teamKey: string;
  teamName: string;
  logoEspn: string | null;
  points: number | null;
  isWinner: boolean;
}

export interface PreseasonGame {
  id: number;
  home: PreseasonParticipant;
  away: PreseasonParticipant;
  /** null until both sides are scored; then the winning ownerSeasonId, or null on a tie. */
  winnerOwnerSeasonId: number | null;
  isTie: boolean;
}

export interface PreseasonView {
  hasData: boolean;
  week: number | null;
  preseasonWeek: number | null;
  label: string | null;
  games: PreseasonGame[];
}

/** Owner-season display info for a season, keyed by ownerSeasonId. */
async function ownerDisplay(seasonId: number) {
  const rows = await db
    .select({
      ownerSeasonId: ownerSeasons.id,
      ownerName: ownerSeasons.displayName,
      fallbackName: owners.name,
      teamKey: nflTeams.key,
      teamName: nflTeams.name,
      logoEspn: nflTeams.logoEspn,
    })
    .from(ownerSeasons)
    .innerJoin(owners, eq(ownerSeasons.ownerId, owners.id))
    .innerJoin(nflTeams, eq(ownerSeasons.nflTeamId, nflTeams.id))
    .where(eq(ownerSeasons.seasonId, seasonId));
  return new Map(
    rows.map((r) => [
      r.ownerSeasonId,
      {
        ownerName: r.ownerName ?? r.fallbackName,
        teamKey: r.teamKey,
        teamName: r.teamName,
        logoEspn: r.logoEspn ?? null,
      },
    ]),
  );
}

/** The preseason/exhibition weeks present for a season (stored week values), newest first. */
export async function getPreseasonWeeks(seasonId: number): Promise<number[]> {
  const rows = await db
    .select({ week: matchups.week })
    .from(matchups)
    .where(and(eq(matchups.seasonId, seasonId), eq(matchups.isExhibition, true)))
    .orderBy(desc(matchups.week));
  return [...new Set(rows.map((r) => r.week))];
}

/**
 * Read the exhibition view for a season. Defaults to the most recent exhibition week
 * present. Returns `hasData: false` when the season has no exhibition matchups.
 */
export async function getPreseasonView(
  seasonId: number,
  week?: number,
): Promise<PreseasonView> {
  const weeks = await getPreseasonWeeks(seasonId);
  const target = week && weeks.includes(week) ? week : weeks[0];
  if (target === undefined) {
    return { hasData: false, week: null, preseasonWeek: null, label: null, games: [] };
  }

  const [rows, display, scoreRows] = await Promise.all([
    db
      .select({
        id: matchups.id,
        homeOwnerSeasonId: matchups.homeOwnerSeasonId,
        awayOwnerSeasonId: matchups.awayOwnerSeasonId,
      })
      .from(matchups)
      .where(and(eq(matchups.seasonId, seasonId), eq(matchups.week, target)))
      .orderBy(matchups.id),
    ownerDisplay(seasonId),
    db
      .select({ ownerSeasonId: scores.ownerSeasonId, dkPoints: scores.dkPoints, isBye: scores.isBye })
      .from(scores)
      .where(and(eq(scores.seasonId, seasonId), eq(scores.week, target))),
  ]);

  const pointsByOwner = new Map<number, number | null>();
  for (const s of scoreRows) {
    pointsByOwner.set(s.ownerSeasonId, s.isBye || s.dkPoints === null ? null : Number(s.dkPoints));
  }

  const games: PreseasonGame[] = rows.map((m) => {
    const homePts = pointsByOwner.get(m.homeOwnerSeasonId) ?? null;
    const awayPts = pointsByOwner.get(m.awayOwnerSeasonId) ?? null;
    const scored = homePts !== null && awayPts !== null;
    let winnerOwnerSeasonId: number | null = null;
    let isTie = false;
    if (scored) {
      if (homePts > awayPts) winnerOwnerSeasonId = m.homeOwnerSeasonId;
      else if (awayPts > homePts) winnerOwnerSeasonId = m.awayOwnerSeasonId;
      else isTie = true;
    }
    const mk = (osId: number, points: number | null): PreseasonParticipant => {
      const d = display.get(osId);
      return {
        ownerSeasonId: osId,
        ownerName: d?.ownerName ?? '—',
        teamKey: d?.teamKey ?? '—',
        teamName: d?.teamName ?? '—',
        logoEspn: d?.logoEspn ?? null,
        points,
        isWinner: winnerOwnerSeasonId === osId,
      };
    };
    return {
      id: m.id,
      home: mk(m.homeOwnerSeasonId, homePts),
      away: mk(m.awayOwnerSeasonId, awayPts),
      winnerOwnerSeasonId,
      isTie,
    };
  });

  return {
    hasData: true,
    week: target,
    preseasonWeek: fromExhibitionWeek(target),
    label: exhibitionWeekLabel(target),
    games,
  };
}
