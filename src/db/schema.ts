/**
 * Database schema — KeyLehr H2H Fantasy Football League.
 *
 * Drizzle ORM (PostgreSQL / Neon). Column names use `snake_case` in the database;
 * the Drizzle client and drizzle-kit are configured with `casing: 'snake_case'`, so the
 * camelCase keys below map to snake_case columns automatically.
 *
 * Domain model overview
 * ---------------------
 *  - `seasons`          one row per league season (mirrors an NFL season/year)
 *  - `nflTeams`         the 32 NFL teams (static reference data, seeded once)
 *  - `owners`           the people in the league (global identity, persists across seasons)
 *  - `ownerSeasons`     an owner's assignment to one NFL team for one season
 *  - `nflGames`         the real NFL schedule for a season (auto-pulled from ESPN)
 *  - `matchups`         owner-vs-owner head-to-head games, derived from `nflGames`
 *  - `weeklyContests`   the shared DraftKings contest used for scoring each week
 *  - `scores`           an owner's weekly DraftKings fantasy points
 *  - `scoreImportRuns`  audit log of each DraftKings leaderboard pull
 *  - `seasonAwards`     payouts/records (champion, weekly high, most points, ...)
 *  - `playoffMatchups`  the league playoff bracket
 */
import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

/* -------------------------------------------------------------------------- */
/* Enums                                                                       */
/* -------------------------------------------------------------------------- */

export const seasonStatus = pgEnum('season_status', ['upcoming', 'active', 'completed']);
export const conference = pgEnum('conference', ['AFC', 'NFC']);
export const division = pgEnum('division', ['East', 'North', 'South', 'West']);
export const scoreSource = pgEnum('score_source', ['auto', 'manual']);
export const contestStatus = pgEnum('contest_status', [
  'pending', // no DK contest id set yet
  'locked', // contest id set, lineups locked
  'pulling', // a pull is in progress
  'final', // scores imported and finalized
  'error', // last pull failed
]);
export const matchupStatus = pgEnum('matchup_status', ['scheduled', 'final']);
export const importStatus = pgEnum('import_status', ['success', 'partial', 'failed']);
export const awardType = pgEnum('award_type', [
  'champion',
  'runner_up',
  'third',
  'fourth',
  'weekly_high',
  'season_high',
  'most_points',
  'other',
]);
export const playoffRound = pgEnum('playoff_round', [
  'wild_card',
  'divisional',
  'conference',
  'championship',
]);

/* -------------------------------------------------------------------------- */
/* Reference data                                                              */
/* -------------------------------------------------------------------------- */

/** The 32 NFL teams. Static reference data, seeded once (see src/db/seed). */
export const nflTeams = pgTable('nfl_teams', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  /** Team abbreviation, e.g. "MIA". Used to match ESPN schedule data. */
  key: varchar({ length: 4 }).notNull().unique(),
  /** City/region, e.g. "Miami". */
  location: varchar({ length: 64 }).notNull(),
  /** Nickname, e.g. "Dolphins". */
  name: varchar({ length: 64 }).notNull(),
  conference: conference().notNull(),
  division: division().notNull(),
  /** ESPN team id (string), used as a robust join key to the ESPN schedule API. */
  espnId: varchar({ length: 16 }),
  /* --- Branding metadata (logos + colors), backfilled from src/db/seed/team-meta.ts --- */
  /** Primary brand color, hex like "#00338D". */
  primaryColor: varchar({ length: 9 }),
  /** Secondary brand color, hex. */
  secondaryColor: varchar({ length: 9 }),
  /** Tertiary brand color, hex (nullable — source may be empty). */
  tertiaryColor: varchar({ length: 9 }),
  /** Quaternary brand color, hex (nullable — source may be empty). */
  quaternaryColor: varchar({ length: 9 }),
  /** DraftKings display label, e.g. "MIA Dolphins". */
  draftkingsLabel: varchar({ length: 64 }),
  /** NFL.com team id, e.g. "0610". */
  nflTeamId: varchar({ length: 8 }),
  /** ESPN team logo URL (the primary crest shown on-site). */
  logoEspn: text(),
  /** nflverse wordmark logo URL. */
  logoWordmark: text(),
  /** nflverse squared logo URL. */
  logoSquared: text(),
  /** Wikipedia logo URL. */
  logoWikipedia: text(),
});

