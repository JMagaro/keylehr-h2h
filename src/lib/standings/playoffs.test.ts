/**
 * Unit tests for bracket construction & advancement.
 * Covers initial wild-card pairings (2v7, 3v6, 4v5; #1 bye), NFL reseeding
 * across rounds, and the cross-conference championship pairing.
 */
import { describe, it, expect } from 'vitest';
import { advanceBracket, seedInitialBracket } from './playoffs';
import type { Conference, PlayoffConfig, PlayoffGameResult, SeededOwner } from './types';

/** Build a conference's 7 seeds with ownerSeasonId = `base + seed`. */
function seedsFor(conference: Conference, base: number): SeededOwner[] {
  const out: SeededOwner[] = [];
  for (let seed = 1; seed <= 7; seed++) {
    out.push({
      seed,
      ownerSeasonId: base + seed,
      kind: seed <= 4 ? 'division_winner' : 'wild_card',
      conference,
      division: 'East',
      isBye: seed === 1,
      wins: 12 - seed,
      losses: seed,
      ties: 0,
      gamesPlayed: 12,
      pointsFor: 1000 - seed,
      pointsAgainst: 500,
      winPct: (12 - seed) / 12,
      streak: 'W1',
    });
  }
  return out;
}

const SEEDS: Record<Conference, SeededOwner[]> = {
  AFC: seedsFor('AFC', 0), // owner ids 1..7
  NFC: seedsFor('NFC', 100), // owner ids 101..107
};

/** Build a playoff game result with an explicit winner. */
function result(
  conference: Conference | null,
  highSeed: number,
  lowSeed: number,
  highId: number,
  lowId: number,
  winnerId: number,
): PlayoffGameResult {
  return {
    conference,
    highSeed,
    lowSeed,
    highOwnerSeasonId: highId,
    lowOwnerSeasonId: lowId,
    highPoints: winnerId === highId ? 100 : 50,
    lowPoints: winnerId === lowId ? 100 : 50,
    winnerOwnerSeasonId: winnerId,
  };
}

describe('seedInitialBracket — wild-card pairings', () => {
  it('pairs 2v7, 3v6, 4v5 per conference and gives #1 a bye', () => {
    const games = seedInitialBracket(SEEDS);
    // 3 games per conference, AFC then NFC.
    expect(games).toHaveLength(6);

    const afc = games.filter((g) => g.conference === 'AFC');
    expect(afc.map((g) => [g.highSeed, g.lowSeed])).toEqual([
      [2, 7],
      [3, 6],
      [4, 5],
    ]);
    // No game involves seed 1 (bye).
    expect(games.every((g) => g.highSeed !== 1 && g.lowSeed !== 1)).toBe(true);
    // Owner ids line up with seeds (AFC base 0).
    const game27 = afc[0];
    expect(game27.highOwnerSeasonId).toBe(2);
    expect(game27.lowOwnerSeasonId).toBe(7);
    expect(game27.round).toBe('wild_card');
  });
});

describe('advanceBracket — wild_card → divisional reseeding', () => {
  it('reseeds the bye #1 plus 3 winners: 1 v worst, then middle two', () => {
    // AFC: seeds 2,3,4 all win (lowest seed advancing besides bye is 4).
    // Divisional reseed: [1,2,3,4] -> 1v4 and 2v3.
    const wcResults: PlayoffGameResult[] = [
      result('AFC', 2, 7, 2, 7, 2),
      result('AFC', 3, 6, 3, 6, 3),
      result('AFC', 4, 5, 4, 5, 4),
      result('NFC', 2, 7, 102, 107, 102),
      result('NFC', 3, 6, 103, 106, 103),
      result('NFC', 4, 5, 104, 105, 104),
    ];
    const byes: Record<Conference, SeededOwner> = {
      AFC: SEEDS.AFC[0],
      NFC: SEEDS.NFC[0],
    };
    const div = advanceBracket('wild_card', wcResults, byes);

    const afc = div.filter((g) => g.conference === 'AFC');
    expect(afc).toHaveLength(2);
    expect(afc.map((g) => [g.highSeed, g.lowSeed])).toEqual([
      [1, 4],
      [2, 3],
    ]);
    expect(afc[0].round).toBe('divisional');
    expect(afc[0].highOwnerSeasonId).toBe(1);
    expect(afc[0].lowOwnerSeasonId).toBe(4);

    // NFC mirrors.
    const nfc = div.filter((g) => g.conference === 'NFC');
    expect(nfc.map((g) => [g.highSeed, g.lowSeed])).toEqual([
      [1, 4],
      [2, 3],
    ]);
  });

  it('reseeds correctly when an upset changes who advances', () => {
    // AFC: 7 upsets 2, 6 upsets 3, 4 beats 5. Advancing besides bye: 7,6,4.
    // With bye #1: [1,4,6,7] -> 1v7 and 4v6.
    const wcResults: PlayoffGameResult[] = [
      result('AFC', 2, 7, 2, 7, 7),
      result('AFC', 3, 6, 3, 6, 6),
      result('AFC', 4, 5, 4, 5, 4),
    ];
    const byes: Record<Conference, SeededOwner> = { AFC: SEEDS.AFC[0], NFC: SEEDS.NFC[0] };
    const div = advanceBracket('wild_card', wcResults, byes).filter((g) => g.conference === 'AFC');
    expect(div.map((g) => [g.highSeed, g.lowSeed])).toEqual([
      [1, 7],
      [4, 6],
    ]);
  });
});

