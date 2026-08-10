/**
 * Unit tests for "is this game / week over?".
 *
 * An explicit ESPN status always wins; only a missing/unrecognized status falls back to
 * "kicked off more than {@link FINAL_FALLBACK_MS} ago". A week with no games is never final —
 * otherwise an unsynced week would read as settled and start deriving missed lineups for
 * owners who never had a game to miss.
 */
import { describe, it, expect } from 'vitest';
import { FINAL_FALLBACK_MS, gameIsFinal, statusIsFinal, weekIsFinal } from './final';

const NOW = new Date('2026-09-13T23:00:00Z');
const hoursAgo = (h: number): Date => new Date(NOW.getTime() - h * 60 * 60 * 1000);

describe('statusIsFinal', () => {
  it('recognizes the finished statuses ESPN emits', () => {
    for (const s of ['STATUS_FINAL', 'final', 'Complete', 'full-time', 'FULL_TIME', 'postgame']) {
      expect(statusIsFinal(s)).toBe(true);
    }
  });

  it('returns false for a status that is present but not finished', () => {
    for (const s of ['STATUS_IN_PROGRESS', 'STATUS_SCHEDULED', 'halftime']) {
      expect(statusIsFinal(s)).toBe(false);
    }
  });

  it('returns null when there is no status to read', () => {
    expect(statusIsFinal(null)).toBeNull();
    expect(statusIsFinal('')).toBeNull();
  });
});

describe('gameIsFinal', () => {
  it('trusts an explicit final status regardless of kickoff', () => {
    expect(gameIsFinal({ status: 'STATUS_FINAL', kickoff: hoursAgo(0.5) }, NOW)).toBe(true);
  });

  it('trusts an explicit in-progress status even long after kickoff', () => {
    // A game stuck in-progress must not be aged into "final" by the fallback.
    expect(gameIsFinal({ status: 'STATUS_IN_PROGRESS', kickoff: hoursAgo(12) }, NOW)).toBe(false);
  });

  it('falls back to kickoff age only when the status is missing', () => {
    expect(gameIsFinal({ status: null, kickoff: hoursAgo(7) }, NOW)).toBe(true);
    expect(gameIsFinal({ status: null, kickoff: hoursAgo(2) }, NOW)).toBe(false);
  });

  it('treats the fallback boundary as inclusive', () => {
    const kickoff = new Date(NOW.getTime() - FINAL_FALLBACK_MS);
    expect(gameIsFinal({ status: null, kickoff }, NOW)).toBe(true);
  });

  it('is not final when there is neither a status nor a kickoff', () => {
    expect(gameIsFinal({ status: null, kickoff: null }, NOW)).toBe(false);
  });
});

describe('weekIsFinal', () => {
  it('is true only when every game is final', () => {
    expect(
      weekIsFinal([{ status: 'STATUS_FINAL', kickoff: hoursAgo(9) }, { status: 'final', kickoff: hoursAgo(6) }], NOW),
    ).toBe(true);
    expect(
      weekIsFinal([{ status: 'STATUS_FINAL', kickoff: hoursAgo(9) }, { status: 'STATUS_IN_PROGRESS', kickoff: hoursAgo(1) }], NOW),
    ).toBe(false);
  });

  it('is FALSE for a week with no games at all', () => {
    // "Nothing scheduled" must never read as "everything is over".
    expect(weekIsFinal([], NOW)).toBe(false);
  });
});
