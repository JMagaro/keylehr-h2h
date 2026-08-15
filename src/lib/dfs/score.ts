/**
 * The DraftKings Classic NFL scoring engine.
 *
 * Pure: no DB, no network, no clock. Given a stat line and a rule set it returns points.
 * That makes the whole thing exhaustively unit-testable (see ./score.test.ts), which
 * matters because this is the one piece of the live pipeline with no upstream to check it
 * against until DK's official leaderboard lands at the end of the week.
 *
 * ROUNDING: intermediate sums are kept at full float precision and rounded to 2dp exactly
 * once, at the boundary. Rounding per-rule would drift — 0.04/yard on a 287-yard passer is
 * 11.48 exactly, but rounding each component first can land a cent away, and 32 owners x 9
 * slots compounds it. `formatPoints` in src/lib/utils.ts expects a 2dp-clean number.
 *
 * Everything here produces an ESTIMATE. See ./rules.ts.
 */
import type { DkScoringRules, DkSlot } from './rules';
import { DK_CLASSIC_NFL } from './rules';
import type { DstStatLine, PlayerStatLine } from './stat-line';

/** One contributing line item, for the UI breakdown and for accuracy attribution. */
export interface ScoreComponent {
  /** Stable machine key, e.g. "passYards", "bonus.recYards", "pointsAllowed". */
  key: string;
  /** Human label for the expandable per-player view, e.g. "Passing yards". */
  label: string;
  /** The underlying stat quantity (287 yards, 2 TDs, 21 points allowed). */
  quantity: number;
  /** Points contributed. May be negative. */
  points: number;
}

export interface ScoreResult {
  /** Total DK points, rounded to 2dp. */
  points: number;
  /** Non-zero contributions, in rule order. Empty when the player did nothing. */
  components: ScoreComponent[];
}

/** Round to 2 decimals without float drift (0.145 -> 0.15, not 0.14). */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Push a component only when it actually contributes, keeping breakdowns readable. */
function add(
  components: ScoreComponent[],
  key: string,
  label: string,
  quantity: number,
  points: number,
): number {
  if (quantity === 0 && points === 0) return 0;
  components.push({ key, label, quantity, points });
  return points;
}

/**
 * Score a skill-position player (QB / RB / WR / TE).
 *
 * @param line  Stat line with every field present (use `playerLine()` to build one).
 * @param rules Defaults to DK Classic NFL.
 */
export function scorePlayer(
  line: PlayerStatLine,
  rules: DkScoringRules = DK_CLASSIC_NFL,
): ScoreResult {
  const r = rules.offense;
  const components: ScoreComponent[] = [];
  let total = 0;

  total += add(components, 'passYards', 'Passing yards', line.passYards, line.passYards * r.passYardPerPoint);
  total += add(components, 'passTd', 'Passing TD', line.passTd, line.passTd * r.passTd);
  total += add(
    components,
    'passInterceptions',
    'Interception thrown',
    line.passInterceptions,
    line.passInterceptions * r.passInterception,
  );

  total += add(components, 'rushYards', 'Rushing yards', line.rushYards, line.rushYards * r.rushYardPerPoint);
  total += add(components, 'rushTd', 'Rushing TD', line.rushTd, line.rushTd * r.rushTd);

  total += add(components, 'receptions', 'Receptions', line.receptions, line.receptions * r.reception);
  total += add(components, 'recYards', 'Receiving yards', line.recYards, line.recYards * r.recYardPerPoint);
  total += add(components, 'recTd', 'Receiving TD', line.recTd, line.recTd * r.recTd);

  total += add(components, 'fumblesLost', 'Fumble lost', line.fumblesLost, line.fumblesLost * r.fumbleLost);
  total += add(components, 'returnTd', 'Return TD', line.returnTd, line.returnTd * r.returnTd);
  total += add(
    components,
    'twoPointConversions',
    '2-pt conversion',
    line.twoPointConversions,
    line.twoPointConversions * r.twoPointConversion,
  );
  total += add(
    components,
    'offensiveFumbleRecoveryTd',
    'Off. fumble recovery TD',
    line.offensiveFumbleRecoveryTd,
    line.offensiveFumbleRecoveryTd * r.offensiveFumbleRecoveryTd,
  );

  // Yardage bonuses are awarded once at the threshold, not per-yard beyond it.
  if (line.passYards >= r.bonuses.passYards.threshold) {
    total += add(components, 'bonus.passYards', '300+ passing yards', line.passYards, r.bonuses.passYards.points);
  }
  if (line.rushYards >= r.bonuses.rushYards.threshold) {
    total += add(components, 'bonus.rushYards', '100+ rushing yards', line.rushYards, r.bonuses.rushYards.points);
  }
  if (line.recYards >= r.bonuses.recYards.threshold) {
    total += add(components, 'bonus.recYards', '100+ receiving yards', line.recYards, r.bonuses.recYards.points);
  }

  return { points: round2(total), components };
}

