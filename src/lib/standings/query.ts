/**
 * DB-backed adapter for the pure standings engine.
 *
 * The `src/lib/standings/*` engine is intentionally DB-decoupled: it operates on plain
 * `OwnerEntry[]` + `MatchupResult[]` and knows nothing about Drizzle. This module is the
 * single place that loads those rows from Postgres and feeds the engine, so the public
 * pages and scripts all compute standings the same way.
 *
 * Assembly:
 *  - `OwnerEntry[]` comes from `owner_seasons` joined to `owners` and `nfl_teams`.
 *  - `MatchupResult[]` comes from `matchups` joined to each side's `scores` for that week.
 *    A matchup is `isFinal` only when BOTH owners have a non-bye, non-null score for the
 *    week (otherwise the game has not been played / scored and must not count). Bye scores
 *    are excluded by construction: an owner on bye has no matchup row that week, and the
 *    `isBye` flag on a score is treated as "no score" for the opponent's matchup.
 *
 * Numeric columns (`numeric(7,2)`) come back from the driver as strings; we convert with
 * `Number` exactly once, here.
 */
import { cache } from 'react';

import { and, desc, eq, lte, sql } from 'drizzle-orm';

import { db, matchups, nflGames, nflTeams, owners, ownerSeasons, scores, seasons } from '@/db';
import { weekIsFinal } from '@/lib/schedule/final';
import { assembleMatchupResults } from './assemble';
import {
  buildPlayingSet,
  deriveForfeits,
  isEffectiveBye,
  type ScoreRow as DerivedScoreRow,
} from './forfeit-derive';
import { getSeasonRules, type SeasonRules } from '@/lib/rules/schema';
import {
  buildTiebreakerContext,
  computeConferenceSeeds,
  computeDivisionStandings,
  computeStandings,
  rankStandings,
  type Conference,
  type Division,
  type MatchupResult,
  type OwnerEntry,
  type PlayoffConfig,
  type RankingOptions,
  type SeededOwner,
  type StandingRow,
} from '@/lib/standings';

/** Map a season's `playoffs` rules to the engine's {@link PlayoffConfig}. */
function playoffConfigFromRules(rules: SeasonRules): PlayoffConfig {
  return {
    teamsPerConference: rules.playoffs.teamsPerConference,
    divisionWinnersPerConference: rules.playoffs.divisionWinnersPerConference,
    wildCardsPerConference: rules.playoffs.wildCardsPerConference,
    topSeedByes: rules.playoffs.topSeedByes,
  };
}

/** Display-only team branding (logo + accent color), keyed by ownerSeasonId. */
export interface TeamBranding {
  /** ESPN crest URL, or null when the team has no logo metadata. */
  logoEspn: string | null;
  /** Primary brand color (hex), or null. */
  primaryColor: string | null;
}

/** The owners + the assembled regular-season matchup results for a season. */
export interface SeasonStandingsData {
  entries: OwnerEntry[];
  results: MatchupResult[];
  /** Per-owner team branding for display; not consumed by the standings engine. */
  brandingById: Map<number, TeamBranding>;
  /** The season's effective (defaults-filled) rules. */
  rules: SeasonRules;
  /**
   * Regular-season week count from the CANONICAL `seasons.regularSeasonWeeks` column.
   * Prefer this over `rules.regularSeasonWeeks`, which is a mirror the Settings page
   * deliberately leaves untouched and which therefore drifts.
   */
  regularSeasonWeeks: number;
  /**
   * Owner-weeks treated as missed lineups — derived from the schedule and unioned with any
   * stored `scores.isForfeit`. Exposed so consumers (My Team, history) report forfeits
   * identically to the standings rather than re-deriving from raw points.
   * Keys are `${ownerSeasonId}:${week}`.
   */
  forfeitByOwnerWeek: ReadonlySet<string>;
  /**
   * Rule-derived ranking knobs (tiebreaker order + bye Points-For), ready to pass
   * straight to `computeStandings` / `computeConferenceSeeds` / `computeDivisionStandings`.
   */
  rankingOptions: RankingOptions;
  /** The season's playoff structure (seeds, division winners, wild cards, byes). */
  playoffConfig: PlayoffConfig;
}

/**
 * Load the season's `OwnerEntry[]` and assemble its regular-season `MatchupResult[]`.
 *
 * @returns The inputs the pure standings engine consumes.
 */
