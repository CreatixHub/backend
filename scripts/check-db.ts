import "dotenv/config";
import pg from "pg";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("DATABASE_URL is missing in .env");
    return;
  }

  const u = new URL(url);
  console.log("host:", u.hostname, "port:", u.port, "user:", decodeURIComponent(u.username), "db:", u.pathname);

  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
    const r = await client.query("select count(*)::int as n from users");
    console.log("OK - connected, users:", r.rows[0].n);
  } catch (e) {
    console.log("FAILED:", (e as Error).message);
  } finally {
    await client.end().catch(() => {});
  }
}

main();