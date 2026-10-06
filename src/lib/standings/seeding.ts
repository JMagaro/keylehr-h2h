/**
 * Division standings & conference playoff seeding.
 *
 * Mirrors the NFL playoff format:
 *  - 4 division winners per conference qualify automatically.
 *  - They are seeded 1–4 among the four winners by overall record + tiebreakers.
 *  - The 3 best remaining (non-winning) owners are wild cards, seeded 5–7.
 *  - The #1 seed receives a first-round bye.
 *
 * All ranking uses the shared tiebreaker chain (H2H → PF → PA → id). For
 * cross-division seeding, head-to-head is only decisive when the tied owners
 * actually played each other; otherwise the chain falls through to PF/PA.
 *
 * Pure: no DB, no I/O.
 */
import { computeStandings } from './standings';
import {
  buildTiebreakerContext,
  headToHeadRecord,
  rankStandings,
  rankStandingsWithReasons,
  type TiebreakerContext,
} from './tiebreakers';
import {
  DEFAULT_PLAYOFF_CONFIG,
  DEFAULT_TIEBREAKERS,
  type Conference,
  type Division,
  type MatchupResult,
  type OwnerEntry,
  type PlayoffConfig,
  type RankedStandingRow,
  type RankingOptions,
  type SeededOwner,
  type StandingRow,
  type TieH2hRecord,
  type TiebreakerKey,
  type TiebreakerReason,
} from './types';

const CONFERENCES: Conference[] = ['AFC', 'NFC'];
const DIVISIONS: Division[] = ['East', 'North', 'South', 'West'];

/** Internal: standings + lookup maps computed once, reused by seeding helpers. */
interface ComputedContext {
  entryById: Map<number, OwnerEntry>;
  rowById: Map<number, StandingRow>;
  ctx: TiebreakerContext;
  /** The season's tiebreaker order, applied by every rankStandings call below. */
  order: readonly TiebreakerKey[];
}

function compute(
  entries: OwnerEntry[],
  results: MatchupResult[],
  opts: RankingOptions = {},
): ComputedContext {
  const rows = computeStandings(entries, results, opts.byePointsFor);
  const ctx = buildTiebreakerContext(rows, results);
  const entryById = new Map(entries.map((e) => [e.ownerSeasonId, e]));
  const rowById = new Map(rows.map((r) => [r.ownerSeasonId, r]));
  return { entryById, rowById, ctx, order: opts.tiebreakers ?? DEFAULT_TIEBREAKERS };
}

/** Attach conference/division to a standings row. */
function enrich(row: StandingRow, entry: OwnerEntry): RankedStandingRow {
  return { ...row, conference: entry.conference, division: entry.division };
}

/**
 * Compute ranked standings for a single division.
 *
 * @returns The division's owners ordered best-first by record + tiebreakers.
 *          Index 0 is the division leader (the division winner once the season
 *          is complete).
 */
export function computeDivisionStandings(
  entries: OwnerEntry[],
  results: MatchupResult[],
  conference: Conference,
  division: Division,
  opts: RankingOptions = {},
): RankedStandingRow[] {
  const c = compute(entries, results, opts);
  return rankDivision(entries, c, conference, division);
}

function rankDivision(
  entries: OwnerEntry[],
  c: ComputedContext,
  conference: Conference,
  division: Division,
): RankedStandingRow[] {
  const members = entries.filter(
    (e) => e.conference === conference && e.division === division,
  );
  const rows = members.map((e) => c.rowById.get(e.ownerSeasonId)!);
  const ranked = rankStandings(rows, c.ctx, c.order);
  return ranked.map((r) => enrich(r, c.entryById.get(r.ownerSeasonId)!));
}

/**
 * Compute the full 7-seed playoff field for both conferences.
 *
 * Seeding rules implemented:
 *  - Division winner = the top-ranked owner in each of the conference's four
 *    divisions.
 *  - Seeds 1–4 = the four division winners ordered among themselves by the
 *    tiebreaker chain. The best gets seed 1 and a bye.
 *  - Seeds 5–7 = the best three non-winners in the conference, ordered by the
 *    tiebreaker chain.
 *
 * Config-driven: the number of division-winner seeds, wild-card seeds, total
 * seeds, and how many top seeds get a bye all come from {@link PlayoffConfig}
 * (the season's `playoffs` rules). Omitting `config` uses
 * {@link DEFAULT_PLAYOFF_CONFIG} (today's 7/4/3/1 format), so existing callers
 * are unchanged.
 *
 * @returns A record keyed by conference; each value is the seeded owners in
 *          seed order (seed 1 first .. last). The length is
 *          `min(teamsPerConference, owners available in the conference)`.
 */
