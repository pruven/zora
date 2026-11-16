import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import sharp from "sharp";
import { testPostgres } from "./postgres";
import { eq, count } from "drizzle-orm";
import { files } from "../lib/schema";
import { testS3 } from "./s3";
import { MAX_FILE_BYTES, STAGING_GRACE_MS } from "../lib/config";

for (const cloud of [false, true])
  test(
    `GitHub OAuth and staged uploads with ${cloud ? "signed S3" : "local"} storage`,
    { timeout: 120_000 },
    async () => {
      const database = await testPostgres();
      const storage = cloud ? await testS3() : null;
      const directory = mkdtempSync(join(tmpdir(), "zora-integration-"));
      const generatedFiles = ["next-env.d.ts", "tsconfig.json"]
        .filter(existsSync)
        .map((path) => ({ path, content: readFileSync(path) }));
      const base = "http://localhost:3107";
      let logs = "";
      const server = spawn(
        process.execPath,
        ["node_modules/next/dist/bin/next", "dev", "--port", "3107"],
        {
          env: {
            ...process.env,
            NEXT_DIST_DIR: ".next-test",
            NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --import=${pathToFileURL(resolve("tests/github-mock.mjs")).href}`,
            GITHUB_CLIENT_ID: "test-github-client-id",
            GITHUB_CLIENT_SECRET: "test-github-client-secret",
            DATA_DIR: directory,
            DATABASE_URL: database.url,
            DATABASE_URL_UNPOOLED: database.url,
            STORAGE_DRIVER: cloud ? "s3" : "local",
            ...(storage?.env || {}),
            BETTER_AUTH_URL: base,
            BETTER_AUTH_SECRET:
              "integration-test-secret-only-00000000000000000",
            CRON_SECRET: "test-cron-secret",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      server.stdout.on("data", (chunk) => {
        logs += chunk;
      });
      server.stderr.on("data", (chunk) => {
        logs += chunk;
      });
      try {
        let ready = false;
        for (let i = 0; i < 120; i++) {
          if (server.exitCode !== null) throw new Error(logs);
          try {
            const response = await fetch(`${base}/api/storage`);
            if (response.ok) {
              ready = true;
              break;
            }
          } catch {}
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        assert.ok(ready, logs);
        for (const endpoint of ["sign-up/email", "sign-in/email"]) {
          const response = await fetch(`${base}/api/auth/${endpoint}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Origin: base },
            body: JSON.stringify({
              name: "Tester",
              email: "blocked@example.com",
              password: "long-enough-test-password",
            }),
          });
          assert.equal(response.ok, false, `${endpoint} must be disabled`);
          assert.ok(
            !response.headers.get("set-cookie")?.includes("session_token="),
          );
        }
        async function githubSignIn(identity: string) {
          const response = await fetch(`${base}/api/auth/sign-in/social`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Origin: base },
            body: JSON.stringify({
              provider: "github",
              callbackURL: "/",
              errorCallbackURL: "/?auth_error=github",
            }),
          });
          assert.equal(response.status, 200, await response.clone().text());
          const authorization = new URL((await response.json()).url);
          assert.equal(authorization.origin, "https://github.com");
          assert.equal(authorization.pathname, "/login/oauth/authorize");
          assert.equal(
            authorization.searchParams.get("client_id"),
            "test-github-client-id",
          );
          assert.equal(
            authorization.searchParams.get("redirect_uri"),
            `${base}/api/auth/callback/github`,
          );
          const state = authorization.searchParams.get("state");
          assert.ok(state);
          const stateCookie = response.headers
            .getSetCookie()
            .map((value) => value.split(";")[0])
            .join("; ");
          const callback = await fetch(
            `${base}/api/auth/callback/github?code=${identity}&state=${encodeURIComponent(state)}`,
            {
              headers: { Cookie: stateCookie },
              redirect: "manual",
            },
          );
          assert.equal(callback.status, 302, await callback.clone().text());
          assert.equal(
            new URL(callback.headers.get("location")!, base).pathname,
            "/",
          );
          const cookie = callback.headers
            .getSetCookie()
            .map((value) => value.split(";")[0])
            .join("; ");
          assert.ok(
            cookie.includes("session_token="),
            `GitHub callback did not issue a session: ${callback.headers.get("location")}`,
          );
          const session = await (
            await fetch(`${base}/api/auth/get-session`, {
              headers: { Cookie: cookie },
            })
          ).json();
          assert.equal(session.user.email, `${identity}@example.com`);
          assert.equal(session.user.emailVerified, true);
          return cookie;
        }
        const invalidCallback = await fetch(
          `${base}/api/auth/callback/github?code=one&state=forged-state`,
          { redirect: "manual" },
        );
        assert.equal(invalidCallback.status, 302);
        assert.match(invalidCallback.headers.get("location")!, /error=/);
        assert.ok(
          !invalidCallback.headers
            .get("set-cookie")
            ?.includes("session_token="),
        );
        const cookie = await githubSignIn("one");
        const secondCookie = await githubSignIn("two");
        const png = await sharp({
          create: { width: 8, height: 8, channels: 3, background: "#dafa9c" },
        })
          .png()
          .toBuffer();
        const begin = (
          name: string,
          size: number,
          session = cookie,
          origin = base,
        ) =>
          fetch(`${base}/api/files`, {
            method: "POST",
            headers: {
              Origin: origin,
              Cookie: session,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ name, size }),
          });
        const finish = (id: string, session = cookie) =>
          fetch(`${base}/api/files/${id}/complete`, {
            method: "POST",
            headers: { Origin: base, Cookie: session },
          });
        async function write(
          target: {
            upload: {
              url: string;
              method: string;
              headers: Record<string, string>;
            };
          },
          body: Buffer,
        ) {
          return fetch(new URL(target.upload.url, base), {
            method: target.upload.method,
            headers: {
              ...target.upload.headers,
              ...(cloud ? {} : { Origin: base, Cookie: cookie }),
            },
            body: new Uint8Array(body),
          });
        }
        async function send(
          name: string,
          body: Buffer,
          session = cookie,
          origin = base,
        ) {
          const response = await begin(name, body.length, session, origin);
          if (!response.ok) return response;
          const target = await response.json();
          const uploaded = await write(target, body);
          assert.equal(uploaded.ok, true, await uploaded.clone().text());
          return finish(target.id, session);
        }
        assert.equal((await send("a.png", png, "")).status, 401);
        const raw = await fetch(`${base}/api/files`, {
          method: "POST",
          headers: {
            Origin: base,
            Cookie: cookie,
            "Content-Type": "application/octet-stream",
          },
          body: new Uint8Array(png),
        });
        assert.equal(raw.status, 415);
        if (cloud)
          assert.equal(
            (
              await fetch(`${base}/api/uploads/${"a".repeat(48)}/content`, {
                method: "PUT",
                body: "x",
              })
            ).status,
            404,
          );

        assert.equal(
          (await send("a.png", png, cookie, "https://evil.example")).status,
          403,
        );
        assert.equal(
          (await send("run.js", Buffer.from("alert(1)"))).status,
          415,
        );
        assert.equal(
          (await send("photo.png", Buffer.from("MZ disguised executable")))
            .status,
          415,
        );
        assert.equal((await send("run.sh.png", png)).status, 415);
        assert.equal(
          (await begin("photo.png", MAX_FILE_BYTES + 1)).status,
          413,
        );
        const reserved = await (await begin("private.png", png.length)).json();
        const listingBefore = await (
          await fetch(`${base}/api/files`, { headers: { Cookie: cookie } })
        ).json();
        assert.equal(listingBefore.files.length, 0);
        assert.equal(
          (await fetch(`${base}/f/${reserved.id}/private.png`)).status,
          404,
        );
        assert.equal((await finish(reserved.id)).status, 409); // missing upload can be retried
        assert.equal((await write(reserved, png)).ok, true);
        assert.equal((await write(reserved, png)).ok, false); // single-write staging
        assert.equal((await finish(reserved.id)).status, 200);
        if (cloud) {
          const signed = new URL(reserved.upload.url);
          assert.match(
            signed.searchParams.get("X-Amz-SignedHeaders")!,
            /content-length/,
          );
          assert.match(
            signed.searchParams.get("X-Amz-SignedHeaders")!,
            /if-none-match/,
          );
          assert.equal(
            (
              await fetch(
                `${storage!.endpoint}/test-bucket/staging/${reserved.id}`,
              )
            ).status,
            403,
          );
          const altered = {
            ...reserved,
            upload: {
              ...reserved.upload,
              headers: { ...reserved.upload.headers, "If-None-Match": "" },
            },
          };
          assert.equal((await write(altered, png)).status, 403);
          const sizeMismatch = await (
            await begin("size.png", png.length + 1)
          ).json();
          assert.equal((await write(sizeMismatch, png)).status, 403);
        }
        await fetch(`${base}/api/files/${reserved.id}`, {
          method: "DELETE",
          headers: { Cookie: cookie, Origin: base },
        });
        assert.equal((await write(reserved, png)).ok, false); // deletion retains staging until URL expires
        const large = Buffer.alloc(5_000_000);
        large.write("RIFF");
        large.writeUInt32LE(large.length - 8, 4);
        large.write("WAVEfmt ", 8);
        large.writeUInt32LE(16, 16);
        large.writeUInt16LE(1, 20);
        large.writeUInt16LE(1, 22);
        large.writeUInt32LE(8000, 24);
        large.writeUInt32LE(16000, 28);
        large.writeUInt16LE(2, 32);
        large.writeUInt16LE(16, 34);
        large.write("data", 36);
        large.writeUInt32LE(large.length - 44, 40);
        const largeResponse = await send("large.wav", large);
        assert.equal(
          largeResponse.status,
          200,
          await largeResponse.clone().text(),
        );
        const { file: largeFile } = await largeResponse.json();
        if (cloud) {
          const redirect = await fetch(largeFile.url, { redirect: "manual" });
          assert.equal(redirect.status, 302);
          assert.equal((await redirect.arrayBuffer()).byteLength, 0);
          assert.equal(
            new URL(redirect.headers.get("location")!).searchParams.get(
              "X-Amz-Expires",
            ),
            "60",
          );
        }
        assert.equal(
          (await (await fetch(largeFile.url)).arrayBuffer()).byteLength,
          large.length,
        );
        await fetch(`${base}/api/files/${largeFile.id}`, {
          method: "DELETE",
          headers: { Cookie: cookie, Origin: base },
        });
        if (cloud) {
          for (const cancel of [false, true]) {
            const race = await (
              await begin(cancel ? "cancelled.png" : "race.png", png.length)
            ).json();
            assert.equal((await write(race, png)).ok, true);
            let release!: () => void, entered!: () => void;
            const paused = new Promise<void>((resolve) => {
              release = resolve;
            });
            const waiting = new Promise<void>((resolve) => {
              entered = resolve;
            });
            storage!.hooks.beforeGet = async (key) => {
              if (key === `staging/${race.id}`) {
                entered();
                await paused;
              }
            };
            const first = finish(race.id);
            try {
              await waiting;
              assert.equal((await finish(race.id)).status, 409);
              assert.equal(
                (await fetch(`${base}/f/${race.id}/race.png`)).status,
                404,
              );
              if (cancel) {
                assert.equal(
                  (
                    await fetch(`${base}/api/files/${race.id}`, {
                      method: "DELETE",
                      headers: { Cookie: cookie, Origin: base },
                    })
                  ).status,
                  200,
                );
              }
            } finally {
              release();
            }
            const completed = await first;
            assert.equal(
              completed.status,
              cancel ? 409 : 200,
              await completed.clone().text(),
            );
            storage!.hooks.beforeGet = undefined;
            if (cancel)
              assert.equal(storage!.objects.has(`files/${race.id}`), false);
            else
              await fetch(`${base}/api/files/${race.id}`, {
                method: "DELETE",
                headers: { Cookie: cookie, Origin: base },
              });
          }
        }
        const response = await send("photo.png", png);
        assert.equal(response.status, 200, await response.clone().text());
        const { file } = await response.json();
        assert.ok(file.url.startsWith(`${base}/f/`));
        assert.equal((await finish(file.id, secondCookie)).status, 404);
        assert.equal((await finish(file.id)).status, 200); // idempotent completion
        const downloaded = await fetch(file.url);
        assert.equal(downloaded.status, 200);
        assert.equal(downloaded.headers.get("content-type"), "image/png");
        assert.match(downloaded.headers.get("cache-control")!, /no-store/);
        assert.match(
          downloaded.headers.get("content-disposition")!,
          /^attachment/,
        );
        const otherFiles = await (
          await fetch(`${base}/api/files`, {
            headers: { Cookie: secondCookie },
          })
        ).json();
        assert.equal(otherFiles.files.length, 0);
        const remove = (id: string, session: string) =>
          fetch(`${base}/api/files/${id}`, {
            method: "DELETE",
            headers: { Cookie: session, Origin: base },
          });
        assert.equal((await remove(file.id, secondCookie)).status, 404);
        const report = await fetch(`${base}/api/reports`, {
          method: "POST",
          headers: { Origin: base, "Content-Type": "application/json" },
          body: JSON.stringify({ id: file.id }),
        });
        assert.equal(report.status, 200);
        assert.equal((await remove(file.id, cookie)).status, 200);
        assert.equal((await fetch(file.url)).status, 404);
        const { file: expired } = await (await send("expires.png", png)).json();
        await database.db
          .update(files)
          .set({ expiresAt: Date.now() - 1 })
          .where(eq(files.id, expired.id));
        assert.equal((await fetch(expired.url)).status, 410);
        const expiredCompletion = await finish(expired.id);
        assert.equal(expiredCompletion.status, 410);
        assert.match((await expiredCompletion.json()).error, /expired/);
        assert.equal(
          (await fetch(`${base}/api/cleanup`, { method: "POST" })).status,
          401,
        );
        const cleaned = await fetch(`${base}/api/cleanup`, {
          method: "POST",
          headers: { Authorization: "Bearer test-cron-secret" },
        });
        assert.equal(cleaned.status, 200);
        assert.equal((await cleaned.json()).failed, 0);
        await database.db
          .update(files)
          .set({
            uploadExpiresAt: Date.now() - STAGING_GRACE_MS - 1,
            processingAt: Date.now() - STAGING_GRACE_MS - 1,
          });
        await fetch(`${base}/api/cleanup`, {
          method: "POST",
          headers: { Authorization: "Bearer test-cron-secret" },
        });
        const [remaining] = await database.db
          .select({ n: count() })
          .from(files);
        assert.equal(remaining.n, 0);
        if (cloud) assert.equal(storage!.objects.size, 0);
      } finally {
        const exited = once(server, "exit");
        server.kill("SIGTERM");
        if (server.exitCode === null) await exited;
        await storage?.stop();
        await database.stop();
        rmSync(directory, { recursive: true, force: true });
        for (const file of generatedFiles)
          writeFileSync(file.path, file.content);
      }
    },
  );
