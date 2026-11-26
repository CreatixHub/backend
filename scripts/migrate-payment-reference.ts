// Adds payments.reference_no (the UPI reference number a student enters after paying).
// Safe to run more than once.   Usage:  npx tsx scripts/migrate-payment-reference.ts
import { Client } from 'pg';
import { config } from '../src/config';

const SQL = `
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "reference_no" text;
CREATE UNIQUE INDEX IF NOT EXISTS "payments_tenant_id_reference_no_key"
  ON "payments" USING btree ("tenant_id","reference_no");
`;

async function main() {
  const client = new Client({
    connectionString: config.DIRECT_URL ?? config.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(SQL);
    await client.query('COMMIT');
    console.log('OK - payments.reference_no is ready.');
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