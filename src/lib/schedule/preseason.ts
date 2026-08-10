/**
 * Preseason (exhibition) week namespace.
 *
 * NFL preseason weeks (1..4) would collide with the regular season (1..18) in every
 * `(…, week)` unique index, so preseason games/matchups/scores are stored at an OFFSET
 * week: `week = PRESEASON_WEEK_BASE + preseasonWeek` (101, 102, 103, …). They also carry
 * an `isExhibition` flag, and EVERY standings/stats query excludes exhibition rows — so a
 * preseason game is fully tracked (schedule, matchups, scores, a winner) but never counts
 * toward standings, seeding, playoffs, payouts, or all-time records.
 *
 * Pure / no DB.
 */

/** Stored preseason weeks start just past the playoff weeks (19..22) to avoid any overlap. */
export const PRESEASON_WEEK_BASE = 100;

/** The number of NFL preseason weeks we allow (HOF + wk2 + wk3). */
export const MAX_PRESEASON_WEEK = 3;

/** NFL preseason week (1..3) → the stored `week` value. */
export function toExhibitionWeek(preseasonWeek: number): number {
  return PRESEASON_WEEK_BASE + preseasonWeek;
}

/** Stored `week` value → the NFL preseason week (1..3). */
export function fromExhibitionWeek(week: number): number {
  return week - PRESEASON_WEEK_BASE;
}

/** True when a stored `week` value is a preseason/exhibition week. */
export function isExhibitionWeek(week: number): boolean {
  return week > PRESEASON_WEEK_BASE;
}

/** e.g. 102 → "Preseason Week 2". */
export function exhibitionWeekLabel(week: number): string {
  return `Preseason Week ${fromExhibitionWeek(week)}`;
}
