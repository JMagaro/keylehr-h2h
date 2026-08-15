/**
 * Normalize a DraftKings roster payload into our lineup shape. Pure — no DB, no network.
 *
 * WHY IT IS SHAPE-AGNOSTIC: DraftKings' roster endpoint is undocumented and auth-gated, and
 * DK's payloads already vary by endpoint and version (that variance is exactly why the
 * leaderboard extractor in extension/page-hook.js walks the tree instead of following a
 * fixed path). Rather than hardcode a path we have not seen, we identify roster rows
 * STRUCTURALLY — an object carrying a player id plus a slot or a name — and gather them
 * wherever they appear.
 *
 * The consequence worth stating: the endpoint probe CONFIRMS the shape rather than defining
 * it. If DK returns a different envelope than expected, this keeps working.
 *
 * Three payload shapes are handled:
 *   1. Bulk      — a leaderboard whose entries each embed a roster.
 *   2. Per entry — one entry object with its roster.
 *   3. Bare      — just the nine slots, with the entry name supplied by the caller.
 */
import { normalizeTeamKey } from '@/lib/nfl/team-keys';

/**
 * One stat line as DRAFTKINGS itself scored it, captured verbatim.
 *
 * `key` is DK's own abbreviation (RecYds, REC, RuTD, …) — deliberately not remapped to our
 * `PlayerStatLine` field names, because the entire value of this data is that it is DK's
 * account of the play, unmediated by our interpretation of it.
 */
export interface DkStat {
  key: string;
  /** The raw stat (5 receiving yards, 1 reception). */
  value: number;
  /** What DraftKings paid for it. 0 for stats that don't score, e.g. Targets. */
  points: number;
}

/** One drafted player. */
export interface LineupSlotInput {
  /** DK roster slot: QB | RB | WR | TE | FLEX | DST. Null when DK didn't say. */
  slot: string | null;
  dkPlayerId: string | null;
  draftableId: string | null;
  name: string | null;
  /**
   * Normalized to `nfl_teams.key`. DraftKings' roster payload does NOT carry a team
   * abbreviation, so this is null on capture and resolved from `draftableId` against the
   * PUBLIC draftables endpoint (src/lib/draftkings/draftables.ts).
   */
  teamKey: string | null;
  /** The player's actual position, which differs from `slot` for a FLEX. */
  position: string | null;
  /**
   * False when DraftKings CONCEALED the player.
   *
   * DK hides an opponent's player until that player's game kicks off — the concealed row
   * arrives as `{ rosterPosition, draftableId: 0, isSwappable: true, yetToPlay: true }` with
   * no name. This is load-bearing for correctness in two ways:
   *   1. A concealed slot is NOT an empty lineup. Never render it as 0.00.
   *   2. Concealment tracks swappability exactly, so ANY player we can see is already locked
   *      and can no longer be swapped. Revealed data never goes stale.
   */
  revealed: boolean;
  /**
   * DraftKings' OWN fantasy points for this player at capture time, when revealed.
   *
   * Not used for scoring — the live page computes from ESPN so it works without auth — but
   * it is a free per-player reconciliation checkpoint every time a capture runs.
   */
  dkScore: number | null;
  /**
   * DraftKings' own STAT LINE for this player at capture time, when revealed.
   *
   * Also not used for scoring, and also a checkpoint — but a far sharper one than `dkScore`.
   * A matching total can hide two compensating errors; a per-stat diff cannot. This is how
   * the ESPN extractor gets validated against DK's own account of the same game, and how
   * `pointsAllowedMode` gets settled empirically instead of by guesswork.
   *
   * Captured because it is available ONLY at capture time: DraftKings' authenticated roster
   * endpoint is the only place it exists, and it is gone once the contest ages out.
   */
  dkStats: DkStat[] | null;
}

/** One owner's captured lineup, before owner matching. */
export interface LineupInput {
  entryName: string;
  entryKey: string | null;
  slots: LineupSlotInput[];
}

