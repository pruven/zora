import { randomBytes } from "node:crypto";
import { db, StoredFile } from "./db";
import {
  DAILY_UPLOADS,
  GLOBAL_BYTES,
  USER_BYTES,
  RETENTION_MS,
  appURL,
} from "./config";
import { HttpError } from "./http";
import { removeObject } from "./storage";

export function usage(userId?: string) {
  return (
    db
      .prepare(
        `SELECT COALESCE(SUM(size),0) AS bytes FROM files${userId ? " WHERE userId = ?" : ""}`,
      )
      .get(...(userId ? [userId] : [])) as { bytes: number }
  ).bytes;
}
export function reserve(
  userId: string,
  name: string,
  mime: string,
  size: number,
  now = Date.now(),
) {
  return db
    .transaction(() => {
      if (usage() + size > GLOBAL_BYTES)
        throw new HttpError(
          507,
          "Community storage is full. Existing files will stay until their expiry dates.",
        );
      if (usage(userId) + size > USER_BYTES)
        throw new HttpError(
          409,
          "Your 100 MB storage allowance is full. Delete a file first.",
        );
      const file: StoredFile = {
        id: randomBytes(24).toString("hex"),
        userId,
        name,
        mime,
        size,
        createdAt: now,
        expiresAt: now + RETENTION_MS,
        status: "pending",
      };
      db.prepare(
        "INSERT INTO files (id,userId,name,mime,size,createdAt,expiresAt,status) VALUES (@id,@userId,@name,@mime,@size,@createdAt,@expiresAt,@status)",
      ).run(file);
      return file;
    })
    .immediate();
}
export function consumeUploadAttempt(userId: string, now = Date.now()) {
  db.transaction(() => {
    const count = db
      .prepare(
        "SELECT COUNT(*) AS n FROM upload_events WHERE userId = ? AND createdAt > ?",
      )
      .get(userId, now - 86_400_000) as { n: number };
    if (count.n >= DAILY_UPLOADS)
      throw new HttpError(
        429,
        "Your daily limit is 20 upload attempts. Try again later.",
      );
    db.prepare("INSERT INTO upload_events VALUES (?,?)").run(userId, now);
  }).immediate();
}
export function publicFile(file: StoredFile) {
  const base = process.env.FILE_BASE_URL || appURL();
  return {
    id: file.id,
    name: file.name,
    size: file.size,
    mime: file.mime,
    createdAt: file.createdAt,
    expiresAt: file.expiresAt,
    url: `${base}/f/${file.id}/${encodeURIComponent(file.name)}`,
  };
}
export async function deleteFile(id: string) {
  db.prepare("UPDATE files SET status = 'deleting' WHERE id = ?").run(id);
  await removeObject(id);
  db.prepare("DELETE FROM files WHERE id = ?").run(id);
  db.prepare("DELETE FROM reports WHERE fileId = ?").run(id);
}
export async function cleanup(now = Date.now()) {
  const expired = db
    .prepare(
      "SELECT id FROM files WHERE expiresAt <= ? OR status = 'deleting' OR (status = 'pending' AND createdAt < ?) LIMIT 100",
    )
    .all(now, now - 3_600_000) as { id: string }[];
  let deleted = 0,
    failed = 0;
  for (const file of expired) {
    try {
      await deleteFile(file.id);
      deleted++;
    } catch (error) {
      console.error("Cleanup failed:", file.id, error);
      failed++;
    }
  }
  db.prepare("DELETE FROM upload_events WHERE createdAt < ?").run(
    now - 86_400_000,
  );
  return { deleted, failed };
}
