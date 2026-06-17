/**
 * Pure grading math for lineup-model snapshots — no DB/network, so it is unit-testable.
 * Used by performance.ts (which adds the DB + Sleeper-stats I/O around it).
 */
import { LINEUP_SLOTS } from './recommend';
import { optimizeLineup, type OptCandidate } from './optimize';

export interface SnapshotPick {
  slot: string;
  playerId: string;
  name: string;
  position: string;
  teamKey: string;
  fit: number;
  salary: number | null;
}

export interface SnapshotPoolPlayer {
  playerId: string;
  position: string;
  salary: number | null;
  fit: number;
}

export interface SnapshotGrade {
  /** Actual points the recommended lineup scored. */
  actualPoints: number;
  /** Hindsight-best points from the considered pool under the cap (null in signal mode). */
  optimalPoints: number | null;
  /** Points a naive "pay up" (most-expensive) lineup from the pool scored (null in signal mode). */
  chalkPoints: number | null;
  /** How many of the rostered players had an actual stat line. */
  playersGraded: number;
  meta: { perPlayer: { playerId: string; actual: number }[] };
}

const sumActuals = (ids: string[], actuals: Map<string, number>): number =>
  ids.reduce((s, id) => s + (actuals.get(id) ?? 0), 0);

/**
 * Grade one snapshot against the week's actual results. Pure: same inputs → same output.
 *
 * `optimalPoints` / `chalkPoints` are only computed when every pool player has a positive
 * salary (i.e. the snapshot was taken in salary mode); otherwise they're null because a
 * cap-based comparison is meaningless without prices.
 */
export function gradeSnapshot(
  lineup: SnapshotPick[],
  pool: SnapshotPoolPlayer[],
  cap: number,
  actuals: Map<string, number>,
): SnapshotGrade {
  const lineupIds = lineup.map((p) => p.playerId);
  const actualPoints = sumActuals(lineupIds, actuals);
  const playersGraded = lineupIds.filter((id) => actuals.has(id)).length;

  const haveSalaries = pool.length > 0 && pool.every((p) => (p.salary ?? 0) > 0);
  let optimalPoints: number | null = null;
  let chalkPoints: number | null = null;

  if (haveSalaries) {
    // Hindsight-best lineup: maximize ACTUAL points under the cap.
    const byActual: OptCandidate[] = pool.map((p) => ({
      id: p.playerId,
      position: p.position as OptCandidate['position'],
      fit: actuals.get(p.playerId) ?? 0,
      salary: p.salary ?? 0,
    }));
    optimalPoints = optimizeLineup(byActual, LINEUP_SLOTS, cap).totalFit;

    // "Chalk": pay up (maximize salary), then score that lineup by actual points.
    const bySalary: OptCandidate[] = pool.map((p) => ({
      id: p.playerId,
      position: p.position as OptCandidate['position'],
      fit: p.salary ?? 0,
      salary: p.salary ?? 0,
    }));
    const chalk = optimizeLineup(bySalary, LINEUP_SLOTS, cap);
    chalkPoints = sumActuals(
      chalk.lineup.map((l) => l.id).filter((id): id is string => id !== null),
      actuals,
    );
  }

  return {
    actualPoints,
    optimalPoints,
    chalkPoints,
    playersGraded,
    meta: {
      perPlayer: lineup.map((p) => ({ playerId: p.playerId, actual: actuals.get(p.playerId) ?? 0 })),
    },
  };
}
