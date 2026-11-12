CREATE TABLE "academic_calendar_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"academic_year_id" bigint,
	"branch_id" bigint,
	"title" text NOT NULL,
	"description" text,
	"event_type" text NOT NULL,
	"starts_at" timestamp (6) with time zone NOT NULL,
	"ends_at" timestamp (6) with time zone NOT NULL,
	"all_day" boolean DEFAULT false NOT NULL,
	"audience" text DEFAULT 'all' NOT NULL,
	"class_id" bigint,
	"location" text,
	"color" text,
	"notify_via" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attendance_rules" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"audience" text NOT NULL,
	"branch_id" bigint,
	"name" text NOT NULL,
	"late_after" time,
	"half_day_after" time,
	"absent_after" time,
	"min_attendance_percent" numeric(5, 2),
	"grace_minutes" smallint DEFAULT 0 NOT NULL,
	"working_weekdays" smallint[] NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leave_balances" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"staff_id" bigint NOT NULL,
	"leave_type_id" bigint NOT NULL,
	"academic_year_id" bigint NOT NULL,
	"allocated" numeric(5, 1) DEFAULT '0' NOT NULL,
	"used" numeric(5, 1) DEFAULT '0' NOT NULL,
	"carried_forward" numeric(5, 1) DEFAULT '0' NOT NULL,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leave_requests" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"student_id" bigint,
	"staff_id" bigint,
	"leave_type_id" bigint,
	"requested_by_user_id" bigint,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"days" numeric(5, 1) NOT NULL,
	"duration_type" text NOT NULL,
	"reason" text NOT NULL,
	"document_file_id" bigint,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" bigint,
	"decided_at" timestamp (6) with time zone,
	"decision_notes" text,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leave_types" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"is_paid" boolean DEFAULT true NOT NULL,
	"annual_quota" numeric(5, 1),
	"max_consecutive_days" smallint,
	"requires_document" boolean DEFAULT false NOT NULL,
	"carry_forward" boolean,
	"carry_forward_limit" numeric(5, 1),
	"applicable_to" text NOT NULL,
	"leave_category" text NOT NULL,
	"accrual_basis" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_attendance" (
	"tenant_id" bigint NOT NULL,
	"staff_id" bigint NOT NULL,
	"attendance_date" date NOT NULL,
	"status" text NOT NULL,
	"check_in" timestamp (6) with time zone,
	"check_out" timestamp (6) with time zone,
	"worked_minutes" integer,
	"leave_request_id" bigint,
	"shift_id" bigint,
	"source" text DEFAULT 'manual' NOT NULL,
	"marked_by" bigint,
	"marked_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "staff_attendance_staff_id_attendance_date_pk" PRIMARY KEY("staff_id","attendance_date")
);
--> statement-breakpoint
CREATE TABLE "student_attendance" (
	"tenant_id" bigint NOT NULL,
	"enrollment_id" bigint NOT NULL,
	"attendance_date" date NOT NULL,
	"status" text NOT NULL,
	"check_in" time,
	"check_out" time,
	"remarks" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"marked_by" bigint,
	"marked_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "student_attendance_enrollment_id_attendance_date_pk" PRIMARY KEY("enrollment_id","attendance_date")
);
--> statement-breakpoint
ALTER TABLE "academic_calendar_events" ADD CONSTRAINT "academic_calendar_events_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "academic_calendar_events" ADD CONSTRAINT "academic_calendar_events_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "attendance_rules" ADD CONSTRAINT "attendance_rules_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "leave_balances" ADD CONSTRAINT "leave_balances_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "leave_balances" ADD CONSTRAINT "leave_balances_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "leave_balances" ADD CONSTRAINT "leave_balances_leave_type_id_leave_types_id_fk" FOREIGN KEY ("leave_type_id") REFERENCES "public"."leave_types"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_leave_type_id_leave_types_id_fk" FOREIGN KEY ("leave_type_id") REFERENCES "public"."leave_types"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "leave_types" ADD CONSTRAINT "leave_types_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "staff_attendance" ADD CONSTRAINT "staff_attendance_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "staff_attendance" ADD CONSTRAINT "staff_attendance_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "staff_attendance" ADD CONSTRAINT "staff_attendance_leave_request_id_leave_requests_id_fk" FOREIGN KEY ("leave_request_id") REFERENCES "public"."leave_requests"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "staff_attendance" ADD CONSTRAINT "staff_attendance_marked_by_users_id_fk" FOREIGN KEY ("marked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "student_attendance" ADD CONSTRAINT "student_attendance_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "student_attendance" ADD CONSTRAINT "student_attendance_marked_by_users_id_fk" FOREIGN KEY ("marked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "academic_calendar_events_tenant_id_type_idx" ON "academic_calendar_events" USING btree ("tenant_id","event_type");--> statement-breakpoint
CREATE INDEX "academic_calendar_events_tenant_id_starts_at_idx" ON "academic_calendar_events" USING btree ("tenant_id","starts_at");--> statement-breakpoint
CREATE INDEX "attendance_rules_tenant_id_audience_idx" ON "attendance_rules" USING btree ("tenant_id","audience");--> statement-breakpoint
CREATE UNIQUE INDEX "leave_balances_tenant_staff_type_year_key" ON "leave_balances" USING btree ("tenant_id","staff_id","leave_type_id","academic_year_id");--> statement-breakpoint
CREATE INDEX "leave_requests_tenant_id_status_idx" ON "leave_requests" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "leave_requests_tenant_id_student_id_idx" ON "leave_requests" USING btree ("tenant_id","student_id");--> statement-breakpoint
CREATE INDEX "leave_requests_tenant_id_staff_id_idx" ON "leave_requests" USING btree ("tenant_id","staff_id");--> statement-breakpoint
CREATE UNIQUE INDEX "leave_types_tenant_id_code_key" ON "leave_types" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "staff_attendance_tenant_id_date_idx" ON "staff_attendance" USING btree ("tenant_id","attendance_date");--> statement-breakpoint
CREATE INDEX "student_attendance_tenant_id_date_idx" ON "student_attendance" USING btree ("tenant_id","attendance_date");