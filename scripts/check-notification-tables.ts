import { pool } from "../src/db";

async function main() {
  try {
    const result = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name IN (
        'notifications',
        'device_push_tokens'
      )
      ORDER BY table_name
    `);

    console.log("Database connected successfully.");
    console.table(result.rows);

    const required = ["notifications", "device_push_tokens"];

    for (const table of required) {
      const exists = result.rows.some(
        row => row.table_name === table
      );

      console.log(
        table + ": " + (exists ? "EXISTS" : "MISSING")
      );
    }
  } catch (error) {
    console.error("Database check failed:", error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
