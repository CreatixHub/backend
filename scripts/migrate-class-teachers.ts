// Creates the class_teachers table (migration 0015) on its own, without drizzle-kit.
// Safe to run more than once: every statement is guarded with IF NOT EXISTS.
//
// Usage (from the backend folder):  npx tsx scripts/migrate-class-teachers.ts
import { Client } from 'pg';
import { config } from '../src/config';

const SQL = `
CREATE TABLE IF NOT EXISTS "class_teachers" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "tenant_id" bigint NOT NULL,
  "class_id" bigint NOT NULL,
  "teacher_id" bigint NOT NULL,
  "created_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "class_teachers" ADD CONSTRAINT "class_teachers_tenant_id_organizations_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "class_teachers" ADD CONSTRAINT "class_teachers_class_id_classes_id_fk"
    FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE restrict ON UPDATE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "class_teachers" ADD CONSTRAINT "class_teachers_teacher_id_staff_id_fk"
    FOREIGN KEY ("teacher_id") REFERENCES "public"."staff"("id") ON DELETE restrict ON UPDATE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "class_teachers_tenant_id_class_id_key"
  ON "class_teachers" USING btree ("tenant_id","class_id");
CREATE INDEX IF NOT EXISTS "class_teachers_tenant_id_teacher_id_idx"
  ON "class_teachers" USING btree ("tenant_id","teacher_id");
`;

async function main() {
  const client = new Client({ connectionString: config.DIRECT_URL ?? config.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(SQL);
    await client.query('COMMIT');
    const r = await client.query('SELECT count(*)::int AS n FROM class_teachers');
    console.log(`OK - class_teachers table is ready (${r.rows[0].n} rows).`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('Migration failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});