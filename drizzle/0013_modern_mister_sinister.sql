CREATE TABLE "exit_passes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"student_id" bigint,
	"requested_by_guardian_id" bigint,
	"requested_by_staff_id" bigint,
	"reason" text NOT NULL,
	"reason_type" text NOT NULL,
	"requested_exit_at" timestamp (6) with time zone NOT NULL,
	"expected_return_at" timestamp (6) with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"approved_by" bigint,
	"approved_at" timestamp (6) with time zone,
	"rejection_reason" text,
	"picked_up_by_guardian_id" bigint,
	"authorized_person_name" text,
	"authorized_person_relation" text,
	"actual_exit_at" timestamp (6) with time zone,
	"actual_return_at" timestamp (6) with time zone,
	"pass_code" text NOT NULL,
	"used_at" timestamp (6) with time zone,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "exit_passes" ADD CONSTRAINT "exit_passes_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "exit_passes" ADD CONSTRAINT "exit_passes_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "exit_passes" ADD CONSTRAINT "exit_passes_requested_by_guardian_id_guardians_id_fk" FOREIGN KEY ("requested_by_guardian_id") REFERENCES "public"."guardians"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "exit_passes" ADD CONSTRAINT "exit_passes_requested_by_staff_id_staff_id_fk" FOREIGN KEY ("requested_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "exit_passes" ADD CONSTRAINT "exit_passes_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "exit_passes" ADD CONSTRAINT "exit_passes_picked_up_by_guardian_id_guardians_id_fk" FOREIGN KEY ("picked_up_by_guardian_id") REFERENCES "public"."guardians"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "exit_passes_tenant_id_pass_code_key" ON "exit_passes" USING btree ("tenant_id","pass_code");--> statement-breakpoint
CREATE INDEX "exit_passes_tenant_id_student_id_idx" ON "exit_passes" USING btree ("tenant_id","student_id");--> statement-breakpoint
CREATE INDEX "exit_passes_tenant_id_status_idx" ON "exit_passes" USING btree ("tenant_id","status");