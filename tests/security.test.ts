import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

const directory = mkdtempSync(join(tmpdir(), "zora-unit-"));
process.env.DATA_DIR = directory;
process.env.STORAGE_DRIVER = "local";
const { validateUpload, validateName, readLimitedBody } =
  await import("../lib/validation");
const { reserve, usage, consumeUploadAttempt, cleanup } =
  await import("../lib/files");
const { db } = await import("../lib/db");
const { putObject } = await import("../lib/storage");
const { GLOBAL_BYTES, USER_BYTES, MAX_FILE_BYTES, RETENTION_MS } =
  await import("../lib/config");
after(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

test("blocks scripts, executables, archives, active documents, paths, and double extensions", () => {
  for (const name of [
    "hello.js",
    "file.EXE",
    "photo.exe.png",
    "run.ps1.jpg",
    "index.html",
    "picture.svg",
    "slides.pdf",
    "work.docx",
    "files.zip",
    "../photo.png",
    "a\\photo.jpg",
    "photo\u202egnp.exe",
    "photo.png\0",
    "photo.png.",
    ".png",
    "photo.py.webp",
    "installer.apk.mp4",
  ])
    assert.throws(() => validateName(name), { name: "Error" }, name);
  assert.equal(validateName("a normal photo.JPEG").extension, "jpeg");
});
test("rejects executables and script text renamed as media", async () => {
  for (const body of [
    Buffer.from("MZ" + "\0".repeat(100)),
    Buffer.from("#!/bin/sh\necho hello"),
    Buffer.from("<script>alert(1)</script>"),
  ])
    await assert.rejects(validateUpload("photo.png", body));
});
test("validates image bytes, rejects mismatches, strips trailing payloads", async () => {
  const png = await sharp({
    create: { width: 4, height: 4, channels: 3, background: "#dafa9c" },
  })
    .png()
    .toBuffer();
  await assert.rejects(validateUpload("image.jpg", png));
  const result = await validateUpload(
    "image.png",
    Buffer.concat([png, Buffer.from("<script>malicious_payload</script>")]),
  );
  assert.equal(result.mime, "image/png");
  assert.equal(result.body.includes(Buffer.from("malicious_payload")), false);
  assert.equal((await sharp(result.body).metadata()).width, 4);
});
test("enforces byte limits on streams without relying on Content-Length", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_FILE_BYTES));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    },
  });
  await assert.rejects(
    readLimitedBody(
      new Request("http://localhost", {
        method: "POST",
        body: stream,
        duplex: "half",
      } as RequestInit),
    ),
    /10 MB/,
  );
  await assert.rejects(
    readLimitedBody(
      new Request("http://localhost", {
        method: "POST",
        body: "x",
        headers: { "content-length": String(MAX_FILE_BYTES + 1) },
      }),
    ),
    /10 MB/,
  );
});
test("counts pending reservations and refuses per-user and global overfill", () => {
  db.prepare("DELETE FROM files").run();
  const reserved = reserve("one", "a.png", "image/png", USER_BYTES);
  assert.equal(usage(), USER_BYTES);
  assert.throws(() => reserve("one", "b.png", "image/png", 1), /100 MB/);
  db.prepare("UPDATE files SET size = ? WHERE id = ?").run(
    GLOBAL_BYTES,
    reserved.id,
  );
  assert.throws(() => reserve("two", "b.png", "image/png", 1), /full/);
  db.prepare("DELETE FROM files").run();
});
test("daily upload attempts are limited, including rejected uploads", () => {
  for (let i = 0; i < 20; i++) consumeUploadAttempt("limited", 100_000_000);
  assert.throws(
    () => consumeUploadAttempt("limited", 100_000_000),
    /daily limit/,
  );
  assert.doesNotThrow(() => consumeUploadAttempt("limited", 200_000_000));
});
test("cleanup deletes expired objects and releases accounted bytes", async () => {
  const file = reserve(
    "cleanup-user",
    "photo.png",
    "image/png",
    3,
    Date.now() - RETENTION_MS - 1,
  );
  await putObject(file.id, Buffer.from("abc"), file.mime);
  db.prepare("UPDATE files SET status = 'ready' WHERE id = ?").run(file.id);
  assert.equal(usage(), 3);
  const result = await cleanup();
  assert.equal(result.deleted, 1);
  assert.equal(result.failed, 0);
  assert.equal(usage(), 0);
});
