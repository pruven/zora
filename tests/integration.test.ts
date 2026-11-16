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
import Database from "better-sqlite3";

test(
  "GitHub-only OAuth, ownership, upload validation, sharing, reporting, deletion, and expiry",
  { timeout: 120_000 },
  async () => {
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
          STORAGE_DRIVER: "local",
          BETTER_AUTH_URL: base,
          BETTER_AUTH_SECRET: "integration-test-secret-only-00000000000000000",
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
        !invalidCallback.headers.get("set-cookie")?.includes("session_token="),
      );
      const cookie = await githubSignIn("one");
      const secondCookie = await githubSignIn("two");
      const png = await sharp({
        create: { width: 8, height: 8, channels: 3, background: "#dafa9c" },
      })
        .png()
        .toBuffer();
      const send = (
        name: string,
        body: Buffer,
        session = cookie,
        origin = base,
      ) =>
        fetch(`${base}/api/files`, {
          method: "POST",
          headers: {
            Origin: origin,
            Cookie: session,
            "X-File-Name": encodeURIComponent(name),
          },
          body: new Uint8Array(body),
        });
      assert.equal((await send("a.png", png, "")).status, 401);
      assert.equal(
        (await send("a.png", png, cookie, "https://evil.example")).status,
        403,
      );
      assert.equal((await send("run.js", Buffer.from("alert(1)"))).status, 415);
      assert.equal(
        (await send("photo.png", Buffer.from("MZ disguised executable")))
          .status,
        415,
      );
      assert.equal((await send("run.sh.png", png)).status, 415);
      const response = await send("photo.png", png);
      assert.equal(response.status, 201, await response.clone().text());
      const { file } = await response.json();
      assert.ok(file.url.startsWith(`${base}/f/`));
      const downloaded = await fetch(file.url);
      assert.equal(downloaded.status, 200);
      assert.equal(downloaded.headers.get("content-type"), "image/png");
      assert.match(downloaded.headers.get("cache-control")!, /no-store/);
      assert.match(
        downloaded.headers.get("content-disposition")!,
        /^attachment/,
      );
      const otherFiles = await (
        await fetch(`${base}/api/files`, { headers: { Cookie: secondCookie } })
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
      const database = new Database(join(directory, "zora.sqlite"));
      database
        .prepare("UPDATE files SET expiresAt = ? WHERE id = ?")
        .run(Date.now() - 1, expired.id);
      assert.equal((await fetch(expired.url)).status, 410);
      assert.equal(
        (await fetch(`${base}/api/cleanup`, { method: "POST" })).status,
        401,
      );
      const cleaned = await fetch(`${base}/api/cleanup`, {
        method: "POST",
        headers: { Authorization: "Bearer test-cron-secret" },
      });
      assert.equal(cleaned.status, 200);
      assert.equal((await cleaned.json()).deleted, 1);
      assert.equal(
        (
          database.prepare("SELECT COUNT(*) AS n FROM files").get() as {
            n: number;
          }
        ).n,
        0,
      );
      database.close();
    } finally {
      const exited = once(server, "exit");
      server.kill("SIGTERM");
      if (server.exitCode === null) await exited;
      rmSync(directory, { recursive: true, force: true });
      for (const file of generatedFiles) writeFileSync(file.path, file.content);
    }
  },
);
