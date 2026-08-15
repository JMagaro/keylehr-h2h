/**
 * Turn an ESPN summary payload into DraftKings-shaped stat lines. Pure — no fetch, no DB,
 * no clock — so every quirk below is unit-testable against a stored fixture.
 *
 * WHAT IS EXACT vs BEST-EFFORT
 *
 * Exact (straight out of the boxscore, no inference):
 *   passing/rushing/receiving yards + TDs, receptions, interceptions thrown, fumbles lost,
 *   kick/punt return TDs, sacks, defensive interceptions, defensive TDs, points allowed.
 *   This is ~99% of DK scoring by volume.
 *
 * Best-effort (ESPN does not expose these as stats — only as English play text):
 *   2-point conversions, safeties, blocked kicks. Each is worth 2 points and touches a
 *   handful of players league-wide per week. We parse them from `drives[].plays[].text`
 *   and `scoringPlays[]`, attributing 2-pt conversions via ESPN's abbreviated gamebook
 *   names ("P.Mahomes"), which is inherently fuzzy. A miss costs ±2 on one player and is
 *   corrected when the official DraftKings total lands. See docs/SCORING.md §15.
 *
 * Known gap: a blocked-kick RETURN touchdown is credited by DK as a special-teams TD but is
 * not separable from other return TDs in ESPN's data. Rare enough to accept.
 */
import { normalizeTeamKey } from '@/lib/nfl/team-keys';
import { EMPTY_DST_LINE, EMPTY_PLAYER_LINE, type DstStatLine, type PlayerStatLine } from '../stat-line';
import type { GameState } from './espn-boxscore';
import type {
  EspnStatGroup,
  EspnSummaryResponse,
  EspnTeamStats,
} from './espn-types';

export interface ExtractedPlayer {
  /**
   * ESPN athlete id — stable, but cross-source matching keys on (normalized name, team key)
   * because DK's draftables carry no ESPN id. See `playerKey` in scripts/dfs-selftest.ts;
   * a shared ../identity.ts is planned, not written.
   */
  espnAthleteId: string;
  name: string;
  teamKey: string;
  line: PlayerStatLine;
}

export interface ExtractedDefense {
  teamKey: string;
  line: DstStatLine;
}

export interface ExtractedGame {
  espnEventId: string | null;
  state: GameState;
  /** ESPN's human status, e.g. "Final" or "8:30 - 3rd Quarter". */
  statusDetail: string | null;
  /** Both teams' `nfl_teams.key`, home first when known. */
  teamKeys: string[];
  players: ExtractedPlayer[];
  defenses: ExtractedDefense[];
}

/* -------------------------------------------------------------------------- */
/* Primitives                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Parse an ESPN stat cell to a number.
 * ESPN uses "--" for "did not record", "" for missing, and combined cells like "13/22"
 * or "1-12" for paired stats. We never index a combined cell by choice, so anything
 * unparseable becomes 0 rather than NaN poisoning a sum.
 */
