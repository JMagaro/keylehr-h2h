/**
 * Assemble raw `scores` + `matchups` rows into the `MatchupResult[]` the pure standings
 * engine consumes.
 *
 * This logic used to live welded to Drizzle inside `getSeasonStandingsData`, which meant the
 * whole forfeit / bye / league-average-vs-median chain — the part of the system that decides
 * wins, Points Against and ultimately playoff seeds — could not be unit-tested at all. It is
 * pure here: callers do the I/O and hand in plain rows.
 *
 * Two behaviors differ from the original inline version, both deliberate:
 *
 *   1. **Byes are reconciled against the schedule** rather than trusted from `scores.isBye`.
 *      An owner with a regular-season matchup that week was not on a bye, whatever the column
 *      says. See {@link isEffectiveBye}.
 *   2. **A derived forfeit with no `scores` row is scored as 0** rather than left unscored.
 *      Previously such a matchup had `isFinal = false` and was dropped entirely — which
 *      denied the opponent a win they were owed AND changed their games-played, which in turn
 *      feeds the win% tiebreaker cohorts. An owner who never submits a lineup must lose, not
 *      erase the game.
 *
 * Pure / no DB.
 */
import {
  isEffectiveBye,
  buildPlayingSet,
  ownerWeekKey,
  type MatchupRow,
  type ScoreRow,
} from './forfeit-derive';
import type { MatchupResult } from './types';

/** The season's missed-lineup rule, as stored in `seasons.rules`. */
export interface MissedLineupRule {
  result: 'auto_loss' | 'none';
  opponentScores: 'league_average' | 'league_median' | 'zero' | 'actual';
}

export interface AssembleParams {
  scores: readonly ScoreRow[];
  matchups: readonly MatchupRow[];
  /** Owner-weeks treated as missed lineups (derived ∪ stored) — see `deriveForfeits`. */
  forfeits: ReadonlySet<string>;
  missedLineup: MissedLineupRule;
  regularSeasonWeeks: number;
}

export interface AssembleResult {
  results: MatchupResult[];
  /** `${ownerSeasonId}:${week}` → points; null when bye or unscored. */
  pointsByOwnerWeek: Map<string, number | null>;
  /** Per-owner sum of bye-week points, for the `byeWeek.countsTowardPointsFor` rule. */
  byePointsForByOwner: Map<number, number>;
  /** Per-week league mean of counted scores (forfeits and byes excluded). */
  leagueAverageByWeek: Map<number, number>;
  /** Per-week league median of counted scores (forfeits and byes excluded). */
  leagueMedianByWeek: Map<number, number>;
}

/** Median of a non-empty list. Even counts average the two middle values. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function assembleMatchupResults(params: AssembleParams): AssembleResult {
  const { scores, matchups, forfeits, missedLineup, regularSeasonWeeks } = params;
  const playing = buildPlayingSet(matchups);

  // 1. Scores → per-owner-week points, with byes reconciled against the schedule.
  const pointsByOwnerWeek = new Map<string, number | null>();
  const byePointsForByOwner = new Map<number, number>();
  for (const s of scores) {
    const key = ownerWeekKey(s.ownerSeasonId, s.week);
    const bye = isEffectiveBye({
      storedIsBye: s.isBye,
      ownerSeasonId: s.ownerSeasonId,
      week: s.week,
      regularSeasonWeeks,
      playing,
    });
    pointsByOwnerWeek.set(key, bye || s.dkPoints === null ? null : s.dkPoints);
    if (bye && s.dkPoints !== null) {
      byePointsForByOwner.set(
        s.ownerSeasonId,
        (byePointsForByOwner.get(s.ownerSeasonId) ?? 0) + s.dkPoints,
      );
    }
  }

  // 2. A derived forfeit with no score row still played (and lost) — score it 0 so the
  //    matchup is final and the opponent gets the win the league rule owes them.
  for (const key of forfeits) {
    if (!playing.has(key)) continue;
    const existing = pointsByOwnerWeek.get(key);
    if (existing === undefined || existing === null) pointsByOwnerWeek.set(key, 0);
  }

  // 3. Per-week league scores → the average / median a forfeit's opponent faces.
  //    Forfeits and byes are excluded so a 0 can't drag the benchmark down.
  const weekScores = new Map<number, number[]>();
  for (const m of matchups) {
    if (m.isPlayoff) continue;
    for (const ownerSeasonId of [m.homeOwnerSeasonId, m.awayOwnerSeasonId]) {
      const key = ownerWeekKey(ownerSeasonId, m.week);
      if (forfeits.has(key)) continue;
      const pts = pointsByOwnerWeek.get(key);
      if (pts === null || pts === undefined) continue;
      const cur = weekScores.get(m.week) ?? [];
      cur.push(pts);
      weekScores.set(m.week, cur);
    }
  }
  const leagueAverageByWeek = new Map<number, number>();
  const leagueMedianByWeek = new Map<number, number>();
  for (const [week, values] of weekScores) {
    if (values.length === 0) continue;
    leagueAverageByWeek.set(week, values.reduce((a, b) => a + b, 0) / values.length);
    leagueMedianByWeek.set(week, median(values));
  }

  // 4. Translate the season's missedLineup rule into the engine's forfeit fields.
  const applyForfeit = missedLineup.result === 'auto_loss';
  const { opponentScores } = missedLineup;
  const facesFor = (week: number, forfeiterPoints: number | null): number => {
    switch (opponentScores) {
      case 'league_average':
        return leagueAverageByWeek.get(week) ?? 0;
      case 'league_median':
        return leagueMedianByWeek.get(week) ?? 0;
      case 'zero':
        return 0;
      case 'actual':
        return forfeiterPoints ?? 0;
    }
  };

  const results: MatchupResult[] = matchups.map((m) => {
    const homePoints = pointsByOwnerWeek.get(ownerWeekKey(m.homeOwnerSeasonId, m.week)) ?? null;
    const awayPoints = pointsByOwnerWeek.get(ownerWeekKey(m.awayOwnerSeasonId, m.week)) ?? null;
    const isFinal = homePoints !== null && awayPoints !== null;

    const base: MatchupResult = {
      week: m.week,
      isPlayoff: m.isPlayoff,
      isFinal,
      homeOwnerSeasonId: m.homeOwnerSeasonId,
      awayOwnerSeasonId: m.awayOwnerSeasonId,
      homePoints,
      awayPoints,
    };

    // 'actual' means "no special handling" — the forfeiter's own points stand.
    if (!applyForfeit || m.isPlayoff || !isFinal || opponentScores === 'actual') return base;

    const homeForfeit = forfeits.has(ownerWeekKey(m.homeOwnerSeasonId, m.week));
    const awayForfeit = forfeits.has(ownerWeekKey(m.awayOwnerSeasonId, m.week));
    if (!homeForfeit && !awayForfeit) return base;

    if (homeForfeit && awayForfeit) {
      return { ...base, forfeitBy: 'both', opponentFacesPoints: facesFor(m.week, null) };
    }
    if (homeForfeit) {
      return { ...base, forfeitBy: 'home', opponentFacesPoints: facesFor(m.week, homePoints) };
    }
    return { ...base, forfeitBy: 'away', opponentFacesPoints: facesFor(m.week, awayPoints) };
  });

  return {
    results,
    pointsByOwnerWeek,
    byePointsForByOwner,
    leagueAverageByWeek,
    leagueMedianByWeek,
  };
}
