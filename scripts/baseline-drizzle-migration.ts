// One-time step for a database that already has the ORIGINAL 9 tables (created earlier by Prisma, or by
// the Supabase/DigitalOcean setup before the Drizzle migration) - marks drizzle/0000_*.sql (only) as
// already applied, WITHOUT running its CREATE TABLE statements again (which would fail with "already
// exists"). Any later migration (0001+, the new modules) still gets applied normally by `npm run db:migrate`
// right after this - run that second.
//
// Also fixes a real gap this causes: Prisma's own migrations never put a DB-level DEFAULT CURRENT_TIMESTAMP
// on updated_at (Prisma's @updatedAt was handled entirely in application code), but Drizzle's schema.ts
// expects one - every insert that doesn't explicitly set updatedAt relies on it. Found 2026-11-12 when
// signup broke with "null value in column updated_at" on a baselined-from-Prisma database.
//
// A brand new, empty database does NOT need this at all - just run `npm run db:migrate` directly.
//
// Usage:  npx tsx scripts/baseline-drizzle-migration.ts
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { config } from "../src/config";

const MIGRATIONS_DIR = join(__dirname, "..", "drizzle");
const JOURNAL_PATH = join(MIGRATIONS_DIR, "meta", "_journal.json");
// The 9-table auth/tenant foundation this baseline covers - the only tables old enough to have been
// created by Prisma instead of a real Drizzle migration.
const ORIGINAL_TABLES = [
  "organizations",
  "users",
  "memberships",
  "roles",
  "permissions",
  "role_permissions",
  "membership_roles",
  "refresh_tokens",
  "audit_log",
];

async function main() {
  const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf8"));
  const initial = journal.entries.find((e: { idx: number }) => e.idx === 0);
  if (!initial) throw new Error("No migration with idx 0 in meta/_journal.json - nothing to baseline.");
  const sqlPath = join(MIGRATIONS_DIR, `${initial.tag}.sql`);
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
      initial.when,
    ]);
    console.log(`Baselined ${initial.tag}.sql (hash ${hash.slice(0, 12)}...) against the current database.`);

    // Fix the missing DEFAULT CURRENT_TIMESTAMP on updated_at - see the file comment above.
    for (const table of ORIGINAL_TABLES) {
      const { rows: cols } = await client.query(
        "SELECT column_default FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name='updated_at'",
        [table],
      );
      if (cols.length > 0 && cols[0].column_default === null) {
        await client.query(`ALTER TABLE "${table}" ALTER COLUMN updated_at SET DEFAULT CURRENT_TIMESTAMP`);
        console.log(`  fixed missing updated_at default on "${table}"`);
      }
    }
    console.log("Now run: npm run db:migrate   (applies any migration after 0000 - the newer modules)");
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
