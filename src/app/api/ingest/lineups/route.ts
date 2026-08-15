/**
 * DraftKings ROSTER ingest endpoint (live scoring, Phase 2).
 *
 * The sibling of `/api/ingest/draftkings`. That endpoint records what each owner SCORED;
 * this one records WHO THEY STARTED, so the app can recompute a running total from ESPN's
 * public boxscore during games without a machine polling DraftKings all week.
 *
 * Auth: the same static bearer token (`INGEST_TOKEN`), via the shared `isAuthorized`.
 *
 * Accepted body shapes (any combination — later shapes win on duplicate entry names):
 *
 *   1. DK-raw bulk:      { rawRosters: <whatever DraftKings returned> }
 *   2. DK-raw per entry: { rawLineups: [{ entryName, entryKey?, roster: <DK payload> }] }
 *   3. Normalized:       { lineups: [{ entryName, entryKey?, slots: [{ slot, dkPlayerId, … }] }] }
 *
 * Shape 2 is what the Chrome extension sends, and it exists because DraftKings has NO bulk
 * roster endpoint — `embed=leaderboard,roster` answers 200 with an empty entry map, so the
 * extension fans out one authenticated request per entry. Each response identifies no owner
 * (the caller asked for a known entryKey), hence the paired `entryName`.
 *
 * Shapes 1 and 2 both hand DK's payload over verbatim. DK's roster endpoint is undocumented
 * and auth-gated, so the normalizer identifies roster rows STRUCTURALLY rather than by path
 * — see `src/lib/lineups/normalize.ts`. Keeping raw parsing on the server means one tested
 * implementation instead of a second copy inside the extension.
 *
 * `week` uses the same two disjoint namespaces as scores: 1–25 regular/playoff, 101–103
 * preseason exhibition. `isExhibition` is derived from the week alone.
 *
 * NOTHING here writes a score. See docs/SCORING.md §15.
 */
import { revalidateTag } from 'next/cache';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { liveTag } from '@/lib/live/stats';

import { isAuthorized } from '@/lib/ingest/auth';
import { weekSchema } from '@/lib/ingest/week-schema';
import { ingestLineups } from '@/lib/lineups/ingest';
import { normalizeRosterPayload, type LineupInput } from '@/lib/lineups/normalize';

// Neon's serverless driver requires the Node.js runtime.
export const runtime = 'nodejs';
// Never cache an ingest endpoint.
export const dynamic = 'force-dynamic';

/* -------------------------------------------------------------------------- */
/* Request validation                                                          */
/* -------------------------------------------------------------------------- */

const slotSchema = z.object({
  slot: z.string().nullable().optional(),
  dkPlayerId: z.string().nullable().optional(),
  draftableId: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  teamKey: z.string().nullable().optional(),
  position: z.string().nullable().optional(),
  /** Defaults true: a caller sending an explicit slot is naming a player they can see. */
  revealed: z.boolean().optional(),
  /** DraftKings' own points for this player, when the sender has them. */
  dkScore: z.number().finite().nullable().optional(),
  /** DraftKings' own per-stat breakdown, when the sender has it. */
  dkStats: z
    .array(
      z.object({
        key: z.string(),
        value: z.number().finite(),
        points: z.number().finite(),
      }),
    )
    .nullable()
    .optional(),
});

const lineupSchema = z.object({
  entryName: z.string().trim().min(1),
  entryKey: z.string().nullable().optional(),
  slots: z.array(slotSchema).min(1),
});

/** One entry's DraftKings roster response, paired with whose entry it is. */
const rawLineupSchema = z.object({
  entryName: z.string().trim().min(1),
  entryKey: z.string().nullable().optional(),
  roster: z.unknown(),
});

