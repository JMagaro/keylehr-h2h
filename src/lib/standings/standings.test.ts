/**
 * Unit tests for computeStandings — W-L-T, PF/PA, winPct (ties = half a win),
 * streak, and the rules around isFinal / isPlayoff / explicit winners.
 */
import { describe, it, expect } from 'vitest';
import { computeStandings } from './standings';
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
  homePts: number | null,
  awayPts: number | null,
  extra: Partial<MatchupResult> = {},
): MatchupResult {
  return {
    week,
    isPlayoff: false,
    isFinal: true,
    homeOwnerSeasonId: home,
    awayOwnerSeasonId: away,
    homePoints: homePts,
    awayPoints: awayPts,
    ...extra,
  };
}

function rowFor(rows: ReturnType<typeof computeStandings>, id: number) {
  return rows.find((r) => r.ownerSeasonId === id)!;
}

describe('computeStandings — basic W-L-T', () => {
  it('tallies wins, losses, PF and PA from points', () => {
    const entries = [owner(1), owner(2)];
    const results = [
      game(1, 1, 2, 100, 90), // 1 beats 2
      game(2, 2, 1, 80, 70), // 2 beats 1
      game(3, 1, 2, 110, 50), // 1 beats 2
    ];
    const rows = computeStandings(entries, results);

    const r1 = rowFor(rows, 1);
    expect(r1.wins).toBe(2);
    expect(r1.losses).toBe(1);
    expect(r1.ties).toBe(0);
    expect(r1.gamesPlayed).toBe(3);
    expect(r1.pointsFor).toBe(280); // 100 + 70 + 110
    expect(r1.pointsAgainst).toBe(220); // 90 + 80 + 50
    expect(r1.winPct).toBeCloseTo(2 / 3, 5);

    const r2 = rowFor(rows, 2);
    expect(r2.wins).toBe(1);
    expect(r2.losses).toBe(2);
    expect(r2.pointsFor).toBe(220);
    expect(r2.pointsAgainst).toBe(280);
  });

  it('returns a row for every owner, even with zero games', () => {
    const rows = computeStandings([owner(1), owner(2), owner(3)], []);
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.gamesPlayed).toBe(0);
      expect(r.winPct).toBe(0);
      expect(r.streak).toBe('');
    }
  });
});

describe('computeStandings — ties count as half a win', () => {
  it('records a tie when points are equal and weights winPct by 0.5', () => {
    const entries = [owner(1), owner(2)];
    const results = [
      game(1, 1, 2, 100, 100), // tie
      game(2, 1, 2, 120, 80), // 1 wins
    ];
    const rows = computeStandings(entries, results);
    const r1 = rowFor(rows, 1);
    expect(r1.wins).toBe(1);
    expect(r1.ties).toBe(1);
    expect(r1.losses).toBe(0);
    // (1 + 0.5*1) / 2 = 0.75
    expect(r1.winPct).toBeCloseTo(0.75, 5);

    const r2 = rowFor(rows, 2);
    expect(r2.ties).toBe(1);
    expect(r2.losses).toBe(1);
    expect(r2.winPct).toBeCloseTo(0.25, 5);
  });
});

describe('computeStandings — counting rules', () => {
  it('ignores non-final results', () => {
    const rows = computeStandings(
      [owner(1), owner(2)],
      [game(1, 1, 2, 100, 90, { isFinal: false })],
    );
    expect(rowFor(rows, 1).gamesPlayed).toBe(0);
  });

  it('ignores playoff results', () => {
    const rows = computeStandings(
      [owner(1), owner(2)],
      [game(1, 1, 2, 100, 90, { isPlayoff: true })],
    );
    expect(rowFor(rows, 1).gamesPlayed).toBe(0);
  });

  it('ignores derived games missing a score', () => {
    const rows = computeStandings([owner(1), owner(2)], [game(1, 1, 2, 100, null)]);
    expect(rowFor(rows, 1).gamesPlayed).toBe(0);
  });
});

describe('computeStandings — explicit winner (override / forfeit)', () => {
  it('honors an explicit winner even when points say otherwise', () => {
    const rows = computeStandings(
      [owner(1), owner(2)],
      [game(1, 1, 2, 50, 100, { winnerOwnerSeasonId: 1 })], // forfeit: 1 wins despite fewer pts
    );
    expect(rowFor(rows, 1).wins).toBe(1);
    expect(rowFor(rows, 2).losses).toBe(1);
    // Points still accrue.
    expect(rowFor(rows, 1).pointsFor).toBe(50);
    expect(rowFor(rows, 2).pointsFor).toBe(100);
  });

  it('treats explicit null winner as a tie', () => {
    const rows = computeStandings(
      [owner(1), owner(2)],
      [game(1, 1, 2, 50, 100, { winnerOwnerSeasonId: null })],
    );
    expect(rowFor(rows, 1).ties).toBe(1);
    expect(rowFor(rows, 2).ties).toBe(1);
  });

  it('counts a forfeit with null points as 0-0', () => {
    const rows = computeStandings(
      [owner(1), owner(2)],
      [game(1, 1, 2, null, null, { winnerOwnerSeasonId: 2 })],
    );
    expect(rowFor(rows, 2).wins).toBe(1);
    expect(rowFor(rows, 1).pointsFor).toBe(0);
  });
});

describe('computeStandings — streak', () => {
  it('reports a multi-game win streak', () => {
    const entries = [owner(1), owner(2)];
    const results = [
      game(1, 1, 2, 100, 90),
      game(2, 1, 2, 100, 90),
      game(3, 1, 2, 100, 90),
    ];
    const rows = computeStandings(entries, results);
    expect(rowFor(rows, 1).streak).toBe('W3');
    expect(rowFor(rows, 2).streak).toBe('L3');
  });

  it('resets the streak when the latest outcome changes', () => {
    const entries = [owner(1), owner(2)];
    const results = [
      game(1, 1, 2, 100, 90), // 1 W
      game(2, 1, 2, 100, 90), // 1 W
      game(3, 1, 2, 80, 120), // 1 L
    ];
    const rows = computeStandings(entries, results);
    expect(rowFor(rows, 1).streak).toBe('L1');
    expect(rowFor(rows, 2).streak).toBe('W1');
  });

  it('reports a tie streak', () => {
    const rows = computeStandings(
      [owner(1), owner(2)],
      [game(1, 1, 2, 90, 90)],
    );
    expect(rowFor(rows, 1).streak).toBe('T1');
  });

  it('orders streak by week regardless of input ordering', () => {
    const entries = [owner(1), owner(2)];
    // Provided out of order; week 3 (a loss for 1) is the latest.
    const results = [
      game(3, 1, 2, 70, 120),
      game(1, 1, 2, 100, 90),
      game(2, 1, 2, 100, 90),
    ];
    const rows = computeStandings(entries, results);
    expect(rowFor(rows, 1).streak).toBe('L1');
  });
});