export async function getSeasonStandingsData(seasonId: number): Promise<SeasonStandingsData> {
  // 0. The season's effective rules drive how forfeits ("missed lineups") are
  //    scored. We read them here so the behavior is per-season configurable from
  //    the Settings page rather than hardcoded.
  const [seasonRow] = await db
    .select({ rules: seasons.rules, regularSeasonWeeks: seasons.regularSeasonWeeks })
    .from(seasons)
    .where(eq(seasons.id, seasonId))
    .limit(1);
  const rules = getSeasonRules(seasonRow?.rules);
  // The canonical column, not the `rules` JSONB mirror — the Settings page writes the
  // column and deliberately leaves the mirror alone, so the two drift.
  const regularSeasonWeeks = seasonRow?.regularSeasonWeeks ?? rules.regularSeasonWeeks;

  // 1. Owners for the season → OwnerEntry[].
  const ownerRows = await db
    .select({
      ownerSeasonId: ownerSeasons.id,
      ownerName: sql<string>`coalesce(${ownerSeasons.displayName}, ${owners.name})`,
      teamKey: nflTeams.key,
      teamName: nflTeams.name,
      conference: nflTeams.conference,
      division: nflTeams.division,
      logoEspn: nflTeams.logoEspn,
      primaryColor: nflTeams.primaryColor,
    })
    .from(ownerSeasons)
    .innerJoin(owners, eq(ownerSeasons.ownerId, owners.id))
    .innerJoin(nflTeams, eq(ownerSeasons.nflTeamId, nflTeams.id))
    .where(eq(ownerSeasons.seasonId, seasonId));

  const entries: OwnerEntry[] = ownerRows.map((r) => ({
    ownerSeasonId: r.ownerSeasonId,
    ownerName: r.ownerName,
    teamKey: r.teamKey,
    teamName: r.teamName,
    conference: r.conference as Conference,
    division: r.division as Division,
  }));

  // Branding (logo + primary color) per owner, keyed by ownerSeasonId. Not part
  // of the standings-engine inputs (`OwnerEntry`), carried alongside for display.
  const brandingById = new Map<number, TeamBranding>(
    ownerRows.map((r) => [
      r.ownerSeasonId,
      { logoEspn: r.logoEspn ?? null, primaryColor: r.primaryColor ?? null },
    ]),
  );

  // 2. Scores → (ownerSeasonId, week) lookups, excluding byes (a bye is "no score").
  //    We also track which owner-weeks are forfeits so the assembly can apply the
  //    season's missed-lineup rule.
  const scoreRows = await db
    .select({
      ownerSeasonId: scores.ownerSeasonId,
      week: scores.week,
      dkPoints: scores.dkPoints,
      isBye: scores.isBye,
      isForfeit: scores.isForfeit,
    })
    .from(scores)
    // Exhibition (preseason) scores are tracked but NEVER count toward standings.
    .where(and(eq(scores.seasonId, seasonId), eq(scores.isExhibition, false)));

  // `numeric` arrives as a string; convert exactly once, here.
  const parsedScores: DerivedScoreRow[] = scoreRows.map((s) => ({
    ownerSeasonId: s.ownerSeasonId,
    week: s.week,
    dkPoints: s.dkPoints === null ? null : Number(s.dkPoints),
    isBye: s.isBye,
    isForfeit: s.isForfeit,
  }));

  // 3. Matchups + the NFL schedule. Matchups say who was scheduled to play; the schedule
  //    says which weeks have actually finished, which gates forfeit derivation.
  const [matchupRows, gameRows] = await Promise.all([
    db
      .select({
        week: matchups.week,
        homeOwnerSeasonId: matchups.homeOwnerSeasonId,
        awayOwnerSeasonId: matchups.awayOwnerSeasonId,
        isPlayoff: matchups.isPlayoff,
      })
      .from(matchups)
      // Exhibition (preseason) matchups are tracked but NEVER count toward standings.
      .where(and(eq(matchups.seasonId, seasonId), eq(matchups.isExhibition, false))),
    db
      .select({ week: nflGames.week, status: nflGames.status, kickoff: nflGames.kickoff })
      .from(nflGames)
      .where(and(eq(nflGames.seasonId, seasonId), eq(nflGames.isExhibition, false))),
  ]);

  // 3a. A week is SETTLED once every one of its NFL games is final. Only settled weeks
  //     derive missed lineups: mid-Sunday every owner legitimately sits on 0.00 points,
  //     and deriving then would resolve the week as 32 forfeits with cascading auto-losses.
  const gamesByWeek = new Map<number, { status: string | null; kickoff: Date | null }[]>();
  for (const g of gameRows) {
    const cur = gamesByWeek.get(g.week) ?? [];
    cur.push({ status: g.status, kickoff: g.kickoff });
    gamesByWeek.set(g.week, cur);
  }
  const now = new Date();
  const settledWeeks = new Set<number>();
  for (const [week, games] of gamesByWeek) {
    if (weekIsFinal(games, now)) settledWeeks.add(week);
  }

  // 3b. Missed lineups: derived from the schedule, unioned with any stored `isForfeit`
  //     (the commissioner's manual override). The live DraftKings ingest never writes that
  //     column, so without this the league's missed-lineup rule would not apply at all.
  const forfeitByOwnerWeek = deriveForfeits({
    scores: parsedScores,
    matchups: matchupRows,
    settledWeeks,
    regularSeasonWeeks,
  });

  // 4. Assemble the engine's MatchupResult[]. Pure and unit-tested (`assemble.ts`):
  //    reconciles byes against the schedule, scores a derived forfeit that left no row as
  //    0 (so the game counts and the opponent gets the win the rule owes them), computes
  //    the week's league average/median, and applies the season's missedLineup rule.
  const { results, byePointsForByOwner } = assembleMatchupResults({
    scores: parsedScores,
    matchups: matchupRows,
    forfeits: forfeitByOwnerWeek,
    missedLineup: rules.missedLineup,
    regularSeasonWeeks,
  });

  // Rule-derived ranking knobs, ready for the engine: the configured tiebreaker
  // order, and bye Points-For ONLY when the season counts bye weeks toward PF.
  const rankingOptions: RankingOptions = {
    tiebreakers: rules.tiebreakers,
    byePointsFor: rules.byeWeek.countsTowardPointsFor ? byePointsForByOwner : undefined,
  };

  return {
    entries,
    results,
    brandingById,
    rules,
    regularSeasonWeeks,
    forfeitByOwnerWeek,
    rankingOptions,
    playoffConfig: playoffConfigFromRules(rules),
  };
}

