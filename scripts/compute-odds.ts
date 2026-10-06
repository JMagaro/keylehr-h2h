/**
 * Compute & persist playoff-odds snapshots for a season.
 *
 * Runs the Monte-Carlo odds engine (`computePlayoffOddsSnapshots`) and UPSERTs
 * one `playoff_odds_snapshots` row per (season, week, owner). Idempotent: the
 * unique (season, week, owner) index lets us re-run any time scores change.
 *
 * Usage:
 *   npm run odds:compute                 # default: the most-recent season with data
 *   npm run odds:compute -- --season=2   # a specific season id
 *   npm run odds:compute -- --season=2 --sims=5000
 */
import '@/load-env';

import { getDefaultStandingsSeasonId } from '@/lib/standings/query';
import { computePlayoffOddsSnapshots } from '@/lib/odds/simulate';
import { writeOddsSnapshots } from '@/lib/odds/write';

function parseArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit?.slice(prefix.length);
}

async function main(): Promise<void> {
  const seasonArg = parseArg('season');
  const simsArg = parseArg('sims');

  const seasonId = seasonArg ? Number(seasonArg) : await getDefaultStandingsSeasonId();
  if (seasonId === null || Number.isNaN(seasonId)) {
    throw new Error('Could not resolve a season id. Pass --season=<id>.');
  }
  const sims = simsArg ? Number(simsArg) : undefined;

  console.log(`Computing playoff odds for season ${seasonId}${sims ? ` (${sims} sims)` : ''}…`);
  const started = Date.now();
  const snapshots = await computePlayoffOddsSnapshots(seasonId, sims ? { sims } : {});
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  if (snapshots.length === 0) {
    console.log('No scored regular-season games — nothing to compute.');
    return;
  }

  console.log(`Simulated in ${elapsed}s → ${snapshots.length} snapshots. Upserting…`);

  const { weeks, written } = await writeOddsSnapshots(seasonId, snapshots);
  console.log(`Done. Upserted ${written} snapshots across ${weeks.length} week(s) for season ${seasonId}.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
