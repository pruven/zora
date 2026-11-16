import EmbeddedPostgres from "embedded-postgres";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import * as schema from "../lib/schema";

// Always create a disposable local database. Never read a developer's DATABASE_URL.
export async function testPostgres() {
  const directory = await mkdtemp(join(tmpdir(), "zora-pg-"));
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  const password = randomBytes(24).toString("hex");
  let logs = "";
  const postgres = new EmbeddedPostgres({
    databaseDir: join(directory, "db"),
    port,
    user: "postgres",
    password,
    persistent: false,
    autoRehydrateSymlinks: true,
    initdbFlags: ["--locale=C", "--encoding=UTF8"],
    postgresFlags: ["-h", "127.0.0.1", "-k", directory],
    onLog: (message) => {
      logs += message;
    },
    onError: (message) => {
      logs += String(message);
    },
  });
  const url = `postgresql://postgres:${password}@127.0.0.1:${port}/postgres`;
  const pool = new Pool({ connectionString: url, max: 5 });
  try {
    await postgres.initialise();
    await postgres.start();
    const db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: "./drizzle" });
    return {
      url,
      pool,
      db,
      directory,
      async stop() {
        await pool.end();
        await postgres.stop();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await pool.end();
    await postgres.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
    throw new Error(
      `Test Postgres failed: ${error instanceof Error ? error.message : error}\n${logs}`,
    );
  }
}
