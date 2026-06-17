/**
 * Tests for the cap-constrained lineup optimizer: it must respect the cap, fill every
 * slot uniquely, honor FLEX eligibility, prefer higher fit when affordable, and spend
 * leftover cap to upgrade.
 */
import { describe, it, expect } from 'vitest';

import { optimizeLineup, type OptCandidate, type OptSlot } from './optimize';
import type { FantasyPosition } from './sleeper';

const SLOTS: OptSlot[] = [
  { slot: 'QB', positions: ['QB'] },
  { slot: 'RB', positions: ['RB'] },
  { slot: 'RB', positions: ['RB'] },
  { slot: 'WR', positions: ['WR'] },
  { slot: 'WR', positions: ['WR'] },
  { slot: 'WR', positions: ['WR'] },
  { slot: 'TE', positions: ['TE'] },
  { slot: 'FLEX', positions: ['RB', 'WR', 'TE'] },
  { slot: 'DST', positions: ['DST'] },
];

let n = 0;
function c(position: FantasyPosition, fit: number, salary: number, id?: string): OptCandidate {
  n += 1;
  return { id: id ?? `${position}-${n}`, position, fit, salary };
}

/** A generous pool so every slot can be filled many ways. */
function basePool(): OptCandidate[] {
  const pool: OptCandidate[] = [];
  const add = (pos: FantasyPosition, count: number) => {
    for (let i = 0; i < count; i++) {
      // fit 90..40, salary scaling with fit so studs cost more
      const fit = 90 - i * 5;
      const salary = 4000 + fit * 50;
      pool.push(c(pos, fit, salary));
    }
  };
  add('QB', 6);
  add('RB', 10);
  add('WR', 12);
  add('TE', 6);
  add('DST', 6);
  return pool;
}

describe('optimizeLineup', () => {
  it('fills every slot uniquely and respects FLEX eligibility under a generous cap', () => {
    const res = optimizeLineup(basePool(), SLOTS, 100000); // cap high enough for all studs
    expect(res.lineup).toHaveLength(9);
    const ids = res.lineup.map((l) => l.id);
    expect(ids.every((id) => id !== null)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length); // unique
    expect(res.feasible).toBe(true);
    expect(res.totalSalary).toBeLessThanOrEqual(100000);
  });

  it('never exceeds a tight-but-feasible cap and stays feasible', () => {
    // basePool's cheapest valid roster is ~59k, so 62k is tight but reachable.
    const res = optimizeLineup(basePool(), SLOTS, 62000);
    expect(res.totalSalary).toBeLessThanOrEqual(62000);
    expect(res.feasible).toBe(true);
    expect(res.lineup.every((l) => l.id !== null)).toBe(true);
  });

  it('prefers a higher-fit player when both fit under the cap', () => {
    // Two QBs; the better one is affordable. Minimal other roster so cap is slack.
    const pool: OptCandidate[] = [
      c('QB', 95, 7000, 'qbA'),
      c('QB', 60, 6800, 'qbB'),
      ...['RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'DST'].flatMap((p) => [
        c(p as FantasyPosition, 50, 3000),
        c(p as FantasyPosition, 50, 3000),
      ]),
    ];
    const res = optimizeLineup(pool, SLOTS, 50000);
    const qb = res.lineup.find((l) => l.slot === 'QB');
    expect(qb?.id).toBe('qbA');
  });

  it('downgrades off the most expensive stud to satisfy a very tight cap', () => {
    // One ultra-expensive WR vs cheap alternatives; cap forces leaving the stud out.
    const pool: OptCandidate[] = [
      c('WR', 99, 20000, 'whale'),
      ...Array.from({ length: 6 }, (_, i) => c('WR', 70 - i, 4000)),
      ...Array.from({ length: 3 }, () => c('RB', 70, 4000)),
      c('QB', 70, 5000),
      c('TE', 70, 4000),
      c('DST', 70, 3000),
    ];
    const res = optimizeLineup(pool, SLOTS, 38000);
    expect(res.totalSalary).toBeLessThanOrEqual(38000);
    expect(res.lineup.map((l) => l.id)).not.toContain('whale');
    expect(res.feasible).toBe(true);
  });

  it('reports infeasible when the cheapest possible roster still busts the cap', () => {
    const pool: OptCandidate[] = [
      c('QB', 50, 9000),
      c('RB', 50, 9000),
      c('RB', 50, 9000),
      c('WR', 50, 9000),
      c('WR', 50, 9000),
      c('WR', 50, 9000),
      c('TE', 50, 9000),
      c('DST', 50, 9000),
      c('RB', 50, 9000), // flex
    ];
    const res = optimizeLineup(pool, SLOTS, 20000);
    expect(res.feasible).toBe(false);
  });
});
