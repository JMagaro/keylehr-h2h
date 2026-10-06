/**
 * Weekly playoff-odds snapshot — the server-side counterpart to `npm run odds:compute`.
 *
 * Unlike the DraftKings pull (see `docs/DEPLOYMENT.md` §6, rejected because it needs the
 * commissioner's authenticated session), this computation needs nothing but the database, so
 * a Vercel Cron can run it safely. Triggered by `vercel.json`'s `crons` entry, Tuesdays at
 * 11:00 UTC — chosen to land well after a typical week's Monday-night sync (see
 * `docs/RUNBOOK.md` §2), so the odds trend already reflects the week just finished. The engine
 * re-derives the ENTIRE trend from whatever is scored so far and upserts idempotently, so a
 * late sync just means that week's line catches up on the following Tuesday rather than this
 * one — never a wrong or stuck number.
 *
 * Auth: a static bearer token (`CRON_SECRET`), the same contract as every ingest route. Vercel
 * sends this automatically on scheduled invocations once the env var is set; a request without
 * it is rejected, same as a misconfigured deploy rejecting everything rather than falling open.
 */
import { NextResponse } from 'next/server';

import { timingSafeEqual } from '@/lib/ingest/auth';
import { computePlayoffOddsSnapshots } from '@/lib/odds/simulate';
import { writeOddsSnapshots } from '@/lib/odds/write';
import { getDefaultStandingsSeasonId } from '@/lib/standings/query';

// Neon's serverless driver requires the Node.js runtime.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** A full-season Monte-Carlo run measured at ~5.5s locally; generous headroom for a cold start. */
export const maxDuration = 30;

function isAuthorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false; // Misconfigured server → reject everything.
  const header = request.headers.get('authorization') ?? '';
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;
  return timingSafeEqual(header.slice(prefix.length), expected);
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const seasonId = await getDefaultStandingsSeasonId();
  if (seasonId === null) {
    return NextResponse.json({ ok: true, skipped: 'no season with data' });
  }

  const snapshots = await computePlayoffOddsSnapshots(seasonId);
  if (snapshots.length === 0) {
    return NextResponse.json({ ok: true, seasonId, skipped: 'no scored regular-season games' });
  }

  const { weeks, written } = await writeOddsSnapshots(seasonId, snapshots);
  return NextResponse.json({ ok: true, seasonId, weeks: weeks.length, written });
}
