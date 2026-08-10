/**
 * Unit tests for superseded-bracket-row detection.
 *
 * The rule: when a round is rewritten, any existing row of THAT round which is not part of
 * the new pairing set is stale and must go. Rounds not being written are never touched.
 */
import { describe, it, expect } from 'vitest';
import { staleGameIds, type DesiredGame, type ExistingGameRow } from './prune';

function existing(
  id: number,
  round: string,
  conference: string | null,
  highSeed: number,
  lowSeed: number,
): ExistingGameRow {
  return { id, round, conference, highSeed, lowSeed };
}

function desired(round: string, conference: string | null, highSeed: number, lowSeed: number): DesiredGame {
  return { round, conference, highSeed, lowSeed };
}

describe('staleGameIds', () => {
  it('marks nothing stale when the pairings are unchanged', () => {
    const rows = [existing(1, 'divisional', 'AFC', 1, 7), existing(2, 'divisional', 'AFC', 2, 3)];
    const next = [desired('divisional', 'AFC', 1, 7), desired('divisional', 'AFC', 2, 3)];
    expect(staleGameIds(rows, next)).toEqual([]);
  });

  it('marks the superseded row when an override changes a pairing', () => {
    // The real sequence: wild card resolves 1v7, the commissioner overrides the 2v7 result,
    // advancePlayoffs re-runs and now wants 1v6. Without pruning both rows survive and the
    // AFC ends up with three advancing owners.
    const rows = [existing(1, 'divisional', 'AFC', 1, 7), existing(2, 'divisional', 'AFC', 2, 3)];
    const next = [desired('divisional', 'AFC', 1, 6), desired('divisional', 'AFC', 2, 3)];
    expect(staleGameIds(rows, next)).toEqual([1]);
  });

  it('never touches a round it is not writing', () => {
    const rows = [
      existing(1, 'wild_card', 'AFC', 2, 7),
      existing(2, 'divisional', 'AFC', 1, 7),
    ];
    const next = [desired('divisional', 'AFC', 1, 6)];
    expect(staleGameIds(rows, next)).toEqual([2]);
  });

  it('does not touch the other conference when only one is written', () => {
    // advanceBracket returns a whole round across both conferences today, so this cannot
    // happen yet — but scoping authority to (round, conference) means a future per-conference
    // caller can never wipe the conference it wasn't writing.
    const rows = [existing(1, 'divisional', 'AFC', 1, 7), existing(2, 'divisional', 'NFC', 1, 7)];
    const next = [desired('divisional', 'AFC', 1, 6)];
    expect(staleGameIds(rows, next)).toEqual([1]);
  });

  it('handles the championship, which has a null conference', () => {
    const rows = [existing(1, 'championship', null, 1, 2)];
    expect(staleGameIds(rows, [desired('championship', null, 1, 2)])).toEqual([]);
    expect(staleGameIds(rows, [desired('championship', null, 1, 3)])).toEqual([1]);
  });

  it('deletes nothing when asked to write no games', () => {
    const rows = [existing(1, 'divisional', 'AFC', 1, 7)];
    expect(staleGameIds(rows, [])).toEqual([]);
  });
});
