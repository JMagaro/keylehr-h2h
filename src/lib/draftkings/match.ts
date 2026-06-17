/**
 * Match DraftKings draftables to Sleeper players so the builder can attach a salary to
 * each player it scores. Pure + unit-tested.
 *
 * DK and Sleeper are independent player universes with no shared id, so we match on
 * normalized (name + team + position). Defenses (DST) are matched on team + position only
 * (DK's defense display name is unreliable). A team-agnostic name+position fallback covers
 * players whose team differs between the two sources (recent moves).
 */
import type { DkDraftable } from './draftables';
import type { FantasyPosition, SleeperPlayer } from '@/lib/players/sleeper';

/** Lowercase, strip accents, drop generational suffixes + punctuation, collapse spaces. */
export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics
    .toLowerCase()
    .replace(/[.'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** DK position → our fantasy position bucket (DEF/D/DST all collapse to DST). */
function dkPosition(pos: string): FantasyPosition | null {
  const p = pos.toUpperCase();
  if (p === 'DST' || p === 'DEF' || p === 'D') return 'DST';
  if (p === 'QB' || p === 'RB' || p === 'WR' || p === 'TE' || p === 'K') return p as FantasyPosition;
  return null;
}

export interface SalaryMatch {
  /** sleeper player id → salary. */
  salaryBySleeperId: Map<string, number>;
  /** sleeper player id → DK player id (for links/debugging). */
  dkIdBySleeperId: Map<string, string>;
  matched: number;
  /** Sleeper players that had a salary candidate position but didn't match. */
  total: number;
}

/**
 * Build the salary lookup for a set of Sleeper players from a slate's draftables.
 *
 * `total` counts the Sleeper players eligible to be matched (a DST or a QB/RB/WR/TE/K with
 * a known team) so callers can report a match rate.
 */
export function matchSalaries(
  sleeperPlayers: SleeperPlayer[],
  draftables: DkDraftable[],
): SalaryMatch {
  // Index DK draftables.
  const byNameTeamPos = new Map<string, DkDraftable>();
  const byNamePos = new Map<string, DkDraftable>();
  const dstByTeam = new Map<string, DkDraftable>();

  for (const d of draftables) {
    const pos = dkPosition(d.position);
    if (!pos) continue;
    if (pos === 'DST') {
      dstByTeam.set(d.teamKey, d);
      continue;
    }
    const n = normalizeName(d.name);
    if (!n) continue;
    byNameTeamPos.set(`${n}|${d.teamKey}|${pos}`, d);
    // First writer wins for the looser key (DK lists by salary desc, so the pricier /
    // more prominent player is kept on a name collision).
    const npKey = `${n}|${pos}`;
    if (!byNamePos.has(npKey)) byNamePos.set(npKey, d);
  }

  const salaryBySleeperId = new Map<string, number>();
  const dkIdBySleeperId = new Map<string, string>();
  let matched = 0;
  let total = 0;

  for (const p of sleeperPlayers) {
    if (p.position === 'DST') {
      total += 1;
      const d = dstByTeam.get(p.teamKey);
      if (d) {
        salaryBySleeperId.set(p.id, d.salary);
        dkIdBySleeperId.set(p.id, d.dkPlayerId);
        matched += 1;
      }
      continue;
    }
    total += 1;
    const n = normalizeName(p.name);
    const d =
      byNameTeamPos.get(`${n}|${p.teamKey}|${p.position}`) ?? byNamePos.get(`${n}|${p.position}`);
    if (d) {
      salaryBySleeperId.set(p.id, d.salary);
      dkIdBySleeperId.set(p.id, d.dkPlayerId);
      matched += 1;
    }
  }

  return { salaryBySleeperId, dkIdBySleeperId, matched, total };
}
