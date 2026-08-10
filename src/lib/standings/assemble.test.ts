/**
 * Unit tests for the raw-rows → `MatchupResult[]` assembly.
 *
 * This is the layer that decides, for a missed lineup, what the OPPONENT plays against —
 * the league average or median — which in turn decides whether the opponent wins, and what
 * Points Against they are charged. It was previously inlined in a Drizzle query and had no
 * test coverage at all.
 */
import { describe, it, expect } from 'vitest';
import { assembleMatchupResults, type MissedLineupRule } from './assemble';
import { ownerWeekKey, type MatchupRow, type ScoreRow } from './forfeit-derive';
import { computeStandings } from './standings';
import type { OwnerEntry } from './types';

const REGULAR_WEEKS = 18;
const AVG: MissedLineupRule = { result: 'auto_loss', opponentScores: 'league_average' };
const MED: MissedLineupRule = { result: 'auto_loss', opponentScores: 'league_median' };

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

function owner(id: number): OwnerEntry {
  return {
    ownerSeasonId: id,
    ownerName: `Owner ${id}`,
    teamKey: `T${id}`,
    teamName: `Team ${id}`,
    conference: 'AFC',
    division: 'East',
  };
}

describe('median vs average', () => {
  // One 300-point outlier drags the mean well above the median — the exact reason the
  // league switched conventions for 2026, and never tested before now.
  const scores = [
    score(1, 1, 0), // forfeiter
    score(2, 1, 135), // opponent — between the median and the mean
    score(3, 1, 100),
    score(4, 1, 110),
    score(5, 1, 120),
    score(6, 1, 300), // outlier
  ];
  const matchups = [matchup(1, 1, 2), matchup(1, 3, 4), matchup(1, 5, 6)];
  const forfeits = new Set([ownerWeekKey(1, 1)]);

  it('computes the week mean and median excluding the forfeiter', () => {
    const out = assembleMatchupResults({
      scores,
      matchups,
      forfeits,
      missedLineup: AVG,
      regularSeasonWeeks: REGULAR_WEEKS,
    });
    // counted: 135, 100, 110, 120, 300 → mean 153, median 120
    expect(out.leagueAverageByWeek.get(1)).toBeCloseTo(153, 6);
    expect(out.leagueMedianByWeek.get(1)).toBe(120);
  });

  it('under league_average the opponent faces the mean and LOSES at 135', () => {
    const out = assembleMatchupResults({
      scores,
      matchups,
      forfeits,
      missedLineup: AVG,
      regularSeasonWeeks: REGULAR_WEEKS,
    });
    const game = out.results.find((r) => r.homeOwnerSeasonId === 1)!;
    expect(game.forfeitBy).toBe('home');
    expect(game.opponentFacesPoints).toBeCloseTo(153, 6);

    const rows = computeStandings([owner(1), owner(2)], out.results);
    const opp = rows.find((r) => r.ownerSeasonId === 2)!;
    expect(opp.losses).toBe(1); // 135 < 153 → the double-loss case
  });

  it('under league_median the same opponent faces the median and WINS at 135', () => {
    const out = assembleMatchupResults({
      scores,
      matchups,
      forfeits,
      missedLineup: MED,
      regularSeasonWeeks: REGULAR_WEEKS,
    });
    const game = out.results.find((r) => r.homeOwnerSeasonId === 1)!;
    expect(game.opponentFacesPoints).toBe(120);

    const rows = computeStandings([owner(1), owner(2)], out.results);
    const opp = rows.find((r) => r.ownerSeasonId === 2)!;
    expect(opp.wins).toBe(1); // 135 >= 120
    expect(opp.pointsAgainst).toBe(120); // PA is the benchmark, not the forfeiter's 0
  });
});

describe('a forfeiter with no score row', () => {
  const matchups = [matchup(4, 1, 2)];

  it('still makes the matchup final and hands the opponent the win', () => {
    // Previously this matchup had isFinal=false and was dropped, denying owner 2 a win
    // and reducing their games played (which feeds the win% tiebreaker cohorts).
    const out = assembleMatchupResults({
      scores: [score(2, 4, 118)], // owner 1 never posted anything
      matchups,
      forfeits: new Set([ownerWeekKey(1, 4)]),
      missedLineup: AVG,
      regularSeasonWeeks: REGULAR_WEEKS,
    });
    const game = out.results[0];
    expect(game.isFinal).toBe(true);
    expect(game.homePoints).toBe(0);
    expect(game.forfeitBy).toBe('home');

    const rows = computeStandings([owner(1), owner(2)], out.results);
    expect(rows.find((r) => r.ownerSeasonId === 1)!.losses).toBe(1);
    expect(rows.find((r) => r.ownerSeasonId === 2)!.wins).toBe(1);
    expect(rows.find((r) => r.ownerSeasonId === 2)!.gamesPlayed).toBe(1);
  });

  it('leaves a genuinely unplayed matchup non-final', () => {
    const out = assembleMatchupResults({
      scores: [score(2, 4, 118)],
      matchups,
      forfeits: new Set(), // week not settled → nothing derived
      missedLineup: AVG,
      regularSeasonWeeks: REGULAR_WEEKS,
    });
    expect(out.results[0].isFinal).toBe(false);
  });
});

