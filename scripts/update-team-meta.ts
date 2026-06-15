/**
 * Backfill NFL team branding metadata (logos + colors) onto `nfl_teams`.
 *
 * For each row in `TEAM_META` (see src/db/seed/team-meta.ts) this UPDATEs the
 * matching `nfl_teams` row, setting the color / DraftKings-label / nfl_team_id /
 * logo columns.
 *
 * MATCH KEY: by NICKNAME — `nfl_teams.name === meta.nickname`. All 32 nicknames
 * are unique, and matching on nickname sidesteps the Washington abbreviation
 * mismatch (`meta.abbr` = "WAS" but `nfl_teams.key` = "WSH").
 *
 * Idempotent: re-running converges on the same state (a plain UPDATE per team).
 * Empty-string colors (some teams' tertiary/quaternary) are stored as NULL.
 *
 * Run with:  npm run team:meta   (alias for `tsx scripts/update-team-meta.ts`)
 */
import '@/load-env'; // must precede any import that reads process.env (e.g. @/db)

import { eq } from 'drizzle-orm';

import { db, nflTeams } from '@/db';
import { TEAM_META } from '@/db/seed/team-meta';

/** Normalize a hex color: empty/whitespace → null, otherwise the trimmed value. */
function color(value: string): string | null {
  const v = value.trim();
  return v.length > 0 ? v : null;
}

async function main(): Promise<void> {
  let updated = 0;
  const missing: string[] = [];

  for (const meta of TEAM_META) {
    const result = await db
      .update(nflTeams)
      .set({
        primaryColor: color(meta.colors.primary),
        secondaryColor: color(meta.colors.secondary),
        tertiaryColor: color(meta.colors.tertiary),
        quaternaryColor: color(meta.colors.quaternary),
        draftkingsLabel: meta.ids.draftkings_label,
        nflTeamId: meta.ids.nfl_team_id,
        logoEspn: meta.logos.espn,
        logoWordmark: meta.logos.wordmark,
        logoSquared: meta.logos.squared,
        logoWikipedia: meta.logos.wikipedia,
      })
      .where(eq(nflTeams.name, meta.nickname))
      .returning({ id: nflTeams.id });

    if (result.length > 0) {
      updated += 1;
    } else {
      missing.push(meta.nickname);
    }
  }

  console.log(`Updated ${updated} / ${TEAM_META.length} nfl_teams rows (match by nickname).`);
  if (missing.length > 0) {
    console.warn(`No nfl_teams row matched these nicknames: ${missing.join(', ')}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('update-team-meta failed:', err);
    process.exit(1);
  });
