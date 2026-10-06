/**
 * Standings tiebreakers — a faithful port of the league's original R `resolve_ties`.
 *
 * Cohorts are grouped by WIN PERCENTAGE ALONE, matching the R's
 * `group_by(Win_Percentage)`. Raw win count is deliberately NOT part of the key: with
 * staggered bye weeks (and any week a matchup isn't final) owners play different numbers of
 * games, so 8-8 and 9-9 are both .500 and genuinely tied under the league rule. Keying on
 * wins as well would split them into separate cohorts and rank the 9-9 owner ahead purely
 * on raw wins, never consulting head-to-head or Points For.
 *
 * Within a cohort tied on win%, the order is resolved ITERATIVELY:
 *   1. Build the head-to-head grid among only the tied owners. An owner "wins the
 *      series" against another when it has MORE WINS THAN LOSSES against them
 *      (a split, or never having played, counts as neither).
 *   2. Count each owner's series wins (how many of the other tied owners it beat).
 *   3. If an owner is head-to-head DOMINANT — meaning it holds a winning series
 *      against EVERY other tied owner (undefeated within the group) — that owner
 *      is placed next. A single series loss eliminates the H2H advantage regardless
 *      of group size.
 *   4. Otherwise the owner with the most POINTS FOR is placed next.
 *   5. Remove that owner and repeat on the rest (the grid is recomputed each pass).
 *
 * So the chain is: win% → head-to-head dominance → Points For. Points Against is
 * kept only as an inert final fallback for an exact Points-For tie (which never
 * happens with real decimal scores), followed by ownerSeasonId for determinism.
 *
 * Pure: no DB, no I/O.
 */
