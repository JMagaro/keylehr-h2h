/**
 * Unit tests for the "missed lineup" (forfeit) scoring rule in computeStandings.
 *
 * Rule under test (see MatchupResult.forfeitBy / opponentFacesPoints):
 *  - The forfeiter takes an automatic LOSS; PF += own raw points, PA += opponent
 *    raw points.
 *  - The non-forfeiting opponent plays against `opponentFacesPoints`: WIN if its
 *    own points >= that value else LOSS; PA += `opponentFacesPoints` (NOT the
 *    forfeiter's raw points).
 *  - `forfeitBy: 'both'` → both get a LOSS (double loss), each PA += faces.
 *  - When no forfeit fields are present, behavior is unchanged.
 */
import { describe, it, expect } from 'vitest';
import { computeStandings } from './standings';
import type { MatchupResult, OwnerEntry } from './types';

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

function game(
  week: number,
  home: number,
  away: number,
  homePts: number | null,
  awayPts: number | null,
  extra: Partial<MatchupResult> = {},
): MatchupResult {
  return {
    week,
    isPlayoff: false,
    isFinal: true,
    homeOwnerSeasonId: home,
    awayOwnerSeasonId: away,
    homePoints: homePts,
    awayPoints: awayPts,
    ...extra,
  };
}

function rowFor(rows: ReturnType<typeof computeStandings>, id: number) {
  return rows.find((r) => r.ownerSeasonId === id)!;
}

describe('computeStandings — forfeit (missed lineup)', () => {
  it('opponent ABOVE the league average → opponent W, forfeiter L (PA = average)', () => {
    // Home (owner 1) forfeited with 0; away (owner 2) scored 110, average is 100.
    const rows = computeStandings(
      [owner(1), owner(2)],
      [game(1, 1, 2, 0, 110, { forfeitBy: 'home', opponentFacesPoints: 100 })],
    );

    const forfeiter = rowFor(rows, 1);
    expect(forfeiter.losses).toBe(1);
    expect(forfeiter.wins).toBe(0);
    expect(forfeiter.pointsFor).toBe(0); // own raw points
    expect(forfeiter.pointsAgainst).toBe(110); // opponent's raw points

    const opp = rowFor(rows, 2);
    expect(opp.wins).toBe(1); // 110 >= 100 average
    expect(opp.losses).toBe(0);
    expect(opp.pointsFor).toBe(110); // own raw points
    expect(opp.pointsAgainst).toBe(100); // faces the league average, NOT 0
  });

  it('opponent BELOW the league average → DOUBLE LOSS (opponent L and forfeiter L)', () => {
    // Away (owner 2) forfeited with 0; home (owner 1) scored 80, below average 100.
    const rows = computeStandings(
      [owner(1), owner(2)],
      [game(1, 1, 2, 80, 0, { forfeitBy: 'away', opponentFacesPoints: 100 })],
    );

    const opp = rowFor(rows, 1);
    expect(opp.losses).toBe(1); // 80 < 100 → loses to the average
    expect(opp.wins).toBe(0);
    expect(opp.pointsFor).toBe(80);
    expect(opp.pointsAgainst).toBe(100); // faces the average

    const forfeiter = rowFor(rows, 2);
    expect(forfeiter.losses).toBe(1); // offender always L
    expect(forfeiter.wins).toBe(0);
    expect(forfeiter.pointsFor).toBe(0);
    expect(forfeiter.pointsAgainst).toBe(80); // opponent's raw points

    // Double loss: total losses (2) exceed total wins (0) for this matchup.
    const totalWins = opp.wins + forfeiter.wins;
    const totalLosses = opp.losses + forfeiter.losses;
    expect(totalWins).toBe(0);
    expect(totalLosses).toBe(2);
  });

  it('opponent EXACTLY at the league average → opponent W (>= is a win)', () => {
    const rows = computeStandings(
      [owner(1), owner(2)],
      [game(1, 1, 2, 0, 100, { forfeitBy: 'home', opponentFacesPoints: 100 })],
    );
    expect(rowFor(rows, 2).wins).toBe(1);
    expect(rowFor(rows, 1).losses).toBe(1);
  });

  it("forfeitBy: 'both' → both owners take a LOSS, each PA = faces", () => {
    const rows = computeStandings(
      [owner(1), owner(2)],
      [game(1, 1, 2, 0, 0, { forfeitBy: 'both', opponentFacesPoints: 100 })],
    );
    const r1 = rowFor(rows, 1);
    const r2 = rowFor(rows, 2);
    expect(r1.losses).toBe(1);
    expect(r2.losses).toBe(1);
    expect(r1.wins).toBe(0);
    expect(r2.wins).toBe(0);
    expect(r1.pointsFor).toBe(0);
    expect(r2.pointsFor).toBe(0);
    expect(r1.pointsAgainst).toBe(100);
    expect(r2.pointsAgainst).toBe(100);
  });

  it("opponentFacesPoints of 0 (opponentScores='zero') → opponent always W", () => {
    const rows = computeStandings(
      [owner(1), owner(2)],
      [game(1, 1, 2, 0, 0, { forfeitBy: 'home', opponentFacesPoints: 0 })],
    );
    expect(rowFor(rows, 2).wins).toBe(1); // 0 >= 0
    expect(rowFor(rows, 2).pointsAgainst).toBe(0);
    expect(rowFor(rows, 1).losses).toBe(1);
  });

  it('offender always loses even when their own raw points exceed the average', () => {
    // Pathological: forfeiter "scored" 150 but still auto-loses; opponent faces avg.
    const rows = computeStandings(
      [owner(1), owner(2)],
      [game(1, 1, 2, 150, 90, { forfeitBy: 'home', opponentFacesPoints: 100 })],
    );
    expect(rowFor(rows, 1).losses).toBe(1);
    expect(rowFor(rows, 1).wins).toBe(0);
    expect(rowFor(rows, 1).pointsFor).toBe(150);
    expect(rowFor(rows, 2).losses).toBe(1); // 90 < 100 average
  });

  it('no-forfeit path is unchanged when forfeit fields are absent', () => {
    const rows = computeStandings(
      [owner(1), owner(2)],
      [game(1, 1, 2, 100, 90)],
    );
    expect(rowFor(rows, 1).wins).toBe(1);
    expect(rowFor(rows, 1).pointsAgainst).toBe(90);
    expect(rowFor(rows, 2).losses).toBe(1);
    expect(rowFor(rows, 2).pointsAgainst).toBe(100);
  });
});
