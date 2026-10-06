/**
 * DraftKings Classic NFL scoring rules, expressed as data rather than code.
 *
 * WHY THIS FILE IS DATA: the live page recomputes DraftKings points from a public NFL
 * stat feed (ESPN) because DK's own scoring API is authenticated — see docs/DRAFTKINGS.md.
 * Keeping the rule set as a frozen object means it can be diffed against DK's published
 * rules page by eye, unit-tested exhaustively, and corrected in one place when DK changes
 * a value. No scoring arithmetic lives here; see ./score.ts.
 *
 * Roster shape is confirmed against DK's own PUBLIC rules endpoint (no auth required):
 *   GET https://api.draftkings.com/lineups/v1/gametypes/1/rules?format=json
 *     -> gameTypeName "Classic", salaryCap.maxValue 50000, allowLateSwap true,
 *        lineupTemplate [QB, RB, RB, WR, WR, WR, TE, FLEX, DST]
 * Note there is NO kicker in DK Classic NFL.
 *
 * Anything derived from these numbers is an ESTIMATE. The authoritative score for a week
 * is always the DK contest leaderboard, ingested via src/lib/scores/ingest.ts.
 */

/**
 * How "points allowed" is computed (in `espn-extract.ts`, not here — this type exists so the
 * rule is documented next to the numbers it depends on).
 *
 * It is NOT simply the opponent's final score. DraftKings excludes exactly the touchdown
 * — not any PAT/2pt try that follows it — when the OPPONENT's defense scores off a turnover
 * (an interception or fumble return) against this team's OFFENSE. A punt/kickoff return TD is
 * not excluded: that is this team's special-teams coverage failing, which points-allowed is
 * supposed to capture.
 *
 * An earlier version of this comment claimed the opposite (`raw`, no exclusion at all) from a
 * single 2026-week-1 case: Atlanta conceded 20 to Pittsburgh, 7 of which came from a Pittsburgh
 * defensive TD + made PAT, and DraftKings' captured line showed `14-20 PA`. That case never
 * actually distinguished the two theories — 20 minus just the 6-point TD is still 14, the same
 * tier as raw 20 — so it was mistakenly read as settling on `raw`. Two more cases (weeks 3 and
 * 4, each a different team) showed DraftKings landing one tier BELOW raw, and re-deriving the
 * tier with the TD-only exclusion matches DraftKings exactly in all three games, including the
 * original one. That is the rule implemented now.
 *
 * Re-checking it is cheap and does not need a hand audit: Admin → Scoring reconciles every
 * captured slot against DraftKings' own stat line, and a wrong exclusion shows up there as a
 * DST landing exactly one tier off in a game containing a defensive or return touchdown.
 * (`npm run dfs:selftest` still will NOT catch it — that compares QB/RB/WR/TE only.)
 */

/** One row of the DST points-allowed ladder. `maxPoints` is inclusive. */
export interface PointsAllowedTier {
  /** Upper bound of the tier, inclusive. `Infinity` for the final catch-all row. */
  maxPoints: number;
  points: number;
}

/** A yardage bonus: award `points` once a player reaches `threshold` yards. */
export interface YardageBonus {
  threshold: number;
  points: number;
}

export interface DkScoringRules {
  /** Offensive/skill-position scoring. */
  offense: {
    passYardPerPoint: number;
    passTd: number;
    passInterception: number;
    rushYardPerPoint: number;
    rushTd: number;
    reception: number;
    recYardPerPoint: number;
    recTd: number;
    fumbleLost: number;
    /** Punt / kickoff / FG return TD, credited to the returning player. */
    returnTd: number;
    /** 2-point conversion, whether passed, rushed, or caught. */
    twoPointConversion: number;
    offensiveFumbleRecoveryTd: number;
    bonuses: {
      passYards: YardageBonus;
      rushYards: YardageBonus;
      recYards: YardageBonus;
    };
  };
  /** Defense/special-teams (DST) scoring. */
  dst: {
    sack: number;
    interception: number;
    fumbleRecovery: number;
    safety: number;
    blockedKick: number;
    /** Interception-return and fumble-return TDs. */
    defensiveTd: number;
    /** Punt / kickoff / blocked-kick return TDs, credited to the DST unit. */
    specialTeamsTd: number;
    /** 2-point conversion or extra-point return by the defense. */
    twoPointReturn: number;
    /** Ordered ascending by `maxPoints`; first match wins. */
    pointsAllowedTiers: readonly PointsAllowedTier[];
  };
}

/**
 * DraftKings Classic NFL, current as of the 2026 season.
 *
 * Yardage is expressed as points-per-yard (DK publishes it as "1 point per 25 passing
 * yards", i.e. 0.04) so the engine never has to divide.
 */
export const DK_CLASSIC_NFL: DkScoringRules = Object.freeze({
  offense: Object.freeze({
    passYardPerPoint: 0.04, // 1 pt / 25 yds
    passTd: 4,
    passInterception: -1,
    rushYardPerPoint: 0.1, // 1 pt / 10 yds
    rushTd: 6,
    reception: 1, // full PPR
    recYardPerPoint: 0.1, // 1 pt / 10 yds
    recTd: 6,
    fumbleLost: -1,
    returnTd: 6,
    twoPointConversion: 2,
    offensiveFumbleRecoveryTd: 6,
    bonuses: Object.freeze({
      passYards: Object.freeze({ threshold: 300, points: 3 }),
      rushYards: Object.freeze({ threshold: 100, points: 3 }),
      recYards: Object.freeze({ threshold: 100, points: 3 }),
    }),
  }),
  dst: Object.freeze({
    sack: 1,
    interception: 2,
    fumbleRecovery: 2,
    safety: 2,
    blockedKick: 2,
    defensiveTd: 6,
    specialTeamsTd: 6,
    twoPointReturn: 2,
    pointsAllowedTiers: Object.freeze([
      { maxPoints: 0, points: 10 },
      { maxPoints: 6, points: 7 },
      { maxPoints: 13, points: 4 },
      { maxPoints: 20, points: 1 },
      { maxPoints: 27, points: 0 },
      { maxPoints: 34, points: -1 },
      { maxPoints: Infinity, points: -4 },
    ] as const),
  }),
}) as DkScoringRules;

/**
 * DraftKings Classic salary cap. Confirmed against the public gametype rules endpoint
 * (`salaryCap.maxValue`). Re-exported by src/lib/draftkings/draftables.ts for the
 * lineup builder, which was its original home.
 */
export const DK_CLASSIC_SALARY_CAP = 50_000;

/** The nine DK Classic roster slots, in DK's own `lineupTemplate` order. */
export const DK_CLASSIC_SLOTS = [
  'QB',
  'RB',
  'RB',
  'WR',
  'WR',
  'WR',
  'TE',
  'FLEX',
  'DST',
] as const;

export type DkSlot = (typeof DK_CLASSIC_SLOTS)[number];
