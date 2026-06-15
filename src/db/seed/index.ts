/**
 * Database seed — KeyLehr H2H Fantasy Football League.
 *
 * Seeds the static/initial reference data the app needs before any league play:
 *   1. The 32 NFL teams (see `./teams`).
 *   2. The current season (Season 4 / 2026).
 *
 * Idempotent: every write is an upsert keyed on a stable unique column (`key` for
 * teams, `year` for the season), so running it repeatedly converges on the same
 * state and never creates duplicates. Safe to re-run after schema/data tweaks.
 *
 * Run with:  npm run db:seed   (alias for `tsx src/db/seed/index.ts`)
 *
 * NOTE: env is loaded first thing so the shared `db` client (which throws when
 * `DATABASE_URL` is unset) can read the connection string from `.env*`.
 */
import '@/load-env'; // must precede any import that reads process.env (e.g. @/db)

import { sql } from 'drizzle-orm';

import { db, nflTeams, seasons } from '@/db';
import type { NewSeason } from '@/db/schema';

import { NFL_TEAMS } from './teams';

/**
 * The current league season. Inserted once and kept in sync on re-run; the
 * database-generated `id` and the columns with schema defaults (`currentWeek`,
 * `createdAt`) are intentionally left to the database.
 */
const CURRENT_SEASON: NewSeason = {
  year: 2026,
  name: '2026 Season',
  status: 'upcoming',
  regularSeasonWeeks: 18,
  entryFeeCents: 15500,
};

/**
 * Upsert all 32 NFL teams, keyed on the unique `key` column. On conflict the
 * mutable descriptive columns are refreshed so corrections to the seed data
 * (e.g. a relocation or an ESPN id fix) propagate on the next run.
 */
async function seedTeams(): Promise<number> {
  await db
    .insert(nflTeams)
    .values([...NFL_TEAMS])
    .onConflictDoUpdate({
      target: nflTeams.key,
      set: {
        location: sqlExcluded('location'),
        name: sqlExcluded('name'),
        conference: sqlExcluded('conference'),
        division: sqlExcluded('division'),
        espnId: sqlExcluded('espn_id'),
      },
    });

  return NFL_TEAMS.length;
}

/**
 * Upsert the current season, keyed on the unique `year` column. On conflict the
 * descriptive/config columns are refreshed; `currentWeek` is deliberately left
 * untouched so re-seeding never rewinds an in-progress season.
 */
async function seedSeason(): Promise<void> {
  await db
    .insert(seasons)
    .values(CURRENT_SEASON)
    .onConflictDoUpdate({
      target: seasons.year,
      set: {
        name: sqlExcluded('name'),
        status: sqlExcluded('status'),
        regularSeasonWeeks: sqlExcluded('regular_season_weeks'),
        entryFeeCents: sqlExcluded('entry_fee_cents'),
      },
    });
}

/**
 * Build an `excluded.<column>` reference for the `set` clause of an upsert, so
 * conflicting rows are updated with the values we just attempted to insert.
 * `column` is the underlying snake_case database column name.
 */
function sqlExcluded(column: string) {
  return sql.raw(`excluded.${column}`);
}

/** Run the full seed, log a concise summary, and exit cleanly. */
async function main(): Promise<void> {
  const teamCount = await seedTeams();
  await seedSeason();

  console.log('Seed complete:');
  console.log(`  - NFL teams upserted: ${teamCount}`);
  console.log(`  - Season upserted:    ${CURRENT_SEASON.name} (year ${CURRENT_SEASON.year})`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exit(1);
  });
