/**
 * Unit tests for the pure lineup recommendation engine. These pin the behaviors the UI
 * relies on: positional ranking, bye/injury gating, risk re-weighting, the greedy DK
 * lineup fill, and fade selection.
 */
import { describe, it, expect } from 'vitest';

import {
  assignPositionalRanks,
  isInactiveTag,
  isQuestionableTag,
  recommend,
  scorePlayer,
  type RecommendContext,
} from './recommend';
import type { FantasyPosition, SleeperPlayer } from './sleeper';

let idc = 0;
function player(p: Partial<SleeperPlayer> & { position: FantasyPosition; teamKey: string }): SleeperPlayer {
  idc += 1;
  return {
    id: p.id ?? `p${idc}`,
    name: p.name ?? `Player ${idc}`,
    position: p.position,
    teamKey: p.teamKey,
    injuryStatus: p.injuryStatus ?? null,
    injuryNote: p.injuryNote ?? null,
    depthOrder: p.depthOrder ?? null,
    searchRank: p.searchRank ?? 100,
    yearsExp: p.yearsExp ?? 5,
    age: p.age ?? 26,
  };
}

function ctx(over: Partial<RecommendContext> = {}): RecommendContext {
  return {
    matchups: over.matchups ?? new Map(),
    trendingAdd: over.trendingAdd ?? new Map(),
    trendingDrop: over.trendingDrop ?? new Map(),
  };
}

describe('injury tag helpers', () => {
  it('classifies inactive vs questionable tags case-insensitively', () => {
    expect(isInactiveTag('Out')).toBe(true);
    expect(isInactiveTag('IR')).toBe(true);
    expect(isInactiveTag('doubtful')).toBe(true);
    expect(isInactiveTag('Questionable')).toBe(false);
    expect(isInactiveTag(null)).toBe(false);
    expect(isQuestionableTag('Questionable')).toBe(true);
    expect(isQuestionableTag('GTD')).toBe(true);
    expect(isQuestionableTag('Out')).toBe(false);
  });
});

describe('assignPositionalRanks', () => {
  it('ranks by search rank within each position independently', () => {
    const a = player({ position: 'WR', teamKey: 'BUF', searchRank: 30 });
    const b = player({ position: 'WR', teamKey: 'KC', searchRank: 10 });
    const qb = player({ position: 'QB', teamKey: 'BUF', searchRank: 99 });
    const ranks = assignPositionalRanks([a, b, qb]);
    expect(ranks.get(b.id)).toBe(1);
    expect(ranks.get(a.id)).toBe(2);
    expect(ranks.get(qb.id)).toBe(1); // ranked within QB, not globally
  });
});

describe('scorePlayer risk weighting', () => {
  const c = ctx({
    matchups: new Map([['BUF', { opponentKey: 'NYJ', isHome: true }]]),
    trendingAdd: new Map([['buzz', 20000]]),
  });

  it('penalizes a questionable tag less under boom than under safe', () => {
    const healthy = player({ id: 'h', position: 'RB', teamKey: 'BUF', searchRank: 5, depthOrder: 1 });
    const quest = player({ id: 'q', position: 'RB', teamKey: 'BUF', injuryStatus: 'Questionable', searchRank: 5, depthOrder: 1 });
    const safePenalty = scorePlayer(healthy, 2, c, 'safe').fit - scorePlayer(quest, 2, c, 'safe').fit;
    const boomPenalty = scorePlayer(healthy, 2, c, 'boom').fit - scorePlayer(quest, 2, c, 'boom').fit;
    expect(boomPenalty).toBeLessThan(safePenalty);
  });

  it('a heavily-added waiver backup scores higher under boom than safe', () => {
    const buzz = player({ id: 'buzz', position: 'RB', teamKey: 'BUF', depthOrder: 2, yearsExp: 1, searchRank: 120 });
    const safe = scorePlayer(buzz, 40, c, 'safe').fit;
    const boom = scorePlayer(buzz, 40, c, 'boom').fit;
    expect(boom).toBeGreaterThan(safe);
  });

  it('emits a positional-rank reason and a matchup reason', () => {
    const p = player({ position: 'WR', teamKey: 'BUF', searchRank: 8 });
    const { reasons } = scorePlayer(p, 4, c, 'balanced');
    expect(reasons.some((r) => r.label === 'WR4')).toBe(true);
    expect(reasons.some((r) => r.label === 'vs NYJ')).toBe(true);
  });
});

