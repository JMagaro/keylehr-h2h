'use server';

/**
 * Server actions for Admin → Preseason. Runs a preseason EXHIBITION game: sync one NFL
 * preseason week's schedule (ESPN seasontype=1), generate the owner exhibition matchups,
 * and (optionally) enter scores by pasting a team→points list. Everything is flagged
 * `isExhibition`, so it never touches the real standings. Gated by `requireAdmin()`.
 */
import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';

import { db, seasons } from '@/db';
import { requireAdmin } from '@/lib/auth-helpers';
import { syncPreseasonWeek } from '@/lib/schedule/sync';
import { generateMatchups } from '@/lib/matchups/generate';
import { writeTeamScores } from '@/lib/scores/ingest';
import { toExhibitionWeek, MAX_PRESEASON_WEEK } from '@/lib/schedule/preseason';

export type PreseasonFormState = {
  ok?: boolean;
  error?: string;
  message?: string;
};

function readSeasonWeek(formData: FormData): { seasonId: number; preseasonWeek: number } | null {
  const seasonId = Number(formData.get('seasonId'));
  const preseasonWeek = Number(formData.get('preseasonWeek'));
  if (!Number.isInteger(seasonId) || seasonId <= 0) return null;
  if (!Number.isInteger(preseasonWeek) || preseasonWeek < 1 || preseasonWeek > MAX_PRESEASON_WEEK) {
    return null;
  }
  return { seasonId, preseasonWeek };
}

export async function syncPreseasonAction(
  _prev: PreseasonFormState,
  formData: FormData,
): Promise<PreseasonFormState> {
  await requireAdmin();
  const parsed = readSeasonWeek(formData);
  if (!parsed) return { error: 'Pick a valid season and preseason week.' };

  const [season] = await db
    .select({ year: seasons.year })
    .from(seasons)
    .where(eq(seasons.id, parsed.seasonId))
    .limit(1);
  if (!season) return { error: 'Season not found.' };

  const sync = await syncPreseasonWeek(parsed.seasonId, season.year, parsed.preseasonWeek);
  const gen = await generateMatchups(parsed.seasonId);
  revalidatePath('/admin/preseason');
  revalidatePath('/preseason');

  if (sync.gamesUpserted === 0) {
    return {
      ok: true,
      message: `No preseason games found for ${season.year} preseason week ${parsed.preseasonWeek} (ESPN may not have posted them yet).`,
    };
  }
  return {
    ok: true,
    message: `Synced ${sync.gamesUpserted} preseason games and regenerated matchups (${gen.matchupsUpserted} total, incl. exhibitions). Owners must be assigned for the matchups to fill.`,
  };
}

/** Parse pasted "Team, points" / "Team<tab>points" lines into a team→points map. */
function parseScoreLines(raw: string): Map<string, number> {
  const byTeam = new Map<string, number>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = /^(.*?)[,\t]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(trimmed);
    if (!m) continue;
    const team = m[1].trim();
    const pts = Number(m[2]);
    if (team && Number.isFinite(pts)) byTeam.set(team, pts);
  }
  return byTeam;
}

export async function pasteScoresAction(
  _prev: PreseasonFormState,
  formData: FormData,
): Promise<PreseasonFormState> {
  await requireAdmin();
  const parsed = readSeasonWeek(formData);
  if (!parsed) return { error: 'Pick a valid season and preseason week.' };

  const byTeam = parseScoreLines(String(formData.get('scores') ?? ''));
  if (byTeam.size === 0) {
    return { error: 'No scores parsed. Use one "Team, points" per line (comma or tab separated).' };
  }

  const res = await writeTeamScores({
    seasonId: parsed.seasonId,
    week: toExhibitionWeek(parsed.preseasonWeek),
    byTeam,
    source: 'manual',
    triggeredBy: 'admin:preseason',
  });
  revalidatePath('/admin/preseason');
  revalidatePath('/preseason');
  return {
    ok: true,
    message:
      `Recorded ${res.matched} exhibition scores` +
      (res.unmatched.length ? ` · unmatched teams: ${res.unmatched.join(', ')}` : '') +
      '. These do not affect the standings.',
  };
}
