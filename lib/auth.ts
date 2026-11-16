import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { db, dataDir } from "./db";
import { appURL } from "./config";

function secret() {
  if (process.env.BETTER_AUTH_SECRET) return process.env.BETTER_AUTH_SECRET;
  // A persisted development secret keeps local sessions valid between restarts.
  const file = resolve(dataDir, ".dev-secret");
  if (!existsSync(file))
    writeFileSync(file, randomBytes(48).toString("base64url"), { mode: 0o600 });
  return readFileSync(file, "utf8");
}
export const auth = betterAuth({
  database: db,
  secret: secret(),
  baseURL: appURL(),
  emailAndPassword: { enabled: false },
  socialProviders: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID || "",
      clientSecret: process.env.GITHUB_CLIENT_SECRET || "",
    },
  },
  rateLimit: { enabled: true, storage: "database", window: 60, max: 30 },
});
let migration: Promise<void> | undefined;
export function ensureAuth() {
  return (migration ??= getMigrations(auth.options)
    .then((m) => m.runMigrations())
    .catch((error) => {
      migration = undefined;
      throw error;
    }));
}
