CREATE TABLE "drivers" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"staff_id" bigint,
	"full_name" text NOT NULL,
	"phone" text NOT NULL,
	"license_no" text NOT NULL,
	"license_expiry" date NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pickup_points" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"route_id" bigint NOT NULL,
	"name" text NOT NULL,
	"sequence" smallint NOT NULL,
	"landmark" text,
	"latitude" numeric(9, 6),
	"longitude" numeric(9, 6),
	"pickup_time" time,
	"drop_time" time,
	"monthly_fee" numeric(12, 2) NOT NULL,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "route_schedules" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"route_id" bigint NOT NULL,
	"vehicle_id" bigint NOT NULL,
	"driver_id" bigint NOT NULL,
	"attendant_staff_id" bigint,
	"shift" text NOT NULL,
	"operating_days" smallint[] NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date NOT NULL,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transport_assignments" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"student_id" bigint,
	"staff_id" bigint,
	"academic_year_id" bigint NOT NULL,
	"route_id" bigint NOT NULL,
	"pickup_point_id" bigint NOT NULL,
	"direction" text DEFAULT 'both' NOT NULL,
	"monthly_fee" numeric(12, 2) NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transport_routes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"branch_id" bigint,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"start_location" text,
	"end_location" text,
	"distance_km" numeric(6, 2),
	"estimated_minutes" smallint,
	"shift" text DEFAULT 'morning' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vehicles" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"branch_id" bigint,
	"registration_no" text NOT NULL,
	"vehicle_type" text NOT NULL,
	"seating_capacity" smallint NOT NULL,
	"insurance_expiry" date,
	"fitness_expiry" date,
	"permit_expiry" date,
	"pollution_expiry" date,
	"gps_device_id" text,
	"chassis_no" text,
	"engine_no" text,
	"make" text,
	"model" text,
	"manufacture_year" smallint,
	"odometer_km" integer,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "pickup_points" ADD CONSTRAINT "pickup_points_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "pickup_points" ADD CONSTRAINT "pickup_points_route_id_transport_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."transport_routes"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "route_schedules" ADD CONSTRAINT "route_schedules_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "route_schedules" ADD CONSTRAINT "route_schedules_route_id_transport_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."transport_routes"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "route_schedules" ADD CONSTRAINT "route_schedules_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "route_schedules" ADD CONSTRAINT "route_schedules_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "route_schedules" ADD CONSTRAINT "route_schedules_attendant_staff_id_staff_id_fk" FOREIGN KEY ("attendant_staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "transport_assignments" ADD CONSTRAINT "transport_assignments_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "transport_assignments" ADD CONSTRAINT "transport_assignments_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "transport_assignments" ADD CONSTRAINT "transport_assignments_route_id_transport_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."transport_routes"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "transport_assignments" ADD CONSTRAINT "transport_assignments_pickup_point_id_pickup_points_id_fk" FOREIGN KEY ("pickup_point_id") REFERENCES "public"."pickup_points"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "transport_routes" ADD CONSTRAINT "transport_routes_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "drivers_tenant_id_license_no_key" ON "drivers" USING btree ("tenant_id","license_no");--> statement-breakpoint
CREATE UNIQUE INDEX "pickup_points_route_id_sequence_key" ON "pickup_points" USING btree ("route_id","sequence");--> statement-breakpoint
CREATE INDEX "pickup_points_tenant_id_route_id_idx" ON "pickup_points" USING btree ("tenant_id","route_id");--> statement-breakpoint
CREATE INDEX "route_schedules_tenant_id_route_id_idx" ON "route_schedules" USING btree ("tenant_id","route_id");--> statement-breakpoint
CREATE INDEX "route_schedules_vehicle_id_idx" ON "route_schedules" USING btree ("vehicle_id");--> statement-breakpoint
CREATE INDEX "route_schedules_driver_id_idx" ON "route_schedules" USING btree ("driver_id");--> statement-breakpoint
CREATE INDEX "transport_assignments_tenant_id_route_id_year_idx" ON "transport_assignments" USING btree ("tenant_id","route_id","academic_year_id");--> statement-breakpoint
CREATE INDEX "transport_assignments_tenant_id_student_id_idx" ON "transport_assignments" USING btree ("tenant_id","student_id");--> statement-breakpoint
CREATE INDEX "transport_assignments_tenant_id_staff_id_idx" ON "transport_assignments" USING btree ("tenant_id","staff_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transport_routes_tenant_id_code_key" ON "transport_routes" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "vehicles_tenant_id_registration_no_key" ON "vehicles" USING btree ("tenant_id","registration_no");--> statement-breakpoint
CREATE INDEX "vehicles_tenant_id_status_idx" ON "vehicles" USING btree ("tenant_id","status");