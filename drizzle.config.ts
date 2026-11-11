import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    // migrations run over the DIRECT connection, same reason prisma/schema.prisma needed directUrl:
    // a pooled/pgbouncer connection breaks the prepared statements a migration runner issues.
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL!,
  },
});
