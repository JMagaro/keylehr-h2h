/**
 * Playoff bracket construction & advancement.
 *
 * Pure transformations only — the caller supplies seeds and, each round, the
 * winners/points. This library never decides games on its own beyond deriving
 * a winner from points when no explicit winner is given.
 *
 * NFL format implemented:
 *  - Wild-card round (per conference): #2 v #7, #3 v #6, #4 v #5. The #1 seed
 *    has a bye and plays no wild-card game.
 *  - Reseeding every round: within a conference, the highest remaining seed
 *    always faces the lowest remaining seed.
 *  - Divisional round (per conference): the #1 seed (back from its bye) joins
 *    the three wild-card winners → 4 owners reseeded into two games
 *    (best v worst, middle two together).
 *  - Conference round (per conference): the two divisional winners → 1 game.
 *  - Championship: AFC conference champion v NFC conference champion
 *    (cross-conference, so `conference` is `null`).
 *
 * Pure: no DB, no I/O.
 */
import type {
  AdvancingOwner,
  Conference,
  PlayoffGame,
  PlayoffGameResult,
  PlayoffRound,
  SeededOwner,
} from './types';

const CONFERENCES: Conference[] = ['AFC', 'NFC'];

/** The next round after `round`, or `null` if `round` is the championship. */
function nextRound(round: PlayoffRound): PlayoffRound | null {
  switch (round) {
    case 'wild_card':
      return 'divisional';
    case 'divisional':
      return 'conference';
    case 'conference':
      return 'championship';
    case 'championship':
      return null;
  }
}

/** Build a single game from two seeded owners (high seed = lower number). */
function pairGame(round: PlayoffRound, conference: Conference | null, x: Seeded, y: Seeded): PlayoffGame {
  const [high, low] = x.seed <= y.seed ? [x, y] : [y, x];
  return {
    round,
    conference,
    highSeed: high.seed,
    lowSeed: low.seed,
    highOwnerSeasonId: high.ownerSeasonId,
    lowOwnerSeasonId: low.ownerSeasonId,
  };
}

/** Minimal seed shape the pairing logic needs. */
interface Seeded {
  seed: number;
  ownerSeasonId: number;
}

/**
 * Build the initial (wild-card) bracket from the conference seeds.
 *
 * For each conference produces three games — #2 v #7, #3 v #6, #4 v #5 — in
 * that order. The #1 seed is omitted (bye). Conferences are emitted in
 * AFC-then-NFC order.
 *
 * @param seeds Per-conference seeded owners (seeds 1..7), e.g. the output of
 *              `computeConferenceSeeds`.
 * @returns The wild-card-round games.
 */
export function seedInitialBracket(seeds: Record<Conference, SeededOwner[]>): PlayoffGame[] {
  const games: PlayoffGame[] = [];
  for (const conf of CONFERENCES) {
    const bySeed = new Map<number, SeededOwner>();
    for (const s of seeds[conf]) bySeed.set(s.seed, s);
    // 2v7, 3v6, 4v5
    const pairs: [number, number][] = [
      [2, 7],
      [3, 6],
      [4, 5],
    ];
    for (const [hi, lo] of pairs) {
      const high = bySeed.get(hi);
      const low = bySeed.get(lo);
      if (!high || !low) continue;
      games.push(pairGame('wild_card', conf, high, low));
    }
  }
  return games;
}

/**
 * Resolve the winner of one completed playoff game.
 *
 * Precedence:
 *  1. Explicit `winnerOwnerSeasonId` (admin override / forfeit), if provided.
 *  2. Higher game points.
 *  3. On an exact points tie — per league rule — the owner with more
 *     REGULAR-SEASON Points For advances (`highRegularSeasonPointsFor` /
 *     `lowRegularSeasonPointsFor`).
 *  4. Final fallback (PF missing or also tied): the better (lower) seed.
 */
function resolveWinner(r: PlayoffGameResult): AdvancingOwner {
  let winnerId: number;
  if (r.winnerOwnerSeasonId !== undefined) {
    winnerId = r.winnerOwnerSeasonId;
  } else if (r.highPoints > r.lowPoints) {
    winnerId = r.highOwnerSeasonId;
  } else if (r.lowPoints > r.highPoints) {
    winnerId = r.lowOwnerSeasonId;
  } else {
    // Exact points tie → break by regular-season Points For, then by seed.
    const hiPf = r.highRegularSeasonPointsFor;
    const loPf = r.lowRegularSeasonPointsFor;
    if (hiPf !== undefined && loPf !== undefined && hiPf !== loPf) {
      winnerId = hiPf > loPf ? r.highOwnerSeasonId : r.lowOwnerSeasonId;
    } else {
      winnerId = r.highOwnerSeasonId; // better (lower) seed
    }
  }
  const seed = winnerId === r.highOwnerSeasonId ? r.highSeed : r.lowSeed;
  return { ownerSeasonId: winnerId, seed, conference: r.conference };
}

/**
 * Advance the bracket: given the results of `round`, produce the games of the
 * next round, applying NFL reseeding.
 *
 * Reseeding rule per conference: collect all advancing owners (plus the #1 seed
 * re-entering after the wild-card round), sort by ORIGINAL seed ascending, then
 * pair best-vs-worst inward (1st v last, 2nd v 2nd-last, ...).
 *
 * Round transitions:
 *  - `wild_card` → `divisional`: per conference, the 3 wild-card winners + the
 *    #1 seed (supplied via `byeSeeds`) are reseeded into 2 games.
 *  - `divisional` → `conference`: per conference, the 2 winners → 1 game.
 *  - `conference` → `championship`: the AFC & NFC champions → 1 cross-
 *    conference game (`conference: null`, seeds preserved for display).
 *
 * @param round    The round whose results are supplied.
 * @param results  The completed games of `round`.
 * @param byeSeeds Required only for the `wild_card → divisional` transition:
 *                 the #1 seed of each conference re-entering from its bye.
 * @returns The next round's games, or `[]` if `round` is the championship.
 */
export function advanceBracket(
  round: PlayoffRound,
  results: PlayoffGameResult[],
  byeSeeds?: Record<Conference, SeededOwner>,
): PlayoffGame[] {
  const next = nextRound(round);
  if (next === null) return [];

  const winners = results.map(resolveWinner);

  if (next === 'championship') {
    // Conference champions cross over. Expect exactly one winner per conference.
    const afc = winners.find((w) => w.conference === 'AFC');
    const nfc = winners.find((w) => w.conference === 'NFC');
    if (!afc || !nfc) return [];
    // Cross-conference: there is no shared seed ordering, so the lower seed
    // number is treated as the "high" slot purely for stable display.
    return [pairGame('championship', null, afc, nfc)];
  }

  // Intra-conference rounds: reseed within each conference.
  const games: PlayoffGame[] = [];
  for (const conf of CONFERENCES) {
    const advancing = winners.filter((w) => w.conference === conf);

    // Re-add the bye seed when moving out of the wild-card round.
    if (round === 'wild_card' && byeSeeds && byeSeeds[conf]) {
      const bye = byeSeeds[conf];
      advancing.push({ ownerSeasonId: bye.ownerSeasonId, seed: bye.seed, conference: conf });
    }

    if (advancing.length < 2) continue;

    // Reseed: best (lowest) seed first.
    const ordered = [...advancing].sort((a, b) => a.seed - b.seed);

    // Pair best-vs-worst inward.
    let lo = 0;
    let hi = ordered.length - 1;
    while (lo < hi) {
      games.push(pairGame(next, conf, ordered[lo], ordered[hi]));
      lo++;
      hi--;
    }
  }
  return games;
}
