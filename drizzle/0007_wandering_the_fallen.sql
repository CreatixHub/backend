CREATE TABLE "asset_allocations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"asset_id" bigint NOT NULL,
	"staff_id" bigint,
	"student_id" bigint,
	"classroom_id" bigint,
	"allocated_on" date,
	"expected_return_on" date,
	"returned_on" date,
	"condition_out" text,
	"condition_in" text,
	"notes" text,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "asset_allocations_one_target" CHECK (("asset_allocations"."staff_id" IS NOT NULL)::int + ("asset_allocations"."student_id" IS NOT NULL)::int + ("asset_allocations"."classroom_id" IS NOT NULL)::int = 1)
);
--> statement-breakpoint
CREATE TABLE "asset_categories" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"name" text NOT NULL,
	"parent_id" bigint,
	"depreciation_method" text DEFAULT 'none' NOT NULL,
	"useful_life_years" smallint,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asset_maintenance" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"asset_id" bigint NOT NULL,
	"maintenance_type" text NOT NULL,
	"description" text,
	"reported_on" date,
	"started_on" date,
	"completed_on" date,
	"cost" numeric(12, 2),
	"labour_cost" numeric(12, 2),
	"parts_cost" numeric(12, 2),
	"vendor_id" bigint,
	"status" text DEFAULT 'reported' NOT NULL,
	"next_due_on" date,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"asset_tag" text NOT NULL,
	"name" text NOT NULL,
	"category_id" bigint NOT NULL,
	"vendor_id" bigint,
	"branch_id" bigint,
	"quantity" integer DEFAULT 1 NOT NULL,
	"serial_no" text,
	"model" text,
	"purchase_date" date,
	"purchase_cost" numeric(12, 2),
	"warranty_until" date,
	"salvage_value" numeric(12, 2),
	"location_classroom_id" bigint,
	"status" text DEFAULT 'in_store' NOT NULL,
	"condition" text DEFAULT 'good' NOT NULL,
	"disposed_on" date,
	"disposal_value" numeric(12, 2),
	"notes" text,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "asset_allocations" ADD CONSTRAINT "asset_allocations_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_allocations" ADD CONSTRAINT "asset_allocations_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_allocations" ADD CONSTRAINT "asset_allocations_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_allocations" ADD CONSTRAINT "asset_allocations_classroom_id_classrooms_id_fk" FOREIGN KEY ("classroom_id") REFERENCES "public"."classrooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_categories" ADD CONSTRAINT "asset_categories_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_categories" ADD CONSTRAINT "asset_categories_parent_id_asset_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."asset_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_maintenance" ADD CONSTRAINT "asset_maintenance_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_maintenance" ADD CONSTRAINT "asset_maintenance_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_category_id_asset_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."asset_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_location_classroom_id_classrooms_id_fk" FOREIGN KEY ("location_classroom_id") REFERENCES "public"."classrooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_allocations_one_open_uq" ON "asset_allocations" USING btree ("asset_id") WHERE "asset_allocations"."returned_on" IS NULL;--> statement-breakpoint
CREATE INDEX "asset_allocations_tenant_staff_idx" ON "asset_allocations" USING btree ("tenant_id","staff_id");--> statement-breakpoint
CREATE INDEX "asset_allocations_tenant_classroom_idx" ON "asset_allocations" USING btree ("tenant_id","classroom_id");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_categories_tenant_name_uq" ON "asset_categories" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "asset_maintenance_tenant_asset_idx" ON "asset_maintenance" USING btree ("tenant_id","asset_id");--> statement-breakpoint
CREATE INDEX "asset_maintenance_tenant_due_idx" ON "asset_maintenance" USING btree ("tenant_id","next_due_on");--> statement-breakpoint
CREATE UNIQUE INDEX "assets_tenant_tag_uq" ON "assets" USING btree ("tenant_id","asset_tag");--> statement-breakpoint
CREATE INDEX "assets_tenant_status_idx" ON "assets" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "assets_tenant_category_idx" ON "assets" USING btree ("tenant_id","category_id");