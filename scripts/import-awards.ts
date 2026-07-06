/**
 * Backfill season_awards with amountCents for all seasons that have playoff data.
 * Safe to re-run — deletes and re-inserts all award rows per season.
 *
 * Awards computed:
 *   champion      — championship game winner
 *   runner_up     — championship game loser
 *   weekly_high   — highest scorer per week (excludes byes & forfeits)
 *   season_high   — single highest score across the whole season
 *   most_points   — owner with highest total regular-season PF
 *
 * 3rd/4th place are not tracked in the source sheets and are omitted.
 * Payouts use DEFAULT_SEASON_RULES (same across all seasons).
 *
 * Usage:
 *   npm run import:awards            # write to DB
 *   npm run import:awards -- --dry-run  # preview only
 */
import '@/load-env';

import { and, eq, ilike } from 'drizzle-orm';
import { db, owners, ownerSeasons, playoffMatchups, scores, seasonAwards, seasons } from '@/db';
import { DEFAULT_SEASON_RULES } from '@/lib/rules/schema';

const DRY_RUN = process.argv.includes('--dry-run');
const { payouts } = DEFAULT_SEASON_RULES;

/** 3rd place winners by season year — not in the sheets, entered manually. */
const THIRD_PLACE: Record<number, string> = {
  2023: 'Andy Myers',
  2024: 'Scott Koretsky',
  2025: 'Chris deMartino',
};

function log(...args: unknown[]) { console.log(...args); }

