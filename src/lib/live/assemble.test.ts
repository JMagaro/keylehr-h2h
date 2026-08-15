/**
 * Tests for the live assembler.
 *
 * The theme running through these: a missing number must never arrive as 0.00. Zero is a real
 * DraftKings result, so anything that isn't a real zero has to be a distinct state — otherwise
 * a mid-Sunday page reads as 32 forfeits.
 */
import { describe, it, expect } from 'vitest';

import { EMPTY_DST_LINE, EMPTY_PLAYER_LINE } from '@/lib/dfs/stat-line';
import type { LineupSlotInput } from '@/lib/lineups/normalize';

import { assembleLive, type AssembleMatchup, type AssembleSnapshot } from './assemble';
import { playerStatKey, type LiveStatIndex } from './stats';

/* -------------------------------------------------------------------------- */
/* fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const slot = (over: Partial<LineupSlotInput> = {}): LineupSlotInput => ({
  slot: 'WR',
  dkPlayerId: null,
  draftableId: '1',
  name: 'Puka Nacua',
  teamKey: 'LAR',
  position: 'WR',
  revealed: true,
  dkScore: null,
  dkStats: null,
  dkProjection: null,
  ...over,
});

const concealed = (s: string): LineupSlotInput =>
  slot({ slot: s, draftableId: null, name: null, teamKey: null, position: null, revealed: false });

function makeIndex(over: Partial<LiveStatIndex> = {}): LiveStatIndex {
  return {
    players: {},
    defenses: {},
    teamState: {},
    games: [],
    gamesLoaded: 1,
    gamesTotal: 1,
    fetchedAt: 1_700_000_000_000,
    ...over,
  };
}

/** An index where Nacua has 8 catches for 100 yards and a TD, and LAR's game is live. */
function nacuaIndex(): LiveStatIndex {
  return makeIndex({
    players: {
      [playerStatKey('Puka Nacua', 'LAR')]: {
        name: 'Puka Nacua',
        teamKey: 'LAR',
        line: { ...EMPTY_PLAYER_LINE, receptions: 8, recYards: 100, recTd: 1 },
      },
    },
    teamState: { LAR: { state: 'in', detail: '8:30 - 3rd Quarter', period: 3, displayClock: '8:30' } },
  });
}

const MATCHUP: AssembleMatchup = {
  id: 1,
  home: { ownerSeasonId: 10, ownerName: 'magaro', teamKey: 'BUF', logoEspn: null },
  away: { ownerSeasonId: 20, ownerName: 'lehr', teamKey: 'PHI', logoEspn: null },
};

const snap = (ownerSeasonId: number, slots: LineupSlotInput[], at = '2026-08-15T20:00:00Z'): AssembleSnapshot => ({
  ownerSeasonId,
  capturedAt: new Date(at),
  slots,
});

/* -------------------------------------------------------------------------- */

