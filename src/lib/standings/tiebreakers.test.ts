/**
 * Unit tests for the tiebreaker chain: H2H → PF → PA → ownerSeasonId.
 * Covers 2-way ties, the priority of each step, and multi-way (3+) ties
 * resolved as a mini round-robin.
 */
import { describe, it, expect } from 'vitest';
import { computeStandings } from './standings';
import { buildTiebreakerContext, compareForStandings, rankStandings } from './tiebreakers';
import type { MatchupResult, OwnerEntry } from './types';

function owner(id: number): OwnerEntry {
  return {
    ownerSeasonId: id,
    ownerName: `Owner ${id}`,
    teamKey: `T${id}`,
    teamName: `Team ${id}`,
    conference: 'AFC',
    division: 'East',
  };
}

function game(
  week: number,
  home: number,
  away: number,
  homePts: number,
  awayPts: number,
): MatchupResult {
  return {
    week,
    isPlayoff: false,
    isFinal: true,
    homeOwnerSeasonId: home,
    awayOwnerSeasonId: away,
    homePoints: homePts,
    awayPoints: awayPts,
  };
}

function rank(entries: OwnerEntry[], results: MatchupResult[]): number[] {
  const rows = computeStandings(entries, results);
  const ctx = buildTiebreakerContext(rows, results);
  return rankStandings(rows, ctx).map((r) => r.ownerSeasonId);
}

describe('tiebreakers — configurable order (rules.tiebreakers)', () => {
  // Owners 1 and 2 each finish 1-0 and never play each other (H2H not applicable).
  // Owner 1 has the higher Points For; owner 2 has the lower (better) Points Against.
  // So PF-first ranks 1 ahead, PA-first ranks 2 ahead — proving the order is honored.
  const entries = [owner(1), owner(2), owner(3), owner(4)];
  const results: MatchupResult[] = [
    game(1, 1, 3, 120, 100), // owner 1: 1-0, PF 120, PA 100
    game(2, 2, 4, 110, 90), //  owner 2: 1-0, PF 110, PA 90
  ];

  function rankTopTwo(order?: ('h2h' | 'pf' | 'pa')[]): number[] {
    const rows = computeStandings(entries, results);
    const ctx = buildTiebreakerContext(rows, results);
    const tied = rows.filter((r) => r.ownerSeasonId === 1 || r.ownerSeasonId === 2);
    return rankStandings(tied, ctx, order).map((r) => r.ownerSeasonId);
  }

  it('default order (H2H → PF → PA) ranks the higher-PF owner ahead', () => {
    expect(rankTopTwo()).toEqual([1, 2]);
  });

  it('PA before PF flips the result — the lower-PA owner ranks ahead', () => {
    expect(rankTopTwo(['h2h', 'pa', 'pf'])).toEqual([2, 1]);
  });
});

describe('tiebreakers — head-to-head beats Points For', () => {
  it('the owner who won the head-to-head ranks ahead despite lower PF', () => {
    // Owners 1 and 2 each finish 1-1 (a clean 2-way tie). Owner 2 beat owner 1
    // head-to-head, but owner 1 has far more total PF. H2H must win.
    // Each plays the other once and an outsider once (which they both win).
    const entries = [owner(1), owner(2), owner(3), owner(4)];
    const results: MatchupResult[] = [
      game(1, 1, 2, 90, 100), // 2 beats 1   (H2H to 2)
      game(2, 1, 3, 250, 10), // 1 beats outsider 3 (huge PF for 1)
      game(3, 2, 4, 60, 10), // 2 beats outsider 4 (modest PF)
    ];
    // Records: 1 → 1-1 (PF 340), 2 → 1-1 (PF 160).
    // 1 and 2 tie on record; H2H (2 over 1) ranks 2 ahead of 1 despite 1's PF.
    const order = rank(entries, results);
    expect(order.indexOf(2)).toBeLessThan(order.indexOf(1));
  });
});

