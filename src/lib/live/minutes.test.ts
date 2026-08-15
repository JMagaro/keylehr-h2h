import { describe, it, expect } from 'vitest';

import type { LiveSlot } from './assemble';
import { lineupMinutes, minutesLeftInGame, parseClockMinutes } from './minutes';

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
  ...over,
});

describe('parseClockMinutes', () => {
  it('reads a game clock', () => {
    expect(parseClockMinutes('8:30')).toBeCloseTo(8.5, 5);
    expect(parseClockMinutes('0:01')).toBeCloseTo(1 / 60, 5);
    expect(parseClockMinutes('15:00')).toBe(15);
  });

  it('returns null for anything unparseable', () => {
    for (const v of [null, undefined, '', 'Final', 'Halftime', '--']) {
      expect(parseClockMinutes(v)).toBeNull();
    }
  });
});

describe('minutesLeftInGame', () => {
  it('gives a full game before kickoff', () => {
    expect(minutesLeftInGame({ state: 'pre' })).toBe(60);
  });

  it('gives zero for a finished game', () => {
    expect(minutesLeftInGame({ state: 'post', period: 4, displayClock: '0:00' })).toBe(0);
  });

  it('counts down through the quarters', () => {
    // 8:30 left in the 3rd = one full quarter after this one, plus 8.5.
    expect(minutesLeftInGame({ state: 'in', period: 3, displayClock: '8:30' })).toBeCloseTo(23.5, 5);
    expect(minutesLeftInGame({ state: 'in', period: 1, displayClock: '15:00' })).toBe(60);
    expect(minutesLeftInGame({ state: 'in', period: 4, displayClock: '2:00' })).toBe(2);
  });

  it('treats halftime as the second quarter being over', () => {
    // ESPN drops the clock between quarters; 30 minutes remain, which matches the
    // DraftKings value observed for a player at halftime.
    expect(minutesLeftInGame({ state: 'in', period: 2, displayClock: null })).toBe(30);
  });

  it('clamps overtime to zero rather than going negative', () => {
    // Overtime is football beyond the 60 this metric is denominated in. A negative would make
    // a lineup total actively misleading.
    expect(minutesLeftInGame({ state: 'in', period: 5, displayClock: '4:00' })).toBe(0);
  });

  it('falls back to a full game when in progress with no period yet', () => {
    expect(minutesLeftInGame({ state: 'in' })).toBe(60);
  });
});

describe('lineupMinutes', () => {
  const clocks = {
    LAR: { state: 'in' as const, period: 3, displayClock: '8:30' }, // 23.5
    KC: { state: 'post' as const, period: 4, displayClock: '0:00' }, // 0
    SEA: { state: 'pre' as const }, // 60
  };

  it('sums across a lineup and reports the maximum', () => {
    const m = lineupMinutes(
      [slot({ teamKey: 'LAR' }), slot({ teamKey: 'KC' }), slot({ teamKey: 'SEA' })],
      clocks,
    );
    expect(m.minutesLeft).toBe(84); // 23.5 + 0 + 60, rounded
    expect(m.maxMinutes).toBe(180);
    expect(m.slotsWithTimeLeft).toBe(2);
    expect(m.unknownSlots).toBe(0);
  });

  it('counts a CONCEALED slot as a full game', () => {
    // DraftKings conceals a player exactly until their game kicks off, so at capture time a
    // concealed player had a whole game ahead of them. That inference is only as fresh as the
    // capture — staleness is flagged separately.
    const m = lineupMinutes(
      [slot({ teamKey: null, name: null, status: 'concealed', points: null })],
      clocks,
    );
    expect(m.minutesLeft).toBe(60);
    expect(m.unknownSlots).toBe(0);
  });

  it('does not guess for an unresolved slot', () => {
    const m = lineupMinutes(
      [slot({ teamKey: 'MIA', status: 'unresolved', points: null })],
      clocks,
    );
    expect(m.minutesLeft).toBe(0);
    expect(m.unknownSlots).toBe(1);
  });

  it('gives a full 540 for an untouched nine-man lineup', () => {
    // Matches DraftKings' own maxTimeRemaining of 540, which is what confirms the model:
    // nine roster slots times sixty minutes of regulation.
    const nine = Array.from({ length: 9 }, () => slot({ teamKey: 'SEA' }));
    const m = lineupMinutes(nine, clocks);
    expect(m.minutesLeft).toBe(540);
    expect(m.maxMinutes).toBe(540);
  });
});