/** A standings row enriched with the owner's identity, for display/comparison. */
export interface SeasonStandingRow extends StandingRow {
  ownerName: string;
  teamKey: string;
  teamName: string;
  conference: Conference;
  division: Division;
}

/** Attach owner identity to bare engine rows. */
function enrichStandingRows(
  rows: StandingRow[],
  entries: OwnerEntry[],
): SeasonStandingRow[] {
  const entryById = new Map(entries.map((e) => [e.ownerSeasonId, e]));
  return rows.map((r) => {
    const e = entryById.get(r.ownerSeasonId)!;
    return {
      ...r,
      ownerName: e.ownerName,
      teamKey: e.teamKey,
      teamName: e.teamName,
      conference: e.conference,
      division: e.division,
    };
  });
}

/**
 * Compute the season's regular-season standings rows (one per owner), enriched with the
 * owner's identity. Unordered — use {@link getRankedSeasonStandings} or the seeding helpers
 * to rank.
 */
export async function getSeasonStandings(seasonId: number): Promise<SeasonStandingRow[]> {
  const { entries, results, rankingOptions } = await getSeasonStandingsData(seasonId);
  return enrichStandingRows(
    computeStandings(entries, results, rankingOptions.byePointsFor),
    entries,
  );
}

/** Ranked standings plus the two facts callers otherwise re-derive incorrectly. */
export interface RankedSeasonStandings {
  /** Best first, by the league's full tiebreaker chain. */
  rows: SeasonStandingRow[];
  /** Distinct regular-season weeks with at least one finalized matchup. */
  weeksPlayed: number;
  /** Owner-weeks that were missed lineups (`${ownerSeasonId}:${week}`). */
  forfeitByOwnerWeek: ReadonlySet<string>;
}

/**
 * The season's standings rows ORDERED by the league's full tiebreaker chain (win% →
 * head-to-head dominance → Points For), best first.
 *
 * Exists because callers kept re-sorting `getSeasonStandings` with an ad-hoc
 * winPct → PF → PA comparator, which silently drops the head-to-head step. That is how
 * `/history` could crown one owner "Regular-season #1" while the playoff bracket on the same
 * page — which does use the real chain — seeded a different owner first.
 */
