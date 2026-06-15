/**
 * Regular-season standings computation.
 *
 * Pure function: given the league's owners and all matchup results, produce a
 * W-L-T standings row (with Points For / Against, win%, and current streak)
 * for each owner. No DB, no I/O.
 *
 * Rules implemented here:
 *  - Only `isFinal` results count.
 *  - Only regular-season results count (`isPlayoff === true` is ignored).
 *  - Outcome is taken from `winnerOwnerSeasonId` when supplied (override /
 *    forfeit / explicit tie via `null`); otherwise derived from points
 *    (higher finite points wins, equal finite points is a tie).
 *  - Forfeit ("missed lineup") via `forfeitBy` + `opponentFacesPoints`: the
 *    forfeiter takes an automatic loss, while the non-forfeiting opponent plays
 *    against `opponentFacesPoints` (W if its own points >= that value) and books
 *    that value as its Points Against. See `MatchupResult` for the full rule.
 *  - Ties count as half a win in win percentage:
 *      winPct = (wins + 0.5 * ties) / gamesPlayed.
 *  - Streak reflects the most recent consecutive run of identical outcomes,
 *    ordered by week then a stable tiebreak, e.g. "W3", "L1", "T1".
 */
import type { MatchupResult, OwnerEntry, StandingRow } from './types';

/** The outcome of a single counted game from one owner's perspective. */
type Outcome = 'W' | 'L' | 'T';

/** Internal mutable accumulator for one owner while tallying results. */
interface Tally {
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
  /** Outcomes in chronological order, used to compute the current streak. */
  history: { week: number; outcome: Outcome }[];
}

/**
 * Per-side resolution of a matchup. `homePoints`/`awayPoints` are what each side
 * ACCRUES to its own Points For; `homePointsAgainst`/`awayPointsAgainst` are what
 * each side accrues to its Points Against. For a normal game these are simply the
 * mirror of each other (home's PA == away's PF), but a forfeit can break that
 * symmetry: the non-forfeiting opponent's PA is the value it "faced", not the
 * forfeiter's raw points.
 */
interface Resolved {
  homeOutcome: Outcome;
  awayOutcome: Outcome;
  homePoints: number;
  awayPoints: number;
  homePointsAgainst: number;
  awayPointsAgainst: number;
}

/**
 * Resolve a final, regular-season matchup into per-side outcomes & points.
 *
 * Returns `null` when the matchup should not be counted (not final, a playoff
 * game, or missing points with no explicit winner).
 */
function resolveOutcome(m: MatchupResult): Resolved | null {
  if (!m.isFinal || m.isPlayoff) return null;

  const homePoints = m.homePoints ?? 0;
  const awayPoints = m.awayPoints ?? 0;

  // Forfeit ("missed lineup") handling takes precedence: it overrides the normal
  // outcome and rewrites the non-forfeiting opponent's Points Against to what it
  // "faced" (see MatchupResult.forfeitBy / opponentFacesPoints).
  if (m.forfeitBy !== undefined) {
    const faces = m.opponentFacesPoints ?? 0;
    if (m.forfeitBy === 'both') {
      // Both forfeited → double loss; each faces `faces` for PA.
      return {
        homeOutcome: 'L',
        awayOutcome: 'L',
        homePoints,
        awayPoints,
        homePointsAgainst: faces,
        awayPointsAgainst: faces,
      };
    }
    // One side forfeited: it takes an auto-loss and its PA is the opponent's raw
    // points; the opponent plays against `faces` (W if its own points >= faces).
    if (m.forfeitBy === 'home') {
      const awayWins = awayPoints >= faces;
      return {
        homeOutcome: 'L',
        awayOutcome: awayWins ? 'W' : 'L',
        homePoints,
        awayPoints,
        homePointsAgainst: awayPoints,
        awayPointsAgainst: faces,
      };
    }
    // forfeitBy === 'away'
    const homeWins = homePoints >= faces;
    return {
      homeOutcome: homeWins ? 'W' : 'L',
      awayOutcome: 'L',
      homePoints,
      awayPoints,
      homePointsAgainst: faces,
      awayPointsAgainst: homePoints,
    };
  }

  // For all non-forfeit cases the two sides' Points Against simply mirror each
  // other (home faces away's points and vice-versa).
  const pa = { homePointsAgainst: awayPoints, awayPointsAgainst: homePoints };

  // Explicit winner (admin override / forfeit) is authoritative.
  if (m.winnerOwnerSeasonId !== undefined) {
    if (m.winnerOwnerSeasonId === null) {
      return { homeOutcome: 'T', awayOutcome: 'T', homePoints, awayPoints, ...pa };
    }
    if (m.winnerOwnerSeasonId === m.homeOwnerSeasonId) {
      return { homeOutcome: 'W', awayOutcome: 'L', homePoints, awayPoints, ...pa };
    }
    if (m.winnerOwnerSeasonId === m.awayOwnerSeasonId) {
      return { homeOutcome: 'L', awayOutcome: 'W', homePoints, awayPoints, ...pa };
    }
    // Winner id matches neither participant — ignore as malformed.
    return null;
  }

  // Otherwise derive from points; both sides must have a finite score.
  if (m.homePoints === null || m.awayPoints === null) return null;
  if (!Number.isFinite(m.homePoints) || !Number.isFinite(m.awayPoints)) return null;

  if (m.homePoints > m.awayPoints) {
    return { homeOutcome: 'W', awayOutcome: 'L', homePoints, awayPoints, ...pa };
  }
  if (m.homePoints < m.awayPoints) {
    return { homeOutcome: 'L', awayOutcome: 'W', homePoints, awayPoints, ...pa };
  }
  return { homeOutcome: 'T', awayOutcome: 'T', homePoints, awayPoints, ...pa };
}

