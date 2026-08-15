/**
 * Database half of week detection. Reads `nfl_games`; the rules live in ./current-week, which
 * is pure and tested. Server-only, read-only.
 */
import { eq } from 'drizzle-orm';

import { db, nflGames } from '@/db';

import {
  pickWeek,
  rangeForWeek,
  type DetectedWeek,
  type ScheduleGame,
  type WeekRange,
} from './current-week';

function loadSeasonGames(seasonId: number): Promise<ScheduleGame[]> {
  return db
    .select({
      week: nflGames.week,
      kickoff: nflGames.kickoff,
      isExhibition: nflGames.isExhibition,
    })
    .from(nflGames)
    .where(eq(nflGames.seasonId, seasonId));
}

/** Which week it is now, or null when the season has no synced schedule. */
export async function detectCurrentWeek(
  seasonId: number,
  now: Date = new Date(),
): Promise<DetectedWeek | null> {
  return pickWeek(await loadSeasonGames(seasonId), now);
}

/** The dates one week covers, or null when that week has no games. */
export async function getWeekRange(seasonId: number, week: number): Promise<WeekRange | null> {
  return rangeForWeek(await loadSeasonGames(seasonId), week);
}
