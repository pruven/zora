const required = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "CRON_SECRET",
  "S3_ENDPOINT",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
];
const missing = required.filter((key) => !process.env[key]);
if (missing.length)
  throw new Error(
    `Production configuration missing: ${missing.join(", ")}. See README.md.`,
  );
if (
  process.env.BETTER_AUTH_SECRET!.length < 32 ||
  process.env.CRON_SECRET!.length < 32
)
  throw new Error(
    "Auth and cleanup secrets must each have at least 32 random characters.",
  );
if (!process.env.BETTER_AUTH_URL!.startsWith("https://"))
  throw new Error("Production BETTER_AUTH_URL must use HTTPS.");
if (process.env.STORAGE_DRIVER !== "s3")
  throw new Error("Configure private R2 or B2 storage for production.");
if (!/^postgres(?:ql)?:\/\//.test(process.env.DATABASE_URL!))
  throw new Error("DATABASE_URL must be a PostgreSQL connection string.");
console.log("Production configuration is valid.");
