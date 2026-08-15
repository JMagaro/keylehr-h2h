/**
 * Tests for draftableId → identity enrichment.
 *
 * Driven by the REAL DraftKings roster payload, because the thing under test only exists
 * because of a property of that payload: it names no team.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

import type { DraftableIdentity } from '@/lib/draftkings/draftables';

import { applyDraftableIndex } from './enrich';
import { normalizeRosterPayload } from './normalize';

const DK_REAL = JSON.parse(
  readFileSync(new URL('../../../scripts/fixtures/dk-roster-entry.json', import.meta.url), 'utf8'),
);

/** The four revealed players in the real capture, as the public draftables endpoint has them. */
const INDEX = new Map<string, DraftableIdentity>([
  ['43836582', { dkPlayerId: '1180254', name: 'Ameer Abdullah', teamKey: 'JAX', position: 'RB' }],
  ['43836540', { dkPlayerId: '844433', name: 'Jakobi Meyers', teamKey: 'JAX', position: 'WR' }],
  ['43836558', { dkPlayerId: '1509434', name: 'Terrance Ferguson', teamKey: 'LAR', position: 'TE' }],
  ['43836601', { dkPlayerId: '4321', name: 'Rams', teamKey: 'LAR', position: 'DST' }],
]);

const capture = () => normalizeRosterPayload(DK_REAL, 'DocGSL').lineups;

describe('applyDraftableIndex', () => {
  it('fills in the team and position DraftKings omits', () => {
    const { lineups, enriched, unresolvedIds } = applyDraftableIndex(capture(), INDEX);
    expect(enriched).toBe(4);
    expect(unresolvedIds).toEqual([]);

    const revealed = lineups[0].slots.filter((s) => s.revealed);
    expect(revealed.map((s) => [s.name, s.teamKey, s.position])).toEqual([
      ['Ameer Abdullah', 'JAX', 'RB'],
      ['Jakobi Meyers', 'JAX', 'WR'],
      ['Terrance Ferguson', 'LAR', 'TE'],
      ['Rams', 'LAR', 'DST'],
    ]);
  });

  it('keeps the roster slot distinct from the resolved position', () => {
    // Abdullah is a RB in a RB slot here, but the general case matters: enrichment writes
    // `position`, never `slot`. A FLEX must stay a FLEX.
    const { lineups } = applyDraftableIndex(capture(), INDEX);
    expect(lineups[0].slots.map((s) => s.slot)).toEqual([
      'QB',
      'RB',
      'RB',
      'WR',
      'WR',
      'WR',
      'TE',
      'FLEX',
      'DST',
    ]);
  });

  it('leaves concealed slots untouched and does not count them as unresolved', () => {
    const { lineups, unresolvedIds } = applyDraftableIndex(capture(), INDEX);
    const concealed = lineups[0].slots.filter((s) => !s.revealed);
    expect(concealed).toHaveLength(5);
    for (const s of concealed) {
      expect(s.teamKey).toBeNull();
      expect(s.name).toBeNull();
    }
    // A player whose game hasn't started is expected to be anonymous — not a lookup failure.
    expect(unresolvedIds).toEqual([]);
  });

  it('reports a revealed id the draft group does not know, rather than dropping it', () => {
    const partial = new Map([...INDEX].slice(0, 2));
    const { lineups, enriched, unresolvedIds } = applyDraftableIndex(capture(), partial);
    expect(enriched).toBe(2);
    expect(unresolvedIds.sort()).toEqual(['43836558', '43836601']);
    // The slot survives with its name intact — an unresolved player must never vanish.
    const ferguson = lineups[0].slots.find((s) => s.draftableId === '43836558');
    expect(ferguson!.name).toBe('Terrance Ferguson');
    expect(ferguson!.teamKey).toBeNull();
  });

  it('never overwrites a value the capture already had', () => {
    const wrong = new Map<string, DraftableIdentity>([
      ['43836582', { dkPlayerId: '9', name: 'Someone Else', teamKey: 'BUF', position: 'QB' }],
    ]);
    const { lineups, enriched } = applyDraftableIndex(
      [
        {
          entryName: 'magaro',
          entryKey: '1',
          slots: [
            {
              slot: 'RB',
              dkPlayerId: null,
              draftableId: '43836582',
              name: 'Ameer Abdullah',
              teamKey: 'JAX',
              position: 'RB',
              revealed: true,
              dkScore: 3.4,
              dkStats: null,
              dkProjection: null,
            },
          ],
        },
      ],
      wrong,
    );
    const slot = lineups[0].slots[0];
    expect(slot.name).toBe('Ameer Abdullah');
    expect(slot.teamKey).toBe('JAX');
    expect(slot.position).toBe('RB');
    // Only the genuinely-missing field is written.
    expect(slot.dkPlayerId).toBe('9');
    expect(enriched).toBe(0);
  });

  it('passes lineups through unchanged when the index is empty', () => {
    const before = capture();
    const { lineups, enriched, unresolvedIds } = applyDraftableIndex(before, new Map());
    expect(enriched).toBe(0);
    // Every revealed id is reported so an empty index is loud, not silent.
    expect(unresolvedIds).toHaveLength(4);
    expect(lineups[0].slots).toEqual(before[0].slots);
  });

  it('does not mutate its input', () => {
    const before = capture();
    const snapshot = JSON.parse(JSON.stringify(before));
    applyDraftableIndex(before, INDEX);
    expect(before).toEqual(snapshot);
  });
});