describe('assembleLive — scoring', () => {
  it('scores a matched player and exposes the per-rule breakdown', () => {
    const view = assembleLive([MATCHUP], [snap(10, [slot()])], nacuaIndex());
    const s = view.matchups[0].home.slots[0];

    // 8 rec (8) + 100 yds (10) + TD (6) + 100-yard bonus (3) = 27
    expect(s.status).toBe('scored');
    expect(s.points).toBe(27);
    expect(view.matchups[0].home.points).toBe(27);
    expect(s.components.length).toBeGreaterThan(0);
    expect(s.gameDetail).toBe('8:30 - 3rd Quarter');
  });

  it('understates rather than invents when a player’s game could not be loaded', () => {
    // MIA is absent from the index entirely — that game never loaded — so this player is
    // unknown, contributes nothing, and the total is explicitly a floor.
    const view = assembleLive(
      [MATCHUP],
      [snap(10, [slot(), slot({ name: 'Nobody Here', teamKey: 'MIA', draftableId: '2' })])],
      nacuaIndex(),
    );
    const team = view.matchups[0].home;
    expect(team.points).toBe(27);
    expect(team.scored).toBe(1);
    expect(team.unresolved).toBe(1);
  });

  it('scores a DST from the defenses index', () => {
    const view = assembleLive(
      [MATCHUP],
      [snap(10, [slot({ slot: 'DST', position: 'DST', name: 'Rams', teamKey: 'LAR' })])],
      makeIndex({
        defenses: { LAR: { teamKey: 'LAR', line: { ...EMPTY_DST_LINE, sacks: 3, interceptions: 1, pointsAllowed: 10 } } },
        teamState: { LAR: { state: 'in', detail: 'Halftime', period: 2, displayClock: null } },
      }),
    );
    // 3 sacks (3) + 1 INT (2) + 10 points allowed, the 7–13 tier (4) = 9
    expect(view.matchups[0].home.slots[0].points).toBe(9);
  });

  it('treats a genuine zero as scored, not as missing', () => {
    // The distinction this protects: a player who played and did nothing IS 0.00, and must
    // not be lumped in with players we simply could not find.
    const view = assembleLive(
      [MATCHUP],
      [snap(10, [slot({ name: 'Quiet Guy', teamKey: 'LAR' })])],
      makeIndex({
        players: {
          [playerStatKey('Quiet Guy', 'LAR')]: {
            name: 'Quiet Guy',
            teamKey: 'LAR',
            line: EMPTY_PLAYER_LINE,
          },
        },
        teamState: { LAR: { state: 'in', detail: 'Q2', period: 2, displayClock: '5:00' } },
      }),
    );
    const s = view.matchups[0].home.slots[0];
    expect(s.status).toBe('scored');
    expect(s.points).toBe(0);
    expect(view.matchups[0].home.unresolved).toBe(0);
  });
});

describe('assembleLive — the four non-scored states never become 0.00', () => {
  it('marks a player whose game has not kicked off as pending, with null points', () => {
    const view = assembleLive(
      [MATCHUP],
      [snap(10, [slot()])],
      makeIndex({ teamState: { LAR: { state: 'pre', detail: '8:20 PM ET', period: null, displayClock: null } } }),
    );
    const s = view.matchups[0].home.slots[0];
    expect(s.status).toBe('pending');
    expect(s.points).toBeNull();
    expect(view.matchups[0].home.pending).toBe(1);
  });

  it('marks a DraftKings-concealed slot as concealed, keeping the roster position', () => {
    const view = assembleLive([MATCHUP], [snap(10, [concealed('FLEX')])], nacuaIndex());
    const s = view.matchups[0].home.slots[0];
    expect(s.status).toBe('concealed');
    expect(s.points).toBeNull();
    expect(s.name).toBeNull();
    // The slot itself is still known — that is what makes the display honest.
    expect(s.slot).toBe('FLEX');
    expect(view.matchups[0].home.concealed).toBe(1);
  });

  it('marks a player whose game did NOT load as unresolved, never zero', () => {
    // No teamState for MIA means we never loaded that game, so we genuinely cannot say.
    const view = assembleLive(
      [MATCHUP],
      [snap(10, [slot({ name: 'Ghost Player', teamKey: 'MIA' })])],
      nacuaIndex(),
    );
    const s = view.matchups[0].home.slots[0];
    expect(s.status).toBe('unresolved');
    expect(s.points).toBeNull();
    expect(view.matchups[0].home.unresolved).toBe(1);
  });

  it('marks a revealed player with no team as unresolved — enrichment failed', () => {
    const view = assembleLive([MATCHUP], [snap(10, [slot({ teamKey: null })])], nacuaIndex());
    expect(view.matchups[0].home.slots[0].status).toBe('unresolved');
  });

  it('scores a playing-but-statless player as a real 0, counted separately', () => {
    // Measured against a live capture: ESPN lists only players who recorded a stat, so a
    // receiver who has caught nothing is simply absent from a boxscore we DID load. DK pays
    // 0 for exactly this. Calling it "unresolved" would paint `?` over half a roster.
    const view = assembleLive(
      [MATCHUP],
      [snap(10, [slot(), slot({ name: 'Quiet Starter', draftableId: '2' })])],
      nacuaIndex(),
    );
    const team = view.matchups[0].home;
    const quiet = team.slots[1];
    expect(quiet.status).toBe('noStats');
    expect(quiet.points).toBe(0);
    expect(team.noStats).toBe(1);
    expect(team.unresolved).toBe(0);
    // Their explicit zero does not disturb the total.
    expect(team.points).toBe(27);
  });

  it('keeps a MISSING defense unresolved rather than zeroing it', () => {
    // A defense always has a row in a loaded boxscore (points allowed alone guarantees one),
    // so unlike a skill player, its absence is genuinely unexplained.
    const view = assembleLive(
      [MATCHUP],
      [snap(10, [slot({ slot: 'DST', position: 'DST', name: 'Rams', teamKey: 'LAR' })])],
      nacuaIndex(),
    );
    const s = view.matchups[0].home.slots[0];
    expect(s.status).toBe('unresolved');
    expect(s.points).toBeNull();
  });

  it('reports an owner with NO capture as hasSnapshot:false and names them', () => {
    // The load-bearing case: this must be readable as "not captured", never as a 0.00 that
    // the eye reads as a forfeit.
    const view = assembleLive([MATCHUP], [snap(10, [slot()])], nacuaIndex());
    const away = view.matchups[0].away;
    expect(away.hasSnapshot).toBe(false);
    expect(away.slots).toEqual([]);
    expect(away.capturedAt).toBeNull();
    expect(view.missingCaptures).toEqual(['lehr']);
  });
});

