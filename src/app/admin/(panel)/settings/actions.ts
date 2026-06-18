'use server';

/**
 * Server actions backing the admin Settings page. Two independent mutations,
 * each gated by `requireAdmin()` (defense-in-depth on top of middleware) and
 * validated server-side — the server is the source of truth:
 *
 *  - `updateSeasonMeta`  → the canonical `seasons` columns (name, status,
 *                          currentWeek, regularSeasonWeeks, entryFeeCents).
 *  - `updateSeasonRules` → the per-season `seasons.rules` JSONB, round-tripped
 *                          through `getSeasonRules` + `seasonRulesSchema` so we
 *                          never silently drop or corrupt unknown/derived keys.
 *
 * Both `revalidatePath('/admin/settings')` and return a `{ ok?, error? }` state
 * for `useActionState` to render inline success/error.
 */
import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { db, seasons } from '@/db';
import { requireAdmin } from '@/lib/auth-helpers';
import { DEFAULT_SEASON_RULES, getSeasonRules, seasonRulesSchema } from '@/lib/rules/schema';

/** Shape returned to `useActionState` for inline success/error rendering. */
export type SettingsFormState = {
  ok?: boolean;
  error?: string;
  message?: string;
};

/** Parse a dollar string (e.g. "155.50") into whole USD cents. */
function dollarsToCents(raw: FormDataEntryValue | null): number {
  const dollars = Number(String(raw ?? '').trim());
  if (!Number.isFinite(dollars)) return Number.NaN; // surfaced by zod below
  return Math.round(dollars * 100);
}

/** Read a numeric form field as a Number (NaN if blank/invalid → caught by zod). */
function num(raw: FormDataEntryValue | null): number {
  return Number(String(raw ?? '').trim());
}

/** A checkbox is present in form data only when checked. */
function checked(formData: FormData, name: string): boolean {
  return formData.get(name) !== null;
}

/* -------------------------------------------------------------------------- */
/* Season meta                                                                 */
/* -------------------------------------------------------------------------- */

const seasonMetaSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name is required.')
    .max(64, 'Name must be 64 characters or fewer.'),
  status: z.enum(['upcoming', 'active', 'completed']),
  currentWeek: z
    .number({ message: 'Current week must be a number.' })
    .int('Current week must be a whole number.')
    .min(1, 'Current week must be at least 1.')
    .max(25, 'Current week must be 25 or fewer.'),
  regularSeasonWeeks: z
    .number({ message: 'Regular-season weeks must be a number.' })
    .int('Regular-season weeks must be a whole number.')
    .min(1, 'Regular-season weeks must be at least 1.')
    .max(25, 'Regular-season weeks must be 25 or fewer.'),
  entryFeeCents: z
    .number({ message: 'Entry fee must be a number.' })
    .int('Entry fee must resolve to whole cents.')
    .nonnegative('Entry fee cannot be negative.'),
});

