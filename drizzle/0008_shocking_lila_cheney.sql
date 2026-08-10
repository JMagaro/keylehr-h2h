ALTER TABLE "matchups" ADD COLUMN "is_exhibition" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "nfl_games" ADD COLUMN "is_exhibition" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "scores" ADD COLUMN "is_exhibition" boolean DEFAULT false NOT NULL;