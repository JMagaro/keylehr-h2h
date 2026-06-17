/**
 * Playoff bracket service — the DB-backed bridge between the pure standings
 * engine (`src/lib/standings/*`) and the `playoff_matchups` table.
 *
 * Server-only (touches the DB / Neon Node driver). Never import into a client
 * component or an edge route.
 *
 * Responsibilities:
 *  - `generatePlayoffBracket` — compute regular-season seeds with the season's
 *    CONFIGURED playoff structure and write the wild-card round.
 *  - `advancePlayoffs` — resolve each round whose games are fully scored and
 *    generate the next round (reseeding, bye re-entry), then record the champion
 *    as a `seasonAwards` row when the championship resolves.
 *  - `getPlayoffBracket` — read the full bracket shaped for a UI to render.
 *
 * Everything reads the playoff structure from the season's rules
 * (`getSeasonRules(season).playoffs`) — no hardcoded 7/4/3/1. The postseason TIE
 * rule (`tieBreaker`: regular_season_pf | higher_seed) also comes from the rules
 * and is threaded into the engine per game.
 *
 * All mutations are idempotent / re-runnable. Numeric DB columns (`numeric`)
 * come back as strings; they are converted with `Number` exactly once here.
 *
 * Server-only: this module touches the DB (Neon Node driver). Never import it
 * into a `'use client'` component or an edge route.
 */
import { and, asc, eq } from 'drizzle-orm';

import {
  db,
  nflTeams,
  owners,
  ownerSeasons,
  playoffMatchups,
  scores,
  seasonAwards,
  seasons,
} from '@/db';
import { getSeasonRules } from '@/lib/rules/schema';
import {
  advanceBracket,
  computeConferenceSeeds,
  computeStandings,
  seedInitialBracket,
  type Conference,
  type PlayoffConfig,
  type PlayoffGame,
  type PlayoffGameResult,
  type PlayoffRound,
  type SeededOwner,
} from '@/lib/standings';
import { getSeasonStandingsData } from '@/lib/standings/query';

/* -------------------------------------------------------------------------- */
/* Round → week mapping                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The NFL playoff weeks the league scores each round in. The DK playoff
 * contests are synced into `scores` for these weeks (see the admin Playoffs
 * page), exactly like a regular-season week.
 */
export const PLAYOFF_ROUND_WEEKS: Record<PlayoffRound, number> = {
  wild_card: 19,
  divisional: 20,
  conference: 21,
  championship: 22,
};

/** The playoff rounds in order, earliest first. */
export const PLAYOFF_ROUND_ORDER: PlayoffRound[] = [
  'wild_card',
  'divisional',
  'conference',
  'championship',
];

const CONFERENCES: Conference[] = ['AFC', 'NFC'];

/* -------------------------------------------------------------------------- */
/* Shared loaders                                                              */
/* -------------------------------------------------------------------------- */

/** Read the season's configured playoff structure (or the defaults). */
async function loadPlayoffConfig(seasonId: number): Promise<PlayoffConfig> {
  const [row] = await db
    .select({ rules: seasons.rules })
    .from(seasons)
    .where(eq(seasons.id, seasonId))
    .limit(1);
  const rules = getSeasonRules(row?.rules);
  return {
    teamsPerConference: rules.playoffs.teamsPerConference,
    divisionWinnersPerConference: rules.playoffs.divisionWinnersPerConference,
    wildCardsPerConference: rules.playoffs.wildCardsPerConference,
    topSeedByes: rules.playoffs.topSeedByes,
  };
}

/** Read the season's postseason tie rule. */
async function loadTieRule(seasonId: number): Promise<'regular_season_pf' | 'higher_seed'> {
  const [row] = await db
    .select({ rules: seasons.rules })
    .from(seasons)
    .where(eq(seasons.id, seasonId))
    .limit(1);
  return getSeasonRules(row?.rules).playoffs.tieBreaker;
}