export function computeConferenceSeeds(
  entries: OwnerEntry[],
  results: MatchupResult[],
  config: PlayoffConfig = DEFAULT_PLAYOFF_CONFIG,
  opts: RankingOptions = {},
): Record<Conference, SeededOwner[]> {
  const full = computeConferenceSeedsFull(entries, results, config, opts);
  const out = {} as Record<Conference, SeededOwner[]>;
  for (const conf of CONFERENCES) {
    out[conf] = full[conf].slice(0, config.teamsPerConference);
  }
  return out;
}

/**
 * Like {@link computeConferenceSeeds}, but returns EVERY owner in the conference, continuing
 * the same order and numbering past the playoff cutoff — seeds 1..`teamsPerConference` carry
 * `kind: 'division_winner' | 'wild_card'`, everyone after is `kind: 'out_of_field'`. Powers
 * the playoffs page's "also in the picture" list; `computeConferenceSeeds` stays the
 * field-only view every other caller expects.
 */
export function computeConferenceSeedsFull(
  entries: OwnerEntry[],
  results: MatchupResult[],
  config: PlayoffConfig = DEFAULT_PLAYOFF_CONFIG,
  opts: RankingOptions = {},
): Record<Conference, SeededOwner[]> {
  const c = compute(entries, results, opts);
  const out = {} as Record<Conference, SeededOwner[]>;
  for (const conf of CONFERENCES) {
    out[conf] = seedConference(entries, c, conf, config);
  }
  return out;
}

/**
 * The exact head-to-head record behind a `'h2h'`-decided tie, when the tied group is exactly
 * two owners — the case it can be stated precisely. Null for a larger group (no single record
 * explains a multi-way sweep) or when the two somehow never played.
 */
function h2hDetailFor(
  ctx: TiebreakerContext,
  winnerId: number,
  group: StandingRow[],
): TieH2hRecord | null {
  if (group.length !== 2) return null;
  const opponent = group.find((r) => r.ownerSeasonId !== winnerId);
  if (!opponent) return null;
  const record = headToHeadRecord(ctx, winnerId, opponent.ownerSeasonId);
  return record ? { opponentOwnerSeasonId: opponent.ownerSeasonId, ...record } : null;
}

/** Consecutive runs of equal win% in an already best-first-ordered list, length 2+ only. */
function consecutiveTieGroups(rows: StandingRow[]): StandingRow[][] {
  const groups: StandingRow[][] = [];
  let i = 0;
  while (i < rows.length) {
    let j = i + 1;
    while (j < rows.length && rows[j].winPct === rows[i].winPct) j++;
    if (j - i > 1) groups.push(rows.slice(i, j));
    i = j;
  }
  return groups;
}

/** {@link h2hDetailFor} for every 2-owner, h2h-decided tie in an ordered pool. */
function poolH2hDetails(
  orderedRows: StandingRow[],
  reasons: Map<number, TiebreakerReason>,
  ctx: TiebreakerContext,
): Map<number, TieH2hRecord> {
  const out = new Map<number, TieH2hRecord>();
  for (const group of consecutiveTieGroups(orderedRows)) {
    const winner = group[0]; // already best-first within the group
    if (reasons.get(winner.ownerSeasonId) !== 'h2h') continue;
    const detail = h2hDetailFor(ctx, winner.ownerSeasonId, group);
    if (detail) out.set(winner.ownerSeasonId, detail);
  }
  return out;
}

