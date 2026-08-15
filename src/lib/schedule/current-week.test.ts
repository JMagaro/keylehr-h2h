/**
 * Tests for week detection.
 *
 * The stakes: `scores` upserts on `(ownerSeasonId, week)`, so a wrong week silently overwrites
 * real scores. Getting this right is worth more than it looks.
 */
import { describe, it, expect } from 'vitest';

import { pickWeek } from './current-week';

const g = (week: number, kickoff: string | null, isExhibition = false) => ({
  week,
  kickoff: kickoff ? new Date(kickoff) : null,
  isExhibition,
});

/** A slice of a real NFL season: Thursday opener, Sunday slate, Monday night. */
const SEASON = [
  g(1, '2026-09-10T00:20:00Z'), // Thu
  g(1, '2026-09-13T17:00:00Z'), // Sun early
  g(1, '2026-09-15T00:15:00Z'), // Mon night
  g(2, '2026-09-17T00:15:00Z'),
  g(2, '2026-09-20T17:00:00Z'),
  g(3, '2026-09-24T00:15:00Z'),
  g(3, '2026-09-27T17:00:00Z'),
];

describe('pickWeek', () => {
  it('returns null for a season with no synced games', () => {
    // The caller must treat this as "don't know". Defaulting to week 1 would be a confident
    // wrong answer, which is exactly the failure this replaces.
    expect(pickWeek([], new Date('2026-09-13T18:00:00Z'))).toBeNull();
  });

  it('picks the week in progress on a Sunday afternoon', () => {
    const r = pickWeek(SEASON, new Date('2026-09-13T18:30:00Z'));
    expect(r!.week).toBe(1);
    expect(r!.basis).toBe('in-progress');
  });

  it('stays on the current week through its Monday night game', () => {
    // The week must not flip to the next one the moment Sunday's games end — Monday's game
    // still belongs to it, and that is when a re-sync matters most.
    const r = pickWeek(SEASON, new Date('2026-09-15T01:00:00Z'));
    expect(r!.week).toBe(1);
  });

  it('moves on once the next week starts, even though the old span overlaps', () => {
    // Week 2's Thursday game is inside week 1's 5.5-day span. The LATEST in-progress week
    // wins, otherwise Thursday night would keep reporting the week just gone.
    const r = pickWeek(SEASON, new Date('2026-09-17T01:00:00Z'));
    expect(r!.week).toBe(2);
    expect(r!.basis).toBe('in-progress');
  });

  it('names the next week during the midweek gap', () => {
    const r = pickWeek(SEASON, new Date('2026-09-16T12:00:00Z'));
    expect(r!.week).toBe(2);
    expect(r!.basis).toBe('upcoming');
  });

  it('names the first week before the season starts', () => {
    const r = pickWeek(SEASON, new Date('2026-08-01T12:00:00Z'));
    expect(r!.week).toBe(1);
    expect(r!.basis).toBe('upcoming');
  });

  it('falls back to the last week once the season is over', () => {
    const r = pickWeek(SEASON, new Date('2026-12-31T12:00:00Z'));
    expect(r!.week).toBe(3);
    expect(r!.basis).toBe('last');
  });

  it('reports the date range and game count, so a human can confirm the week', () => {
    const r = pickWeek(SEASON, new Date('2026-09-13T18:30:00Z'));
    expect(r!.firstKickoff).toEqual(new Date('2026-09-10T00:20:00Z'));
    expect(r!.lastKickoff).toEqual(new Date('2026-09-15T00:15:00Z'));
    expect(r!.gameCount).toBe(3);
  });

  it('detects an exhibition week and flags it', () => {
    // This is the bit that was never detected at all: the preseason toggle just remembered
    // its last state, which put a capture in week 102 while the scores went to 103.
    const preseason = [g(102, '2026-08-15T20:00:00Z', true), g(102, '2026-08-16T00:00:00Z', true)];
    const r = pickWeek(preseason, new Date('2026-08-15T22:00:00Z'));
    expect(r!.week).toBe(102);
    expect(r!.isExhibition).toBe(true);
  });

  it('prefers a live regular week over an earlier exhibition one', () => {
    const mixed = [...SEASON, g(102, '2026-08-15T20:00:00Z', true)];
    const r = pickWeek(mixed, new Date('2026-09-13T18:30:00Z'));
    expect(r!.week).toBe(1);
    expect(r!.isExhibition).toBe(false);
  });

  it('tolerates a schedule with no kickoff times yet', () => {
    const r = pickWeek([g(1, null), g(2, null)], new Date('2026-09-13T18:30:00Z'));
    expect(r!.week).toBe(2);
    expect(r!.basis).toBe('last');
  });
});
