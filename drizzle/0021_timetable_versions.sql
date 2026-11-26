CREATE TABLE "timetable_versions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"academic_year_id" bigint NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"seed" integer NOT NULL,
	"bell" jsonb NOT NULL,
	"problem" jsonb NOT NULL,
	"entries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"settings_revision" integer NOT NULL,
	"edit_revision" integer DEFAULT 0 NOT NULL,
	"previous_version_id" bigint,
	"previous_slots" jsonb,
	"created_by" bigint NOT NULL,
	"published_by" bigint,
	"generated_at" timestamp (6) with time zone,
	"published_at" timestamp (6) with time zone,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "timetable_versions_status_check" CHECK ("timetable_versions"."status" in ('draft', 'published', 'archived'))
);
--> statement-breakpoint
ALTER TABLE "timetable_versions" ADD CONSTRAINT "timetable_versions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "timetable_versions" ADD CONSTRAINT "timetable_versions_academic_year_id_academic_years_id_fk" FOREIGN KEY ("academic_year_id") REFERENCES "public"."academic_years"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "timetable_versions" ADD CONSTRAINT "timetable_versions_previous_version_id_timetable_versions_id_fk" FOREIGN KEY ("previous_version_id") REFERENCES "public"."timetable_versions"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "timetable_versions" ADD CONSTRAINT "timetable_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "timetable_versions" ADD CONSTRAINT "timetable_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "timetable_versions_tenant_year_id_idx" ON "timetable_versions" USING btree ("tenant_id","academic_year_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "timetable_versions_published_year_key" ON "timetable_versions" USING btree ("tenant_id","academic_year_id") WHERE "timetable_versions"."status" = 'published';--> statement-breakpoint
-- Before this migration no application code wrote version_id or archived_by_version_id, so any non-null value is a
-- leftover from tests or experiments and cannot refer to a real version. Clear them so the foreign keys below can be added.
UPDATE "timetable_entries" SET "version_id" = NULL WHERE "version_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "timetable_versions" v WHERE v."id" = "timetable_entries"."version_id");--> statement-breakpoint
UPDATE "timetable_entries" SET "archived_by_version_id" = NULL WHERE "archived_by_version_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "timetable_versions" v WHERE v."id" = "timetable_entries"."archived_by_version_id");--> statement-breakpoint
ALTER TABLE "timetable_entries" ADD CONSTRAINT "timetable_entries_version_id_timetable_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."timetable_versions"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "timetable_entries" ADD CONSTRAINT "timetable_entries_archived_by_version_id_timetable_versions_id_fk" FOREIGN KEY ("archived_by_version_id") REFERENCES "public"."timetable_versions"("id") ON DELETE restrict ON UPDATE cascade;