/**
 * Tests for projections and win probability.
 *
 * The first block is the important one: it pins our formula to DraftKings' OWN published
 * numbers from real captures. If DK ever changes how it projects, these fail.
 */
import { describe, it, expect } from 'vitest';

import type { LiveSlot, LiveTeam } from './assemble';
import type { GameClock } from './minutes';
import { formatWinProbability, projectLineup, projectSlot, winProbability } from './projection';

const slot = (over: Partial<LiveSlot> = {}): LiveSlot => ({
  slot: 'WR',
  name: 'Someone',
  teamKey: 'LAR',
  position: 'WR',
  status: 'scored',
  points: 0,
  components: [],
  gameDetail: null,
  dkScore: null,
  dkStats: null,
  dkProjection: null,
  ...over,
});

const team = (slots: LiveSlot[], points: number): LiveTeam => ({
  ownerSeasonId: 1,
  ownerName: 'owner',
  teamKey: 'LAR',
  logoEspn: null,
  points,
  slots,
  scored: slots.length,
  pending: 0,
  concealed: 0,
  noStats: 0,
  unresolved: 0,
  capturedAt: new Date('2026-08-15T20:00:00Z'),
  hasSnapshot: true,
});

describe('projectSlot — matches DraftKings exactly', () => {
  // DK gives both `pregameProjection` and `realTimeProjection`. These three captures pin the
  // relationship between them: projected = score + pregame × (minutesLeft / 60).
  const PREGAME = 14.666666666666666;

  it('reproduces DK’s realTimeProjection at 34.35 minutes left', () => {
    // Austin Trammell, JAX @ NO, 3:44 in the 2nd. DK said 9.896666666666667.
    const clock: GameClock = { state: 'in', period: 2, displayClock: '4:21' };
    const p = projectSlot(slot({ points: 1.5, dkProjection: PREGAME }), clock);
    // 1.5 + 14.6667 × (34.35/60) = 9.8967. Our clock reading differs from DK's by seconds, so
    // compare to one decimal rather than pretending to match their exact tick.
    expect(p!).toBeCloseTo(9.9, 1);
  });

  it('reproduces DK’s realTimeProjection at halftime', () => {
    // Same player later: 3.80 banked, 30 minutes left. DK said 11.133333333333333.
    const clock: GameClock = { state: 'in', period: 2, displayClock: null };
    const p = projectSlot(slot({ points: 3.8, dkProjection: PREGAME }), clock);
    expect(p!).toBeCloseTo(11.133333333333333, 9);
  });

  it('reproduces DK’s realTimeProjection before a player has played', () => {
    // Mario Williams, nothing banked, a full game ahead. DK said 14.666666666666666.
    const p = projectSlot(slot({ points: 0, dkProjection: PREGAME }), { state: 'pre' });
    expect(p!).toBeCloseTo(14.666666666666666, 9);
  });

  it('is just the banked score once the game is over', () => {
    const clock: GameClock = { state: 'post', period: 4, displayClock: '0:00' };
    expect(projectSlot(slot({ points: 12.4, dkProjection: PREGAME }), clock)).toBeCloseTo(12.4, 9);
  });

  it('reports the banked score, and projects nothing, with no pregame projection', () => {
    // Never invent a projection we were not given — an older capture has none.
    expect(projectSlot(slot({ points: 7, dkProjection: null }), { state: 'pre' })).toBe(7);
  });
});

