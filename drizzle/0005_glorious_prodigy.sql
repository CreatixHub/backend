CREATE TABLE "homework" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"homework_code" text NOT NULL,
	"section_id" bigint NOT NULL,
	"subject_id" bigint NOT NULL,
	"teacher_id" bigint NOT NULL,
	"academic_year_id" bigint NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"homework_type" text DEFAULT 'assignment' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"duration_minutes" smallint,
	"assigned_on" date NOT NULL,
	"due_at" timestamp (6) with time zone NOT NULL,
	"max_marks" numeric(5, 2),
	"submission_required" boolean DEFAULT true NOT NULL,
	"allow_late" boolean DEFAULT false NOT NULL,
	"late_penalty_percent" numeric(5, 2),
	"submission_type" text DEFAULT 'text' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "homework_attachments" (
	"homework_id" bigint NOT NULL,
	"file_id" bigint NOT NULL,
	"tenant_id" bigint NOT NULL,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "homework_attachments_homework_id_file_id_pk" PRIMARY KEY("homework_id","file_id")
);
--> statement-breakpoint
CREATE TABLE "homework_submission_files" (
	"submission_id" bigint NOT NULL,
	"file_id" bigint NOT NULL,
	"tenant_id" bigint NOT NULL,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "homework_submission_files_submission_id_file_id_pk" PRIMARY KEY("submission_id","file_id")
);
--> statement-breakpoint
CREATE TABLE "homework_submissions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"homework_id" bigint NOT NULL,
	"enrollment_id" bigint NOT NULL,
	"submitted_at" timestamp (6) with time zone,
	"text_answer" text,
	"file_id" bigint,
	"status" text DEFAULT 'not_submitted' NOT NULL,
	"score" numeric(5, 2),
	"grade_label" text,
	"feedback" text,
	"graded_by" bigint,
	"graded_at" timestamp (6) with time zone,
	"resubmission_required" boolean DEFAULT false NOT NULL,
	"late_reason" text,
	"marks_deducted" numeric(5, 2),
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "homework" ADD CONSTRAINT "homework_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "homework" ADD CONSTRAINT "homework_section_id_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."sections"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "homework" ADD CONSTRAINT "homework_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "homework" ADD CONSTRAINT "homework_teacher_id_staff_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."staff"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "homework_attachments" ADD CONSTRAINT "homework_attachments_homework_id_homework_id_fk" FOREIGN KEY ("homework_id") REFERENCES "public"."homework"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "homework_attachments" ADD CONSTRAINT "homework_attachments_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "homework_submission_files" ADD CONSTRAINT "homework_submission_files_submission_id_homework_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."homework_submissions"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "homework_submission_files" ADD CONSTRAINT "homework_submission_files_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "homework_submissions" ADD CONSTRAINT "homework_submissions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "homework_submissions" ADD CONSTRAINT "homework_submissions_homework_id_homework_id_fk" FOREIGN KEY ("homework_id") REFERENCES "public"."homework"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "homework_submissions" ADD CONSTRAINT "homework_submissions_graded_by_staff_id_fk" FOREIGN KEY ("graded_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "homework_tenant_id_homework_code_key" ON "homework" USING btree ("tenant_id","homework_code");--> statement-breakpoint
CREATE INDEX "homework_tenant_id_section_id_due_at_idx" ON "homework" USING btree ("tenant_id","section_id","due_at");--> statement-breakpoint
CREATE INDEX "homework_tenant_id_teacher_id_idx" ON "homework" USING btree ("tenant_id","teacher_id");--> statement-breakpoint
CREATE UNIQUE INDEX "homework_submissions_homework_id_enrollment_id_key" ON "homework_submissions" USING btree ("homework_id","enrollment_id");--> statement-breakpoint
CREATE INDEX "homework_submissions_tenant_id_enrollment_id_idx" ON "homework_submissions" USING btree ("tenant_id","enrollment_id");