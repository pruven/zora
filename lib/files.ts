import { randomBytes } from "node:crypto";
import { and, count, desc, eq, gt, lt, lte, or, sql } from "drizzle-orm";
import { db, StoredFile } from "./db";
import { files, uploadEvents, reports } from "./schema";
import {
  DAILY_UPLOADS,
  GLOBAL_BYTES,
  USER_BYTES,
  RETENTION_MS,
  appURL,
  MAX_FILE_BYTES,
  UPLOAD_URL_SECONDS,
  STAGING_GRACE_MS,
} from "./config";
import { HttpError } from "./errors";
import { removeObject, stagingKey } from "./storage";

export async function usage(userId?: string) {
  const [result] = await db
    .select({
      bytes: sql<string>`coalesce(sum(coalesce(${files.reservedBytes}, ${files.size})), 0)`,
    })
    .from(files)
    .where(userId ? eq(files.userId, userId) : undefined);
  return Number(result.bytes);
}
export async function reserve(
  userId: string,
  name: string,
  mime: string,
  size: number,
  now = Date.now(),
  staged = false,
) {
  return db.transaction(
    async (tx) => {
      // Transaction-scoped locks work with Neon's transaction pooler and across app instances.
      // Read committed gives these SUM queries a fresh snapshot after acquiring the lock.
      await tx.execute(sql`select pg_advisory_xact_lock(20261117, 0)`);
      const [global] = await tx
        .select({
          bytes: sql<string>`coalesce(sum(coalesce(${files.reservedBytes}, ${files.size})), 0)`,
        })
        .from(files);
      const [personal] = await tx
        .select({
          bytes: sql<string>`coalesce(sum(coalesce(${files.reservedBytes}, ${files.size})), 0)`,
        })
        .from(files)
        .where(eq(files.userId, userId));
      const reservation = staged ? size + MAX_FILE_BYTES : size;
      if (Number(global.bytes) + reservation > GLOBAL_BYTES)
        throw new HttpError(
          507,
          "Community storage is full. Existing files will stay until their expiry dates.",
        );
      if (Number(personal.bytes) + reservation > USER_BYTES)
        throw new HttpError(
          409,
          "Your 100 MB storage allowance is full. Delete a file first.",
        );
      const id = randomBytes(24).toString("hex");
      const [file] = await tx
        .insert(files)
        .values({
          id,
          userId,
          name,
          mime,
          size,
          reservedBytes: staged ? reservation : null,
          stagingSize: staged ? size : null,
          uploadExpiresAt: staged ? now + UPLOAD_URL_SECONDS * 1000 : null,
          objectKey: staged ? `files/${id}` : null,
          createdAt: now,
          expiresAt: now + RETENTION_MS,
          status: "pending",
        })
        .returning();
      return file;
    },
    { isolationLevel: "read committed" },
  );
}
export async function consumeUploadAttempt(userId: string, now = Date.now()) {
  await db.transaction(
    async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(20261118, hashtext(${userId}))`,
      );
      const [result] = await tx
        .select({ n: count() })
        .from(uploadEvents)
        .where(
          and(
            eq(uploadEvents.userId, userId),
            gt(uploadEvents.createdAt, now - 86_400_000),
          ),
        );
      if (result.n >= DAILY_UPLOADS)
        throw new HttpError(
          429,
          "Your daily limit is 20 upload attempts. Try again later.",
        );
      await tx.insert(uploadEvents).values({
        id: randomBytes(24).toString("hex"),
        userId,
        createdAt: now,
      });
    },
    { isolationLevel: "read committed" },
  );
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
export async function listFiles(userId: string) {
  return db
    .select()
    .from(files)
    .where(
      and(
        eq(files.userId, userId),
        eq(files.status, "ready"),
        gt(files.expiresAt, Date.now()),
      ),
    )
    .orderBy(desc(files.createdAt));
}
export async function findFile(id: string, userId?: string) {
  const [file] = await db
    .select()
    .from(files)
    .where(and(eq(files.id, id), userId ? eq(files.userId, userId) : undefined))
    .limit(1);
  return file;
}
export async function deleteFile(id: string, now = Date.now()) {
  const [file] = await db
    .update(files)
    .set({ status: "deleting" })
    .where(eq(files.id, id))
    .returning();
  if (!file) return false;
  await removeObject(file.objectKey || id);
  // Keep both the row and the single-write staging object while a signed PUT can still be used.
  // A caller could have begun a request just before expiry, so include a conservative grace period.
  if (
    file.uploadExpiresAt !== null &&
    file.uploadExpiresAt + STAGING_GRACE_MS > now
  )
    return false;
  if (file.processingAt !== null && file.processingAt + STAGING_GRACE_MS > now)
    return false;
  if (file.stagingSize !== null) await removeObject(stagingKey(id));
  await db
    .delete(files)
    .where(and(eq(files.id, id), eq(files.status, "deleting")));
  return true;
}
export async function reportFile(id: string) {
  // One statement ties insertion to a currently active row; deletion cannot leave orphan reports.
  await db
    .insert(reports)
    .select(
      db
        .select({
          fileId: files.id,
          createdAt: sql<number>`${Date.now()}::bigint`.as("created_at"),
        })
        .from(files)
        .where(
          and(
            eq(files.id, id),
            eq(files.status, "ready"),
            gt(files.expiresAt, Date.now()),
          ),
        ),
    )
    .onConflictDoNothing();
}
export async function cleanup(now = Date.now()) {
  const expired = await db
    .select({ id: files.id })
    .from(files)
    .where(
      or(
        lte(files.expiresAt, now),
        and(
          eq(files.status, "deleting"),
          or(
            sql`${files.processingAt} is null`,
            lte(files.processingAt, now - STAGING_GRACE_MS),
          ),
          or(
            sql`${files.uploadExpiresAt} is null`,
            lte(files.uploadExpiresAt, now - STAGING_GRACE_MS),
          ),
        ),
        and(
          eq(files.status, "pending"),
          or(
            and(
              sql`${files.uploadExpiresAt} is null`,
              lt(files.createdAt, now - STAGING_GRACE_MS),
            ),
            lte(files.uploadExpiresAt, now - STAGING_GRACE_MS),
          ),
        ),
        and(
          eq(files.status, "processing"),
          lt(files.processingAt, now - STAGING_GRACE_MS),
        ),
      ),
    )
    .limit(100);
  let deleted = 0,
    failed = 0,
    stagingDeleted = 0;
  for (const file of expired) {
    try {
      if (await deleteFile(file.id, now)) deleted++;
    } catch (error) {
      console.error("Cleanup failed:", file.id, error);
      failed++;
    }
  }
  const completed = await db
    .select()
    .from(files)
    .where(
      and(
        eq(files.status, "ready"),
        sql`${files.stagingSize} is not null`,
        lte(files.uploadExpiresAt, now - STAGING_GRACE_MS),
      ),
    )
    .limit(100);
  for (const file of completed) {
    try {
      await removeObject(stagingKey(file.id));
      await db
        .update(files)
        .set({ stagingSize: null, reservedBytes: file.size })
        .where(and(eq(files.id, file.id), eq(files.status, "ready")));
      stagingDeleted++;
    } catch (error) {
      console.error("Staging cleanup failed:", file.id, error);
      failed++;
    }
  }
  await db
    .delete(uploadEvents)
    .where(lt(uploadEvents.createdAt, now - 86_400_000));
  return { deleted, failed, stagingDeleted };
}
