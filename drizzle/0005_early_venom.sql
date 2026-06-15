CREATE TABLE "playoff_odds_snapshots" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "playoff_odds_snapshots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"season_id" integer NOT NULL,
	"week" integer NOT NULL,
	"owner_season_id" integer NOT NULL,
	"odds_pct" numeric(5, 2) NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "playoff_odds_snapshots" ADD CONSTRAINT "playoff_odds_snapshots_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playoff_odds_snapshots" ADD CONSTRAINT "playoff_odds_snapshots_owner_season_id_owner_seasons_id_fk" FOREIGN KEY ("owner_season_id") REFERENCES "public"."owner_seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "playoff_odds_snapshots_season_week_owner_uq" ON "playoff_odds_snapshots" USING btree ("season_id","week","owner_season_id");--> statement-breakpoint
CREATE INDEX "playoff_odds_snapshots_season_idx" ON "playoff_odds_snapshots" USING btree ("season_id");