describe('bye reconciliation inside the assembly', () => {
  it('counts the points of an owner wrongly flagged isBye who had a matchup', () => {
    // The ingest-ordering regression: every owner written isBye=true would otherwise have
    // their points erased from Points For.
    const out = assembleMatchupResults({
      scores: [score(1, 2, 130, { isBye: true }), score(2, 2, 90, { isBye: true })],
      matchups: [matchup(2, 1, 2)],
      forfeits: new Set(),
      missedLineup: AVG,
      regularSeasonWeeks: REGULAR_WEEKS,
    });
    expect(out.pointsByOwnerWeek.get(ownerWeekKey(1, 2))).toBe(130);
    expect(out.results[0].isFinal).toBe(true);

    const rows = computeStandings([owner(1), owner(2)], out.results);
    expect(rows.find((r) => r.ownerSeasonId === 1)!.pointsFor).toBe(130);
    expect(rows.find((r) => r.ownerSeasonId === 1)!.wins).toBe(1);
  });

  it('still treats a real bye (no matchup) as unscored, and tallies its bye points', () => {
    const out = assembleMatchupResults({
      scores: [score(9, 2, 88, { isBye: true })],
      matchups: [matchup(2, 1, 2)],
      forfeits: new Set(),
      missedLineup: AVG,
      regularSeasonWeeks: REGULAR_WEEKS,
    });
    expect(out.pointsByOwnerWeek.get(ownerWeekKey(9, 2))).toBeNull();
    expect(out.byePointsForByOwner.get(9)).toBe(88);
  });
});

describe('rule passthrough', () => {
  it("result: 'none' disables forfeit handling entirely", () => {
    const out = assembleMatchupResults({
      scores: [score(1, 1, 0), score(2, 1, 100)],
      matchups: [matchup(1, 1, 2)],
      forfeits: new Set([ownerWeekKey(1, 1)]),
      missedLineup: { result: 'none', opponentScores: 'league_average' },
      regularSeasonWeeks: REGULAR_WEEKS,
    });
    expect(out.results[0].forfeitBy).toBeUndefined();
  });

  it("opponentScores: 'actual' leaves the forfeiter's own points standing", () => {
    const out = assembleMatchupResults({
      scores: [score(1, 1, 0), score(2, 1, 100)],
      matchups: [matchup(1, 1, 2)],
      forfeits: new Set([ownerWeekKey(1, 1)]),
      missedLineup: { result: 'auto_loss', opponentScores: 'actual' },
      regularSeasonWeeks: REGULAR_WEEKS,
    });
    expect(out.results[0].forfeitBy).toBeUndefined();
  });

  it('both sides forfeiting yields a double loss', () => {
    const out = assembleMatchupResults({
      scores: [score(1, 1, 0), score(2, 1, 0), score(3, 1, 110), score(4, 1, 130)],
      matchups: [matchup(1, 1, 2), matchup(1, 3, 4)],
      forfeits: new Set([ownerWeekKey(1, 1), ownerWeekKey(2, 1)]),
      missedLineup: AVG,
      regularSeasonWeeks: REGULAR_WEEKS,
    });
    const game = out.results.find((r) => r.homeOwnerSeasonId === 1)!;
    expect(game.forfeitBy).toBe('both');

    const rows = computeStandings([owner(1), owner(2)], out.results);
    expect(rows.find((r) => r.ownerSeasonId === 1)!.losses).toBe(1);
    expect(rows.find((r) => r.ownerSeasonId === 2)!.losses).toBe(1);
  });

  it('playoff matchups are never given forfeit handling', () => {
    const out = assembleMatchupResults({
      scores: [score(1, 19, 0), score(2, 19, 100)],
      matchups: [matchup(19, 1, 2, true)],
      forfeits: new Set([ownerWeekKey(1, 19)]),
      missedLineup: AVG,
      regularSeasonWeeks: REGULAR_WEEKS,
    });
    expect(out.results[0].forfeitBy).toBeUndefined();
  });
});