export interface NormalizeResult {
  lineups: LineupInput[];
  /** Rows that looked like lineups but carried no usable slots. */
  skipped: number;
}

/* -------------------------------------------------------------------------- */
/* Field aliases                                                              */
/* -------------------------------------------------------------------------- */

const ENTRY_NAME_KEYS = [
  'userName',
  'user_name',
  'UserName',
  'displayName',
  'screenName',
  'entryName',
  'EntryName',
  'draftGroupPlayerName',
] as const;

const ENTRY_KEY_KEYS = ['entryKey', 'entry_key', 'EntryKey', 'entryId', 'EntryId'] as const;

const PLAYER_ID_KEYS = ['playerId', 'PlayerId', 'player_id', 'playerDkId'] as const;
const DRAFTABLE_ID_KEYS = ['draftableId', 'DraftableId', 'draftable_id'] as const;
const SLOT_KEYS = [
  'rosterPosition',
  'RosterPosition',
  'rosterSlotName',
  'roster_position',
  'rosterSlotId',
] as const;
const POSITION_KEYS = ['position', 'Position', 'playerPosition'] as const;
const PLAYER_NAME_KEYS = [
  'displayName',
  'DisplayName',
  'playerName',
  'fullName',
  'name',
  'Name',
] as const;
const TEAM_KEYS = [
  'teamAbbreviation',
  'TeamAbbreviation',
  'teamAbbrev',
  'team',
  'Team',
  'teamKey',
] as const;

/** DraftKings' own fantasy points for a drafted player, when it reveals them. */
const SCORE_KEYS = ['score', 'Score', 'fantasyPoints', 'FantasyPoints'] as const;

/** DK's per-stat breakdown array, and the fields inside one of its rows. */
const STATS_KEYS = ['stats', 'Stats'] as const;
const STAT_NAME_KEYS = ['abbreviation', 'Abbreviation', 'name', 'Name'] as const;
const STAT_VALUE_KEYS = ['statValue', 'StatValue', 'value', 'Value'] as const;
const STAT_POINTS_KEYS = ['fantasyPoints', 'FantasyPoints', 'points', 'Points'] as const;

type Bag = Record<string, unknown>;

