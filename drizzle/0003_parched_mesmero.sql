CREATE TABLE "class_subjects" (
	"class_id" bigint NOT NULL,
	"subject_id" bigint NOT NULL,
	"tenant_id" bigint NOT NULL,
	"is_elective" boolean DEFAULT false NOT NULL,
	"periods_per_week" smallint,
	"display_order" smallint DEFAULT 0 NOT NULL,
	"exam_marks" numeric(6, 2) NOT NULL,
	"internal_marks" numeric(6, 2) NOT NULL,
	"pass_marks" numeric(6, 2),
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "class_subjects_class_id_subject_id_pk" PRIMARY KEY("class_id","subject_id")
);
--> statement-breakpoint
CREATE TABLE "classes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"branch_id" bigint,
	"grade_level" smallint NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"stream" text,
	"category" text,
	"display_order" smallint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"deleted_at" timestamp (6) with time zone,
	"deleted_by" bigint
);
--> statement-breakpoint
CREATE TABLE "classrooms" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"branch_id" bigint,
	"code" text NOT NULL,
	"name" text,
	"building" text,
	"floor" smallint,
	"capacity" smallint,
	"room_type" text DEFAULT 'classroom' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"facilities" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"deleted_at" timestamp (6) with time zone,
	"deleted_by" bigint
);
--> statement-breakpoint
CREATE TABLE "sections" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"class_id" bigint NOT NULL,
	"name" text NOT NULL,
	"capacity" smallint NOT NULL,
	"default_classroom_id" bigint,
	"shift" text DEFAULT 'morning' NOT NULL,
	"medium" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"deleted_at" timestamp (6) with time zone,
	"deleted_by" bigint
);
--> statement-breakpoint
ALTER TABLE "class_subjects" ADD CONSTRAINT "class_subjects_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "class_subjects" ADD CONSTRAINT "class_subjects_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "class_subjects" ADD CONSTRAINT "class_subjects_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "classes" ADD CONSTRAINT "classes_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "classes" ADD CONSTRAINT "classes_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "classrooms" ADD CONSTRAINT "classrooms_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "classrooms" ADD CONSTRAINT "classrooms_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "sections" ADD CONSTRAINT "sections_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "sections" ADD CONSTRAINT "sections_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "sections" ADD CONSTRAINT "sections_default_classroom_id_classrooms_id_fk" FOREIGN KEY ("default_classroom_id") REFERENCES "public"."classrooms"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "sections" ADD CONSTRAINT "sections_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "class_subjects_tenant_id_idx" ON "class_subjects" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "classes_tenant_id_code_key" ON "classes" USING btree ("tenant_id","code") WHERE "classes"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "classes_tenant_id_status_idx" ON "classes" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "classrooms_tenant_id_code_key" ON "classrooms" USING btree ("tenant_id","code") WHERE "classrooms"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "sections_class_id_name_key" ON "sections" USING btree ("class_id","name") WHERE "sections"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "sections_tenant_id_class_id_idx" ON "sections" USING btree ("tenant_id","class_id");