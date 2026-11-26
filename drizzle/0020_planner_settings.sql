CREATE TABLE "planner_lessons" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"academic_year_id" bigint NOT NULL,
	"subject_id" bigint,
	"activity_name" text,
	"section_ids" bigint[] NOT NULL,
	"sync_group" text,
	"parts" jsonb NOT NULL,
	CONSTRAINT "planner_lessons_subject_or_activity" CHECK ("planner_lessons"."subject_id" IS NOT NULL OR "planner_lessons"."activity_name" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "planner_settings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"academic_year_id" bigint NOT NULL,
	"bell" jsonb DEFAULT '{"weekType":"weekly","dayTypes":[{"id":"usual","name":"Usual day","days":[1,2,3,4,5],"periods":[]}]}'::jsonb NOT NULL,
	"rules" jsonb DEFAULT '{"defaults":{},"teachers":{},"sections":{}}'::jsonb NOT NULL,
	"availability" jsonb DEFAULT '{"staff":{},"section":{},"room":{}}'::jsonb NOT NULL,
	"excluded_section_ids" bigint[] DEFAULT '{}'::bigint[] NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_groups" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "classrooms" ADD COLUMN "group_id" bigint;--> statement-breakpoint
ALTER TABLE "planner_lessons" ADD CONSTRAINT "planner_lessons_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "planner_lessons" ADD CONSTRAINT "planner_lessons_academic_year_id_academic_years_id_fk" FOREIGN KEY ("academic_year_id") REFERENCES "public"."academic_years"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "planner_lessons" ADD CONSTRAINT "planner_lessons_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "planner_settings" ADD CONSTRAINT "planner_settings_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "planner_settings" ADD CONSTRAINT "planner_settings_academic_year_id_academic_years_id_fk" FOREIGN KEY ("academic_year_id") REFERENCES "public"."academic_years"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "room_groups" ADD CONSTRAINT "room_groups_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "planner_lessons_tenant_year_idx" ON "planner_lessons" USING btree ("tenant_id","academic_year_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "planner_settings_tenant_year_key" ON "planner_settings" USING btree ("tenant_id","academic_year_id");--> statement-breakpoint
CREATE UNIQUE INDEX "room_groups_tenant_name_key" ON "room_groups" USING btree ("tenant_id",lower("name"));--> statement-breakpoint
ALTER TABLE "classrooms" ADD CONSTRAINT "classrooms_group_id_room_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."room_groups"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "classrooms_tenant_group_idx" ON "classrooms" USING btree ("tenant_id","group_id");