function seedConference(
  entries: OwnerEntry[],
  c: ComputedContext,
  conference: Conference,
  config: PlayoffConfig,
): SeededOwner[] {
  // 1. Division leaders (top of each division). All four are candidates; how
  //    many actually seed AS division winners is capped by the config.
  //
  //    A division winner tied with a DIVISION-MATE (not just conference-wide) is its own
  //    tiebreaker story — "why did I win the division, not just why is my seed N" — and the
  //    two owners end up far apart once seeded (the winner at 1-4, the runner-up wherever
  //    the wild-card pool lands them), so it has to be captured here, before that split
  //    happens, or it's lost. Only the winner's reason is kept: everyone else in the tied
  //    group is identifiable later purely from sharing (division, win%).
  const leaderRows: StandingRow[] = [];
  const divisionTieReasonByOwner = new Map<number, TiebreakerReason>();
  const divisionTieH2hByOwner = new Map<number, TieH2hRecord>();
  for (const div of DIVISIONS) {
    const members = entries
      .filter((e) => e.conference === conference && e.division === div)
      .map((e) => c.rowById.get(e.ownerSeasonId)!);
    if (members.length === 0) continue;
    const { rows: rankedDivision, reasons: divisionReasons } = rankStandingsWithReasons(
      members,
      c.ctx,
      c.order,
    );
    const winner = rankedDivision[0];
    leaderRows.push(winner);
    const tiedGroup = rankedDivision.filter((r) => r.winPct === winner.winPct);
    if (tiedGroup.length > 1) {
      const reason = divisionReasons.get(winner.ownerSeasonId) ?? 'none';
      divisionTieReasonByOwner.set(winner.ownerSeasonId, reason);
      if (reason === 'h2h') {
        const detail = h2hDetailFor(c.ctx, winner.ownerSeasonId, tiedGroup);
        if (detail) divisionTieH2hByOwner.set(winner.ownerSeasonId, detail);
      }
    }
  }

  // 2. Order the division leaders, then take the configured number as the
  //    division-winner seeds. Any extra leaders (config < 4 winners) drop back
  //    into the wild-card pool and compete on record like everyone else.
  const { rows: orderedLeaders, reasons: leaderReasons } = rankStandingsWithReasons(
    leaderRows,
    c.ctx,
    c.order,
  );
  const divisionWinners = orderedLeaders.slice(0, config.divisionWinnersPerConference);
  const winnerIds = new Set(divisionWinners.map((r) => r.ownerSeasonId));

  // 3. Everyone else in the conference, ordered the same way — wild cards fill the rest of
  //    the field up to the configured count, and whoever is left keeps going as
  //    `out_of_field`, still in the real tiebreaker order.
  const totalSeeds = config.teamsPerConference;
  const wildCardSlots = Math.min(
    config.wildCardsPerConference,
    Math.max(0, totalSeeds - divisionWinners.length),
  );
  const nonWinnerRows = entries
    .filter((e) => e.conference === conference && !winnerIds.has(e.ownerSeasonId))
    .map((e) => c.rowById.get(e.ownerSeasonId)!);
  const { rows: orderedNonWinners, reasons: nonWinnerReasons } = rankStandingsWithReasons(
    nonWinnerRows,
    c.ctx,
    c.order,
  );
  const leaderH2h = poolH2hDetails(orderedLeaders, leaderReasons, c.ctx);
  const nonWinnerH2h = poolH2hDetails(orderedNonWinners, nonWinnerReasons, c.ctx);

  const seeds: SeededOwner[] = [];
  divisionWinners.forEach((row, idx) => {
    seeds.push(
      makeSeed(row, idx + 1, 'division_winner', config, c, {
        tieReason: leaderReasons.get(row.ownerSeasonId),
        tieH2h: leaderH2h.get(row.ownerSeasonId),
        divisionTieReason: divisionTieReasonByOwner.get(row.ownerSeasonId),
        divisionTieH2h: divisionTieH2hByOwner.get(row.ownerSeasonId),
      }),
    );
  });
  orderedNonWinners.forEach((row, idx) => {
    const kind = idx < wildCardSlots ? 'wild_card' : 'out_of_field';
    seeds.push(
      makeSeed(row, divisionWinners.length + idx + 1, kind, config, c, {
        tieReason: nonWinnerReasons.get(row.ownerSeasonId),
        tieH2h: nonWinnerH2h.get(row.ownerSeasonId),
        divisionTieReason: undefined,
        divisionTieH2h: undefined,
      }),
    );
  });
  return seeds;
}

interface SeedTieInfo {
  tieReason: TiebreakerReason | undefined;
  tieH2h: TieH2hRecord | undefined;
  divisionTieReason: TiebreakerReason | undefined;
  divisionTieH2h: TieH2hRecord | undefined;
}

function makeSeed(
  row: StandingRow,
  seed: number,
  kind: SeededOwner['kind'],
  config: PlayoffConfig,
  c: ComputedContext,
  tie: SeedTieInfo,
): SeededOwner {
  const entry = c.entryById.get(row.ownerSeasonId)!;
  return {
    ...row,
    seed,
    kind,
    conference: entry.conference,
    division: entry.division,
    // A top-N seed gets a first-round bye (N = config.topSeedByes).
    isBye: seed <= config.topSeedByes,
    tieReason: tie.tieReason ?? 'none',
    divisionTieReason: tie.divisionTieReason ?? 'none',
    tieH2h: tie.tieH2h ?? null,
    divisionTieH2h: tie.divisionTieH2h ?? null,
  };
}
