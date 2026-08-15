/**
 * Tests for the DraftKings Classic NFL scoring engine.
 *
 * Every expected value here is hand-computed from DK's published rules — deliberately NOT
 * derived by running the engine — so a rule change has to be re-justified by a human rather
 * than silently re-baselined.
 */
import { describe, it, expect } from 'vitest';

import { DK_CLASSIC_NFL, DK_CLASSIC_SLOTS, type DkScoringRules } from './rules';
import { dstLine, playerLine } from './stat-line';
import {
  pointsAllowedPoints,
  round2,
  scoreDst,
  scoreLineup,
  scorePlayer,
  type LineupSlotInput,
} from './score';

describe('round2', () => {
  it('rounds half up and kills float drift', () => {
    expect(round2(0.145)).toBe(0.15);
    expect(round2(5.2000000000000002)).toBe(5.2);
    expect(round2(11.48)).toBe(11.48);
    expect(round2(-1.005)).toBe(-1);
  });
});

describe('scorePlayer — individual rules', () => {
  it('scores passing yards at 0.04/yd', () => {
    // 287 * 0.04 = 11.48
    expect(scorePlayer(playerLine({ passYards: 287 })).points).toBe(11.48);
  });

  it('scores passing TDs at 4 and interceptions at -1', () => {
    expect(scorePlayer(playerLine({ passTd: 3 })).points).toBe(12);
    expect(scorePlayer(playerLine({ passInterceptions: 2 })).points).toBe(-2);
  });

  it('scores rushing and receiving yards at 0.1/yd', () => {
    expect(scorePlayer(playerLine({ rushYards: 63 })).points).toBe(6.3);
    expect(scorePlayer(playerLine({ recYards: 47 })).points).toBe(4.7);
  });

  it('scores rushing and receiving TDs at 6', () => {
    expect(scorePlayer(playerLine({ rushTd: 2 })).points).toBe(12);
    expect(scorePlayer(playerLine({ recTd: 1 })).points).toBe(6);
  });

  it('is full PPR — 1 point per reception', () => {
    expect(scorePlayer(playerLine({ receptions: 9 })).points).toBe(9);
  });

  it('penalises lost fumbles at -1', () => {
    expect(scorePlayer(playerLine({ fumblesLost: 2 })).points).toBe(-2);
  });

  it('scores return TDs and 2-pt conversions', () => {
    expect(scorePlayer(playerLine({ returnTd: 1 })).points).toBe(6);
    expect(scorePlayer(playerLine({ twoPointConversions: 2 })).points).toBe(4);
    expect(scorePlayer(playerLine({ offensiveFumbleRecoveryTd: 1 })).points).toBe(6);
  });
});

describe('scorePlayer — yardage bonuses', () => {
  it('awards the 300-yard passing bonus at exactly 300, not 299', () => {
    expect(scorePlayer(playerLine({ passYards: 299 })).points).toBe(11.96); // 299*.04
    expect(scorePlayer(playerLine({ passYards: 300 })).points).toBe(15); // 12 + 3
  });

  it('awards the 100-yard rushing bonus at exactly 100, not 99', () => {
    expect(scorePlayer(playerLine({ rushYards: 99 })).points).toBe(9.9);
    expect(scorePlayer(playerLine({ rushYards: 100 })).points).toBe(13); // 10 + 3
  });

  it('awards the 100-yard receiving bonus at exactly 100, not 99', () => {
    expect(scorePlayer(playerLine({ recYards: 99 })).points).toBe(9.9);
    expect(scorePlayer(playerLine({ recYards: 100 })).points).toBe(13);
  });

  it('awards rushing and receiving bonuses together for a dual-100 game', () => {
    // 100*.1 + 100*.1 + 3 + 3 = 26
    expect(scorePlayer(playerLine({ rushYards: 100, recYards: 100 })).points).toBe(26);
  });

  it('awards the bonus only once regardless of how far past the threshold', () => {
    // 250*.1 = 25, +3 once = 28
    expect(scorePlayer(playerLine({ rushYards: 250 })).points).toBe(28);
  });
});

describe('scorePlayer — whole lines', () => {
  it('scores a real hand-verified QB line (Altmyer, DET @ CIN preseason 2026)', () => {
    // ESPN boxscore: 13/22, 130 pass yds, 1 pass TD, 2 INT, 1 rush yd, 1 fumble lost.
    // 130*0.04 = 5.2 | +4 TD | -2 INT | 1*0.1 = 0.1 | -1 fumble  =>  6.3
    const line = playerLine({
      passYards: 130,
      passTd: 1,
      passInterceptions: 2,
      rushYards: 1,
      fumblesLost: 1,
    });
    expect(scorePlayer(line).points).toBe(6.3);
  });

  it('scores a big receiving line', () => {
    // 9 rec + 142 yds + 2 TD + 100-yd bonus = 9 + 14.2 + 12 + 3 = 38.2
    const line = playerLine({ receptions: 9, recYards: 142, recTd: 2 });
    expect(scorePlayer(line).points).toBe(38.2);
  });

  it('scores an elite QB line with the passing bonus', () => {
    // 333*0.04 = 13.32 | 4 TD = 16 | 1 INT = -1 | 24 rush = 2.4 | 1 rush TD = 6 | bonus 3
    // = 39.72
    const line = playerLine({
      passYards: 333,
      passTd: 4,
      passInterceptions: 1,
      rushYards: 24,
      rushTd: 1,
    });
    expect(scorePlayer(line).points).toBe(39.72);
  });

  it('returns an empty breakdown for a player who did nothing', () => {
    const result = scorePlayer(playerLine({}));
    expect(result.points).toBe(0);
    expect(result.components).toEqual([]);
  });

  it('emits a component breakdown that sums to the total', () => {
    const result = scorePlayer(playerLine({ receptions: 9, recYards: 142, recTd: 2 }));
    const sum = result.components.reduce((acc, c) => acc + c.points, 0);
    expect(round2(sum)).toBe(result.points);
    expect(result.components.map((c) => c.key)).toEqual([
      'receptions',
      'recYards',
      'recTd',
      'bonus.recYards',
    ]);
  });
});

