CREATE TABLE "section_teachers" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"section_id" bigint NOT NULL,
	"subject_id" bigint NOT NULL,
	"academic_year_id" bigint NOT NULL,
	"teacher_id" bigint NOT NULL,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "time_slots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"branch_id" bigint,
	"name" text NOT NULL,
	"sequence" smallint NOT NULL,
	"starts_at" time NOT NULL,
	"ends_at" time NOT NULL,
	"is_break" boolean DEFAULT false NOT NULL,
	"duration_minutes" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timetable_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"section_id" bigint NOT NULL,
	"subject_id" bigint NOT NULL,
	"teacher_id" bigint NOT NULL,
	"time_slot_id" bigint NOT NULL,
	"classroom_id" bigint,
	"day_of_week" smallint NOT NULL,
	"academic_year_id" bigint NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "section_teachers" ADD CONSTRAINT "section_teachers_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "section_teachers" ADD CONSTRAINT "section_teachers_section_id_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."sections"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "section_teachers" ADD CONSTRAINT "section_teachers_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "section_teachers" ADD CONSTRAINT "section_teachers_teacher_id_staff_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."staff"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "time_slots" ADD CONSTRAINT "time_slots_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "timetable_entries" ADD CONSTRAINT "timetable_entries_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "timetable_entries" ADD CONSTRAINT "timetable_entries_section_id_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."sections"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "timetable_entries" ADD CONSTRAINT "timetable_entries_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "timetable_entries" ADD CONSTRAINT "timetable_entries_teacher_id_staff_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."staff"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "timetable_entries" ADD CONSTRAINT "timetable_entries_time_slot_id_time_slots_id_fk" FOREIGN KEY ("time_slot_id") REFERENCES "public"."time_slots"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "timetable_entries" ADD CONSTRAINT "timetable_entries_classroom_id_classrooms_id_fk" FOREIGN KEY ("classroom_id") REFERENCES "public"."classrooms"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "section_teachers_section_subject_year_key" ON "section_teachers" USING btree ("section_id","subject_id","academic_year_id");--> statement-breakpoint
CREATE INDEX "section_teachers_tenant_id_teacher_id_idx" ON "section_teachers" USING btree ("tenant_id","teacher_id");--> statement-breakpoint
CREATE UNIQUE INDEX "time_slots_tenant_id_sequence_key" ON "time_slots" USING btree ("tenant_id","sequence");--> statement-breakpoint
CREATE INDEX "timetable_entries_section_day_idx" ON "timetable_entries" USING btree ("tenant_id","section_id","day_of_week");--> statement-breakpoint
CREATE INDEX "timetable_entries_teacher_day_idx" ON "timetable_entries" USING btree ("tenant_id","teacher_id","day_of_week");--> statement-breakpoint
CREATE INDEX "timetable_entries_classroom_idx" ON "timetable_entries" USING btree ("classroom_id");--> statement-breakpoint
CREATE INDEX "timetable_entries_time_slot_idx" ON "timetable_entries" USING btree ("time_slot_id");