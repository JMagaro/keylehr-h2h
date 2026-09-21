/**
 * "Is this game / week finished?" — one definition, shared.
 *
 * This logic previously lived module-private inside `src/lib/scores/status.ts`, where it
 * decided whether the admin sync dashboard called a week complete. The scoring engine now
 * needs the same answer for a load-bearing reason: a missed lineup can only be *derived*
 * from a 0-point (or absent) score once the week's games have actually been played. Mid-
 * Sunday every owner legitimately has 0 points, and treating that as 32 forfeits would
 * cascade auto-losses across the whole league.
 *
 * Two definitions of "final" would be a latent bug, so `status.ts` imports these too.
 *
 * Pure / no DB, no clock of its own — `now` is always passed in so tests are deterministic.
 */

/** A safe margin after kickoff before we assume a game with no status is over. */
export const FINAL_FALLBACK_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * A PRE-GAME status, which is evidence of nothing once kickoff has passed.
 *
 * `nfl_games.status` has exactly one writer — `syncSeasonSchedule` — and it is only
 * reachable by hand (Admin → Schedule, `npm run schedule:pull`), documented as *pre-season*
 * setup. So a season pulled in August still reads `STATUS_SCHEDULED` in December: it is the
 * DEFAULT every row carries before anything is refreshed, not a claim that the game has yet
 * to be played. Read as "explicitly not finished" it froze `weekIsFinal` at false for the
 * whole 2026 season, which silently disabled missed-lineup derivation — the gate is only
 * load-bearing when it can actually open.
 *
 * Every other unfinished status (`STATUS_IN_PROGRESS`, `halftime`, `STATUS_POSTPONED`) can
 * only have been WRITTEN by a refresh, so it is fresh evidence and still wins outright.
 */
const PRE_GAME = /scheduled|pre[-_ ]?game/i;

/**
 * Interpret an ESPN status string.
 *
 * @returns `true` finished · `false` explicitly not finished · `null` unknown/missing/stale,
 *          meaning the caller should fall back to how long ago kickoff was.
 */
export function statusIsFinal(status: string | null): boolean | null {
  if (!status) return null;
  if (/final|complete|full[-_ ]?time|postgame/i.test(status)) return true;
  // Not "not finished" — just nothing written since the schedule pull. Defer to the clock.
  if (PRE_GAME.test(status)) return null;
  return false;
}

/** The timing facts about one NFL game that decide whether it is over. */
export interface GameTiming {
  status: string | null;
  kickoff: Date | null;
}

/**
 * Whether a single game is finished. An explicit status always wins; a missing,
 * unrecognized, or merely PRE-GAME status falls back to "kicked off long enough ago"
 * (see {@link PRE_GAME} for why a stale `STATUS_SCHEDULED` must not veto the clock).
 */
export function gameIsFinal(game: GameTiming, now: Date): boolean {
  const explicit = statusIsFinal(game.status);
  if (explicit !== null) return explicit;
  return (
    game.kickoff !== null && now.getTime() - game.kickoff.getTime() >= FINAL_FALLBACK_MS
  );
}

/**
 * Whether an entire week is finished: at least one game, and every one of them final.
 *
 * A week with **no** games is NOT final — "nothing scheduled" must never read as
 * "everything is over", or an unsynced week would look settled and start deriving
 * forfeits for owners who never had a game to miss.
 */
export function weekIsFinal(games: readonly GameTiming[], now: Date): boolean {
  if (games.length === 0) return false;
  return games.every((g) => gameIsFinal(g, now));
}
