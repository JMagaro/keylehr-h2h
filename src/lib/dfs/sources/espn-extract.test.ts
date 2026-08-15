/**
 * Tests for ESPN boxscore extraction, run against REAL trimmed payloads in
 * scripts/fixtures/. Expected values are hand-computed from DK's rules, not produced by
 * running the code, so a regression has to be re-justified rather than re-baselined.
 *
 * Fixtures:
 *   401772810 — CHI @ MIN, 2025 regular-season week 1. Chosen because it contains the
 *               awkward cases: a SUCCESSFUL two-point conversion (plus a failed one that
 *               must not be counted), an interception-return touchdown, and a lost fumble.
 *   401873272 — DET @ CIN, 2026 preseason week 2. A plain game used to pin the end-to-end
 *               arithmetic against a line verified by hand during design.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

import {
  abbreviatedNameKey,
  extractGame,
  extractTwoPointCredits,
  fullNameKey,
  isBlockedKickPlay,
  parseStat,
} from './espn-extract';
import type { EspnSummaryResponse } from './espn-types';
import { scoreDst, scorePlayer } from '../score';

function fixture(eventId: string): EspnSummaryResponse {
  const url = new URL(`../../../../scripts/fixtures/espn-summary-${eventId}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as EspnSummaryResponse;
}

const CHI_MIN = fixture('401772810');
const DET_CIN = fixture('401873272');

const playerNamed = (game: ReturnType<typeof extractGame>, name: string) =>
  game.players.find((p) => p.name === name);
const defenseFor = (game: ReturnType<typeof extractGame>, teamKey: string) =>
  game.defenses.find((d) => d.teamKey === teamKey);

/* -------------------------------------------------------------------------- */

describe('parseStat', () => {
  it('handles ESPN placeholders and separators', () => {
    expect(parseStat('143')).toBe(143);
    expect(parseStat('--')).toBe(0);
    expect(parseStat('')).toBe(0);
    expect(parseStat(undefined)).toBe(0);
    expect(parseStat('1,234')).toBe(1234);
    expect(parseStat('2.5')).toBe(2.5);
    // Combined cells are never indexed on purpose; they must not become NaN.
    expect(parseStat('13/20')).toBe(0);
  });
});

describe('name keys', () => {
  it('maps gamebook abbreviations and full names onto the same key', () => {
    expect(abbreviatedNameKey('J.McCarthy')).toBe('j|mccarthy');
    expect(fullNameKey('J.J. McCarthy')).toBe('j|mccarthy');
    expect(abbreviatedNameKey('A.Thielen')).toBe('a|thielen');
    expect(fullNameKey('Adam Thielen')).toBe('a|thielen');
    expect(fullNameKey('Aaron Jones Sr.')).toBe('a|jones');
    expect(abbreviatedNameKey('A.Jones')).toBe('a|jones');
  });

  it('rejects tokens that are not abbreviated names', () => {
    expect(abbreviatedNameKey('TOUCHDOWN')).toBeNull();
    expect(abbreviatedNameKey('')).toBeNull();
    expect(fullNameKey('Cher')).toBeNull();
  });
});

describe('extractTwoPointCredits', () => {
  it('credits passer AND receiver on a successful conversion pass', () => {
    const text =
      '(Shotgun) J.McCarthy pass deep right to A.Jones for 27 yards, TOUCHDOWN. ' +
      '** Injury Update: CHI-N.Wright has returned to the game. TWO-POINT CONVERSION ATTEMPT. ' +
      'J.McCarthy pass to A.Thielen is complete. ATTEMPT SUCCEEDS.';
    expect(extractTwoPointCredits(text)).toEqual({ playerKeys: ['j|mccarthy', 'a|thielen'] });
  });

  it('ignores a FAILED conversion attempt', () => {
    const text =
      'TWO-POINT CONVERSION ATTEMPT. J.McCarthy pass to A.Thielen is incomplete. ATTEMPT FAILS.' +
      'PENALTY on CHI-D.Odeyingbo, Illegal Use of Hands, 1 yard, enforced at CHI 2 - No Play.';
    expect(extractTwoPointCredits(text)).toBeNull();
  });

  it('ignores the scoring-play summary phrasing that is not an attempt line', () => {
    expect(
      extractTwoPointCredits('Justin Jefferson 13 Yd pass from J.J. McCarthy (Two-Point Pass Conversion Failed)'),
    ).toBeNull();
  });

  it('credits the runner on a successful conversion run', () => {
    const text = 'TWO-POINT CONVERSION ATTEMPT. J.Allen rushes right end. ATTEMPT SUCCEEDS.';
    expect(extractTwoPointCredits(text)).toEqual({ playerKeys: ['j|allen'] });
  });

  it('returns null for ordinary plays', () => {
    expect(extractTwoPointCredits('J.Allen pass short left to S.Diggs for 8 yards.')).toBeNull();
    expect(extractTwoPointCredits(undefined)).toBeNull();
  });
});

