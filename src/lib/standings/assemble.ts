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
 *   3. **A regular-season week counts only once it is SETTLED.** `isFinal` used to mean no
 *      more than "both owners have a score", so a live DraftKings sync — the extension posts
 *      the leaderboard on every poll — published W/L off half-played lineups. The league's
 *      contest runs through Monday night, so a record shown on Sunday afternoon could still
 *      move. See {@link AssembleParams.settledWeeks}.
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
  /** Remove the opponent's own score from the average/median pool before computing it. */
  excludeOpponentScore: boolean;
}

export interface AssembleParams {
  scores: readonly ScoreRow[];
  matchups: readonly MatchupRow[];
  /** Owner-weeks treated as missed lineups (derived ∪ stored) — see `deriveForfeits`. */
  forfeits: ReadonlySet<string>;
  missedLineup: MissedLineupRule;
  regularSeasonWeeks: number;
  /**
   * Weeks whose results may be counted: every NFL game final AND the week's sync landed
   * (`computeSettledWeeks`). A regular-season matchup is `isFinal` only inside one.
   *
   * Scores arrive DURING play — the extension's Live Sync posts the leaderboard on every
   * poll and the ingest upserts `dkPoints` — so "both owners have a score" says nothing
   * about whether either lineup has finished. Gating on the week instead means a record
   * appears when it can no longer change, which for this league is after Monday night.
   *
   * Playoff rows are exempt: playoff weeks (19-22) hold no `nfl_games` rows, so they can
   * never settle, and gating them would strand the bracket.
   */
  settledWeeks: ReadonlySet<number>;
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

function mean(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function assembleMatchupResults(params: AssembleParams): AssembleResult {
  const { scores, matchups, forfeits, missedLineup, regularSeasonWeeks, settledWeeks } = params;
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
  //    Forfeits and byes are excluded so a 0 can't drag the benchmark down. Owner id is kept
  //    alongside each score so `facesFor` can additionally drop the specific opponent being
  //    judged, per `excludeOpponentScore` — step 4.
  const weekScores = new Map<number, Array<{ ownerSeasonId: number; points: number }>>();
  for (const m of matchups) {
    if (m.isPlayoff) continue;
    for (const ownerSeasonId of [m.homeOwnerSeasonId, m.awayOwnerSeasonId]) {
      const key = ownerWeekKey(ownerSeasonId, m.week);
      if (forfeits.has(key)) continue;
      const pts = pointsByOwnerWeek.get(key);
      if (pts === null || pts === undefined) continue;
      const cur = weekScores.get(m.week) ?? [];
      cur.push({ ownerSeasonId, points: pts });
      weekScores.set(m.week, cur);
    }
  }
  const leagueAverageByWeek = new Map<number, number>();
  const leagueMedianByWeek = new Map<number, number>();
  for (const [week, entries] of weekScores) {
    const values = entries.map((e) => e.points);
    if (values.length === 0) continue;
    leagueAverageByWeek.set(week, mean(values));
    leagueMedianByWeek.set(week, median(values));
  }

  // 4. Translate the season's missedLineup rule into the engine's forfeit fields.
  const applyForfeit = missedLineup.result === 'auto_loss';
  const { opponentScores, excludeOpponentScore } = missedLineup;
  /**
   * The benchmark a specific opponent faces. When `excludeOpponentScore` is on, that
   * opponent's own score is removed from the pool first — an owner must not be graded
   * against a standard that includes themselves. `opponentOwnerSeasonId` is only meaningful
   * for a single-sided forfeit; the 'both forfeit' case passes none because both sides are
   * already excluded from the pool via the forfeit check above.
   */
  const facesFor = (
    week: number,
    forfeiterPoints: number | null,
    opponentOwnerSeasonId?: number,
  ): number => {
    switch (opponentScores) {
      case 'league_average':
      case 'league_median': {
        const entries = weekScores.get(week) ?? [];
        const pool =
          excludeOpponentScore && opponentOwnerSeasonId !== undefined
            ? entries.filter((e) => e.ownerSeasonId !== opponentOwnerSeasonId)
            : entries;
        const values = pool.map((e) => e.points);
        if (values.length === 0) return 0;
        return opponentScores === 'league_average' ? mean(values) : median(values);
      }
      case 'zero':
        return 0;
      case 'actual':
        return forfeiterPoints ?? 0;
    }
  };

  const results: MatchupResult[] = matchups.map((m) => {
    const homePoints = pointsByOwnerWeek.get(ownerWeekKey(m.homeOwnerSeasonId, m.week)) ?? null;
    const awayPoints = pointsByOwnerWeek.get(ownerWeekKey(m.awayOwnerSeasonId, m.week)) ?? null;
    // Both owners scored AND the week is over. Playoffs are exempt — see `settledWeeks`.
    const isFinal =
      homePoints !== null && awayPoints !== null && (m.isPlayoff || settledWeeks.has(m.week));

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
      // Away owner is the opponent being judged — exclude their own score from the pool.
      return {
        ...base,
        forfeitBy: 'home',
        opponentFacesPoints: facesFor(m.week, homePoints, m.awayOwnerSeasonId),
      };
    }
    // Home owner is the opponent being judged — exclude their own score from the pool.
    return {
      ...base,
      forfeitBy: 'away',
      opponentFacesPoints: facesFor(m.week, awayPoints, m.homeOwnerSeasonId),
    };
  });

  return {
    results,
    pointsByOwnerWeek,
    byePointsForByOwner,
    leagueAverageByWeek,
    leagueMedianByWeek,
  };
}