export async function getRankedSeasonStandings(
  seasonId: number,
): Promise<RankedSeasonStandings> {
  const { entries, results, rankingOptions, forfeitByOwnerWeek } =
    await getSeasonStandingsData(seasonId);
  const rows = computeStandings(entries, results, rankingOptions.byePointsFor);
  const ctx = buildTiebreakerContext(rows, results);
  return {
    rows: enrichStandingRows(rankStandings(rows, ctx, rankingOptions.tiebreakers), entries),
    // Distinct weeks that actually produced a finalized game — NOT `max(gamesPlayed)`, which
    // is one lower for any season past the bye weeks (every owner sits out exactly one).
    weeksPlayed: new Set(results.filter((r) => !r.isPlayoff && r.isFinal).map((r) => r.week)).size,
    forfeitByOwnerWeek,
  };
}

/** Compute the season's full 7-seed playoff field for both conferences. */
export async function getSeasonSeeds(
  seasonId: number,
): Promise<Record<Conference, SeededOwner[]>> {
  const { entries, results, playoffConfig, rankingOptions } = await getSeasonStandingsData(seasonId);
  return computeConferenceSeeds(entries, results, playoffConfig, rankingOptions);
}

/* -------------------------------------------------------------------------- */
/* Request-scoped caches (React Server Components only)                        */
/* -------------------------------------------------------------------------- */

/**
 * Request-scoped memos for pages that fan out over the same season repeatedly.
 *
 * `/history` renders eleven aggregates; several of them independently load every season's
 * standings, and almost all of them call `getSeasonOptions`. On the Neon HTTP driver each of
 * those is a separate network round-trip, on a `force-dynamic` page, so the same handful of
 * queries ran dozens of times per render.
 *
 * IMPORTANT: these wrap the plain functions rather than replacing them, and the uncached
 * exports stay the default. `scripts/import-season3.ts` — the ground-truth replay — mutates
 * the database and then reads standings back to validate them; a memo that outlived the
 * write would hand it stale rows and silently break the regression anchor. React's `cache`
 * is scoped to a single request, which server components have and scripts do not, so the
 * split is deliberate: **app code may use these, scripts must not.**
 */
export const getSeasonStandingsDataCached = cache(getSeasonStandingsData);
export const getSeasonOptionsCached = cache(getSeasonOptions);
export const getRankedSeasonStandingsCached = cache(getRankedSeasonStandings);
export const getSeasonStandingsCached = cache(getSeasonStandings);

/* -------------------------------------------------------------------------- */
/* Display views for the public pages                                          */
/* -------------------------------------------------------------------------- */

/** A bare season identity for the season selector. */
export interface SeasonOption {
  id: number;
  year: number;
  name: string;
  status: 'upcoming' | 'active' | 'completed';
}

/**
 * All seasons, most-recent (highest year) first, for the season selector.
 */
export async function getSeasonOptions(): Promise<SeasonOption[]> {
  const rows = await db
    .select({
      id: seasons.id,
      year: seasons.year,
      name: seasons.name,
      status: seasons.status,
    })
    .from(seasons)
    .orderBy(desc(seasons.year));
  return rows.map((r) => ({
    id: r.id,
    year: r.year,
    name: r.name,
    status: r.status,
  }));
}

/**
 * The most-recent season that actually HAS owners assigned (i.e. has standings
 * data to render). Falls back to the most recent season of any kind, then null.
 * This is the default the public pages select when no `?season=` is given, so
 * an empty upcoming season never shows as the default.
 */
export async function getDefaultStandingsSeasonId(): Promise<number | null> {
  const withOwners = await db
    .select({ seasonId: ownerSeasons.seasonId, year: seasons.year })
    .from(ownerSeasons)
    .innerJoin(seasons, eq(ownerSeasons.seasonId, seasons.id))
    .orderBy(desc(seasons.year))
    .limit(1);
  if (withOwners[0]) return withOwners[0].seasonId;
  const any = await getSeasonOptions();
  return any[0]?.id ?? null;
}

/** Tag describing an owner's current playoff standing, for badges. */
export type PlayoffTag =
  | { kind: 'bye'; seed: number } // #1 seed: division winner + first-round bye
  | { kind: 'div'; seed: number } // division winner (seeds 2..4)
  | { kind: 'wc'; seed: number } // wild card (seeds 5..7)
  | null;

