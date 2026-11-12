CREATE TABLE "admission_status_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"admission_id" bigint NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"note" text,
	"changed_by" bigint,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admissions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"application_no" text NOT NULL,
	"academic_year_id" bigint NOT NULL,
	"class_id" bigint NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"dob" date NOT NULL,
	"gender" text,
	"email" text,
	"phone" text,
	"blood_group" text,
	"religion_id" bigint,
	"social_category" text,
	"father_name" text,
	"father_phone" text,
	"father_email" text,
	"father_occupation" text,
	"mother_name" text,
	"mother_phone" text,
	"mother_email" text,
	"mother_occupation" text,
	"guardian_name" text NOT NULL,
	"guardian_phone" text NOT NULL,
	"guardian_email" text,
	"previous_school" text,
	"previous_class" text,
	"address_line1" text,
	"address_line2" text,
	"city_id" bigint,
	"postal_code" text,
	"status" text DEFAULT 'applied' NOT NULL,
	"applied_on" date NOT NULL,
	"acknowledged_at" timestamp (6) with time zone,
	"decision_on" date,
	"decided_by" bigint,
	"decision_notes" text,
	"rejection_reason" text,
	"waitlist_position" smallint,
	"assigned_to_staff_id" bigint,
	"needs_transport" boolean DEFAULT false NOT NULL,
	"needs_hostel" boolean DEFAULT false NOT NULL,
	"application_fee" numeric(12, 2),
	"fee_paid" boolean DEFAULT false NOT NULL,
	"fee_paid_on" date,
	"fee_payment_method" text,
	"source" text NOT NULL,
	"student_id" bigint,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"deleted_at" timestamp (6) with time zone
);
--> statement-breakpoint
CREATE TABLE "guardians" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"full_name" text NOT NULL,
	"relation" text NOT NULL,
	"phone" text NOT NULL,
	"alt_phone" text,
	"email" text,
	"occupation" text,
	"annual_income" numeric(12, 2),
	"address_line1" text,
	"address_line2" text,
	"city_id" bigint,
	"postal_code" text,
	"photo_file_id" bigint,
	"id_proof_type" text,
	"id_proof_no" text,
	"is_emergency_contact" boolean DEFAULT false NOT NULL,
	"deleted_by" bigint,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"deleted_at" timestamp (6) with time zone
);
--> statement-breakpoint
CREATE TABLE "student_documents" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"student_id" bigint NOT NULL,
	"document_type" text NOT NULL,
	"file_id" bigint NOT NULL,
	"document_no" text,
	"issued_on" date,
	"expires_on" date,
	"verified_status" text DEFAULT 'pending' NOT NULL,
	"verified_by" bigint,
	"verified_at" timestamp (6) with time zone,
	"remarks" text,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "student_guardians" (
	"student_id" bigint NOT NULL,
	"guardian_id" bigint NOT NULL,
	"tenant_id" bigint NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"can_pick_up" boolean DEFAULT false NOT NULL,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "student_guardians_student_id_guardian_id_pk" PRIMARY KEY("student_id","guardian_id")
);
--> statement-breakpoint
CREATE TABLE "student_houses" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"motto" text,
	"house_master_id" bigint,
	"is_active" boolean DEFAULT true NOT NULL,
	"deleted_by" bigint,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"deleted_at" timestamp (6) with time zone
);
--> statement-breakpoint
CREATE TABLE "students" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"user_id" bigint,
	"admission_id" bigint,
	"admission_no" text NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"full_name" text,
	"dob" date NOT NULL,
	"gender" text,
	"blood_group" text,
	"religion_id" bigint,
	"social_category" text,
	"mother_tongue_id" bigint,
	"photo_file_id" bigint,
	"father_name" text,
	"father_phone" text,
	"father_email" text,
	"father_occupation" text,
	"mother_name" text,
	"mother_phone" text,
	"mother_email" text,
	"mother_occupation" text,
	"primary_guardian_id" bigint,
	"address_line1" text,
	"address_line2" text,
	"city_id" bigint,
	"postal_code" text,
	"student_house_id" bigint,
	"status" text DEFAULT 'active' NOT NULL,
	"admitted_on" date NOT NULL,
	"left_on" date,
	"left_reason" text,
	"deleted_by" bigint,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"deleted_at" timestamp (6) with time zone
);
--> statement-breakpoint
ALTER TABLE "admission_status_history" ADD CONSTRAINT "admission_status_history_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "admission_status_history" ADD CONSTRAINT "admission_status_history_admission_id_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."admissions"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "admission_status_history" ADD CONSTRAINT "admission_status_history_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_assigned_to_staff_id_staff_id_fk" FOREIGN KEY ("assigned_to_staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "guardians" ADD CONSTRAINT "guardians_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "guardians" ADD CONSTRAINT "guardians_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "student_documents" ADD CONSTRAINT "student_documents_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "student_documents" ADD CONSTRAINT "student_documents_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "student_documents" ADD CONSTRAINT "student_documents_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "student_guardians" ADD CONSTRAINT "student_guardians_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "student_guardians" ADD CONSTRAINT "student_guardians_guardian_id_guardians_id_fk" FOREIGN KEY ("guardian_id") REFERENCES "public"."guardians"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "student_guardians" ADD CONSTRAINT "student_guardians_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "student_houses" ADD CONSTRAINT "student_houses_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "student_houses" ADD CONSTRAINT "student_houses_house_master_id_staff_id_fk" FOREIGN KEY ("house_master_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "student_houses" ADD CONSTRAINT "student_houses_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "students" ADD CONSTRAINT "students_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "students" ADD CONSTRAINT "students_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "students" ADD CONSTRAINT "students_admission_id_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."admissions"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "students" ADD CONSTRAINT "students_primary_guardian_id_guardians_id_fk" FOREIGN KEY ("primary_guardian_id") REFERENCES "public"."guardians"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "students" ADD CONSTRAINT "students_student_house_id_student_houses_id_fk" FOREIGN KEY ("student_house_id") REFERENCES "public"."student_houses"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "students" ADD CONSTRAINT "students_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "admission_status_history_tenant_id_admission_id_idx" ON "admission_status_history" USING btree ("tenant_id","admission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "admissions_tenant_id_application_no_key" ON "admissions" USING btree ("tenant_id","application_no");--> statement-breakpoint
CREATE UNIQUE INDEX "admissions_student_id_key" ON "admissions" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "admissions_tenant_id_academic_year_id_idx" ON "admissions" USING btree ("tenant_id","academic_year_id");--> statement-breakpoint
CREATE INDEX "admissions_tenant_id_class_id_idx" ON "admissions" USING btree ("tenant_id","class_id");--> statement-breakpoint
CREATE INDEX "admissions_tenant_id_status_idx" ON "admissions" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "guardians_tenant_id_phone_idx" ON "guardians" USING btree ("tenant_id","phone");--> statement-breakpoint
CREATE INDEX "student_documents_tenant_id_student_id_idx" ON "student_documents" USING btree ("tenant_id","student_id");--> statement-breakpoint
CREATE INDEX "student_guardians_tenant_id_idx" ON "student_guardians" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "student_guardians_guardian_id_idx" ON "student_guardians" USING btree ("guardian_id");--> statement-breakpoint
CREATE UNIQUE INDEX "student_houses_tenant_id_name_key" ON "student_houses" USING btree ("tenant_id","name") WHERE "student_houses"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "students_tenant_id_admission_no_key" ON "students" USING btree ("tenant_id","admission_no");--> statement-breakpoint
CREATE UNIQUE INDEX "students_admission_id_key" ON "students" USING btree ("admission_id");--> statement-breakpoint
CREATE INDEX "students_tenant_id_status_idx" ON "students" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "students_tenant_id_student_house_id_idx" ON "students" USING btree ("tenant_id","student_house_id");--> statement-breakpoint
CREATE INDEX "students_user_id_idx" ON "students" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "asset_allocations" ADD CONSTRAINT "asset_allocations_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transport_assignments" ADD CONSTRAINT "transport_assignments_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE restrict ON UPDATE cascade;