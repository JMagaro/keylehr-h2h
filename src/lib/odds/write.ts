/**
 * Persists the Monte-Carlo odds engine's output. The only writer of `playoff_odds_snapshots` —
 * shared by the manual CLI (`scripts/compute-odds.ts`) and the weekly cron
 * (`src/app/api/cron/odds/route.ts`) so there is exactly one upsert path to keep correct.
 *
 * UPSERTs on the (season, week, owner) unique index, so re-running after a score change is
 * always safe.
 */
import { sql } from 'drizzle-orm';

import { db, playoffOddsSnapshots } from '@/db';
import type { OddsSnapshot } from './simulate';

export interface WriteOddsResult {
  weeks: number[];
  written: number;
}

/** Upsert a season's odds snapshots, one multi-row statement per week. */
export async function writeOddsSnapshots(
  seasonId: number,
  snapshots: OddsSnapshot[],
): Promise<WriteOddsResult> {
  const weeks = Array.from(new Set(snapshots.map((s) => s.week))).sort((a, b) => a - b);

  let written = 0;
  for (const week of weeks) {
    const rows = snapshots
      .filter((s) => s.week === week)
      .map((s) => ({
        seasonId,
        week: s.week,
        ownerSeasonId: s.ownerSeasonId,
        // numeric column → string with 2 decimals.
        oddsPct: s.oddsPct.toFixed(2),
      }));
    if (rows.length === 0) continue;
    await db
      .insert(playoffOddsSnapshots)
      .values(rows)
      .onConflictDoUpdate({
        target: [
          playoffOddsSnapshots.seasonId,
          playoffOddsSnapshots.week,
          playoffOddsSnapshots.ownerSeasonId,
        ],
        set: {
          oddsPct: sql`excluded.odds_pct`,
          computedAt: sql`now()`,
        },
      });
    written += rows.length;
  }

  return { weeks, written };
}
