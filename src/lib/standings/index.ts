/**
 * Standings & playoff-seeding library — public API.
 *
 * A PURE, DB-DECOUPLED module. The caller loads rows from the database, maps
 * them into the input types here, and persists the computed results. Nothing
 * in this folder performs any I/O, so it is fast and trivially unit-testable.
 */
export type {
  Conference,
  Division,
  PlayoffRound,
  OwnerEntry,
  MatchupResult,
  StandingRow,
  RankedStandingRow,
  SeedKind,
  SeededOwner,
  PlayoffConfig,
  PlayoffGame,
  PlayoffGameResult,
  AdvancingOwner,
  TiebreakerKey,
  RankingOptions,
} from './types';

export { DEFAULT_PLAYOFF_CONFIG, DEFAULT_TIEBREAKERS } from './types';

export { computeStandings } from './standings';

export {
  compareForStandings,
  rankStandings,
  buildTiebreakerContext,
  type TiebreakerContext,
} from './tiebreakers';

export { computeDivisionStandings, computeConferenceSeeds } from './seeding';

export { seedInitialBracket, advanceBracket } from './playoffs';