import {
  DEFAULT_TIEBREAKERS,
  type MatchupResult,
  type StandingRow,
  type TiebreakerKey,
  type TiebreakerReason,
} from './types';

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
   * loss = 0), plus the game count and the exact wins/losses/ties breakdown (kept alongside
   * `credit`/`games` rather than reconstructed from them — summed credit is ambiguous past 2
   * games, e.g. 1.5 over 3 games could be 3 ties or 1 win + 1 tie + 1 loss). Owner `a` won
   * the series vs `b` iff `credit > games/2`.
   */
  h2h: Map<number, Map<number, { credit: number; games: number; wins: number; losses: number; ties: number }>>;
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

  const h2h: TiebreakerContext['h2h'] = new Map();
  const bump = (a: number, b: number, credit: number) => {
    let inner = h2h.get(a);
    if (!inner) {
      inner = new Map();
      h2h.set(a, inner);
    }
    const cur = inner.get(b) ?? { credit: 0, games: 0, wins: 0, losses: 0, ties: 0 };
    cur.credit += credit;
    cur.games += 1;
    // `credit` is always exactly 1, 0.5, or 0 for a single game (see the callers below).
    if (credit === 1) cur.wins += 1;
    else if (credit === 0) cur.losses += 1;
    else cur.ties += 1;
    inner.set(b, cur);
  };

  for (const m of results) {
    if (!m.isFinal || m.isPlayoff || m.isExhibition) continue;
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

/**
 * The exact head-to-head series tally owner `a` holds against owner `b`, from `a`'s
 * perspective. Null when they never played a countable game. Exported so a caller that
 * already knows a tie was decided by `'h2h'` can explain it with the real record (e.g.
 * "2-0") instead of just naming the rule.
 */
export function headToHeadRecord(
  ctx: TiebreakerContext,
  a: number,
  b: number,
): { wins: number; losses: number; ties: number } | null {
  const rec = ctx.h2h.get(a)?.get(b);
  if (!rec || rec.games === 0) return null;
  return { wins: rec.wins, losses: rec.losses, ties: rec.ties };
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
 * Which points key actually separated `top` from the rest of its group — the first key
 * (in configured order) where `top`'s value differs from the best of the others. Falls back
 * to the first configured key on a true exact tie (never happens with real decimal scores).
 */
function pointsReason(
  top: StandingRow,
  rest: StandingRow[],
  pointsKeys: readonly TiebreakerKey[],
): TiebreakerReason {
  if (rest.length === 0) return 'none';
  const runnerUp = bestByPoints(rest, pointsKeys);
  for (const k of pointsKeys) {
    if (k === 'pf' && top.pointsFor !== runnerUp.pointsFor) return 'pf';
    if (k === 'pa' && top.pointsAgainst !== runnerUp.pointsAgainst) return 'pa';
  }
  return pointsKeys[0] ?? 'pf';
}

/**
 * Pick the single top owner from a tied cohort, per the league rule: a head-to-head
 * dominant owner if one exists, otherwise the best by the configured points tiebreakers.
 * Also reports which rule actually decided it, for the "why is this team ranked here"
 * explanation on the playoffs page.
 */
function pickTop(
  teams: StandingRow[],
  ctx: TiebreakerContext,
  useH2h: boolean,
  pointsKeys: readonly TiebreakerKey[],
): { top: StandingRow; reason: TiebreakerReason } {
  if (useH2h) {
    const ids = teams.map((t) => t.ownerSeasonId);
    const wins = new Map(teams.map((t) => [t.ownerSeasonId, seriesWinCount(ctx, t.ownerSeasonId, ids)]));
    const maxWins = Math.max(...wins.values());
    // Dominant means holding a winning series against every other tied owner (undefeated).
    // A single series loss disqualifies H2H regardless of group size — 3-1 in a 5-team
    // group does not qualify.
    if (maxWins === teams.length - 1) {
      const dominant = teams.filter((t) => wins.get(t.ownerSeasonId) === maxWins);
      if (dominant.length === 1) return { top: dominant[0], reason: 'h2h' };
      // More than one owner is H2H-dominant (possible in a larger group) — points breaks
      // the remaining tie among just the dominant ones.
      const top = bestByPoints(dominant, pointsKeys);
      const rest = dominant.filter((t) => t.ownerSeasonId !== top.ownerSeasonId);
      return { top, reason: pointsReason(top, rest, pointsKeys) };
    }
  }
  const top = bestByPoints(teams, pointsKeys);
  const rest = teams.filter((t) => t.ownerSeasonId !== top.ownerSeasonId);
  return { top, reason: pointsReason(top, rest, pointsKeys) };
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
  return rankCohortWithReasons(cohort, ctx, order).rows;
}

/**
 * Same as {@link rankCohort}, but also reports which rule decided each placement — the data
 * behind the playoffs page's "why is this team ranked here" explanation. Kept as a separate
 * function so every other caller of `rankCohort`/`rankStandings` is unaffected.
 */
export function rankCohortWithReasons(
  cohort: StandingRow[],
  ctx: TiebreakerContext,
  order: readonly TiebreakerKey[] = DEFAULT_TIEBREAKERS,
): { rows: StandingRow[]; reasons: Map<number, TiebreakerReason> } {
  const reasons = new Map<number, TiebreakerReason>();
  if (cohort.length <= 1) {
    for (const r of cohort) reasons.set(r.ownerSeasonId, 'none');
    return { rows: [...cohort], reasons };
  }

  const useH2h = order.includes('h2h');
  const pointsKeys = order.filter((k) => k !== 'h2h');
  const remaining = [...cohort];
  const rows: StandingRow[] = [];
  while (remaining.length > 1) {
    const { top, reason } = pickTop(remaining, ctx, useH2h, pointsKeys);
    rows.push(top);
    reasons.set(top.ownerSeasonId, reason);
    remaining.splice(remaining.indexOf(top), 1);
  }
  if (remaining.length) {
    rows.push(remaining[0]);
    // Last one standing — nothing left to compare it against.
    reasons.set(remaining[0].ownerSeasonId, 'none');
  }
  return { rows, reasons };
}

/**
 * Compare two standings rows for ranking (pairwise). Best-first ordering:
 *   1. Win percentage.
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
 * 1. Sort by win percentage.
 * 2. Detect maximal cohorts of owners sharing the same win percentage.
 * 3. Order each cohort by head-to-head dominance → Points For (recursively).
 *
 * @returns A new array sorted best-first. The input is not mutated.
 */
export function rankStandings(
  rows: StandingRow[],
  ctx: TiebreakerContext,
  order: readonly TiebreakerKey[] = DEFAULT_TIEBREAKERS,
): StandingRow[] {
  return rankStandingsWithReasons(rows, ctx, order).rows;
}

/**
 * Same as {@link rankStandings}, but also reports which rule decided each tied owner's
 * placement (see {@link rankCohortWithReasons}). Used by seeding so the playoffs page can
 * explain itself; every other caller keeps using the plain {@link rankStandings}.
 */
export function rankStandingsWithReasons(
  rows: StandingRow[],
  ctx: TiebreakerContext,
  order: readonly TiebreakerKey[] = DEFAULT_TIEBREAKERS,
): { rows: StandingRow[]; reasons: Map<number, TiebreakerReason> } {
  const byRecord = [...rows].sort((a, b) => {
    if (a.winPct !== b.winPct) return b.winPct - a.winPct;
    return a.ownerSeasonId - b.ownerSeasonId;
  });

  const result: StandingRow[] = [];
  const reasons = new Map<number, TiebreakerReason>();
  let i = 0;
  while (i < byRecord.length) {
    let j = i + 1;
    while (j < byRecord.length && byRecord[j].winPct === byRecord[i].winPct) {
      j++;
    }
    const cohort = byRecord.slice(i, j);
    if (cohort.length === 1) {
      result.push(cohort[0]);
      reasons.set(cohort[0].ownerSeasonId, 'none');
    } else {
      const { rows: ranked, reasons: cohortReasons } = rankCohortWithReasons(cohort, ctx, order);
      result.push(...ranked);
      for (const [id, reason] of cohortReasons) reasons.set(id, reason);
    }
    i = j;
  }
  return { rows: result, reasons };
}
