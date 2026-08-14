/**
 * Season awards — the DB shell around the pure {@link computeSeasonAwards}.
 *
 * Loads a season's inputs, computes the ledger, and persists it. All of the interesting
 * arithmetic lives in `compute.ts`; this file is I/O plus two safety properties:
 *
 *  1. **Never leaves the season with zero awards.** The old script did
 *     `DELETE ... ; INSERT ...` as two statements, and the Neon HTTP driver has no
 *     transactions — a blip between them wiped the whole payout ledger. Here new rows are
 *     inserted FIRST and the superseded ones deleted afterwards by id, so the worst case is
 *     duplicate rows (visible, fixable) rather than an empty ledger.
 *  2. **Never silently rewrites a frozen season.** 2023-2025 were played and paid under the
 *     rules of their day; recomputation is refused unless explicitly forced.
 */
import { and, eq, inArray } from 'drizzle-orm';

import { db, ownerSeasons, playoffMatchups, scores, seasonAwards, seasons } from '@/db';
import { getSeasonRules } from '@/lib/rules/schema';
import { computeStandings } from '@/lib/standings';
import { getSeasonStandingsData } from '@/lib/standings/query';

import {
  computeSeasonAwards,
  type AwardType,
  type BracketOutcome,
  type ComputedAward,
} from './compute';

/** Seasons that are frozen by league decision — see docs/HANDOFF.md. */
export const FROZEN_YEARS: readonly number[] = [2023, 2024, 2025];

/** The award types this module owns. Anything else (e.g. `other`) is never touched. */
const MANAGED_TYPES: AwardType[] = [
  'champion',
  'runner_up',
  'third',
  'fourth',
  'weekly_high',
  'season_high',
  'most_points',
];

export interface RecomputeOptions {
  /** Compute and report without writing. */
  dryRun?: boolean;
  /** Required to recompute a frozen season. */
  force?: boolean;
  /**
   * Which conference-round loser finished 3rd.
   *
   * LEGACY FALLBACK. 3rd/4th normally come off the resolved `third_place` consolation game, and
   * this is ignored when one exists. It is here for seasons imported before that game was
   * modelled (2023-2025, which have no consolation row). With neither, neither `third` nor
   * `fourth` is emitted — better than guessing at a $300/$150 payout.
   */
  thirdPlaceOwnerSeasonId?: number;
}

export interface RecomputeResult {
  seasonId: number;
  year: number;
  awards: ComputedAward[];
  inserted: number;
  deleted: number;
  skipped?: string;
  notes: string[];
}

/** Resolve champion / runner-up / 3rd / 4th from the persisted bracket. */
async function loadBracketOutcome(
  seasonId: number,
  thirdPlaceOwnerSeasonId: number | undefined,
  notes: string[],
): Promise<BracketOutcome> {
  const rows = await db
    .select({
      round: playoffMatchups.round,
      highOwnerSeasonId: playoffMatchups.highOwnerSeasonId,
      lowOwnerSeasonId: playoffMatchups.lowOwnerSeasonId,
      winnerOwnerSeasonId: playoffMatchups.winnerOwnerSeasonId,
    })
    .from(playoffMatchups)
    .where(eq(playoffMatchups.seasonId, seasonId));

  const out: BracketOutcome = {
    championOwnerSeasonId: null,
    runnerUpOwnerSeasonId: null,
    thirdOwnerSeasonId: null,
    fourthOwnerSeasonId: null,
  };

  // Only RESOLVED title games count. The old code took titleGames[0] with no ordering and no
  // winner filter, so a stale/duplicate championship row could pay the wrong owner $2000.
  const titleGames = rows.filter((r) => r.round === 'championship' && r.winnerOwnerSeasonId !== null);
  if (titleGames.length > 1) {
    notes.push(
      `WARNING: ${titleGames.length} resolved championship games — bracket has stale rows; skipping champion/runner-up`,
    );
  } else if (titleGames.length === 1) {
    const g = titleGames[0];
    out.championOwnerSeasonId = g.winnerOwnerSeasonId;
    out.runnerUpOwnerSeasonId =
      g.highOwnerSeasonId === g.winnerOwnerSeasonId ? g.lowOwnerSeasonId : g.highOwnerSeasonId;
  } else {
    notes.push('No resolved championship game — skipping champion/runner-up');
  }

  // 3rd/4th are decided on the field: the two beaten conference finalists play a consolation
  // game in championship week. Its winner is 3rd, its loser 4th — nothing is inferred.
  const consolation = rows.filter(
    (r) => r.round === 'third_place' && r.winnerOwnerSeasonId !== null,
  );
  if (consolation.length > 1) {
    notes.push(
      `WARNING: ${consolation.length} resolved 3rd-place games — bracket has stale rows; skipping 3rd/4th`,
    );
    return out;
  }
  if (consolation.length === 1) {
    const g = consolation[0];
    out.thirdOwnerSeasonId = g.winnerOwnerSeasonId;
    out.fourthOwnerSeasonId =
      g.highOwnerSeasonId === g.winnerOwnerSeasonId ? g.lowOwnerSeasonId : g.highOwnerSeasonId;
    return out;
  }

  // No consolation game on record. Seasons imported before it was modelled (2023-2025) have
  // none, so `--third` remains available to record those by hand.
  const confGames = rows.filter((r) => r.round === 'conference' && r.winnerOwnerSeasonId !== null);
  const semiLosers = confGames
    .map((g) => (g.highOwnerSeasonId === g.winnerOwnerSeasonId ? g.lowOwnerSeasonId : g.highOwnerSeasonId))
    .filter((id): id is number => id !== null);

  if (semiLosers.length !== 2) {
    if (semiLosers.length > 0) {
      notes.push(
        `WARNING: expected 2 conference-round losers, found ${semiLosers.length} — skipping 3rd/4th`,
      );
    }
    return out;
  }
  if (thirdPlaceOwnerSeasonId === undefined) {
    notes.push(
      '3rd/4th not emitted: no resolved 3rd-place game yet. It is generated with the ' +
        'championship and scored from the same week-22 contest; for a season imported before ' +
        'that existed, pass --third=<ownerSeasonId>',
    );
    return out;
  }
  if (!semiLosers.includes(thirdPlaceOwnerSeasonId)) {
    notes.push(
      `WARNING: --third=${thirdPlaceOwnerSeasonId} is not one of the conference-round losers (${semiLosers.join(', ')}) — skipping 3rd/4th`,
    );
    return out;
  }
  out.thirdOwnerSeasonId = thirdPlaceOwnerSeasonId;
  out.fourthOwnerSeasonId = semiLosers.find((id) => id !== thirdPlaceOwnerSeasonId) ?? null;
  return out;
}

