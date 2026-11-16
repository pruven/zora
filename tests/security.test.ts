import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  validateUpload,
  validateName,
  readLimitedBody,
} from "../lib/validation";
import { MAX_FILE_BYTES } from "../lib/config";

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
