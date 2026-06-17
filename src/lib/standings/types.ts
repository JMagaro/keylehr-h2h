/**
 * Standings & playoff-seeding library — shared types.
 *
 * This module is PURE and DB-DECOUPLED: it defines plain input/output shapes
 * only. The caller is responsible for loading rows from the database and
 * mapping them into these structures, and for persisting the results.
 *
 * Vocabulary (conference / division / playoff rounds) is aligned with
 * `src/db/schema.ts` but intentionally does NOT import it — keeping this
 * library free of any DB/ORM dependency so it stays fast and trivially
 * unit-testable.
 */

/** The two NFL conferences. Mirrors the `conference` enum in the DB schema. */
export type Conference = 'AFC' | 'NFC';

/** The four NFL divisions. Mirrors the `division` enum in the DB schema. */
export type Division = 'East' | 'North' | 'South' | 'West';

/** Playoff rounds. Mirrors the `playoff_round` enum in the DB schema. */
export type PlayoffRound = 'wild_card' | 'divisional' | 'conference' | 'championship';

/**
 * One owner's season identity + their NFL alignment.
 *
 * `ownerSeasonId` is the stable key used everywhere in this library to refer
 * to an owner for a given season (it is the `owner_seasons.id` in the DB).
 */
export interface OwnerEntry {
  ownerSeasonId: number;
  ownerName: string;
  /** NFL team abbreviation, e.g. "MIA". */
  teamKey: string;
  teamName: string;
  conference: Conference;
  division: Division;
}

/**
 * One head-to-head matchup result.
 *
 * - When `winnerOwnerSeasonId` is provided (admin override / forfeit) it is
 *   authoritative. `null` means an explicitly recorded tie.
 * - When `winnerOwnerSeasonId` is absent (`undefined`), the outcome is derived
 *   from points: higher finite points wins; equal finite points is a tie.
 * - Only results with `isFinal === true` are ever counted.
 * - Regular-season computations ignore results with `isPlayoff === true`.
 */
export interface MatchupResult {
  week: number;
  isPlayoff: boolean;
  isFinal: boolean;
  homeOwnerSeasonId: number;
  awayOwnerSeasonId: number;
  homePoints: number | null;
  awayPoints: number | null;
  /**
   * Optional explicit winner. `undefined` → derive from points; `null` →
   * explicitly a tie; a number → that owner won regardless of points.
   */
  winnerOwnerSeasonId?: number | null;
  /**
   * Forfeit ("missed lineup") handling. When present, this OVERRIDES the normal
   * outcome derivation for the affected side(s):
   *
   * - `'home'` / `'away'`: that side forfeited. The forfeiter takes an automatic
   *   LOSS; their Points For still accrues their own raw points (usually 0) and
   *   their Points Against accrues the opponent's raw points. The non-forfeiting
   *   opponent instead "plays against" {@link opponentFacesPoints} — they WIN if
   *   their own points are >= that value, otherwise LOSE, and their Points
   *   Against accrues {@link opponentFacesPoints} (NOT the forfeiter's raw 0).
   * - `'both'`: both owners forfeited. Each takes an automatic LOSS, each PF
   *   accrues their own raw points, and each PA accrues {@link opponentFacesPoints}.
   *
   * Per the league rule, a single forfeit can yield a DOUBLE LOSS (forfeiter L +
   * opponent below average L), so league wins need not equal league losses.
   *
   * This field is set by the DB assembly layer from the SEASON'S CONFIGURED
   * rules (`missedLineup.result === 'auto_loss'`); the engine stays generic.
   */
  forfeitBy?: 'home' | 'away' | 'both';
  /**
   * What the NON-forfeiting opponent "plays against" — used for both their W/L
   * determination and their Points Against — when {@link forfeitBy} is set.
   *
   * The assembly layer derives this from the season's
   * `missedLineup.opponentScores` rule: `'league_average'` → the week's league
   * average, `'zero'` → 0 (an effective auto-win), `'actual'` → the forfeiter's
   * own raw points. Defaults to 0 when omitted.
   */
  opponentFacesPoints?: number;
}

/** A computed regular-season standings row for one owner. */
export interface StandingRow {
  ownerSeasonId: number;
  wins: number;
  losses: number;
  ties: number;
  gamesPlayed: number;
  pointsFor: number;
  pointsAgainst: number;
  /** Win percentage with ties counting as half a win; 0 when no games played. */
  winPct: number;
  /**
   * Current streak as a short code, e.g. "W3" (won last 3), "L1" (lost last 1),
   * "T1" (last game was a tie). Empty string when no games have been played.
   */
  streak: string;
}

/** A standings row enriched with the owner's conference/division alignment. */
export interface RankedStandingRow extends StandingRow {
  conference: Conference;
  division: Division;
}

/**
 * A single standings tiebreaker step. Mirrors the `tiebreakers` rule in
 * `src/lib/rules/schema.ts`:
 *   - `h2h` head-to-head record within the tied cohort
 *   - `pf`  Points For (higher is better)
 *   - `pa`  Points Against (lower is better)
 */
