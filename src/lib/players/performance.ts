/**
 * Lineup-model performance tracking.
 *
 * Forward-looking by necessity: the models' inputs (waiver trends, injury tags) only exist
 * "now", so we cannot honestly backtest past seasons. Instead we SNAPSHOT each week's
 * recommended lineup near lock, then GRADE it after the games against actual player results
 * (free, from the Sleeper stats API). Accumulated grades are what let the models be compared
 * — and, eventually, trained (graduating them from 'heuristic' to 'trained' in models.ts).
 *
 * The grading math (gradeSnapshot) is pure and unit-tested; snapshotWeek/gradeWeek wrap it
 * with DB + network I/O. Everything here is server-only.
 */
import { and, desc, eq, isNotNull } from 'drizzle-orm';

import { db, modelSnapshots, seasons } from '@/db';
import { DK_CLASSIC_SALARY_CAP } from '@/lib/draftkings/draftables';
import { getBuilderData, getBuilderSeasons } from './query';
import { RISK_LEVELS, type RiskLevel } from './recommend';
import { MODEL_REGISTRY, modelVersionTag } from './models';
import { getWeekActuals } from './sleeper';
import { gradeSnapshot, type SnapshotPick, type SnapshotPoolPlayer } from './grade';

export type { SnapshotPick, SnapshotPoolPlayer, SnapshotGrade } from './grade';
export { gradeSnapshot } from './grade';

/* -------------------------------------------------------------------------- */
/* Snapshot a week                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Snapshot all three models' recommended lineups for a (season, week). Idempotent — upserts
 * on (season, week, risk) and resets any prior grade. Run near lineup lock.
 */
export async function snapshotWeek(
  seasonId: number,
  week: number,
): Promise<{ snapshots: number; salaryMode: boolean }> {
  const season = (await getBuilderSeasons()).find((s) => s.id === seasonId);
  if (!season) throw new Error(`No season ${seasonId}`);

  let salaryMode = false;
  let count = 0;
  for (const risk of RISK_LEVELS) {
    const data = await getBuilderData(season, week, risk);
    salaryMode = salaryMode || data.salary.enabled;

    const lineup: SnapshotPick[] = data.lineup
      .filter((s) => s.pick)
      .map((s) => ({
        slot: s.slot,
        playerId: s.pick!.id,
        name: s.pick!.name,
        position: s.pick!.position,
        teamKey: s.pick!.teamKey,
        fit: s.pick!.fit,
        salary: s.pick!.salary,
      }));

    // Pool = the lineup plus every considered target (for hindsight grading).
    const poolMap = new Map<string, SnapshotPoolPlayer>();
    const add = (p: { id: string; position: string; salary: number | null; fit: number }) => {
      if (!poolMap.has(p.id)) {
        poolMap.set(p.id, { playerId: p.id, position: p.position, salary: p.salary, fit: p.fit });
      }
    };
    for (const s of data.lineup) if (s.pick) add(s.pick);
    for (const g of data.targetsByPosition) for (const p of g.players) add(p);
    const pool = [...poolMap.values()];

    const values = {
      seasonId,
      week,
      risk,
      modelVersion: modelVersionTag(risk),
      draftGroupId: data.salary.draftGroupId,
      salaryMode: data.salary.enabled,
      salaryCap: data.salary.enabled ? data.salary.salaryCap : null,
      lineup,
      pool,
    };

    await db
      .insert(modelSnapshots)
      .values(values)
      .onConflictDoUpdate({
        target: [modelSnapshots.seasonId, modelSnapshots.week, modelSnapshots.risk],
        set: {
          ...values,
          // Reset the grade — the lineup may have changed.
          gradedAt: null,
          actualPoints: null,
          optimalPoints: null,
          chalkPoints: null,
          playersGraded: null,
          gradeMeta: null,
        },
      });
    count += 1;
  }
  return { snapshots: count, salaryMode };
}

/* -------------------------------------------------------------------------- */
/* Grade a week                                                               */
/* -------------------------------------------------------------------------- */

