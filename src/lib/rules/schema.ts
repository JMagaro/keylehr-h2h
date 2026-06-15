/**
 * Per-season league rules / settings.
 *
 * Rules are configurable PER SEASON (stored in `seasons.rules` as JSONB) rather
 * than hardcoded, so the commissioner can adjust them each year from the admin
 * Settings page. This module is the single source of truth for the rule shape,
 * its validation (Zod), and the defaults a season inherits until overridden.
 *
 * Pure / no DB dependency — safe to import anywhere.
 */
import { z } from 'zod';

/** A USD-cents amount (non-negative integer). */
const cents = z.number().int().nonnegative();

export const seasonRulesSchema = z.object({
  /** Number of regular-season weeks (NFL is 18). */
  regularSeasonWeeks: z.number().int().min(1).max(25).default(18),

  /** Standings tiebreaker order. Applied top to bottom. */
  tiebreakers: z
    .array(z.enum(['h2h', 'pf', 'pa']))
    .default(['h2h', 'pf', 'pa']),

  playoffs: z
    .object({
      teamsPerConference: z.number().int().min(1).max(16).default(7),
      divisionWinnersPerConference: z.number().int().min(0).max(8).default(4),
      wildCardsPerConference: z.number().int().min(0).max(12).default(3),
      /** How many top seeds get a first-round bye. */
      topSeedByes: z.number().int().min(0).max(4).default(1),
      /** A postseason-matchup tie is broken by this rule. */
      tieBreaker: z.enum(['regular_season_pf', 'higher_seed']).default('regular_season_pf'),
    })
    .default({
      teamsPerConference: 7,
      divisionWinnersPerConference: 4,
      wildCardsPerConference: 3,
      topSeedByes: 1,
      tieBreaker: 'regular_season_pf',
    }),

  byeWeek: z
    .object({
      /** Whether bye-week points count toward Points For. League rule: false. */
      countsTowardPointsFor: z.boolean().default(false),
      /** Whether a bye-week score is eligible for the weekly high-score prize. */
      eligibleForWeeklyHigh: z.boolean().default(false),
    })
    .default({ countsTowardPointsFor: false, eligibleForWeeklyHigh: false }),

  missedLineup: z
    .object({
      /** Result for the owner who missed: automatic loss. */
      result: z.enum(['auto_loss', 'none']).default('auto_loss'),
      /** What the opponent scores that week. League rule: league average. */
      opponentScores: z.enum(['league_average', 'zero', 'actual']).default('league_average'),
    })
    .default({ result: 'auto_loss', opponentScores: 'league_average' }),

  /** Prize structure (cents). Mirrors the league's payout table. */
  payouts: z
    .object({
      entryFeeCents: cents.default(15500),
      weeklyHighCents: cents.default(5000),
      weeklyHighWeeks: z.number().int().nonnegative().default(18),
      seasonHighCents: cents.default(5000),
      mostRegularSeasonPointsCents: cents.default(40000),
      championCents: cents.default(200000),
      runnerUpCents: cents.default(100000),
      thirdCents: cents.default(30000),
      fourthCents: cents.default(15000),
    })
    .default({
      entryFeeCents: 15500,
      weeklyHighCents: 5000,
      weeklyHighWeeks: 18,
      seasonHighCents: 5000,
      mostRegularSeasonPointsCents: 40000,
      championCents: 200000,
      runnerUpCents: 100000,
      thirdCents: 30000,
      fourthCents: 15000,
    }),
});

export type SeasonRules = z.infer<typeof seasonRulesSchema>;

/** The defaults a season inherits before any commissioner override. */
export const DEFAULT_SEASON_RULES: SeasonRules = seasonRulesSchema.parse({});

/**
 * Resolve a season's effective rules. Parses whatever is stored in
 * `seasons.rules` (which may be null, partial, or a previous shape) and fills in
 * any missing keys from the defaults. Never throws on missing keys; only throws
 * if a present value is the wrong type (which surfaces a real misconfiguration).
 */
export function getSeasonRules(stored: unknown): SeasonRules {
  if (stored === null || stored === undefined) return DEFAULT_SEASON_RULES;
  return seasonRulesSchema.parse(stored);
}
