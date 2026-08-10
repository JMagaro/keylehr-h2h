/**
 * Season awards — the payout ledger, computed as a pure function.
 *
 * This is real money: $50 per weekly high across 18 weeks, $50 season high, $400 for most
 * regular-season points, and $2000/$1000/$300/$150 for the playoff finish. It used to live
 * inline in `scripts/import-awards.ts` welded to Drizzle, which meant none of it was testable
 * and three separate defects went unnoticed:
 *
 *  - **Ties silently dropped a payout.** `reduce((a, b) => b.points > a.points ? b : a)` keeps
 *    the FIRST maximum, and the underlying query had no ORDER BY — so on an exact tie one
 *    owner got the whole prize and *which one could change between runs of the same script*.
 *    League decision: split the pot evenly (see {@link splitCents}).
 *  - **"Most regular-season points" counted the playoffs**, because it summed every score row
 *    with no week cap. It also summed raw `scores` while the standings page derives Points For
 *    from final matchups, so the $400 could go to someone other than the owner shown on top
 *    of `/standings`. Now it takes `pointsFor` straight from the standings engine.
 *  - **Payouts came from `DEFAULT_SEASON_RULES`**, so per-season overrides set in Admin →
 *    Settings were silently ignored. Rules are passed in per season.
 *
 * Pure / no DB.
 */
import type { SeasonRules } from '@/lib/rules/schema';

/** The award types this module computes. Mirrors the `award_type` enum. */
export type AwardType =
  | 'champion'
  | 'runner_up'
  | 'third'
  | 'fourth'
  | 'weekly_high'
  | 'season_high'
  | 'most_points';

/** One computed award row, ready to persist. */
export interface ComputedAward {
  type: AwardType;
  ownerSeasonId: number;
  /** Set for `weekly_high`; null for season-long awards. */
  week: number | null;
  amountCents: number;
  /** The points behind the award, for display. Null for placement awards. */
  value: string | null;
}

/** A score row as the awards computation needs it. */
export interface AwardScoreRow {
  ownerSeasonId: number;
  week: number;
  points: number | null;
  isBye: boolean;
}

/** Final regular-season Points For per owner, from the standings engine. */
export interface AwardStandingRow {
  ownerSeasonId: number;
  pointsFor: number;
}

/** Who finished where, resolved from the playoff bracket. */
export interface BracketOutcome {
  championOwnerSeasonId: number | null;
  runnerUpOwnerSeasonId: number | null;
  thirdOwnerSeasonId: number | null;
  fourthOwnerSeasonId: number | null;
}

export interface ComputeAwardsParams {
  scores: readonly AwardScoreRow[];
  standings: readonly AwardStandingRow[];
  bracket: BracketOutcome;
  payouts: SeasonRules['payouts'];
  /** `${ownerSeasonId}:${week}` for missed lineups — never eligible for a high-score prize. */
  forfeits: ReadonlySet<string>;
  regularSeasonWeeks: number;
  /** The season's `byeWeek.eligibleForWeeklyHigh` rule. */
  byeEligibleForWeeklyHigh: boolean;
}

/**
 * Split a prize into `shares` whole cents that sum EXACTLY to the original.
 *
 * The remainder goes to the earliest shares, and callers order tied owners deterministically
 * (by ownerSeasonId), so a 3-way split of $50 is 16.67 / 16.67 / 16.66 every single run
 * rather than depending on row order.
 */
export function splitCents(totalCents: number, shares: number): number[] {
  if (shares <= 0) return [];
  const base = Math.floor(totalCents / shares);
  let remainder = totalCents - base * shares;
  return Array.from({ length: shares }, () => {
    const extra = remainder > 0 ? 1 : 0;
    if (remainder > 0) remainder -= 1;
    return base + extra;
  });
}

/** Every entry tied at the maximum of `valueOf`, ordered by ownerSeasonId. */
function topTied<T extends { ownerSeasonId: number }>(
  items: readonly T[],
  valueOf: (item: T) => number,
): T[] {
  if (items.length === 0) return [];
  // `numeric(7,2)` parsed via Number is exact at two decimals, so `===` is a valid
  // equality test for a genuine tie.
  const best = Math.max(...items.map(valueOf));
  return items
    .filter((i) => valueOf(i) === best)
    .sort((a, b) => a.ownerSeasonId - b.ownerSeasonId);
}

