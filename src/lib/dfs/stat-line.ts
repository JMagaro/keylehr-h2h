/**
 * Source-agnostic stat lines — the input contract for the DraftKings scoring engine.
 *
 * These field names deliberately mirror DRAFTKINGS' RULES, not any particular provider's
 * JSON. ESPN is the live source today (see ./sources/espn-extract.ts), but Sleeper is a
 * useful after-the-fact reconciler for the handful of stats ESPN buries in play text, and
 * a future provider should be able to feed the same engine without touching ./score.ts.
 *
 * Every field is a plain non-negative count except where a rule is negative (fumbles,
 * interceptions), which the RULES handle — the stat line itself is always "how many".
 * Missing data must be 0, never null: a null would be indistinguishable from a real zero
 * and the engine has no way to signal "unknown". Callers that cannot resolve a player at
 * all should omit the player and surface it as unresolved rather than pass an empty line.
 */

/** A skill-position player's stat line (QB / RB / WR / TE). */
export interface PlayerStatLine {
  passYards: number;
  passTd: number;
  /** Interceptions THROWN (a negative rule). Not defensive interceptions. */
  passInterceptions: number;
  rushYards: number;
  rushTd: number;
  receptions: number;
  recYards: number;
  recTd: number;
  /** Fumbles LOST, not total fumbles — DK only penalises lost ones. */
  fumblesLost: number;
  /** Punt / kickoff / FG return TDs by this player. */
  returnTd: number;
  /** 2-point conversions passed, rushed, or caught — DK pays 2 for all three. */
  twoPointConversions: number;
  /** Recovering one's own team's offensive fumble in the end zone. Vanishingly rare. */
  offensiveFumbleRecoveryTd: number;
}

/** A team defense/special-teams unit's stat line. */
export interface DstStatLine {
  sacks: number;
  /** Interceptions CAUGHT by this defense. */
  interceptions: number;
  /** Opponent fumbles recovered by this defense. */
  fumbleRecoveries: number;
  safeties: number;
  /** Blocked punts / FGs / XPs that did NOT result in a touchdown. */
  blockedKicks: number;
  /**
   * Interception-return and fumble-return touchdowns.
   *
   * CAUTION when extracting from ESPN: the team-level `defensiveTouchdowns` stat already
   * includes interception-return TDs, so summing it with a `scoringPlays` classification
   * double-counts. See ./sources/espn-extract.ts.
   */
  defensiveTds: number;
  /** Punt / kickoff / blocked-kick return touchdowns credited to the unit. */
  specialTeamsTds: number;
  /** Defensive 2-point conversion or extra-point return. Extremely rare. */
  twoPointReturns: number;
  /** Points surrendered, per the configured `pointsAllowedMode`. */
  pointsAllowed: number;
}

/** A zeroed player line — spread over it so new rules can't silently read `undefined`. */
export const EMPTY_PLAYER_LINE: PlayerStatLine = Object.freeze({
  passYards: 0,
  passTd: 0,
  passInterceptions: 0,
  rushYards: 0,
  rushTd: 0,
  receptions: 0,
  recYards: 0,
  recTd: 0,
  fumblesLost: 0,
  returnTd: 0,
  twoPointConversions: 0,
  offensiveFumbleRecoveryTd: 0,
});

/** A zeroed DST line. `pointsAllowed: 0` scores +10, so never use this as a "no data" value. */
export const EMPTY_DST_LINE: DstStatLine = Object.freeze({
  sacks: 0,
  interceptions: 0,
  fumbleRecoveries: 0,
  safeties: 0,
  blockedKicks: 0,
  defensiveTds: 0,
  specialTeamsTds: 0,
  twoPointReturns: 0,
  pointsAllowed: 0,
});

/** Build a complete player line from a partial one, defaulting every absent stat to 0. */
export function playerLine(partial: Partial<PlayerStatLine>): PlayerStatLine {
  return { ...EMPTY_PLAYER_LINE, ...partial };
}

/** Build a complete DST line from a partial one, defaulting every absent stat to 0. */
export function dstLine(partial: Partial<DstStatLine>): DstStatLine {
  return { ...EMPTY_DST_LINE, ...partial };
}
