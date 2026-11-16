import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

// Pools open connections on demand, so the production build needs no database access.
// The inert fallback prevents pg from using a machine's default database when unconfigured.
const shared = globalThis as unknown as { zoraPool?: Pool };
function createPool() {
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ||
      "postgresql://unconfigured:unconfigured@127.0.0.1:1/unconfigured",
    max: 5,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: true,
  });
  pool.on("error", (error) =>
    console.error("Database connection failed:", error.message),
  );
  return pool;
}
export const pool = (shared.zoraPool ??= createPool());
export const db = drizzle(pool, { schema });
export type StoredFile = typeof schema.files.$inferSelect;
