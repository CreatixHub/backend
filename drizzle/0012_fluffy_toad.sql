ALTER TABLE "guardians" ADD COLUMN "user_id" bigint;--> statement-breakpoint
ALTER TABLE "guardians" ADD CONSTRAINT "guardians_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "guardians_tenant_id_user_id_idx" ON "guardians" USING btree ("tenant_id","user_id");