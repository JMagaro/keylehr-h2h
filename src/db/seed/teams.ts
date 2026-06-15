/**
 * NFL team seed data — KeyLehr H2H Fantasy Football League.
 *
 * The 32 NFL teams as static reference data for the `nfl_teams` table.
 *
 * Source of truth
 * ---------------
 * `key`, `location`, `name`, and `espnId` were taken verbatim from the live ESPN
 * teams endpoint so the abbreviations match the ESPN schedule API exactly (the
 * value used to join the imported NFL schedule back to our teams):
 *
 *   https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams
 *
 * `conference` and `division` are hardcoded — they are stable alignment data that
 * the teams endpoint does not return directly.
 *
 * ESPN abbreviation gotchas (verified against the live endpoint):
 *   - Washington Commanders -> "WSH"  (NOT "WAS")
 *   - Jacksonville Jaguars  -> "JAX"
 *   - Las Vegas Raiders     -> "LV"
 *   - Los Angeles Rams      -> "LAR"
 *   - Los Angeles Chargers  -> "LAC"
 */
import type { NewNflTeam } from '@/db/schema';

/**
 * One seed row per NFL team. Typed as `NewNflTeam` so it stays in lock-step with
 * the schema; the database-generated `id` is intentionally omitted.
 */
export type NflTeamSeed = Omit<NewNflTeam, 'id'>;

/**
 * The 32 NFL teams, ordered by division (AFC then NFC, East/North/South/West).
 *
 * `espnId` is the ESPN team id as a string to match the `varchar` column and the
 * string ids the ESPN schedule API returns.
 */
export const NFL_TEAMS: readonly NflTeamSeed[] = [
  /* ---------------------------- AFC East ---------------------------------- */
  { key: 'BUF', location: 'Buffalo', name: 'Bills', conference: 'AFC', division: 'East', espnId: '2' },
  { key: 'MIA', location: 'Miami', name: 'Dolphins', conference: 'AFC', division: 'East', espnId: '15' },
  { key: 'NE', location: 'New England', name: 'Patriots', conference: 'AFC', division: 'East', espnId: '17' },
  { key: 'NYJ', location: 'New York', name: 'Jets', conference: 'AFC', division: 'East', espnId: '20' },

  /* ---------------------------- AFC North --------------------------------- */
  { key: 'BAL', location: 'Baltimore', name: 'Ravens', conference: 'AFC', division: 'North', espnId: '33' },
  { key: 'CIN', location: 'Cincinnati', name: 'Bengals', conference: 'AFC', division: 'North', espnId: '4' },
  { key: 'CLE', location: 'Cleveland', name: 'Browns', conference: 'AFC', division: 'North', espnId: '5' },
  { key: 'PIT', location: 'Pittsburgh', name: 'Steelers', conference: 'AFC', division: 'North', espnId: '23' },

  /* ---------------------------- AFC South --------------------------------- */
  { key: 'HOU', location: 'Houston', name: 'Texans', conference: 'AFC', division: 'South', espnId: '34' },
  { key: 'IND', location: 'Indianapolis', name: 'Colts', conference: 'AFC', division: 'South', espnId: '11' },
  { key: 'JAX', location: 'Jacksonville', name: 'Jaguars', conference: 'AFC', division: 'South', espnId: '30' },
  { key: 'TEN', location: 'Tennessee', name: 'Titans', conference: 'AFC', division: 'South', espnId: '10' },

  /* ---------------------------- AFC West ---------------------------------- */
  { key: 'DEN', location: 'Denver', name: 'Broncos', conference: 'AFC', division: 'West', espnId: '7' },
  { key: 'KC', location: 'Kansas City', name: 'Chiefs', conference: 'AFC', division: 'West', espnId: '12' },
  { key: 'LV', location: 'Las Vegas', name: 'Raiders', conference: 'AFC', division: 'West', espnId: '13' },
  { key: 'LAC', location: 'Los Angeles', name: 'Chargers', conference: 'AFC', division: 'West', espnId: '24' },

  /* ---------------------------- NFC East ---------------------------------- */
  { key: 'DAL', location: 'Dallas', name: 'Cowboys', conference: 'NFC', division: 'East', espnId: '6' },
  { key: 'NYG', location: 'New York', name: 'Giants', conference: 'NFC', division: 'East', espnId: '19' },
  { key: 'PHI', location: 'Philadelphia', name: 'Eagles', conference: 'NFC', division: 'East', espnId: '21' },
  { key: 'WSH', location: 'Washington', name: 'Commanders', conference: 'NFC', division: 'East', espnId: '28' },

  /* ---------------------------- NFC North --------------------------------- */
  { key: 'CHI', location: 'Chicago', name: 'Bears', conference: 'NFC', division: 'North', espnId: '3' },
  { key: 'DET', location: 'Detroit', name: 'Lions', conference: 'NFC', division: 'North', espnId: '8' },
  { key: 'GB', location: 'Green Bay', name: 'Packers', conference: 'NFC', division: 'North', espnId: '9' },
  { key: 'MIN', location: 'Minnesota', name: 'Vikings', conference: 'NFC', division: 'North', espnId: '16' },

  /* ---------------------------- NFC South --------------------------------- */
  { key: 'ATL', location: 'Atlanta', name: 'Falcons', conference: 'NFC', division: 'South', espnId: '1' },
  { key: 'CAR', location: 'Carolina', name: 'Panthers', conference: 'NFC', division: 'South', espnId: '29' },
  { key: 'NO', location: 'New Orleans', name: 'Saints', conference: 'NFC', division: 'South', espnId: '18' },
  { key: 'TB', location: 'Tampa Bay', name: 'Buccaneers', conference: 'NFC', division: 'South', espnId: '27' },

  /* ---------------------------- NFC West ---------------------------------- */
  { key: 'ARI', location: 'Arizona', name: 'Cardinals', conference: 'NFC', division: 'West', espnId: '22' },
  { key: 'LAR', location: 'Los Angeles', name: 'Rams', conference: 'NFC', division: 'West', espnId: '14' },
  { key: 'SF', location: 'San Francisco', name: '49ers', conference: 'NFC', division: 'West', espnId: '25' },
  { key: 'SEA', location: 'Seattle', name: 'Seahawks', conference: 'NFC', division: 'West', espnId: '26' },
] as const;
