/**
 * ESPN NFL boxscore client — the live stat source for computed DraftKings scoring.
 *
 * WHY ESPN: DraftKings' own scoring API requires an authenticated session for every
 * endpoint (verified — the whole `scores/*` namespace returns `SCO101 Invalid userKey`,
 * even for public contests), and the NFL's official feeds are all auth-gated too. ESPN's
 * public site API is the only free source that carries a complete per-player boxscore and
 * updates during games. See docs/DRAFTKINGS.md.
 *
 * Endpoint (public, keyless):
 *   GET https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event={espnEventId}
 *
 * ------------------------------------------------------------------------------------
 * DO NOT SET A `user-agent` HEADER.
 *
 * ESPN's edge rejects browser-like and empty User-Agents on this API. Verified directly:
 *     -A "Mozilla/5.0"  -> HTTP 403
 *     -H "User-Agent:"  -> HTTP 403
 *     curl default UA   -> HTTP 200
 *     Node/undici fetch -> HTTP 200
 * Sending only `accept` (as src/lib/espn/client.ts already does) is what keeps this
 * working on Vercel. "Helpfully" adding a realistic UA will take the live page down.
 * ------------------------------------------------------------------------------------
 */
import type { EspnSummaryResponse } from './espn-types';

const SUMMARY_URL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary';

/**
 * Revalidation windows by game state. A finished game's boxscore is effectively immutable
 * (ESPN issues stat corrections days later, but DK is authoritative for the final number
 * anyway), so it is cached hard; an in-progress game is the only thing worth re-fetching.
 */
export const BOXSCORE_TTL_SECONDS = {
  /** Not kicked off — nothing to read, check back occasionally. */
  pre: 300,
  /** In progress — this is the live case. */
  in: 45,
  /** Final. */
  post: 86_400,
} as const;

export type GameState = keyof typeof BOXSCORE_TTL_SECONDS;

/** Error thrown when ESPN returns a non-OK HTTP status. */
export class EspnBoxscoreError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly espnEventId: string,
  ) {
    super(message);
    this.name = 'EspnBoxscoreError';
  }
}

/** Build the summary URL for an ESPN event id. */
export function buildSummaryUrl(espnEventId: string): string {
  return `${SUMMARY_URL}?event=${encodeURIComponent(espnEventId)}`;
}

/**
 * Fetch one game's full summary payload.
 *
 * @param espnEventId `nfl_games.espnEventId`.
 * @param ttlSeconds  Data Cache revalidation window; pick from {@link BOXSCORE_TTL_SECONDS}
 *                    using the game's state so finished games aren't re-fetched all week.
 * @throws {EspnBoxscoreError} on a non-OK response.
 */
export async function fetchGameSummary(
  espnEventId: string,
  ttlSeconds: number = BOXSCORE_TTL_SECONDS.in,
): Promise<EspnSummaryResponse> {
  const url = buildSummaryUrl(espnEventId);

  const response = await fetch(url, {
    next: { revalidate: ttlSeconds },
    // `accept` ONLY — see the User-Agent warning in this file's header.
    headers: { accept: 'application/json' },
  });

  if (!response.ok) {
    throw new EspnBoxscoreError(
      `ESPN summary request failed for event ${espnEventId} (HTTP ${response.status})`,
      response.status,
      espnEventId,
    );
  }

  return (await response.json()) as EspnSummaryResponse;
}
