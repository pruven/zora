import { test, after } from "node:test";
import assert from "node:assert/strict";
import { testS3 } from "./s3";
const storage = await testS3();
Object.assign(process.env, storage.env, { STORAGE_DRIVER: "s3" });
const { putObject, uploadTarget, downloadURL } = await import("../lib/storage");
after(() => storage.stop());

test("signed staging PUTs bind size, conditional write, and cache headers", async () => {
  const target = await uploadTarget("b".repeat(48), 3);
  const url = new URL(target.url);
  assert.equal(url.searchParams.get("X-Amz-Expires"), "300");
  assert.match(url.searchParams.get("X-Amz-SignedHeaders")!, /content-length/);
  assert.match(url.searchParams.get("X-Amz-SignedHeaders")!, /if-none-match/);
  assert.ok(
    url.searchParams
      .get("X-Amz-SignedHeaders")!
      .split(";")
      .includes("cache-control"),
  );
  assert.equal(
    (
      await fetch(target.url, {
        method: "PUT",
        headers: {
          ...target.headers,
          "Cache-Control": "public, max-age=86400",
        },
        body: "abc",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(target.url, {
        method: "PUT",
        headers: target.headers,
        body: "abcd",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(target.url, {
        method: "PUT",
        headers: target.headers,
        body: "abc",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(target.url, {
        method: "PUT",
        headers: target.headers,
        body: "abc",
      })
    ).status,
    412,
  );
});
test("signed download deadlines are bounded by file expiry, including legacy keys", async () => {
  const key = "a".repeat(48);
  await putObject(key, Buffer.from("abc"), "audio/mpeg", "audio.mp3");
  const deadline = Date.now() + 4500;
  const url = new URL(await downloadURL(key, "audio.mp3", deadline, false));
  const date = Date.parse(
    url.searchParams
      .get("X-Amz-Date")!
      .replace(
        /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
        "$1-$2-$3T$4:$5:$6Z",
      ),
  );
  assert.ok(
    date + Number(url.searchParams.get("X-Amz-Expires")) * 1000 <= deadline,
  );
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control")!, /no-store/);
  assert.match(response.headers.get("content-disposition")!, /^attachment/);
  await assert.rejects(
    downloadURL(key, "audio.mp3", Date.now() - 1, false),
    /expired/,
  );
});
