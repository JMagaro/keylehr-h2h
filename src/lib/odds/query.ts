/**
 * Read adapter for the playoff-odds trend chart.
 *
 * Loads the persisted `playoff_odds_snapshots` for a season and reshapes them
 * into the per-owner series the chart consumes. Numeric DB columns
 * (`numeric(5,2)`) come back as strings; we convert with `Number` exactly once,
 * here. The snapshots themselves are produced offline by
 * `scripts/compute-odds.ts` (which runs `computePlayoffOddsSnapshots`), so this
 * function is a cheap, render-time read.
 */
import { asc, eq } from 'drizzle-orm';

import { db, nflTeams, owners, ownerSeasons, playoffOddsSnapshots } from '@/db';
import type { Conference } from '@/lib/standings';

/** One owner's playoff-odds trend across the season's scored weeks. */
export interface OddsTrendOwner {
  ownerSeasonId: number;
  ownerName: string;
  /** NFL team abbreviation, e.g. "MIA". Stable key for filtering/highlighting. */
  teamKey: string;
  teamName: string;
  conference: Conference;
  /** ESPN crest URL, or null. */
  logoEspn: string | null;
  /** Primary brand color (hex) used to color this owner's line, or null. */
  color: string | null;
  /**
   * Playoff probability percent (0..100) per week, ALIGNED to {@link OddsTrend.weeks}.
   * `null` where no snapshot exists for that week (e.g. the owner joined late /
   * a gap in the data) so the chart can break the line cleanly.
   */
  series: (number | null)[];
}

/** The full odds trend payload for the chart. */
export interface OddsTrend {
  /** The distinct weeks that have snapshots, ascending. The chart's x-axis. */
  weeks: number[];
  /** One entry per owner with a week-aligned `series`. */
  owners: OddsTrendOwner[];
}

/**
 * Load the season's playoff-odds trend: the weeks that have snapshots and, for
 * each owner, a week-aligned series of playoff probabilities.
 *
 * @returns `{ weeks: [], owners: [] }` when the season has no snapshots yet.
 */
export async function getOddsTrend(seasonId: number): Promise<OddsTrend> {
  const rows = await db
    .select({
      week: playoffOddsSnapshots.week,
      ownerSeasonId: playoffOddsSnapshots.ownerSeasonId,
      oddsPct: playoffOddsSnapshots.oddsPct,
      ownerName: owners.name,
      teamKey: nflTeams.key,
      teamName: nflTeams.name,
      conference: nflTeams.conference,
      logoEspn: nflTeams.logoEspn,
      color: nflTeams.primaryColor,
    })
    .from(playoffOddsSnapshots)
    .innerJoin(ownerSeasons, eq(playoffOddsSnapshots.ownerSeasonId, ownerSeasons.id))
    .innerJoin(owners, eq(ownerSeasons.ownerId, owners.id))
    .innerJoin(nflTeams, eq(ownerSeasons.nflTeamId, nflTeams.id))
    .where(eq(playoffOddsSnapshots.seasonId, seasonId))
    .orderBy(asc(playoffOddsSnapshots.week));

  if (rows.length === 0) return { weeks: [], owners: [] };

  // Distinct weeks, ascending — the x-axis.
  const weeks = Array.from(new Set(rows.map((r) => r.week))).sort((a, b) => a - b);
  const weekIndex = new Map(weeks.map((w, i) => [w, i]));

  // Group rows by owner, building a week-aligned (nullable) series.
  const byOwner = new Map<number, OddsTrendOwner>();
  for (const r of rows) {
    let owner = byOwner.get(r.ownerSeasonId);
    if (!owner) {
      owner = {
        ownerSeasonId: r.ownerSeasonId,
        ownerName: r.ownerName,
        teamKey: r.teamKey,
        teamName: r.teamName,
        conference: r.conference as Conference,
        logoEspn: r.logoEspn ?? null,
        color: r.color ?? null,
        series: weeks.map(() => null),
      };
      byOwner.set(r.ownerSeasonId, owner);
    }
    const idx = weekIndex.get(r.week);
    if (idx !== undefined) owner.series[idx] = Number(r.oddsPct);
  }

  // Stable display order: highest final-week odds first (most relevant lines on
  // top of the legend), then by name.
  const lastIdx = weeks.length - 1;
  const ownersList = Array.from(byOwner.values()).sort((a, b) => {
    const av = a.series[lastIdx] ?? -1;
    const bv = b.series[lastIdx] ?? -1;
    if (bv !== av) return bv - av;
    return a.ownerName.localeCompare(b.ownerName);
  });

  return { weeks, owners: ownersList };
}
