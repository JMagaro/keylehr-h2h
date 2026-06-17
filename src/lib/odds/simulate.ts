/**
 * Playoff-odds simulation engine (538-style "odds over time").
 *
 * Server-only but otherwise pure-ish: the only I/O is the single
 * `getSeasonStandingsData` load (the same DB adapter the standings pages use).
 * Everything after that is deterministic CPU work seeded by a tiny LCG we
 * control — we deliberately avoid `Math.random` so a given season always
 * produces the same snapshots (stable week-over-week trend lines).
 *
 * Approach
 * --------
 * For each scored week W of the regular season we ask: "given everything played
 * through week W, and simulating the remaining schedule, how often does each
 * owner make the playoff field?"
 *
 *  1. Split the season's real matchups into PLAYED (week <= W, final) and
 *     REMAINING (W < week <= regularSeasonWeeks). We use the actual schedule
 *     pairings for the remaining games — only the scores are simulated.
 *  2. Build a per-owner scoring model from their scored weeks so far: the mean
 *     and (sample) standard deviation of their weekly DraftKings points. Owners
 *     with too few games fall back toward a league-wide prior (so week-1 noise
 *     does not produce absurd variance).
 *  3. Monte-Carlo: for N sims, draw each remaining matchup's two scores from the
 *     owners' normal models, decide W/L, then feed the FULL set of results
 *     (played + simulated) into `computeConferenceSeeds` to get the playoff
 *     field for both conferences. Tally how often each owner lands in the field.
 *  4. The tally / N is the owner's playoff probability for week W. Owners already
 *     mathematically locked in / out converge to ~100% / ~0% naturally.
 *
 * The default 7-seeds-per-conference field is whatever `computeConferenceSeeds`
 * returns (we call it WITHOUT any optional playoff-config arg, so it uses the
 * standard 4 division winners + 3 wild cards behavior).
 */
import {
  computeConferenceSeeds,
  type Conference,
  type MatchupResult,
  type OwnerEntry,
  type PlayoffConfig,
  type RankingOptions,
} from '@/lib/standings';
import { getSeasonStandingsData } from '@/lib/standings/query';
import { db, seasons } from '@/db';
import { eq } from 'drizzle-orm';

/** Number of Monte-Carlo simulations per week. ~4k balances stability/speed. */
const DEFAULT_SIMS = 4000;

/** League-wide prior used to stabilize tiny early-season samples. */
const PRIOR_STDEV = 35; // a typical weekly DK point spread for one owner
const MIN_STDEV = 8; // floor so a fluky low-variance owner stays plausible

/** One owner's playoff probability at a given week. */
export interface OddsSnapshot {
  week: number;
  ownerSeasonId: number;
  /** Probability the owner makes the playoff field, as a percent 0..100. */
  oddsPct: number;
}

/** Options for {@link computePlayoffOddsSnapshots} (mostly for tests/tuning). */
export interface OddsOptions {
  /** Monte-Carlo iterations per week. Default {@link DEFAULT_SIMS}. */
  sims?: number;
  /** Seed for the deterministic PRNG. Default derived from the season id. */
  seed?: number;
}

/* -------------------------------------------------------------------------- */
/* Deterministic PRNG                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A tiny seeded PRNG (Numerical Recipes LCG) returning floats in [0, 1).
 * We control the seed so the whole simulation is reproducible — important
 * because the snapshots are persisted and rendered as a stable trend line.
 */
