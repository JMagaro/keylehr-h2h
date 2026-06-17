CREATE TABLE "model_snapshots" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "model_snapshots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"season_id" integer NOT NULL,
	"week" integer NOT NULL,
	"risk" varchar(16) NOT NULL,
	"model_version" varchar(32) NOT NULL,
	"draft_group_id" varchar(64),
	"salary_mode" boolean DEFAULT false NOT NULL,
	"salary_cap" integer,
	"lineup" jsonb NOT NULL,
	"pool" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"graded_at" timestamp with time zone,
	"actual_points" numeric(8, 2),
	"optimal_points" numeric(8, 2),
	"chalk_points" numeric(8, 2),
	"players_graded" integer,
	"grade_meta" jsonb
);
--> statement-breakpoint
ALTER TABLE "model_snapshots" ADD CONSTRAINT "model_snapshots_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "model_snapshots_season_week_risk_uq" ON "model_snapshots" USING btree ("season_id","week","risk");--> statement-breakpoint
CREATE INDEX "model_snapshots_season_idx" ON "model_snapshots" USING btree ("season_id");