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

function seedConference(
  entries: OwnerEntry[],
  c: ComputedContext,
  conference: Conference,
  config: PlayoffConfig,
): SeededOwner[] {
  // 1. Division leaders (top of each division). All four are candidates; how
  //    many actually seed AS division winners is capped by the config.
  const leaderRows: StandingRow[] = [];
  for (const div of DIVISIONS) {
    const ranked = rankDivision(entries, c, conference, div);
    if (ranked.length === 0) continue;
    leaderRows.push(c.rowById.get(ranked[0].ownerSeasonId)!);
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

  const seeds: SeededOwner[] = [];
  divisionWinners.forEach((row, idx) => {
    seeds.push(
      makeSeed(row, idx + 1, 'division_winner', config, c, leaderReasons.get(row.ownerSeasonId)),
    );
  });
  orderedNonWinners.forEach((row, idx) => {
    const kind = idx < wildCardSlots ? 'wild_card' : 'out_of_field';
    seeds.push(
      makeSeed(
        row,
        divisionWinners.length + idx + 1,
        kind,
        config,
        c,
        nonWinnerReasons.get(row.ownerSeasonId),
      ),
    );
  });
  return seeds;
}

function makeSeed(
  row: StandingRow,
  seed: number,
  kind: SeededOwner['kind'],
  config: PlayoffConfig,
  c: ComputedContext,
  tieReason: TiebreakerReason | undefined,
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
    tieReason: tieReason ?? 'none',
  };
}
