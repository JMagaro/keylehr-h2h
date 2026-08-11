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
      // Within a bucket the direction differs: for upcoming seasons we want the SOONEST, but
      // for completed ones the MOST RECENT. A plain ascending `year` gave the soonest for
      // both — i.e. the oldest completed season, contradicting the contract above. Latent
      // while any season is active or upcoming; it would surface the first time every
      // season is completed.
      sql`case when ${seasons.status} = 'completed' then -${seasons.year} else ${seasons.year} end`,
    )
    .limit(1);
  return rows[0] ?? null;
}
