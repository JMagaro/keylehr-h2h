/**
 * The roster summary line — specifically, that a HIDDEN pick is never described as one that
 * has yet to play.
 *
 * This is a regression test with a real number behind it. In 2026 week 2 the only capture was
 * taken at 1:08pm, so DraftKings was still concealing the entire late slate. The matchup page
 * read "7 playing · 2 to play" and showed 56.02 while DraftKings showed 78.42 — and the two
 * "to play" players were CeeDee Lamb (19.90) and a Washington back (2.50), 22.40 between them,
 * both of whom were on the field at the time. The scoring was exact; the label was a lie.
 */
import { describe, it, expect } from 'vitest';

import type { LiveTeam } from '@/lib/live/assemble';

import { isFloorTotal, rosterSummaryParts } from './roster-summary';

function team(over: Partial<LiveTeam> = {}): LiveTeam {
  return {
    ownerSeasonId: 1,
    ownerName: 'Jared Magaro',
    teamKey: 'BAL',
    logoEspn: null,
    points: 56.02,
    slots: [],
    scored: 7,
    pending: 0,
    concealed: 0,
    noStats: 0,
    unresolved: 0,
    played: 0,
    capturedAt: new Date('2026-09-20T17:08:40Z'),
    hasSnapshot: true,
    ...over,
  };
}

describe('rosterSummaryParts', () => {
  it('reports hidden picks as unknown, never as "to play" — the week-2 line', () => {
    const parts = rosterSummaryParts(team({ scored: 7, concealed: 2 }));
    expect(parts).toEqual(['7 playing', '2 unknown']);
    expect(parts.join(' · ')).not.toContain('to play');
  });

  it('still says "to play" for a player whose game has not kicked off', () => {
    expect(rosterSummaryParts(team({ scored: 6, pending: 3 }))).toEqual([
      '6 playing',
      '3 to play',
    ]);
  });

  it('keeps the two apart when a roster has both', () => {
    expect(rosterSummaryParts(team({ scored: 5, pending: 2, concealed: 2 }))).toEqual([
      '5 playing',
      '2 to play',
      '2 unknown',
    ]);
  });

  it('counts a player with no stats yet as playing — they are worth a real 0', () => {
    expect(rosterSummaryParts(team({ scored: 6, noStats: 3 }))).toEqual(['9 playing']);
  });

  it('surfaces a failed match separately from a hidden one', () => {
    expect(rosterSummaryParts(team({ scored: 7, concealed: 1, unresolved: 1 }))).toEqual([
      '7 playing',
      '1 unknown',
      '1 unresolved',
    ]);
  });

  it('omits every clause that is zero', () => {
    expect(rosterSummaryParts(team({ scored: 9 }))).toEqual(['9 playing']);
  });

  it('says "played" instead of "playing" once every counted slot is final', () => {
    expect(rosterSummaryParts(team({ scored: 9, played: 9 }))).toEqual(['9 played']);
  });

  it('splits played from playing when the roster is mid-transition', () => {
    expect(rosterSummaryParts(team({ scored: 9, played: 6 }))).toEqual(['6 played', '3 playing']);
  });

  it('leads with played/playing before pending, unknown or unresolved', () => {
    expect(
      rosterSummaryParts(team({ scored: 8, played: 5, pending: 1, concealed: 1, unresolved: 1 })),
    ).toEqual(['5 played', '3 playing', '1 to play', '1 unknown', '1 unresolved']);
  });
});

describe('isFloorTotal', () => {
  it('is true when a pick is hidden — the total cannot include what it cannot see', () => {
    expect(isFloorTotal(team({ concealed: 2 }))).toBe(true);
  });

  it('is true when a player could not be matched', () => {
    expect(isFloorTotal(team({ unresolved: 1 }))).toBe(true);
  });

  it('is FALSE for a player who has simply not kicked off', () => {
    // The distinction that stops the marker from firing on every normal Sunday morning: a
    // pending player is worth nothing YET, so the total is complete as of right now.
    expect(isFloorTotal(team({ pending: 4 }))).toBe(false);
  });

  it('is false for a fully resolved roster', () => {
    expect(isFloorTotal(team({ scored: 9 }))).toBe(false);
  });

  it('is false when there is no capture at all — that is "unknown", not "a floor"', () => {
    expect(isFloorTotal(team({ hasSnapshot: false, concealed: 9 }))).toBe(false);
  });
});
