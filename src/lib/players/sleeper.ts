/**
 * Sleeper API client — free, keyless source of NFL player metadata + waiver trends.
 *
 * This is the first external *player-level* data source in the app (everything else
 * tracks only weekly team-owner DraftKings totals). It powers the My Team "spotlight /
 * fade risks" strip and the lineup-builder wizard.
 *
 * Endpoints used (all public, no auth — https://docs.sleeper.com):
 *   GET /v1/players/nfl                          full player dictionary (~5 MB, ~11k players)
 *   GET /v1/players/nfl/trending/add?...         most-added players (waiver buzz)
 *   GET /v1/players/nfl/trending/drop?...        most-dropped players
 *
 * Honest-signal note: Sleeper is strong on availability (injury status), identity, depth
 * order, a consensus search rank, and add/drop momentum — but it does NOT provide weekly
 * point projections or DraftKings salaries. The recommender treats these as news/availability
 * signals, not projections (see ./recommend.ts), and the UI says so.
 *
 * Caching: the big player dictionary is fetched at most once per TTL via a module-level
 * memo (Sleeper asks callers to pull it no more than once a day; it also exceeds Next's
 * 2 MB fetch-cache entry limit, so we can't rely on the Data Cache for it). The small
 * trending lists go through the normal Next Data Cache with hourly revalidation.
 */

const SLEEPER_BASE = 'https://api.sleeper.app/v1';

/** Positions we care about for DFS. Sleeper's "DEF" is surfaced as "DST". */
export type FantasyPosition = 'QB' | 'RB' | 'WR' | 'TE' | 'K' | 'DST';

const FANTASY_POSITIONS = new Set<FantasyPosition>(['QB', 'RB', 'WR', 'TE', 'K', 'DST']);

/** A normalized, fantasy-relevant player. */
export interface SleeperPlayer {
  id: string;
  name: string;
  position: FantasyPosition;
  /** Normalized to our nfl_teams.key (e.g. Sleeper "WAS" → "WSH"). */
  teamKey: string;
  /** null when healthy; otherwise "Questionable" | "Doubtful" | "Out" | "IR" | "PUP" | "Sus" | … */
  injuryStatus: string | null;
  injuryNote: string | null;
  /** Depth-chart slot (1 = starter) when Sleeper provides it. */
  depthOrder: number | null;
  /** Sleeper's overall relevance rank (lower = more fantasy-relevant). */
  searchRank: number;
  yearsExp: number | null;
  age: number | null;
}

/** Raw Sleeper player shape (loose — it's an external, untyped dictionary). */
interface RawSleeperPlayer {
  player_id?: string;
  first_name?: string;
  last_name?: string;
  full_name?: string;
  position?: string;
  team?: string | null;
  status?: string | null;
  active?: boolean;
  injury_status?: string | null;
  injury_notes?: string | null;
  depth_chart_order?: number | null;
  search_rank?: number | null;
  years_exp?: number | null;
  age?: number | null;
}

/**
 * Sleeper team abbreviations that differ from our nfl_teams.key. Sleeper uses "WAS"
 * for Washington where we use "WSH"; the rest match. The historical relocations are
 * mapped defensively in case an old player row still carries them.
 */
const TEAM_KEY_FIX: Record<string, string> = {
  WAS: 'WSH',
  JAC: 'JAX',
  LA: 'LAR',
  OAK: 'LV',
  SD: 'LAC',
  STL: 'LAR',
};

function normalizeTeamKey(team: string): string {
  const u = team.trim().toUpperCase();
  return TEAM_KEY_FIX[u] ?? u;
}

function normalizePosition(pos: string | undefined): FantasyPosition | null {
  if (!pos) return null;
  const p = pos.toUpperCase();
  if (p === 'DEF') return 'DST';
  return FANTASY_POSITIONS.has(p as FantasyPosition) ? (p as FantasyPosition) : null;
}

/** Keep only players relevant enough to surface; drops deep/irrelevant search ranks. */
const RELEVANCE_MAX_RANK = 900;