export type TiebreakerKey = 'h2h' | 'pf' | 'pa';

/** The league's default tiebreaker order (H2H → PF → PA). */
export const DEFAULT_TIEBREAKERS: readonly TiebreakerKey[] = ['h2h', 'pf', 'pa'];

/**
 * Rule-derived knobs that tune ranking + Points-For accumulation. Supplied by the
 * DB layer from the season's configured rules; omitting it (or any field) keeps
 * the league-default behavior so the pure engine and its tests stay unchanged.
 */
export interface RankingOptions {
  /**
   * Tiebreaker order applied WITHIN a cohort of equal overall record. Defaults to
   * {@link DEFAULT_TIEBREAKERS}. The overall-record sort (win% then wins) always
   * runs first, and `ownerSeasonId` is always the final deterministic fallback.
   */
  tiebreakers?: readonly TiebreakerKey[];
  /**
   * Per-owner bye-week points to ADD to Points For — set by the DB layer only when
   * the season's `byeWeek.countsTowardPointsFor` rule is on. Affects Points For
   * (and therefore the PF tiebreaker) but never wins/losses/win%.
   */
  byePointsFor?: Map<number, number>;
}

/**
 * Per-season playoff structure the seeding/bracket engine reads instead of
 * hardcoding. Mirrors the `playoffs` block of the season rules
 * (`src/lib/rules/schema.ts`) so the commissioner can change the format from
 * the admin Settings page and the engine follows.
 *
 * The tie rule itself (`regular_season_pf` vs `higher_seed`) is supplied
 * separately per-game via {@link PlayoffGameResult} and is intentionally NOT
 * part of this config — see {@link advanceBracket}.
 */
export interface PlayoffConfig {
  /** Total seeds per conference (e.g. 7 → seeds 1..7). */
  teamsPerConference: number;
  /** How many division winners auto-qualify and seed at the top. */
  divisionWinnersPerConference: number;
  /** How many wild cards fill the remaining seeds. */
  wildCardsPerConference: number;
  /** How many top seeds receive a first-round bye. */
  topSeedByes: number;
}

/**
 * Today's league defaults (7 teams, 4 division winners, 3 wild cards, 1 bye).
 * Used whenever a {@link PlayoffConfig} is not supplied, so existing callers and
 * tests are unaffected.
 */
export const DEFAULT_PLAYOFF_CONFIG: PlayoffConfig = {
  teamsPerConference: 7,
  divisionWinnersPerConference: 4,
  wildCardsPerConference: 3,
  topSeedByes: 1,
};

/** Why an owner earned their playoff seed. */
export type SeedKind = 'division_winner' | 'wild_card';

/** An owner placed into a conference's playoff seeding (seeds 1..7). */
export interface SeededOwner extends StandingRow {
  /** Conference playoff seed, 1 (best) .. 7. */
  seed: number;
  ownerSeasonId: number;
  kind: SeedKind;
  conference: Conference;
  division: Division;
  /** True only for the #1 seed, which receives a first-round bye. */
  isBye: boolean;
}

/**
 * One playoff game. For intra-conference rounds (`wild_card`, `divisional`,
 * `conference`) `conference` is set; for the `championship` it is `null`
 * because it crosses conferences (AFC champion vs NFC champion).
 */
export interface PlayoffGame {
  round: PlayoffRound;
  /** Conference for intra-conference rounds; `null` for the championship. */
  conference: Conference | null;
  /** The higher (better) seed in this game. */
  highSeed: number;
  /** The lower (worse) seed in this game. */
  lowSeed: number;
  highOwnerSeasonId: number;
  lowOwnerSeasonId: number;
}

/** A reported playoff-game outcome the caller feeds back to {@link advanceBracket}. */
export interface PlayoffGameResult {
  /** Seed of the high-seeded participant in the completed game. */
  highSeed: number;
  /** Seed of the low-seeded participant in the completed game. */
  lowSeed: number;
  highOwnerSeasonId: number;
  lowOwnerSeasonId: number;
  highPoints: number;
  lowPoints: number;
  /** Conference the game belonged to; `null` for the championship. */
  conference: Conference | null;
  /**
   * Regular-season Points For of each participant. Per league rule, a tie in a
   * postseason matchup is broken in favor of the owner with more regular-season
   * points. Supply these so ties resolve correctly; if omitted, an exact points
   * tie falls back to the better (lower) seed.
   */
  highRegularSeasonPointsFor?: number;
  lowRegularSeasonPointsFor?: number;
  /**
   * Optional explicit winner (override/forfeit). When absent the winner is
   * derived from points (higher wins; ties broken by regular-season PF).
   */
  winnerOwnerSeasonId?: number;
}

/** The winner of one completed playoff game, carrying its original seed. */
export interface AdvancingOwner {
  ownerSeasonId: number;
  /** The owner's ORIGINAL conference seed (1..7), used for reseeding. */
  seed: number;
  conference: Conference | null;
}
