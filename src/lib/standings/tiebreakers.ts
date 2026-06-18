/**
 * Standings tiebreakers — a faithful port of the league's original R `resolve_ties`.
 *
 * Within a group of owners tied on overall record (win%), the order is resolved
 * ITERATIVELY:
 *   1. Build the head-to-head grid among only the tied owners. An owner "wins the
 *      series" against another when it has MORE WINS THAN LOSSES against them
 *      (a split, or never having played, counts as neither).
 *   2. Count each owner's series wins (how many of the other tied owners it beat).
 *   3. If an owner is head-to-head DOMINANT — for a 2-way tie, it won the series;
 *      for a 3+-way tie, it has a winning series against MORE THAN HALF the group —
 *      that owner is placed next.
 *   4. Otherwise the owner with the most POINTS FOR is placed next.
 *   5. Remove that owner and repeat on the rest (the grid is recomputed each pass).
 *
 * So the chain is: record → head-to-head dominance → Points For. Points Against is
 * kept only as an inert final fallback for an exact Points-For tie (which never
 * happens with real decimal scores), followed by ownerSeasonId for determinism.
 *
 * Pure: no DB, no I/O.
 */
import { DEFAULT_TIEBREAKERS, type MatchupResult, type StandingRow, type TiebreakerKey } from './types';

/**
 * Context needed to compare standings rows. Built once via
 * {@link buildTiebreakerContext} and reused across a sort.
 */
export interface TiebreakerContext {
  /** Standings row by ownerSeasonId. */
  rows: Map<number, StandingRow>;
  /**
   * Head-to-head per ordered pair: `h2h.get(a)?.get(b)` is the win-credit owner `a`
   * earned against owner `b` across counted regular-season games (win = 1, tie = 0.5,
   * loss = 0), plus the game count. Owner `a` won the series vs `b` iff `credit > games/2`.
   */
  h2h: Map<number, Map<number, { credit: number; games: number }>>;
}

/**
 * Build a reusable tiebreaker context from standings rows and the raw results.
 * Only final, regular-season results contribute to head-to-head.
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

/** True when owner `a` has a winning head-to-head SERIES against owner `b`. */
function wonSeries(ctx: TiebreakerContext, a: number, b: number): boolean {
  const rec = ctx.h2h.get(a)?.get(b);
  if (!rec || rec.games === 0) return false;
  return rec.credit > rec.games / 2; // more wins than losses
}

/** How many owners in `cohortIds` that `owner` has a winning series against. */
function seriesWinCount(ctx: TiebreakerContext, owner: number, cohortIds: number[]): number {
  let n = 0;
  for (const opp of cohortIds) {
    if (opp === owner) continue;
    if (wonSeries(ctx, owner, opp)) n += 1;
  }
  return n;
}

/**
 * Compare two rows by the configured POINTS tiebreakers (the non-h2h keys, in order):
 * `pf` = higher first, `pa` = lower first; then ownerSeasonId ascending. Negative when
 * `a` ranks ahead. The pf/pa order is taken from the season's rules — never hardcoded.
 */
function comparePoints(a: StandingRow, b: StandingRow, pointsKeys: readonly TiebreakerKey[]): number {
  for (const k of pointsKeys) {
    if (k === 'pf' && a.pointsFor !== b.pointsFor) return b.pointsFor - a.pointsFor;
    if (k === 'pa' && a.pointsAgainst !== b.pointsAgainst) return a.pointsAgainst - b.pointsAgainst;
  }
  return a.ownerSeasonId - b.ownerSeasonId;
}

function bestByPoints(teams: StandingRow[], pointsKeys: readonly TiebreakerKey[]): StandingRow {
  return teams.reduce((best, t) => (comparePoints(t, best, pointsKeys) < 0 ? t : best));
}

/**
 * Pick the single top owner from a tied cohort, per the league rule: a head-to-head
 * dominant owner if one exists, otherwise the best by the configured points tiebreakers.
 */
