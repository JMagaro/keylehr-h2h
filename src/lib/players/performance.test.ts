/**
 * Tests for the pure grading math: actual lineup scoring, players-graded counting, and the
 * hindsight-optimal / chalk baselines (salary mode only).
 */
import { describe, it, expect } from 'vitest';

import { gradeSnapshot, type SnapshotPick, type SnapshotPoolPlayer } from './grade';

function pick(playerId: string, position: string, salary: number | null, fit = 50): SnapshotPick {
  return { slot: position, playerId, name: playerId, position, teamKey: 'XX', fit, salary };
}
function pool(playerId: string, position: string, salary: number | null, fit = 50): SnapshotPoolPlayer {
  return { playerId, position, salary, fit };
}

/** A full 9-man lineup of distinct ids. */
function lineup9(salary: number | null): SnapshotPick[] {
  return [
    pick('qb', 'QB', salary),
    pick('rb1', 'RB', salary),
    pick('rb2', 'RB', salary),
    pick('wr1', 'WR', salary),
    pick('wr2', 'WR', salary),
    pick('wr3', 'WR', salary),
    pick('te', 'TE', salary),
    pick('flex', 'RB', salary),
    pick('dst', 'DST', salary),
  ];
}

describe('gradeSnapshot', () => {
  it('sums actual points for the rostered players and counts those with stats', () => {
    const lineup = lineup9(null); // signal mode (no salaries)
    const actuals = new Map<string, number>([
      ['qb', 25],
      ['rb1', 10],
      ['wr1', 18],
      // others missing → 0 and not counted as graded
    ]);
    const g = gradeSnapshot(lineup, [], 50000, actuals);
    expect(g.actualPoints).toBeCloseTo(53);
    expect(g.playersGraded).toBe(3);
    expect(g.optimalPoints).toBeNull(); // no salaries → no cap baseline
    expect(g.chalkPoints).toBeNull();
  });

  it('computes the hindsight-optimal and chalk baselines in salary mode', () => {
    // Lineup all cost 5000 (sums to 45000 ≤ 50k). Pool has a cheap stud who outscores
    // an expensive bust, so optimal > our lineup and chalk picks the expensive bust.
    const lineup = lineup9(5000);
    // Pool: include the rostered 9 plus, at WR, a cheap stud and an expensive bust.
    const p: SnapshotPoolPlayer[] = [
      pool('qb', 'QB', 5000),
      pool('rb1', 'RB', 5000),
      pool('rb2', 'RB', 5000),
      pool('wr1', 'WR', 5000),
      pool('wr2', 'WR', 5000),
      pool('wr3', 'WR', 5000),
      pool('te', 'TE', 5000),
      pool('flex', 'RB', 5000),
      pool('dst', 'DST', 5000),
      pool('cheapStud', 'WR', 4000),
      pool('pricyBust', 'WR', 9000),
    ];
    const actuals = new Map<string, number>([
      ['qb', 20],
      ['rb1', 10],
      ['rb2', 10],
      ['wr1', 8],
      ['wr2', 8],
      ['wr3', 8],
      ['te', 6],
      ['flex', 10],
      ['dst', 6],
      ['cheapStud', 40], // huge actual, cheap
      ['pricyBust', 1], // expensive, scored nothing
    ]);
    const g = gradeSnapshot(lineup, p, 50000, actuals);
    // Our lineup actual = 20+10+10+8+8+8+6+10+6 = 86
    expect(g.actualPoints).toBeCloseTo(86);
    // Optimal should swap a WR for the cheap stud → strictly better than 86.
    expect(g.optimalPoints).not.toBeNull();
    expect(g.optimalPoints!).toBeGreaterThan(86);
    // Chalk (pay up) would roster the pricy bust → drags its actual below optimal.
    expect(g.chalkPoints).not.toBeNull();
    expect(g.chalkPoints!).toBeLessThan(g.optimalPoints!);
  });
});
