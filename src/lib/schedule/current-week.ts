/**
 * Work out which week it actually is, from the synced NFL schedule. PURE — no DB, no clock of
 * its own — so every rule below is testable. The database half lives in ./current-week-query.
 *
 * WHY THIS EXISTS. The Chrome extension used to guess the week from a `#N` in the DraftKings
 * contest name, falling back to `seasons.currentWeek`. Both are unreliable:
 *
 *   - A contest name need not contain `#N` at all. A real one ("DraftKings - Test 2 by
 *     Colts0094") did not, so the parse silently found nothing.
 *   - `seasons.currentWeek` is a hand-maintained column. Nobody advancing it in November means
 *     the extension confidently offers week 1.
 *
 * And the preseason toggle was never detected at all — it just remembered whatever it was last
 * left on, which is how a capture landed in week 102 while the scores went to 103.
 *
 * `nfl_games` already holds every kickoff, and `isExhibition` is stored per row, so the
 * schedule can answer BOTH questions without guessing.
 *
 * THE STAKES: `scores` upserts on `(ownerSeasonId, week)`, so a wrong week silently overwrites
 * a real week's scores. Getting this right is worth more than it looks.
 */

export interface WeekRange {
  /** The stored week value — regular 1–18, playoffs 19–25, or exhibition 101–103. */
  week: number;
  /** True when `week` is in the exhibition namespace, i.e. the preseason toggle should be on. */
  isExhibition: boolean;
  /** First and last kickoff, so a human can confirm the week is the one they meant. */
  firstKickoff: Date | null;
  lastKickoff: Date | null;
  gameCount: number;
}

export interface DetectedWeek extends WeekRange {
  /** How the week was chosen — shown to the user, and useful when one looks wrong. */
  basis: 'in-progress' | 'upcoming' | 'last';
}

/** One row of the schedule, as both halves of this module see it. */
export interface ScheduleGame {
  week: number;
  kickoff: Date | null;
  isExhibition: boolean;
}

/**
 * How long after its first kickoff a week is still "in progress".
 *
 * Sized to cover Thursday night through the following Monday night — an NFL week's games span
 * about five days, and the answer should stay on the current week for its whole duration
 * rather than flipping the moment Sunday's games end.
 */
const WEEK_SPAN_MS = 5.5 * 24 * 60 * 60 * 1000;

interface WeekSummary {
  week: number;
  first: Date | null;
  last: Date | null;
  isExhibition: boolean;
  count: number;
}

/** Collapse the schedule to one entry per week, keeping its first and last kickoff. */
function summarize(games: ScheduleGame[]): WeekSummary[] {
  const byWeek = new Map<number, WeekSummary>();
  for (const g of games) {
    const existing = byWeek.get(g.week);
    if (!existing) {
      byWeek.set(g.week, {
        week: g.week,
        first: g.kickoff,
        last: g.kickoff,
        isExhibition: g.isExhibition,
        count: 1,
      });
      continue;
    }
    existing.count += 1;
    if (g.kickoff && (!existing.first || g.kickoff < existing.first)) existing.first = g.kickoff;
    if (g.kickoff && (!existing.last || g.kickoff > existing.last)) existing.last = g.kickoff;
  }

  // A week with no kickoff at all cannot be placed in time; sort it last rather than drop it,
  // so it can still be the "last week" answer for a schedule with no times yet.
  return [...byWeek.values()].sort((a, b) => {
    if (a.first && b.first) return a.first.getTime() - b.first.getTime();
    if (a.first) return -1;
    if (b.first) return 1;
    return a.week - b.week;
  });
}

function toRange(w: WeekSummary): WeekRange {
  return {
    week: w.week,
    isExhibition: w.isExhibition,
    firstKickoff: w.first,
    lastKickoff: w.last,
    gameCount: w.count,
  };
}

/**
 * Pick the week a given moment falls in.
 *
 *   1. A week already under way (first kickoff in the past, within the week's span).
 *   2. The next week to start.
 *   3. The last week of the season, once everything has finished.
 *
 * Returns null when there are no games at all, which the caller must treat as "don't know"
 * rather than defaulting to week 1 — a confident wrong week is worse than none.
 */
export function pickWeek(games: ScheduleGame[], now: Date): DetectedWeek | null {
  if (games.length === 0) return null;

  const weeks = summarize(games);
  const t = now.getTime();

  // Under way — the LATEST such week, so a Thursday opener doesn't hand the answer back to the
  // week just gone, whose 5.5-day span still covers now.
  let inProgress: WeekSummary | undefined;
  for (const w of weeks) {
    if (w.first && w.first.getTime() <= t && t < w.first.getTime() + WEEK_SPAN_MS) inProgress = w;
  }
  if (inProgress) return { ...toRange(inProgress), basis: 'in-progress' };

  const upcoming = weeks.find((w) => w.first && w.first.getTime() > t);
  if (upcoming) return { ...toRange(upcoming), basis: 'upcoming' };

  return { ...toRange(weeks[weeks.length - 1]), basis: 'last' };
}

/**
 * The date range one specific week covers.
 *
 * Shown next to the week selector so a human can confirm the week is the one they mean BEFORE
 * syncing — the cheap defence against the silent-overwrite hazard above.
 */
export function rangeForWeek(games: ScheduleGame[], week: number): WeekRange | null {
  const forWeek = games.filter((g) => g.week === week);
  if (forWeek.length === 0) return null;
  return toRange(summarize(forWeek)[0]);
}