/** One owner's standings row enriched with everything the UI renders. */
export interface StandingsViewRow {
  ownerSeasonId: number;
  rank: number; // rank within the owner's division (1-based)
  ownerName: string;
  teamKey: string;
  teamName: string;
  /** ESPN crest URL for the team, or null. */
  logoEspn: string | null;
  /** Primary brand color (hex), or null. */
  primaryColor: string | null;
  dkEntryName: string | null;
  conference: Conference;
  division: Division;
  wins: number;
  losses: number;
  ties: number;
  gamesPlayed: number;
  pointsFor: number;
  pointsAgainst: number;
  winPct: number;
  streak: string;
  playoff: PlayoffTag;
}

/** Conference → division → ranked rows, ready for the standings tables. */
export interface StandingsView {
  hasData: boolean;
  /** Distinct regular-season weeks that have at least one scored matchup. */
  weeksPlayed: number;
  ownerCount: number;
  byConference: Record<Conference, Record<Division, StandingsViewRow[]>>;
}

const CONFERENCES: Conference[] = ['AFC', 'NFC'];
const DIVISIONS: Division[] = ['East', 'North', 'South', 'West'];

/**
 * The combined per-owner standings view for the public `/standings` page:
 * division-ranked rows carrying owner name, team, DK entry name, record, and a
 * computed playoff tag (DIV / WC / #1 BYE) from the conference seeding.
 *
 * Built once from a single `getSeasonStandingsData` load so the page never
 * re-derives standings logic.
 */
export async function getStandingsView(seasonId: number): Promise<StandingsView> {
  const { entries, results, brandingById, playoffConfig, rankingOptions } =
    await getSeasonStandingsData(seasonId);

  const empty: StandingsView = {
    hasData: false,
    weeksPlayed: 0,
    ownerCount: 0,
    byConference: {
      AFC: { East: [], North: [], South: [], West: [] },
      NFC: { East: [], North: [], South: [], West: [] },
    },
  };
  if (entries.length === 0) return empty;

  // DK entry names keyed by ownerSeasonId (not part of the standings inputs).
  const entryNameRows = await db
    .select({ id: ownerSeasons.id, dkEntryName: ownerSeasons.dkEntryName })
    .from(ownerSeasons)
    .where(eq(ownerSeasons.seasonId, seasonId));
  const dkEntryById = new Map(entryNameRows.map((r) => [r.id, r.dkEntryName]));
  const entryById = new Map(entries.map((e) => [e.ownerSeasonId, e]));

  // Distinct regular-season weeks with a final (both-scored) matchup. Seeding is
  // only meaningful once at least one week is in the books — before that, every
  // owner is 0-0 and the tiebreaker chain falls through to owner-season id order,
  // producing an arbitrary "seeding" that misleads. So we withhold playoff tags
  // until the season is under way.
  const weeksPlayed = new Set(
    results.filter((r) => !r.isPlayoff && r.isFinal).map((r) => r.week),
  ).size;

  // Playoff tags from the conference seeding (only once games have been scored).
  const tagById = new Map<number, PlayoffTag>();
  if (weeksPlayed > 0) {
    const seeds = computeConferenceSeeds(entries, results, playoffConfig, rankingOptions);
    for (const conf of CONFERENCES) {
      for (const s of seeds[conf]) {
        const kind = s.isBye ? 'bye' : s.kind === 'division_winner' ? 'div' : 'wc';
        tagById.set(s.ownerSeasonId, { kind, seed: s.seed } as PlayoffTag);
      }
    }
  }

  const byConference = {
    AFC: { East: [], North: [], South: [], West: [] },
    NFC: { East: [], North: [], South: [], West: [] },
  } as Record<Conference, Record<Division, StandingsViewRow[]>>;

  for (const conf of CONFERENCES) {
    for (const div of DIVISIONS) {
      const ranked = computeDivisionStandings(entries, results, conf, div, rankingOptions);
      byConference[conf][div] = ranked.map((row, idx) => {
        const e = entryById.get(row.ownerSeasonId)!;
        return {
          ownerSeasonId: row.ownerSeasonId,
          rank: idx + 1,
          ownerName: e.ownerName,
          teamKey: e.teamKey,
          teamName: e.teamName,
          logoEspn: brandingById.get(row.ownerSeasonId)?.logoEspn ?? null,
          primaryColor: brandingById.get(row.ownerSeasonId)?.primaryColor ?? null,
          dkEntryName: dkEntryById.get(row.ownerSeasonId) ?? null,
          conference: e.conference,
          division: e.division,
          wins: row.wins,
          losses: row.losses,
          ties: row.ties,
          gamesPlayed: row.gamesPlayed,
          pointsFor: row.pointsFor,
          pointsAgainst: row.pointsAgainst,
          winPct: row.winPct,
          streak: row.streak,
          playoff: tagById.get(row.ownerSeasonId) ?? null,
        };
      });
    }
  }

  return {
    hasData: true,
    weeksPlayed,
    ownerCount: entries.length,
    byConference,
  };
}