/** Emit one award row per tied owner, splitting the prize evenly between them. */
function awardTied(
  type: AwardType,
  tied: readonly { ownerSeasonId: number; points?: number }[],
  totalCents: number,
  week: number | null,
): ComputedAward[] {
  const amounts = splitCents(totalCents, tied.length);
  return tied.map((t, i) => ({
    type,
    ownerSeasonId: t.ownerSeasonId,
    week,
    amountCents: amounts[i],
    value: t.points === undefined ? null : t.points.toFixed(2),
  }));
}

export function computeSeasonAwards(params: ComputeAwardsParams): ComputedAward[] {
  const {
    scores,
    standings,
    bracket,
    payouts,
    forfeits,
    regularSeasonWeeks,
    byeEligibleForWeeklyHigh,
  } = params;

  const out: ComputedAward[] = [];

  // --- Placement awards (no ties possible: a bracket resolves to one owner per slot) ---
  const placements: [AwardType, number | null, number][] = [
    ['champion', bracket.championOwnerSeasonId, payouts.championCents],
    ['runner_up', bracket.runnerUpOwnerSeasonId, payouts.runnerUpCents],
    ['third', bracket.thirdOwnerSeasonId, payouts.thirdCents],
    ['fourth', bracket.fourthOwnerSeasonId, payouts.fourthCents],
  ];
  for (const [type, ownerSeasonId, amountCents] of placements) {
    if (ownerSeasonId === null) continue;
    out.push({ type, ownerSeasonId, week: null, amountCents, value: null });
  }

  // --- Weekly highs ---
  // Two independent caps apply, and we take the stricter of the two. `weeklyHighWeeks` is the
  // payout-scope knob (how many weeks carry a prize); `regularSeasonWeeks` is a hard
  // structural bound that keeps playoff weeks (19-22) out of a "regular season" award.
  const lastPrizeWeek = Math.min(payouts.weeklyHighWeeks, regularSeasonWeeks);

  const byWeek = new Map<number, { ownerSeasonId: number; points: number }[]>();
  for (const s of scores) {
    if (s.points === null) continue;
    if (s.week < 1 || s.week > lastPrizeWeek) continue;
    if (s.isBye && !byeEligibleForWeeklyHigh) continue;
    // A missed lineup cannot win a high-score prize. The 0-point floor is kept as a
    // backstop for any season whose forfeits were never flagged.
    if (forfeits.has(`${s.ownerSeasonId}:${s.week}`)) continue;
    if (s.points <= 0) continue;
    const list = byWeek.get(s.week) ?? [];
    list.push({ ownerSeasonId: s.ownerSeasonId, points: s.points });
    byWeek.set(s.week, list);
  }

  const weeklyWinners: { ownerSeasonId: number; points: number }[] = [];
  for (const week of [...byWeek.keys()].sort((a, b) => a - b)) {
    const tied = topTied(byWeek.get(week)!, (e) => e.points);
    if (tied.length === 0) continue;
    out.push(...awardTied('weekly_high', tied, payouts.weeklyHighCents, week));
    weeklyWinners.push(...tied);
  }

  // --- Season high: the best of the weekly highs ---
  const seasonHigh = topTied(weeklyWinners, (e) => e.points);
  if (seasonHigh.length > 0) {
    out.push(...awardTied('season_high', seasonHigh, payouts.seasonHighCents, null));
  }

  // --- Most regular-season points ---
  // Sourced from the standings engine, NOT a raw sum of `scores`, so this is the same number
  // shown on /standings — including its bye and forfeit conventions.
  //
  // The `> 0` filter is load-bearing: before a season has played a week every owner sits at
  // exactly 0, so without it all 32 are "tied for the lead" and the $400 gets split 32 ways.
  const mostPoints = topTied(
    standings.filter((r) => r.pointsFor > 0),
    (r) => r.pointsFor,
  );
  if (mostPoints.length > 0) {
    out.push(
      ...awardTied(
        'most_points',
        mostPoints.map((r) => ({ ownerSeasonId: r.ownerSeasonId, points: r.pointsFor })),
        payouts.mostRegularSeasonPointsCents,
        null,
      ),
    );
  }

  return out;
}
