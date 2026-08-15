CREATE TABLE "lineup_capture_runs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "lineup_capture_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"season_id" integer NOT NULL,
	"week" integer NOT NULL,
	"dk_contest_id" varchar(64),
	"status" "import_status" NOT NULL,
	"entries_total" integer DEFAULT 0 NOT NULL,
	"entries_matched" integer DEFAULT 0 NOT NULL,
	"entries_unmatched" integer DEFAULT 0 NOT NULL,
	"triggered_by" varchar(64),
	"source_url_template" text,
	"error" text,
	"raw_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lineup_snapshots" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "lineup_snapshots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"season_id" integer NOT NULL,
	"owner_season_id" integer NOT NULL,
	"week" integer NOT NULL,
	"is_exhibition" boolean DEFAULT false NOT NULL,
	"dk_contest_id" varchar(64),
	"dk_draft_group_id" varchar(64),
	"dk_entry_key" varchar(64),
	"captured_at" timestamp with time zone NOT NULL,
	"slots" jsonb NOT NULL,
	"capture_run_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lineup_capture_runs" ADD CONSTRAINT "lineup_capture_runs_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lineup_snapshots" ADD CONSTRAINT "lineup_snapshots_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lineup_snapshots" ADD CONSTRAINT "lineup_snapshots_owner_season_id_owner_seasons_id_fk" FOREIGN KEY ("owner_season_id") REFERENCES "public"."owner_seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lineup_snapshots" ADD CONSTRAINT "lineup_snapshots_capture_run_id_lineup_capture_runs_id_fk" FOREIGN KEY ("capture_run_id") REFERENCES "public"."lineup_capture_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lineup_snapshots_owner_week_captured_uq" ON "lineup_snapshots" USING btree ("owner_season_id","week","captured_at");--> statement-breakpoint
CREATE INDEX "lineup_snapshots_season_week_idx" ON "lineup_snapshots" USING btree ("season_id","week");