/** The highest non-bye weekly DraftKings score in a season, and everyone who posted it. */
export interface HighestWeeklyScore {
  /** All owners tied at this score — more than one when a week's high is shared. */
  owners: { ownerName: string; teamKey: string }[];
  week: number;
  points: number;
}

/**
 * The highest regular-season, non-bye weekly score in the season, with EVERY owner who
 * posted it. Returns null when no scores exist.
 *
 * Three things this must get right, because it drives the dashboard's headline number and
 * mirrors a real $50 prize:
 *
 *  - **Ties.** It previously did `ORDER BY dk_points DESC LIMIT 1`, so an exact tie handed
 *    the honour to whichever row Postgres returned first — not stable between runs.
 *  - **Week cap.** It scanned every week, so a playoff score (weeks 19-22, written non-bye
 *    by the playoff importers) could win the season's "weekly high" while the actual paid
 *    award is capped to the regular season.
 *  - **Byes.** It filtered the raw `isBye` column. That column can be wrong for an owner who
 *    has a matchup that week, so byes are reconciled against the schedule here too.
 */
export async function getHighestWeeklyScore(
  seasonId: number,
): Promise<HighestWeeklyScore | null> {
  const [seasonRow] = await db
    .select({ rules: seasons.rules, regularSeasonWeeks: seasons.regularSeasonWeeks })
    .from(seasons)
    .where(eq(seasons.id, seasonId))
    .limit(1);
  const rules = getSeasonRules(seasonRow?.rules);
  const regularSeasonWeeks = seasonRow?.regularSeasonWeeks ?? rules.regularSeasonWeeks;
  // Honor the season's `byeWeek.eligibleForWeeklyHigh` rule: when off (the default),
  // bye-week scores are excluded from the weekly-high prize.
  const byesEligible = rules.byeWeek.eligibleForWeeklyHigh;

  const [rows, matchupRows] = await Promise.all([
    db
      .select({
        ownerSeasonId: scores.ownerSeasonId,
        ownerName: sql<string>`coalesce(${ownerSeasons.displayName}, ${owners.name})`,
        teamKey: nflTeams.key,
        week: scores.week,
        points: scores.dkPoints,
        isBye: scores.isBye,
      })
      .from(scores)
      .innerJoin(ownerSeasons, eq(scores.ownerSeasonId, ownerSeasons.id))
      .innerJoin(owners, eq(ownerSeasons.ownerId, owners.id))
      .innerJoin(nflTeams, eq(ownerSeasons.nflTeamId, nflTeams.id))
      .where(
        and(
          eq(scores.seasonId, seasonId),
          // Never let a preseason exhibition blow-up win the weekly-high prize.
          eq(scores.isExhibition, false),
          lte(scores.week, regularSeasonWeeks),
        ),
      ),
    db
      .select({
        week: matchups.week,
        homeOwnerSeasonId: matchups.homeOwnerSeasonId,
        awayOwnerSeasonId: matchups.awayOwnerSeasonId,
        isPlayoff: matchups.isPlayoff,
      })
      .from(matchups)
      .where(and(eq(matchups.seasonId, seasonId), eq(matchups.isExhibition, false))),
  ]);

  const playing = buildPlayingSet(matchupRows);

  let best: number | null = null;
  const candidates: { ownerName: string; teamKey: string; week: number; points: number }[] = [];
  for (const r of rows) {
    if (r.points === null) continue;
    const bye = isEffectiveBye({
      storedIsBye: r.isBye,
      ownerSeasonId: r.ownerSeasonId,
      week: r.week,
      regularSeasonWeeks,
      playing,
    });
    if (bye && !byesEligible) continue;
    const points = Number(r.points);
    if (best === null || points > best) best = points;
    candidates.push({ ownerName: r.ownerName, teamKey: r.teamKey, week: r.week, points });
  }
  if (best === null) return null;

  // `numeric(7,2)` parsed via Number is exact at two decimals, so `===` is a valid
  // equality test for a genuine tie.
  const winners = candidates
    .filter((c) => c.points === best)
    .sort((a, b) => a.teamKey.localeCompare(b.teamKey));

  return {
    owners: winners.map((w) => ({ ownerName: w.ownerName, teamKey: w.teamKey })),
    week: winners[0].week,
    points: best,
  };
}

