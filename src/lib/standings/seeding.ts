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
import { buildTiebreakerContext, rankStandings, type TiebreakerContext } from './tiebreakers';
import type {
  Conference,
  Division,
  MatchupResult,
  OwnerEntry,
  RankedStandingRow,
  SeededOwner,
  StandingRow,
} from './types';

const CONFERENCES: Conference[] = ['AFC', 'NFC'];
const DIVISIONS: Division[] = ['East', 'North', 'South', 'West'];

/** Internal: standings + lookup maps computed once, reused by seeding helpers. */
interface ComputedContext {
  entryById: Map<number, OwnerEntry>;
  rowById: Map<number, StandingRow>;
  ctx: TiebreakerContext;
}

function compute(entries: OwnerEntry[], results: MatchupResult[]): ComputedContext {
  const rows = computeStandings(entries, results);
  const ctx = buildTiebreakerContext(rows, results);
  const entryById = new Map(entries.map((e) => [e.ownerSeasonId, e]));
  const rowById = new Map(rows.map((r) => [r.ownerSeasonId, r]));
  return { entryById, rowById, ctx };
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
): RankedStandingRow[] {
  const c = compute(entries, results);
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
  const ranked = rankStandings(rows, c.ctx);
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
 * @returns A record keyed by conference; each value is the 7 seeded owners in
 *          seed order (seed 1 first .. seed 7 last).
 */
export function computeConferenceSeeds(
  entries: OwnerEntry[],
  results: MatchupResult[],
): Record<Conference, SeededOwner[]> {
  const c = compute(entries, results);
  const out = {} as Record<Conference, SeededOwner[]>;
  for (const conf of CONFERENCES) {
    out[conf] = seedConference(entries, c, conf);
  }
  return out;
}

function seedConference(
  entries: OwnerEntry[],
  c: ComputedContext,
  conference: Conference,
): SeededOwner[] {
  // 1. Division winners (top of each division).
  const winnerIds = new Set<number>();
  const winnerRows: StandingRow[] = [];
  for (const div of DIVISIONS) {
    const ranked = rankDivision(entries, c, conference, div);
    if (ranked.length === 0) continue;
    const winner = ranked[0];
    winnerIds.add(winner.ownerSeasonId);
    winnerRows.push(c.rowById.get(winner.ownerSeasonId)!);
  }

  // 2. Order the division winners → seeds 1..4.
  const orderedWinners = rankStandings(winnerRows, c.ctx);

  // 3. Wild cards: best remaining non-winners in the conference → seeds 5..7.
  const nonWinnerRows = entries
    .filter((e) => e.conference === conference && !winnerIds.has(e.ownerSeasonId))
    .map((e) => c.rowById.get(e.ownerSeasonId)!);
  const orderedWildCards = rankStandings(nonWinnerRows, c.ctx).slice(0, 3);

  const seeds: SeededOwner[] = [];
  orderedWinners.forEach((row, idx) => {
    seeds.push(makeSeed(row, idx + 1, 'division_winner', c));
  });
  orderedWildCards.forEach((row, idx) => {
    seeds.push(makeSeed(row, orderedWinners.length + idx + 1, 'wild_card', c));
  });
  return seeds;
}

function makeSeed(
  row: StandingRow,
  seed: number,
  kind: SeededOwner['kind'],
  c: ComputedContext,
): SeededOwner {
  const entry = c.entryById.get(row.ownerSeasonId)!;
  return {
    ...row,
    seed,
    kind,
    conference: entry.conference,
    division: entry.division,
    isBye: seed === 1,
  };
}
