import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { randomBytes } from "node:crypto";
import { db } from "./db";
import * as schema from "./schema";
import { appURL } from "./config";

function secret() {
  if (process.env.BETTER_AUTH_SECRET) return process.env.BETTER_AUTH_SECRET;
  // Development only. Set a stable secret for sessions across deployments.
  const shared = globalThis as unknown as { zoraDevSecret?: string };
  return (shared.zoraDevSecret ??= randomBytes(48).toString("base64url"));
}
export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema, transaction: true }),
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
