ALTER TABLE "nfl_teams" ADD COLUMN "primary_color" varchar(9);--> statement-breakpoint
ALTER TABLE "nfl_teams" ADD COLUMN "secondary_color" varchar(9);--> statement-breakpoint
ALTER TABLE "nfl_teams" ADD COLUMN "tertiary_color" varchar(9);--> statement-breakpoint
ALTER TABLE "nfl_teams" ADD COLUMN "quaternary_color" varchar(9);--> statement-breakpoint
ALTER TABLE "nfl_teams" ADD COLUMN "draftkings_label" varchar(64);--> statement-breakpoint
ALTER TABLE "nfl_teams" ADD COLUMN "nfl_team_id" varchar(8);--> statement-breakpoint
ALTER TABLE "nfl_teams" ADD COLUMN "logo_espn" text;--> statement-breakpoint
ALTER TABLE "nfl_teams" ADD COLUMN "logo_wordmark" text;--> statement-breakpoint
ALTER TABLE "nfl_teams" ADD COLUMN "logo_squared" text;--> statement-breakpoint
ALTER TABLE "nfl_teams" ADD COLUMN "logo_wikipedia" text;