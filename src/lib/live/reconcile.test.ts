/**
 * The scoring-drift audit. Every classification gets a case, because the WHOLE value of this
 * module is telling the four apart: "our rules are wrong" and "ESPN and DK saw different
 * games" look identical if you only compare totals.
 */
import { describe, it, expect } from 'vitest';

import type { LiveSlot } from './assemble';
import { reconcileSlot, reconcileWeek } from './reconcile';

/** A scored slot with our components and DK's stat line, both supplied by the caller. */
function slot(over: Partial<LiveSlot> = {}): LiveSlot {
  return {
    slot: 'QB',
    name: 'Joe Fagnano',
    teamKey: 'BAL',
    position: 'QB',
    status: 'scored',
    points: 12.06,
    components: [
      { key: 'passTd', label: 'Passing TD', quantity: 1, points: 4 },
      { key: 'passYards', label: 'Passing yards', quantity: 224, points: 8.96 },
      { key: 'rushYards', label: 'Rushing yards', quantity: 1, points: 0.1 },
      { key: 'passInterceptions', label: 'Interception thrown', quantity: 1, points: -1 },
    ],
    gameDetail: 'Final',
    dkScore: 12.06,
    dkStats: [
      { key: 'PaTD', value: 1, points: 4 },
      { key: 'PaYds', value: 224, points: 8.96 },
      { key: 'RuYds', value: 1, points: 0.1 },
      { key: 'INT', value: 1, points: -1 },
    ],
    dkProjection: null,
    ...over,
  };
}

describe('reconcileSlot', () => {
  it('agrees when the totals match — the real captured week-102 line', () => {
    const r = reconcileSlot(slot(), true);
    expect(r.verdict).toBe('agree');
    expect(r.delta).toBe(0);
    expect(r.differences).toEqual([]);
  });

  it('calls it ruleDrift when the stats are identical but the points are not', () => {
    // Same 224 yards; we priced them at 0.05/yd instead of 0.04.
    const r = reconcileSlot(
      slot({
        points: 15.42,
        components: [
          { key: 'passTd', label: 'Passing TD', quantity: 1, points: 4 },
          { key: 'passYards', label: 'Passing yards', quantity: 224, points: 11.2 },
          { key: 'rushYards', label: 'Rushing yards', quantity: 1, points: 0.1 },
          { key: 'passInterceptions', label: 'Interception thrown', quantity: 1, points: -1 },
        ],
      }),
      true,
    );
    expect(r.verdict).toBe('ruleDrift');
    expect(r.delta).toBeCloseTo(3.36, 2);
    const d = r.differences.find((x) => x.ourKey === 'passYards');
    expect(d).toMatchObject({ dkValue: 224, ourValue: 224, dkPoints: 8.96, ourPoints: 11.2 });
    expect(r.explanation).toContain('IDENTICAL stat line');
  });

  it('calls it statDrift when the two sources saw different plays', () => {
    // ESPN gave him 230 yards, DK 224. Same rule, different input.
    const r = reconcileSlot(
      slot({
        points: 12.3,
        components: [
          { key: 'passTd', label: 'Passing TD', quantity: 1, points: 4 },
          { key: 'passYards', label: 'Passing yards', quantity: 230, points: 9.2 },
          { key: 'rushYards', label: 'Rushing yards', quantity: 1, points: 0.1 },
          { key: 'passInterceptions', label: 'Interception thrown', quantity: 1, points: -1 },
        ],
      }),
      true,
    );
    expect(r.verdict).toBe('statDrift');
    expect(r.explanation).toContain('disagree on what happened');
  });

  it('refuses to blame the rules for a DraftKings key it does not recognise', () => {
    const r = reconcileSlot(
      slot({
        points: 12.06,
        dkScore: 14.06,
        dkStats: [
          { key: 'PaTD', value: 1, points: 4 },
          { key: 'PaYds', value: 224, points: 8.96 },
          { key: 'RuYds', value: 1, points: 0.1 },
          { key: 'INT', value: 1, points: -1 },
          { key: 'MysteryBonus', value: 1, points: 2 },
        ],
      }),
      true,
    );
    expect(r.verdict).toBe('unmapped');
    expect(r.explanation).toContain('does not recognise');
    expect(r.differences.some((d) => d.dkKey === 'MysteryBonus')).toBe(true);
  });

  it('ignores zero-point DraftKings keys like Targets', () => {
    const r = reconcileSlot(
      slot({ dkStats: [...(slot().dkStats ?? []), { key: 'Targets', value: 7, points: 0 }] }),
      true,
    );
    expect(r.verdict).toBe('agree');
  });

  it('flags a player we could not score at all as unmatched', () => {
    const r = reconcileSlot(slot({ status: 'unresolved', points: null, components: [] }), true);
    expect(r.verdict).toBe('unmatched');
    expect(r.explanation).toContain('name/team match failed');
  });

  it('never judges a slot whose game had not finished when it was captured', () => {
    // The trap: DK's number is a snapshot, ours is live. Mid-game they SHOULD differ.
    const r = reconcileSlot(slot({ points: 30 }), false);
    expect(r.verdict).toBe('notComparable');
    expect(r.delta).toBeNull();
  });

  it('never judges a slot DraftKings concealed', () => {
    const r = reconcileSlot(slot({ dkScore: null, dkStats: null }), true);
    expect(r.verdict).toBe('notComparable');
  });

  it('reads INT as thrown for a quarterback and caught for a defense', () => {
    // Same DK key, opposite meaning. A DST with one interception, priced identically.
    const dst = reconcileSlot(
      slot({
        slot: 'DST',
        position: 'DST',
        name: 'Ravens DST',
        points: 8,
        components: [
          { key: 'interceptions', label: 'Interceptions', quantity: 1, points: 2 },
          { key: 'sacks', label: 'Sacks', quantity: 2, points: 2 },
          { key: 'pointsAllowed', label: 'Points allowed', quantity: 10, points: 4 },
        ],
        dkScore: 8,
        dkStats: [
          { key: 'INT', value: 1, points: 2 },
          { key: 'SACK', value: 2, points: 2 },
          { key: '7-13 PA', value: 1, points: 4 },
        ],
      }),
      true,
    );
    expect(dst.verdict).toBe('agree');
  });

  it('compares the points-allowed TIER, not the raw points conceded', () => {
    // DK's row is a flag named for its range; ours records the actual points allowed. Only
    // the award is comparable — matching them on `value` would fail on every DST.
    const r = reconcileSlot(
      slot({
        slot: 'DST',
        position: 'DST',
        points: 4,
        components: [{ key: 'pointsAllowed', label: 'Points allowed', quantity: 13, points: 4 }],
        dkScore: 1,
        dkStats: [{ key: '14-20 PA', value: 1, points: 1 }],
      }),
      true,
    );
    expect(r.verdict).toBe('ruleDrift');
    expect(r.differences[0]).toMatchObject({ ourKey: 'pointsAllowed', dkPoints: 1, ourPoints: 4 });
  });

  it('catches a stat WE scored that DraftKings never listed', () => {
    // Walking DK's rows alone would miss this entirely.
    const r = reconcileSlot(
      slot({
        points: 15.06,
        components: [
          ...slot().components,
          { key: 'bonus.passYards', label: '300+ passing yards', quantity: 224, points: 3 },
        ],
      }),
      true,
    );
    expect(r.verdict).toBe('statDrift');
    expect(r.differences.some((d) => d.ourKey === 'bonus.passYards')).toBe(true);
  });
});

