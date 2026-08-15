/**
 * Turn matchups + captured rosters + a stat index into what /live renders. PURE — no DB, no
 * network, no clock — so every rule below is unit-testable, mirroring standings/assemble.ts.
 *
 * THE ONE RULE THAT MATTERS: a slot that we could not score is NEVER 0.00.
 *
 * Zero is a real, meaningful DraftKings result — a player can genuinely score nothing. So
 * every OTHER reason a number is missing gets its own state, and the total is reported as a
 * floor with the reason attached. A mid-Sunday page where everyone sits near zero must never
 * be readable as "everyone forfeited"; that is the exact class of bug docs/SCORING.md exists
 * to prevent, and here it is prevented by never producing the ambiguous value in the first
 * place.
 *
 *   scored      — we have this player's stat line. `points` is real (and may legitimately be 0).
 *   pending     — their game has not kicked off. Contributes nothing YET, and says so.
 *   concealed   — DraftKings hid the player (their game hasn't started). Same as pending for
 *                 arithmetic, but we don't even know the name.
 *   unresolved  — we know who they are and their game has started, but no stat line matched.
 *                 This is the only genuinely bad state, and it must be loud.
 *
 * Nothing here is a score. See docs/SCORING.md §15.
 */
import { scoreDst, scorePlayer, type ScoreComponent } from '@/lib/dfs/score';
import type { LineupSlotInput } from '@/lib/lineups/normalize';

import { playerStatKey, type LiveStatIndex } from './stats';

export type LiveSlotStatus = 'scored' | 'pending' | 'concealed' | 'unresolved';

export interface LiveSlot {
  /** DK roster slot: QB | RB | WR | TE | FLEX | DST. */
  slot: string | null;
  name: string | null;
  teamKey: string | null;
  position: string | null;
  status: LiveSlotStatus;
  /** null for every status except 'scored'. Never 0 as a stand-in for "unknown". */
  points: number | null;
  /** Per-rule breakdown for the expanded view. Empty unless scored. */
  components: ScoreComponent[];
  /** ESPN's human game status for this player's team, e.g. "8:30 - 3rd Quarter". */
  gameDetail: string | null;
  /** DraftKings' own number at capture time — a reconciliation checkpoint, not the estimate. */
  dkScore: number | null;
}

export interface LiveTeam {
  ownerSeasonId: number;
  ownerName: string;
  teamKey: string | null;
  logoEspn: string | null;
  /**
   * Sum of SCORED slots only, so a matching failure understates rather than invents.
   * Read it as a floor whenever `unresolved` or `pending` is non-zero.
   */
  points: number;
  slots: LiveSlot[];
  scored: number;
  pending: number;
  concealed: number;
  unresolved: number;
  /** When DraftKings was read. null when this owner has no capture at all. */
  capturedAt: Date | null;
  /** False → render "not captured", never "0.00". */
  hasSnapshot: boolean;
}

export interface LiveMatchup {
  id: number;
  home: LiveTeam;
  away: LiveTeam;
}

export interface LiveView {
  matchups: LiveMatchup[];
  /** Owners with a matchup but no captured roster — surfaced by name, never hidden. */
  missingCaptures: string[];
  gamesLoaded: number;
  gamesTotal: number;
  fetchedAt: number;
  /** Newest capture across all owners — "lineups as of …". */
  latestCapturedAt: Date | null;
}

/* -------------------------------------------------------------------------- */
/* Inputs                                                                     */
/* -------------------------------------------------------------------------- */

export interface AssembleParticipant {
  ownerSeasonId: number;
  ownerName: string;
  teamKey: string | null;
  logoEspn: string | null;
}

export interface AssembleMatchup {
  id: number;
  home: AssembleParticipant;
  away: AssembleParticipant;
}

export interface AssembleSnapshot {
  ownerSeasonId: number;
  capturedAt: Date;
  slots: LineupSlotInput[];
}

/* -------------------------------------------------------------------------- */

function isDstSlot(slot: LineupSlotInput): boolean {
  const s = (slot.slot ?? '').toUpperCase();
  const p = (slot.position ?? '').toUpperCase();
  return s === 'DST' || p === 'DST';
}

