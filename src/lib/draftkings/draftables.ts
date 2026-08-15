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

import { normalizeTeamKey } from '@/lib/nfl/team-keys';

/**
 * Standard DraftKings NFL Classic salary cap. (Draftables don't carry the cap.)
 * Defined in src/lib/dfs/rules.ts alongside the rest of the DK Classic rule set and
 * re-exported here, where the lineup builder has always imported it from.
 */
export { DK_CLASSIC_SALARY_CAP } from '@/lib/dfs/rules';

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
 * One raw fetch of a draft group's draftables, shared by the salary view and the
 * `draftableId` index below so a page needing both makes one request, not two.
 * Cached 15 minutes via the Next Data Cache (salaries shift slowly until lock).
 */
async function fetchRawDraftables(draftGroupId: string): Promise<RawDraftable[]> {
  const res = await fetch(draftablesUrl(draftGroupId), {
    headers: { accept: 'application/json' },
    next: { revalidate: 900 },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { draftables?: RawDraftable[] };
  return data.draftables ?? [];
}

/* -------------------------------------------------------------------------- */
/* draftableId → identity                                                     */
/* -------------------------------------------------------------------------- */

/** Who a `draftableId` refers to. The roster payload gives us only the id. */
export interface DraftableIdentity {
  dkPlayerId: string | null;
  name: string | null;
  /** Normalized to our nfl_teams.key. */
  teamKey: string | null;
  /** QB | RB | WR | TE | DST | … */
  position: string | null;
}

/**
 * Index a draft group by `draftableId`.
 *
 * WHY THIS EXISTS: DraftKings' authenticated roster payload identifies each drafted player
 * by `draftableId` ALONE — no team abbreviation, and for concealed players not even a name.
 * Scoring needs `(name, teamKey)` to reach ESPN's boxscore, so a capture is only usable once
 * those ids are resolved here, against the PUBLIC endpoint.
 *
 * Keyed by `draftableId`, NOT `playerId`: a player appears once per roster-slot eligibility
 * with a distinct draftableId, and the roster payload only ever quotes the draftable one.
 *
 * Never throws — an empty index degrades a capture to "names but no teams", which the live
 * page surfaces as unresolved rather than as zero points.
 */
export async function fetchDraftableIndex(
  draftGroupId: string,
): Promise<Map<string, DraftableIdentity>> {
  const index = new Map<string, DraftableIdentity>();
  try {
    for (const r of await fetchRawDraftables(draftGroupId)) {
      const draftableId = r.draftableId != null ? String(r.draftableId) : null;
      if (!draftableId || draftableId === '0') continue;
      index.set(draftableId, {
        dkPlayerId: r.playerId != null ? String(r.playerId) : null,
        name: (r.displayName ?? '').trim() || null,
        teamKey: r.teamAbbreviation ? normalizeTeamKey(r.teamAbbreviation) : null,
        position: r.position?.trim().toUpperCase() || null,
      });
    }
  } catch (err) {
    console.error('[draftkings] draftable index fetch failed:', err);
  }
  return index;
}

/**
 * Fetch + normalize the salaries for a draft group. Cached for 15 minutes via the Next
 * Data Cache (salaries shift slowly until lock). Never throws.
 */
export async function fetchDraftables(draftGroupId: string): Promise<DraftablesResult> {
  try {
    const rows = await fetchRawDraftables(draftGroupId);

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
