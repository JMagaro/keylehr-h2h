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
import { desc, eq } from 'drizzle-orm';

import { db, matchups, nflTeams, owners, ownerSeasons, scores, seasons } from '@/db';
import { getSeasonRules } from '@/lib/rules/schema';
import {
  computeConferenceSeeds,
  computeDivisionStandings,
  computeStandings,
  type Conference,
  type Division,
  type MatchupResult,
  type OwnerEntry,
  type SeededOwner,
  type StandingRow,
} from '@/lib/standings';

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
    .select({ rules: seasons.rules })
    .from(seasons)
    .where(eq(seasons.id, seasonId))
    .limit(1);
  const rules = getSeasonRules(seasonRow?.rules);

  // 1. Owners for the season → OwnerEntry[].
  const ownerRows = await db
    .select({
      ownerSeasonId: ownerSeasons.id,
      ownerName: owners.name,
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
    .where(eq(scores.seasonId, seasonId));

  /** key `${ownerSeasonId}:${week}` → points (null when bye / unscored). */
  const pointsByOwnerWeek = new Map<string, number | null>();
  /** key `${ownerSeasonId}:${week}` → true when that owner-week is a forfeit. */
  const forfeitByOwnerWeek = new Set<string>();
  for (const s of scoreRows) {
    const key = `${s.ownerSeasonId}:${s.week}`;
    const pts = s.isBye || s.dkPoints === null ? null : Number(s.dkPoints);
    pointsByOwnerWeek.set(key, pts);
    if (s.isForfeit) forfeitByOwnerWeek.add(key);
  }

  // 3. Matchups → MatchupResult[]. A matchup is final only when both sides have a
  //    non-bye score; otherwise it has not been played and must not be counted.
  const matchupRows = await db
    .select({
      week: matchups.week,
      homeOwnerSeasonId: matchups.homeOwnerSeasonId,
      awayOwnerSeasonId: matchups.awayOwnerSeasonId,
      isPlayoff: matchups.isPlayoff,
    })
    .from(matchups)
    .where(eq(matchups.seasonId, seasonId));

  // 3a. League average per regular-season week: the mean of that week's scores
  //     among owners who HAVE a matchup that week (not on bye) and did NOT
  //     forfeit. One value per week — what the season's `league_average` rule uses.
  const weekTotals = new Map<number, { sum: number; n: number }>();
  for (const m of matchupRows) {
    if (m.isPlayoff) continue;
    for (const ownerSeasonId of [m.homeOwnerSeasonId, m.awayOwnerSeasonId]) {
      const key = `${ownerSeasonId}:${m.week}`;
      if (forfeitByOwnerWeek.has(key)) continue; // forfeits excluded from the average
      const pts = pointsByOwnerWeek.get(key);
      if (pts === null || pts === undefined) continue; // bye / unscored excluded
      const cur = weekTotals.get(m.week) ?? { sum: 0, n: 0 };
      cur.sum += pts;
      cur.n += 1;
      weekTotals.set(m.week, cur);
    }
  }
  const leagueAverageByWeek = new Map<number, number>();
  for (const [week, { sum, n }] of weekTotals) {
    if (n > 0) leagueAverageByWeek.set(week, sum / n);
  }

  // 3b. Translate the season's missedLineup rule into the engine's forfeit fields.
  //     - `result: 'auto_loss'` → the forfeiter takes an auto-loss (forfeitBy set).
  //       `result: 'none'`      → forfeits are scored like any other game.
  //     - `opponentScores`: 'league_average' → the week average; 'zero' → 0;
  //       'actual' → the forfeiter's own raw points (i.e. no special handling).
  const applyForfeit = rules.missedLineup.result === 'auto_loss';
  const opponentScores = rules.missedLineup.opponentScores;
  const facesFor = (week: number, forfeiterPoints: number | null): number => {
    switch (opponentScores) {
      case 'league_average':
        return leagueAverageByWeek.get(week) ?? 0;
      case 'zero':
        return 0;
      case 'actual':
        return forfeiterPoints ?? 0;
    }
  };

  const results: MatchupResult[] = matchupRows.map((m) => {
    const homePoints = pointsByOwnerWeek.get(`${m.homeOwnerSeasonId}:${m.week}`) ?? null;
    const awayPoints = pointsByOwnerWeek.get(`${m.awayOwnerSeasonId}:${m.week}`) ?? null;
    const isFinal = homePoints !== null && awayPoints !== null;

    const base: MatchupResult = {
      week: m.week,
      isPlayoff: m.isPlayoff,
      isFinal,
      homeOwnerSeasonId: m.homeOwnerSeasonId,
      awayOwnerSeasonId: m.awayOwnerSeasonId,
      homePoints,
      awayPoints,
    };

    // Forfeit handling only applies to counted regular-season games when the
    // season's rule asks for an auto-loss and the opponent faces something other
    // than the forfeiter's actual points ('actual' is "no special handling").
    if (!applyForfeit || m.isPlayoff || !isFinal || opponentScores === 'actual') {
      return base;
    }
    const homeForfeit = forfeitByOwnerWeek.has(`${m.homeOwnerSeasonId}:${m.week}`);
    const awayForfeit = forfeitByOwnerWeek.has(`${m.awayOwnerSeasonId}:${m.week}`);
    if (!homeForfeit && !awayForfeit) return base;

    if (homeForfeit && awayForfeit) {
      // Both forfeited → both face the week average (or 0). Pass the average; the
      // engine gives both a loss regardless.
      return { ...base, forfeitBy: 'both', opponentFacesPoints: facesFor(m.week, null) };
    }
    if (homeForfeit) {
      return { ...base, forfeitBy: 'home', opponentFacesPoints: facesFor(m.week, homePoints) };
    }
    return { ...base, forfeitBy: 'away', opponentFacesPoints: facesFor(m.week, awayPoints) };
  });

  return { entries, results, brandingById };
}

/** A standings row enriched with the owner's identity, for display/comparison. */
export interface SeasonStandingRow extends StandingRow {
  ownerName: string;
  teamKey: string;
  teamName: string;
  conference: Conference;
  division: Division;
}

/**
 * Compute the season's regular-season standings rows (one per owner), enriched with the
 * owner's identity. Unordered — use the seeding/tiebreaker helpers to rank.
 */
export async function getSeasonStandings(seasonId: number): Promise<SeasonStandingRow[]> {
  const { entries, results } = await getSeasonStandingsData(seasonId);
  const rows = computeStandings(entries, results);
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

/** Compute the season's full 7-seed playoff field for both conferences. */
export async function getSeasonSeeds(
  seasonId: number,
): Promise<Record<Conference, SeededOwner[]>> {
  const { entries, results } = await getSeasonStandingsData(seasonId);
  return computeConferenceSeeds(entries, results);
}

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
  const { entries, results, brandingById } = await getSeasonStandingsData(seasonId);

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

  // Playoff tags from the conference seeding.
  const seeds = computeConferenceSeeds(entries, results);
  const tagById = new Map<number, PlayoffTag>();
  for (const conf of CONFERENCES) {
    for (const s of seeds[conf]) {
      const kind = s.isBye ? 'bye' : s.kind === 'division_winner' ? 'div' : 'wc';
      tagById.set(s.ownerSeasonId, { kind, seed: s.seed } as PlayoffTag);
    }
  }

  const byConference = {
    AFC: { East: [], North: [], South: [], West: [] },
    NFC: { East: [], North: [], South: [], West: [] },
  } as Record<Conference, Record<Division, StandingsViewRow[]>>;

  for (const conf of CONFERENCES) {
    for (const div of DIVISIONS) {
      const ranked = computeDivisionStandings(entries, results, conf, div);
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

  const weeksPlayed = new Set(
    results.filter((r) => !r.isPlayoff && r.isFinal).map((r) => r.week),
  ).size;

  return {
    hasData: true,
    weeksPlayed,
    ownerCount: entries.length,
    byConference,
  };
}

/** The single highest non-bye weekly DraftKings score in a season. */
export interface HighestWeeklyScore {
  ownerName: string;
  teamKey: string;
  week: number;
  points: number;
}

/**
 * The highest non-bye, non-null weekly score in the season, with the owner who
 * posted it. Returns null when no scores exist.
 */
export async function getHighestWeeklyScore(
  seasonId: number,
): Promise<HighestWeeklyScore | null> {
  const rows = await db
    .select({
      ownerName: owners.name,
      teamKey: nflTeams.key,
      week: scores.week,
      points: scores.dkPoints,
    })
    .from(scores)
    .innerJoin(ownerSeasons, eq(scores.ownerSeasonId, ownerSeasons.id))
    .innerJoin(owners, eq(ownerSeasons.ownerId, owners.id))
    .innerJoin(nflTeams, eq(ownerSeasons.nflTeamId, nflTeams.id))
    .where(eq(scores.seasonId, seasonId))
    .orderBy(desc(scores.dkPoints))
    .limit(1);
  const r = rows[0];
  if (!r || r.points === null) return null;
  return {
    ownerName: r.ownerName,
    teamKey: r.teamKey,
    week: r.week,
    points: Number(r.points),
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
  const { entries, results, brandingById } = await getSeasonStandingsData(seasonId);
  if (entries.length === 0) {
    return { hasData: false, byConference: { AFC: [], NFC: [] } };
  }
  const entryById = new Map(entries.map((e) => [e.ownerSeasonId, e]));
  const seeds = computeConferenceSeeds(entries, results);
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
