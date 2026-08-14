/**
 * Recompute `season_awards` — the league's payout ledger.
 *
 * A thin CLI over `src/lib/awards/service.ts`; all the logic (and its tests) lives there.
 *
 * Awards computed:
 *   champion / runner_up      — from the resolved championship game
 *   third / fourth            — from the resolved `third_place` consolation game (winner 3rd,
 *                               loser 4th). `--third` is a LEGACY fallback, used only for a
 *                               season imported before that game was modelled (2023-2025)
 *   weekly_high               — top score each week, capped to the regular season
 *   season_high               — the best of those weekly highs
 *   most_points               — most regular-season Points For, taken from the standings
 *                               engine so it matches /standings
 *
 * Ties are SPLIT EVENLY, one row per tied owner, summing to exactly the prize.
 * Payouts come from each season's own `seasons.rules`, so Admin → Settings overrides apply.
 *
 * Usage:
 *   npm run import:awards -- --dry-run              # preview every eligible season
 *   npm run import:awards -- --season=1             # one season
 *   npm run import:awards -- --season=1 --third=42  # legacy: 3rd/4th for a pre-consolation season
 *   npm run import:awards -- --force                # include the frozen 2023-2025 seasons
 *
 * 2023-2025 are FROZEN (played and paid under the rules of their day) and are skipped
 * unless `--force` is passed. `npm run verify` fails if their ledger ever changes.
 */
import '@/load-env';

import { db, ownerSeasons } from '@/db';
import { recomputeSeasonAwards } from '@/lib/awards/service';
import { formatMoney } from '@/lib/utils';

function flag(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const force = process.argv.includes('--force');
  const seasonArg = flag('season');
  const thirdArg = flag('third');

  const osRows = await db.select({ seasonId: ownerSeasons.seasonId }).from(ownerSeasons);
  const allSeasonIds = [...new Set(osRows.map((r) => r.seasonId))].sort((a, b) => a - b);
  const seasonIds = seasonArg ? [Number(seasonArg)] : allSeasonIds;

  if (seasonIds.length === 0) {
    console.log('No seasons with data.');
    return;
  }

  for (const seasonId of seasonIds) {
    const result = await recomputeSeasonAwards(seasonId, {
      dryRun,
      force,
      thirdPlaceOwnerSeasonId: thirdArg ? Number(thirdArg) : undefined,
    });

    console.log(`\n=== ${result.year} (season ${result.seasonId}) ===`);
    if (result.skipped) {
      console.log(`  SKIPPED — ${result.skipped}`);
      continue;
    }
    for (const note of result.notes) console.log(`  ${note}`);

    const total = result.awards.reduce((sum, a) => sum + a.amountCents, 0);
    const byType = new Map<string, number>();
    for (const a of result.awards) byType.set(a.type, (byType.get(a.type) ?? 0) + 1);
    for (const [type, count] of [...byType].sort()) {
      console.log(`  ${type.padEnd(12)} ${count} row(s)`);
    }
    console.log(`  ${result.awards.length} awards · ${formatMoney(total)} total`);

    if (dryRun) console.log('  [dry-run] nothing written');
    else console.log(`  ✓ inserted ${result.inserted}, pruned ${result.deleted}`);
  }

  console.log('\nDone.');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
