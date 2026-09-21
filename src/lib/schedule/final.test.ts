/**
 * Unit tests for "is this game / week over?".
 *
 * An explicit ESPN status always wins; a missing, unrecognized, or merely PRE-GAME status
 * falls back to "kicked off more than {@link FINAL_FALLBACK_MS} ago" — pre-game because the
 * column is written only by a manual schedule pull, so it goes stale mid-season and must not
 * be allowed to veto the clock. A week with no games is never final —
 * otherwise an unsynced week would read as settled and start deriving missed lineups for
 * owners who never had a game to miss.
 */
import { describe, it, expect } from 'vitest';
import { FINAL_FALLBACK_MS, gameIsFinal, statusIsFinal, weekIsFinal, type GameTiming } from './final';

const NOW = new Date('2026-09-13T23:00:00Z');
const hoursAgo = (h: number): Date => new Date(NOW.getTime() - h * 60 * 60 * 1000);

describe('statusIsFinal', () => {
  it('recognizes the finished statuses ESPN emits', () => {
    for (const s of ['STATUS_FINAL', 'final', 'Complete', 'full-time', 'FULL_TIME', 'postgame']) {
      expect(statusIsFinal(s)).toBe(true);
    }
  });

  it('returns false for a status that is present but not finished', () => {
    // These can only have been WRITTEN by a refresh, so they are fresh evidence.
    for (const s of ['STATUS_IN_PROGRESS', 'halftime', 'STATUS_POSTPONED']) {
      expect(statusIsFinal(s)).toBe(false);
    }
  });

  it('returns null for a PRE-GAME status — the default, not a claim', () => {
    // `status` is only written by syncSeasonSchedule (manual, pre-season), so a season
    // pulled in August still reads STATUS_SCHEDULED in December. Treating that as
    // "not finished" froze weekIsFinal at false all season and disabled forfeit
    // derivation. It means "nothing refreshed here" — defer to kickoff age instead.
    for (const s of ['STATUS_SCHEDULED', 'STATUS_PRE_GAME', 'pregame']) {
      expect(statusIsFinal(s)).toBeNull();
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

  it('ages a STALE pre-game status into final, but never a future kickoff', () => {
    // The 2026 case: every row still says STATUS_SCHEDULED because nothing re-pulled
    // the schedule. A game played last Sunday is over whatever the column claims...
    expect(gameIsFinal({ status: 'STATUS_SCHEDULED', kickoff: hoursAgo(20) }, NOW)).toBe(true);
    // ...while tonight's game plainly is not, which is what keeps the week unsettled.
    expect(gameIsFinal({ status: 'STATUS_SCHEDULED', kickoff: hoursAgo(-4) }, NOW)).toBe(false);
    expect(gameIsFinal({ status: 'STATUS_SCHEDULED', kickoff: hoursAgo(2) }, NOW)).toBe(false);
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

  it('holds a week open for the Monday night game, then settles it', () => {
    // 2026 week 2 exactly: every row still STATUS_SCHEDULED, Thursday through Monday night.
    // The league's DraftKings contest runs through MNF, so treating the week as over before
    // that game is played would lock in a W/L that can still move.
    const mondayNight = new Date(NOW.getTime() + 4 * 60 * 60 * 1000);
    const week: GameTiming[] = [
      ...[96, 71, 70, 69, 68].map((h) => ({ status: 'STATUS_SCHEDULED', kickoff: hoursAgo(h) })),
      { status: 'STATUS_SCHEDULED', kickoff: mondayNight },
    ];

    // Monday afternoon, MNF still to come — not settled, however stale the column is.
    expect(weekIsFinal(week, NOW)).toBe(false);
    // Six hours past that kickoff — settled.
    expect(weekIsFinal(week, new Date(mondayNight.getTime() + FINAL_FALLBACK_MS))).toBe(true);
  });

  it('is FALSE for a week with no games at all', () => {
    // "Nothing scheduled" must never read as "everything is over".
    expect(weekIsFinal([], NOW)).toBe(false);
  });
});
