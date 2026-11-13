CREATE TABLE "expense_categories" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"name" text NOT NULL,
	"parent_id" bigint,
	"annual_budget" numeric(12, 2),
	"per_expense_limit" numeric(12, 2),
	"approval_level" text DEFAULT 'manager' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"expense_no" text NOT NULL,
	"category_id" bigint NOT NULL,
	"vendor_id" bigint,
	"branch_id" bigint,
	"staff_id" bigint,
	"priority" text DEFAULT 'normal' NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"tax_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"expense_date" date NOT NULL,
	"description" text NOT NULL,
	"payment_method" text,
	"receipt_file_id" bigint,
	"status" text DEFAULT 'submitted' NOT NULL,
	"approved_by" bigint,
	"approved_at" timestamp (6) with time zone,
	"paid_at" timestamp (6) with time zone,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fee_assignments" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"enrollment_id" bigint NOT NULL,
	"fee_structure_id" bigint NOT NULL,
	"assigned_on" date NOT NULL,
	"discount_percent" numeric(5, 2) DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fee_groups" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"category" text NOT NULL,
	"display_order" smallint DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fee_installments" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"fee_structure_id" bigint NOT NULL,
	"name" text NOT NULL,
	"sequence" smallint NOT NULL,
	"due_on" date NOT NULL,
	"percent_of_total" numeric(5, 2) NOT NULL,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fee_structure_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"fee_structure_id" bigint NOT NULL,
	"fee_type_id" bigint NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"is_optional" boolean DEFAULT false NOT NULL,
	"due_on" date,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fee_structures" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"academic_year_id" bigint NOT NULL,
	"class_id" bigint NOT NULL,
	"name" text,
	"code" text,
	"description" text,
	"frequency" text NOT NULL,
	"effective_from" date,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fee_types" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"fee_group_id" bigint,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"frequency" text NOT NULL,
	"is_refundable" boolean DEFAULT false NOT NULL,
	"is_mandatory" boolean DEFAULT true NOT NULL,
	"late_fee_applicable" boolean DEFAULT false NOT NULL,
	"default_amount" numeric(12, 2),
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"invoice_id" bigint NOT NULL,
	"line_type" text NOT NULL,
	"fee_type_id" bigint,
	"quantity" numeric(10, 2) DEFAULT '1' NOT NULL,
	"unit_amount" numeric(12, 2) NOT NULL,
	"discount_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"tax_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"line_total" numeric(12, 2) NOT NULL,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"number" text NOT NULL,
	"student_id" bigint NOT NULL,
	"enrollment_id" bigint,
	"academic_year_id" bigint NOT NULL,
	"installment_id" bigint,
	"issued_on" date NOT NULL,
	"due_on" date NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" bigint NOT NULL,
	"receipt_no" text NOT NULL,
	"student_id" bigint NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"method" text NOT NULL,
	"received_at" timestamp (6) with time zone NOT NULL,
	"received_by" bigint,
	"status" text DEFAULT 'cleared' NOT NULL,
	"idempotency_key" text,
	"cheque_no" text,
	"cheque_date" date,
	"cheque_status" text,
	"created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_parent_id_expense_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."expense_categories"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_category_id_expense_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."expense_categories"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "fee_assignments" ADD CONSTRAINT "fee_assignments_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "fee_assignments" ADD CONSTRAINT "fee_assignments_fee_structure_id_fee_structures_id_fk" FOREIGN KEY ("fee_structure_id") REFERENCES "public"."fee_structures"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "fee_groups" ADD CONSTRAINT "fee_groups_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "fee_installments" ADD CONSTRAINT "fee_installments_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "fee_installments" ADD CONSTRAINT "fee_installments_fee_structure_id_fee_structures_id_fk" FOREIGN KEY ("fee_structure_id") REFERENCES "public"."fee_structures"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "fee_structure_items" ADD CONSTRAINT "fee_structure_items_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "fee_structure_items" ADD CONSTRAINT "fee_structure_items_fee_structure_id_fee_structures_id_fk" FOREIGN KEY ("fee_structure_id") REFERENCES "public"."fee_structures"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "fee_structure_items" ADD CONSTRAINT "fee_structure_items_fee_type_id_fee_types_id_fk" FOREIGN KEY ("fee_type_id") REFERENCES "public"."fee_types"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "fee_structures" ADD CONSTRAINT "fee_structures_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "fee_structures" ADD CONSTRAINT "fee_structures_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "fee_types" ADD CONSTRAINT "fee_types_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "fee_types" ADD CONSTRAINT "fee_types_fee_group_id_fee_groups_id_fk" FOREIGN KEY ("fee_group_id") REFERENCES "public"."fee_groups"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_fee_type_id_fee_types_id_fk" FOREIGN KEY ("fee_type_id") REFERENCES "public"."fee_types"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_installment_id_fee_installments_id_fk" FOREIGN KEY ("installment_id") REFERENCES "public"."fee_installments"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_received_by_users_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "expense_categories_tenant_id_name_key" ON "expense_categories" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "expenses_tenant_id_expense_no_key" ON "expenses" USING btree ("tenant_id","expense_no");--> statement-breakpoint
CREATE INDEX "expenses_tenant_id_status_idx" ON "expenses" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "expenses_tenant_id_category_id_idx" ON "expenses" USING btree ("tenant_id","category_id");--> statement-breakpoint
CREATE INDEX "fee_assignments_tenant_id_enrollment_id_idx" ON "fee_assignments" USING btree ("tenant_id","enrollment_id");--> statement-breakpoint
CREATE INDEX "fee_assignments_tenant_id_structure_id_idx" ON "fee_assignments" USING btree ("tenant_id","fee_structure_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fee_groups_tenant_id_name_key" ON "fee_groups" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "fee_installments_tenant_id_structure_id_idx" ON "fee_installments" USING btree ("tenant_id","fee_structure_id");--> statement-breakpoint
CREATE INDEX "fee_structure_items_tenant_id_structure_id_idx" ON "fee_structure_items" USING btree ("tenant_id","fee_structure_id");--> statement-breakpoint
CREATE INDEX "fee_structures_tenant_id_class_id_idx" ON "fee_structures" USING btree ("tenant_id","class_id");--> statement-breakpoint
CREATE INDEX "fee_structures_tenant_id_academic_year_id_idx" ON "fee_structures" USING btree ("tenant_id","academic_year_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fee_types_tenant_id_code_key" ON "fee_types" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "invoice_lines_tenant_id_invoice_id_idx" ON "invoice_lines" USING btree ("tenant_id","invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_tenant_id_number_key" ON "invoices" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "invoices_tenant_id_student_id_idx" ON "invoices" USING btree ("tenant_id","student_id");--> statement-breakpoint
CREATE INDEX "invoices_tenant_id_status_idx" ON "invoices" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_tenant_id_receipt_no_key" ON "payments" USING btree ("tenant_id","receipt_no");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_tenant_id_idempotency_key_key" ON "payments" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "payments_tenant_id_student_id_idx" ON "payments" USING btree ("tenant_id","student_id");