describe('reconcileWeek', () => {
  it('summarises, and only counts a clean week as clean', () => {
    const s = reconcileWeek([
      { slot: slot(), comparable: true },
      { slot: slot({ name: 'B' }), comparable: true },
      { slot: slot({ name: 'C', dkScore: null }), comparable: true },
    ]);
    expect(s.total).toBe(3);
    expect(s.agree).toBe(2);
    expect(s.notComparable).toBe(1);
    expect(s.maxAbsDelta).toBe(0);
    expect(s.needsAttention).toBe(false);
    expect(s.findings).toEqual([]);
  });

  it('ranks a rule bug above a source disagreement', () => {
    const ruleBug = slot({
      name: 'RuleBug',
      points: 15.42,
      components: [
        { key: 'passTd', label: 'Passing TD', quantity: 1, points: 4 },
        { key: 'passYards', label: 'Passing yards', quantity: 224, points: 11.2 },
        { key: 'rushYards', label: 'Rushing yards', quantity: 1, points: 0.1 },
        { key: 'passInterceptions', label: 'Interception thrown', quantity: 1, points: -1 },
      ],
    });
    const statBug = slot({
      name: 'StatBug',
      points: 40,
      components: [
        { key: 'passTd', label: 'Passing TD', quantity: 1, points: 4 },
        { key: 'passYards', label: 'Passing yards', quantity: 900, points: 36 },
        { key: 'rushYards', label: 'Rushing yards', quantity: 1, points: 0.1 },
        { key: 'passInterceptions', label: 'Interception thrown', quantity: 1, points: -1 },
      ],
    });

    const s = reconcileWeek([
      { slot: statBug, comparable: true },
      { slot: ruleBug, comparable: true },
    ]);
    expect(s.findings[0].playerName).toBe('RuleBug');
    expect(s.ruleDrift).toBe(1);
    expect(s.statDrift).toBe(1);
    expect(s.needsAttention).toBe(true);
  });

  it('does not raise the alarm for a source disagreement alone', () => {
    const s = reconcileWeek([
      {
        slot: slot({
          points: 12.3,
          components: [
            { key: 'passTd', label: 'Passing TD', quantity: 1, points: 4 },
            { key: 'passYards', label: 'Passing yards', quantity: 230, points: 9.2 },
            { key: 'rushYards', label: 'Rushing yards', quantity: 1, points: 0.1 },
            { key: 'passInterceptions', label: 'Interception thrown', quantity: 1, points: -1 },
          ],
        }),
        comparable: true,
      },
    ]);
    expect(s.statDrift).toBe(1);
    expect(s.needsAttention).toBe(false);
  });
});
