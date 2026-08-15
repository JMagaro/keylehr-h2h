/**
 * The live stat index: every rostered-relevant player's stat line for a week, from ESPN.
 *
 * This is the half of live scoring that needs NO authentication, which is the whole point of
 * the design — DraftKings' scoring API requires the commissioner's session, so if the running
 * total came from DK, a machine would have to stay logged in all week. It doesn't.
 *
 * WHAT IS CACHED, AND WHY IT MATTERS
 * `unstable_cache` wraps the whole fan-out, so one warm entry serves every viewer: 32 owners
 * refreshing does not become 32× the upstream traffic. Vercel's Data Cache is shared across
 * instances, so this holds in production, not just locally.
 *
 * `cacheComponents` is not enabled in next.config.ts, so `use cache` is unavailable and
 * `unstable_cache` is the correct tool here.
 *
 * STAT LINES, NOT POINTS. The index stores DK-shaped stat lines and lets `assemble.ts` score
 * them. Two reasons: the cached payload stays small, and a scoring-rule fix takes effect
 * immediately instead of waiting out a cache TTL.
 *
 * NOTHING HERE WRITES. See docs/SCORING.md §15 and src/lib/lineups/no-write.test.ts.
 */
import { unstable_cache } from 'next/cache';

import { normalizeName } from '@/lib/draftkings/match';
import { BOXSCORE_TTL_SECONDS, fetchGameSummary, type GameState } from '@/lib/dfs/sources/espn-boxscore';
import { extractGame } from '@/lib/dfs/sources/espn-extract';
import type { DstStatLine, PlayerStatLine } from '@/lib/dfs/stat-line';

/** How long an assembled index stays warm. Short — the point is that it moves during games. */
export const LIVE_INDEX_REVALIDATE_SECONDS = 30;

/**
 * How many ESPN summaries to have in flight at once.
 *
 * A full slate is ~16 games. Six at a time keeps a cold render comfortably inside the route's
 * 30s budget without hammering a free public API.
 */
const FETCH_CONCURRENCY = 6;

export interface LiveGameSummary {
  espnEventId: string;
  state: GameState;
  /** ESPN's human status, e.g. "Final" or "8:30 - 3rd Quarter". */
  detail: string | null;
  teamKeys: string[];
}

export interface LivePlayerStat {
  name: string;
  teamKey: string;
  line: PlayerStatLine;
}

export interface LiveDstStat {
  teamKey: string;
  line: DstStatLine;
}

export interface LiveStatIndex {
  /** Keyed `${normalizeName(name)}|${teamKey}` — see `playerStatKey`. */
  players: Record<string, LivePlayerStat>;
  /** Keyed by `nfl_teams.key`. */
  defenses: Record<string, LiveDstStat>;
  /** Per-team game state, so a roster slot can say "yet to play" without a second lookup. */
  teamState: Record<string, { state: GameState; detail: string | null }>;
  games: LiveGameSummary[];
  /** Games whose boxscore actually loaded, and how many were asked for. */
  gamesLoaded: number;
  gamesTotal: number;
  /** Epoch ms of the fetch, for the "updated Ns ago" ticker. */
  fetchedAt: number;
}

/**
 * The cross-source identity key.
 *
 * DraftKings' draftables carry no ESPN id, so players are matched on (normalized name, team).
 * That pairing was validated at 100% against 172 DK draftables on a live slate, and the
 * team component is load-bearing: name alone collides on real players (Bijan vs Brian
 * Robinson, Travis vs Trevor Etienne, Josh vs Jonathan Allen), which produced 18 phantom
 * mismatches in the scoring self-test before the team was added to the key.
 */
export function playerStatKey(name: string, teamKey: string): string {
  return `${normalizeName(name)}|${teamKey.trim().toUpperCase()}`;
}

/** Run `worker` over `items` with a bounded number in flight. Never rejects. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;

  async function run(): Promise<void> {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      try {
        results[i] = { status: 'fulfilled', value: await worker(items[i]) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

export interface LiveGameRef {
  espnEventId: string;
  /** Last known state, used only to pick a TTL before the fetch tells us the truth. */
  state?: GameState;
}

/**
 * Build the index for a set of games. Exported unwrapped so it can be exercised directly
 * (scripts, tests) without going through the cache.
 */
export async function buildLiveStatIndex(games: LiveGameRef[]): Promise<LiveStatIndex> {
  const index: LiveStatIndex = {
    players: {},
    defenses: {},
    teamState: {},
    games: [],
    gamesLoaded: 0,
    gamesTotal: games.length,
    fetchedAt: Date.now(),
  };

  const settled = await mapWithConcurrency(games, FETCH_CONCURRENCY, async (g) => {
    // A finished game is cached hard and a pre-game game barely at all; only in-progress
    // games are worth re-fetching every render.
    const ttl = BOXSCORE_TTL_SECONDS[g.state ?? 'in'];
    return extractGame(await fetchGameSummary(g.espnEventId, ttl));
  });

  for (const result of settled) {
    // One failed game degrades to "15 of 16 loaded" — never a thrown page. The count is
    // surfaced in the UI so a partial slate is visible rather than silently understated.
    if (result.status !== 'fulfilled') continue;
    const game = result.value;
    index.gamesLoaded += 1;

    index.games.push({
      espnEventId: game.espnEventId ?? '',
      state: game.state,
      detail: game.statusDetail,
      teamKeys: game.teamKeys,
    });
    for (const teamKey of game.teamKeys) {
      index.teamState[teamKey] = { state: game.state, detail: game.statusDetail };
    }
    for (const p of game.players) {
      index.players[playerStatKey(p.name, p.teamKey)] = {
        name: p.name,
        teamKey: p.teamKey,
        line: p.line,
      };
    }
    for (const d of game.defenses) {
      index.defenses[d.teamKey] = { teamKey: d.teamKey, line: d.line };
    }
  }

  return index;
}

/**
 * Cached entry point.
 *
 * The cache key includes the season/week AND the event ids, so adding a game to the week
 * (or a schedule correction) produces a new entry rather than serving a stale slate.
 */
export function getLiveStatsForWeek(
  seasonId: number,
  week: number,
  games: LiveGameRef[],
): Promise<LiveStatIndex> {
  const ids = games.map((g) => g.espnEventId).sort();
  return unstable_cache(
    () => buildLiveStatIndex(games),
    ['live-stats', String(seasonId), String(week), ids.join(',')],
    { revalidate: LIVE_INDEX_REVALIDATE_SECONDS, tags: [liveTag(seasonId, week)] },
  )();
}

/** Cache tag for a week's live data, so a fresh capture or an admin button can bust it. */
export function liveTag(seasonId: number, week: number): string {
  return `live:${seasonId}:${week}`;
}
