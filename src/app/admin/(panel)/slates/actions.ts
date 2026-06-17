'use server';

/**
 * Server action backing Admin → Slates. Sets the DraftKings *draft group id* (slate) per
 * regular-season week in `weekly_contests`, which the lineup builder reads to fetch player
 * salaries and run cap-aware optimization. Gated by `requireAdmin()`. Idempotent: it upserts
 * on (season, week) and only touches `dkDraftGroupId`, never the `dkContestId` used for scoring.
 *
 * The draft group id is the number in a DraftKings contest/lobby URL
 * (…/draft/nfl/<draftGroupId> or ?draftGroupId=<id>).
 */
import { revalidatePath } from 'next/cache';

import { db, weeklyContests } from '@/db';
import { requireAdmin } from '@/lib/auth-helpers';

export type SlateFormState = {
  ok?: boolean;
  error?: string;
  message?: string;
};

export async function setDraftGroupIdsAction(
  _prev: SlateFormState,
  formData: FormData,
): Promise<SlateFormState> {
  await requireAdmin();
  const seasonId = Number(formData.get('seasonId'));
  if (!Number.isInteger(seasonId) || seasonId <= 0) return { error: 'Invalid season.' };

  let saved = 0;
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith('dg_')) continue;
    const week = Number(key.slice(3));
    if (!Number.isInteger(week) || week <= 0) continue;
    const raw = String(value).trim();
    // Accept a bare id or a pasted URL; pull the last number out of a URL.
    const dkDraftGroupId = raw.length > 0 ? (raw.match(/(\d{4,})/g)?.pop() ?? raw) : null;

    await db
      .insert(weeklyContests)
      .values({ seasonId, week, dkDraftGroupId })
      .onConflictDoUpdate({
        target: [weeklyContests.seasonId, weeklyContests.week],
        set: { dkDraftGroupId },
      });
    saved += 1;
  }

  revalidatePath('/admin/slates');
  return { ok: true, message: `Saved draft group ids for ${saved} week(s).` };
}
