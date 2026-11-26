-- ============================================================================================================
-- 0019_academic_years  (HAND-EDITED after drizzle-kit generate. Do NOT regenerate it or reorder the steps.)
--
-- WARNING: THIS MIGRATION REWRITES academic_year_id IN NINE TABLES FOR EVERY SCHOOL.
-- DRY-RUN IT ON A COPY OF THE DATABASE FIRST (restore a backup, run it, check the counts) BEFORE THE REAL ONE.
--
-- Until now academic_year_id was a bare number (the frontend always sent 1) with no academic_years table.
-- Ids are global (bigserial), so "1" cannot be a real year for every school. This migration:
--   1. creates academic_years (one row per school year; at most ONE current year per school),
--   2. inserts ONE current year for every row in organizations, named from the year of the school's created_at
--      (format YYYY-YY, e.g. 2026-27; starts 1 June of the first year and ends 31 May of the next - a simple
--      default, the same one the app uses when it creates a school; see src/modules/academic-years/yearName.ts),
--   3. refuses to continue if remapping would collide with a unique index (see the check below),
--   4. points EVERY existing academic_year_id at its own school's new current year (the old value, 1 or anything
--      else, is discarded; the UPDATE is safe to repeat), in these tables:
--        section_teachers, timetable_entries, homework, transport_assignments, admissions, leave_balances,
--        academic_calendar_events (nullable: NULL stays NULL), fee_structures, invoices
--      every one of them has a NOT NULL tenant_id that already references organizations, so every row finds a year,
--   5. ONLY THEN adds the foreign keys (restrict). Adding them earlier would fail on the old values.
-- It all runs in one transaction: if any step fails, nothing is changed. Two things to know about that:
--   (a) the transaction covers ALL pending migrations, not just this one: if an earlier pending file fails, this one
--       is rolled back with it (and the other way round);
--   (b) BEFORE RUNNING: stop the app (no request may write academic_year_id while this runs) and deploy backend and
--       frontend TOGETHER. The old frontend sends academicYearId 1, which is no longer a valid year (see the
--       sequence restart in step 1b, which makes such a stray value fail loudly instead of landing in another school).
--
-- (c) AFTER RUNNING, verify (all on the migrated database):
--     * for EACH of the 9 tables t below, this must return 0 (no row points at another school's year):
--         SELECT count(*) FROM <t> t JOIN academic_years ay ON ay.id = t.academic_year_id WHERE ay.tenant_id <> t.tenant_id;
--     * every organization has exactly one current year (this must return 0 rows):
--         SELECT o.id FROM organizations o LEFT JOIN academic_years ay ON ay.tenant_id = o.id AND ay.is_current
--         GROUP BY o.id HAVING count(ay.id) <> 1;
--     * row counts are unchanged: compare SELECT count(*) of each of the 9 tables with the numbers taken before the run.
-- ============================================================================================================

-- Step 1: the table
CREATE TABLE "academic_years" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"name" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "academic_years_dates_check" CHECK ("academic_years"."ends_on" > "academic_years"."starts_on")
);
--> statement-breakpoint
ALTER TABLE "academic_years" ADD CONSTRAINT "academic_years_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "academic_years_tenant_id_name_key" ON "academic_years" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "academic_years_tenant_id_current_key" ON "academic_years" USING btree ("tenant_id") WHERE "academic_years"."is_current";--> statement-breakpoint
-- Step 1b: new year ids start at 10000. Legacy rows carry the literal 1 (or 2026 from the old leave code); if the ids
-- started at 1, a stray legacy value sent by an old client would pass the foreign key and silently point at whichever
-- school got id 1. Starting at 10000 makes such a value fail the foreign key loudly instead.
SELECT setval(pg_get_serial_sequence('academic_years', 'id'), 10000, false);--> statement-breakpoint
-- Step 2: one current year per school (every school, including soft-deleted ones: their rows need a year too).
INSERT INTO "academic_years" ("tenant_id", "name", "starts_on", "ends_on", "is_current")
SELECT
	o."id",
	y.yr::text || '-' || lpad(((y.yr + 1) % 100)::text, 2, '0'),
	make_date(y.yr, 6, 1),
	make_date(y.yr + 1, 5, 31),
	true
FROM "organizations" o
CROSS JOIN LATERAL (SELECT EXTRACT(YEAR FROM o."created_at" AT TIME ZONE 'UTC')::int AS yr) y
WHERE NOT EXISTS (SELECT 1 FROM "academic_years" ay WHERE ay."tenant_id" = o."id");--> statement-breakpoint
-- Step 3: these two tables have a unique index that includes academic_year_id. If a school has rows for two different
-- old year values, pointing both at one new year would collide (or silently merge balances). Stop and let a person decide.
DO $$
DECLARE
	r record;
