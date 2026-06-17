/**
 * DraftKings draftables client — free, keyless, server-side. Given a draft-group id
 * (a "slate"), returns each player's salary + position + team for that slate. This is
 * the salary source for the lineup builder's cap-aware optimization.
 *
 * Endpoint (public, no auth — unlike the leaderboard pull which needs the user's session):
 *   GET https://api.draftkings.com/draftgroups/v1/draftgroups/{draftGroupId}/draftables?format=json
 * Response: { draftables: [{ playerId, displayName, firstName, lastName, position,
 *            teamAbbreviation, salary, status, ... }] }
 *
 * Players appear multiple times (one row per roster-slot eligibility) with the SAME
 * salary, so we dedupe by playerId. Returns [] on any error so the builder degrades to
 * its signal-only mode.
 */

/** Standard DraftKings NFL Classic salary cap. (Draftables don't carry the cap.) */
export const DK_CLASSIC_SALARY_CAP = 50000;

export interface DkDraftable {
  dkPlayerId: string;
  name: string;
  firstName: string | null;
  lastName: string | null;
  /** Normalized to our nfl_teams.key (e.g. DK "WAS" → "WSH"). */
  teamKey: string;
  /** QB | RB | WR | TE | DST | K | … (DK's player position). */
  position: string;
  salary: number;
  /** DK status string when present (e.g. "O", "Q", "IR") — informational only. */
  status: string | null;
}

interface RawDraftable {
  playerId?: number | string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
  position?: string;
  teamAbbreviation?: string;
  salary?: number;
  status?: string | null;
  draftableId?: number | string;
}

/** DK team abbreviations that differ from our nfl_teams.key. */
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

function draftablesUrl(draftGroupId: string): string {
  return `https://api.draftkings.com/draftgroups/v1/draftgroups/${encodeURIComponent(
    draftGroupId,
  )}/draftables?format=json`;
}

/* -------------------------------------------------------------------------- */
/* Auto-detect the week's main slate                                          */
/* -------------------------------------------------------------------------- */

interface RawDraftGroup {
  DraftGroupId?: number;
  GameCount?: number;
  ContestStartTimeSuffix?: string | null;
  GameType?: string | null;
  StartDateEst?: string;
}

/**
 * Auto-detect DraftKings' MAIN NFL Classic slate (the full multi-game slate, the one most
 * people play), so the builder works without anyone pasting an id. Heuristic: among the
 * NFL draft groups in DK's public lobby, take Classic multi-game slates (GameCount ≥ 2,
 * excluding single-game Showdowns) and pick the one with the most games; tie-break to the
 * soonest start. This naturally lands on the current week's main slate in-season.
 *
 * Returns null in the offseason gap or on any error. Cached for 30 minutes.
 */
export async function getMainNflDraftGroupId(): Promise<string | null> {
  try {
    const res = await fetch('https://www.draftkings.com/lobby/getcontests?sport=NFL', {
      headers: { accept: 'application/json' },
      next: { revalidate: 1800 },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { DraftGroups?: RawDraftGroup[] };
    const groups = data.DraftGroups ?? [];

    const candidates = groups.filter((g) => {
      const games = typeof g.GameCount === 'number' ? g.GameCount : 0;
      const suffix = (g.ContestStartTimeSuffix ?? '').toLowerCase();
      const type = (g.GameType ?? '').toLowerCase();
      const isShowdown =
        suffix.includes('showdown') || suffix.includes('captain') || type.includes('showdown');
      return g.DraftGroupId != null && games >= 2 && !isShowdown;
    });
    if (candidates.length === 0) return null;

    candidates.sort(
      (a, b) =>
        (b.GameCount ?? 0) - (a.GameCount ?? 0) ||
        (a.StartDateEst ?? '').localeCompare(b.StartDateEst ?? ''),
    );
    return String(candidates[0].DraftGroupId);
  } catch (err) {
    console.error('[draftkings] main slate auto-detect failed:', err);
    return null;
  }
}

export interface DraftablesResult {
  players: DkDraftable[];
  /** Distinct draftable rows seen (pre-dedupe) — useful for diagnostics. */
  rawCount: number;
}

/**
 * Fetch + normalize the salaries for a draft group. Cached for 15 minutes via the Next
 * Data Cache (salaries shift slowly until lock). Never throws.
 */
export async function fetchDraftables(draftGroupId: string): Promise<DraftablesResult> {
  try {
    const res = await fetch(draftablesUrl(draftGroupId), {
      headers: { accept: 'application/json' },
      next: { revalidate: 900 },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { draftables?: RawDraftable[] };
    const rows = data.draftables ?? [];

    const byId = new Map<string, DkDraftable>();
    for (const r of rows) {
      const dkPlayerId = r.playerId != null ? String(r.playerId) : null;
      const team = r.teamAbbreviation ? normalizeTeamKey(r.teamAbbreviation) : null;
      const position = r.position?.trim().toUpperCase();
      const salary = typeof r.salary === 'number' ? r.salary : null;
      if (!dkPlayerId || !team || !position || salary == null) continue;
      if (byId.has(dkPlayerId)) continue; // same salary across roster-slot rows
      byId.set(dkPlayerId, {
        dkPlayerId,
        name: (r.displayName ?? '').trim(),
        firstName: r.firstName?.trim() || null,
        lastName: r.lastName?.trim() || null,
        teamKey: team,
        position,
        salary,
        status: r.status ?? null,
      });
    }
    return { players: [...byId.values()], rawCount: rows.length };
  } catch (err) {
    console.error('[draftkings] draftables fetch failed:', err);
    return { players: [], rawCount: 0 };
  }
}
