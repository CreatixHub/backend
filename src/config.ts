import "dotenv/config"; // loads .env into process.env
import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  // used only by migration tooling (drizzle.config.ts, scripts/baseline-drizzle-migration.ts) - a pooled
  // connection (pgbouncer) breaks the prepared statements a migration runner issues. Optional: locally
  // there's no pooler, so DATABASE_URL already works fine for migrations too.
  DIRECT_URL: z.string().optional(),
  JWT_ACCESS_SECRET: z.string().min(32, "must be at least 32 characters (generate with: openssl rand -hex 32)"),
  JWT_ACCESS_TTL: z.coerce.number().int().positive().default(900), // seconds
  REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),
  AUTH_RATE_LIMIT: z.coerce.number().int().positive().default(10), // sign-up / sign-in attempts per minute per IP
  PORT: z.coerce.number().int().positive().default(5000),
  CORS_ORIGINS: z.string().optional(), // comma separated list of allowed browser origins
  COOKIE_SECURE: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  NODE_ENV: z.string().optional(), // "production" on the server
  DOCS_ENABLED: z.enum(["true", "false"]).optional(), // API docs at /api/docs; default: on, except when NODE_ENV=production
});

// Fail fast with a readable message instead of crashing later with "undefined".
const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment (.env):");
  for (const issue of parsed.error.issues) {
    console.error("  " + issue.path.join(".") + ": " + issue.message);
  }
  process.exit(1);
}

export const config = parsed.data;
