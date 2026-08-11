/**
 * Unit tests for bye + forfeit derivation.
 *
 * The rules under test:
 *
 *   BYE      — an owner is on a bye when their NFL team has no game that week. A stored
 *              `isBye = true` on an owner who DOES have a regular-season matchup is
 *              self-contradictory and is ignored. Playoff/exhibition weeks never bye.
 *
 *   SETTLED  — a week is settled when every NFL game is final AND at least one owner has
 *              posted a real score (i.e. the DraftKings sync has landed). Both halves
 *              matter; each guards a different window in which every owner is legitimately
 *              on zero.
 *
 *   FORFEIT  — on a SETTLED regular-season week, an owner who had a matchup and either
 *              posted a non-bye 0.00 or posted nothing at all missed their lineup. On an
 *              unsettled week nothing is derived. A stored `isForfeit = true` is always
 *              honored as a manual override.
 *
 * The most important cases here are the two that must NOT derive a forfeit: mid-Sunday, when
 * every owner sits on 0 points; and the gap after the last game goes final but before the
 * sync runs, when the scores table is still empty. Either one would otherwise resolve the
 * week as a league-wide missed lineup and hand all 16 games a double loss.
 */
import { describe, it, expect } from 'vitest';
import {
  buildPlayingSet,
  computeSettledWeeks,
  deriveByes,
  deriveForfeits,
  isEffectiveBye,
  ownerWeekKey,
  type MatchupRow,
  type ScoreRow,
} from './forfeit-derive';

const REGULAR_WEEKS = 18;

function score(
  ownerSeasonId: number,
  week: number,
  dkPoints: number | null,
  extra: Partial<ScoreRow> = {},
): ScoreRow {
  return { ownerSeasonId, week, dkPoints, isBye: false, isForfeit: false, ...extra };
}

function matchup(week: number, home: number, away: number, isPlayoff = false): MatchupRow {
  return { week, homeOwnerSeasonId: home, awayOwnerSeasonId: away, isPlayoff };
}

describe('buildPlayingSet', () => {
  it('includes both sides of a regular-season matchup and skips playoff rows', () => {
    const playing = buildPlayingSet([matchup(3, 1, 2), matchup(19, 3, 4, true)]);
    expect(playing.has(ownerWeekKey(1, 3))).toBe(true);
    expect(playing.has(ownerWeekKey(2, 3))).toBe(true);
    expect(playing.has(ownerWeekKey(3, 19))).toBe(false);
  });
});

describe('bye reconciliation', () => {
  it('honors a stored bye when the owner has no matchup that week', () => {
    const playing = buildPlayingSet([matchup(5, 1, 2)]);
    expect(
      isEffectiveBye({ storedIsBye: true, ownerSeasonId: 9, week: 5, regularSeasonWeeks: REGULAR_WEEKS, playing }),
    ).toBe(true);
  });

  it('ignores a stored bye when the owner DOES have a matchup that week', () => {
    // The regression: scores ingested before matchups existed wrote isBye=true for everyone.
    const playing = buildPlayingSet([matchup(5, 1, 2)]);
    expect(
      isEffectiveBye({ storedIsBye: true, ownerSeasonId: 1, week: 5, regularSeasonWeeks: REGULAR_WEEKS, playing }),
    ).toBe(false);
  });

  it('never treats a playoff or exhibition week as a bye', () => {
    // `matchups` holds regular-season rows only, so "no matchup" is meaningless past week 18
    // and would otherwise mark every playoff participant as a bye.
    const playing = buildPlayingSet([]);
    for (const week of [19, 22, 102]) {
      expect(
        isEffectiveBye({ storedIsBye: true, ownerSeasonId: 1, week, regularSeasonWeeks: REGULAR_WEEKS, playing }),
      ).toBe(false);
    }
  });

  it('when no matchups exist at all, only owners flagged bye are byes', () => {
    // Nobody is playing, so a stored bye stands; but an owner NOT flagged bye is not
    // invented as one.
    const byes = deriveByes({
      scores: [score(1, 5, 100), score(2, 5, 0, { isBye: true })],
      matchups: [],
      regularSeasonWeeks: REGULAR_WEEKS,
    });
    expect(byes.has(ownerWeekKey(1, 5))).toBe(false);
    expect(byes.has(ownerWeekKey(2, 5))).toBe(true);
  });
});