export function parseStat(raw: string | undefined | null): number {
  if (raw === undefined || raw === null) return 0;
  const trimmed = String(raw).trim();
  if (trimmed === '' || trimmed === '--') return 0;
  const n = Number(trimmed.replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Read one column from a stat group by its stable `keys[]` id.
 * Returns 0 when the group, the key, or the row is absent — which is the correct reading
 * for a player who simply didn't record that stat.
 */
function statByKey(group: EspnStatGroup, stats: string[] | undefined, key: string): number {
  const idx = group.keys?.indexOf(key) ?? -1;
  if (idx < 0 || !stats || idx >= stats.length) return 0;
  return parseStat(stats[idx]);
}

/** Read a team aggregate stat by name (`fumblesLost`, `defensiveTouchdowns`, …). */
function teamStat(team: EspnTeamStats | undefined, name: string): number {
  const row = team?.statistics?.find((s) => s.name === name);
  if (!row) return 0;
  if (typeof row.value === 'number' && Number.isFinite(row.value)) return row.value;
  return parseStat(row.displayValue);
}

/** ESPN's coarse game state, defaulting to `pre` when the payload is incomplete. */
function readState(raw: string | undefined): GameState {
  if (raw === 'in') return 'in';
  if (raw === 'post') return 'post';
  return 'pre';
}

/* -------------------------------------------------------------------------- */
/* Play-text parsing (best-effort)                                            */
/* -------------------------------------------------------------------------- */

/**
 * Matches an ESPN gamebook abbreviated name: an initial, then one or more surname tokens
 * ("J.McCarthy", "A.St. Brown", "A.Jones").
 *
 * The negative lookahead is load-bearing. Surnames may contain spaces, so without it the
 * pattern happily swallows the verb that follows — "J.Allen rushes right end" parsed as the
 * name "J.Allen rushes". Every word that can legally follow a name in gamebook text is
 * excluded so the match stops at the surname.
 */
const NAME_PATTERN =
  "[A-Za-z]\\.\\s*[A-Za-z'.-]+(?:\\s+(?!pass|rush|run|scramble|kneel|sack|up|left|right|middle|end|guard|tackle|for|is|to|and|no|the)[A-Za-z'.-]+)*";

/**
 * Normalize an ESPN gamebook abbreviated name ("P.Mahomes", "A.St. Brown") to a lookup key
 * of `firstInitial|lastname`, lowercased and stripped of punctuation.
 * Returns null when the token doesn't look like an abbreviated name.
 */
export function abbreviatedNameKey(token: string): string | null {
  const m = token.trim().match(/^([A-Za-z])\.\s*([A-Za-z' .-]+)$/);
  if (!m) return null;
  const last = m[2]
    .toLowerCase()
    .replace(/[.'-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!last) return null;
  return `${m[1].toLowerCase()}|${last}`;
}

/** Build the same key from a full display name ("Patrick Mahomes" -> "p|mahomes"). */
export function fullNameKey(name: string): string | null {
  const cleaned = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\b(Jr|Sr|II|III|IV|V)\b\.?/gi, '')
    .trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  const first = parts[0][0]?.toLowerCase();
  const last = parts
    .slice(1)
    .join(' ')
    .toLowerCase()
    .replace(/[.'-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!first || !last) return null;
  return `${first}|${last}`;
}

/** A successful 2-pt conversion, attributed to whoever we could identify. */
export interface TwoPointCredit {
  /** `firstInitial|lastname` keys of every player DK would credit with +2. */
  playerKeys: string[];
}

/**
 * Extract successful two-point conversions from a play's text.
 *
 * ESPN embeds them in the parent touchdown play, e.g.:
 *   "…TOUCHDOWN. TWO-POINT CONVERSION ATTEMPT. P.Mahomes pass to N.Gray is incomplete.
 *    ATTEMPT FAILS."
 *   "…TWO-POINT CONVERSION ATTEMPT. J.Allen rushes right end. ATTEMPT SUCCEEDS."
 *
 * DK pays +2 for a 2-pt conversion passed, rushed, OR caught — so a successful pass credits
 * both the passer and the receiver.
 */
export function extractTwoPointCredits(text: string | undefined): TwoPointCredit | null {
  if (!text) return null;
  const upper = text.toUpperCase();
  if (!upper.includes('TWO-POINT CONVERSION ATTEMPT')) return null;
  if (!upper.includes('ATTEMPT SUCCEEDS')) return null;

  const start = upper.indexOf('TWO-POINT CONVERSION ATTEMPT');
  const segment = text.slice(start).replace(/^TWO-POINT CONVERSION ATTEMPT\.?/i, '').trim();

  const playerKeys: string[] = [];

  // "P.Mahomes pass to N.Gray" — DK credits BOTH the passer and the receiver with +2.
  const passMatch = segment.match(
    new RegExp(`(${NAME_PATTERN})\\s+pass(?:es)?\\s+(?:to\\s+)?(${NAME_PATTERN})`, 'i'),
  );
  if (passMatch) {
    for (const token of [passMatch[1], passMatch[2]]) {
      const key = abbreviatedNameKey(token);
      if (key) playerKeys.push(key);
    }
  } else {
    // A run: "J.Allen rushes right end", "T.Hill up the middle". The gamebook always leads
    // with the ball carrier, so the first abbreviated name in the segment is the runner —
    // more reliable than trying to enumerate every direction phrase ESPN uses as a verb.
    const rushMatch = segment.match(new RegExp(NAME_PATTERN, 'i'));
    const key = rushMatch ? abbreviatedNameKey(rushMatch[0]) : null;
    if (key) playerKeys.push(key);
  }

  return playerKeys.length > 0 ? { playerKeys } : null;
}

/** True when a play describes a kick/punt/FG that was blocked. */
export function isBlockedKickPlay(text: string | undefined): boolean {
  if (!text) return false;
  return /\bBLOCKED\b/i.test(text);
}

/* -------------------------------------------------------------------------- */
/* Extraction                                                                 */
/* -------------------------------------------------------------------------- */

/** Accumulator so a player appearing in several stat groups merges into one line. */
type PlayerAcc = {
  espnAthleteId: string;
  name: string;
  teamKey: string;
  line: PlayerStatLine;
};

/**
 * Extract every DK-relevant stat line from one ESPN summary payload.
 *
 * Returns a `pre`-state game with empty players/defenses when the boxscore is absent,
 * which is exactly what ESPN serves before kickoff — callers must treat that as
 * "nothing yet", never as "everyone scored zero".
 */
export function extractGame(summary: EspnSummaryResponse): ExtractedGame {
  const competition = summary.header?.competitions?.[0];
  const statusType = competition?.status?.type;
  const state = readState(statusType?.state);
  const statusDetail = statusType?.detail ?? statusType?.shortDetail ?? null;
  const espnEventId = summary.header?.id ? String(summary.header.id) : null;

  // --- teams, scores, and the espnTeamId -> teamKey map ---------------------
  const teamKeyByEspnId = new Map<string, string>();
  const scoreByTeamKey = new Map<string, number>();
  const orderedTeamKeys: string[] = [];

  for (const c of competition?.competitors ?? []) {
    const abbr = c.team?.abbreviation;
    const espnId = c.team?.id ?? c.id;
    if (!abbr || !espnId) continue;
    const teamKey = normalizeTeamKey(abbr);
    teamKeyByEspnId.set(String(espnId), teamKey);
    scoreByTeamKey.set(teamKey, parseStat(c.score));
    if (c.homeAway === 'home') orderedTeamKeys.unshift(teamKey);
    else orderedTeamKeys.push(teamKey);
  }

  // --- per-player offensive + return stats ---------------------------------
  const players = new Map<string, PlayerAcc>();
  /** Per team: return TDs and sacks/INTs summed from that team's own players. */
  const teamReturnTds = new Map<string, number>();
  const teamSacks = new Map<string, number>();
  const teamDefInterceptions = new Map<string, number>();

  for (const teamBlock of summary.boxscore?.players ?? []) {
    const abbr = teamBlock.team?.abbreviation;
    if (!abbr) continue;
    const teamKey = normalizeTeamKey(abbr);

    for (const group of teamBlock.statistics ?? []) {
      const groupName = group.name;
      if (!groupName) continue;

      for (const row of group.athletes ?? []) {
        const athleteId = row.athlete?.id;
        const name = row.athlete?.displayName;
        if (!athleteId || !name) continue;

        const id = String(athleteId);
        let acc = players.get(id);
        if (!acc) {
          acc = { espnAthleteId: id, name, teamKey, line: { ...EMPTY_PLAYER_LINE } };
          players.set(id, acc);
        }
        const s = row.stats;

        switch (groupName) {
          case 'passing':
            acc.line.passYards += statByKey(group, s, 'passingYards');
            acc.line.passTd += statByKey(group, s, 'passingTouchdowns');
            // In the PASSING group, "interceptions" means INTs thrown.
            acc.line.passInterceptions += statByKey(group, s, 'interceptions');
            break;
          case 'rushing':
            acc.line.rushYards += statByKey(group, s, 'rushingYards');
            acc.line.rushTd += statByKey(group, s, 'rushingTouchdowns');
            break;
          case 'receiving':
            acc.line.receptions += statByKey(group, s, 'receptions');
            acc.line.recYards += statByKey(group, s, 'receivingYards');
            acc.line.recTd += statByKey(group, s, 'receivingTouchdowns');
            break;
          case 'fumbles':
            // DK penalises only fumbles LOST, not total fumbles.
            acc.line.fumblesLost += statByKey(group, s, 'fumblesLost');
            break;
          case 'kickReturns': {
            const td = statByKey(group, s, 'kickReturnTouchdowns');
            acc.line.returnTd += td;
            teamReturnTds.set(teamKey, (teamReturnTds.get(teamKey) ?? 0) + td);
            break;
          }
          case 'puntReturns': {
            const td = statByKey(group, s, 'puntReturnTouchdowns');
            acc.line.returnTd += td;
            teamReturnTds.set(teamKey, (teamReturnTds.get(teamKey) ?? 0) + td);
            break;
          }
          case 'defensive':
            // Defensive production belongs to the DST unit, not the individual, in DK Classic.
            teamSacks.set(teamKey, (teamSacks.get(teamKey) ?? 0) + statByKey(group, s, 'sacks'));
            break;
          case 'interceptions':
            // In the INTERCEPTIONS group, "interceptions" means INTs caught.
            teamDefInterceptions.set(
              teamKey,
              (teamDefInterceptions.get(teamKey) ?? 0) + statByKey(group, s, 'interceptions'),
            );
            break;
          default:
            break; // kicking / punting — DK Classic NFL has no kicker slot.
        }
      }
    }
  }

  // --- best-effort play-text stats -----------------------------------------
  const twoPointByPlayerKey = new Map<string, number>();
  const blockedKicksByTeam = new Map<string, number>();
  const safetiesByTeam = new Map<string, number>();

  const allDrives = [
    ...(summary.drives?.previous ?? []),
    ...(summary.drives?.current ? [summary.drives.current] : []),
  ];
  for (const drive of allDrives) {
    // A drive's `team` is the offense; a block is credited to the defending side.
    const offenseKey = drive.team?.abbreviation ? normalizeTeamKey(drive.team.abbreviation) : null;
    const defenseKey = offenseKey ? orderedTeamKeys.find((k) => k !== offenseKey) ?? null : null;

    for (const play of drive.plays ?? []) {
      const credit = extractTwoPointCredits(play.text);
      if (credit) {
        for (const key of credit.playerKeys) {
          twoPointByPlayerKey.set(key, (twoPointByPlayerKey.get(key) ?? 0) + 1);
        }
      }
      if (defenseKey && isBlockedKickPlay(play.text)) {
        blockedKicksByTeam.set(defenseKey, (blockedKicksByTeam.get(defenseKey) ?? 0) + 1);
      }
    }
  }

  for (const play of summary.scoringPlays ?? []) {
    const typeText = play.type?.text ?? '';
    if (/safety/i.test(typeText)) {
      // ESPN credits the scoring play to the team that scored the safety (the defense).
      const espnId = play.team?.id ? String(play.team.id) : null;
      const teamKey = espnId ? teamKeyByEspnId.get(espnId) ?? null : null;
      if (teamKey) safetiesByTeam.set(teamKey, (safetiesByTeam.get(teamKey) ?? 0) + 1);
    }
    // 2-pt conversions also appear on scoring plays; drives are the richer source, but
    // ESPN sometimes ships scoringPlays without full drive data (in-progress games).
    const credit = extractTwoPointCredits(play.text);
    if (credit && allDrives.length === 0) {
      for (const key of credit.playerKeys) {
        twoPointByPlayerKey.set(key, (twoPointByPlayerKey.get(key) ?? 0) + 1);
      }
    }
  }

  // Attribute two-point conversions to the players we extracted.
  if (twoPointByPlayerKey.size > 0) {
    for (const acc of players.values()) {
      const key = fullNameKey(acc.name);
      const count = key ? twoPointByPlayerKey.get(key) ?? 0 : 0;
      if (count > 0) acc.line.twoPointConversions += count;
    }
  }

  // --- DST lines -----------------------------------------------------------
  const teamStatsByKey = new Map<string, EspnTeamStats>();
  for (const t of summary.boxscore?.teams ?? []) {
    const abbr = t.team?.abbreviation;
    if (abbr) teamStatsByKey.set(normalizeTeamKey(abbr), t);
  }

  const defenses: ExtractedDefense[] = [];
  for (const teamKey of orderedTeamKeys) {
    const opponentKey = orderedTeamKeys.find((k) => k !== teamKey);
    if (!opponentKey) continue;

    const own = teamStatsByKey.get(teamKey);
    const opponent = teamStatsByKey.get(opponentKey);

    defenses.push({
      teamKey,
      line: {
        ...EMPTY_DST_LINE,
        sacks: teamSacks.get(teamKey) ?? 0,
        interceptions: teamDefInterceptions.get(teamKey) ?? 0,
        // Fumbles the OPPONENT lost are the ones this defense recovered. Do not use our own
        // `fumblesRecovered`, which also counts recovering our own team's fumble.
        fumbleRecoveries: teamStat(opponent, 'fumblesLost'),
        safeties: safetiesByTeam.get(teamKey) ?? 0,
        blockedKicks: blockedKicksByTeam.get(teamKey) ?? 0,
        // Team-level `defensiveTouchdowns` ALREADY includes interception-return TDs — adding
        // the per-player `interceptionTouchdowns` on top would double-count.
        defensiveTds: teamStat(own, 'defensiveTouchdowns'),
        specialTeamsTds: teamReturnTds.get(teamKey) ?? 0,
        pointsAllowed: scoreByTeamKey.get(opponentKey) ?? 0,
      },
    });
  }

  return {
    espnEventId,
    state,
    statusDetail,
    teamKeys: orderedTeamKeys,
    players: [...players.values()].map((p) => ({
      espnAthleteId: p.espnAthleteId,
      name: p.name,
      teamKey: p.teamKey,
      line: p.line,
    })),
    defenses,
  };
}