const bodySchema = z
  .object({
    seasonId: z.number().int().positive(),
    week: weekSchema,
    contestId: z.string().optional(),
    draftGroupId: z.string().optional(),
    /** ISO timestamp of the DraftKings read. Defaults to now when omitted. */
    capturedAt: z.string().datetime({ offset: true }).optional(),
    sourceUrlTemplate: z.string().optional(),
    /** Entry name to attribute a BARE roster payload to (per-entry endpoints). */
    entryName: z.string().optional(),
    lineups: z.array(lineupSchema).optional(),
    rawLineups: z.array(rawLineupSchema).optional(),
    rawRosters: z.unknown().optional(),
  })
  .refine(
    (b) =>
      (b.lineups?.length ?? 0) > 0 || (b.rawLineups?.length ?? 0) > 0 || b.rawRosters !== undefined,
    {
      message: 'Provide a non-empty `lineups`/`rawLineups` array or a `rawRosters` payload.',
    },
  );

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

  const {
    seasonId,
    week,
    contestId,
    draftGroupId,
    capturedAt,
    sourceUrlTemplate,
    entryName,
    lineups: explicitLineups,
    rawLineups,
    rawRosters,
  } = parsed.data;

  // Merge every accepted shape; later shapes win on duplicate entry names.
  const byName = new Map<string, LineupInput>();
  let normalizedFromRaw = 0;
  let skippedFromRaw = 0;

  if (rawRosters !== undefined) {
    const { lineups: norm, skipped } = normalizeRosterPayload(rawRosters, entryName);
    normalizedFromRaw = norm.length;
    skippedFromRaw = skipped;
    for (const l of norm) byName.set(l.entryName.trim().toLowerCase(), l);
  }
  if (rawLineups?.length) {
    for (const raw of rawLineups) {
      const { lineups: norm, skipped } = normalizeRosterPayload(raw.roster, raw.entryName);
      normalizedFromRaw += norm.length;
      skippedFromRaw += skipped;
      // A per-entry response has no entry name of its own, so the FIRST normalized lineup is
      // the one we asked for. DK returns exactly one; anything past it would be a shape change.
      const first = norm[0];
      if (!first) {
        skippedFromRaw += 1;
        continue;
      }
      byName.set(raw.entryName.trim().toLowerCase(), {
        ...first,
        entryName: raw.entryName,
        // The caller knows the entryKey it requested; DK's response body does not echo it.
        entryKey: raw.entryKey ?? first.entryKey ?? null,
      });
    }
  }
  if (explicitLineups?.length) {
    for (const l of explicitLineups) {
      byName.set(l.entryName.trim().toLowerCase(), {
        entryName: l.entryName,
        entryKey: l.entryKey ?? null,
        slots: l.slots.map((s) => ({
          slot: s.slot ?? null,
          dkPlayerId: s.dkPlayerId ?? null,
          draftableId: s.draftableId ?? null,
          name: s.name ?? null,
          teamKey: s.teamKey ?? null,
          position: s.position ?? null,
          // A slot with no identity at all is a concealed one, however it was sent.
          revealed: s.revealed ?? Boolean(s.draftableId || s.dkPlayerId || s.name),
          dkScore: s.dkScore ?? null,
          dkStats: s.dkStats ?? null,
        })),
      });
    }
  }

  const lineups = [...byName.values()];
  if (lineups.length === 0) {
    return NextResponse.json(
      {
        error:
          'No usable lineups after normalization. ' +
          `Skipped ${skippedFromRaw} roster group(s) (no entry name, or no players). ` +
          'If this was a single-entry payload, pass `entryName` so it can be attributed.',
      },
      { status: 400 },
    );
  }

  try {
    const result = await ingestLineups({
      seasonId,
      week,
      lineups,
      capturedAt: capturedAt ? new Date(capturedAt) : new Date(),
      contestId,
      draftGroupId,
      sourceUrlTemplate,
      triggeredBy: 'extension',
      rawPayload: rawRosters ?? rawLineups ?? lineups,
    });

    // A capture is the one moment we KNOW the roster changed, and it usually happens because
    // games are underway. Drop the week's cached ESPN index so the newly-revealed players are
    // scored against current stats rather than whatever was cached up to 30s ago.
    //
    // (The snapshots themselves are read uncached, so /live would pick up the new roster
    // regardless — this is about the stat side, and it is the only caller of `liveTag`.)
    //
    // NOTE the second argument. In Next 16 `revalidateTag` requires a cache-life profile
    // (`'max'` = stale-while-revalidate: serve the stale entry, refresh behind it), even
    // though the caching-without-cache-components guide still shows the one-argument form.
    // The type declaration is the authority here — see node_modules/next/cache.d.ts.
    revalidateTag(liveTag(seasonId, week), 'max');

    return NextResponse.json({
      matched: result.matched,
      unmatched: result.unmatched,
      total: result.total,
      snapshots: result.snapshots,
      captureRunId: result.captureRunId,
      week,
      seasonId,
      normalizedFromRaw,
      skippedFromRaw,
      // Team/position resolution against the public draftables endpoint. Zero enriched with a
      // draftGroupId set means DK's slate lookup failed — the capture stored, but is not yet
      // scorable, so it should be re-run rather than trusted.
      enrichedSlots: result.enrichedSlots,
      unresolvedDraftableIds: result.unresolvedDraftableIds,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: `Roster ingest failed: ${message}` }, { status: 500 });
  }
}