describe('assembleLive — late swap', () => {
  it('uses the NEWEST capture per owner', () => {
    // Captures are append-only precisely because DK Classic allows late swap. Scoring an
    // older version would silently score players the owner already swapped out.
    const view = assembleLive(
      [MATCHUP],
      [
        snap(10, [slot({ name: 'Old Pick' })], '2026-08-15T17:00:00Z'),
        snap(10, [slot()], '2026-08-15T20:00:00Z'),
      ],
      nacuaIndex(),
    );
    const team = view.matchups[0].home;
    expect(team.slots[0].name).toBe('Puka Nacua');
    expect(team.points).toBe(27);
    expect(team.capturedAt).toEqual(new Date('2026-08-15T20:00:00Z'));
  });

  it('is order-independent — an older capture posted late does not win', () => {
    const view = assembleLive(
      [MATCHUP],
      [
        snap(10, [slot()], '2026-08-15T20:00:00Z'),
        snap(10, [slot({ name: 'Old Pick' })], '2026-08-15T17:00:00Z'),
      ],
      nacuaIndex(),
    );
    expect(view.matchups[0].home.slots[0].name).toBe('Puka Nacua');
  });

  it('reports the latest capture across all owners', () => {
    const view = assembleLive(
      [MATCHUP],
      [
        snap(10, [slot()], '2026-08-15T17:00:00Z'),
        snap(20, [slot()], '2026-08-15T21:30:00Z'),
      ],
      nacuaIndex(),
    );
    expect(view.latestCapturedAt).toEqual(new Date('2026-08-15T21:30:00Z'));
  });
});

describe('assembleLive — degradation', () => {
  it('passes through a partial slate rather than hiding it', () => {
    const view = assembleLive([MATCHUP], [], makeIndex({ gamesLoaded: 15, gamesTotal: 16 }));
    expect(view.gamesLoaded).toBe(15);
    expect(view.gamesTotal).toBe(16);
  });

  it('renders matchups with no captures at all instead of throwing', () => {
    const view = assembleLive([MATCHUP], [], makeIndex());
    expect(view.matchups).toHaveLength(1);
    expect(view.missingCaptures.sort()).toEqual(['lehr', 'magaro']);
    expect(view.matchups[0].home.points).toBe(0);
    // points is 0 only because nothing scored — hasSnapshot is what the UI must branch on.
    expect(view.matchups[0].home.hasSnapshot).toBe(false);
  });

  it('handles an empty week', () => {
    const view = assembleLive([], [], makeIndex({ gamesTotal: 0, gamesLoaded: 0 }));
    expect(view.matchups).toEqual([]);
    expect(view.latestCapturedAt).toBeNull();
  });
});
