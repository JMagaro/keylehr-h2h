/**
 * CLI: pull the NFL schedule from ESPN and generate owner matchups.
 *
 * Runs the two-stage pipeline for one season:
 *   1. `syncSeasonSchedule` — fetch ESPN regular-season games into `nfl_games`.
 *   2. `generateMatchups`   — derive owner-vs-owner `matchups` from those games.
 *
 * Usage:
 *   npm run schedule:pull                 # uses the active (else upcoming) season in DB
 *   npm run schedule:pull -- --year=2026  # targets the season with that calendar year
 *
 * The target season must already exist in the `seasons` table (seed it first). The
 * ESPN `year` defaults to the resolved season's `year` column.
 *
 * Requires DATABASE_URL (loaded from .env.local/.env via @/load-env). Without it the
 * shared `db` client throws on first use — expected when running outside a configured env.
 */
import '@/load-env'; // must precede any import that reads process.env (e.g. @/db)

import { eq } from 'drizzle-orm';

import { db, seasons, type Season } from '@/db';
import { generateMatchups } from '@/lib/matchups/generate';
import { syncSeasonSchedule } from '@/lib/schedule/sync';

/** Parsed command-line options. */
interface CliOptions {
  /** Explicit NFL calendar year to target (from `--year=YYYY`), if provided. */
  year?: number;
}

/** Parse `--year=2026` / `--year 2026` style flags from argv. */
function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--year=')) {
      options.year = Number(arg.slice('--year='.length));
    } else if (arg === '--year') {
      options.year = Number(argv[i + 1]);
      i += 1;
    }
  }

  if (options.year !== undefined && !Number.isInteger(options.year)) {
    throw new Error(`Invalid --year value: expected an integer, got "${options.year}".`);
  }

  return options;
}

/**
 * Resolve which season to operate on.
 *  - With `--year`, the season whose `year` matches (must exist).
 *  - Otherwise the single `active` season; failing that, the soonest `upcoming` one.
 */
async function resolveSeason(year: number | undefined): Promise<Season> {
  if (year !== undefined) {
    const [season] = await db.select().from(seasons).where(eq(seasons.year, year)).limit(1);
    if (!season) {
      throw new Error(
        `No season found for year ${year}. Seed it first (npm run db:seed) or pass an existing year.`,
      );
    }
    return season;
  }

  const [active] = await db
    .select()
    .from(seasons)
    .where(eq(seasons.status, 'active'))
    .limit(1);
  if (active) return active;

  const [upcoming] = await db
    .select()
    .from(seasons)
    .where(eq(seasons.status, 'upcoming'))
    .orderBy(seasons.year)
    .limit(1);
  if (upcoming) return upcoming;

  throw new Error(
    'No active or upcoming season found. Seed a season or pass --year=YYYY explicitly.',
  );
}

async function main(): Promise<void> {
  const { year } = parseArgs(process.argv.slice(2));

  const season = await resolveSeason(year);
  console.log(
    `Targeting season "${season.name}" (id=${season.id}, year=${season.year}, status=${season.status}).`,
  );

  console.log(`\n[1/2] Syncing NFL schedule from ESPN for ${season.year} ...`);
  const sync = await syncSeasonSchedule(season.id, season.year, season.regularSeasonWeeks);
  console.log(
    `      weeks processed: ${sync.weeksProcessed}, games upserted: ${sync.gamesUpserted}`,
  );
  if (sync.unmappedEspnTeamIds.length > 0) {
    console.warn(
      `      WARNING: ${sync.unmappedEspnTeamIds.length} unmapped ESPN team id(s): ` +
        `${sync.unmappedEspnTeamIds.join(', ')} (check nfl_teams.espn_id seed data).`,
    );
  }

  console.log(`\n[2/2] Generating owner matchups ...`);
  const gen = await generateMatchups(season.id);
  console.log(
    `      matchups upserted: ${gen.matchupsUpserted}, byes: ${gen.byes}, ` +
      `games skipped (unassigned team): ${gen.gamesSkippedUnassigned}`,
  );

  console.log('\nDone.');
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error('\nschedule:pull failed:');
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  });