class Lcg {
  private state: number;
  constructor(seed: number) {
    // Avoid a zero state; coerce to a 32-bit unsigned int.
    this.state = (seed >>> 0) || 0x9e3779b9;
  }
  /** Next float in [0, 1). */
  next(): number {
    // 32-bit LCG (Numerical Recipes constants), kept in unsigned 32-bit space.
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return this.state / 0x100000000;
  }
  /**
   * One standard-normal draw via Box–Muller. We discard the second variate for
   * simplicity; the cost is negligible at these sim counts.
   */
  normal(): number {
    let u = this.next();
    const v = this.next();
    // Guard against log(0).
    if (u < 1e-12) u = 1e-12;
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

/* -------------------------------------------------------------------------- */
/* Scoring models                                                              */
/* -------------------------------------------------------------------------- */

interface ScoringModel {
  mean: number;
  stdev: number;
}

/**
 * Build each owner's scoring model (mean + stdev of weekly points) from the
 * results PLAYED through `throughWeek`. Byes/unscored weeks are skipped. Owners
 * with sparse samples are shrunk toward the league-wide prior so early weeks
 * don't yield wild variance.
 */
function buildModels(
  entries: OwnerEntry[],
  playedResults: MatchupResult[],
): Map<number, ScoringModel> {
  const samples = new Map<number, number[]>();
  for (const e of entries) samples.set(e.ownerSeasonId, []);

  for (const r of playedResults) {
    if (r.homePoints !== null) samples.get(r.homeOwnerSeasonId)?.push(r.homePoints);
    if (r.awayPoints !== null) samples.get(r.awayOwnerSeasonId)?.push(r.awayPoints);
  }

  // League-wide mean across every scored owner-week, used as the prior mean for
  // owners who have not played yet (and as a shrink target).
  let leagueSum = 0;
  let leagueN = 0;
  for (const arr of samples.values()) {
    for (const p of arr) {
      leagueSum += p;
      leagueN += 1;
    }
  }
  const leagueMean = leagueN > 0 ? leagueSum / leagueN : 100;

  const models = new Map<number, ScoringModel>();
  for (const [id, arr] of samples) {
    const n = arr.length;
    if (n === 0) {
      models.set(id, { mean: leagueMean, stdev: PRIOR_STDEV });
      continue;
    }
    const mean = arr.reduce((a, b) => a + b, 0) / n;
    let stdev: number;
    if (n >= 2) {
      const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
      stdev = Math.sqrt(variance);
    } else {
      stdev = PRIOR_STDEV;
    }
    // Shrink the stdev toward the prior when the sample is small, so a single
    // tight/loose early week doesn't dominate. Weight by sample size.
    const w = n / (n + 3);
    stdev = w * stdev + (1 - w) * PRIOR_STDEV;
    stdev = Math.max(stdev, MIN_STDEV);
    models.set(id, { mean, stdev });
  }
  return models;
}

/* -------------------------------------------------------------------------- */
/* Simulation                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Run the Monte-Carlo for a single week W and return each owner's playoff
 * probability percent.
 *
 * @param entries        all owners for the season
 * @param playedResults  final regular-season results through week W
 * @param remaining      remaining regular-season matchup pairings (W < wk <= last)
 * @param models         per-owner scoring models from games through W
 * @param sims           number of Monte-Carlo iterations
 * @param rng            seeded PRNG (advanced across the whole week)
 */
function simulateWeek(
  entries: OwnerEntry[],
  playedResults: MatchupResult[],
  remaining: MatchupResult[],
  models: Map<number, ScoringModel>,
  sims: number,
  rng: Lcg,
  config: PlayoffConfig,
  rankingOptions: RankingOptions,
): Map<number, number> {
  const fieldCount = new Map<number, number>();
  for (const e of entries) fieldCount.set(e.ownerSeasonId, 0);

  const conferences: Conference[] = ['AFC', 'NFC'];

  for (let s = 0; s < sims; s++) {
    // Simulate every remaining matchup's two scores → a final MatchupResult.
    const simResults: MatchupResult[] = remaining.map((m) => {
      const hm = models.get(m.homeOwnerSeasonId)!;
      const am = models.get(m.awayOwnerSeasonId)!;
      const homePoints = hm.mean + hm.stdev * rng.normal();
      const awayPoints = am.mean + am.stdev * rng.normal();
      return {
        week: m.week,
        isPlayoff: false,
        isFinal: true,
        homeOwnerSeasonId: m.homeOwnerSeasonId,
        awayOwnerSeasonId: m.awayOwnerSeasonId,
        homePoints,
        awayPoints,
      };
    });

    const allResults = playedResults.concat(simResults);
    const seeds = computeConferenceSeeds(entries, allResults, config, rankingOptions);
    for (const conf of conferences) {
      for (const seeded of seeds[conf]) {
        fieldCount.set(seeded.ownerSeasonId, (fieldCount.get(seeded.ownerSeasonId) ?? 0) + 1);
      }
    }
  }

  const out = new Map<number, number>();
  for (const [id, count] of fieldCount) {
    out.set(id, (count / sims) * 100);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Public entry point                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Compute per-(week, owner) playoff probabilities for the season.
 *
 * Loads the season's owners + all regular-season matchup results, then for each
 * scored week runs a Monte-Carlo over the remaining schedule and tallies how
 * often each owner makes the playoff field.
 *
 * @returns A flat array of `{ week, ownerSeasonId, oddsPct }` for every scored
 *          week × owner. Empty when the season has no owners or no scored games.
 */
export async function computePlayoffOddsSnapshots(
  seasonId: number,
  options: OddsOptions = {},
): Promise<OddsSnapshot[]> {
  const sims = options.sims ?? DEFAULT_SIMS;
  const { entries, results, playoffConfig, rankingOptions } = await getSeasonStandingsData(seasonId);
  if (entries.length === 0) return [];

  // The season's regular-season length (remaining weeks run up to this).
  const [seasonRow] = await db
    .select({ regularSeasonWeeks: seasons.regularSeasonWeeks })
    .from(seasons)
    .where(eq(seasons.id, seasonId))
    .limit(1);
  const regularSeasonWeeks = seasonRow?.regularSeasonWeeks ?? 18;

  // Regular-season matchups only. Final ones drive "played"; all pairings drive
  // the schedule we simulate forward from.
  const regResults = results.filter((r) => !r.isPlayoff);

  // The last week that actually has a final (scored) regular-season game.
  const finalWeeks = regResults.filter((r) => r.isFinal).map((r) => r.week);
  if (finalWeeks.length === 0) return [];
  const lastScoredWeek = Math.max(...finalWeeks);

  // Deterministic seed: caller override, else derived from the season id.
  const seed = options.seed ?? (seasonId * 2654435761) >>> 0;
  const rng = new Lcg(seed);

  const snapshots: OddsSnapshot[] = [];

  for (let week = 1; week <= lastScoredWeek; week++) {
    // Played: every final regular-season result through this week.
    const played = regResults.filter((r) => r.isFinal && r.week <= week);
    // Remaining: scheduled pairings after this week, up to the season length.
    // We treat ALL such pairings as remaining (whether or not they have been
    // scored in reality) so each week is a clean "as-of" simulation.
    const remaining = regResults.filter(
      (r) => r.week > week && r.week <= regularSeasonWeeks,
    );

    const models = buildModels(entries, played);
    const probs = simulateWeek(entries, played, remaining, models, sims, rng, playoffConfig, rankingOptions);

    for (const e of entries) {
      const pct = probs.get(e.ownerSeasonId) ?? 0;
      // Round to 2 decimals to match the numeric(5,2) DB column.
      snapshots.push({
        week,
        ownerSeasonId: e.ownerSeasonId,
        oddsPct: Math.round(pct * 100) / 100,
      });
    }
  }

  return snapshots;
}
