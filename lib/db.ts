import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

export const dataDir = resolve(
  /* turbopackIgnore: true */ process.env.DATA_DIR || "./data",
);
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const globalDB = globalThis as unknown as { zoraDB?: Database.Database };
export const db =
  globalDB.zoraDB ?? new Database(resolve(dataDir, "zora.sqlite"));
globalDB.zoraDB = db;
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.exec(`
 CREATE TABLE IF NOT EXISTS files (
 id TEXT PRIMARY KEY, userId TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL,
 size INTEGER NOT NULL, createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','ready','deleting')));
 CREATE INDEX IF NOT EXISTS files_owner ON files(userId);
 CREATE INDEX IF NOT EXISTS files_expiry ON files(expiresAt);
 CREATE TABLE IF NOT EXISTS upload_events (userId TEXT NOT NULL, createdAt INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS events_owner_date ON upload_events(userId,createdAt);
 CREATE TABLE IF NOT EXISTS reports (fileId TEXT PRIMARY KEY, createdAt INTEGER NOT NULL);
`);
export type StoredFile = {
  id: string;
  userId: string;
  name: string;
  mime: string;
  size: number;
  createdAt: number;
  expiresAt: number;
  status: "pending" | "ready" | "deleting";
};
