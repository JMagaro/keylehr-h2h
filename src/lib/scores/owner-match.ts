/**
 * Owner name matching, shared by the score ingest and the roster ingest.
 *
 * Moved out of `scores/ingest.ts` (where it was private) when roster capture was added.
 * BOTH ingests must resolve a DraftKings entry name to an owner identically — if they ever
 * diverge, an owner's roster and their score land on different rows and the live page shows
 * one person's lineup against another person's total.
 */
import { eq } from 'drizzle-orm';

import { db, owners, ownerSeasons } from '@/db';

export interface OwnerSeasonMatchRow {
  ownerSeasonId: number;
  dkEntryName: string | null;
  dkUsername: string | null;
}

/** Normalize a DraftKings entry name for matching: trimmed + lowercased. */
export function normalizeEntryName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Load the season's owners and build a normalized-name → ownerSeasonId map.
 * Prefers `dkEntryName`; falls back to `dkUsername`. Both keys (when distinct) map
 * to the same owner so either form on the leaderboard matches.
 */
export async function loadOwnerNameMap(seasonId: number): Promise<{
  byName: Map<string, number>;
  rows: OwnerSeasonMatchRow[];
}> {
  const rows = await db
    .select({
      ownerSeasonId: ownerSeasons.id,
      dkEntryName: ownerSeasons.dkEntryName,
      dkUsername: owners.dkUsername,
    })
    .from(ownerSeasons)
    .innerJoin(owners, eq(ownerSeasons.ownerId, owners.id))
    .where(eq(ownerSeasons.seasonId, seasonId));

  const byName = new Map<string, number>();
  for (const r of rows) {
    if (r.dkEntryName) byName.set(normalizeEntryName(r.dkEntryName), r.ownerSeasonId);
    // Only fall back to username when it does not collide with an explicit entry name.
    if (r.dkUsername) {
      const key = normalizeEntryName(r.dkUsername);
      if (!byName.has(key)) byName.set(key, r.ownerSeasonId);
    }
  }
  return { byName, rows };
}