describe('isBlockedKickPlay', () => {
  it('detects blocked kicks case-insensitively', () => {
    expect(isBlockedKickPlay('C.Santos 48 yard field goal is BLOCKED.')).toBe(true);
    expect(isBlockedKickPlay('C.Santos 48 yard field goal is GOOD.')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe('extractGame — CHI @ MIN (2025 week 1)', () => {
  const game = extractGame(CHI_MIN);

  it('reads game state and both teams', () => {
    expect(game.state).toBe('post');
    expect(game.statusDetail).toBe('Final');
    expect(game.teamKeys).toHaveLength(2);
    expect(game.teamKeys).toContain('CHI');
    expect(game.teamKeys).toContain('MIN');
  });

  it('merges a QB’s passing and rushing groups into one line, including the 2-pt pass', () => {
    const qb = playerNamed(game, 'J.J. McCarthy');
    expect(qb).toBeDefined();
    expect(qb!.teamKey).toBe('MIN');
    expect(qb!.line).toMatchObject({
      passYards: 143,
      passTd: 2,
      passInterceptions: 1,
      rushYards: 25,
      rushTd: 1,
      twoPointConversions: 1,
    });
    // 143*.04=5.72 | 2 TD=8 | 1 INT=-1 | 25 rush=2.5 | 1 rush TD=6 | 2-pt=2  => 23.22
    expect(scorePlayer(qb!.line).points).toBe(23.22);
  });

  it('scores a player whose ONLY production was a 2-pt conversion catch', () => {
    // A 2-pt conversion is not a reception and its yards are not receiving yards, so Adam
    // Thielen's boxscore line is empty. Without play-text parsing he would score 0.00 while
    // DraftKings paid him 2.00 — this is precisely why the best-effort parser exists.
    const thielen = playerNamed(game, 'Adam Thielen');
    expect(thielen).toBeDefined();
    expect(thielen!.line.receptions).toBe(0);
    expect(thielen!.line.recYards).toBe(0);
    expect(thielen!.line.twoPointConversions).toBe(1);
    expect(scorePlayer(thielen!.line).points).toBe(2);
  });

  it('does not credit a 2-pt conversion to uninvolved players', () => {
    const jefferson = playerNamed(game, 'Justin Jefferson');
    expect(jefferson!.line.twoPointConversions).toBe(0);
    // 4 rush=0.4 | 4 rec=4 | 44 rec yds=4.4 | 1 rec TD=6  => 14.8
    expect(scorePlayer(jefferson!.line).points).toBe(14.8);
  });

  it('scores a receiving back correctly', () => {
    const jones = playerNamed(game, 'Aaron Jones Sr.');
    // 23 rush=2.3 | 3 rec=3 | 44 rec yds=4.4 | 1 rec TD=6  => 15.7
    expect(scorePlayer(jones!.line).points).toBe(15.7);
  });

  it('builds the CHI defense from team stats without double-counting the pick-six', () => {
    const chi = defenseFor(game, 'CHI');
    expect(chi!.line).toMatchObject({
      sacks: 3,
      interceptions: 1,
      // MIN lost no fumbles, so CHI recovered none.
      fumbleRecoveries: 0,
      // Team-level defensiveTouchdowns already covers the interception return TD.
      defensiveTds: 1,
      pointsAllowed: 27,
    });
    // 3 sacks=3 | 1 INT=2 | 1 def TD=6 | 27 allowed=0  => 11
    expect(scoreDst(chi!.line).points).toBe(11);
  });

  it('credits MIN’s defense with the fumble CHI lost', () => {
    const min = defenseFor(game, 'MIN');
    expect(min!.line).toMatchObject({
      sacks: 2,
      interceptions: 0,
      fumbleRecoveries: 1,
      defensiveTds: 0,
      pointsAllowed: 24,
    });
    // 2 sacks=2 | 1 fum rec=2 | 24 allowed=0  => 4
    expect(scoreDst(min!.line).points).toBe(4);
  });
});

describe('extractGame — DET @ CIN (2026 preseason)', () => {
  const game = extractGame(DET_CIN);

  it('reproduces the line verified by hand during design', () => {
    const altmyer = playerNamed(game, 'Luke Altmyer');
    expect(altmyer!.line).toMatchObject({
      passYards: 130,
      passTd: 1,
      passInterceptions: 2,
      rushYards: 1,
      fumblesLost: 1,
    });
    // 130*.04=5.2 | 1 TD=4 | 2 INT=-2 | 1 rush=0.1 | 1 fumble=-1  => 6.3
    expect(scorePlayer(altmyer!.line).points).toBe(6.3);
  });

  it('assigns points allowed from the opponent’s score', () => {
    // CIN 16, DET 14.
    expect(defenseFor(game, 'DET')!.line.pointsAllowed).toBe(16);
    expect(defenseFor(game, 'CIN')!.line.pointsAllowed).toBe(14);
    // Both land in the 14–20 tier: +1.
    expect(scoreDst(defenseFor(game, 'DET')!.line).components.at(-1)!.points).toBe(1);
  });

  it('finds no phantom two-point conversions in a game that had none', () => {
    expect(game.players.every((p) => p.line.twoPointConversions === 0)).toBe(true);
  });

  it('extracts every player who recorded a stat', () => {
    expect(game.players.length).toBeGreaterThan(30);
    expect(game.defenses).toHaveLength(2);
  });
});

describe('extractGame — degenerate payloads', () => {
  it('treats an empty payload as a pre-game with no data, never as zeros', () => {
    const game = extractGame({});
    expect(game.state).toBe('pre');
    expect(game.players).toEqual([]);
    expect(game.defenses).toEqual([]);
    expect(game.teamKeys).toEqual([]);
  });

  it('survives a header with no boxscore (scheduled game)', () => {
    const game = extractGame({
      header: {
        id: '999',
        competitions: [
          {
            competitors: [
              { homeAway: 'home', score: '0', team: { id: '1', abbreviation: 'ATL' } },
              { homeAway: 'away', score: '0', team: { id: '7', abbreviation: 'DEN' } },
            ],
            status: { type: { state: 'pre', detail: '7:00 PM ET' } },
          },
        ],
      },
    });
    expect(game.state).toBe('pre');
    expect(game.teamKeys).toEqual(['ATL', 'DEN']);
    expect(game.players).toEqual([]);
    // Defenses still resolve so the UI can show a 0-0 pending matchup.
    expect(game.defenses).toHaveLength(2);
  });
});
