import "dotenv/config";
import pg from "pg";

async function main() {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    const t = await c.query(
      `select table_name from information_schema.tables
        where table_schema = 'public' and (table_name ilike '%notif%' or table_name ilike '%push%' or table_name ilike '%device%')
        order by table_name`,
    );
    console.log("Tables matching notif / push / device:");
    console.table(t.rows);

    for (const row of t.rows) {
      const cols = await c.query(
        `select column_name, data_type, is_nullable from information_schema.columns
          where table_schema = 'public' and table_name = $1 order by ordinal_position`,
        [row.table_name],
      );
      console.log("\nColumns of", row.table_name);
      console.table(cols.rows);
      const n = await c.query(`select count(*)::int as n from "${row.table_name}"`);
      console.log("rows:", n.rows[0].n);
    }
  } catch (e) {
    console.log("FAILED:", (e as Error).message);
  } finally {
    await c.end().catch(() => {});
  }
}

main();