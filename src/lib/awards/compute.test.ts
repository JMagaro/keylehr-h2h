/**
 * Unit tests for the season awards computation.
 *
 * The rules under test:
 *   - a payout tie is SPLIT EVENLY, one row per tied owner, summing to exactly the prize;
 *   - output does not depend on input order (the old code kept the first maximum from an
 *     unordered query, so a tie was resolved nondeterministically across runs);
 *   - "most regular-season points" comes from the standings engine, so it matches /standings;
 *   - weekly highs are capped to the regular season and skip byes and missed lineups;
 *   - payouts come from the season's own rules, not a global default.
 */
import { describe, it, expect } from 'vitest';
import {
  computeSeasonAwards,
  splitCents,
  type AwardScoreRow,
  type AwardStandingRow,
  type BracketOutcome,
  type ComputeAwardsParams,
} from './compute';
import { DEFAULT_SEASON_RULES } from '@/lib/rules/schema';

const NO_BRACKET: BracketOutcome = {
  championOwnerSeasonId: null,
  runnerUpOwnerSeasonId: null,
  thirdOwnerSeasonId: null,
  fourthOwnerSeasonId: null,
};

function score(ownerSeasonId: number, week: number, points: number | null, isBye = false): AwardScoreRow {
  return { ownerSeasonId, week, points, isBye };
}

function standing(ownerSeasonId: number, pointsFor: number): AwardStandingRow {
  return { ownerSeasonId, pointsFor };
}

function run(overrides: Partial<ComputeAwardsParams> = {}) {
  return computeSeasonAwards({
    scores: [],
    standings: [],
    bracket: NO_BRACKET,
    payouts: DEFAULT_SEASON_RULES.payouts,
    forfeits: new Set(),
    regularSeasonWeeks: 18,
    byeEligibleForWeeklyHigh: false,
    ...overrides,
  });
}

