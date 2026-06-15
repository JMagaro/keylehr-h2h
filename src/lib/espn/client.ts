/**
 * ESPN NFL schedule client.
 *
 * Thin, typed wrapper over ESPN's public site scoreboard API. We only fetch the
 * regular-season schedule (home/away team ids, kickoff, status) — scoring comes from
 * a different (DraftKings) pipeline, so we deliberately ignore ESPN scores here.
 *
 * Endpoint (confirmed against real responses):
 *   GET https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard
 *         ?seasontype=2&week=N&dates=YYYY
 *   - seasontype=2  -> regular season
 *   - week=N        -> 1..18
 *   - dates=YYYY    -> the season's calendar year (e.g. 2026)
 *
 * Response shape (the subset we read; see ./types.ts):
 *   events[]                                 one per game
 *     .id                                    -> espnEventId   (string)
 *     .date                                  -> kickoff       (ISO 8601)
 *     .week.number                           -> week          (number)
 *     .competitions[0].competitors[]         two teams
 *        .homeAway ("home" | "away")
 *        .team.id                            -> ESPN team id  (string)
 *     .competitions[0].status.type.name      -> status        (e.g. "STATUS_SCHEDULED")
 *
 * Example (week 1, 2024): event id "401671789", date "2024-09-06T00:40Z",
 *   home team id "12" (KC) vs away team id "33" (BAL), status "STATUS_FINAL".
 *
 * Caching: uses the global `fetch` with `{ next: { revalidate: 3600 } }` so the
 * schedule is re-validated at most hourly (it changes rarely). This also works in
 * plain Node/`tsx` scripts, where the `next` option is simply ignored.
 */
import type {
  EspnCompetition,
  EspnEvent,
  EspnScoreboardResponse,
  NormalizedGame,
} from './types';

/** ESPN regular-season scoreboard endpoint. */
const SCOREBOARD_URL =
  'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';

/** ESPN's `seasontype` code for the regular season. */
const SEASON_TYPE_REGULAR = 2;

/** Default number of NFL regular-season weeks. */
export const DEFAULT_REGULAR_SEASON_WEEKS = 18;

/** Error thrown when ESPN returns a non-OK HTTP status. */
export class EspnFetchError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = 'EspnFetchError';
  }
}

/**
 * Build the scoreboard URL for a given regular-season week.
 * @internal exported for testing.
 */
export function buildScoreboardUrl(year: number, week: number): string {
  const params = new URLSearchParams({
    seasontype: String(SEASON_TYPE_REGULAR),
    week: String(week),
    dates: String(year),
  });
  return `${SCOREBOARD_URL}?${params.toString()}`;
}

/**
 * Parse an ISO date string defensively. Returns null for missing or unparseable
 * values (ESPN may emit placeholder/TBD dates for unscheduled games).
 */
function parseKickoff(raw: string | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Normalize a single ESPN event into our flat {@link NormalizedGame} shape.
 * Returns null when the event is unusable (missing competition, missing a team id,
 * or both competitors share a side) so callers can skip it without crashing.
 */
function normalizeEvent(event: EspnEvent, fallbackWeek: number): NormalizedGame | null {
  if (!event?.id) return null;

  const competition: EspnCompetition | undefined = event.competitions?.[0];
  const competitors = competition?.competitors;
  if (!competitors || competitors.length < 2) return null;

  const home = competitors.find((c) => c.homeAway === 'home');
  const away = competitors.find((c) => c.homeAway === 'away');

  const homeEspnId = home?.team?.id;
  const awayEspnId = away?.team?.id;
  if (!homeEspnId || !awayEspnId) return null;

  const week =
    typeof event.week?.number === 'number' ? event.week.number : fallbackWeek;

  // Prefer the competition's status, fall back to the event-level status.
  const status =
    competition?.status?.type?.name ?? event.status?.type?.name ?? null;

  // Prefer the competition date, fall back to the event date.
  const kickoff = parseKickoff(competition?.date ?? event.date);

  return {
    espnEventId: String(event.id),
    week,
    homeEspnId: String(homeEspnId),
    awayEspnId: String(awayEspnId),
    kickoff,
    status,
  };
}

/**
 * Fetch and normalize every regular-season game for a single week.
 *
 * @param year Season calendar year (e.g. 2026).
 * @param week Regular-season week number (1..18).
 * @returns The week's games, normalized. Empty array if ESPN reports no events.
 * @throws {EspnFetchError} when ESPN responds with a non-OK status.
 */
export async function fetchWeekGames(
  year: number,
  week: number,
): Promise<NormalizedGame[]> {
  const url = buildScoreboardUrl(year, week);

  const response = await fetch(url, {
    // Revalidate hourly under Next's Data Cache; ignored by plain Node fetch.
    next: { revalidate: 3600 },
    headers: { accept: 'application/json' },
  });

  if (!response.ok) {
    throw new EspnFetchError(
      `ESPN scoreboard request failed for ${year} week ${week} (HTTP ${response.status})`,
      response.status,
      url,
    );
  }

  const data = (await response.json()) as EspnScoreboardResponse;
  const events = data.events ?? [];

  const games: NormalizedGame[] = [];
  for (const event of events) {
    const game = normalizeEvent(event, week);
    if (game) games.push(game);
  }
  return games;
}

/**
 * Fetch the full regular-season schedule, week by week.
 *
 * Weeks are fetched sequentially (ESPN is a public, unauthenticated API and we are
 * polite about request rate). A failed week aborts the whole pull so the caller
 * never persists a partial/misleading season; wrap per-week if partial pulls are
 * desired later.
 *
 * @param year  Season calendar year (e.g. 2026).
 * @param weeks Number of regular-season weeks to pull (default 18).
 * @returns A flat array of all normalized games across the requested weeks.
 */
export async function fetchSeasonSchedule(
  year: number,
  weeks: number = DEFAULT_REGULAR_SEASON_WEEKS,
): Promise<NormalizedGame[]> {
  const all: NormalizedGame[] = [];
  for (let week = 1; week <= weeks; week += 1) {
    const games = await fetchWeekGames(year, week);
    all.push(...games);
  }
  return all;
}
