/**
 * Standings tiebreakers.
 *
 * Implements the league's STRICT tiebreaker order:
 *   1. Head-to-head record among the tied owners
 *   2. Points For (higher is better)
 *   3. Points Against (lower is better)
 *   4. Deterministic final fallback: ownerSeasonId ascending (so sorts are
 *      always stable and reproducible).
 *
 * Step 1 is applied as a *group* tiebreaker: when more than two owners are
 * tied, head-to-head is each owner's win% in games played ONLY against the
 * other members of the tied group (a "mini round-robin"). For a 2-way tie this
 * reduces to the direct head-to-head record. This is computed first by overall
 * record (wins/win%), and head-to-head is only consulted between owners whose
 * overall record is equal.
 *
 * Pure: no DB, no I/O.
 */
import { DEFAULT_TIEBREAKERS, type MatchupResult, type StandingRow, type TiebreakerKey } from './types';

/**
 * Context needed to compare two standings rows. Built once via
 * {@link buildTiebreakerContext} and reused across all comparisons in a sort.
 */
export interface TiebreakerContext {
  /** Standings row by ownerSeasonId. */
  rows: Map<number, StandingRow>;
  /**
   * Head-to-head win value per ordered pair: `h2h.get(a)?.get(b)` is the sum of
   * win-credit owner `a` earned against owner `b` across all counted regular-
   * season games (win = 1, tie = 0.5, loss = 0), plus the game count.
   */
  h2h: Map<number, Map<number, { credit: number; games: number }>>;
}

/**
 * Build a reusable tiebreaker context from standings rows and the raw results.
 *
 * Only final, regular-season results contribute to head-to-head, mirroring
 * {@link computeStandings}. Explicit `winnerOwnerSeasonId` (override/forfeit)
 * is honored; otherwise the winner is derived from points.
 */
export function buildTiebreakerContext(
  rows: StandingRow[],
  results: MatchupResult[],
): TiebreakerContext {
  const rowMap = new Map<number, StandingRow>();
  for (const r of rows) rowMap.set(r.ownerSeasonId, r);

  const h2h = new Map<number, Map<number, { credit: number; games: number }>>();
  const bump = (a: number, b: number, credit: number) => {
    let inner = h2h.get(a);
    if (!inner) {
      inner = new Map();
      h2h.set(a, inner);
    }
    const cur = inner.get(b) ?? { credit: 0, games: 0 };
    cur.credit += credit;
    cur.games += 1;
    inner.set(b, cur);
  };

  for (const m of results) {
    if (!m.isFinal || m.isPlayoff) continue;
    const a = m.homeOwnerSeasonId;
    const b = m.awayOwnerSeasonId;
    if (!rowMap.has(a) || !rowMap.has(b)) continue;

    let homeCredit: number; // owner `a` credit; away credit is 1 - homeCredit
    if (m.winnerOwnerSeasonId !== undefined) {
      if (m.winnerOwnerSeasonId === null) homeCredit = 0.5;
      else if (m.winnerOwnerSeasonId === a) homeCredit = 1;
      else if (m.winnerOwnerSeasonId === b) homeCredit = 0;
      else continue; // malformed
    } else {
      if (m.homePoints === null || m.awayPoints === null) continue;
      if (!Number.isFinite(m.homePoints) || !Number.isFinite(m.awayPoints)) continue;
      if (m.homePoints > m.awayPoints) homeCredit = 1;
      else if (m.homePoints < m.awayPoints) homeCredit = 0;
      else homeCredit = 0.5;
    }
    bump(a, b, homeCredit);
    bump(b, a, 1 - homeCredit);
  }

  return { rows: rowMap, h2h };
}

/** Head-to-head win% of `owner` against the supplied set of opponents. */
function h2hWinPct(
  ctx: TiebreakerContext,
  owner: number,
  opponents: Iterable<number>,
): { pct: number; games: number } {
  const inner = ctx.h2h.get(owner);
  let credit = 0;
  let games = 0;
  if (inner) {
    for (const opp of opponents) {
      if (opp === owner) continue;
      const rec = inner.get(opp);
      if (rec) {
        credit += rec.credit;
        games += rec.games;
      }
    }
  }
  return { pct: games === 0 ? 0 : credit / games, games };
}

