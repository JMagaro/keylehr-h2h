/**
 * Week detection endpoint (read-only) — tells the Chrome extension which week it is, and what
 * dates any given week covers.
 *
 * WHY IT EXISTS. The extension used to guess: parse `#N` out of the DraftKings contest name,
 * else fall back to `seasons.currentWeek`. A real contest name ("DraftKings - Test 2 by
 * Colts0094") contains no `#N`, and `currentWeek` is a hand-maintained column that nobody
 * remembers to advance. The preseason toggle was not detected at all — it simply remembered
 * its last state, which is how a capture landed in week 102 while the scores went to 103.
 *
 * The synced NFL schedule already knows both answers, so it should be the one giving them.
 *
 * THE STAKES. `scores` upserts on `(ownerSeasonId, week)`. Syncing a contest against the wrong
 * week silently OVERWRITES that week's real scores — no error, nothing to notice. Hence
 * `requested`: the extension shows the date range for whatever week is selected so a human can
 * confirm it before syncing, and warns when it disagrees with `detected`.
 *
 * Auth + CORS: identical to /api/seasons, so the extension reuses the one token it stores.
 *
 * Response:
 *   { detected: WeekInfo | null, requested: WeekInfo | null }
 * `detected` is null when the season has no synced games — the caller must treat that as
 * "unknown" and leave the week alone, never default to 1.
 */
import { NextResponse } from 'next/server';

import { isAuthorized } from '@/lib/ingest/auth';
import { detectCurrentWeek, getWeekRange } from '@/lib/schedule/current-week-query';
import type { WeekRange } from '@/lib/schedule/current-week';
import { exhibitionWeekLabel, isExhibitionWeek } from '@/lib/schedule/preseason';

// Neon's serverless driver requires the Node.js runtime.
export const runtime = 'nodejs';
// Always reflect the current time and the latest schedule.
export const dynamic = 'force-dynamic';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
} as const;

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

function label(week: number): string {
  return isExhibitionWeek(week) ? exhibitionWeekLabel(week) : `Week ${week}`;
}

/**
 * Shape sent to the extension.
 *
 * `week` is the STORED value (101–103 for exhibition), while `inputWeek` is what a human types
 * — 1–3 with the preseason box ticked. Sending both means the extension never has to know the
 * offset rule, which is the sort of duplicated arithmetic that drifts.
 */
function toWire(info: WeekRange | null) {
  if (!info) return null;
  return {
    week: info.week,
    inputWeek: isExhibitionWeek(info.week) ? info.week - 100 : info.week,
    isExhibition: info.isExhibition,
    label: label(info.week),
    firstKickoff: info.firstKickoff?.toISOString() ?? null,
    lastKickoff: info.lastKickoff?.toISOString() ?? null,
    gameCount: info.gameCount,
  };
}

export async function GET(request: Request): Promise<Response> {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: CORS });
  }

  const url = new URL(request.url);
  const seasonId = Number(url.searchParams.get('season'));
  if (!Number.isInteger(seasonId) || seasonId <= 0) {
    return NextResponse.json({ error: 'Pass ?season=<id>' }, { status: 400, headers: CORS });
  }

  const requestedWeek = Number(url.searchParams.get('week'));
  const [detected, requested] = await Promise.all([
    detectCurrentWeek(seasonId),
    Number.isInteger(requestedWeek) && requestedWeek > 0
      ? getWeekRange(seasonId, requestedWeek)
      : Promise.resolve(null),
  ]);

  return NextResponse.json(
    {
      detected: detected ? { ...toWire(detected), basis: detected.basis } : null,
      requested: toWire(requested),
    },
    { headers: CORS },
  );
}
