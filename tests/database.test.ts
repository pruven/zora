import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq, sql, count } from "drizzle-orm";
import { testPostgres } from "./postgres";
import { files, user, uploadEvents } from "../lib/schema";
import {
  GLOBAL_BYTES,
  USER_BYTES,
  RETENTION_MS,
  MAX_FILE_BYTES,
  STAGING_GRACE_MS,
} from "../lib/config";

const postgres = await testPostgres();
process.env.DATABASE_URL = postgres.url;
process.env.DATABASE_URL_UNPOOLED = postgres.url;
process.env.DATA_DIR = postgres.directory;
process.env.STORAGE_DRIVER = "local";
const { reserve, usage, consumeUploadAttempt, cleanup } =
  await import("../lib/files");
const { pool, db } = await import("../lib/db");
const { putObject, stagingKey } = await import("../lib/storage");
beforeEach(async () => {
  await db.execute(sql`truncate table files, upload_events, "user" cascade`);
  await db.insert(user).values(
    ["one", "two", "limited", "cleanup-user"].map((id) => ({
      id,
      name: id,
      email: `${id}@example.com`,
    })),
  );
});
after(async () => {
  await pool.end();
  await postgres.stop();
});

test("migration and maintenance commands use Postgres and migrations are repeatable", async () => {
  const run = promisify(execFile);
  const env = {
    ...process.env,
    DATABASE_URL: postgres.url,
    DATABASE_URL_UNPOOLED: postgres.url,
    STORAGE_DRIVER: "local",
    DATA_DIR: postgres.directory,
  };
  for (let i = 0; i < 2; i++) {
    const result = await run("bun", ["run", "db:migrate"], { env });
    assert.match(result.stdout, /Database migrations applied/);
  }
  const history = await db.execute(
    sql`select count(*) as n from drizzle.__drizzle_migrations`,
  );
  assert.equal(Number((history.rows[0] as { n: string }).n), 2);
  await run("bun", ["run", "reports"], { env });
  const cleanup = await run("bun", ["run", "cleanup"], { env });
  assert.deepEqual(JSON.parse(cleanup.stdout.trim()), {
    deleted: 0,
    failed: 0,
    stagingDeleted: 0,
  });
});

test("counts pending reservations and refuses per-user and global overfill", async () => {
  const reserved = await reserve("one", "a.png", "image/png", USER_BYTES);
  assert.equal(await usage(), USER_BYTES);
  await assert.rejects(reserve("one", "b.png", "image/png", 1), /100 MB/);
  await db
    .update(files)
    .set({ size: GLOBAL_BYTES })
    .where(eq(files.id, reserved.id));
  await assert.rejects(reserve("two", "b.png", "image/png", 1), /full/);
});
test("simultaneous uploads across connections cannot overfill the global pool", async () => {
  const reserved = await reserve("one", "existing.png", "image/png", 1);
  await db
    .update(files)
    .set({ size: GLOBAL_BYTES - 1_000_000 })
    .where(eq(files.id, reserved.id));
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () =>
      reserve("two", "next.png", "image/png", 1_000_000),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(await usage(), GLOBAL_BYTES);
});
test("simultaneous uploads cannot exceed an account's allowance", async () => {
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () =>
      reserve("one", "photo.png", "image/png", 20_000_000),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 5);
  assert.equal(await usage("one"), USER_BYTES);
});
test("concurrent daily upload attempts stop at twenty and reset after 24 hours", async () => {
  const now = Date.now();
  const results = await Promise.allSettled(
    Array.from({ length: 30 }, () => consumeUploadAttempt("limited", now)),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 20);
  const [result] = await db.select({ n: count() }).from(uploadEvents);
  assert.equal(result.n, 20);
  await assert.rejects(consumeUploadAttempt("limited", now), /daily limit/);
  await consumeUploadAttempt("limited", now + 86_400_001);
});
test("cleanup deletes expired objects and releases accounted bytes", async () => {
  const file = await reserve(
    "cleanup-user",
    "photo.png",
    "image/png",
    3,
    Date.now() - RETENTION_MS - 1,
  );
  await putObject(file.id, Buffer.from("abc"), file.mime);
  await db.update(files).set({ status: "ready" }).where(eq(files.id, file.id));
  assert.equal(await usage(), 3);
  const result = await cleanup();
  assert.equal(result.deleted, 1);
  assert.equal(result.failed, 0);
  assert.equal(await usage(), 0);
});

test("staging and processed-output reservations remain accounted for until upload authorization expires", async () => {
  const now = Date.now();
  const file = await reserve(
    "one",
    "small.png",
    "application/octet-stream",
    3,
    now,
    true,
  );
  assert.equal(await usage(), MAX_FILE_BYTES + 3);
  await putObject(
    stagingKey(file.id),
    Buffer.from("abc"),
    "application/octet-stream",
  );
  await putObject(file.objectKey!, Buffer.from("abc"), "image/png");
  await db
    .update(files)
    .set({ status: "ready", size: 3, reservedBytes: 6 })
    .where(eq(files.id, file.id));
  assert.equal((await cleanup(now)).stagingDeleted, 0);
  assert.equal(await usage(), 6);
  assert.equal(
    (await cleanup(file.uploadExpiresAt! + STAGING_GRACE_MS + 1))
      .stagingDeleted,
    1,
  );
  assert.equal(await usage(), 3);
});
test("abandoned uploads and cancelled processing retain reservations until safe cleanup", async () => {
  const now = Date.now();
  const file = await reserve(
    "one",
    "pending.png",
    "application/octet-stream",
    3,
    now,
    true,
  );
  await cleanup(now);
  assert.equal(await usage(), MAX_FILE_BYTES + 3);
  await cleanup(file.uploadExpiresAt! + STAGING_GRACE_MS + 1);
  assert.equal(await usage(), 0);
  const active = await reserve(
    "one",
    "active.png",
    "application/octet-stream",
    3,
    now,
    true,
  );
  const processingAt = active.uploadExpiresAt! + STAGING_GRACE_MS - 1000;
  await db
    .update(files)
    .set({ status: "deleting", processingAt })
    .where(eq(files.id, active.id));
  await cleanup(processingAt + 2000);
  assert.equal(await usage(), MAX_FILE_BYTES + 3);
  await cleanup(processingAt + STAGING_GRACE_MS + 1);
  assert.equal(await usage(), 0);
});