function pickTop(
  teams: StandingRow[],
  ctx: TiebreakerContext,
  useH2h: boolean,
  pointsKeys: readonly TiebreakerKey[],
): StandingRow {
  if (useH2h) {
    const ids = teams.map((t) => t.ownerSeasonId);
    const wins = new Map(teams.map((t) => [t.ownerSeasonId, seriesWinCount(ctx, t.ownerSeasonId, ids)]));
    const maxWins = Math.max(...wins.values());
    const totalWins = [...wins.values()].reduce((s, n) => s + n, 0);
    // 2-way tie: dominant means one owner actually won the series (maxWins > total/2 = 0.5).
    // 3+-way tie: dominant means a winning series against more than half the group.
    const threshold = teams.length === 2 ? totalWins / 2 : teams.length / 2;
    if (maxWins > threshold) {
      const dominant = teams.filter((t) => wins.get(t.ownerSeasonId) === maxWins);
      // Practically unique; if not, fall back to the points tiebreakers among them.
      return bestByPoints(dominant, pointsKeys);
    }
  }
  return bestByPoints(teams, pointsKeys);
}

/**
 * Order a tied cohort (all sharing the same overall record) by recursively selecting
 * the top owner (head-to-head dominant, else best by the configured points tiebreakers),
 * removing it, and repeating. Mirrors the R `resolve_ties`. Returns a new array,
 * best-first. The tiebreaker order comes from the season's rules — nothing is hardcoded.
 */
export function rankCohort(
  cohort: StandingRow[],
  ctx: TiebreakerContext,
  order: readonly TiebreakerKey[] = DEFAULT_TIEBREAKERS,
): StandingRow[] {
  const useH2h = order.includes('h2h');
  const pointsKeys = order.filter((k) => k !== 'h2h');
  const remaining = [...cohort];
  const out: StandingRow[] = [];
  while (remaining.length > 1) {
    const top = pickTop(remaining, ctx, useH2h, pointsKeys);
    out.push(top);
    remaining.splice(remaining.indexOf(top), 1);
  }
  if (remaining.length) out.push(remaining[0]);
  return out;
}

/**
 * Compare two standings rows for ranking (pairwise). Best-first ordering:
 *   1. Overall record (win% then wins).
 *   2. Head-to-head series winner (when the two actually played and one won).
 *   3. Points For (higher), then Points Against (lower), then ownerSeasonId.
 *
 * Returns negative when `a` ranks ahead, positive when `b` ranks ahead. The `group`
 * and `order` params are accepted for backward compatibility; multi-way ties should
 * be resolved with {@link rankStandings} (the recursive league rule), not pairwise.
 */
export function compareForStandings(
  a: StandingRow,
  b: StandingRow,
  ctx: TiebreakerContext,
  _group?: Iterable<number>,
  order: readonly TiebreakerKey[] = DEFAULT_TIEBREAKERS,
): number {
  if (a.winPct !== b.winPct) return b.winPct - a.winPct;
  if (a.wins !== b.wins) return b.wins - a.wins;

  if (order.includes('h2h')) {
    const aWon = wonSeries(ctx, a.ownerSeasonId, b.ownerSeasonId);
    const bWon = wonSeries(ctx, b.ownerSeasonId, a.ownerSeasonId);
    if (aWon !== bWon) return aWon ? -1 : 1;
  }
  if (a.pointsFor !== b.pointsFor) return b.pointsFor - a.pointsFor;
  if (a.pointsAgainst !== b.pointsAgainst) return a.pointsAgainst - b.pointsAgainst;
  return a.ownerSeasonId - b.ownerSeasonId;
}

/**
 * Rank a list of standings rows, resolving multi-way ties via the league's recursive
 * rule (see {@link rankCohort}).
 *
 * 1. Sort by overall record (win% then wins).
 * 2. Detect maximal cohorts of owners sharing the same record.
 * 3. Order each cohort by head-to-head dominance → Points For (recursively).
 *
 * @returns A new array sorted best-first. The input is not mutated.
 */
export function rankStandings(
  rows: StandingRow[],
  ctx: TiebreakerContext,
  order: readonly TiebreakerKey[] = DEFAULT_TIEBREAKERS,
): StandingRow[] {
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
    if (cohort.length === 1) result.push(cohort[0]);
    else result.push(...rankCohort(cohort, ctx, order));
    i = j;
  }
  return result;
}
