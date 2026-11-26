// Finds which Supabase pooler host accepts this project. Prints only host names, never the password.
// Usage:  npx tsx scripts/find-db-host.ts
import { Client } from "pg";
import { config } from "../src/config";

const url = new URL(config.DIRECT_URL ?? config.DATABASE_URL);
const REGIONS = [
  "ap-south-1", "ap-southeast-1", "ap-southeast-2", "ap-northeast-1", "ap-northeast-2", "ap-east-1",
  "us-east-1", "us-east-2", "us-west-1", "us-west-2", "ca-central-1",
  "eu-west-1", "eu-west-2", "eu-west-3", "eu-central-1", "eu-central-2", "eu-north-1", "sa-east-1",
];

async function tryHost(host: string): Promise<string> {
  const client = new Client({
    host,
    port: 5432,
    user: url.username,
    password: decodeURIComponent(url.password),
    database: url.pathname.slice(1) || "postgres",
    connectionTimeoutMillis: 8000,
  });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return "WORKS";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  } finally {
    await client.end().catch(() => {});
  }
}

async function main() {
  console.log("Project user:", url.username);
  for (const prefix of ["aws-1", "aws-0"]) {
    for (const region of REGIONS) {
      const host = `${prefix}-${region}.pooler.supabase.com`;
      const result = await tryHost(host);
      const notFound = /tenant\/user .* not found/i.test(result) || /ENOTFOUND/.test(result);
      if (!notFound) {
        console.log(`\n>>> ${host}\n    ${result}`);
        if (result === "WORKS") return;
      } else {
        process.stdout.write(".");
      }
    }
  }
  console.log("\nNo region accepted this project. Check in Supabase that the project is not paused or deleted.");
}

main();