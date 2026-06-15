/**
 * Seasons list endpoint (read-only) — used by the "KeyLehr H2H — DraftKings Sync" extension to
 * populate its Season dropdown AND as a lightweight "Test connection" probe.
 *
 * Auth: the same static bearer token (`INGEST_TOKEN`) as the ingest route, compared in constant
 * time. This is deliberately identical to `ingest/draftkings/route.ts` so the extension can reuse
 * the one token it already stores. The endpoint is read-only and never mutates anything.
 *
 * Response: `{ seasons: [{ id, name, status, currentWeek, regularSeasonWeeks }], currentSeasonId }`
 * ordered active → upcoming → completed, then by year. `currentSeasonId` comes from
 * `getCurrentSeason()` (the season the app considers "current"), so the extension can default its
 * dropdown to it.
 *
 * CORS: the extension fetches with the bearer token and already has host permission for the app
 * origin, so CORS headers are not strictly required — but we send `Access-Control-Allow-Origin: *`
 * and handle `OPTIONS` preflight so the call is safe from any extension/page context. This is a
 * read-only, token-guarded endpoint, so a permissive origin is acceptable.
 */
import { sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { db, seasons } from '@/db';
import { getCurrentSeason } from '@/lib/season';

// Neon's serverless driver requires the Node.js runtime.
export const runtime = 'nodejs';
// Always reflect the latest season state.
export const dynamic = 'force-dynamic';

/* -------------------------------------------------------------------------- */
/* Auth (mirrors ingest/draftkings/route.ts)                                   */
/* -------------------------------------------------------------------------- */

/** Constant-time string comparison that avoids leaking length via early return. */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  // Compare against the longer length so timing does not depend on the shorter input.
  const len = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < len; i += 1) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

function isAuthorized(request: Request): boolean {
  const expected = process.env.INGEST_TOKEN;
  if (!expected) return false; // Misconfigured server → reject everything.
  const header = request.headers.get('authorization') ?? '';
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;
  return timingSafeEqual(header.slice(prefix.length), expected);
}

/** Permissive CORS headers for this read-only, token-guarded endpoint. */
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

/* -------------------------------------------------------------------------- */
/* Handlers                                                                     */
/* -------------------------------------------------------------------------- */

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(request: Request): Promise<Response> {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: CORS_HEADERS });
  }

  try {
    const rows = await db
      .select({
        id: seasons.id,
        name: seasons.name,
        status: seasons.status,
        currentWeek: seasons.currentWeek,
        regularSeasonWeeks: seasons.regularSeasonWeeks,
      })
      .from(seasons)
      .orderBy(
        sql`case ${seasons.status} when 'active' then 0 when 'upcoming' then 1 else 2 end`,
        seasons.year,
      );

    const current = await getCurrentSeason();

    return NextResponse.json(
      { seasons: rows, currentSeasonId: current?.id ?? null },
      { headers: CORS_HEADERS },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json(
      { error: `Failed to load seasons: ${message}` },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