describe('advanceBracket — divisional → conference', () => {
  it('pairs the two divisional winners per conference', () => {
    // AFC divisional: 1 beats 4, 2 beats 3 -> winners seeds 1 and 2 -> 1v2.
    const divResults: PlayoffGameResult[] = [
      result('AFC', 1, 4, 1, 4, 1),
      result('AFC', 2, 3, 2, 3, 2),
      result('NFC', 1, 4, 101, 104, 101),
      result('NFC', 2, 3, 102, 103, 102),
    ];
    const conf = advanceBracket('divisional', divResults);
    const afc = conf.filter((g) => g.conference === 'AFC');
    expect(afc).toHaveLength(1);
    expect(afc[0]).toMatchObject({
      round: 'conference',
      highSeed: 1,
      lowSeed: 2,
      highOwnerSeasonId: 1,
      lowOwnerSeasonId: 2,
    });
  });
});

describe('advanceBracket — conference → championship', () => {
  it('pairs the AFC champion vs the NFC champion (cross-conference)', () => {
    const confResults: PlayoffGameResult[] = [
      result('AFC', 1, 2, 1, 2, 1), // AFC champ = owner 1
      result('NFC', 1, 2, 101, 102, 102), // NFC champ = owner 102 (seed 2)
    ];
    const champ = advanceBracket('conference', confResults);
    expect(champ).toHaveLength(1);
    expect(champ[0].round).toBe('championship');
    expect(champ[0].conference).toBeNull();
    const ids = [champ[0].highOwnerSeasonId, champ[0].lowOwnerSeasonId];
    expect(ids).toContain(1);
    expect(ids).toContain(102);
  });

  it('returns no further games after the championship', () => {
    const final: PlayoffGameResult[] = [
      { conference: null, highSeed: 1, lowSeed: 2, highOwnerSeasonId: 1, lowOwnerSeasonId: 102, highPoints: 120, lowPoints: 119 },
    ];
    expect(advanceBracket('championship', final)).toEqual([]);
  });
});

describe('advanceBracket — winner derivation from points', () => {
  it('derives the winner from points when no explicit winner is given', () => {
    const divResults: PlayoffGameResult[] = [
      { conference: 'AFC', highSeed: 1, lowSeed: 4, highOwnerSeasonId: 1, lowOwnerSeasonId: 4, highPoints: 90, lowPoints: 120 }, // 4 upsets 1
      { conference: 'AFC', highSeed: 2, lowSeed: 3, highOwnerSeasonId: 2, lowOwnerSeasonId: 3, highPoints: 110, lowPoints: 80 }, // 2 wins
    ];
    const conf = advanceBracket('divisional', divResults).filter((g) => g.conference === 'AFC');
    // Advancing: seed 4 (owner 4) and seed 2 (owner 2) -> reseed 2v4.
    expect(conf[0]).toMatchObject({ highSeed: 2, lowSeed: 4, highOwnerSeasonId: 2, lowOwnerSeasonId: 4 });
  });
});

describe('config-driven brackets — 6 teams / 2 byes', () => {
  // 6-team field per conference, top 2 seeds bye. Wild card plays seeds 3..6.
  const SIX_TEAM: PlayoffConfig = {
    teamsPerConference: 6,
    divisionWinnersPerConference: 4,
    wildCardsPerConference: 2,
    topSeedByes: 2,
  };

  // Reuse seedsFor (ids 1..7 for AFC) but only seeds 1..6 are in this field.
  const SIX_SEEDS: Record<Conference, SeededOwner[]> = {
    AFC: seedsFor('AFC', 0).slice(0, 6),
    NFC: seedsFor('NFC', 100).slice(0, 6),
  };

  it('wild-card round pairs 3v6 and 4v5, with seeds 1 & 2 on bye', () => {
    const games = seedInitialBracket(SIX_SEEDS, SIX_TEAM);
    const afc = games.filter((g) => g.conference === 'AFC');
    expect(afc.map((g) => [g.highSeed, g.lowSeed])).toEqual([
      [3, 6],
      [4, 5],
    ]);
    // No bye seed (1 or 2) appears in any game.
    expect(games.every((g) => g.highSeed > 2 && g.lowSeed > 2)).toBe(true);
    // 2 games per conference × 2 conferences.
    expect(games).toHaveLength(4);
  });

  it('re-enters BOTH bye seeds at the divisional round and reseeds [1,2,3,4]', () => {
    // AFC: seeds 3 and 4 win their wild-card games.
    const wcResults: PlayoffGameResult[] = [
      result('AFC', 3, 6, 3, 6, 3),
      result('AFC', 4, 5, 4, 5, 4),
    ];
    const byes: Record<Conference, SeededOwner[]> = {
      AFC: [SIX_SEEDS.AFC[0], SIX_SEEDS.AFC[1]], // seeds 1 & 2
      NFC: [SIX_SEEDS.NFC[0], SIX_SEEDS.NFC[1]],
    };
    const div = advanceBracket('wild_card', wcResults, byes).filter((g) => g.conference === 'AFC');
    // Divisional field [1,2,3,4] -> reseed 1v4, 2v3.
    expect(div.map((g) => [g.highSeed, g.lowSeed])).toEqual([
      [1, 4],
      [2, 3],
    ]);
    expect(div[0].highOwnerSeasonId).toBe(1);
    expect(div[0].lowOwnerSeasonId).toBe(4);
  });
});
