import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { config } from "./config";
import * as schema from "./db/schema";

// One shared pool, one shared Drizzle instance - the same role src/db.ts's PrismaClient used to play.
export const pool = new Pool({ connectionString: config.DATABASE_URL });

export const db = drizzle(pool, { schema });
