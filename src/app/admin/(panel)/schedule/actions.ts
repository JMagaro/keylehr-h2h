'use server';

/**
 * Server actions backing the admin Schedule page. Both actions re-check
 * `requireAdmin()`, run an idempotent pipeline step against the live data, and
 * return a small summary object that a client wrapper renders via
 * `useActionState`. They can take a few seconds (the schedule pull fetches ESPN);
 * that is expected. Re-running either action is safe.
 */
import { revalidatePath } from 'next/cache';

import { requireAdmin } from '@/lib/auth-helpers';
import { getCurrentSeason } from '@/lib/season';
import { syncSeasonSchedule } from '@/lib/schedule/sync';
import { generateMatchups } from '@/lib/matchups/generate';
// A `'use server'` file may export ONLY async functions, so the shared state type
// and its initial value live in a plain module (./state) and are imported here.
import type { ScheduleActionState } from './state';

/**
 * Pull / refresh the NFL schedule for the current season from ESPN.
 *
 * Used via `useActionState`, whose action signature is `(prevState, payload)`;
 * this action ignores both (it operates on the current season), so we omit the
 * parameters — a nullary function is assignable to the expected action type.
 */
export async function pullScheduleAction(): Promise<ScheduleActionState> {
  await requireAdmin();

  const season = await getCurrentSeason();
  if (!season) {
    return { status: 'error', message: 'No current season — seed a season first.' };
  }

  try {
    const summary = await syncSeasonSchedule(season.id, season.year);
    revalidatePath('/admin/schedule');

    const parts = [
      `Pulled ${season.year} schedule: ${summary.gamesUpserted} games across ${summary.weeksProcessed} weeks.`,
    ];
    if (summary.unmappedEspnTeamIds.length > 0) {
      parts.push(
        `Warning: ${summary.unmappedEspnTeamIds.length} ESPN team id(s) could not be mapped (${summary.unmappedEspnTeamIds.join(', ')}).`,
      );
    }
    return { status: 'success', message: parts.join(' ') };
  } catch (err) {
    console.error('pullScheduleAction failed', err);
    return {
      status: 'error',
      message: 'Failed to pull the schedule from ESPN. Please try again in a moment.',
    };
  }
}

/** Generate / refresh owner-vs-owner matchups for the current season. */
export async function generateMatchupsAction(): Promise<ScheduleActionState> {
  await requireAdmin();

  const season = await getCurrentSeason();
  if (!season) {
    return { status: 'error', message: 'No current season — seed a season first.' };
  }

  try {
    const summary = await generateMatchups(season.id);
    revalidatePath('/admin/schedule');

    const parts = [`Generated ${summary.matchupsUpserted} matchups (${summary.byes} bye slots).`];
    if (summary.gamesSkippedUnassigned > 0) {
      parts.push(
        `${summary.gamesSkippedUnassigned} NFL game(s) skipped because one or both teams are unassigned — finish team assignments to include them.`,
      );
    }
    return { status: 'success', message: parts.join(' ') };
  } catch (err) {
    console.error('generateMatchupsAction failed', err);
    return {
      status: 'error',
      message: 'Failed to generate matchups. Please try again.',
    };
  }
}
