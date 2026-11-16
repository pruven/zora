import { test } from "node:test";
import assert from "node:assert/strict";
import { readJSON } from "../lib/request-json";
import { HttpError } from "../lib/errors";

function request(contentType?: string) {
  return new Request("http://localhost/api/files", {
    method: "POST",
    headers: contentType ? { "Content-Type": contentType } : undefined,
    body: new TextEncoder().encode('{"name":"photo.png","size":3}'),
  });
}

test("JSON requests accept case-insensitive media types and parameters", async () => {
  for (const contentType of [
    "application/json",
    "Application/JSON",
    "APPLICATION/JSON; charset=UTF-8",
    " application/json ; charset=utf-8 ",
  ]) {
    assert.deepEqual(await readJSON(request(contentType)), {
      name: "photo.png",
      size: 3,
    });
  }
});

test("JSON requests reject missing types and JSON-prefixed non-JSON types", async () => {
  for (const contentType of [
    undefined,
    "application/jsonp",
    "application/json-patch+json",
    "application/jsonx; charset=utf-8",
    "text/plain",
  ]) {
    await assert.rejects(
      readJSON(request(contentType)),
      (error) => error instanceof HttpError && error.status === 415,
    );
  }
});
