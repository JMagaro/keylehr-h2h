'use server';

/**
 * Server actions backing the admin Playoffs page. All gated by `requireAdmin()`
 * (defense-in-depth on top of middleware) and all idempotent — the playoff
 * service is the source of truth.
 *
 *  - `generateBracketAction`  → seed the wild-card round from the configured
 *                               regular-season standings.
 *  - `advanceBracketAction`   → resolve every fully-scored round + record the
 *                               champion when the title game resolves.
 *  - `setContestIdsAction`    → set the DraftKings contest ids for the playoff
 *                               weeks 19–22 in `weekly_contests`, so the
 *                               extension syncs playoff scores like any week.
 *  - `setWinnerAction`        → manual per-game winner override, then re-advance.
 *
 * Each returns a `{ ok?, error?, message? }` state for `useActionState` and
 * revalidates `/admin/playoffs`.
 */
import { revalidatePath } from 'next/cache';

import { db, weeklyContests } from '@/db';
import { requireAdmin } from '@/lib/auth-helpers';
import {
  advancePlayoffs,
  generatePlayoffBracket,
  setGameWinner,
  PLAYOFF_ROUND_WEEKS,
} from '@/lib/playoffs/service';

/** Shape returned to `useActionState`. */
export type PlayoffFormState = {
  ok?: boolean;
  error?: string;
  message?: string;
};

/** The four playoff weeks, in round order. (Local to this module — a 'use server' file may only export async functions.) */
const PLAYOFF_WEEKS = [
  PLAYOFF_ROUND_WEEKS.wild_card,
  PLAYOFF_ROUND_WEEKS.divisional,
  PLAYOFF_ROUND_WEEKS.conference,
  PLAYOFF_ROUND_WEEKS.championship,
] as const;

function readSeasonId(formData: FormData): number {
  return Number(formData.get('seasonId'));
}

export async function generateBracketAction(
  _prev: PlayoffFormState,
  formData: FormData,
): Promise<PlayoffFormState> {
  await requireAdmin();
  const seasonId = readSeasonId(formData);
  if (!Number.isInteger(seasonId) || seasonId <= 0) return { error: 'Invalid season.' };

  const res = await generatePlayoffBracket(seasonId);
  revalidatePath('/admin/playoffs');
  return res.ok ? { ok: true, message: res.message } : { error: res.message };
}

export async function advanceBracketAction(
  _prev: PlayoffFormState,
  formData: FormData,
): Promise<PlayoffFormState> {
  await requireAdmin();
  const seasonId = readSeasonId(formData);
  if (!Number.isInteger(seasonId) || seasonId <= 0) return { error: 'Invalid season.' };

  const res = await advancePlayoffs(seasonId);
  revalidatePath('/admin/playoffs');
  return { ok: true, message: res.message };
}

/**
 * Upsert the DraftKings contest id for one playoff week into `weekly_contests`
 * (unique on season+week). An empty value clears it.
 */
export async function setContestIdsAction(
  _prev: PlayoffFormState,
  formData: FormData,
): Promise<PlayoffFormState> {
  await requireAdmin();
  const seasonId = readSeasonId(formData);
  if (!Number.isInteger(seasonId) || seasonId <= 0) return { error: 'Invalid season.' };

  for (const week of PLAYOFF_WEEKS) {
    const raw = String(formData.get(`contest_${week}`) ?? '').trim();
    const dkContestId = raw.length > 0 ? raw : null;

    await db
      .insert(weeklyContests)
      .values({ seasonId, week, dkContestId })
      .onConflictDoUpdate({
        target: [weeklyContests.seasonId, weeklyContests.week],
        set: { dkContestId },
      });
  }

  revalidatePath('/admin/playoffs');
  return { ok: true, message: `Saved contest ids for weeks ${PLAYOFF_WEEKS.join(', ')}.` };
}

export async function setWinnerAction(
  _prev: PlayoffFormState,
  formData: FormData,
): Promise<PlayoffFormState> {
  await requireAdmin();
  const seasonId = readSeasonId(formData);
  const playoffMatchupId = Number(formData.get('playoffMatchupId'));
  const winnerOwnerSeasonId = Number(formData.get('winnerOwnerSeasonId'));
  if (!Number.isInteger(seasonId) || seasonId <= 0) return { error: 'Invalid season.' };
  if (!Number.isInteger(playoffMatchupId) || playoffMatchupId <= 0) {
    return { error: 'Invalid game.' };
  }
  if (!Number.isInteger(winnerOwnerSeasonId) || winnerOwnerSeasonId <= 0) {
    return { error: 'Pick a winner.' };
  }

  const res = await setGameWinner(seasonId, playoffMatchupId, winnerOwnerSeasonId);
  revalidatePath('/admin/playoffs');
  return { ok: true, message: `Winner set. ${res.message}` };
}
