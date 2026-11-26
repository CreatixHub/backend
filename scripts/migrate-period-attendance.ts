// Creates the period_attendance table (migration 0016) on its own, without drizzle-kit.
// Safe to run more than once: every statement is guarded with IF NOT EXISTS.
// Needs the tables students, classes, subjects, staff, time_slots and timetable_entries (they already exist).
//
// Usage (from the backend folder):  npx tsx scripts/migrate-period-attendance.ts
import { Client } from "pg";
import { config } from "../src/config";

const SQL = `
CREATE TABLE IF NOT EXISTS "period_attendance" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"attendance_date" date NOT NULL,
	"timetable_entry_id" bigint NOT NULL,
	"class_id" bigint NOT NULL,
	"time_slot_id" bigint NOT NULL,
	"subject_id" bigint NOT NULL,
	"teacher_id" bigint NOT NULL,
	"student_id" bigint NOT NULL,
	"status" text NOT NULL,
	"remarks" text,
	"marked_by" bigint,
	"marked_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "period_attendance" ADD CONSTRAINT "period_attendance_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "period_attendance" ADD CONSTRAINT "period_attendance_timetable_entry_id_timetable_entries_id_fk" FOREIGN KEY ("timetable_entry_id") REFERENCES "public"."timetable_entries"("id") ON DELETE restrict ON UPDATE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "period_attendance" ADD CONSTRAINT "period_attendance_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE restrict ON UPDATE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "period_attendance" ADD CONSTRAINT "period_attendance_time_slot_id_time_slots_id_fk" FOREIGN KEY ("time_slot_id") REFERENCES "public"."time_slots"("id") ON DELETE restrict ON UPDATE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "period_attendance" ADD CONSTRAINT "period_attendance_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE restrict ON UPDATE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "period_attendance" ADD CONSTRAINT "period_attendance_teacher_id_staff_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."staff"("id") ON DELETE restrict ON UPDATE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "period_attendance" ADD CONSTRAINT "period_attendance_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE restrict ON UPDATE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "period_attendance" ADD CONSTRAINT "period_attendance_marked_by_users_id_fk" FOREIGN KEY ("marked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "period_attendance_period_student_key" ON "period_attendance" USING btree ("tenant_id","attendance_date","timetable_entry_id","student_id");

CREATE INDEX IF NOT EXISTS "period_attendance_tenant_id_date_idx" ON "period_attendance" USING btree ("tenant_id","attendance_date");

CREATE INDEX IF NOT EXISTS "period_attendance_tenant_id_student_id_date_idx" ON "period_attendance" USING btree ("tenant_id","student_id","attendance_date");

CREATE INDEX IF NOT EXISTS "period_attendance_tenant_id_class_id_date_idx" ON "period_attendance" USING btree ("tenant_id","class_id","attendance_date");
`;

async function main() {
  const client = new Client({ connectionString: config.DIRECT_URL ?? config.DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(SQL);
    await client.query("COMMIT");
    const r = await client.query("SELECT count(*)::int AS n FROM period_attendance");
    console.log(`OK - period_attendance table is ready (${r.rows[0].n} rows).`);
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error("Migration failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});