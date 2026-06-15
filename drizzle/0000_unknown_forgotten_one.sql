CREATE TYPE "public"."award_type" AS ENUM('champion', 'runner_up', 'third', 'fourth', 'weekly_high', 'season_high', 'most_points', 'other');--> statement-breakpoint
CREATE TYPE "public"."conference" AS ENUM('AFC', 'NFC');--> statement-breakpoint
CREATE TYPE "public"."contest_status" AS ENUM('pending', 'locked', 'pulling', 'final', 'error');--> statement-breakpoint
CREATE TYPE "public"."division" AS ENUM('East', 'North', 'South', 'West');--> statement-breakpoint
CREATE TYPE "public"."import_status" AS ENUM('success', 'partial', 'failed');--> statement-breakpoint
CREATE TYPE "public"."matchup_status" AS ENUM('scheduled', 'final');--> statement-breakpoint
CREATE TYPE "public"."playoff_round" AS ENUM('wild_card', 'divisional', 'conference', 'championship');--> statement-breakpoint
CREATE TYPE "public"."score_source" AS ENUM('auto', 'manual');--> statement-breakpoint
CREATE TYPE "public"."season_status" AS ENUM('upcoming', 'active', 'completed');--> statement-breakpoint
CREATE TABLE "matchups" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "matchups_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"season_id" integer NOT NULL,
	"week" integer NOT NULL,
	"home_owner_season_id" integer NOT NULL,
	"away_owner_season_id" integer NOT NULL,
	"nfl_game_id" integer,
	"status" "matchup_status" DEFAULT 'scheduled' NOT NULL,
	"is_playoff" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nfl_games" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "nfl_games_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"season_id" integer NOT NULL,
	"week" integer NOT NULL,
	"home_team_id" integer NOT NULL,
	"away_team_id" integer NOT NULL,
	"kickoff" timestamp with time zone,
	"espn_event_id" varchar(32),
	"status" varchar(32)
);
--> statement-breakpoint
CREATE TABLE "nfl_teams" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "nfl_teams_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"key" varchar(4) NOT NULL,
	"location" varchar(64) NOT NULL,
	"name" varchar(64) NOT NULL,
	"conference" "conference" NOT NULL,
	"division" "division" NOT NULL,
	"espn_id" varchar(16),
	CONSTRAINT "nfl_teams_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "owner_seasons" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "owner_seasons_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"season_id" integer NOT NULL,
	"owner_id" integer NOT NULL,
	"nfl_team_id" integer NOT NULL,
	"dk_entry_name" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "owners" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "owners_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" varchar(128) NOT NULL,
	"email" varchar(256),
	"phone" varchar(32),
	"dk_username" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playoff_matchups" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "playoff_matchups_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"season_id" integer NOT NULL,
	"round" "playoff_round" NOT NULL,
	"conference" "conference",
	"week" integer,
	"high_seed" integer,
	"low_seed" integer,
	"high_owner_season_id" integer,
	"low_owner_season_id" integer,
	"high_points" numeric(7, 2),
	"low_points" numeric(7, 2),
	"winner_owner_season_id" integer
);
--> statement-breakpoint
CREATE TABLE "score_import_runs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "score_import_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"season_id" integer NOT NULL,
	"week" integer NOT NULL,
	"dk_contest_id" varchar(64),
	"status" "import_status" NOT NULL,
	"entries_total" integer DEFAULT 0 NOT NULL,
	"entries_matched" integer DEFAULT 0 NOT NULL,
	"entries_unmatched" integer DEFAULT 0 NOT NULL,
	"triggered_by" varchar(64),
	"error" text,
	"raw_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scores" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "scores_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"season_id" integer NOT NULL,
	"owner_season_id" integer NOT NULL,
	"week" integer NOT NULL,
	"dk_points" numeric(7, 2),
	"source" "score_source" DEFAULT 'manual' NOT NULL,
	"is_bye" boolean DEFAULT false NOT NULL,
	"dk_contest_id" varchar(64),
	"dk_entry_key" varchar(64),
	"note" text,
	"import_run_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "season_awards" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "season_awards_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"season_id" integer NOT NULL,
	"type" "award_type" NOT NULL,
	"owner_id" integer,
	"owner_season_id" integer,
	"week" integer,
	"amount_cents" integer,
	"value" numeric(8, 2),
	"note" text
);
--> statement-breakpoint
CREATE TABLE "seasons" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "seasons_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"year" integer NOT NULL,
	"name" varchar(64) NOT NULL,
	"status" "season_status" DEFAULT 'upcoming' NOT NULL,
	"regular_season_weeks" integer DEFAULT 18 NOT NULL,
	"current_week" integer DEFAULT 1 NOT NULL,
	"entry_fee_cents" integer DEFAULT 15500 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seasons_year_unique" UNIQUE("year")
);
--> statement-breakpoint
CREATE TABLE "weekly_contests" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "weekly_contests_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"season_id" integer NOT NULL,
	"week" integer NOT NULL,
	"dk_contest_id" varchar(64),
	"dk_draft_group_id" varchar(64),
	"name" varchar(256),
	"lock_time" timestamp with time zone,
	"status" "contest_status" DEFAULT 'pending' NOT NULL,
	"last_pulled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "matchups" ADD CONSTRAINT "matchups_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matchups" ADD CONSTRAINT "matchups_home_owner_season_id_owner_seasons_id_fk" FOREIGN KEY ("home_owner_season_id") REFERENCES "public"."owner_seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matchups" ADD CONSTRAINT "matchups_away_owner_season_id_owner_seasons_id_fk" FOREIGN KEY ("away_owner_season_id") REFERENCES "public"."owner_seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matchups" ADD CONSTRAINT "matchups_nfl_game_id_nfl_games_id_fk" FOREIGN KEY ("nfl_game_id") REFERENCES "public"."nfl_games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nfl_games" ADD CONSTRAINT "nfl_games_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nfl_games" ADD CONSTRAINT "nfl_games_home_team_id_nfl_teams_id_fk" FOREIGN KEY ("home_team_id") REFERENCES "public"."nfl_teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nfl_games" ADD CONSTRAINT "nfl_games_away_team_id_nfl_teams_id_fk" FOREIGN KEY ("away_team_id") REFERENCES "public"."nfl_teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_seasons" ADD CONSTRAINT "owner_seasons_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_seasons" ADD CONSTRAINT "owner_seasons_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_seasons" ADD CONSTRAINT "owner_seasons_nfl_team_id_nfl_teams_id_fk" FOREIGN KEY ("nfl_team_id") REFERENCES "public"."nfl_teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playoff_matchups" ADD CONSTRAINT "playoff_matchups_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playoff_matchups" ADD CONSTRAINT "playoff_matchups_high_owner_season_id_owner_seasons_id_fk" FOREIGN KEY ("high_owner_season_id") REFERENCES "public"."owner_seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playoff_matchups" ADD CONSTRAINT "playoff_matchups_low_owner_season_id_owner_seasons_id_fk" FOREIGN KEY ("low_owner_season_id") REFERENCES "public"."owner_seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playoff_matchups" ADD CONSTRAINT "playoff_matchups_winner_owner_season_id_owner_seasons_id_fk" FOREIGN KEY ("winner_owner_season_id") REFERENCES "public"."owner_seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "score_import_runs" ADD CONSTRAINT "score_import_runs_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_owner_season_id_owner_seasons_id_fk" FOREIGN KEY ("owner_season_id") REFERENCES "public"."owner_seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_import_run_id_score_import_runs_id_fk" FOREIGN KEY ("import_run_id") REFERENCES "public"."score_import_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "season_awards" ADD CONSTRAINT "season_awards_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "season_awards" ADD CONSTRAINT "season_awards_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "season_awards" ADD CONSTRAINT "season_awards_owner_season_id_owner_seasons_id_fk" FOREIGN KEY ("owner_season_id") REFERENCES "public"."owner_seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_contests" ADD CONSTRAINT "weekly_contests_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "matchups_season_week_idx" ON "matchups" USING btree ("season_id","week");--> statement-breakpoint
CREATE UNIQUE INDEX "matchups_season_week_home_uq" ON "matchups" USING btree ("season_id","week","home_owner_season_id");--> statement-breakpoint
CREATE UNIQUE INDEX "nfl_games_season_week_home_uq" ON "nfl_games" USING btree ("season_id","week","home_team_id");--> statement-breakpoint
CREATE INDEX "nfl_games_season_week_idx" ON "nfl_games" USING btree ("season_id","week");--> statement-breakpoint
CREATE UNIQUE INDEX "owner_seasons_season_owner_uq" ON "owner_seasons" USING btree ("season_id","owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "owner_seasons_season_team_uq" ON "owner_seasons" USING btree ("season_id","nfl_team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scores_owner_season_week_uq" ON "scores" USING btree ("owner_season_id","week");--> statement-breakpoint
CREATE INDEX "scores_season_week_idx" ON "scores" USING btree ("season_id","week");--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_contests_season_week_uq" ON "weekly_contests" USING btree ("season_id","week");