describe('pointsAllowedPoints — every tier boundary', () => {
  const cases: [number, number][] = [
    [0, 10],
    [1, 7],
    [6, 7],
    [7, 4],
    [13, 4],
    [14, 1],
    [20, 1],
    [21, 0],
    [27, 0],
    [28, -1],
    [34, -1],
    [35, -4],
    [59, -4],
  ];
  it.each(cases)('%i points allowed -> %i', (allowed, expected) => {
    expect(pointsAllowedPoints(allowed)).toBe(expected);
  });
});

describe('scoreDst', () => {
  it('scores a shutout with pressure', () => {
    // 4 sacks = 4 | 2 INT = 4 | 1 fum rec = 2 | 0 allowed = +10  => 20
    const line = dstLine({ sacks: 4, interceptions: 2, fumbleRecoveries: 1, pointsAllowed: 0 });
    expect(scoreDst(line).points).toBe(20);
  });

  it('scores defensive and special teams TDs at 6 each', () => {
    // 1 def TD = 6 | 1 ST TD = 6 | 24 allowed = 0  => 12
    const line = dstLine({ defensiveTds: 1, specialTeamsTds: 1, pointsAllowed: 24 });
    expect(scoreDst(line).points).toBe(12);
  });

  it('scores safeties and blocked kicks at 2 each', () => {
    // 1 safety = 2 | 2 blocked = 4 | 10 allowed = +4  => 10
    const line = dstLine({ safeties: 1, blockedKicks: 2, pointsAllowed: 10 });
    expect(scoreDst(line).points).toBe(10);
  });

  it('goes negative when blown out', () => {
    // 1 sack = 1 | 41 allowed = -4  => -3
    expect(scoreDst(dstLine({ sacks: 1, pointsAllowed: 41 })).points).toBe(-3);
  });

  it('always reports a points-allowed component, even in the 0-point tier', () => {
    const result = scoreDst(dstLine({ pointsAllowed: 24 }));
    expect(result.points).toBe(0);
    const pa = result.components.find((c) => c.key === 'pointsAllowed');
    expect(pa).toEqual({ key: 'pointsAllowed', label: 'Points allowed', quantity: 24, points: 0 });
  });
});

describe('scoreLineup', () => {
  const filled = (): LineupSlotInput[] =>
    DK_CLASSIC_SLOTS.map((slot) =>
      slot === 'DST'
        ? { slot, kind: 'dst' as const, line: dstLine({ sacks: 3, pointsAllowed: 10 }) }
        : { slot, kind: 'player' as const, line: playerLine({ recYards: 50, receptions: 4 }) },
    );

  it('sums all nine slots', () => {
    // 8 players * (4 rec + 5.0 yds) = 8 * 9 = 72 | DST 3 sacks + tier +4 = 7  => 79
    const result = scoreLineup(filled());
    expect(result.slots).toHaveLength(9);
    expect(result.points).toBe(79);
    expect(result.unresolvedCount).toBe(0);
  });

  it('treats an unresolved slot as null, never as zero, and counts it', () => {
    const slots = filled();
    slots[3] = { slot: 'WR', kind: 'unresolved' };
    const result = scoreLineup(slots);

    expect(result.unresolvedCount).toBe(1);
    expect(result.slots[3].points).toBeNull();
    expect(result.slots[3].components).toEqual([]);
    // The unresolved slot's 9 points are excluded — the total understates, never invents.
    expect(result.points).toBe(70);
  });

  it('scores a lineup where every slot is unresolved as 0 with a full unresolved count', () => {
    const slots: LineupSlotInput[] = DK_CLASSIC_SLOTS.map((slot) => ({ slot, kind: 'unresolved' }));
    const result = scoreLineup(slots);
    expect(result.points).toBe(0);
    expect(result.unresolvedCount).toBe(9);
  });
});

describe('rules are injectable', () => {
  it('honours an overridden rule set', () => {
    const halfPpr: DkScoringRules = {
      ...DK_CLASSIC_NFL,
      offense: { ...DK_CLASSIC_NFL.offense, reception: 0.5 },
    };
    expect(scorePlayer(playerLine({ receptions: 8 }), halfPpr).points).toBe(4);
  });

  it('ships DK Classic defaults', () => {
    expect(DK_CLASSIC_NFL.offense.reception).toBe(1);
    expect(DK_CLASSIC_NFL.offense.passYardPerPoint).toBe(0.04);
    expect(DK_CLASSIC_NFL.dst.pointsAllowedMode).toBe('raw');
    expect(DK_CLASSIC_SLOTS).toHaveLength(9);
    expect(DK_CLASSIC_SLOTS).not.toContain('K');
  });
});