/**
 * Compare two standings rows for ranking, applying the full tiebreaker chain.
 *
 * Returns a negative number when `a` should rank ahead of `b`, positive when
 * `b` should rank ahead, and 0 only when truly indistinguishable (which cannot
 * happen here because of the ownerSeasonId fallback).
 *
 * Ordering, best-first:
 *   1. Overall record: higher win% first; if equal, more wins first.
 *   2. Head-to-head: higher head-to-head win% *within the group being ranked*
 *      first (the group defaults to {a, b} for a pairwise comparison; pass a
 *      larger group via {@link compareForStandings}'s `group` to resolve
 *      multi-way ties as a mini round-robin).
 *   3. Points For: higher first.
 *   4. Points Against: lower first.
 *   5. ownerSeasonId: ascending (deterministic stable fallback).
 *
 * @param group Optional set of ownerSeasonIds defining the tied cohort for the
 *              head-to-head step. When omitted, the head-to-head is computed
 *              between just `a` and `b`.
 */
export function compareForStandings(
  a: StandingRow,
  b: StandingRow,
  ctx: TiebreakerContext,
  group?: Iterable<number>,
  order: readonly TiebreakerKey[] = DEFAULT_TIEBREAKERS,
): number {
  // 1. Overall record always comes first (this is the standings order itself, not
  //    a configurable tiebreaker).
  if (a.winPct !== b.winPct) return b.winPct - a.winPct;
  if (a.wins !== b.wins) return b.wins - a.wins;

  // 2. Configured tiebreaker steps, applied in the season's order.
  const cohort = group ? [...group] : [a.ownerSeasonId, b.ownerSeasonId];
  for (const key of order) {
    const d = compareByKey(key, a, b, ctx, cohort);
    if (d !== 0) return d;
  }

  // 3. Deterministic fallback so sorts are always stable and reproducible.
  return a.ownerSeasonId - b.ownerSeasonId;
}

/**
 * Compare two rows by ONE tiebreaker step. Returns a negative/positive number when
 * decisive, or 0 ("not applicable") to fall through to the next step.
 */
function compareByKey(
  key: TiebreakerKey,
  a: StandingRow,
  b: StandingRow,
  ctx: TiebreakerContext,
  cohort: number[],
): number {
  switch (key) {
    case 'h2h': {
      // Head-to-head within the tied cohort — only decisive when BOTH owners
      // actually have games within the cohort; otherwise not applicable.
      const aH2h = h2hWinPct(ctx, a.ownerSeasonId, cohort);
      const bH2h = h2hWinPct(ctx, b.ownerSeasonId, cohort);
      if (aH2h.games > 0 && bH2h.games > 0 && aH2h.pct !== bH2h.pct) {
        return bH2h.pct - aH2h.pct;
      }
      return 0;
    }
    case 'pf': // Points For (higher first).
      return a.pointsFor !== b.pointsFor ? b.pointsFor - a.pointsFor : 0;
    case 'pa': // Points Against (lower first).
      return a.pointsAgainst !== b.pointsAgainst ? a.pointsAgainst - b.pointsAgainst : 0;
  }
}

/**
 * Rank a list of standings rows, resolving multi-way ties correctly.
 *
 * The algorithm:
 *  1. Sort by overall record (win% then wins).
 *  2. Detect maximal cohorts of owners sharing the same overall record.
 *  3. Within each cohort, order by head-to-head record *among that cohort*,
 *     then Points For, then Points Against, then ownerSeasonId.
 *
 * This guarantees the head-to-head step uses the true tied group (the NFL's
 * "sweep" semantics) rather than only pairwise comparisons, which can be
 * non-transitive for 3+ teams.
 *
 * @returns A new array sorted best-first. The input is not mutated.
 */
export function rankStandings(
  rows: StandingRow[],
  ctx: TiebreakerContext,
  order: readonly TiebreakerKey[] = DEFAULT_TIEBREAKERS,
): StandingRow[] {
  // Group by identical overall record.
  const byRecord = [...rows].sort((a, b) => {
    if (a.winPct !== b.winPct) return b.winPct - a.winPct;
    if (a.wins !== b.wins) return b.wins - a.wins;
    return a.ownerSeasonId - b.ownerSeasonId;
  });

  const result: StandingRow[] = [];
  let i = 0;
  while (i < byRecord.length) {
    let j = i + 1;
    while (
      j < byRecord.length &&
      byRecord[j].winPct === byRecord[i].winPct &&
      byRecord[j].wins === byRecord[i].wins
    ) {
      j++;
    }
    const cohort = byRecord.slice(i, j);
    if (cohort.length === 1) {
      result.push(cohort[0]);
    } else {
      const cohortIds = cohort.map((r) => r.ownerSeasonId);
      const sorted = [...cohort].sort((a, b) => compareForStandings(a, b, ctx, cohortIds, order));
      result.push(...sorted);
    }
    i = j;
  }
  return result;
}
