/**
 * Tests for roster normalization.
 *
 * Two kinds of fixture here, and the distinction matters:
 *
 *   - `scripts/fixtures/dk-roster-entry.json` is a REAL capture from DraftKings' roster
 *     endpoint (2026-08-15). It is the authority on the shape.
 *   - The inline fixtures are MODELLED on shapes DK uses elsewhere (the leaderboard embed,
 *     draftables). They stay because the normalizer is deliberately structural and must keep
 *     coping with shapes we have not seen — DK varies its payloads across endpoints.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

import { normalizeRosterPayload, looksLikeRosterSlot, normalizeSlotObject } from './normalize';

/** The real DraftKings roster payload. */
const DK_REAL = JSON.parse(
  readFileSync(new URL('../../../scripts/fixtures/dk-roster-entry.json', import.meta.url), 'utf8'),
);

describe('looksLikeRosterSlot', () => {
  it('requires an id plus a slot or a name', () => {
    expect(looksLikeRosterSlot({ playerId: 123, rosterPosition: 'QB' })).toBe(true);
    expect(looksLikeRosterSlot({ draftableId: 9, displayName: 'Josh Allen' })).toBe(true);
    // No id — a display-only object must not qualify.
    expect(looksLikeRosterSlot({ rosterPosition: 'QB', displayName: 'Josh Allen' })).toBe(false);
    // Id alone is not enough.
    expect(looksLikeRosterSlot({ playerId: 123 })).toBe(false);
    expect(looksLikeRosterSlot(null)).toBe(false);
    expect(looksLikeRosterSlot([1, 2])).toBe(false);
  });
});

describe('normalizeSlotObject', () => {
  it('normalizes ids, names, team keys and slots', () => {
    expect(
      normalizeSlotObject({
        draftableId: 43834727,
        playerId: 748070,
        rosterPosition: 'QB',
        position: 'QB',
        displayName: 'Baker Mayfield',
        teamAbbreviation: 'TB',
      }),
    ).toEqual({
      slot: 'QB',
      dkPlayerId: '748070',
      draftableId: '43834727',
      name: 'Baker Mayfield',
      teamKey: 'TB',
      position: 'QB',
      revealed: true,
      dkScore: null,
      dkStats: null,
      dkProjection: null,
    });
  });

  it('applies the shared team-key fixups', () => {
    expect(normalizeSlotObject({ playerId: 1, position: 'WR', teamAbbreviation: 'WAS' }).teamKey).toBe('WSH');
    expect(normalizeSlotObject({ playerId: 2, position: 'RB', teamAbbreviation: 'JAC' }).teamKey).toBe('JAX');
  });

  it('collapses DEF/D to DST', () => {
    expect(normalizeSlotObject({ playerId: 3, rosterPosition: 'DEF' }).slot).toBe('DST');
    expect(normalizeSlotObject({ playerId: 4, rosterPosition: 'D' }).slot).toBe('DST');
    expect(normalizeSlotObject({ playerId: 5, position: 'DST' }).slot).toBe('DST');
  });

  it('builds a name from firstName/lastName when there is no display name', () => {
    expect(normalizeSlotObject({ playerId: 6, position: 'TE', firstName: 'Trey', lastName: 'McBride' }).name).toBe(
      'Trey McBride',
    );
  });

  it('falls back to position when DK omits the roster slot', () => {
    expect(normalizeSlotObject({ playerId: 7, position: 'WR' }).slot).toBe('WR');
  });
});