/* -------------------------------------------------------------------------- */
/* Admin users                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Admin accounts that can log in to the commissioner panel.
 *
 * This table backs the multi-admin login: the commissioner can add/remove other
 * admins here without a redeploy. It is intentionally separate from `owners`
 * (league members) — most owners never need an admin login.
 *
 * The env bootstrap admin (ADMIN_EMAIL / ADMIN_PASSWORD_HASH) is NOT stored here;
 * it always works as a fallback so the commissioner can sign in even before any
 * rows exist. `passwordHash` is a RAW bcrypt hash (starts with `$2…`).
 */
export const users = pgTable('users', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  email: varchar({ length: 256 }).notNull().unique(),
  name: varchar({ length: 128 }),
  /** Raw bcrypt hash (e.g. `$2b$12$…`). Never exposed to the client. */
  passwordHash: varchar({ length: 256 }).notNull(),
  role: varchar({ length: 32 }).notNull().default('admin'),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/* -------------------------------------------------------------------------- */
/* League core                                                                 */
/* -------------------------------------------------------------------------- */

export const seasons = pgTable('seasons', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  /** Calendar year of the NFL season, e.g. 2026. */
  year: integer().notNull().unique(),
  /** Display name, e.g. "Season 4 (2026)". */
  name: varchar({ length: 64 }).notNull(),
  status: seasonStatus().notNull().default('upcoming'),
  /** Number of regular-season weeks (NFL is 18). */
  regularSeasonWeeks: integer().notNull().default(18),
  /** The week currently in progress (drives "live" views). */
  currentWeek: integer().notNull().default(1),
  /** Entry fee per owner, in cents (e.g. 15500 = $155). */
  entryFeeCents: integer().notNull().default(15500),
  /**
   * Per-season, editable rules/settings (tiebreakers, playoff structure, bye &
   * missed-lineup behavior, payouts). Shape is validated by `seasonRulesSchema`
   * (see src/lib/rules). Null/missing keys fall back to DEFAULT_SEASON_RULES, so
   * a season inherits the defaults until the commissioner overrides them in the
   * admin Settings page.
   */
  rules: jsonb(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/** A person in the league. Persists across seasons (so all-time stats work). */
export const owners = pgTable('owners', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  name: varchar({ length: 128 }).notNull(),
  email: varchar({ length: 256 }),
  phone: varchar({ length: 32 }),
  /** The owner's DraftKings account/handle. */
  dkUsername: varchar({ length: 128 }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/** An owner's assignment to one NFL team for one season. */
export const ownerSeasons = pgTable(
  'owner_seasons',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    seasonId: integer()
      .notNull()
      .references(() => seasons.id, { onDelete: 'cascade' }),
    ownerId: integer()
      .notNull()
      .references(() => owners.id, { onDelete: 'cascade' }),
    nflTeamId: integer()
      .notNull()
      .references(() => nflTeams.id),
    /**
     * The exact DraftKings entry/username this owner will use in the weekly contest
     * this season. This is the key the scoring pipeline matches the leaderboard against,
     * and the league rule is it must not change mid-season.
     */
    dkEntryName: varchar({ length: 128 }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('owner_seasons_season_owner_uq').on(t.seasonId, t.ownerId),
    uniqueIndex('owner_seasons_season_team_uq').on(t.seasonId, t.nflTeamId),
  ],
);

/* -------------------------------------------------------------------------- */
/* Schedule & matchups                                                         */
/* -------------------------------------------------------------------------- */

/** The real NFL schedule for a season, auto-pulled from ESPN. Drives matchups. */
export const nflGames = pgTable(
  'nfl_games',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    seasonId: integer()
      .notNull()
      .references(() => seasons.id, { onDelete: 'cascade' }),
    week: integer().notNull(),
    homeTeamId: integer()
      .notNull()
      .references(() => nflTeams.id),
    awayTeamId: integer()
      .notNull()
      .references(() => nflTeams.id),
    kickoff: timestamp({ withTimezone: true }),
    /** ESPN event id for idempotent upserts. */
    espnEventId: varchar({ length: 32 }),
    status: varchar({ length: 32 }),
  },
  (t) => [
    uniqueIndex('nfl_games_season_week_home_uq').on(t.seasonId, t.week, t.homeTeamId),
    index('nfl_games_season_week_idx').on(t.seasonId, t.week),
  ],
);

/**
 * Head-to-head owner matchups for a week, derived from `nflGames`: each owner faces
 * the owner whose NFL team is their team's opponent that week. An owner whose team is
 * on a bye has no matchup row that week. `home`/`away` mirror the underlying NFL game.
 */
export const matchups = pgTable(
  'matchups',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    seasonId: integer()
      .notNull()
      .references(() => seasons.id, { onDelete: 'cascade' }),
    week: integer().notNull(),
    homeOwnerSeasonId: integer()
      .notNull()
      .references(() => ownerSeasons.id, { onDelete: 'cascade' }),
    awayOwnerSeasonId: integer()
      .notNull()
      .references(() => ownerSeasons.id, { onDelete: 'cascade' }),
    nflGameId: integer().references(() => nflGames.id),
    status: matchupStatus().notNull().default('scheduled'),
    isPlayoff: boolean().notNull().default(false),
  },
  (t) => [
    index('matchups_season_week_idx').on(t.seasonId, t.week),
    uniqueIndex('matchups_season_week_home_uq').on(t.seasonId, t.week, t.homeOwnerSeasonId),
  ],
);

/* -------------------------------------------------------------------------- */
/* DraftKings scoring                                                          */
/* -------------------------------------------------------------------------- */

/** The shared DraftKings contest used to score a given week. */
export const weeklyContests = pgTable(
  'weekly_contests',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    seasonId: integer()
      .notNull()
      .references(() => seasons.id, { onDelete: 'cascade' }),
    week: integer().notNull(),
    /** DraftKings contest id whose leaderboard we pull. */
    dkContestId: varchar({ length: 64 }),
    /** DraftKings draft group id (slate), optional. */
    dkDraftGroupId: varchar({ length: 64 }),
    name: varchar({ length: 256 }),
    lockTime: timestamp({ withTimezone: true }),
    status: contestStatus().notNull().default('pending'),
    lastPulledAt: timestamp({ withTimezone: true }),
  },
  (t) => [uniqueIndex('weekly_contests_season_week_uq').on(t.seasonId, t.week)],
);

/** Audit log: one row per DraftKings leaderboard pull (auto or manual). */
export const scoreImportRuns = pgTable('score_import_runs', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  seasonId: integer()
    .notNull()
    .references(() => seasons.id, { onDelete: 'cascade' }),
  week: integer().notNull(),
  dkContestId: varchar({ length: 64 }),
  status: importStatus().notNull(),
  entriesTotal: integer().notNull().default(0),
  entriesMatched: integer().notNull().default(0),
  entriesUnmatched: integer().notNull().default(0),
  /** 'cron' | 'admin:<email>' | 'manual-paste' */
  triggeredBy: varchar({ length: 64 }),
  error: text(),
  /** Raw leaderboard payload retained for debugging/replay. */
  rawPayload: jsonb(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/** An owner's weekly DraftKings fantasy points. One row per (ownerSeason, week). */
export const scores = pgTable(
  'scores',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    seasonId: integer()
      .notNull()
      .references(() => seasons.id, { onDelete: 'cascade' }),
    ownerSeasonId: integer()
      .notNull()
      .references(() => ownerSeasons.id, { onDelete: 'cascade' }),
    week: integer().notNull(),
    /** DraftKings fantasy points, 2 decimal places (e.g. 241.68). Null until scored. */
    dkPoints: numeric({ precision: 7, scale: 2 }),
    source: scoreSource().notNull().default('manual'),
    /** True when the owner's NFL team is on bye — score does not count toward stats. */
    isBye: boolean().notNull().default(false),
    /**
     * True when the owner failed to set a lineup (league rule: automatic loss, and the
     * opponent instead plays the league-average score for that week). The forfeiting
     * owner's own `dkPoints` still record whatever they scored (often 0).
     */
    isForfeit: boolean().notNull().default(false),
    dkContestId: varchar({ length: 64 }),
    dkEntryKey: varchar({ length: 64 }),
    note: text(),
    importRunId: integer().references(() => scoreImportRuns.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('scores_owner_season_week_uq').on(t.ownerSeasonId, t.week),
    index('scores_season_week_idx').on(t.seasonId, t.week),
  ],
);

/* -------------------------------------------------------------------------- */
/* Awards & playoffs                                                           */
/* -------------------------------------------------------------------------- */

/** Payouts and records for a season (champion, weekly high score, most points, ...). */
export const seasonAwards = pgTable('season_awards', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  seasonId: integer()
    .notNull()
    .references(() => seasons.id, { onDelete: 'cascade' }),
  type: awardType().notNull(),
  ownerId: integer().references(() => owners.id),
  ownerSeasonId: integer().references(() => ownerSeasons.id),
  /** Week for weekly awards (e.g. weekly high score); null for season-long awards. */
  week: integer(),
  /** Payout amount in cents. */
  amountCents: integer(),
  /** Associated value, e.g. the points total for a high-score award. */
  value: numeric({ precision: 8, scale: 2 }),
  note: text(),
});

/** The league playoff bracket. Seeding mirrors the NFL (4 division winners + 3 wild cards). */
export const playoffMatchups = pgTable('playoff_matchups', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  seasonId: integer()
    .notNull()
    .references(() => seasons.id, { onDelete: 'cascade' }),
  round: playoffRound().notNull(),
  /** Conference for intra-conference rounds; null for the championship. */
  conference: conference(),
  week: integer(),
  highSeed: integer(),
  lowSeed: integer(),
  highOwnerSeasonId: integer().references(() => ownerSeasons.id),
  lowOwnerSeasonId: integer().references(() => ownerSeasons.id),
  highPoints: numeric({ precision: 7, scale: 2 }),
  lowPoints: numeric({ precision: 7, scale: 2 }),
  winnerOwnerSeasonId: integer().references(() => ownerSeasons.id),
});

/* -------------------------------------------------------------------------- */
/* Playoff odds (538-style "odds over time")                                   */
/* -------------------------------------------------------------------------- */

/**
 * Per-week playoff-probability snapshots for each owner, produced by the
 * Monte-Carlo odds engine (`src/lib/odds/simulate.ts`) and persisted by
 * `scripts/compute-odds.ts`. One row per (season, week, owner): the owner's
 * probability — as a percent 0..100 — of making the playoff field given games
 * played through that week. The `/playoffs` page renders these as a multi-line
 * trend chart. The unique index makes the compute script an idempotent upsert.
 */
export const playoffOddsSnapshots = pgTable(
  'playoff_odds_snapshots',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    seasonId: integer()
      .notNull()
      .references(() => seasons.id, { onDelete: 'cascade' }),
    week: integer().notNull(),
    ownerSeasonId: integer()
      .notNull()
      .references(() => ownerSeasons.id, { onDelete: 'cascade' }),
    /** Playoff probability as a percent, 0.00..100.00. */
    oddsPct: numeric({ precision: 5, scale: 2 }).notNull(),
    computedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('playoff_odds_snapshots_season_week_owner_uq').on(
      t.seasonId,
      t.week,
      t.ownerSeasonId,
    ),
    index('playoff_odds_snapshots_season_idx').on(t.seasonId),
  ],
);

/* -------------------------------------------------------------------------- */
/* Relations (for the Drizzle relational query API)                            */
/* -------------------------------------------------------------------------- */

export const seasonsRelations = relations(seasons, ({ many }) => ({
  ownerSeasons: many(ownerSeasons),
  nflGames: many(nflGames),
  matchups: many(matchups),
  weeklyContests: many(weeklyContests),
  scores: many(scores),
}));

export const ownersRelations = relations(owners, ({ many }) => ({
  ownerSeasons: many(ownerSeasons),
}));

export const ownerSeasonsRelations = relations(ownerSeasons, ({ one, many }) => ({
  season: one(seasons, { fields: [ownerSeasons.seasonId], references: [seasons.id] }),
  owner: one(owners, { fields: [ownerSeasons.ownerId], references: [owners.id] }),
  team: one(nflTeams, { fields: [ownerSeasons.nflTeamId], references: [nflTeams.id] }),
  scores: many(scores),
}));

export const nflTeamsRelations = relations(nflTeams, ({ many }) => ({
  ownerSeasons: many(ownerSeasons),
}));

export const nflGamesRelations = relations(nflGames, ({ one }) => ({
  season: one(seasons, { fields: [nflGames.seasonId], references: [seasons.id] }),
  homeTeam: one(nflTeams, { fields: [nflGames.homeTeamId], references: [nflTeams.id] }),
  awayTeam: one(nflTeams, { fields: [nflGames.awayTeamId], references: [nflTeams.id] }),
}));

export const matchupsRelations = relations(matchups, ({ one }) => ({
  season: one(seasons, { fields: [matchups.seasonId], references: [seasons.id] }),
  homeOwnerSeason: one(ownerSeasons, {
    fields: [matchups.homeOwnerSeasonId],
    references: [ownerSeasons.id],
    relationName: 'homeOwnerSeason',
  }),
  awayOwnerSeason: one(ownerSeasons, {
    fields: [matchups.awayOwnerSeasonId],
    references: [ownerSeasons.id],
    relationName: 'awayOwnerSeason',
  }),
  nflGame: one(nflGames, { fields: [matchups.nflGameId], references: [nflGames.id] }),
}));

export const scoresRelations = relations(scores, ({ one }) => ({
  season: one(seasons, { fields: [scores.seasonId], references: [seasons.id] }),
  ownerSeason: one(ownerSeasons, {
    fields: [scores.ownerSeasonId],
    references: [ownerSeasons.id],
  }),
  importRun: one(scoreImportRuns, {
    fields: [scores.importRunId],
    references: [scoreImportRuns.id],
  }),
}));

export const weeklyContestsRelations = relations(weeklyContests, ({ one }) => ({
  season: one(seasons, { fields: [weeklyContests.seasonId], references: [seasons.id] }),
}));

/* -------------------------------------------------------------------------- */
/* Inferred types                                                              */
/* -------------------------------------------------------------------------- */

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Season = typeof seasons.$inferSelect;
export type NewSeason = typeof seasons.$inferInsert;
export type NflTeam = typeof nflTeams.$inferSelect;
export type NewNflTeam = typeof nflTeams.$inferInsert;
export type Owner = typeof owners.$inferSelect;
export type NewOwner = typeof owners.$inferInsert;
export type OwnerSeason = typeof ownerSeasons.$inferSelect;
export type NewOwnerSeason = typeof ownerSeasons.$inferInsert;
export type NflGame = typeof nflGames.$inferSelect;
export type NewNflGame = typeof nflGames.$inferInsert;
export type Matchup = typeof matchups.$inferSelect;
export type NewMatchup = typeof matchups.$inferInsert;
export type WeeklyContest = typeof weeklyContests.$inferSelect;
export type NewWeeklyContest = typeof weeklyContests.$inferInsert;
export type Score = typeof scores.$inferSelect;
export type NewScore = typeof scores.$inferInsert;
export type ScoreImportRun = typeof scoreImportRuns.$inferSelect;
export type NewScoreImportRun = typeof scoreImportRuns.$inferInsert;
export type SeasonAward = typeof seasonAwards.$inferSelect;
export type NewSeasonAward = typeof seasonAwards.$inferInsert;
export type PlayoffMatchup = typeof playoffMatchups.$inferSelect;
export type NewPlayoffMatchup = typeof playoffMatchups.$inferInsert;
export type PlayoffOddsSnapshot = typeof playoffOddsSnapshots.$inferSelect;
export type NewPlayoffOddsSnapshot = typeof playoffOddsSnapshots.$inferInsert;
