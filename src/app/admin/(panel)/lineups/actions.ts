'use server';

/**
 * Server action backing Admin → Lineups: paste a DraftKings roster payload for a week.
 *
 * This is the permanent FALLBACK for roster capture. The Chrome extension is the normal
 * path, but DK's roster endpoint is undocumented and auth-gated, so a manual paste has to
 * keep working — the same posture as the leaderboard paste in Admin → Preseason.
 *
 * Whatever DraftKings returned can be pasted verbatim: the normalizer identifies roster rows
 * structurally rather than by path (see src/lib/lineups/normalize.ts).
 *
 * Gated by `requireAdmin()`. Writes ONLY to `lineup_snapshots` / `lineup_capture_runs` —
 * never to `scores`. See docs/SCORING.md §15.
 */
import { revalidatePath } from 'next/cache';

import { requireAdmin } from '@/lib/auth-helpers';
import { ingestLineups } from '@/lib/lineups/ingest';
import { normalizeRosterPayload } from '@/lib/lineups/normalize';
import {
  MAX_EXHIBITION_WEEK,
  MAX_REGULAR_WEEK,
  MIN_EXHIBITION_WEEK,
} from '@/lib/ingest/week-schema';

export type LineupFormState = {
  ok?: boolean;
  error?: string;
  message?: string;
  unmatched?: string[];
};

export async function pasteLineupsAction(
  _prev: LineupFormState,
  formData: FormData,
): Promise<LineupFormState> {
  await requireAdmin();

  const seasonId = Number(formData.get('seasonId'));
  if (!Number.isInteger(seasonId) || seasonId <= 0) return { error: 'Invalid season.' };

  const week = Number(formData.get('week'));
  const legalWeek =
    Number.isInteger(week) &&
    ((week >= 1 && week <= MAX_REGULAR_WEEK) ||
      (week >= MIN_EXHIBITION_WEEK && week <= MAX_EXHIBITION_WEEK));
  if (!legalWeek) {
    return {
      error:
        `Week must be 1–${MAX_REGULAR_WEEK} (regular/playoff) or ` +
        `${MIN_EXHIBITION_WEEK}–${MAX_EXHIBITION_WEEK} (preseason exhibition).`,
    };
  }

  const raw = String(formData.get('json') ?? '').trim();
  if (!raw) return { error: 'Paste the DraftKings roster JSON first.' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: 'That is not valid JSON.' };
  }

  // Optional: attribute a BARE roster (a per-entry endpoint response carries no entry name).
  const entryName = String(formData.get('entryName') ?? '').trim() || undefined;
  const contestId = String(formData.get('contestId') ?? '').trim() || undefined;
  /**
   * Load-bearing, NOT optional metadata.
   *
   * DraftKings' roster payload names no team and no position — only a `draftableId`. Scoring
   * reaches ESPN's boxscore by (name, team), so without a draft group id to resolve those ids
   * against, a pasted capture is stored but can never be scored. That made the paste path a
   * store-the-evidence fallback rather than a working one until this was threaded through.
   */
  const draftGroupId = String(formData.get('draftGroupId') ?? '').trim() || undefined;
  // Recording which DraftKings URL produced the payload is the whole point of the
  // `sourceUrlTemplate` column — the endpoint is undocumented, so this is how it stays known.
  const sourceUrlTemplate = String(formData.get('sourceUrlTemplate') ?? '').trim() || undefined;

  const { lineups, skipped } = normalizeRosterPayload(parsed, entryName);
  if (lineups.length === 0) {
    return {
      error:
        `No usable lineups found (skipped ${skipped}). ` +
        'If this is a single entry with no name in the payload, fill in "Entry name".',
    };
  }

  try {
    const result = await ingestLineups({
      seasonId,
      week,
      lineups,
      // A paste is a record of a read that already happened; we only know "now".
      capturedAt: new Date(),
      contestId,
      draftGroupId,
      sourceUrlTemplate,
      triggeredBy: 'admin:paste',
      rawPayload: parsed,
    });

    revalidatePath('/admin/lineups');
    revalidatePath('/live');

    const parts = [`Captured ${result.snapshots} lineup(s) for week ${week}.`];
    if (result.unmatched.length > 0) {
      parts.push(`${result.unmatched.length} entry name(s) did not match an owner.`);
    }
    // Say plainly when a capture landed but is not scorable, rather than reporting success
    // and letting it surface much later as every player "unresolved" on /live.
    const revealed = lineups.reduce((n, l) => n + l.slots.filter((s) => s.revealed).length, 0);
    if (!draftGroupId && revealed > 0) {
      parts.push(
        'No draft group id given, so players were not resolved to teams — this capture is ' +
          'stored but cannot be scored. Add the draft group id and paste again.',
      );
    } else if (result.enrichedSlots === 0 && revealed > 0) {
      parts.push(
        `Draft group ${draftGroupId} resolved no players — check the id, or DraftKings may ` +
          'have expired that slate.',
      );
    }
    return {
      ok: true,
      message: parts.join(' '),
      unmatched: result.unmatched,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { error: `Capture failed: ${message}` };
  }
}
