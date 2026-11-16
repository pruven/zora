import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
const connectionString =
  process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!connectionString)
  throw new Error(
    "Set DATABASE_URL (and optionally DATABASE_URL_UNPOOLED) before running migrations.",
  );
const pool = new Pool({
  connectionString,
  max: 1,
  connectionTimeoutMillis: 10_000,
});
try {
  await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
  console.log("Database migrations applied.");
} finally {
  await pool.end();
}
