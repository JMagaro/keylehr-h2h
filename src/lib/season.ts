/**
 * Shared season resolution helpers (server-only).
 */
import { sql } from 'drizzle-orm';

import { db, seasons, type Season } from '@/db';

/**
 * The "current" season for admin/public views: the active season if one exists,
 * otherwise the soonest upcoming, otherwise the most recent completed. Returns
 * null only if no seasons exist at all.
 */
export async function getCurrentSeason(): Promise<Season | null> {
  const rows = await db
    .select()
    .from(seasons)
    .orderBy(
      sql`case ${seasons.status} when 'active' then 0 when 'upcoming' then 1 else 2 end`,
      seasons.year,
    )
    .limit(1);
  return rows[0] ?? null;
}