describe('normalizeSlotObject — DraftKings’ own stat line', () => {
  // Verbatim from a live capture (2026-08-15, JAX @ NO, 2nd quarter). DK scores 1.5:
  // 5 receiving yards (0.5) + 1 reception (1.0). Targets are listed but pay nothing.
  const TRAMMELL = {
    displayName: 'Austin Trammell',
    rosterPosition: 'WR',
    draftableId: 43836765,
    score: 1.5,
    stats: [
      { statId: 40, name: 'Receiving Yards', abbreviation: 'RecYds', fantasyPoints: 0.5, statValue: 5, contributesToScoring: true },
      { statId: 44, name: 'Receptions', abbreviation: 'REC', fantasyPoints: 1, statValue: 1, contributesToScoring: true },
      { statId: 467, name: 'Targets', abbreviation: 'Targets', fantasyPoints: 0, statValue: 2, contributesToScoring: false },
    ],
  };

  it('captures the per-stat breakdown, keyed by DraftKings’ own abbreviations', () => {
    expect(normalizeSlotObject(TRAMMELL).dkStats).toEqual([
      { key: 'RecYds', value: 5, points: 0.5 },
      { key: 'REC', value: 1, points: 1 },
      { key: 'Targets', value: 2, points: 0 },
    ]);
  });

  it('keeps non-scoring stats — they are evidence even when they pay nothing', () => {
    // Targets don't score in DK Classic, but knowing a receiver saw 2 of them is exactly the
    // kind of detail that explains a discrepancy against ESPN.
    const stats = normalizeSlotObject(TRAMMELL).dkStats!;
    expect(stats.find((s) => s.key === 'Targets')).toEqual({ key: 'Targets', value: 2, points: 0 });
  });

  it('sums to DraftKings’ own total', () => {
    const stats = normalizeSlotObject(TRAMMELL).dkStats!;
    const total = stats.reduce((n, s) => n + s.points, 0);
    expect(total).toBeCloseTo(normalizeSlotObject(TRAMMELL).dkScore!, 5);
  });

  it('handles a negative stat value (lost yardage)', () => {
    // Audric Estime, same capture: -6 receiving yards is -0.6 points.
    const stats = normalizeSlotObject({
      displayName: 'Audric Estime',
      rosterPosition: 'FLEX',
      draftableId: 43836676,
      score: 9.2,
      stats: [
        { abbreviation: 'RuTD', fantasyPoints: 6, statValue: 1 },
        { abbreviation: 'RecYds', fantasyPoints: -0.6, statValue: -6 },
        { abbreviation: 'RuYds', fantasyPoints: 2.8, statValue: 28 },
      ],
    }).dkStats!;
    expect(stats).toEqual([
      { key: 'RuTD', value: 1, points: 6 },
      { key: 'RecYds', value: -6, points: -0.6 },
      { key: 'RuYds', value: 28, points: 2.8 },
    ]);
  });

  it('distinguishes “no stats yet” from “no stat breakdown in this payload”', () => {
    // DK sends `stats: []` for a player whose game is live but who has not done anything.
    expect(normalizeSlotObject({ draftableId: 1, rosterPosition: 'QB', score: 0, stats: [] }).dkStats).toEqual([]);
    // A payload with no stats array at all says nothing about the player.
    expect(normalizeSlotObject({ draftableId: 1, rosterPosition: 'QB', score: 0 }).dkStats).toBeNull();
  });

  it('never claims a stat line for a concealed player', () => {
    expect(normalizeSlotObject({ draftableId: 0, rosterPosition: 'QB', yetToPlay: true }).dkStats).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

const slot = (id: number, pos: string, name: string, team: string, rosterPos?: string) => ({
  draftableId: id,
  playerId: id * 10,
  rosterPosition: rosterPos ?? pos,
  position: pos,
  displayName: name,
  teamAbbreviation: team,
});

const NINE = [
  slot(1, 'QB', 'Josh Allen', 'BUF'),
  slot(2, 'RB', 'Bijan Robinson', 'ATL'),
  slot(3, 'RB', 'De%27Von Achane', 'MIA'),
  slot(4, 'WR', 'Ja%27Marr Chase', 'CIN'),
  slot(5, 'WR', 'Justin Jefferson', 'MIN'),
  slot(6, 'WR', 'Puka Nacua', 'LAR'),
  slot(7, 'TE', 'Trey McBride', 'ARI'),
  slot(8, 'RB', 'Saquon Barkley', 'PHI', 'FLEX'),
  slot(9, 'DST', 'Eagles', 'PHI'),
];

describe('normalizeRosterPayload — shape 1: bulk leaderboard with embedded rosters', () => {
  const payload = {
    leaderBoard: [
      { userName: 'magaro', entryKey: '111', fantasyPoints: 143.2, roster: { scorecards: NINE } },
      { userName: 'lehr', entryKey: '222', fantasyPoints: 121.7, roster: { scorecards: NINE.slice(0, 9) } },
    ],
  };

  it('extracts one lineup per entry', () => {
    const { lineups, skipped } = normalizeRosterPayload(payload);
    expect(skipped).toBe(0);
    expect(lineups).toHaveLength(2);
    expect(lineups.map((l) => l.entryName)).toEqual(['magaro', 'lehr']);
    expect(lineups[0].entryKey).toBe('111');
    expect(lineups[0].slots).toHaveLength(9);
  });

  it('keeps the FLEX slot distinct from the player’s position', () => {
    const { lineups } = normalizeRosterPayload(payload);
    const flex = lineups[0].slots.find((s) => s.slot === 'FLEX');
    expect(flex).toBeDefined();
    expect(flex!.position).toBe('RB');
    expect(flex!.name).toBe('Saquon Barkley');
  });
});

describe('normalizeRosterPayload — shape 2: single entry with a roster', () => {
  it('extracts one lineup', () => {
    const { lineups } = normalizeRosterPayload({
      entryName: 'magaro',
      entryKey: '111',
      lineup: NINE,
    });
    expect(lineups).toHaveLength(1);
    expect(lineups[0].entryName).toBe('magaro');
    expect(lineups[0].slots).toHaveLength(9);
  });
});

describe('normalizeRosterPayload — shape 3: bare roster array', () => {
  it('uses the caller-supplied entry name', () => {
    const { lineups } = normalizeRosterPayload(NINE, 'magaro');
    expect(lineups).toHaveLength(1);
    expect(lineups[0].entryName).toBe('magaro');
    expect(lineups[0].slots).toHaveLength(9);
  });

  it('refuses to guess an owner when there is no name anywhere', () => {
    const { lineups, skipped } = normalizeRosterPayload(NINE);
    expect(lineups).toHaveLength(0);
    expect(skipped).toBe(1);
  });
});

describe('normalizeRosterPayload — the REAL DraftKings payload', () => {
  // GET scores/v2/entries/{draftGroupId}/{entryKey}?format=json&embed=roster
  // Shape: { entries: [ { roster: { scorecards: [...9] } } ] }
  const { lineups, skipped } = normalizeRosterPayload(DK_REAL, 'DocGSL');
  const lineup = lineups[0];

  it('extracts one lineup, attributed to the caller-supplied entry name', () => {
    // DK's per-entry response carries no entry name — the caller asked for a known entryKey.
    expect(skipped).toBe(0);
    expect(lineups).toHaveLength(1);
    expect(lineup.entryName).toBe('DocGSL');
  });

  it('keeps all NINE slots, including the concealed ones', () => {
    // The regression this guards: every concealed slot arrives as draftableId 0 with no name,
    // so de-duplicating them by id collapsed five pending slots into one and turned a 9-man
    // lineup into a 5-man one.
    expect(lineup.slots).toHaveLength(9);
    expect(lineup.slots.map((s) => s.slot)).toEqual([
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

  it('marks players whose games have started as revealed', () => {
    const revealed = lineup.slots.filter((s) => s.revealed);
    expect(revealed.map((s) => s.name)).toEqual([
      'Ameer Abdullah',
      'Jakobi Meyers',
      'Terrance Ferguson',
      'Rams',
    ]);
    expect(revealed.map((s) => s.draftableId)).toEqual([
      '43836582',
      '43836540',
      '43836558',
      '43836601',
    ]);
  });

  it('marks players whose games have NOT started as concealed, with no identity', () => {
    const concealed = lineup.slots.filter((s) => !s.revealed);
    expect(concealed).toHaveLength(5);
    for (const s of concealed) {
      // draftableId 0 is "absent", not "player zero" — it must not survive as an id.
      expect(s.draftableId).toBeNull();
      expect(s.dkPlayerId).toBeNull();
      expect(s.name).toBeNull();
      expect(s.dkScore).toBeNull();
      // The slot itself is still known, which is what makes the UI honest.
      expect(s.slot).not.toBeNull();
    }
  });

  it('captures DraftKings’ own per-player score for revealed players', () => {
    const abdullah = lineup.slots.find((s) => s.name === 'Ameer Abdullah');
    expect(abdullah!.dkScore).toBe(0);
  });

  it('leaves teamKey null — DK’s roster payload has no team abbreviation', () => {
    // Team is resolved later from draftableId via the PUBLIC draftables endpoint. Asserting
    // it here documents the gap rather than letting it surprise someone downstream.
    expect(lineup.slots.every((s) => s.teamKey === null)).toBe(true);
  });

  it('trims DraftKings’ padded DST display name', () => {
    // DK sends displayName "Rams " with a trailing space and lastName "".
    expect(lineup.slots.find((s) => s.slot === 'DST')!.name).toBe('Rams');
  });
});

describe('normalizeRosterPayload — robustness', () => {
  it('handles a keyed map of entries (DK does this for leaderboards)', () => {
    const { lineups } = normalizeRosterPayload({
      leaderBoardUserEntries: {
        entryByEntryKey: {
          '111': { userName: 'magaro', entryKey: '111', roster: NINE },
          '222': { userName: 'lehr', entryKey: '222', roster: NINE },
          '333': { userName: 'smith', entryKey: '333', roster: NINE },
        },
      },
    });
    expect(lineups.map((l) => l.entryName).sort()).toEqual(['lehr', 'magaro', 'smith']);
  });

  it('tolerates deep nesting and unknown wrapper keys', () => {
    const { lineups } = normalizeRosterPayload({
      data: { contest: { standings: { rows: [{ screenName: 'magaro', playerRoster: NINE }] } } },
    });
    expect(lineups).toHaveLength(1);
    expect(lineups[0].slots).toHaveLength(9);
  });

  it('de-dupes repeated players within a lineup', () => {
    const { lineups } = normalizeRosterPayload({
      entryName: 'magaro',
      lineup: [...NINE, NINE[0], NINE[1]],
    });
    expect(lineups[0].slots).toHaveLength(9);
  });

  it('de-dupes repeated entries by key, then by name', () => {
    const { lineups } = normalizeRosterPayload({
      a: [{ userName: 'magaro', entryKey: '111', roster: NINE }],
      b: [{ userName: 'magaro', entryKey: '111', roster: NINE }],
    });
    expect(lineups).toHaveLength(1);
  });

  it('skips an entry that names someone but carries no players', () => {
    const { lineups, skipped } = normalizeRosterPayload({
      leaderBoard: [
        { userName: 'magaro', roster: NINE },
        { userName: 'empty', fantasyPoints: 0 },
      ],
    });
    expect(lineups).toHaveLength(1);
    expect(lineups[0].entryName).toBe('magaro');
    // The empty entry never looked like a lineup, so it is not even counted as skipped.
    expect(skipped).toBe(0);
  });

  it('returns nothing for junk instead of throwing', () => {
    for (const junk of [null, undefined, 42, 'nope', {}, [], { foo: { bar: 1 } }]) {
      expect(() => normalizeRosterPayload(junk)).not.toThrow();
      expect(normalizeRosterPayload(junk).lineups).toEqual([]);
    }
  });
});
