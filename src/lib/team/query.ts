/**
 * DB-backed data for the per-team dashboard (`/my-team`).
 *
 * Everything here is derived from the same engine the standings pages use
 * (`getStandingsView` for the authoritative header/record, `getSeasonStandingsData`
 * for the per-matchup results), so a team's numbers always agree with the rest of
 * the site. No new scoring logic lives here — only per-owner shaping for charts.
 */
import { eq } from 'drizzle-orm';

import { db, owners, ownerSeasons, nflTeams } from '@/db';
import { buildTiebreakerContext, computeStandings, rankStandings } from '@/lib/standings';
import {
  getSeasonStandingsData,
  getStandingsView,
  type StandingsViewRow,
} from '@/lib/standings/query';
import { getOddsTrend } from '@/lib/odds/query';

/** One selectable team in the dropdown. */
export interface TeamDirectoryEntry {
  ownerSeasonId: number;
  ownerName: string;
  teamKey: string;
  teamName: string;
  logoEspn: string | null;
}

/** Owners assigned for a season, alphabetical by team key — for the team picker. */
export async function getTeamDirectory(seasonId: number): Promise<TeamDirectoryEntry[]> {
  const rows = await db
    .select({
      ownerSeasonId: ownerSeasons.id,
      ownerName: owners.name,
      teamKey: nflTeams.key,
      teamName: nflTeams.name,
      logoEspn: nflTeams.logoEspn,
    })
    .from(ownerSeasons)
    .innerJoin(owners, eq(ownerSeasons.ownerId, owners.id))
    .innerJoin(nflTeams, eq(ownerSeasons.nflTeamId, nflTeams.id))
    .where(eq(ownerSeasons.seasonId, seasonId));
  return rows.sort((a, b) => a.teamKey.localeCompare(b.teamKey));
}

/** One week on the team's schedule, enriched for the timeline + results table. */
export interface TeamWeek {
  week: number;
  isBye: boolean;
  /** The team's own points that week (null on a bye / unplayed week). */
  points: number | null;
  oppOwnerName: string | null;
  oppTeamKey: string | null;
  oppPoints: number | null;
  result: 'W' | 'L' | 'T' | null;
  /** Mean of every team's scored points that week — the chart's reference line. */
  leagueAvg: number | null;
  /** The team's overall league rank computed through this week (1 = first). */
  rank: number | null;
}

/** Season-long head-to-head record vs one opponent. */
export interface TeamH2H {
  oppOwnerSeasonId: number;
  oppOwnerName: string;
  oppTeamKey: string;
  wins: number;
  losses: number;
  ties: number;
}

/** Everything the `/my-team` dashboard renders for one team. */
export interface TeamDashboard {
  header: StandingsViewRow;
  stats: {
    gamesPlayed: number;
    avgScore: number | null;
    bestWeek: { week: number; points: number } | null;
    worstWeek: { week: number; points: number } | null;
    /** Population std-dev of weekly scores — lower = more consistent. */
    consistency: number | null;
    /** Single highest week (same as bestWeek.points) for the tile. */
    highScore: number | null;
  };
  weeks: TeamWeek[];
  h2h: TeamH2H[];
  /** Playoff-odds trend for this team, or null when no snapshots exist. */
  odds: { weeks: number[]; series: (number | null)[] } | null;
}

