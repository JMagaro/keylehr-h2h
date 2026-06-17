/**
 * Tests for DK↔Sleeper salary matching: name normalization (accents, suffixes,
 * punctuation), team+position keying, the DST-by-team rule, and the team-agnostic fallback.
 */
import { describe, it, expect } from 'vitest';

import { matchSalaries, normalizeName } from './match';
import type { DkDraftable } from './draftables';
import type { FantasyPosition, SleeperPlayer } from '@/lib/players/sleeper';

function sleeper(p: Partial<SleeperPlayer> & { id: string; name: string; position: FantasyPosition; teamKey: string }): SleeperPlayer {
  return {
    id: p.id,
    name: p.name,
    position: p.position,
    teamKey: p.teamKey,
    injuryStatus: p.injuryStatus ?? null,
    injuryNote: null,
    depthOrder: p.depthOrder ?? 1,
    searchRank: p.searchRank ?? 50,
    yearsExp: 4,
    age: 26,
  };
}

function dk(name: string, position: string, teamKey: string, salary: number, id: string): DkDraftable {
  return { dkPlayerId: id, name, firstName: null, lastName: null, teamKey, position, salary, status: null };
}

describe('normalizeName', () => {
  it('strips accents, suffixes, and punctuation', () => {
    expect(normalizeName("Ja'Marr Chase")).toBe('jamarr chase');
    expect(normalizeName('Michael Pittman Jr.')).toBe('michael pittman');
    expect(normalizeName('D.K. Metcalf')).toBe('dk metcalf');
    expect(normalizeName('Amon-Ra St. Brown')).toBe('amon ra st brown');
  });
});

describe('matchSalaries', () => {
  it('matches by name + team + position', () => {
    const players = [
      sleeper({ id: 's1', name: "Ja'Marr Chase", position: 'WR', teamKey: 'CIN' }),
      sleeper({ id: 's2', name: 'Josh Allen', position: 'QB', teamKey: 'BUF' }),
    ];
    const draftables = [
      dk('JaMarr Chase', 'WR', 'CIN', 7200, 'd1'),
      dk('Josh Allen', 'QB', 'BUF', 8000, 'd2'),
    ];
    const m = matchSalaries(players, draftables);
    expect(m.matched).toBe(2);
    expect(m.salaryBySleeperId.get('s1')).toBe(7200);
    expect(m.salaryBySleeperId.get('s2')).toBe(8000);
    expect(m.dkIdBySleeperId.get('s1')).toBe('d1');
  });

  it('matches a DST by team + position regardless of name', () => {
    const players = [sleeper({ id: 'BUF', name: 'Bills DST', position: 'DST', teamKey: 'BUF' })];
    const draftables = [dk('Buffalo Bills ', 'DST', 'BUF', 3500, 'dd')];
    const m = matchSalaries(players, draftables);
    expect(m.salaryBySleeperId.get('BUF')).toBe(3500);
  });

  it('falls back to name+position when the team differs (recent move)', () => {
    const players = [sleeper({ id: 's1', name: 'Davante Adams', position: 'WR', teamKey: 'NYJ' })];
    const draftables = [dk('Davante Adams', 'WR', 'LAR', 7000, 'd9')]; // DK has him on a different team
    const m = matchSalaries(players, draftables);
    expect(m.salaryBySleeperId.get('s1')).toBe(7000);
  });

  it('reports total candidates and leaves unmatched players out', () => {
    const players = [
      sleeper({ id: 's1', name: 'Real Guy', position: 'WR', teamKey: 'KC' }),
      sleeper({ id: 's2', name: 'Nobody Here', position: 'RB', teamKey: 'KC' }),
    ];
    const draftables = [dk('Real Guy', 'WR', 'KC', 5000, 'd1')];
    const m = matchSalaries(players, draftables);
    expect(m.total).toBe(2);
    expect(m.matched).toBe(1);
    expect(m.salaryBySleeperId.has('s2')).toBe(false);
  });
});
