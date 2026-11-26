CREATE TABLE "class_notes" (
"id" bigserial PRIMARY KEY NOT NULL,
"tenant_id" bigint NOT NULL,
"class_id" bigint NOT NULL,
"subject_id" bigint,
"title" text NOT NULL,
"description" text,
"file_id" bigint NOT NULL,
"uploaded_by" bigint,
"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
"deleted_at" timestamp (6) with time zone
);
--> statement-breakpoint
ALTER TABLE "class_notes" ADD CONSTRAINT "class_notes_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "class_notes" ADD CONSTRAINT "class_notes_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "class_notes" ADD CONSTRAINT "class_notes_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "class_notes" ADD CONSTRAINT "class_notes_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "class_notes" ADD CONSTRAINT "class_notes_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "class_notes_tenant_id_class_id_idx" ON "class_notes" USING btree ("tenant_id","class_id");