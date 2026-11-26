ALTER TABLE "timetable_entries" ALTER COLUMN "subject_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "timetable_entries" ALTER COLUMN "teacher_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "timetable_entries" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "timetable_entries" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "timetable_entries" ADD COLUMN "version_id" bigint;--> statement-breakpoint
ALTER TABLE "timetable_entries" ADD COLUMN "archived_by_version_id" bigint;--> statement-breakpoint
ALTER TABLE "timetable_entries" ADD COLUMN "classroom_ids" bigint[] DEFAULT '{}'::bigint[] NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "timetable_entries_planner_teacher_slot_key" ON "timetable_entries" USING btree ("tenant_id","teacher_id","day_of_week","time_slot_id") WHERE "timetable_entries"."source" = 'planner' AND "timetable_entries"."status" = 'active' AND "timetable_entries"."teacher_id" IS NOT NULL;