/** Resolve the DST points-allowed tier. Tiers are ascending; first match wins. */
export function pointsAllowedPoints(
  pointsAllowed: number,
  rules: DkScoringRules = DK_CLASSIC_NFL,
): number {
  for (const tier of rules.dst.pointsAllowedTiers) {
    if (pointsAllowed <= tier.maxPoints) return tier.points;
  }
  // Unreachable: the ladder ends at Infinity. Fail loud rather than silently score 0.
  throw new Error(`No points-allowed tier matched ${pointsAllowed}`);
}

/** Score a team defense/special-teams unit. */
export function scoreDst(line: DstStatLine, rules: DkScoringRules = DK_CLASSIC_NFL): ScoreResult {
  const r = rules.dst;
  const components: ScoreComponent[] = [];
  let total = 0;

  total += add(components, 'sacks', 'Sacks', line.sacks, line.sacks * r.sack);
  total += add(components, 'interceptions', 'Interceptions', line.interceptions, line.interceptions * r.interception);
  total += add(
    components,
    'fumbleRecoveries',
    'Fumble recoveries',
    line.fumbleRecoveries,
    line.fumbleRecoveries * r.fumbleRecovery,
  );
  total += add(components, 'safeties', 'Safeties', line.safeties, line.safeties * r.safety);
  total += add(components, 'blockedKicks', 'Blocked kicks', line.blockedKicks, line.blockedKicks * r.blockedKick);
  total += add(components, 'defensiveTds', 'Defensive TD', line.defensiveTds, line.defensiveTds * r.defensiveTd);
  total += add(
    components,
    'specialTeamsTds',
    'Special teams TD',
    line.specialTeamsTds,
    line.specialTeamsTds * r.specialTeamsTd,
  );
  total += add(
    components,
    'twoPointReturns',
    '2-pt return',
    line.twoPointReturns,
    line.twoPointReturns * r.twoPointReturn,
  );

  // Always emitted, even at 0 points scored — "+10, shut out" is the headline of a DST line,
  // and a 0-point tier award is meaningful information rather than an absent stat.
  const paPoints = pointsAllowedPoints(line.pointsAllowed, rules);
  components.push({
    key: 'pointsAllowed',
    label: 'Points allowed',
    quantity: line.pointsAllowed,
    points: paPoints,
  });
  total += paPoints;

  return { points: round2(total), components };
}

/**
 * One filled roster slot handed to {@link scoreLineup}.
 *
 * `unresolved` is a first-class state, NOT a zero. A player we failed to match to the stat
 * feed must never render as 0.00 — that is indistinguishable from a genuine goose egg and
 * would quietly understate an owner's total. Callers must surface these — via `unresolvedCount`
 * on {@link LineupScore}. (A dedicated src/lib/dfs/identity.ts for DK->ESPN player matching is
 * PLANNED, not written: matching lives in scripts/dfs-selftest.ts today.)
 */
export type LineupSlotInput =
  | { slot: DkSlot; kind: 'player'; line: PlayerStatLine }
  | { slot: DkSlot; kind: 'dst'; line: DstStatLine }
  | { slot: DkSlot; kind: 'unresolved' };

export interface ScoredSlot {
  slot: DkSlot;
  /** null when the slot could not be resolved to a stat line. */
  points: number | null;
  components: ScoreComponent[];
}

export interface LineupScore {
  /** Sum of the resolved slots only, rounded to 2dp. */
  points: number;
  slots: ScoredSlot[];
  /** How many slots had no stat line. Non-zero means `points` is a floor, not a total. */
  unresolvedCount: number;
}

/**
 * Score a full lineup, tolerating unresolved slots.
 *
 * The returned `points` deliberately sums only what resolved, so a matching failure
 * understates rather than invents. `unresolvedCount` is what the UI must surface.
 */
export function scoreLineup(
  slots: LineupSlotInput[],
  rules: DkScoringRules = DK_CLASSIC_NFL,
): LineupScore {
  const scored: ScoredSlot[] = [];
  let total = 0;
  let unresolvedCount = 0;

  for (const entry of slots) {
    if (entry.kind === 'unresolved') {
      unresolvedCount += 1;
      scored.push({ slot: entry.slot, points: null, components: [] });
      continue;
    }
    const result =
      entry.kind === 'dst' ? scoreDst(entry.line, rules) : scorePlayer(entry.line, rules);
    total += result.points;
    scored.push({ slot: entry.slot, points: result.points, components: result.components });
  }

  return { points: round2(total), slots: scored, unresolvedCount };
}
