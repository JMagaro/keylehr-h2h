/**
 * Snapshot or grade the lineup models for a given week, from the CLI — so the work can be
 * automated (cron / the scheduled cloud routine) instead of only via Admin → Models.
 *
 * Usage:
 *   tsx scripts/models.ts --action=snapshot --season=<id> --week=<n>
 *   tsx scripts/models.ts --action=grade    --season=<id> --week=<n>
 *
 * Omit --season to use the current/upcoming season; omit --week to use that season's
 * currentWeek. Requires DATABASE_URL (loaded via @/load-env).
 */
import '@/load-env';

import { getBuilderSeasons, pickDefaultBuilderSeason } from '@/lib/players/query';
import { gradeWeek, snapshotWeek } from '@/lib/players/performance';

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : undefined;
}

async function main(): Promise<boolean> {
  const action = (arg('action') ?? 'snapshot').toLowerCase();
  if (action !== 'snapshot' && action !== 'grade') {
    console.error('Invalid --action (use snapshot | grade).');
    return false;
  }

  const seasons = await getBuilderSeasons();
  const seasonArg = Number(arg('season'));
  const season =
    seasons.find((s) => s.id === seasonArg) ?? pickDefaultBuilderSeason(seasons) ?? seasons[0];
  if (!season) {
    console.error('No season found.');
    return false;
  }

  const weekArg = Number(arg('week'));
  const week =
    Number.isInteger(weekArg) && weekArg >= 1 && weekArg <= season.regularSeasonWeeks
      ? weekArg
      : Math.min(Math.max(season.currentWeek, 1), season.regularSeasonWeeks);

  console.log(`[models] ${action} — ${season.name} (id ${season.id}) week ${week}`);

  if (action === 'snapshot') {
    const res = await snapshotWeek(season.id, week);
    console.log(
      `  snapshotted ${res.snapshots} models (${res.salaryMode ? 'salary mode' : 'signal-only'}).`,
    );
  } else {
    const res = await gradeWeek(season.id, week);
    console.log(`  graded ${res.graded} models.${res.note ? ` (${res.note})` : ''}`);
  }
  return true;
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((err: unknown) => {
    console.error('[models] failed:', err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
