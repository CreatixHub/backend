CREATE TABLE "subjects" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"subject_type" text NOT NULL,
	"credits" numeric(4, 1),
	"color" text,
	"department_id" bigint,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"deleted_at" timestamp (6) with time zone,
	"deleted_by" bigint
);
--> statement-breakpoint
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "subjects_tenant_id_code_key" ON "subjects" USING btree ("tenant_id","code") WHERE "subjects"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "subjects_tenant_id_status_idx" ON "subjects" USING btree ("tenant_id","status");