describe('projectLineup', () => {
  const clocks: Record<string, GameClock> = {
    LAR: { state: 'post', period: 4, displayClock: '0:00' },
    SEA: { state: 'pre' },
  };

  it('adds each slot’s expected remainder to what is banked', () => {
    const t = team(
      [
        slot({ teamKey: 'LAR', points: 20, dkProjection: 15 }), // done: 20
        slot({ teamKey: 'SEA', points: 0, dkProjection: 12 }), // full game: 12
      ],
      20,
    );
    const p = projectLineup(t, clocks);
    expect(p.current).toBe(20);
    expect(p.projected).toBe(32);
    expect(p.isFinal).toBe(false);
  });

  it('treats a concealed slot as a full game ahead', () => {
    // It has no projection (no identity yet), so it cannot add expected points — but it must
    // still register as time remaining, or a barely-started lineup reads as finished.
    const t = team([slot({ teamKey: null, status: 'concealed', points: null })], 0);
    const p = projectLineup(t, clocks);
    expect(p.isFinal).toBe(false);
    expect(p.unprojectedSlots).toBe(1);
  });

  it('marks a lineup final when no game time remains', () => {
    const t = team([slot({ teamKey: 'LAR', points: 20, dkProjection: 15 })], 20);
    const p = projectLineup(t, clocks);
    expect(p.isFinal).toBe(true);
    expect(p.projected).toBe(20);
  });
});

describe('winProbability', () => {
  it('is a coin flip on a level projection with everything to play for', () => {
    expect(winProbability(100, 100, 1080).home).toBeCloseTo(0.5, 6);
  });

  it('grows more confident as the same lead survives fewer minutes', () => {
    const early = winProbability(120, 100, 1080).home;
    const late = winProbability(120, 100, 60).home;
    expect(early).toBeGreaterThan(0.5);
    expect(late).toBeGreaterThan(early);
  });

  it('settles once no time remains', () => {
    expect(winProbability(120, 100, 0)).toEqual({ home: 1, settled: true });
    expect(winProbability(100, 120, 0)).toEqual({ home: 0, settled: true });
  });

  it('is symmetric', () => {
    const a = winProbability(115, 100, 540).home;
    const b = winProbability(100, 115, 540).home;
    expect(a + b).toBeCloseTo(1, 6);
  });
});

describe('formatWinProbability', () => {
  it('never shows a certainty while games are still running', () => {
    // A 99.9% favourite has still lost before. Showing "100%" mid-game would be a lie the
    // page cannot back up.
    expect(formatWinProbability(0.9999, false)).toBe('99%');
    expect(formatWinProbability(0.0001, false)).toBe('1%');
  });

  it('states the result once settled', () => {
    expect(formatWinProbability(1, true)).toBe('Won');
    expect(formatWinProbability(0, true)).toBe('Lost');
  });
});

describe('regression: a snapshot written before dkProjection existed', () => {
  // `slots` is jsonb, so the field needed no migration — and every row written before it has
  // no such key at all. `undefined` slips past an `=== null` guard and turns the arithmetic
  // into NaN, which then propagates to the team total, renders as "NaN%", and poisons a sort
  // comparator. This is the shape that actually sat in the database.
  const legacySlot = {
    slot: 'WR',
    name: 'Old Capture',
    teamKey: 'LAR',
    position: 'WR',
    status: 'scored',
    points: 12.3,
    components: [],
    gameDetail: null,
    dkScore: null,
    dkStats: null,
    // dkProjection deliberately ABSENT
  } as unknown as LiveSlot;

  it('projects a real number, never NaN', () => {
    const p = projectSlot(legacySlot, { state: 'in', period: 3, displayClock: '8:30' });
    expect(p).toBe(12.3);
    expect(Number.isNaN(p)).toBe(false);
  });

  it('keeps a lineup total finite', () => {
    const t = team([legacySlot], 12.3);
    const p = projectLineup(t, { LAR: { state: 'in', period: 3, displayClock: '8:30' } });
    expect(Number.isFinite(p.projected)).toBe(true);
    expect(p.projected).toBe(12.3);
  });

  it('keeps win probability finite, so the closeness sort still orders', () => {
    const t = team([legacySlot], 12.3);
    const p = projectLineup(t, { LAR: { state: 'in', period: 3, displayClock: '8:30' } });
    const odds = winProbability(p.projected, 10, 200);
    expect(Number.isNaN(odds.home)).toBe(false);
  });
});
