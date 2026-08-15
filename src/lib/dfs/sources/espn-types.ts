/**
 * Types for the subset of ESPN's NFL *summary* (boxscore) payload we consume.
 *
 * Endpoint (public, keyless):
 *   GET https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event={espnEventId}
 *
 * This is a different, much larger payload than the scoreboard typed in src/lib/espn/types.ts
 * (~600 KB vs ~140 KB). Only the read subset is typed; everything else is intentionally
 * omitted so the shape stays narrow and self-documenting. Every field is optional because
 * ESPN omits entire blocks for games that have not kicked off.
 */

/** A stat group (passing, rushing, …) for one team's players. */
export interface EspnStatGroup {
  /** "passing" | "rushing" | "receiving" | "fumbles" | "defensive" | … */
  name?: string;
  /**
   * Machine-readable column ids, e.g. ["completions/passingAttempts", "passingYards", …].
   *
   * ALWAYS index by this, never by `labels`. ESPN adds and reorders display columns between
   * payloads (`adjQBR` is present in some games and absent in others), which silently shifts
   * every positional index and produces plausible-but-wrong numbers.
   */
  keys?: string[];
  /** Display headers, parallel to `keys`. For humans only. */
  labels?: string[];
  athletes?: EspnAthleteStats[];
}

export interface EspnAthleteStats {
  athlete?: {
    id?: string;
    displayName?: string;
    shortName?: string;
  };
  /** Values parallel to the group's `keys`. Strings, sometimes "--" or "13/22" or "1-12". */
  stats?: string[];
}

/** One team's player stat groups. */
export interface EspnTeamPlayers {
  team?: { id?: string; abbreviation?: string; displayName?: string };
  statistics?: EspnStatGroup[];
}

/** One team's aggregate stats (name/value pairs). */
export interface EspnTeamStats {
  team?: { id?: string; abbreviation?: string };
  statistics?: { name?: string; displayValue?: string; value?: number; label?: string }[];
}

export interface EspnBoxscore {
  players?: EspnTeamPlayers[];
  teams?: EspnTeamStats[];
}

/** A scoring play. `awayScore`/`homeScore` are the running totals AFTER the play. */
export interface EspnScoringPlay {
  id?: string;
  type?: { id?: string; text?: string; abbreviation?: string };
  text?: string;
  awayScore?: number;
  homeScore?: number;
  period?: { number?: number };
  team?: { id?: string; abbreviation?: string };
}

/** A single play inside a drive. The only place 2-pt attempts and blocks are described. */
export interface EspnPlay {
  id?: string;
  text?: string;
  scoringPlay?: boolean;
  type?: { id?: string; text?: string };
  team?: { id?: string };
}

export interface EspnDrive {
  id?: string;
  team?: { abbreviation?: string; id?: string };
  plays?: EspnPlay[];
}

export interface EspnDrives {
  previous?: EspnDrive[];
  current?: EspnDrive;
}

/** Header competitor — the authoritative final/running score for points-allowed. */
export interface EspnHeaderCompetitor {
  id?: string;
  homeAway?: 'home' | 'away' | string;
  /** Score as a string, e.g. "16". */
  score?: string;
  winner?: boolean;
  team?: { id?: string; abbreviation?: string; displayName?: string };
}

export interface EspnHeaderCompetition {
  id?: string;
  date?: string;
  competitors?: EspnHeaderCompetitor[];
  status?: {
    type?: {
      /** "pre" | "in" | "post". */
      state?: string;
      name?: string;
      completed?: boolean;
      /** e.g. "Final", "8:30 - 3rd Quarter". */
      detail?: string;
      shortDetail?: string;
    };
  };
}

export interface EspnSummaryResponse {
  boxscore?: EspnBoxscore;
  scoringPlays?: EspnScoringPlay[];
  drives?: EspnDrives;
  header?: {
    id?: string;
    competitions?: EspnHeaderCompetition[];
  };
}
