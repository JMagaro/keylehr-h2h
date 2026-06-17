'use server';

/**
 * Server actions for Admin → Models: snapshot the three lineup models' recommendations for
 * a week, and grade a week against actual player results. Both gated by `requireAdmin()`
 * and idempotent (snapshot upserts; grade re-reads actuals). Types are erased, so exporting
 * `ModelsFormState` from this 'use server' file is fine.
 */
import { revalidatePath } from 'next/cache';

import { requireAdmin } from '@/lib/auth-helpers';
import { gradeWeek, snapshotWeek } from '@/lib/players/performance';

export type ModelsFormState = {
  ok?: boolean;
  error?: string;
  message?: string;
};

function readSeasonWeek(formData: FormData): { seasonId: number; week: number } | null {
  const seasonId = Number(formData.get('seasonId'));
  const week = Number(formData.get('week'));
  if (!Number.isInteger(seasonId) || seasonId <= 0) return null;
  if (!Number.isInteger(week) || week < 1 || week > 25) return null;
  return { seasonId, week };
}

export async function snapshotWeekAction(
  _prev: ModelsFormState,
  formData: FormData,
): Promise<ModelsFormState> {
  await requireAdmin();
  const parsed = readSeasonWeek(formData);
  if (!parsed) return { error: 'Pick a valid season and week.' };

  const res = await snapshotWeek(parsed.seasonId, parsed.week);
  revalidatePath('/admin/models');
  return {
    ok: true,
    message: `Snapshotted ${res.snapshots} model lineups for week ${parsed.week}${
      res.salaryMode ? ' (salary mode)' : ' (signal-only — no slate live yet)'
    }.`,
  };
}

export async function gradeWeekAction(
  _prev: ModelsFormState,
  formData: FormData,
): Promise<ModelsFormState> {
  await requireAdmin();
  const parsed = readSeasonWeek(formData);
  if (!parsed) return { error: 'Pick a valid season and week.' };

  const res = await gradeWeek(parsed.seasonId, parsed.week);
  revalidatePath('/admin/models');
  if (res.graded === 0) return { ok: true, message: res.note ?? 'Nothing graded.' };
  return { ok: true, message: `Graded ${res.graded} model lineups for week ${parsed.week}.` };
}