describe('splitCents', () => {
  it('splits evenly when it divides', () => {
    expect(splitCents(5000, 2)).toEqual([2500, 2500]);
  });

  it('distributes the remainder to the earliest shares and sums exactly', () => {
    const parts = splitCents(5000, 3);
    expect(parts).toEqual([1667, 1667, 1666]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(5000);
  });

  it('always sums to the original prize for any share count', () => {
    for (const total of [5000, 40000, 30000, 1]) {
      for (const shares of [1, 2, 3, 4, 7]) {
        expect(splitCents(total, shares).reduce((a, b) => a + b, 0)).toBe(total);
      }
    }
  });
});

describe('weekly high ties', () => {
  const scores = [score(1, 1, 168.42), score(2, 1, 168.42), score(3, 1, 150)];

  it('awards every tied owner instead of silently picking one', () => {
    const weekly = run({ scores }).filter((a) => a.type === 'weekly_high');
    expect(weekly.map((a) => a.ownerSeasonId).sort()).toEqual([1, 2]);
  });

  it('splits the prize so the total paid is unchanged', () => {
    const weekly = run({ scores }).filter((a) => a.type === 'weekly_high');
    expect(weekly.reduce((sum, a) => sum + a.amountCents, 0)).toBe(
      DEFAULT_SEASON_RULES.payouts.weeklyHighCents,
    );
    expect(weekly.map((a) => a.amountCents)).toEqual([2500, 2500]);
  });

  it('produces identical output for shuffled inputs', () => {
    // The original kept the first maximum from a query with no ORDER BY, so the winner of a
    // tie could change between runs of the same importer.
    const a = run({ scores });
    const b = run({ scores: [...scores].reverse() });
    const c = run({ scores: [scores[2], scores[0], scores[1]] });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(JSON.stringify(c)).toBe(JSON.stringify(a));
  });
});

describe('weekly high eligibility', () => {
  it('skips byes unless the season allows them', () => {
    const scores = [score(1, 1, 200, true), score(2, 1, 150)];
    expect(run({ scores }).find((a) => a.type === 'weekly_high')?.ownerSeasonId).toBe(2);
    expect(
      run({ scores, byeEligibleForWeeklyHigh: true }).find((a) => a.type === 'weekly_high')
        ?.ownerSeasonId,
    ).toBe(1);
  });

  it('skips a missed lineup even if it somehow posted the top score', () => {
    const scores = [score(1, 1, 200), score(2, 1, 150)];
    const awarded = run({ scores, forfeits: new Set(['1:1']) }).find(
      (a) => a.type === 'weekly_high',
    );
    expect(awarded?.ownerSeasonId).toBe(2);
  });

  it('ignores playoff weeks', () => {
    // Playoff scores live in the same table at weeks 19-22 and are written non-bye.
    const scores = [score(1, 20, 300), score(2, 5, 150)];
    const weekly = run({ scores }).filter((a) => a.type === 'weekly_high');
    expect(weekly).toHaveLength(1);
    expect(weekly[0].week).toBe(5);
  });

  it('honors a shorter weeklyHighWeeks payout window', () => {
    const payouts = { ...DEFAULT_SEASON_RULES.payouts, weeklyHighWeeks: 2 };
    const scores = [score(1, 1, 150), score(2, 3, 300)];
    const weekly = run({ scores, payouts }).filter((a) => a.type === 'weekly_high');
    expect(weekly.map((a) => a.week)).toEqual([1]);
  });
});

describe('season high', () => {
  it('is the best of the weekly highs', () => {
    const scores = [score(1, 1, 190), score(2, 2, 210), score(3, 3, 205)];
    const seasonHigh = run({ scores }).filter((a) => a.type === 'season_high');
    expect(seasonHigh).toHaveLength(1);
    expect(seasonHigh[0].ownerSeasonId).toBe(2);
    expect(seasonHigh[0].value).toBe('210.00');
  });

  it('splits when two weeks tie for the best score', () => {
    const scores = [score(1, 1, 210), score(2, 2, 210)];
    const seasonHigh = run({ scores }).filter((a) => a.type === 'season_high');
    expect(seasonHigh).toHaveLength(2);
    expect(seasonHigh.reduce((s, a) => s + a.amountCents, 0)).toBe(
      DEFAULT_SEASON_RULES.payouts.seasonHighCents,
    );
  });
});

describe('most regular-season points', () => {
  it('uses the standings Points For, matching /standings', () => {
    // Deliberately inconsistent with the raw scores below: the old code summed those, which
    // is how the $400 could go to someone other than the owner atop the standings.
    const standings = [standing(1, 2400.5), standing(2, 2399.9)];
    const scores = [score(2, 1, 9999)];
    const award = run({ standings, scores }).find((a) => a.type === 'most_points');
    expect(award?.ownerSeasonId).toBe(1);
    expect(award?.value).toBe('2400.50');
  });

  it('splits an exact tie', () => {
    const standings = [standing(1, 2400), standing(2, 2400)];
    const awards = run({ standings }).filter((a) => a.type === 'most_points');
    expect(awards).toHaveLength(2);
    expect(awards.reduce((s, a) => s + a.amountCents, 0)).toBe(
      DEFAULT_SEASON_RULES.payouts.mostRegularSeasonPointsCents,
    );
  });
});

describe('per-season payout overrides', () => {
  it('pays the season’s own configured amounts, not the defaults', () => {
    const payouts = { ...DEFAULT_SEASON_RULES.payouts, weeklyHighCents: 7500, championCents: 250000 };
    const awards = run({
      payouts,
      scores: [score(1, 1, 150)],
      bracket: { ...NO_BRACKET, championOwnerSeasonId: 9 },
    });
    expect(awards.find((a) => a.type === 'weekly_high')?.amountCents).toBe(7500);
    expect(awards.find((a) => a.type === 'champion')?.amountCents).toBe(250000);
  });
});

describe('placements', () => {
  it('emits only the slots the bracket resolved', () => {
    const awards = run({
      bracket: { championOwnerSeasonId: 1, runnerUpOwnerSeasonId: 2, thirdOwnerSeasonId: null, fourthOwnerSeasonId: null },
    });
    expect(awards.map((a) => a.type)).toEqual(['champion', 'runner_up']);
    expect(awards.every((a) => a.amountCents > 0)).toBe(true);
  });
});

describe('a season that has not been played', () => {
  it('awards nothing when every owner is still on zero points', () => {
    // Caught by a dry run against the live 2026 season: with no games played all 32 owners
    // are tied at 0, so the $400 "most points" prize was split 32 ways.
    const standings = Array.from({ length: 32 }, (_, i) => standing(i + 1, 0));
    expect(run({ standings })).toEqual([]);
  });

  it('still awards once a single owner has scored', () => {
    const standings = [standing(1, 120.5), standing(2, 0)];
    const award = run({ standings }).find((a) => a.type === 'most_points');
    expect(award?.ownerSeasonId).toBe(1);
  });
});
