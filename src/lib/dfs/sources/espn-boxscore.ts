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

/**
 * How long to wait on one ESPN request before giving up on it.
 *
 * There was no timeout at all, which is worse than a slow page: the live routes budget 30s
 * (`maxDuration`), a full slate is 16 summaries at concurrency 6, and one socket that never
 * answers held a whole wave until the platform killed the render.
 */
const FETCH_TIMEOUT_MS = 6_000;

/** Attempts per game, including the first. */
const MAX_ATTEMPTS = 3;

/** Backoff before attempt 2 and 3. Deliberately short — see {@link fetchGameSummary}. */
const RETRY_BACKOFF_MS = [150, 400];

/**
 * Is this failure worth trying again?
 *
 * A 404 means the event id is wrong and will be wrong next time; retrying it just burns the
 * render budget. Rate limiting and server errors are exactly what a retry is for.
 */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
 * Fetch one game's full summary payload, retrying a transient failure.
 *
 * WHY THE RETRY EXISTS, AND WHY IT IS HERE RATHER THAN IN THE UI. A failed summary does not
 * degrade gracefully into "one stat is missing" — `buildLiveStatIndex` skips the whole game,
 * so every player in it loses their `teamState` and renders as `?` (unresolved). Nine rosters
 * can light up from a single dropped request.
 *
 * It is then STICKY, which is the part that makes it a user-visible defect rather than a
 * blip: the assembled index is memoised for `LIVE_INDEX_REVALIDATE_SECONDS` (30s), so the
 * partial result is served to everyone for the rest of that window. The reported symptom was
 * exactly that — question marks on random players, and reloading until they come back. The
 * reload WAS the retry; doing it here means nobody has to.
 *
 * Backoff is short on purpose. These routes budget 30s total for a 16-game slate, so a
 * patient retry would trade one broken render for a timed-out one.
 *
 * THE `signal` IS LOAD-BEARING, AND NOT ONLY FOR THE TIMEOUT. Without it the retry is a
 * NO-OP inside a render, which is the opposite of obvious and is why this is written down:
 *
 *   - `node_modules/next/dist/server/lib/dedupe-fetch.js` memoises every fetch by
 *     (url, method, headers, mode, redirect, credentials, referrer, referrerPolicy,
 *     integrity) for the whole render pass, and it pushes the entry BEFORE the promise
 *     settles. A rejected fetch stays in that map, so an identical second call re-awaits the
 *     SAME rejected promise and never touches the network. A non-OK response is worse: it
 *     resolved, so the retry gets a clone of the very same 503.
 *   - Note `cache` and `next` are deliberately excluded from that key, so `cache: 'no-store'`
 *     on the retry would NOT bust it. Only a signal (or a differing header) does.
 *   - That same file opts out of deduping entirely when a signal is present — the documented
 *     escape hatch, and exactly what a retry needs.
 *
 * And it costs nothing here. Dedupe only helps when the same URL is fetched twice in one
 * render; `buildLiveStatIndex` fetches each event exactly once, so there is nothing to dedupe.
 * The DATA CACHE is untouched by the signal — `patch-fetch.js` passes `next.revalidate`
 * through and only drops the signal when refreshing a stale entry in the background — so a
 * finished game is still cached for a day.
 *
 * @param espnEventId `nfl_games.espnEventId`.
 * @param ttlSeconds  Data Cache revalidation window; pick from {@link BOXSCORE_TTL_SECONDS}
 *                    using the game's state so finished games aren't re-fetched all week.
 * @throws {EspnBoxscoreError} when every attempt fails.
 */
export async function fetchGameSummary(
  espnEventId: string,
  ttlSeconds: number = BOXSCORE_TTL_SECONDS.in,
): Promise<EspnSummaryResponse> {
  const url = buildSummaryUrl(espnEventId);
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(RETRY_BACKOFF_MS[attempt - 1] ?? 400);

    try {
      const response = await fetch(url, {
        next: { revalidate: ttlSeconds },
        // `accept` ONLY — see the User-Agent warning in this file's header.
        headers: { accept: 'application/json' },
        // Aborts a hung request AND bypasses the render-pass dedupe — see above. Both are
        // required; dropping this silently turns every retry into a replay of the failure.
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (response.ok) return (await response.json()) as EspnSummaryResponse;

      lastError = new EspnBoxscoreError(
        `ESPN summary request failed for event ${espnEventId} (HTTP ${response.status})`,
        response.status,
        espnEventId,
      );
      // A permanent status will fail identically on the next attempt.
      if (!isRetryableStatus(response.status)) break;
    } catch (err) {
      // Network error or timeout. Both are worth another go.
      lastError = err;
    }
  }

  if (lastError instanceof EspnBoxscoreError) throw lastError;
  throw new EspnBoxscoreError(
    `ESPN summary request failed for event ${espnEventId} after ${MAX_ATTEMPTS} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
    0,
    espnEventId,
  );
}
