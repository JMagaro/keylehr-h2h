/**
 * DraftKings leaderboard ingest endpoint (Stage 2 — Browser Sync).
 *
 * The "KeyLehr H2H — DraftKings Sync" Chrome extension runs in the commissioner's
 * logged-in DraftKings session, reads the shared private contest's leaderboard from the
 * page's own network traffic / page data, and POSTs it here. The server matches each
 * entry to an owner and upserts that owner's weekly score (see {@link ingestLeaderboard}).
 *
 * Auth: a static bearer token (`INGEST_TOKEN`) compared in constant time. The extension
 * stores the same token in chrome.storage. This is deliberately simple — the endpoint only
 * accepts a normalized leaderboard and never reads DraftKings itself.
 *
 * Two accepted body shapes (either, or both — `rawLeaderboard` is normalized first and the
 * results are merged, with explicit `entries` taking precedence on duplicate names):
 *
 *   1. Normalized:  { entries: { entryName, points, rank?, entryKey? }[] }
 *   2. DK-raw:      { rawLeaderboard: <DK leaderboard objects>[] }  ← extension may post DK's
 *      own JSON verbatim; we map common DK field names → entryName/points server-side.
 *
 * Always also requires `{ seasonId, week }`; `contestId` is optional (stored for traceability).
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { ingestLeaderboard, type LeaderboardEntry } from '@/lib/scores/ingest';

// Neon's serverless driver requires the Node.js runtime.
export const runtime = 'nodejs';
// Never cache an ingest endpoint.
export const dynamic = 'force-dynamic';

/* -------------------------------------------------------------------------- */
/* Request validation                                                          */
/* -------------------------------------------------------------------------- */

/** A leaderboard entry already in our normalized shape. */
const entrySchema = z.object({
  entryName: z.string().trim().min(1),
  points: z.number().finite(),
  rank: z.number().int().nonnegative().optional(),
  entryKey: z.string().optional(),
});

/**
 * A raw DraftKings leaderboard object. DK's payloads vary by endpoint/version, so we accept
 * a permissive bag of the field names seen in the wild and normalize below. `z.unknown()`
 * keeps unknown keys without failing validation.
 */
const rawEntrySchema = z.record(z.string(), z.unknown());

const bodySchema = z
  .object({
    seasonId: z.number().int().positive(),
    week: z.number().int().min(1).max(25),
    contestId: z.string().optional(),
    entries: z.array(entrySchema).optional(),
    rawLeaderboard: z.array(rawEntrySchema).optional(),
  })
  .refine((b) => (b.entries?.length ?? 0) > 0 || (b.rawLeaderboard?.length ?? 0) > 0, {
    message: 'Provide a non-empty `entries` or `rawLeaderboard` array.',
  });

/* -------------------------------------------------------------------------- */
/* DK-raw → normalized mapping                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Candidate DK field names → our fields. DraftKings uses different casings across endpoints
 * (REST `scores/v1/leaderboards` uses snake_case; some page payloads use camelCase/PascalCase),
 * so we probe a prioritized list and take the first present, non-null value.
 */
const NAME_KEYS = [
  'userName',
  'user_name',
  'UserName',
  'displayName',
  'screenName',
  'entryName',
  'EntryName',
  'draftGroupPlayerName',
] as const;

const POINTS_KEYS = [
  'fantasyPoints',
  'fantasy_points',
  'FantasyPoints',
  'fantasyPointsTotal',
  'points',
  'Points',
  'score',
  'Score',
] as const;

const RANK_KEYS = ['rank', 'Rank', 'currentRank', 'standing'] as const;

const ENTRY_KEY_KEYS = [
  'entryKey',
  'entry_key',
  'EntryKey',
  'entryId',
  'EntryId',
  'draftGroupPlayerId',
] as const;

function firstValue(obj: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/** Coerce DK's points (number or string like "241.68" / "1,234.5") to a finite number. */
function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toOptionalInt(v: unknown): number | undefined {
  const n = toNumber(v);
  return n === null ? undefined : Math.trunc(n);
}

function toOptionalString(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  return String(v);
}

/**
 * Normalize an array of raw DK leaderboard objects to our {@link LeaderboardEntry} shape.
 * Objects missing a usable name or points are skipped (and counted) rather than failing the
 * whole request — partial DK payloads still ingest what they can.
 */
function normalizeRaw(raw: Record<string, unknown>[]): {
  entries: LeaderboardEntry[];
  skipped: number;
} {
  const entries: LeaderboardEntry[] = [];
  let skipped = 0;

  for (const obj of raw) {
    const name = toOptionalString(firstValue(obj, NAME_KEYS))?.trim();
    const points = toNumber(firstValue(obj, POINTS_KEYS));
    if (!name || points === null) {
      skipped += 1;
      continue;
    }
    entries.push({
      entryName: name,
      points,
      rank: toOptionalInt(firstValue(obj, RANK_KEYS)),
      entryKey: toOptionalString(firstValue(obj, ENTRY_KEY_KEYS)),
    });
  }

  return { entries, skipped };
}

/* -------------------------------------------------------------------------- */
/* Auth                                                                        */
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

/* -------------------------------------------------------------------------- */
/* Handler                                                                     */
/* -------------------------------------------------------------------------- */

export async function POST(request: Request): Promise<Response> {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { seasonId, week, contestId, entries: rawEntries, rawLeaderboard } = parsed.data;

  // Merge explicit + DK-raw entries; explicit `entries` win on duplicate names.
  const byName = new Map<string, LeaderboardEntry>();
  let normalizedFromRaw = 0;
  let skippedFromRaw = 0;

  if (rawLeaderboard?.length) {
    const { entries: norm, skipped } = normalizeRaw(rawLeaderboard);
    normalizedFromRaw = norm.length;
    skippedFromRaw = skipped;
    for (const e of norm) byName.set(e.entryName.trim().toLowerCase(), e);
  }
  if (rawEntries?.length) {
    for (const e of rawEntries) byName.set(e.entryName.trim().toLowerCase(), e);
  }

  const entries = [...byName.values()];
  if (entries.length === 0) {
    return NextResponse.json(
      {
        error:
          'No usable leaderboard entries after normalization. ' +
          `Skipped ${skippedFromRaw} raw rows (missing name or points).`,
      },
      { status: 400 },
    );
  }

  try {
    const result = await ingestLeaderboard({
      seasonId,
      week,
      entries,
      contestId,
      source: 'auto',
      triggeredBy: 'extension',
    });

    return NextResponse.json({
      matched: result.matched,
      unmatched: result.unmatched,
      week,
      seasonId,
      total: result.total,
      byes: result.byes,
      importRunId: result.importRunId,
      normalizedFromRaw,
      skippedFromRaw,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: `Ingest failed: ${message}` }, { status: 500 });
  }
}
