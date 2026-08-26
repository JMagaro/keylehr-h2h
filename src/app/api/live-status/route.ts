/**
 * Capture-staleness endpoint (read-only) — tells the Chrome extension whether re-reading all
 * 32 rosters would actually change anything.
 *
 * WHY IT EXISTS. Live Sync polls the DraftKings LEADERBOARD every few minutes, which is one
 * request and upserts one row per owner, so polling it is free. Rosters are the opposite: DK
 * has no bulk roster endpoint (see extension/page-hook.js), so a refresh costs one credentialed
 * request PER ENTRY, and every capture is stored append-only. Re-reading them on every poll
 * would be ~4,000 requests against the commissioner's own DraftKings account across a Sunday,
 * nearly all of them returning byte-identical rosters.
 *
 * The thing a re-capture actually fixes is CONCEALMENT: DraftKings hides a player until their
 * game kicks off, so a 1pm capture legitimately misses the late slate, and those players then
 * score points the estimate cannot see because it does not know their names. That has a precise
 * test, which the app already implements and tests — `assessCaptureStaleness` — and it is a
 * question only the app can answer, since only the app knows the kickoff schedule and what the
 * last capture contained.
 *
 * So the extension asks, on each poll, and pays for rosters only when the answer is yes. That
 * turns a fixed ~32 requests/poll into roughly 6-8 refreshes across a whole week, landing within
 * one poll of each kickoff.
 *
 * Auth + CORS: identical to /api/current-week, so the extension reuses the one token it stores.
 *
 * NOTHING HERE WRITES. It runs the same read path as /live.
 */
import { NextResponse } from 'next/server';

import { isAuthorized } from '@/lib/ingest/auth';
import { assembleLive } from '@/lib/live/assemble';
import { getLiveWeekData } from '@/lib/live/query';
import { assessCaptureStaleness, countConcealedSlots } from '@/lib/live/staleness';
import { getLiveStatsForWeek } from '@/lib/live/stats';
import { MAX_EXHIBITION_WEEK } from '@/lib/ingest/week-schema';

// Neon's serverless driver requires the Node.js runtime.
export const runtime = 'nodejs';
// Always reflect the current clock and the latest capture.
export const dynamic = 'force-dynamic';
/** The ESPN index is usually warm, but a cold week fans out to ~16 summaries. */
export const maxDuration = 30;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
} as const;

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET(request: Request): Promise<Response> {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: CORS });
  }

  const url = new URL(request.url);
  const seasonId = Number(url.searchParams.get('season'));
  const week = Number(url.searchParams.get('week'));
  if (!Number.isInteger(seasonId) || seasonId <= 0) {
    return NextResponse.json({ error: 'Pass ?season=<id>' }, { status: 400, headers: CORS });
  }
  if (!Number.isInteger(week) || week <= 0 || week > MAX_EXHIBITION_WEEK) {
    return NextResponse.json({ error: 'Pass ?week=<n>' }, { status: 400, headers: CORS });
  }

  const data = await getLiveWeekData(seasonId, week);
  const index = await getLiveStatsForWeek(seasonId, week, data.games);
  const view = assembleLive(data.matchups, data.snapshots, index);

  const concealedSlots = countConcealedSlots(view.matchups);
  const staleness = assessCaptureStaleness({
    games: index.games,
    kickoffByTeam: Object.fromEntries(
      Object.entries(data.teamContext).map(([k, c]) => [k, c.kickoff]),
    ),
    capturedAt: view.latestCapturedAt,
    concealedSlots,
  });

  // A week with matchups but no capture at all is the one case staleness cannot speak to —
  // there is no `capturedAt` to compare kickoffs against, so it returns false. From the
  // extension's point of view that is precisely when it should capture: there is nothing yet.
  const hasCapture = view.latestCapturedAt !== null;
  const shouldRecapture = view.matchups.length > 0 && (!hasCapture || staleness.shouldRecapture);

  const reason = !view.matchups.length
    ? 'no matchups for this week'
    : !hasCapture
      ? 'no capture yet for this week'
      : staleness.shouldRecapture
        ? `${staleness.gamesStartedSinceCapture} game(s) kicked off since the capture, ${concealedSlots} slot(s) still concealed`
        : concealedSlots === 0
          ? 'every slot is revealed'
          : 'no game has kicked off since the last capture';

  return NextResponse.json(
    {
      shouldRecapture,
      reason,
      hasCapture,
      capturedAt: view.latestCapturedAt?.toISOString() ?? null,
      concealedSlots,
      gamesStartedSinceCapture: staleness.gamesStartedSinceCapture,
      gamesLoaded: view.gamesLoaded,
      gamesTotal: view.gamesTotal,
      matchups: view.matchups.length,
      missingCaptures: view.missingCaptures.length,
    },
    { headers: CORS },
  );
}