function normalizePlayer(id: string, raw: RawSleeperPlayer): SleeperPlayer | null {
  const position = normalizePosition(raw.position);
  if (!position) return null;
  if (raw.active === false) return null;

  const team = raw.team ? normalizeTeamKey(raw.team) : null;
  if (!team) return null; // free agents have no NFL team to play this week

  const searchRank =
    typeof raw.search_rank === 'number' && Number.isFinite(raw.search_rank)
      ? raw.search_rank
      : Number.POSITIVE_INFINITY;
  // Defenses carry weak/blank search ranks but there are only 32 — always keep them.
  if (position !== 'DST' && searchRank > RELEVANCE_MAX_RANK) return null;

  const name =
    (raw.full_name && raw.full_name.trim()) ||
    [raw.first_name, raw.last_name].filter(Boolean).join(' ').trim() ||
    (position === 'DST' ? `${team} DST` : id);

  return {
    id,
    name,
    position,
    teamKey: team,
    injuryStatus: raw.injury_status ? raw.injury_status.trim() : null,
    injuryNote: raw.injury_notes ? raw.injury_notes.trim() : null,
    depthOrder:
      typeof raw.depth_chart_order === 'number' ? raw.depth_chart_order : null,
    searchRank,
    yearsExp: typeof raw.years_exp === 'number' ? raw.years_exp : null,
    age: typeof raw.age === 'number' ? raw.age : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Player dictionary (module-memoized)                                        */
/* -------------------------------------------------------------------------- */

/** 12 hours — Sleeper asks for ≤ 1 pull/day; this stays well under that per instance. */
const PLAYERS_TTL_MS = 12 * 60 * 60 * 1000;

interface PlayersCache {
  at: number;
  players: SleeperPlayer[];
}

let playersCache: PlayersCache | null = null;
let playersInFlight: Promise<SleeperPlayer[]> | null = null;

async function fetchAllPlayers(): Promise<SleeperPlayer[]> {
  const res = await fetch(`${SLEEPER_BASE}/players/nfl`, {
    headers: { accept: 'application/json' },
    // Too large for Next's Data Cache (>2 MB); the module memo below is the real cache.
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Sleeper players request failed (HTTP ${res.status})`);
  const dict = (await res.json()) as Record<string, RawSleeperPlayer>;

  const out: SleeperPlayer[] = [];
  for (const [id, raw] of Object.entries(dict)) {
    const p = normalizePlayer(id, raw);
    if (p) out.push(p);
  }
  return out;
}

/**
 * The fantasy-relevant Sleeper player list, memoized in-process for {@link PLAYERS_TTL_MS}.
 * Concurrent callers share a single in-flight request (no stampede). Never throws — on a
 * Sleeper outage it returns the last good snapshot if any, else an empty list, so the page
 * degrades to "signals unavailable" instead of crashing.
 */
export async function getSleeperPlayers(): Promise<SleeperPlayer[]> {
  const fresh = playersCache && Date.now() - playersCache.at < PLAYERS_TTL_MS;
  if (fresh) return playersCache!.players;
  if (playersInFlight) return playersInFlight;

  playersInFlight = fetchAllPlayers()
    .then((players) => {
      playersCache = { at: Date.now(), players };
      return players;
    })
    .catch((err) => {
      console.error('[sleeper] player dictionary fetch failed:', err);
      return playersCache?.players ?? [];
    })
    .finally(() => {
      playersInFlight = null;
    });

  return playersInFlight;
}

/* -------------------------------------------------------------------------- */
/* Trending (add / drop)                                                      */
/* -------------------------------------------------------------------------- */

interface RawTrending {
  player_id?: string;
  count?: number;
}

/* -------------------------------------------------------------------------- */
/* Actual weekly results (for model grading)                                  */
/* -------------------------------------------------------------------------- */

interface RawWeekStats {
  pts_ppr?: number;
  pts_half_ppr?: number;
  pts_std?: number;
}

/**
 * Actual fantasy points per Sleeper player id for a completed week, as a PPR total (the
 * closest free proxy to DraftKings Classic scoring). Used to grade the lineup models after
 * the games. Cached for 6 hours via the Next Data Cache. Returns an empty map on any error
 * or for a week with no results yet.
 *
 * @param seasonYear e.g. 2026 (the NFL calendar year, not the DB season id).
 */
export async function getWeekActuals(
  seasonYear: number,
  week: number,
): Promise<Map<string, number>> {
  const url = `${SLEEPER_BASE}/stats/nfl/regular/${seasonYear}/${week}`;
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      next: { revalidate: 21600 },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const dict = (await res.json()) as Record<string, RawWeekStats | null>;
    const out = new Map<string, number>();
    for (const [id, stats] of Object.entries(dict)) {
      if (!stats) continue;
      const pts =
        typeof stats.pts_ppr === 'number'
          ? stats.pts_ppr
          : typeof stats.pts_half_ppr === 'number'
            ? stats.pts_half_ppr
            : typeof stats.pts_std === 'number'
              ? stats.pts_std
              : null;
      if (pts != null) out.set(id, pts);
    }
    return out;
  } catch (err) {
    console.error(`[sleeper] week actuals ${seasonYear}/${week} fetch failed:`, err);
    return new Map();
  }
}

/**
 * Most-added (`add`) or most-dropped (`drop`) players over the lookback window, as a
 * map of Sleeper player id → roster-move count. Cached hourly via the Next Data Cache.
 * Returns an empty map on any error.
 */
export async function getSleeperTrending(
  kind: 'add' | 'drop',
  { lookbackHours = 48, limit = 75 }: { lookbackHours?: number; limit?: number } = {},
): Promise<Map<string, number>> {
  const url = `${SLEEPER_BASE}/players/nfl/trending/${kind}?lookback_hours=${lookbackHours}&limit=${limit}`;
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      next: { revalidate: 3600 },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = (await res.json()) as RawTrending[];
    const map = new Map<string, number>();
    for (const r of rows) {
      if (r.player_id) map.set(r.player_id, typeof r.count === 'number' ? r.count : 0);
    }
    return map;
  } catch (err) {
    console.error(`[sleeper] trending/${kind} fetch failed:`, err);
    return new Map();
  }
}
