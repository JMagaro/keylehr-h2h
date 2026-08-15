import { describe, it, expect } from 'vitest';

import { assessCaptureStaleness, countConcealedSlots } from './staleness';

const CAPTURE = new Date('2026-09-13T17:05:00Z'); // ~1:05pm ET, just after the early lock

const early = { state: 'in', teamKeys: ['BUF', 'MIA'] };
const late = { state: 'in', teamKeys: ['SF', 'SEA'] };
const notStarted = { state: 'pre', teamKeys: ['DAL', 'PHI'] };

const KICKOFFS = {
  BUF: new Date('2026-09-13T17:00:00Z'), // before the capture
  MIA: new Date('2026-09-13T17:00:00Z'),
  SF: new Date('2026-09-13T20:25:00Z'), // after the capture
  SEA: new Date('2026-09-13T20:25:00Z'),
  DAL: new Date('2026-09-14T00:20:00Z'),
  PHI: new Date('2026-09-14T00:20:00Z'),
};

describe('assessCaptureStaleness', () => {
  it('does not nag right after a capture, when only pre-capture games have started', () => {
    // 1:05pm: the early games kicked off BEFORE the capture, so their players were already
    // revealed. The concealed ones belong to games still to come — nothing to re-capture yet.
    const r = assessCaptureStaleness({
      games: [early, notStarted],
      kickoffByTeam: KICKOFFS,
      capturedAt: CAPTURE,
      concealedSlots: 30,
    });
    expect(r.shouldRecapture).toBe(false);
    expect(r.gamesStartedSinceCapture).toBe(0);
  });

  it('flags a capture once a game that kicked off AFTER it has started', () => {
    // 4:30pm: the late slate is underway, so DraftKings would now name those players. The only
    // reason they are still missing is that nobody re-captured — and they are scoring points
    // the estimate does not include.
    const r = assessCaptureStaleness({
      games: [early, late],
      kickoffByTeam: KICKOFFS,
      capturedAt: CAPTURE,
      concealedSlots: 30,
    });
    expect(r.shouldRecapture).toBe(true);
    expect(r.gamesStartedSinceCapture).toBe(1);
  });

  it('says nothing when every slot is already revealed', () => {
    const r = assessCaptureStaleness({
      games: [early, late],
      kickoffByTeam: KICKOFFS,
      capturedAt: CAPTURE,
      concealedSlots: 0,
    });
    expect(r.shouldRecapture).toBe(false);
  });

  it('says nothing when there is no capture at all', () => {
    // "Not captured" is a different problem with its own message; don't double up on it.
    const r = assessCaptureStaleness({
      games: [late],
      kickoffByTeam: KICKOFFS,
      capturedAt: null,
      concealedSlots: 9,
    });
    expect(r.shouldRecapture).toBe(false);
  });

  it('ignores games that have not kicked off, however late they are', () => {
    const r = assessCaptureStaleness({
      games: [notStarted],
      kickoffByTeam: KICKOFFS,
      capturedAt: CAPTURE,
      concealedSlots: 9,
    });
    expect(r.shouldRecapture).toBe(false);
  });

  it('tolerates a game whose kickoff is unknown', () => {
    const r = assessCaptureStaleness({
      games: [{ state: 'in', teamKeys: ['XXX'] }],
      kickoffByTeam: {},
      capturedAt: CAPTURE,
      concealedSlots: 9,
    });
    expect(r.shouldRecapture).toBe(false);
  });
});

describe('countConcealedSlots', () => {
  it('sums both sides of every matchup', () => {
    expect(
      countConcealedSlots([
        { home: { concealed: 6 }, away: { concealed: 3 } },
        { home: { concealed: 0 }, away: { concealed: 9 } },
      ]),
    ).toBe(18);
  });

  it('is zero for an empty week', () => {
    expect(countConcealedSlots([])).toBe(0);
  });
});
