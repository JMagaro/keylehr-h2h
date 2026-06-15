/**
 * TypeScript interfaces for the subset of the ESPN NFL scoreboard payload we consume.
 *
 * Source endpoint:
 *   https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard
 *     ?seasontype=2&week=N&dates=YYYY
 *
 * Only the fields the schedule sync depends on are typed here. The real payload is
 * substantially larger (odds, broadcasts, leaders, venue, etc.); everything we do not
 * read is intentionally omitted so the shape stays narrow and self-documenting. All
 * fields are marked optional/defensive because ESPN occasionally omits data for
 * postponed, rescheduled, or not-yet-finalized games.
 */

/** A single team reference inside a competitor. */
export interface EspnTeam {
  /** ESPN's numeric team id, returned as a string (e.g. "12" for Kansas City). */
  id: string;
  /** Team abbreviation (e.g. "KC"). Useful for logging/diagnostics. */
  abbreviation?: string;
  displayName?: string;
}

/** One side (home or away) of a competition. */
export interface EspnCompetitor {
  id?: string;
  /** "home" or "away" — how we distinguish the two teams. */
  homeAway?: 'home' | 'away' | string;
  team?: EspnTeam;
}

/** The status descriptor (shared shape on both event.status and competition.status). */
export interface EspnStatusType {
  id?: string;
  /** e.g. "STATUS_SCHEDULED", "STATUS_FINAL", "STATUS_POSTPONED", "STATUS_IN_PROGRESS". */
  name?: string;
  /** Coarse state: "pre" | "in" | "post". */
  state?: string;
  completed?: boolean;
  description?: string;
  detail?: string;
  shortDetail?: string;
}

export interface EspnStatus {
  type?: EspnStatusType;
}

/** A competition is a single game; the scoreboard nests one per event. */
export interface EspnCompetition {
  id?: string;
  /** ISO 8601 kickoff timestamp; usually mirrors the parent event.date. */
  date?: string;
  competitors?: EspnCompetitor[];
  status?: EspnStatus;
}

export interface EspnWeek {
  number?: number;
}

/** A scoreboard event wraps one (or rarely more) competitions for a matchup. */
export interface EspnEvent {
  /** ESPN event id, returned as a string (e.g. "401671789"). */
  id: string;
  /** ISO 8601 kickoff timestamp. */
  date?: string;
  week?: EspnWeek;
  competitions?: EspnCompetition[];
  status?: EspnStatus;
}

/** Top-level scoreboard response. */
export interface EspnScoreboardResponse {
  events?: EspnEvent[];
}

/**
 * Our normalized, flattened view of a single scheduled NFL game. This is the only
 * shape the rest of the app (schedule sync) consumes from the ESPN layer.
 */
export interface NormalizedGame {
  /** ESPN event id (stable across pulls — used for idempotent upserts). */
  espnEventId: string;
  /** Regular-season week number (1..18). */
  week: number;
  /** ESPN team id of the home team. */
  homeEspnId: string;
  /** ESPN team id of the away team. */
  awayEspnId: string;
  /** Parsed kickoff time, or null when ESPN omits/garbles the date (e.g. TBD games). */
  kickoff: Date | null;
  /** Status name, e.g. "STATUS_SCHEDULED" / "STATUS_FINAL". null if unavailable. */
  status: string | null;
}