/**
 * Recompute and persist one season's awards.
 *
 * Idempotent: running it twice converges on the same ledger.
 */
export async function recomputeSeasonAwards(
  seasonId: number,
  options: RecomputeOptions = {},
): Promise<RecomputeResult> {
  const { dryRun = false, force = false, thirdPlaceOwnerSeasonId } = options;
  const notes: string[] = [];

  const [seasonRow] = await db
    .select({
      id: seasons.id,
      year: seasons.year,
      rules: seasons.rules,
      regularSeasonWeeks: seasons.regularSeasonWeeks,
    })
    .from(seasons)
    .where(eq(seasons.id, seasonId))
    .limit(1);
  if (!seasonRow) throw new Error(`Season ${seasonId} not found`);

  const rules = getSeasonRules(seasonRow.rules);
  const regularSeasonWeeks = seasonRow.regularSeasonWeeks ?? rules.regularSeasonWeeks;

  if (FROZEN_YEARS.includes(seasonRow.year) && !force) {
    return {
      seasonId,
      year: seasonRow.year,
      awards: [],
      inserted: 0,
      deleted: 0,
      skipped: `${seasonRow.year} is frozen (played and paid under the rules of its day); pass force to override`,
      notes,
    };
  }

  // Standings supply Points For — the same number /standings shows — plus the derived
  // forfeit set, so a missed lineup can't win a high-score prize.
  const data = await getSeasonStandingsData(seasonId);
  const standingRows = computeStandings(data.entries, data.results, data.rankingOptions.byePointsFor);

  const [scoreRows, bracket] = await Promise.all([
    db
      .select({
        ownerSeasonId: scores.ownerSeasonId,
        week: scores.week,
        dkPoints: scores.dkPoints,
        isBye: scores.isBye,
      })
      .from(scores)
      // Preseason exhibition scores must never reach a payout.
      .where(and(eq(scores.seasonId, seasonId), eq(scores.isExhibition, false))),
    loadBracketOutcome(seasonId, thirdPlaceOwnerSeasonId, notes),
  ]);

  const awards = computeSeasonAwards({
    scores: scoreRows.map((s) => ({
      ownerSeasonId: s.ownerSeasonId,
      week: s.week,
      points: s.dkPoints === null ? null : Number(s.dkPoints),
      isBye: s.isBye,
    })),
    standings: standingRows.map((r) => ({ ownerSeasonId: r.ownerSeasonId, pointsFor: r.pointsFor })),
    bracket,
    payouts: rules.payouts,
    forfeits: data.forfeitByOwnerWeek,
    regularSeasonWeeks,
    byeEligibleForWeeklyHigh: rules.byeWeek.eligibleForWeeklyHigh,
  });

  if (dryRun) {
    return { seasonId, year: seasonRow.year, awards, inserted: 0, deleted: 0, notes };
  }

  // ownerSeasonId → ownerId, so the all-time per-person views can aggregate.
  const osRows = await db
    .select({ id: ownerSeasons.id, ownerId: ownerSeasons.ownerId })
    .from(ownerSeasons)
    .where(eq(ownerSeasons.seasonId, seasonId));
  const ownerIdByOs = new Map(osRows.map((r) => [r.id, r.ownerId]));

  // Capture the rows we are replacing BEFORE inserting, so the delete can target them by id.
  const existing = await db
    .select({ id: seasonAwards.id, type: seasonAwards.type })
    .from(seasonAwards)
    .where(eq(seasonAwards.seasonId, seasonId));
  const supersededIds = existing
    .filter((r) => (MANAGED_TYPES as string[]).includes(r.type))
    .map((r) => r.id);

  const toInsert = awards.map((a) => ({
    seasonId,
    type: a.type,
    ownerId: ownerIdByOs.get(a.ownerSeasonId) ?? null,
    ownerSeasonId: a.ownerSeasonId,
    week: a.week,
    amountCents: a.amountCents,
    value: a.value,
  }));

  // INSERT FIRST, then prune. If this process dies in between, the season has duplicate
  // awards — obvious and repairable by re-running — instead of none at all.
  if (toInsert.length > 0) await db.insert(seasonAwards).values(toInsert);
  if (supersededIds.length > 0) {
    await db.delete(seasonAwards).where(inArray(seasonAwards.id, supersededIds));
  }

  return {
    seasonId,
    year: seasonRow.year,
    awards,
    inserted: toInsert.length,
    deleted: supersededIds.length,
    notes,
  };
}