/**
 * The top-of-the-standings rows across the whole season (both conferences),
 * ranked by the standings tiebreaker chain, for the dashboard mini-table.
 */
export async function getTopStandings(
  seasonId: number,
  limit = 6,
): Promise<StandingsViewRow[]> {
  const view = await getStandingsView(seasonId);
  if (!view.hasData) return [];
  const all: StandingsViewRow[] = [];
  for (const conf of CONFERENCES) {
    for (const div of DIVISIONS) {
      all.push(...view.byConference[conf][div]);
    }
  }
  // Order by win pct, then PF, then PA — a reasonable cross-division "best record"
  // ordering for a glanceable top-N. (Full seeding logic lives in getStandingsView.)
  all.sort((a, b) => {
    if (b.winPct !== a.winPct) return b.winPct - a.winPct;
    if (b.pointsFor !== a.pointsFor) return b.pointsFor - a.pointsFor;
    return a.pointsAgainst - b.pointsAgainst;
  });
  return all.slice(0, limit);
}

/** One seeded owner enriched for the playoff-picture page. */
export interface PlayoffSeedRow {
  seed: number;
  ownerSeasonId: number;
  ownerName: string;
  teamKey: string;
  teamName: string;
  /** ESPN crest URL for the team, or null. */
  logoEspn: string | null;
  /** Primary brand color (hex), or null. */
  primaryColor: string | null;
  conference: Conference;
  division: Division;
  kind: SeededOwner['kind'];
  isBye: boolean;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
}

/** The playoff picture (7 seeds per conference, in order) for the season. */
export interface PlayoffPictureView {
  hasData: boolean;
  byConference: Record<Conference, PlayoffSeedRow[]>;
}

/**
 * The "as if the season ended today" playoff picture for the public
 * `/playoffs` page: the 7 seeds per conference in seed order, enriched with
 * each owner's identity and record.
 */
export async function getPlayoffPicture(seasonId: number): Promise<PlayoffPictureView> {
  const { entries, results, brandingById, playoffConfig, rankingOptions } =
    await getSeasonStandingsData(seasonId);
  // No owners, or no regular-season week scored yet → no meaningful picture.
  // Before any game is final every owner is 0-0, so seeding would just reflect
  // owner-season id order rather than the standings. Show the empty state instead.
  const weeksPlayed = new Set(
    results.filter((r) => !r.isPlayoff && r.isFinal).map((r) => r.week),
  ).size;
  if (entries.length === 0 || weeksPlayed === 0) {
    return { hasData: false, byConference: { AFC: [], NFC: [] } };
  }
  const entryById = new Map(entries.map((e) => [e.ownerSeasonId, e]));
  const seeds = computeConferenceSeeds(entries, results, playoffConfig, rankingOptions);
  const byConference = { AFC: [], NFC: [] } as Record<Conference, PlayoffSeedRow[]>;
  for (const conf of CONFERENCES) {
    byConference[conf] = seeds[conf].map((s) => {
      const e = entryById.get(s.ownerSeasonId)!;
      return {
        seed: s.seed,
        ownerSeasonId: s.ownerSeasonId,
        ownerName: e.ownerName,
        teamKey: e.teamKey,
        teamName: e.teamName,
        logoEspn: brandingById.get(s.ownerSeasonId)?.logoEspn ?? null,
        primaryColor: brandingById.get(s.ownerSeasonId)?.primaryColor ?? null,
        conference: e.conference,
        division: e.division,
        kind: s.kind,
        isBye: s.isBye,
        wins: s.wins,
        losses: s.losses,
        ties: s.ties,
        pointsFor: s.pointsFor,
      };
    });
  }
  return { hasData: true, byConference };
}