BEGIN
	SELECT "tenant_id", "section_id", "subject_id" INTO r
	FROM "section_teachers" GROUP BY "tenant_id", "section_id", "subject_id" HAVING count(DISTINCT "academic_year_id") > 1 LIMIT 1;
	IF FOUND THEN
		RAISE EXCEPTION '0019: table section_teachers: tenant % has section % and subject % under more than one academic_year_id; merge them by hand first', r.tenant_id, r.section_id, r.subject_id;
	END IF;
	SELECT "tenant_id", "staff_id", "leave_type_id" INTO r
	FROM "leave_balances" GROUP BY "tenant_id", "staff_id", "leave_type_id" HAVING count(DISTINCT "academic_year_id") > 1 LIMIT 1;
	IF FOUND THEN
		RAISE EXCEPTION '0019: table leave_balances: tenant % has staff % and leave type % under more than one academic_year_id; merge them by hand first', r.tenant_id, r.staff_id, r.leave_type_id;
	END IF;
END $$;--> statement-breakpoint
-- Step 4: every table, every row: academic_year_id -> the school's own current year.
UPDATE "section_teachers" SET "academic_year_id" = (SELECT ay."id" FROM "academic_years" ay WHERE ay."tenant_id" = "section_teachers"."tenant_id" AND ay."is_current") WHERE "academic_year_id" IS NOT NULL;--> statement-breakpoint
UPDATE "timetable_entries" SET "academic_year_id" = (SELECT ay."id" FROM "academic_years" ay WHERE ay."tenant_id" = "timetable_entries"."tenant_id" AND ay."is_current") WHERE "academic_year_id" IS NOT NULL;--> statement-breakpoint
UPDATE "homework" SET "academic_year_id" = (SELECT ay."id" FROM "academic_years" ay WHERE ay."tenant_id" = "homework"."tenant_id" AND ay."is_current") WHERE "academic_year_id" IS NOT NULL;--> statement-breakpoint
UPDATE "transport_assignments" SET "academic_year_id" = (SELECT ay."id" FROM "academic_years" ay WHERE ay."tenant_id" = "transport_assignments"."tenant_id" AND ay."is_current") WHERE "academic_year_id" IS NOT NULL;--> statement-breakpoint
UPDATE "admissions" SET "academic_year_id" = (SELECT ay."id" FROM "academic_years" ay WHERE ay."tenant_id" = "admissions"."tenant_id" AND ay."is_current") WHERE "academic_year_id" IS NOT NULL;--> statement-breakpoint
UPDATE "leave_balances" SET "academic_year_id" = (SELECT ay."id" FROM "academic_years" ay WHERE ay."tenant_id" = "leave_balances"."tenant_id" AND ay."is_current") WHERE "academic_year_id" IS NOT NULL;--> statement-breakpoint
UPDATE "academic_calendar_events" SET "academic_year_id" = (SELECT ay."id" FROM "academic_years" ay WHERE ay."tenant_id" = "academic_calendar_events"."tenant_id" AND ay."is_current") WHERE "academic_year_id" IS NOT NULL;--> statement-breakpoint
UPDATE "fee_structures" SET "academic_year_id" = (SELECT ay."id" FROM "academic_years" ay WHERE ay."tenant_id" = "fee_structures"."tenant_id" AND ay."is_current") WHERE "academic_year_id" IS NOT NULL;--> statement-breakpoint
UPDATE "invoices" SET "academic_year_id" = (SELECT ay."id" FROM "academic_years" ay WHERE ay."tenant_id" = "invoices"."tenant_id" AND ay."is_current") WHERE "academic_year_id" IS NOT NULL;--> statement-breakpoint
-- Step 5: the foreign keys, last.
ALTER TABLE "academic_calendar_events" ADD CONSTRAINT "academic_calendar_events_academic_year_id_academic_years_id_fk" FOREIGN KEY ("academic_year_id") REFERENCES "public"."academic_years"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_academic_year_id_academic_years_id_fk" FOREIGN KEY ("academic_year_id") REFERENCES "public"."academic_years"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "fee_structures" ADD CONSTRAINT "fee_structures_academic_year_id_academic_years_id_fk" FOREIGN KEY ("academic_year_id") REFERENCES "public"."academic_years"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "homework" ADD CONSTRAINT "homework_academic_year_id_academic_years_id_fk" FOREIGN KEY ("academic_year_id") REFERENCES "public"."academic_years"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_academic_year_id_academic_years_id_fk" FOREIGN KEY ("academic_year_id") REFERENCES "public"."academic_years"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "leave_balances" ADD CONSTRAINT "leave_balances_academic_year_id_academic_years_id_fk" FOREIGN KEY ("academic_year_id") REFERENCES "public"."academic_years"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "section_teachers" ADD CONSTRAINT "section_teachers_academic_year_id_academic_years_id_fk" FOREIGN KEY ("academic_year_id") REFERENCES "public"."academic_years"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "timetable_entries" ADD CONSTRAINT "timetable_entries_academic_year_id_academic_years_id_fk" FOREIGN KEY ("academic_year_id") REFERENCES "public"."academic_years"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "transport_assignments" ADD CONSTRAINT "transport_assignments_academic_year_id_academic_years_id_fk" FOREIGN KEY ("academic_year_id") REFERENCES "public"."academic_years"("id") ON DELETE restrict ON UPDATE cascade;