async function main() {
  const osRows = await db.select({ seasonId: ownerSeasons.seasonId }).from(ownerSeasons);
  const seasonIds = [...new Set(osRows.map((r) => r.seasonId))].sort();

  const seasonYears = await db.select({ id: seasons.id, year: seasons.year }).from(seasons);
  const yearBySeasonId = new Map(seasonYears.map((s) => [s.id, s.year]));

  if (seasonIds.length === 0) { log('No seasons with data.'); return; }

  for (const seasonId of seasonIds) {
    log(`\n=== Season ${seasonId} ===`);
    const awardRows: (typeof seasonAwards.$inferInsert)[] = [];

    // ownerSeasonId → ownerId for this season
    const osForSeason = await db
      .select({ id: ownerSeasons.id, ownerId: owners.id })
      .from(ownerSeasons)
      .innerJoin(owners, eq(ownerSeasons.ownerId, owners.id))
      .where(eq(ownerSeasons.seasonId, seasonId));
    const ownerIdByOsId = new Map(osForSeason.map((r) => [r.id, r.ownerId]));

    // --- Champion & runner-up from the championship playoff game ---
    const titleGames = await db
      .select()
      .from(playoffMatchups)
      .where(and(eq(playoffMatchups.seasonId, seasonId), eq(playoffMatchups.round, 'championship')));
    const titleGame = titleGames[0] ?? null;

    if (titleGame?.winnerOwnerSeasonId) {
      const champOsId = titleGame.winnerOwnerSeasonId;
      const ruOsId =
        titleGame.highOwnerSeasonId === champOsId
          ? titleGame.lowOwnerSeasonId
          : titleGame.highOwnerSeasonId;

      const champOwnerId = ownerIdByOsId.get(champOsId);
      const ruOwnerId = ruOsId ? ownerIdByOsId.get(ruOsId) : undefined;

      if (champOwnerId) {
        log(`  Champion:    ownerId=${champOwnerId}  $${payouts.championCents / 100}`);
        awardRows.push({ seasonId, type: 'champion', ownerId: champOwnerId, ownerSeasonId: champOsId, amountCents: payouts.championCents });
      }
      if (ruOwnerId && ruOsId) {
        log(`  Runner-up:   ownerId=${ruOwnerId}  $${payouts.runnerUpCents / 100}`);
        awardRows.push({ seasonId, type: 'runner_up', ownerId: ruOwnerId, ownerSeasonId: ruOsId, amountCents: payouts.runnerUpCents });
      }
    } else {
      log('  No resolved championship game — skipping champion/runner-up');
    }

    // --- 3rd & 4th place ---
    // The two conference-round (semi-final) losers are the 3rd/4th place candidates.
    // THIRD_PLACE tells us which one won 3rd; the other is 4th.
    const year = yearBySeasonId.get(seasonId);
    const thirdName = year ? THIRD_PLACE[year] : undefined;

    const confGames = await db
      .select({ highOwnerSeasonId: playoffMatchups.highOwnerSeasonId, lowOwnerSeasonId: playoffMatchups.lowOwnerSeasonId, winnerOwnerSeasonId: playoffMatchups.winnerOwnerSeasonId })
      .from(playoffMatchups)
      .where(and(eq(playoffMatchups.seasonId, seasonId), eq(playoffMatchups.round, 'conference')));

    const semiLosers: number[] = [];
    for (const g of confGames) {
      if (!g.winnerOwnerSeasonId) continue;
      const loserOsId = g.highOwnerSeasonId === g.winnerOwnerSeasonId ? g.lowOwnerSeasonId : g.highOwnerSeasonId;
      if (loserOsId) semiLosers.push(loserOsId);
    }

    if (semiLosers.length === 2 && thirdName) {
      const thirdOwner = await db.select({ id: owners.id }).from(owners).where(ilike(owners.name, thirdName)).then((r) => r[0] ?? null);
      if (thirdOwner) {
        const thirdOsId = osForSeason.find((r) => r.ownerId === thirdOwner.id)?.id;
        const fourthOsId = semiLosers.find((id) => id !== thirdOsId);
        const fourthOwnerId = fourthOsId ? ownerIdByOsId.get(fourthOsId) : undefined;

        log(`  3rd place:   ownerId=${thirdOwner.id} (${thirdName})  $${payouts.thirdCents / 100}`);
        awardRows.push({ seasonId, type: 'third', ownerId: thirdOwner.id, ownerSeasonId: thirdOsId, amountCents: payouts.thirdCents });

        if (fourthOwnerId && fourthOsId) {
          log(`  4th place:   ownerId=${fourthOwnerId}  $${payouts.fourthCents / 100}`);
          awardRows.push({ seasonId, type: 'fourth', ownerId: fourthOwnerId, ownerSeasonId: fourthOsId, amountCents: payouts.fourthCents });
        }
      } else {
        log(`  WARNING: could not find owner "${thirdName}" for 3rd place`);
      }
    } else if (semiLosers.length !== 2) {
      log(`  WARNING: expected 2 conference-round losers, found ${semiLosers.length} — skipping 3rd/4th`);
    }

    // --- Scores for this season (real games only) ---
    const scoreRows = await db
      .select({ ownerSeasonId: scores.ownerSeasonId, week: scores.week, dkPoints: scores.dkPoints, isBye: scores.isBye })
      .from(scores)
      .where(eq(scores.seasonId, seasonId));

    type Entry = { ownerSeasonId: number; points: number };
    const byWeek = new Map<number, Entry[]>();
    for (const s of scoreRows) {
      if (s.isBye || s.dkPoints === null) continue;
      const pts = Number(s.dkPoints);
      if (pts <= 0) continue; // exclude forfeits
      const list = byWeek.get(s.week) ?? [];
      list.push({ ownerSeasonId: s.ownerSeasonId, points: pts });
      byWeek.set(s.week, list);
    }

    // --- Weekly highs + season high ---
    let seasonHighOsId: number | null = null;
    let seasonHighPts = 0;

    for (const [week, entries] of [...byWeek.entries()].sort(([a], [b]) => a - b).filter(([w]) => w <= payouts.weeklyHighWeeks)) {
      const top = entries.reduce((a, b) => (b.points > a.points ? b : a));
      const ownerId = ownerIdByOsId.get(top.ownerSeasonId);
      if (!ownerId) continue;
      log(`  Wk ${String(week).padStart(2)} high: ownerId=${ownerId}  ${top.points.toFixed(2)} pts  $${payouts.weeklyHighCents / 100}`);
      awardRows.push({ seasonId, type: 'weekly_high', ownerId, ownerSeasonId: top.ownerSeasonId, week, amountCents: payouts.weeklyHighCents, value: String(top.points) });

      if (top.points > seasonHighPts) {
        seasonHighPts = top.points;
        seasonHighOsId = top.ownerSeasonId;
      }
    }

    if (seasonHighOsId !== null) {
      const ownerId = ownerIdByOsId.get(seasonHighOsId);
      if (ownerId) {
        log(`  Season high: ownerId=${ownerId}  ${seasonHighPts.toFixed(2)} pts  $${payouts.seasonHighCents / 100}`);
        awardRows.push({ seasonId, type: 'season_high', ownerId, ownerSeasonId: seasonHighOsId, amountCents: payouts.seasonHighCents, value: String(seasonHighPts) });
      }
    }

    // --- Most regular-season points ---
    const pfByOsId = new Map<number, number>();
    for (const s of scoreRows) {
      if (s.isBye || s.dkPoints === null) continue;
      const pts = Number(s.dkPoints);
      pfByOsId.set(s.ownerSeasonId, (pfByOsId.get(s.ownerSeasonId) ?? 0) + pts);
    }
    let mostPtOsId: number | null = null;
    let mostPtTotal = 0;
    for (const [osId, total] of pfByOsId) {
      if (total > mostPtTotal) { mostPtTotal = total; mostPtOsId = osId; }
    }
    if (mostPtOsId !== null) {
      const ownerId = ownerIdByOsId.get(mostPtOsId);
      if (ownerId) {
        log(`  Most PF:     ownerId=${ownerId}  ${mostPtTotal.toFixed(2)} pts  $${payouts.mostRegularSeasonPointsCents / 100}`);
        awardRows.push({ seasonId, type: 'most_points', ownerId, ownerSeasonId: mostPtOsId, amountCents: payouts.mostRegularSeasonPointsCents, value: String(mostPtTotal) });
      }
    }

    if (DRY_RUN) {
      log(`  [dry-run] Would write ${awardRows.length} awards`);
      continue;
    }

    await db.delete(seasonAwards).where(eq(seasonAwards.seasonId, seasonId));
    if (awardRows.length > 0) {
      await db.insert(seasonAwards).values(awardRows);
    }
    log(`  ✓ Wrote ${awardRows.length} awards`);
  }

  log('\nDone.');
}

main().catch((err) => { console.error(err); process.exit(1); });
