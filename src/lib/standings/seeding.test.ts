/**
 * Unit tests for division standings & conference seeding.
 *
 * Fixture design notes
 * --------------------
 * `computeStandings` (correctly) ignores any matchup that references an owner
 * not present in `entries`. So every game in these fixtures uses REAL entries.
 * We add four "doormat" owners per conference whose only role is to be beaten;
 * they absorb wins/losses and finish far below every real contender, so they
 * never win a division or claim a wild-card slot. Each contender's exact win
 * total is forced via explicit `winnerOwnerSeasonId`, so assertions are precise.
 */
import { describe, it, expect } from 'vitest';
import { computeConferenceSeeds, computeDivisionStandings } from './seeding';
import type { Conference, Division, MatchupResult, OwnerEntry, PlayoffConfig } from './types';

const DIVS: Division[] = ['East', 'North', 'South', 'West'];

/** Doormat owner ids per conference (one per division). */
const AFC_DOORMATS = [200, 201, 202, 203];
const NFC_DOORMATS = [300, 301, 302, 303];

/**
 * Build both conferences: 16 real contenders each (4 per division) plus 4
 * doormats each. AFC contender ids 1..16, NFC 101..116.
 */
function buildEntries(): OwnerEntry[] {
  const entries: OwnerEntry[] = [];
  const make = (id: number, conf: Conference, div: Division) =>
    entries.push({
      ownerSeasonId: id,
      ownerName: `O${id}`,
      teamKey: `T${id}`,
      teamName: `Team ${id}`,
      conference: conf,
      division: div,
    });

  let id = 1;
  for (const div of DIVS) for (let i = 0; i < 4; i++) make(id++, 'AFC', div);
  id = 101;
  for (const div of DIVS) for (let i = 0; i < 4; i++) make(id++, 'NFC', div);

  DIVS.forEach((div, i) => make(AFC_DOORMATS[i], 'AFC', div));
  DIVS.forEach((div, i) => make(NFC_DOORMATS[i], 'NFC', div));
  return entries;
}

/**
 * A tiny schedule builder. `win(a, b)` records a final regular-season game in
 * which `a` beats `b` (explicit winner, so points are irrelevant). Weeks are
 * auto-incremented per home owner so the (week, home) uniqueness never clashes
 * within one owner's slate.
 */
class Schedule {
  private games: MatchupResult[] = [];
  private weekByOwner = new Map<number, number>();

  private nextWeek(owner: number): number {
    const w = (this.weekByOwner.get(owner) ?? 0) + 1;
    this.weekByOwner.set(owner, w);
    return w;
  }

  /** `a` beats `b`. */
  win(a: number, b: number): this {
    this.games.push({
      week: Math.max(this.nextWeek(a), this.nextWeek(b)),
      isPlayoff: false,
      isFinal: true,
      homeOwnerSeasonId: a,
      awayOwnerSeasonId: b,
      homePoints: 100,
      awayPoints: 50,
      winnerOwnerSeasonId: a,
    });
    return this;
  }

  /** `owner` beats the given doormat `n` times. */
  beatsDoormat(owner: number, doormat: number, n: number): this {
    for (let i = 0; i < n; i++) this.win(owner, doormat);
    return this;
  }

  /**
   * `owner` loses `n` games to `crusher` (a real owner). Losses are routed to a
   * powerhouse rather than a doormat on purpose: doormats must NEVER accumulate
   * wins, or one could win its own division and break the fixture. The crusher
   * is always an owner that already outranks `owner`, so the loss is harmless to
   * the intended ordering.
   */
  losesTo(owner: number, crusher: number, n: number): this {
    for (let i = 0; i < n; i++) this.win(crusher, owner);
    return this;
  }

  build(): MatchupResult[] {
    return this.games;
  }
}