describe('recommend', () => {
  function pool(): SleeperPlayer[] {
    return [
      player({ id: 'qb1', name: 'QB One', position: 'QB', teamKey: 'BUF', searchRank: 5, depthOrder: 1 }),
      player({ id: 'qbBye', name: 'QB Bye', position: 'QB', teamKey: 'KC', searchRank: 2, depthOrder: 1 }),
      player({ id: 'rb1', position: 'RB', teamKey: 'BUF', searchRank: 8, depthOrder: 1 }),
      player({ id: 'rb2', position: 'RB', teamKey: 'NYJ', searchRank: 12, depthOrder: 1 }),
      player({ id: 'rbOut', name: 'RB Hurt', position: 'RB', teamKey: 'BUF', searchRank: 6, depthOrder: 1, injuryStatus: 'Out' }),
      player({ id: 'wr1', position: 'WR', teamKey: 'BUF', searchRank: 9, depthOrder: 1 }),
      player({ id: 'wr2', position: 'WR', teamKey: 'NYJ', searchRank: 14, depthOrder: 1 }),
      player({ id: 'wr3', position: 'WR', teamKey: 'NYJ', searchRank: 20, depthOrder: 2 }),
      player({ id: 'wr4', position: 'WR', teamKey: 'BUF', searchRank: 26, depthOrder: 2 }),
      player({ id: 'rb3', position: 'RB', teamKey: 'NYJ', searchRank: 40, depthOrder: 2 }),
      player({ id: 'te1', position: 'TE', teamKey: 'BUF', searchRank: 11, depthOrder: 1 }),
      player({ id: 'dst1', position: 'DST', teamKey: 'BUF', searchRank: 300 }),
    ];
  }

  // BUF & NYJ play (home/away); KC is on bye (absent from the map).
  const c = ctx({
    matchups: new Map([
      ['BUF', { opponentKey: 'NYJ', isHome: true }],
      ['NYJ', { opponentKey: 'BUF', isHome: false }],
    ]),
  });

  it('excludes bye-week and injured-out players from targets', () => {
    const { targetsByPosition } = recommend(pool(), c, 'balanced');
    const qbIds = targetsByPosition.QB.map((r) => r.player.id);
    expect(qbIds).toContain('qb1');
    expect(qbIds).not.toContain('qbBye'); // on bye
    const rbIds = targetsByPosition.RB.map((r) => r.player.id);
    expect(rbIds).not.toContain('rbOut'); // injured out
  });

  it('fills a full DK Classic lineup with no duplicate players', () => {
    const { suggestedLineup } = recommend(pool(), c, 'balanced');
    expect(suggestedLineup.map((s) => s.slot)).toEqual([
      'QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'DST',
    ]);
    const picked = suggestedLineup.map((s) => s.pick?.player.id).filter(Boolean);
    expect(new Set(picked).size).toBe(picked.length); // no duplicates
    // FLEX must be an RB/WR/TE.
    const flex = suggestedLineup.find((s) => s.slot === 'FLEX')?.pick;
    expect(['RB', 'WR', 'TE']).toContain(flex?.player.position);
  });

  it('lists an injured star and a bye-week star as fades', () => {
    const { fades } = recommend(pool(), c, 'balanced');
    const ids = fades.map((f) => f.player.id);
    expect(ids).toContain('rbOut'); // Out
    expect(ids).toContain('qbBye'); // on bye
  });

  it('flags a heavily-dropped player as a fade', () => {
    const withDrop = ctx({
      matchups: c.matchups,
      trendingDrop: new Map([['wr1', 9000]]),
    });
    const { fades } = recommend(pool(), withDrop, 'balanced');
    expect(fades.map((f) => f.player.id)).toContain('wr1');
  });
});