function isBag(v: unknown): v is Bag {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function firstValue(obj: Bag, keys: readonly string[]): unknown {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function toStr(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/** DK writes defenses as DST/DEF/D depending on the endpoint. Collapse them. */
function normalizeSlot(raw: string | null): string | null {
  if (!raw) return null;
  const u = raw.trim().toUpperCase();
  if (u === 'DEF' || u === 'D' || u === 'DST') return 'DST';
  return u;
}

/** Build a name from firstName/lastName when DK omits a combined display name. */
function readPlayerName(obj: Bag): string | null {
  const direct = toStr(firstValue(obj, PLAYER_NAME_KEYS));
  if (direct) return direct;
  const first = toStr(firstValue(obj, ['firstName', 'FirstName']));
  const last = toStr(firstValue(obj, ['lastName', 'LastName']));
  if (first && last) return `${first} ${last}`;
  return last ?? first ?? null;
}

/* -------------------------------------------------------------------------- */
/* Structural detection                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Does this object look like one drafted player?
 * Requires an id (so a stray display object can't qualify) plus a slot or a name.
 */
export function looksLikeRosterSlot(v: unknown): boolean {
  if (!isBag(v)) return false;
  const hasId =
    firstValue(v, PLAYER_ID_KEYS) !== undefined || firstValue(v, DRAFTABLE_ID_KEYS) !== undefined;
  if (!hasId) return false;
  const hasSlot =
    firstValue(v, SLOT_KEYS) !== undefined || firstValue(v, POSITION_KEYS) !== undefined;
  return hasSlot || readPlayerName(v) !== null;
}

function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Read DraftKings' per-stat breakdown off a drafted-player row.
 *
 * Returns null rather than [] when DK gave no stats at all, so "DK says this player has done
 * nothing yet" (an empty array — DK sends `"stats": []` pre-snap) stays distinguishable from
 * "this payload has no stat breakdown in it".
 */
function readDkStats(obj: Bag): DkStat[] | null {
  const raw = firstValue(obj, STATS_KEYS);
  if (!Array.isArray(raw)) return null;

  const out: DkStat[] = [];
  for (const row of raw) {
    if (!isBag(row)) continue;
    const key = toStr(firstValue(row, STAT_NAME_KEYS));
    const value = toNum(firstValue(row, STAT_VALUE_KEYS));
    if (key === null || value === null) continue;
    out.push({ key, value, points: toNum(firstValue(row, STAT_POINTS_KEYS)) ?? 0 });
  }
  return out;
}

/** Numeric ids of 0 mean "absent" in DK's roster payload, not "player number zero". */
function toIdStr(v: unknown): string | null {
  const s = toStr(v);
  if (s === null || s === '0') return null;
  return s;
}

/** Normalize one drafted-player object. */
export function normalizeSlotObject(obj: Bag): LineupSlotInput {
  const team = toStr(firstValue(obj, TEAM_KEYS));
  const position = normalizeSlot(toStr(firstValue(obj, POSITION_KEYS)));
  // DK sometimes gives only a position and no explicit roster slot; fall back so a lineup is
  // still usable (FLEX is then indistinguishable from its base position, which is fine —
  // scoring does not depend on which slot a player occupies).
  const slot = normalizeSlot(toStr(firstValue(obj, SLOT_KEYS))) ?? position;

  const draftableId = toIdStr(firstValue(obj, DRAFTABLE_ID_KEYS));
  const dkPlayerId = toIdStr(firstValue(obj, PLAYER_ID_KEYS));
  const name = readPlayerName(obj);

  // A concealed slot carries a roster position but no identity: DK sends draftableId 0 and
  // omits the name until that player's game starts.
  const revealed = Boolean(draftableId || dkPlayerId || name);

  const rawScore = firstValue(obj, SCORE_KEYS);
  const score = typeof rawScore === 'number' && Number.isFinite(rawScore) ? rawScore : null;

  return {
    slot,
    dkPlayerId,
    draftableId,
    name,
    teamKey: team ? normalizeTeamKey(team) : null,
    position,
    revealed,
    dkScore: revealed ? score : null,
    dkStats: revealed ? readDkStats(obj) : null,
  };
}

/** Recursively gather every roster-slot-shaped object under `value`. */
function collectSlots(value: unknown, depth: number, acc: Bag[]): void {
  if (depth > 8 || value === null || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    for (const item of value) {
      if (looksLikeRosterSlot(item)) acc.push(item as Bag);
      else collectSlots(item, depth + 1, acc);
    }
    return;
  }

  const obj = value as Bag;
  const keys = Object.keys(obj);
  // A keyed MAP of slots (DK does this for entries; assume it may here too). Only treat it as
  // one when most values qualify, so a container holding a single stray slot keeps descending.
  const slotKeys = keys.filter((k) => looksLikeRosterSlot(obj[k]));
  if (slotKeys.length >= 2 && slotKeys.length >= keys.length / 2) {
    for (const k of slotKeys) acc.push(obj[k] as Bag);
    return;
  }
  for (const k of keys) collectSlots(obj[k], depth + 1, acc);
}

/**
 * Does this object look like an ENTRY that owns a roster?
 * It must name someone and contain at least one roster row beneath it.
 */
function looksLikeLineupEntry(v: unknown): boolean {
  if (!isBag(v)) return false;
  if (toStr(firstValue(v, ENTRY_NAME_KEYS)) === null) return false;
  const acc: Bag[] = [];
  collectSlots(v, 0, acc);
  return acc.length > 0;
}

/** Recursively gather lineup-entry-shaped objects. */
function collectLineupEntries(value: unknown, depth: number, acc: Bag[]): void {
  if (depth > 8 || value === null || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    for (const item of value) {
      if (looksLikeLineupEntry(item)) acc.push(item as Bag);
      else collectLineupEntries(item, depth + 1, acc);
    }
    return;
  }

  const obj = value as Bag;
  const keys = Object.keys(obj);
  const entryKeys = keys.filter((k) => looksLikeLineupEntry(obj[k]));
  if (entryKeys.length >= 2 && entryKeys.length >= keys.length / 2) {
    for (const k of entryKeys) acc.push(obj[k] as Bag);
    return;
  }
  for (const k of keys) collectLineupEntries(obj[k], depth + 1, acc);
}

/**
 * Drop duplicate PLAYERS within one lineup, preserving order.
 *
 * Concealed slots are never de-duplicated. They are identity-less by construction — DK sends
 * every one of them as `draftableId: 0` with no name — so keying them the same way would
 * collapse five pending slots into one and silently turn a 9-man lineup into a 5-man one.
 * They are positional placeholders, and a lineup must keep all nine.
 */
function dedupeSlots(slots: LineupSlotInput[]): LineupSlotInput[] {
  const seen = new Set<string>();
  const out: LineupSlotInput[] = [];
  for (const s of slots) {
    if (!s.revealed) {
      out.push(s);
      continue;
    }
    const key = s.draftableId ?? s.dkPlayerId ?? `${s.name ?? ''}|${s.teamKey ?? ''}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Normalize any DraftKings roster payload into lineups.
 *
 * @param envelope     Whatever DK returned (or a hand-pasted equivalent).
 * @param fallbackName Entry name to use when the payload is a BARE roster with no entry
 *                     identity — i.e. a per-entry endpoint where the caller already knows
 *                     whose lineup it asked for.
 */
export function normalizeRosterPayload(
  envelope: unknown,
  fallbackName?: string,
): NormalizeResult {
  const entryObjs: Bag[] = [];
  collectLineupEntries(envelope, 0, entryObjs);

  const lineups: LineupInput[] = [];
  let skipped = 0;

  if (entryObjs.length > 0) {
    for (const obj of entryObjs) {
      const entryName = toStr(firstValue(obj, ENTRY_NAME_KEYS));
      if (!entryName) {
        skipped += 1;
        continue;
      }
      const rawSlots: Bag[] = [];
      collectSlots(obj, 0, rawSlots);
      const slots = dedupeSlots(rawSlots.map(normalizeSlotObject));
      if (slots.length === 0) {
        skipped += 1;
        continue;
      }
      lineups.push({
        entryName,
        entryKey: toStr(firstValue(obj, ENTRY_KEY_KEYS)),
        slots,
      });
    }
  } else {
    // No entry wrapper — treat the whole payload as one lineup (per-entry / bare shapes).
    const rawSlots: Bag[] = [];
    collectSlots(envelope, 0, rawSlots);
    const slots = dedupeSlots(rawSlots.map(normalizeSlotObject));
    const entryName =
      (isBag(envelope) ? toStr(firstValue(envelope, ENTRY_NAME_KEYS)) : null) ??
      toStr(fallbackName);

    if (slots.length > 0 && entryName) {
      lineups.push({
        entryName,
        entryKey: isBag(envelope) ? toStr(firstValue(envelope, ENTRY_KEY_KEYS)) : null,
        slots,
      });
    } else if (slots.length > 0) {
      // Rosters with nobody to attribute them to are useless — surface, don't guess.
      skipped += 1;
    }
  }

  // De-dupe whole lineups by entry key, then by lowercased name.
  const byKey = new Map<string, LineupInput>();
  const byName = new Map<string, LineupInput>();
  const out: LineupInput[] = [];
  for (const l of lineups) {
    const keyId = l.entryKey ? `k:${l.entryKey}` : null;
    const nameId = `n:${l.entryName.toLowerCase()}`;
    if (keyId && byKey.has(keyId)) continue;
    if (!keyId && byName.has(nameId)) continue;
    if (keyId) byKey.set(keyId, l);
    byName.set(nameId, l);
    out.push(l);
  }

  return { lineups: out, skipped };
}