export async function gradeWeek(
  seasonId: number,
  week: number,
): Promise<{ graded: number; note?: string }> {
  const [season] = await db
    .select({ year: seasons.year })
    .from(seasons)
    .where(eq(seasons.id, seasonId))
    .limit(1);
  if (!season) throw new Error(`No season ${seasonId}`);

  const actuals = await getWeekActuals(season.year, week);
  if (actuals.size === 0) return { graded: 0, note: 'No actual results posted for this week yet.' };

  const rows = await db
    .select()
    .from(modelSnapshots)
    .where(and(eq(modelSnapshots.seasonId, seasonId), eq(modelSnapshots.week, week)));
  if (rows.length === 0) return { graded: 0, note: 'No snapshots to grade — snapshot the week first.' };

  let graded = 0;
  for (const row of rows) {
    const lineup = (row.lineup as SnapshotPick[]) ?? [];
    const pool = (row.pool as SnapshotPoolPlayer[]) ?? [];
    const cap = row.salaryCap ?? DK_CLASSIC_SALARY_CAP;
    const g = gradeSnapshot(lineup, pool, cap, actuals);
    await db
      .update(modelSnapshots)
      .set({
        gradedAt: new Date(),
        actualPoints: g.actualPoints.toFixed(2),
        optimalPoints: g.optimalPoints != null ? g.optimalPoints.toFixed(2) : null,
        chalkPoints: g.chalkPoints != null ? g.chalkPoints.toFixed(2) : null,
        playersGraded: g.playersGraded,
        gradeMeta: g.meta,
      })
      .where(eq(modelSnapshots.id, row.id));
    graded += 1;
  }
  return { graded };
}

/* -------------------------------------------------------------------------- */
/* Summaries for the UI                                                       */
/* -------------------------------------------------------------------------- */

export interface ModelPerformance {
  risk: RiskLevel;
  codename: string;
  version: string;
  stage: 'heuristic' | 'trained';
  algorithm: string;
  weeksGraded: number;
  avgActual: number | null;
  /** Mean of actual/optimal across graded salary-mode weeks, as a percent. */
  avgOptimalPct: number | null;
  /** Mean (actual − chalk) across graded salary-mode weeks. */
  avgVsChalk: number | null;
  lastGradedWeek: number | null;
}

/** Per-model performance aggregates, optionally scoped to one season. */
export async function getModelPerformance(seasonId?: number): Promise<ModelPerformance[]> {
  const where = seasonId
    ? and(eq(modelSnapshots.seasonId, seasonId), isNotNull(modelSnapshots.gradedAt))
    : isNotNull(modelSnapshots.gradedAt);
  const rows = await db
    .select({
      risk: modelSnapshots.risk,
      week: modelSnapshots.week,
      actual: modelSnapshots.actualPoints,
      optimal: modelSnapshots.optimalPoints,
      chalk: modelSnapshots.chalkPoints,
    })
    .from(modelSnapshots)
    .where(where);

  return RISK_LEVELS.map((risk) => {
    const info = MODEL_REGISTRY[risk];
    const mine = rows.filter((r) => r.risk === risk);
    const actuals = mine.map((r) => Number(r.actual)).filter((n) => Number.isFinite(n));
    const pcts = mine
      .filter((r) => r.optimal != null && Number(r.optimal) > 0)
      .map((r) => (Number(r.actual) / Number(r.optimal)) * 100);
    const vsChalk = mine
      .filter((r) => r.chalk != null)
      .map((r) => Number(r.actual) - Number(r.chalk));
    const mean = (a: number[]) => (a.length ? a.reduce((s, n) => s + n, 0) / a.length : null);
    const lastWeek = mine.length ? Math.max(...mine.map((r) => r.week)) : null;
    return {
      risk,
      codename: info.codename,
      version: info.version,
      stage: info.stage,
      algorithm: info.algorithm,
      weeksGraded: mine.length,
      avgActual: mean(actuals),
      avgOptimalPct: mean(pcts),
      avgVsChalk: mean(vsChalk),
      lastGradedWeek: lastWeek,
    };
  });
}

/** Raw snapshot rows for a season (admin view), newest week first. */
export async function getWeekSnapshots(seasonId: number) {
  return db
    .select({
      week: modelSnapshots.week,
      risk: modelSnapshots.risk,
      modelVersion: modelSnapshots.modelVersion,
      salaryMode: modelSnapshots.salaryMode,
      createdAt: modelSnapshots.createdAt,
      gradedAt: modelSnapshots.gradedAt,
      actualPoints: modelSnapshots.actualPoints,
      optimalPoints: modelSnapshots.optimalPoints,
      chalkPoints: modelSnapshots.chalkPoints,
      playersGraded: modelSnapshots.playersGraded,
    })
    .from(modelSnapshots)
    .where(eq(modelSnapshots.seasonId, seasonId))
    .orderBy(desc(modelSnapshots.week), modelSnapshots.risk);
}