/** Population standard deviation, or null for fewer than 2 samples. */
function stddev(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Build the full per-team dashboard for one owner-season. Returns null when the
 * owner isn't found in the season's standings view (e.g. no data yet).
 */
export async function getTeamDashboard(
  seasonId: number,
  ownerSeasonId: number,
): Promise<TeamDashboard | null> {
  const [view, data, oddsTrend] = await Promise.all([
    getStandingsView(seasonId),
    getSeasonStandingsData(seasonId),
    getOddsTrend(seasonId),
  ]);

  // Authoritative header row (record, rank, PF/PA, streak, playoff tag, branding).
  let header: StandingsViewRow | null = null;
  for (const conf of ['AFC', 'NFC'] as const) {
    for (const div of ['East', 'North', 'South', 'West'] as const) {
      const found = view.byConference[conf][div].find((r) => r.ownerSeasonId === ownerSeasonId);
      if (found) header = found;
    }
  }
  if (!header) return null;

  const { entries, results, rankingOptions } = data;
  const nameById = new Map(entries.map((e) => [e.ownerSeasonId, e.ownerName]));
  const teamKeyById = new Map(entries.map((e) => [e.ownerSeasonId, e.teamKey]));

  // Regular-season, final results only.
  const reg = results.filter((r) => !r.isPlayoff && r.isFinal);
  const playedWeeks = Array.from(new Set(reg.map((r) => r.week))).sort((a, b) => a - b);

  // League average per week (mean of every scored side that week).
  const leagueAvgByWeek = new Map<number, number>();
  for (const week of playedWeeks) {
    const pts: number[] = [];
    for (const m of reg) {
      if (m.week !== week) continue;
      if (m.homePoints !== null) pts.push(m.homePoints);
      if (m.awayPoints !== null) pts.push(m.awayPoints);
    }
    if (pts.length) leagueAvgByWeek.set(week, pts.reduce((a, b) => a + b, 0) / pts.length);
  }

  // Rank-over-time: cumulative overall league rank through each played week.
  const rankByWeek = new Map<number, number>();
  for (const week of playedWeeks) {
    const through = reg.filter((r) => r.week <= week);
    const rows = computeStandings(entries, through, rankingOptions.byePointsFor);
    const ctx = buildTiebreakerContext(rows, through);
    const ranked = rankStandings(rows, ctx, rankingOptions.tiebreakers);
    const idx = ranked.findIndex((r) => r.ownerSeasonId === ownerSeasonId);
    if (idx >= 0) rankByWeek.set(week, idx + 1);
  }

  // Per-week schedule/result for this team + season-long head-to-head tallies.
  const h2hMap = new Map<number, TeamH2H>();
  const myWeekScores: number[] = [];
  const weeks: TeamWeek[] = [];

  for (const week of playedWeeks) {
    const wkGame = reg.find(
      (m) =>
        m.week === week &&
        (m.homeOwnerSeasonId === ownerSeasonId || m.awayOwnerSeasonId === ownerSeasonId),
    );

    if (!wkGame) {
      // No matchup this week → a bye.
      weeks.push({
        week,
        isBye: true,
        points: null,
        oppOwnerName: null,
        oppTeamKey: null,
        oppPoints: null,
        result: null,
        leagueAvg: leagueAvgByWeek.get(week) ?? null,
        rank: rankByWeek.get(week) ?? null,
      });
      continue;
    }

    const isHome = wkGame.homeOwnerSeasonId === ownerSeasonId;
    const myPoints = isHome ? wkGame.homePoints : wkGame.awayPoints;
    const oppId = isHome ? wkGame.awayOwnerSeasonId : wkGame.homeOwnerSeasonId;
    const oppPoints = isHome ? wkGame.awayPoints : wkGame.homePoints;

    let result: 'W' | 'L' | 'T' | null = null;
    if (myPoints !== null && oppPoints !== null) {
      result = myPoints > oppPoints ? 'W' : myPoints < oppPoints ? 'L' : 'T';
      const rec =
        h2hMap.get(oppId) ??
        ({
          oppOwnerSeasonId: oppId,
          oppOwnerName: nameById.get(oppId) ?? 'Unknown',
          oppTeamKey: teamKeyById.get(oppId) ?? '?',
          wins: 0,
          losses: 0,
          ties: 0,
        } satisfies TeamH2H);
      if (result === 'W') rec.wins += 1;
      else if (result === 'L') rec.losses += 1;
      else rec.ties += 1;
      h2hMap.set(oppId, rec);
    }
    if (myPoints !== null) myWeekScores.push(myPoints);

    weeks.push({
      week,
      isBye: false,
      points: myPoints,
      oppOwnerName: nameById.get(oppId) ?? null,
      oppTeamKey: teamKeyById.get(oppId) ?? null,
      oppPoints,
      result,
      leagueAvg: leagueAvgByWeek.get(week) ?? null,
      rank: rankByWeek.get(week) ?? null,
    });
  }

  // Derived scoring stats from the team's non-bye weekly scores.
  const scored = myWeekScores;
  const avgScore = scored.length ? round2(scored.reduce((a, b) => a + b, 0) / scored.length) : null;
  let bestWeek: { week: number; points: number } | null = null;
  let worstWeek: { week: number; points: number } | null = null;
  for (const w of weeks) {
    if (w.points === null) continue;
    if (!bestWeek || w.points > bestWeek.points) bestWeek = { week: w.week, points: w.points };
    if (!worstWeek || w.points < worstWeek.points) worstWeek = { week: w.week, points: w.points };
  }

  // This team's playoff-odds series, aligned to the odds-trend weeks.
  const oddsOwner = oddsTrend.owners.find((o) => o.ownerSeasonId === ownerSeasonId);
  const odds =
    oddsOwner && oddsTrend.weeks.length
      ? { weeks: oddsTrend.weeks, series: oddsOwner.series }
      : null;

  return {
    header,
    stats: {
      gamesPlayed: header.gamesPlayed,
      avgScore,
      bestWeek,
      worstWeek,
      consistency: scored.length ? round2(stddev(scored) ?? 0) : null,
      highScore: bestWeek?.points ?? null,
    },
    weeks,
    h2h: [...h2hMap.values()].sort((a, b) => b.wins - a.wins || a.oppTeamKey.localeCompare(b.oppTeamKey)),
    odds,
  };
}