describe('computeDivisionStandings', () => {
  it('ranks a division best-record first', () => {
    const entries = buildEntries();
    // AFC East contenders = 1,2,3,4. Give strictly descending win totals; all
    // wins come from beating the East doormat (200), zero losses.
    const s = new Schedule();
    s.beatsDoormat(1, 200, 5);
    s.beatsDoormat(2, 200, 4);
    s.beatsDoormat(3, 200, 3);
    s.beatsDoormat(4, 200, 2);
    const div = computeDivisionStandings(entries, s.build(), 'AFC', 'East');
    // Doormat 200 (0-14) must sink to the bottom; the four contenders lead.
    expect(div.slice(0, 4).map((r) => r.ownerSeasonId)).toEqual([1, 2, 3, 4]);
    expect(div[0].conference).toBe('AFC');
    expect(div[0].division).toBe('East');
    expect(div[div.length - 1].ownerSeasonId).toBe(200); // doormat last
  });
});

describe('computeConferenceSeeds — division winners & wild cards', () => {
  it('seeds 4 division winners 1-4 and 3 wild cards 5-7 with #1 bye', () => {
    const entries = buildEntries();
    const s = new Schedule();

    // Division winners, descending so they seed 1>2>3>4:
    //   East winner  = 1  (12-0)
    //   North winner = 5  (11-0)
    //   South winner = 9  (10-0)
    //   West winner  = 13 ( 9-0)
    s.beatsDoormat(1, 200, 12);
    s.beatsDoormat(5, 201, 11);
    s.beatsDoormat(9, 202, 10);
    s.beatsDoormat(13, 203, 9);

    // Wild-card contenders (non-winners): 2 (10-2), 6 (9-2), 3 (8-2). These are
    // the best three non-winners → seeds 5,6,7 in that order. Losses are routed
    // to the conference powerhouse (owner 1) so no doormat ever wins.
    s.beatsDoormat(2, 200, 10).losesTo(2, 1, 2);
    s.beatsDoormat(6, 201, 9).losesTo(6, 1, 2);
    s.beatsDoormat(3, 200, 8).losesTo(3, 1, 2);

    // Also-rans that must NOT reach the wild-card top 3 (weaker records).
    s.beatsDoormat(10, 202, 4).losesTo(10, 1, 8); // 4-8
    s.beatsDoormat(14, 203, 3).losesTo(14, 1, 9); // 3-9

    const seeds = computeConferenceSeeds(entries, s.build());
    const afc = seeds.AFC;

    expect(afc).toHaveLength(7);
    expect(afc.map((x) => x.seed)).toEqual([1, 2, 3, 4, 5, 6, 7]);

    expect(afc[0]).toMatchObject({ seed: 1, ownerSeasonId: 1, kind: 'division_winner', isBye: true });
    expect(afc[1]).toMatchObject({ seed: 2, ownerSeasonId: 5, kind: 'division_winner', isBye: false });
    expect(afc[2]).toMatchObject({ seed: 3, ownerSeasonId: 9, kind: 'division_winner' });
    expect(afc[3]).toMatchObject({ seed: 4, ownerSeasonId: 13, kind: 'division_winner' });

    expect(afc[4]).toMatchObject({ seed: 5, ownerSeasonId: 2, kind: 'wild_card', isBye: false });
    expect(afc[5]).toMatchObject({ seed: 6, ownerSeasonId: 6, kind: 'wild_card' });
    expect(afc[6]).toMatchObject({ seed: 7, ownerSeasonId: 3, kind: 'wild_card' });

    expect(afc.filter((x) => x.isBye).map((x) => x.seed)).toEqual([1]);
  });

  it('a division winner with a worse record than a wild card still seeds 1-4', () => {
    // The South winner (id 9) is weak (4-8) yet must still seed top-4, because
    // division winners always outrank wild cards regardless of record.
    const entries = buildEntries();
    const s = new Schedule();
    // East winner (1) is the powerhouse and takes everyone's losses, so it has
    // no losses of its own. Other winners lose to owner 1.
    s.beatsDoormat(1, 200, 11);
    s.beatsDoormat(5, 201, 10).losesTo(5, 1, 2); // North winner 10-2
    s.beatsDoormat(9, 202, 4).losesTo(9, 1, 8); // South winner 4-8 (weak)
    s.beatsDoormat(13, 203, 9).losesTo(13, 1, 3); // West winner 9-3
    // Strong wild cards (all better than the South winner).
    s.beatsDoormat(2, 200, 10).losesTo(2, 1, 2);
    s.beatsDoormat(6, 201, 9).losesTo(6, 1, 3);
    s.beatsDoormat(14, 203, 8).losesTo(14, 1, 4);

    const afc = computeConferenceSeeds(entries, s.build()).AFC;
    const weakWinner = afc.find((x) => x.ownerSeasonId === 9)!;
    expect(weakWinner.kind).toBe('division_winner');
    expect(weakWinner.seed).toBeLessThanOrEqual(4);
    for (const x of afc.filter((y) => y.kind === 'wild_card')) {
      expect(x.seed).toBeGreaterThanOrEqual(5);
    }
  });

  it('produces a full 7-seed field for both conferences', () => {
    const entries = buildEntries();
    const s = new Schedule();
    // Give each division's first contender a win so a clear winner exists.
    [1, 5, 9, 13].forEach((id, i) => s.beatsDoormat(id, AFC_DOORMATS[i], 5 - i + 1));
    [101, 105, 109, 113].forEach((id, i) => s.beatsDoormat(id, NFC_DOORMATS[i], 5 - i + 1));
    const seeds = computeConferenceSeeds(entries, s.build());
    expect(seeds.AFC).toHaveLength(7);
    expect(seeds.NFC).toHaveLength(7);
    expect(seeds.AFC.every((x) => x.conference === 'AFC')).toBe(true);
    expect(seeds.NFC.every((x) => x.conference === 'NFC')).toBe(true);
    // Exactly one bye per conference, on seed 1.
    expect(seeds.AFC.filter((x) => x.isBye).map((x) => x.seed)).toEqual([1]);
    expect(seeds.NFC.filter((x) => x.isBye).map((x) => x.seed)).toEqual([1]);
  });
});

