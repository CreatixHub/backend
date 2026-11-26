CREATE TABLE "staff_subjects" (
	"staff_id" bigint NOT NULL,
	"subject_id" bigint NOT NULL,
	"tenant_id" bigint NOT NULL,
	CONSTRAINT "staff_subjects_staff_id_subject_id_pk" PRIMARY KEY("staff_id","subject_id")
);
--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN "primary_subject_id" bigint;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN "max_periods_per_week" smallint;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "roll_no" text;--> statement-breakpoint
ALTER TABLE "staff_subjects" ADD CONSTRAINT "staff_subjects_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "staff_subjects" ADD CONSTRAINT "staff_subjects_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "staff_subjects" ADD CONSTRAINT "staff_subjects_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "staff_subjects_tenant_id_subject_id_idx" ON "staff_subjects" USING btree ("tenant_id","subject_id");--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_primary_subject_id_subjects_id_fk" FOREIGN KEY ("primary_subject_id") REFERENCES "public"."subjects"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_max_periods_per_week_range" CHECK ("staff"."max_periods_per_week" BETWEEN 1 AND 35);