export async function updateSeasonMeta(
  _prev: SettingsFormState,
  formData: FormData,
): Promise<SettingsFormState> {
  await requireAdmin();

  const seasonId = Number(formData.get('seasonId'));
  if (!Number.isInteger(seasonId) || seasonId <= 0) {
    return { error: 'Invalid season.' };
  }

  const parsed = seasonMetaSchema.safeParse({
    name: String(formData.get('name') ?? ''),
    status: String(formData.get('status') ?? ''),
    currentWeek: num(formData.get('currentWeek')),
    regularSeasonWeeks: num(formData.get('regularSeasonWeeks')),
    entryFeeCents: dollarsToCents(formData.get('entryFeeDollars')),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Please fix the errors and try again.' };
  }

  await db.update(seasons).set(parsed.data).where(eq(seasons.id, seasonId));

  revalidatePath('/admin/settings');
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Season rules (JSONB)                                                        */
/* -------------------------------------------------------------------------- */

const TIEBREAKER_KEYS = ['h2h', 'pf', 'pa'] as const;
type TiebreakerKey = (typeof TIEBREAKER_KEYS)[number];

/**
 * Build the tiebreaker order from three ordered Selects (`tiebreaker0..2`).
 * Falls back to the current/default order if the submission is incomplete or
 * not a permutation — `seasonRulesSchema` then re-validates the result.
 */
function readTiebreakers(formData: FormData, fallback: TiebreakerKey[]): TiebreakerKey[] {
  const picked = [0, 1, 2]
    .map((i) => String(formData.get(`tiebreaker${i}`) ?? ''))
    .filter((v): v is TiebreakerKey => (TIEBREAKER_KEYS as readonly string[]).includes(v));
  const unique = Array.from(new Set(picked));
  return unique.length === TIEBREAKER_KEYS.length ? unique : fallback;
}

export async function updateSeasonRules(
  _prev: SettingsFormState,
  formData: FormData,
): Promise<SettingsFormState> {
  await requireAdmin();

  const seasonId = Number(formData.get('seasonId'));
  if (!Number.isInteger(seasonId) || seasonId <= 0) {
    return { error: 'Invalid season.' };
  }

  // Load the current effective rules so we round-trip (and preserve) any keys
  // not surfaced by this form rather than dropping them.
  const existing = await db
    .select({ rules: seasons.rules })
    .from(seasons)
    .where(eq(seasons.id, seasonId))
    .limit(1);

  if (existing.length === 0) {
    return { error: 'Season not found.' };
  }

  const current = getSeasonRules(existing[0].rules);

  const next = {
    ...current,
    // Regular-season weeks is edited on the Season card (the canonical
    // `seasons.regularSeasonWeeks` column the scoring engine reads); preserve the
    // rules-JSONB mirror here rather than exposing a second, divergent editor.
    regularSeasonWeeks: current.regularSeasonWeeks,
    tiebreakers: readTiebreakers(formData, current.tiebreakers),
    playoffs: {
      teamsPerConference: num(formData.get('teamsPerConference')),
      divisionWinnersPerConference: num(formData.get('divisionWinnersPerConference')),
      wildCardsPerConference: num(formData.get('wildCardsPerConference')),
      topSeedByes: num(formData.get('topSeedByes')),
      tieBreaker: String(formData.get('playoffTieBreaker') ?? ''),
    },
    byeWeek: {
      countsTowardPointsFor: checked(formData, 'byeCountsTowardPointsFor'),
      eligibleForWeeklyHigh: checked(formData, 'byeEligibleForWeeklyHigh'),
    },
    missedLineup: {
      result: String(formData.get('missedResult') ?? ''),
      opponentScores: String(formData.get('missedOpponentScores') ?? ''),
    },
    payouts: {
      // Entry fee is the canonical `seasons.entryFeeCents` column; preserve the
      // existing rules-payout value rather than editing it here.
      entryFeeCents: current.payouts.entryFeeCents,
      weeklyHighCents: dollarsToCents(formData.get('weeklyHighDollars')),
      weeklyHighWeeks: num(formData.get('weeklyHighWeeks')),
      seasonHighCents: dollarsToCents(formData.get('seasonHighDollars')),
      mostRegularSeasonPointsCents: dollarsToCents(formData.get('mostRegularSeasonPointsDollars')),
      championCents: dollarsToCents(formData.get('championDollars')),
      runnerUpCents: dollarsToCents(formData.get('runnerUpDollars')),
      thirdCents: dollarsToCents(formData.get('thirdDollars')),
      fourthCents: dollarsToCents(formData.get('fourthDollars')),
    },
  };

  const parsed = seasonRulesSchema.safeParse(next);
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? 'Some rule values are invalid. Please review them.',
    };
  }

  await db.update(seasons).set({ rules: parsed.data }).where(eq(seasons.id, seasonId));

  revalidatePath('/admin/settings');
  return { ok: true };
}

/**
 * One-click preset: set this season's rules to the league's canonical "2025 & earlier"
 * configuration ({@link DEFAULT_SEASON_RULES}) — the same tiebreaker order, playoff
 * structure, bye/missed-lineup behavior and payouts the 2023–2025 seasons used. Preserves
 * the canonical `regularSeasonWeeks` + entry fee (edited on the Season card) so this never
 * diverges from those columns. The Rules form re-renders with the applied values.
 */
export async function applyDefaultRulesAction(
  _prev: SettingsFormState,
  formData: FormData,
): Promise<SettingsFormState> {
  await requireAdmin();

  const seasonId = Number(formData.get('seasonId'));
  if (!Number.isInteger(seasonId) || seasonId <= 0) return { error: 'Invalid season.' };

  const existing = await db
    .select({ rules: seasons.rules })
    .from(seasons)
    .where(eq(seasons.id, seasonId))
    .limit(1);
  if (existing.length === 0) return { error: 'Season not found.' };
  const current = getSeasonRules(existing[0].rules);

  const next = {
    ...DEFAULT_SEASON_RULES,
    regularSeasonWeeks: current.regularSeasonWeeks,
    payouts: { ...DEFAULT_SEASON_RULES.payouts, entryFeeCents: current.payouts.entryFeeCents },
  };

  await db.update(seasons).set({ rules: next }).where(eq(seasons.id, seasonId));
  revalidatePath('/admin/settings');
  return { ok: true, message: 'Applied the 2025 & earlier league rules.' };
}