describe('computeConferenceSeeds — config-driven structure', () => {
  /** A non-default format: 6 teams / 4 division winners / 2 wild cards / 2 byes. */
  const SIX_TEAM: PlayoffConfig = {
    teamsPerConference: 6,
    divisionWinnersPerConference: 4,
    wildCardsPerConference: 2,
    topSeedByes: 2,
  };

  it('honors a 6-team / 2-bye format: 4 winners + 2 wild cards, byes on seeds 1-2', () => {
    const entries = buildEntries();
    const s = new Schedule();

    // Division winners, descending so they seed 1>2>3>4.
    s.beatsDoormat(1, 200, 12);
    s.beatsDoormat(5, 201, 11);
    s.beatsDoormat(9, 202, 10);
    s.beatsDoormat(13, 203, 9);
    // Wild-card contenders — best two become seeds 5,6; the third is excluded.
    s.beatsDoormat(2, 200, 10).losesTo(2, 1, 2); // seed 5
    s.beatsDoormat(6, 201, 9).losesTo(6, 1, 2); // seed 6
    s.beatsDoormat(3, 200, 8).losesTo(3, 1, 2); // excluded (only 2 WC slots)

    const afc = computeConferenceSeeds(entries, s.build(), SIX_TEAM).AFC;

    // Field size is exactly teamsPerConference.
    expect(afc).toHaveLength(6);
    expect(afc.map((x) => x.seed)).toEqual([1, 2, 3, 4, 5, 6]);

    // 4 division winners, 2 wild cards.
    expect(afc.filter((x) => x.kind === 'division_winner').map((x) => x.seed)).toEqual([1, 2, 3, 4]);
    expect(afc.filter((x) => x.kind === 'wild_card').map((x) => x.seed)).toEqual([5, 6]);

    // TWO byes now, on seeds 1 and 2.
    expect(afc.filter((x) => x.isBye).map((x) => x.seed)).toEqual([1, 2]);

    // The third-best wild card (owner 3) did not make the smaller field.
    expect(afc.some((x) => x.ownerSeasonId === 3)).toBe(false);
  });

  it('defaults to the 7/4/3/1 format when no config is passed', () => {
    const entries = buildEntries();
    const s = new Schedule();
    [1, 5, 9, 13].forEach((id, i) => s.beatsDoormat(id, AFC_DOORMATS[i], 5 - i + 1));
    const afc = computeConferenceSeeds(entries, s.build()).AFC;
    expect(afc).toHaveLength(7);
    expect(afc.filter((x) => x.isBye).map((x) => x.seed)).toEqual([1]);
  });
});