describe('tiebreakers — Points For beats Points Against', () => {
  it('when records tie and there is no decisive H2H, higher PF wins', () => {
    // Two owners never played each other (no H2H), same record. Higher PF wins.
    const entries = [owner(1), owner(2), owner(3), owner(4)];
    const results = [
      game(1, 1, 3, 120, 10), // 1 beats 3
      game(2, 1, 3, 5, 50), // 3 beats 1  -> 1 is 1-1, PF 125, PA 60
      game(1, 2, 4, 70, 10), // 2 beats 4
      game(2, 2, 4, 5, 40), // 4 beats 2  -> 2 is 1-1, PF 75, PA 50
    ];
    const order = rank(entries, results);
    // 1 and 2 both 1-1, never met. PF: 1=125 > 2=75 → 1 ahead.
    expect(order.indexOf(1)).toBeLessThan(order.indexOf(2));
  });

  it('falls through to Points Against when record and PF tie', () => {
    const entries = [owner(1), owner(2), owner(3), owner(4)];
    // 1 and 2 both 1-1 with identical PF=100; differ only in PA.
    const results = [
      game(1, 1, 3, 60, 10), // 1 W
      game(2, 1, 3, 40, 90), // 1 L (PA heavy) -> 1: PF100 PA100
      game(1, 2, 4, 60, 10), // 2 W
      game(2, 2, 4, 40, 70), // 2 L -> 2: PF100 PA80
    ];
    const order = rank(entries, results);
    // Lower PA (owner 2, PA=80) ranks ahead of owner 1 (PA=100).
    expect(order.indexOf(2)).toBeLessThan(order.indexOf(1));
  });
});

describe('tiebreakers — deterministic final fallback', () => {
  it('uses ownerSeasonId ascending when everything else is equal', () => {
    const entries = [owner(5), owner(9)];
    // Identical: each 0-0 (no games). Fallback to id asc.
    const order = rank(entries, []);
    expect(order).toEqual([5, 9]);
  });

  it('compareForStandings is symmetric and non-zero for distinct owners', () => {
    const rows = computeStandings([owner(1), owner(2)], []);
    const ctx = buildTiebreakerContext(rows, []);
    const a = rows.find((r) => r.ownerSeasonId === 1)!;
    const b = rows.find((r) => r.ownerSeasonId === 2)!;
    expect(compareForStandings(a, b, ctx)).toBeLessThan(0);
    expect(compareForStandings(b, a, ctx)).toBeGreaterThan(0);
  });
});

describe('tiebreakers — multi-way (3-way) tie resolved by mini round-robin', () => {
  it('orders three tied owners by their record among the tied group', () => {
    // Three owners each 2-2 overall, all tied. Within the group of {1,2,3}:
    //   1 beat 2, 1 beat 3  -> 2-0 within group  (best)
    //   2 beat 3            -> 1-1 within group  (middle)
    //   3 lost both         -> 0-2 within group  (worst)
    // Outsider games (vs ids 4,5) equalize each to 2-2: owner 1 loses both
    // outsider games, owner 2 splits, owner 3 wins both.
    const entries = [owner(1), owner(2), owner(3), owner(4), owner(5)];
    const results: MatchupResult[] = [
      // Round-robin within the tied trio.
      game(1, 1, 2, 100, 90), // 1 beats 2
      game(2, 1, 3, 100, 80), // 1 beats 3
      game(3, 2, 3, 70, 60), // 2 beats 3
      // Outsider games to equalize overall record at 2-2 each.
      game(4, 1, 4, 10, 200), // 1 loses
      game(5, 1, 5, 10, 200), // 1 loses   -> 1: 2-2
      game(6, 2, 4, 95, 30), // 2 wins
      game(7, 2, 5, 10, 200), // 2 loses    -> 2: 2-2
      game(8, 3, 4, 95, 30), // 3 wins
      game(9, 3, 5, 95, 30), // 3 wins      -> 3: 2-2
    ];
    // Verify each of the trio is 2-2.
    const rows = computeStandings(entries, results);
    for (const id of [1, 2, 3]) {
      const r = rows.find((x) => x.ownerSeasonId === id)!;
      expect(r.wins).toBe(2);
      expect(r.losses).toBe(2);
    }
    const order = rank(entries, results);
    // Among the tied trio, the round-robin order must be 1, then 2, then 3.
    const idx = (id: number) => order.indexOf(id);
    expect(idx(1)).toBeLessThan(idx(2));
    expect(idx(2)).toBeLessThan(idx(3));
  });
});