describe('deriveForfeits', () => {
  const matchups = [matchup(5, 1, 2), matchup(5, 3, 4)];
  const settled = new Set([5]);

  it('flags a non-bye 0.00 on a settled week as a forfeit', () => {
    const forfeits = deriveForfeits({
      scores: [score(1, 5, 0), score(2, 5, 120)],
      matchups,
      settledWeeks: settled,
      regularSeasonWeeks: REGULAR_WEEKS,
    });
    expect(forfeits.has(ownerWeekKey(1, 5))).toBe(true);
    expect(forfeits.has(ownerWeekKey(2, 5))).toBe(false);
  });

  it('flags an owner with NO score row at all as a forfeit', () => {
    // The worse sub-case: never entered the DK contest, so no row exists to flag. A
    // write-time fix cannot reach this; only derivation can.
    const forfeits = deriveForfeits({
      scores: [score(2, 5, 120)],
      matchups,
      settledWeeks: settled,
      regularSeasonWeeks: REGULAR_WEEKS,
    });
    expect(forfeits.has(ownerWeekKey(1, 5))).toBe(true);
  });

  it('derives NOTHING on an unsettled week, even at 0.00 or with no rows', () => {
    // THE live-Sunday guard. Mid-week everyone is on 0; without this the week resolves as
    // a league-wide forfeit cascade.
    const forfeits = deriveForfeits({
      scores: [score(1, 5, 0), score(2, 5, 0)],
      matchups,
      settledWeeks: new Set(), // week 5 not final yet
      regularSeasonWeeks: REGULAR_WEEKS,
    });
    expect(forfeits.size).toBe(0);
  });

  it('does not flag a bye-week 0.00 as a forfeit', () => {
    const forfeits = deriveForfeits({
      scores: [score(7, 5, 0, { isBye: true })],
      matchups,
      settledWeeks: settled,
      regularSeasonWeeks: REGULAR_WEEKS,
    });
    expect(forfeits.has(ownerWeekKey(7, 5))).toBe(false);
  });

  it('does not flag a 0.00 from an owner with no matchup that week', () => {
    const forfeits = deriveForfeits({
      scores: [score(99, 5, 0)],
      matchups,
      settledWeeks: settled,
      regularSeasonWeeks: REGULAR_WEEKS,
    });
    expect(forfeits.has(ownerWeekKey(99, 5))).toBe(false);
  });

  it('honors a stored isForfeit even when the owner scored points', () => {
    // The manual override the commissioner keeps (e.g. a suspension). No rule can infer it.
    const forfeits = deriveForfeits({
      scores: [score(1, 5, 143.2, { isForfeit: true }), score(2, 5, 120)],
      matchups,
      settledWeeks: settled,
      regularSeasonWeeks: REGULAR_WEEKS,
    });
    expect(forfeits.has(ownerWeekKey(1, 5))).toBe(true);
  });

  it('never derives a forfeit outside the regular season', () => {
    const forfeits = deriveForfeits({
      scores: [score(1, 20, 0), score(1, 102, 0)],
      matchups: [matchup(20, 1, 2), matchup(102, 1, 2)],
      settledWeeks: new Set([20, 102]),
      regularSeasonWeeks: REGULAR_WEEKS,
    });
    expect(forfeits.size).toBe(0);
  });

  it('only derives for the weeks that are settled', () => {
    const forfeits = deriveForfeits({
      scores: [score(1, 5, 0), score(1, 6, 0)],
      matchups: [matchup(5, 1, 2), matchup(6, 1, 2)],
      settledWeeks: new Set([5]), // week 6 still in progress
      regularSeasonWeeks: REGULAR_WEEKS,
    });
    expect(forfeits.has(ownerWeekKey(1, 5))).toBe(true);
    expect(forfeits.has(ownerWeekKey(1, 6))).toBe(false);
  });
});

describe('computeSettledWeeks', () => {
  const NOW = new Date('2026-09-14T06:00:00Z');
  const finalGame = { status: 'STATUS_FINAL', kickoff: new Date('2026-09-13T17:00:00Z') };
  const liveGame = { status: 'STATUS_IN_PROGRESS', kickoff: new Date('2026-09-13T17:00:00Z') };

  it('settles a week whose games are all final AND whose scores have synced', () => {
    const settled = computeSettledWeeks({
      gamesByWeek: new Map([[1, [finalGame, finalGame]]]),
      scores: [score(1, 1, 132.5)],
      now: NOW,
    });
    expect([...settled]).toEqual([1]);
  });

  it('does NOT settle a week that is still being played', () => {
    const settled = computeSettledWeeks({
      gamesByWeek: new Map([[1, [finalGame, liveGame]]]),
      scores: [score(1, 1, 132.5)],
      now: NOW,
    });
    expect(settled.size).toBe(0);
  });

  it('does NOT settle a finished week whose scores have not been synced yet', () => {
    // The window between the last game going final and the commissioner running the DK
    // sync. Every owner has a matchup and no score row, so settling here would derive a
    // league-wide missed lineup and hand all 16 games a double loss.
    const settled = computeSettledWeeks({
      gamesByWeek: new Map([[1, [finalGame, finalGame]]]),
      scores: [],
      now: NOW,
    });
    expect(settled.size).toBe(0);
  });

  it('does not count bye-only rows as evidence that the sync landed', () => {
    const settled = computeSettledWeeks({
      gamesByWeek: new Map([[1, [finalGame]]]),
      scores: [score(9, 1, 88, { isBye: true })],
      now: NOW,
    });
    expect(settled.size).toBe(0);
  });

  it('settles each week independently', () => {
    const settled = computeSettledWeeks({
      gamesByWeek: new Map([
        [1, [finalGame]],
        [2, [liveGame]],
      ]),
      scores: [score(1, 1, 120), score(1, 2, 0)],
      now: NOW,
    });
    expect([...settled]).toEqual([1]);
  });
});