/** Score one captured slot against the stat index. */
function resolveSlot(slot: LineupSlotInput, index: LiveStatIndex): LiveSlot {
  const base = {
    slot: slot.slot,
    name: slot.name,
    teamKey: slot.teamKey,
    position: slot.position,
    dkScore: slot.dkScore,
  };

  // DraftKings hid this player because their game has not kicked off. We know the roster
  // slot and nothing else — which is fine: an unplayed player has scored nothing, so no
  // POINTS are missing, only a name.
  if (!slot.revealed) {
    return { ...base, status: 'concealed', points: null, components: [], gameDetail: null };
  }

  const teamState = slot.teamKey ? index.teamState[slot.teamKey] : undefined;
  const gameDetail = teamState?.detail ?? null;

  // Kickoff hasn't happened. Distinct from 'unresolved': there is nothing to find yet.
  if (teamState?.state === 'pre') {
    return { ...base, status: 'pending', points: null, components: [], gameDetail };
  }

  if (isDstSlot(slot)) {
    const dst = slot.teamKey ? index.defenses[slot.teamKey] : undefined;
    if (!dst) {
      return { ...base, status: 'unresolved', points: null, components: [], gameDetail };
    }
    const scored = scoreDst(dst.line);
    return {
      ...base,
      status: 'scored',
      points: scored.points,
      components: scored.components,
      gameDetail,
    };
  }

  // A revealed player with no name or team cannot be matched to a stat line at all. That is
  // an enrichment failure, and it must show as unresolved rather than quietly score 0.
  if (!slot.name || !slot.teamKey) {
    return { ...base, status: 'unresolved', points: null, components: [], gameDetail };
  }

  const stat = index.players[playerStatKey(slot.name, slot.teamKey)];
  if (!stat) {
    // The player's game has started but ESPN's boxscore has no line for them. Genuinely
    // ambiguous — a healthy scratch and a name-match failure look identical here — so we
    // refuse to guess and let the UI say so.
    return { ...base, status: 'unresolved', points: null, components: [], gameDetail };
  }

  const scored = scorePlayer(stat.line);
  return {
    ...base,
    status: 'scored',
    points: scored.points,
    components: scored.components,
    gameDetail,
  };
}

function buildTeam(
  participant: AssembleParticipant,
  snapshot: AssembleSnapshot | undefined,
  index: LiveStatIndex,
): LiveTeam {
  const empty: LiveTeam = {
    ...participant,
    points: 0,
    slots: [],
    scored: 0,
    pending: 0,
    concealed: 0,
    unresolved: 0,
    capturedAt: null,
    hasSnapshot: false,
  };
  if (!snapshot) return empty;

  const slots = snapshot.slots.map((s) => resolveSlot(s, index));
  const counts = { scored: 0, pending: 0, concealed: 0, unresolved: 0 };
  let total = 0;
  for (const s of slots) {
    counts[s.status] += 1;
    if (s.status === 'scored' && s.points !== null) total += s.points;
  }

  return {
    ...participant,
    // Round once, at the boundary — matching formatPoints and the scoring engine's rule of
    // never rounding intermediate values.
    points: Math.round(total * 100) / 100,
    slots,
    ...counts,
    capturedAt: snapshot.capturedAt,
    hasSnapshot: true,
  };
}

/**
 * Assemble the live view.
 *
 * @param snapshots The roster IN EFFECT per owner — i.e. the newest capture. Late swap makes
 *                  captures append-only, so passing an older one silently scores the wrong
 *                  players; the caller resolves "newest" (see live/query.ts).
 */
export function assembleLive(
  matchups: AssembleMatchup[],
  snapshots: AssembleSnapshot[],
  index: LiveStatIndex,
): LiveView {
  const byOwner = new Map<number, AssembleSnapshot>();
  for (const s of snapshots) {
    const existing = byOwner.get(s.ownerSeasonId);
    if (!existing || s.capturedAt > existing.capturedAt) byOwner.set(s.ownerSeasonId, s);
  }

  const missingCaptures: string[] = [];
  const out: LiveMatchup[] = matchups.map((m) => {
    const home = buildTeam(m.home, byOwner.get(m.home.ownerSeasonId), index);
    const away = buildTeam(m.away, byOwner.get(m.away.ownerSeasonId), index);
    if (!home.hasSnapshot) missingCaptures.push(home.ownerName);
    if (!away.hasSnapshot) missingCaptures.push(away.ownerName);
    return { id: m.id, home, away };
  });

  let latest: Date | null = null;
  for (const s of byOwner.values()) {
    if (!latest || s.capturedAt > latest) latest = s.capturedAt;
  }

  return {
    matchups: out,
    missingCaptures,
    gamesLoaded: index.gamesLoaded,
    gamesTotal: index.gamesTotal,
    fetchedAt: index.fetchedAt,
    latestCapturedAt: latest,
  };
}