/** Compute the current streak code (e.g. "W3") from a chronological history. */
function computeStreak(history: { week: number; outcome: Outcome }[]): string {
  if (history.length === 0) return '';
  // History is already chronologically ordered; walk from the end.
  const last = history[history.length - 1].outcome;
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].outcome === last) count++;
    else break;
  }
  return `${last}${count}`;
}

/**
 * Compute regular-season standings for every owner.
 *
 * @param entries  All owners in the season (one row each is returned, even for
 *                 owners with zero games played).
 * @param results  All matchup results; non-final and playoff results are
 *                 ignored automatically.
 * @returns One {@link StandingRow} per owner, in the input `entries` order.
 *          (Use the tiebreaker/seeding helpers to rank them.)
 */
export function computeStandings(
  entries: OwnerEntry[],
  results: MatchupResult[],
): StandingRow[] {
  const tallies = new Map<number, Tally>();
  for (const e of entries) {
    tallies.set(e.ownerSeasonId, {
      wins: 0,
      losses: 0,
      ties: 0,
      pointsFor: 0,
      pointsAgainst: 0,
      history: [],
    });
  }

  // Process results in a deterministic chronological order so the streak (and
  // any week-derived ordering) is stable regardless of input ordering.
  const ordered = [...results].sort(
    (a, b) =>
      a.week - b.week ||
      a.homeOwnerSeasonId - b.homeOwnerSeasonId ||
      a.awayOwnerSeasonId - b.awayOwnerSeasonId,
  );

  for (const m of ordered) {
    const resolved = resolveOutcome(m);
    if (!resolved) continue;

    const home = tallies.get(m.homeOwnerSeasonId);
    const away = tallies.get(m.awayOwnerSeasonId);
    if (!home || !away) continue; // result references an unknown owner

    applyOutcome(home, resolved.homeOutcome, m.week, resolved.homePoints, resolved.homePointsAgainst);
    applyOutcome(away, resolved.awayOutcome, m.week, resolved.awayPoints, resolved.awayPointsAgainst);
  }

  return entries.map((e) => {
    const t = tallies.get(e.ownerSeasonId)!;
    const gamesPlayed = t.wins + t.losses + t.ties;
    const winPct = gamesPlayed === 0 ? 0 : (t.wins + 0.5 * t.ties) / gamesPlayed;
    return {
      ownerSeasonId: e.ownerSeasonId,
      wins: t.wins,
      losses: t.losses,
      ties: t.ties,
      gamesPlayed,
      pointsFor: round2(t.pointsFor),
      pointsAgainst: round2(t.pointsAgainst),
      winPct,
      streak: computeStreak(t.history),
    };
  });
}

/** Apply a single resolved outcome to an owner's running tally. */
function applyOutcome(t: Tally, outcome: Outcome, week: number, pf: number, pa: number): void {
  if (outcome === 'W') t.wins++;
  else if (outcome === 'L') t.losses++;
  else t.ties++;
  t.pointsFor += pf;
  t.pointsAgainst += pa;
  t.history.push({ week, outcome });
}

/** Round to 2 decimals, matching the DB's `numeric(7,2)` score precision. */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
