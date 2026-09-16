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
 * How to compute the DST's "points allowed" figure.
 *
 * DraftKings' published rule has historically read as though it carves out points the DST
 * itself was not on the field for — most visibly a pick-six thrown by *your own* offense.
 * Neither ESPN's header score nor any free feed implements that carve-out, so we shipped the
 * honest default (`raw` = the opponent's final score) and left the alternative implementable.
 *
 * SETTLED EMPIRICALLY — `raw` IS WHAT DRAFTKINGS DOES. 2026 week 1 contained the exact case
 * that separates the two modes: **Atlanta's DST conceded 20 to Pittsburgh, and 7 of those
 * points (a defensive touchdown plus the extra point) were scored by PITTSBURGH'S DEFENSE
 * against Atlanta's offense.** Under the carve-out Atlanta allows 13 and DraftKings pays the
 * `7-13 PA` tier, +4. DraftKings' own captured stat line awarded `14-20 PA`, **+1** — the raw
 * 20. Our engine scored that DST at 5.00 against DraftKings' 5.00.
 *
 * So do not "fix" this to `exclude_scores_against_offense` on the strength of the rules page.
 * The measurement disagrees with that reading, and it was taken against DK's own numbers.
 *
 * Re-checking it is cheap and does not need a hand audit any more: Admin → Scoring reconciles
 * every captured slot against DraftKings' own stat line, and a wrong mode shows up there as a
 * DST landing exactly one tier off in a game containing a defensive or return touchdown.
 * (`npm run dfs:selftest` still will NOT catch it — that compares QB/RB/WR/TE only.)
 */
export type PointsAllowedMode = 'raw' | 'exclude_scores_against_offense';

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
    pointsAllowedMode: PointsAllowedMode;
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
    pointsAllowedMode: 'raw' as PointsAllowedMode,
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