/** Per-owner regular-season Points For, keyed by ownerSeasonId. */
async function loadRegularSeasonPf(seasonId: number): Promise<Map<number, number>> {
  const { entries, results, rankingOptions } = await getSeasonStandingsData(seasonId);
  const rows = computeStandings(entries, results, rankingOptions.byePointsFor);
  const out = new Map<number, number>();
  for (const r of rows) out.set(r.ownerSeasonId, r.pointsFor);
  return out;
}

/** Scores for one playoff week, keyed by ownerSeasonId → points. */
async function loadWeekScores(seasonId: number, week: number): Promise<Map<number, number>> {
  const rows = await db
    .select({ ownerSeasonId: scores.ownerSeasonId, dkPoints: scores.dkPoints })
    .from(scores)
    .where(and(eq(scores.seasonId, seasonId), eq(scores.week, week)));
  const out = new Map<number, number>();
  for (const r of rows) {
    if (r.dkPoints !== null) out.set(r.ownerSeasonId, Number(r.dkPoints));
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Persistence helpers (idempotent upsert by structural key)                   */
/* -------------------------------------------------------------------------- */

/** The structural identity of a playoff row, used to upsert without a DB unique index. */
function gameKey(round: PlayoffRound, conference: Conference | null, highSeed: number, lowSeed: number): string {
  return `${round}|${conference ?? 'XF'}|${highSeed}|${lowSeed}`;
}

/**
 * Upsert one round's games. Matches existing rows by (round, conference,
 * highSeed, lowSeed) so re-running never duplicates and preserves any already
 * recorded points/winner. Inserts new games with the round's week set.
 */
async function upsertRoundGames(seasonId: number, games: PlayoffGame[]): Promise<void> {
  const existing = await db
    .select()
    .from(playoffMatchups)
    .where(eq(playoffMatchups.seasonId, seasonId));
  const byKey = new Map<string, (typeof existing)[number]>();
  for (const e of existing) {
    byKey.set(gameKey(e.round, e.conference, e.highSeed ?? -1, e.lowSeed ?? -1), e);
  }

  for (const g of games) {
    const key = gameKey(g.round, g.conference, g.highSeed, g.lowSeed);
    const week = PLAYOFF_ROUND_WEEKS[g.round];
    const match = byKey.get(key);
    if (match) {
      // Keep the participants/week in sync (seeds/owners are structural); leave
      // any recorded points/winner intact so this is safe to re-run.
      await db
        .update(playoffMatchups)
        .set({
          week,
          highOwnerSeasonId: g.highOwnerSeasonId,
          lowOwnerSeasonId: g.lowOwnerSeasonId,
        })
        .where(eq(playoffMatchups.id, match.id));
    } else {
      await db.insert(playoffMatchups).values({
        seasonId,
        round: g.round,
        conference: g.conference,
        week,
        highSeed: g.highSeed,
        lowSeed: g.lowSeed,
        highOwnerSeasonId: g.highOwnerSeasonId,
        lowOwnerSeasonId: g.lowOwnerSeasonId,
      });
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Generate the wild-card bracket                                              */
/* -------------------------------------------------------------------------- */

/** Result of {@link generatePlayoffBracket}. */
export interface GenerateBracketResult {
  ok: boolean;
  /** Human-readable note (e.g. why generation was skipped). */
  message: string;
  /** Number of wild-card games written. */
  games: number;
  /** The seeded fields per conference, for confirmation/logging. */
  seeds: Record<Conference, SeededOwner[]>;
}

/**
 * Compute the regular-season seeds (using the season's configured playoff
 * structure) and write the wild-card round into `playoff_matchups`.
 *
 * Idempotent: re-running re-derives the same seeds and upserts the same rows.
 * Guard: requires the regular season to actually have scores — otherwise it is
 * a no-op with a warning (an empty/upcoming season has no valid seeding).
 */
export async function generatePlayoffBracket(seasonId: number): Promise<GenerateBracketResult> {
  const config = await loadPlayoffConfig(seasonId);
  const { entries, results, rankingOptions } = await getSeasonStandingsData(seasonId);

  const emptySeeds = { AFC: [], NFC: [] } as Record<Conference, SeededOwner[]>;

  if (entries.length === 0) {
    return { ok: false, message: 'No owners assigned to this season.', games: 0, seeds: emptySeeds };
  }
  const hasScores = results.some((r) => !r.isPlayoff && r.isFinal);
  if (!hasScores) {
    return {
      ok: false,
      message: 'Regular season has no scored games yet — seeding would be meaningless.',
      games: 0,
      seeds: emptySeeds,
    };
  }

  const seeds = computeConferenceSeeds(entries, results, config, rankingOptions);
  const wildCard = seedInitialBracket(seeds, config);
  await upsertRoundGames(seasonId, wildCard);

  return {
    ok: true,
    message: `Wild-card bracket generated (${wildCard.length} games).`,
    games: wildCard.length,
    seeds,
  };
}

/* -------------------------------------------------------------------------- */
/* Advance the bracket                                                         */
/* -------------------------------------------------------------------------- */

/** Result of {@link advancePlayoffs}. */
export interface AdvanceResult {
  ok: boolean;
  message: string;
  /** Rounds that were resolved (both participants scored) this run. */
  resolvedRounds: PlayoffRound[];
  /** Owner-season id of the recorded champion, if the championship resolved. */
  championOwnerSeasonId: number | null;
}

/** One playoff row as stored, with numeric strings already converted. */
interface BracketRow {
  id: number;
  round: PlayoffRound;
  conference: Conference | null;
  week: number | null;
  highSeed: number | null;
  lowSeed: number | null;
  highOwnerSeasonId: number | null;
  lowOwnerSeasonId: number | null;
  highPoints: number | null;
  lowPoints: number | null;
  winnerOwnerSeasonId: number | null;
}

/** Load all playoff rows for a season as typed {@link BracketRow}s. */
async function loadBracketRows(seasonId: number): Promise<BracketRow[]> {
  const rows = await db
    .select()
    .from(playoffMatchups)
    .where(eq(playoffMatchups.seasonId, seasonId));
  return rows.map((r) => ({
    id: r.id,
    round: r.round,
    conference: r.conference,
    week: r.week,
    highSeed: r.highSeed,
    lowSeed: r.lowSeed,
    highOwnerSeasonId: r.highOwnerSeasonId,
    lowOwnerSeasonId: r.lowOwnerSeasonId,
    highPoints: r.highPoints === null ? null : Number(r.highPoints),
    lowPoints: r.lowPoints === null ? null : Number(r.lowPoints),
    winnerOwnerSeasonId: r.winnerOwnerSeasonId,
  }));
}

/**
 * Build the seed lookups needed to re-enter bye seeds at the divisional round.
 * Derived from the wild-card rows already stored (the participants carry their
 * seeds), plus the full computed seeds so byes (who have no wild-card row) are
 * known.
 */
async function loadByeSeeds(
  seasonId: number,
  config: PlayoffConfig,
): Promise<Record<Conference, SeededOwner[]>> {
  const { entries, results, rankingOptions } = await getSeasonStandingsData(seasonId);
  const seeds = computeConferenceSeeds(entries, results, config, rankingOptions);
  const out = { AFC: [], NFC: [] } as Record<Conference, SeededOwner[]>;
  for (const conf of CONFERENCES) {
    out[conf] = seeds[conf].filter((s) => s.isBye);
  }
  return out;
}

/**
 * Resolve every fully-scored round and generate the next round's games. Records
 * the champion (a `seasonAwards` 'champion' row) when the championship resolves.
 *
 * A round is "resolved" when EVERY game in it has both owners' points recorded
 * (either ingested into `scores` for the round's week, or already written onto
 * the playoff row, or decided by a manual `winnerOwnerSeasonId` override).
 *
 * Idempotent: re-running recomputes the same winners and upserts the same next
 * round; an already-recorded champion award is not duplicated.
 */
export async function advancePlayoffs(seasonId: number): Promise<AdvanceResult> {
  const config = await loadPlayoffConfig(seasonId);
  const tieRule = await loadTieRule(seasonId);
  const pfById = await loadRegularSeasonPf(seasonId);
  const byeSeeds = await loadByeSeeds(seasonId, config);

  const resolvedRounds: PlayoffRound[] = [];
  let championOwnerSeasonId: number | null = null;

  // Walk the rounds in order; each round can unlock the next.
  for (let i = 0; i < PLAYOFF_ROUND_ORDER.length; i++) {
    const round = PLAYOFF_ROUND_ORDER[i];
    const rows = (await loadBracketRows(seasonId)).filter((r) => r.round === round);
    if (rows.length === 0) break; // this round hasn't been generated yet

    const week = PLAYOFF_ROUND_WEEKS[round];
    const weekScores = await loadWeekScores(seasonId, week);

    // 1. Fill in points on each game from this week's scores (idempotent), and
    //    determine whether every game is fully scored / decided.
    const results: PlayoffGameResult[] = [];
    let allResolved = true;
    for (const r of rows) {
      if (r.highOwnerSeasonId === null || r.lowOwnerSeasonId === null) {
        allResolved = false;
        continue;
      }
      const hi =
        r.highPoints ?? weekScores.get(r.highOwnerSeasonId) ?? null;
      const lo =
        r.lowPoints ?? weekScores.get(r.lowOwnerSeasonId) ?? null;

      // Persist freshly-ingested points back onto the row.
      if (
        (r.highPoints === null && hi !== null) ||
        (r.lowPoints === null && lo !== null)
      ) {
        await db
          .update(playoffMatchups)
          .set({
            highPoints: hi === null ? null : hi.toFixed(2),
            lowPoints: lo === null ? null : lo.toFixed(2),
          })
          .where(eq(playoffMatchups.id, r.id));
      }

      const decidedByOverride = r.winnerOwnerSeasonId !== null;
      const scored = hi !== null && lo !== null;
      if (!scored && !decidedByOverride) {
        allResolved = false;
        continue;
      }

      const result: PlayoffGameResult = {
        conference: r.conference,
        highSeed: r.highSeed ?? 0,
        lowSeed: r.lowSeed ?? 0,
        highOwnerSeasonId: r.highOwnerSeasonId,
        lowOwnerSeasonId: r.lowOwnerSeasonId,
        highPoints: hi ?? 0,
        lowPoints: lo ?? 0,
      };
      // Thread the season's tie rule: only supply regular-season PF when the
      // rule is regular_season_pf; otherwise the engine falls back to seed.
      if (tieRule === 'regular_season_pf') {
        result.highRegularSeasonPointsFor = pfById.get(r.highOwnerSeasonId);
        result.lowRegularSeasonPointsFor = pfById.get(r.lowOwnerSeasonId);
      }
      if (r.winnerOwnerSeasonId !== null) {
        result.winnerOwnerSeasonId = r.winnerOwnerSeasonId;
      }
      results.push(result);

      // Record the resolved winner on the row (so the UI shows it).
      const winnerId = resolveGameWinner(result, tieRule);
      if (r.winnerOwnerSeasonId === null && winnerId !== null) {
        await db
          .update(playoffMatchups)
          .set({ winnerOwnerSeasonId: winnerId })
          .where(eq(playoffMatchups.id, r.id));
      }
    }

    if (!allResolved) break; // can't advance past an unfinished round

    resolvedRounds.push(round);

    // 2. Championship resolved → record the champion award, then stop.
    if (round === 'championship') {
      const champ = results[0];
      if (champ) {
        championOwnerSeasonId =
          champ.winnerOwnerSeasonId ?? resolveGameWinner(champ, tieRule);
        if (championOwnerSeasonId !== null) {
          await recordChampion(seasonId, championOwnerSeasonId);
        }
      }
      break;
    }

    // 3. Generate the next round and upsert it.
    const nextGames = advanceBracket(
      round,
      results,
      round === 'wild_card' ? byeSeeds : undefined,
    );
    if (nextGames.length === 0) break;
    await upsertRoundGames(seasonId, nextGames);
  }

  const message =
    resolvedRounds.length === 0
      ? 'No rounds fully scored yet — nothing to advance.'
      : `Advanced through: ${resolvedRounds.join(', ')}.`;

  return {
    ok: true,
    message,
    resolvedRounds,
    championOwnerSeasonId,
  };
}

/**
 * Resolve a single game's winner using the same precedence as the engine:
 * explicit override → higher points → (tie) the season's tie rule.
 */
function resolveGameWinner(
  r: PlayoffGameResult,
  tieRule: 'regular_season_pf' | 'higher_seed',
): number | null {
  if (r.winnerOwnerSeasonId !== undefined) return r.winnerOwnerSeasonId;
  if (r.highPoints > r.lowPoints) return r.highOwnerSeasonId;
  if (r.lowPoints > r.highPoints) return r.lowOwnerSeasonId;
  // Exact tie.
  if (tieRule === 'regular_season_pf') {
    const hiPf = r.highRegularSeasonPointsFor;
    const loPf = r.lowRegularSeasonPointsFor;
    if (hiPf !== undefined && loPf !== undefined && hiPf !== loPf) {
      return hiPf > loPf ? r.highOwnerSeasonId : r.lowOwnerSeasonId;
    }
  }
  // higher_seed (or PF unavailable / tied): the better (lower) seed = high slot.
  return r.highOwnerSeasonId;
}

/**
 * Record (idempotently) the season champion as a `seasonAwards` 'champion' row
 * carrying the ownerId + ownerSeasonId. Re-running updates the existing row
 * rather than inserting a duplicate.
 */
async function recordChampion(seasonId: number, championOwnerSeasonId: number): Promise<void> {
  const [os] = await db
    .select({ ownerId: ownerSeasons.ownerId })
    .from(ownerSeasons)
    .where(eq(ownerSeasons.id, championOwnerSeasonId))
    .limit(1);
  if (!os) return;

  const existing = await db
    .select({ id: seasonAwards.id })
    .from(seasonAwards)
    .where(and(eq(seasonAwards.seasonId, seasonId), eq(seasonAwards.type, 'champion')))
    .limit(1);

  if (existing[0]) {
    await db
      .update(seasonAwards)
      .set({ ownerId: os.ownerId, ownerSeasonId: championOwnerSeasonId })
      .where(eq(seasonAwards.id, existing[0].id));
  } else {
    await db.insert(seasonAwards).values({
      seasonId,
      type: 'champion',
      ownerId: os.ownerId,
      ownerSeasonId: championOwnerSeasonId,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Manual override                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Manually set the winner of a single playoff game (admin override / forfeit),
 * then re-advance the bracket so downstream rounds reflect the change.
 */
export async function setGameWinner(
  seasonId: number,
  playoffMatchupId: number,
  winnerOwnerSeasonId: number,
): Promise<AdvanceResult> {
  await db
    .update(playoffMatchups)
    .set({ winnerOwnerSeasonId })
    .where(and(eq(playoffMatchups.id, playoffMatchupId), eq(playoffMatchups.seasonId, seasonId)));
  return advancePlayoffs(seasonId);
}

/* -------------------------------------------------------------------------- */
/* Read the full bracket for the UI                                            */
/* -------------------------------------------------------------------------- */

/** One participant in a playoff game, with display branding. */
export interface BracketParticipant {
  ownerSeasonId: number | null;
  seed: number | null;
  ownerName: string | null;
  teamKey: string | null;
  teamName: string | null;
  logoEspn: string | null;
  primaryColor: string | null;
  points: number | null;
  isWinner: boolean;
}

/** One playoff game shaped for the UI. */
export interface BracketGame {
  id: number;
  round: PlayoffRound;
  conference: Conference | null;
  week: number | null;
  high: BracketParticipant;
  low: BracketParticipant;
  winnerOwnerSeasonId: number | null;
}

/** The full bracket for a season, grouped by round (earliest first). */
export interface PlayoffBracketView {
  hasData: boolean;
  rounds: { round: PlayoffRound; week: number; games: BracketGame[] }[];
  championOwnerSeasonId: number | null;
  championOwnerName: string | null;
  championTeamName: string | null;
}

/** Owner-season display info keyed by ownerSeasonId. */
interface OwnerDisplay {
  ownerName: string;
  teamKey: string;
  teamName: string;
  logoEspn: string | null;
  primaryColor: string | null;
}

/** Read every owner-season's display info for a season. */
async function loadOwnerDisplay(seasonId: number): Promise<Map<number, OwnerDisplay>> {
  const rows = await db
    .select({
      ownerSeasonId: ownerSeasons.id,
      ownerName: owners.name,
      teamKey: nflTeams.key,
      teamName: nflTeams.name,
      logoEspn: nflTeams.logoEspn,
      primaryColor: nflTeams.primaryColor,
    })
    .from(ownerSeasons)
    .innerJoin(owners, eq(ownerSeasons.ownerId, owners.id))
    .innerJoin(nflTeams, eq(ownerSeasons.nflTeamId, nflTeams.id))
    .where(eq(ownerSeasons.seasonId, seasonId));
  const out = new Map<number, OwnerDisplay>();
  for (const r of rows) {
    out.set(r.ownerSeasonId, {
      ownerName: r.ownerName,
      teamKey: r.teamKey,
      teamName: r.teamName,
      logoEspn: r.logoEspn ?? null,
      primaryColor: r.primaryColor ?? null,
    });
  }
  return out;
}

/**
 * Read the full playoff bracket for a season, shaped for the bracket UI:
 * every round + each game's participants (name/team/logo/seed/points) and the
 * resolved winner, plus the recorded champion.
 */
export async function getPlayoffBracket(seasonId: number): Promise<PlayoffBracketView> {
  const [rows, display] = await Promise.all([
    db
      .select()
      .from(playoffMatchups)
      .where(eq(playoffMatchups.seasonId, seasonId))
      .orderBy(asc(playoffMatchups.id)),
    loadOwnerDisplay(seasonId),
  ]);

  const empty: PlayoffBracketView = {
    hasData: false,
    rounds: [],
    championOwnerSeasonId: null,
    championOwnerName: null,
    championTeamName: null,
  };
  if (rows.length === 0) return empty;

  const participant = (
    ownerSeasonId: number | null,
    seed: number | null,
    points: number | null,
    winnerId: number | null,
  ): BracketParticipant => {
    const d = ownerSeasonId === null ? undefined : display.get(ownerSeasonId);
    return {
      ownerSeasonId,
      seed,
      ownerName: d?.ownerName ?? null,
      teamKey: d?.teamKey ?? null,
      teamName: d?.teamName ?? null,
      logoEspn: d?.logoEspn ?? null,
      primaryColor: d?.primaryColor ?? null,
      points,
      isWinner: ownerSeasonId !== null && ownerSeasonId === winnerId,
    };
  };

  const byRound = new Map<PlayoffRound, BracketGame[]>();
  for (const r of rows) {
    const game: BracketGame = {
      id: r.id,
      round: r.round,
      conference: r.conference,
      week: r.week,
      high: participant(
        r.highOwnerSeasonId,
        r.highSeed,
        r.highPoints === null ? null : Number(r.highPoints),
        r.winnerOwnerSeasonId,
      ),
      low: participant(
        r.lowOwnerSeasonId,
        r.lowSeed,
        r.lowPoints === null ? null : Number(r.lowPoints),
        r.winnerOwnerSeasonId,
      ),
      winnerOwnerSeasonId: r.winnerOwnerSeasonId,
    };
    const list = byRound.get(r.round) ?? [];
    list.push(game);
    byRound.set(r.round, list);
  }

  const rounds = PLAYOFF_ROUND_ORDER.filter((rnd) => byRound.has(rnd)).map((rnd) => ({
    round: rnd,
    week: PLAYOFF_ROUND_WEEKS[rnd],
    games: byRound.get(rnd)!,
  }));

  // Champion from the recorded award (falls back to the championship row winner).
  const [award] = await db
    .select({ ownerSeasonId: seasonAwards.ownerSeasonId })
    .from(seasonAwards)
    .where(and(eq(seasonAwards.seasonId, seasonId), eq(seasonAwards.type, 'champion')))
    .limit(1);
  const champOsId = award?.ownerSeasonId ?? null;
  const champDisplay = champOsId === null ? undefined : display.get(champOsId);

  return {
    hasData: true,
    rounds,
    championOwnerSeasonId: champOsId,
    championOwnerName: champDisplay?.ownerName ?? null,
    championTeamName: champDisplay?.teamName ?? null,
  };
}
