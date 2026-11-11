// One-time step for a database that already has these exact tables (created earlier by Prisma, or by
// the Supabase/DigitalOcean setup before this migration) - marks drizzle/0000_*.sql as already applied,
// WITHOUT running its CREATE TABLE statements again (which would fail with "already exists").
//
// A brand new, empty database does NOT need this - just run `npm run db:migrate` directly.
//
// Usage:  npx tsx scripts/baseline-drizzle-migration.ts
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { config } from "../src/config";

const MIGRATIONS_DIR = join(__dirname, "..", "drizzle");
const JOURNAL_PATH = join(MIGRATIONS_DIR, "meta", "_journal.json");

async function main() {
  const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf8"));
  const sqlFiles = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
  if (sqlFiles.length !== 1 || journal.entries.length !== 1) {
    throw new Error(
      "This script only knows how to baseline a single initial migration. " +
        "If you've added more migrations since, baseline manually - see drizzle-orm's migrator.js for the exact hash/table format.",
    );
  }
  const entry = journal.entries[0];
  const sqlPath = join(MIGRATIONS_DIR, `${entry.tag}.sql`);
  const hash = createHash("sha256").update(readFileSync(sqlPath, "utf8")).digest("hex");

  const client = new Client({ connectionString: config.DIRECT_URL ?? config.DATABASE_URL });
  await client.connect();
  try {
    await client.query("CREATE SCHEMA IF NOT EXISTS drizzle");
    await client.query(
      "CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)",
    );
    const { rows } = await client.query("SELECT 1 FROM drizzle.__drizzle_migrations LIMIT 1");
    if (rows.length > 0) {
      console.log("Already baselined (drizzle.__drizzle_migrations has rows) - nothing to do.");
      return;
    }
    await client.query("INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)", [
      hash,
      entry.when,
    ]);
    console.log(`Baselined ${entry.tag}.sql (hash ${hash.slice(0, 12)}...) against the current database.`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
