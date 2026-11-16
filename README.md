# Zora

Small-file sharing with GitHub-only sign-in through Better Auth, a shared storage meter, direct public links, and ten-day expiry. Built with Next.js, React, Drizzle ORM, PostgreSQL (Neon-compatible), and an S3-compatible storage adapter for private Cloudflare R2 or Backblaze B2 buckets.

## Run locally

Requires Bun 1.4.4+ for dependency management and project commands, and Node.js 22.16+ for Next.js and the PostgreSQL driver. Dependencies are pinned in `bun.lock`.

```sh
bun install --frozen-lockfile
# Configure .env.local with Postgres and GitHub credentials first.
bun run db:migrate
bun run dev
```

Use `bun run test` for the project’s test script; `bun test` invokes Bun’s separate test runner.

Open http://localhost:3000. Sign in with GitHub to upload. Postgres is required for accounts and metadata even when using local object storage. `STORAGE_DRIVER=local` stores only file bytes in the ignored `data/` directory; `STORAGE_DRIVER=s3` uses R2/B2. Set a stable `BETTER_AUTH_SECRET` to preserve sessions between restarts. No database tables are created during web requests.

## Neon / PostgreSQL setup

1. Create a Neon project and database. Use a development branch/database for local work and a separate production branch/database.
2. Open **Connect** in the Neon dashboard. Copy the connection string with **Connection pooling** enabled into `DATABASE_URL`. Copy the direct connection string, with pooling disabled, into `DATABASE_URL_UNPOOLED`. Preserve the SSL parameters from Neon. See [Neon's connection-pooling guide](https://neon.com/docs/connect/connection-pooling).
3. Add these values to `.env.local` without replacing your other settings:

   ```dotenv
   DATABASE_URL="postgresql://USER:PASSWORD@YOUR-POOLED-HOST/DATABASE?sslmode=require"
   DATABASE_URL_UNPOOLED="postgresql://USER:PASSWORD@YOUR-DIRECT-HOST/DATABASE?sslmode=require"
   ```

4. Run `bun run db:migrate` once against the intended database before starting the app. This creates the Better Auth and application tables from the committed SQL in `drizzle/`. The migration command prefers `DATABASE_URL_UNPOOLED` and falls back to `DATABASE_URL`. Set both URLs to the same database/branch.
5. Run `bun run dev` and sign in. For deployment, set the same environment variable names in your host and run migrations as a single release/setup job before routing traffic to the new version.

The Drizzle schema is `lib/schema.ts`; the runtime connection uses `drizzle-orm/node-postgres` and a small `pg` pool. This supports interactive transactions and transaction-scoped advisory locks, which keep shared storage and per-account quotas safe across app instances. Any compatible PostgreSQL provider can be used; the code does not require a Neon-specific HTTP API. Keep secrets on the server.

For a local Postgres server, both URLs can be the same local connection string. Database tools:

```sh
bun run db:generate   # generate a migration after editing lib/schema.ts
bun run db:migrate    # apply committed migrations
bun run db:studio    # inspect the configured database
```

Database migration is explicit: installing dependencies, building, or handling an HTTP request does not modify your database schema. Run one migration job at a time. Commit the generated SQL and metadata together. The code migration does not copy existing SQLite data: the old `data/zora.sqlite` is left untouched. If you already have users or uploaded files, import their metadata and auth records into Postgres before switching production traffic. Changing database URLs alone will not migrate that data. Manage database backups/restore through your provider.

## GitHub sign-in

GitHub is the only sign-in provider. Email/password registration and login are disabled on the server, and there are no password forms.

Create a [GitHub OAuth App](https://github.com/settings/developers) for local development with:

- Homepage URL: `http://localhost:3000`
- Authorization callback URL: `http://localhost:3000/api/auth/callback/github`

Set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` in `.env.local`, alongside `BETTER_AUTH_URL=http://localhost:3000`, then restart the app. Use a separate OAuth App for production, with the production homepage and `<BETTER_AUTH_URL>/api/auth/callback/github` callback. These are server-only credentials; never prefix them with `NEXT_PUBLIC_`.

The same GitHub action creates an account on first sign-in and signs it in afterward. Recipients still need no account. Missing OAuth configuration returns a clear error instead of offering another authentication method. Better Auth requests GitHub profile and email access; no repository scopes are added.

## Upload policy

- Maximum 10,000,000 bytes per file, checked while streaming and again after processing.
- Allowlist: JPG, JPEG, PNG, WebP, MP3, WAV, MP4, WebM, OGG, FLAC.
- Scripts, executables, archives, HTML, SVG, PDF, and office documents are blocked. Documents are excluded because many formats support scripts, macros, or embedded objects.
- The server checks normalized filenames, dangerous double extensions, and detected binary content. Client `Content-Type` is never trusted.
- Images are decoded with a 40-megapixel limit and re-encoded, stripping metadata and trailing payloads. This also flattens animated WebP to its first frame.
- Media signatures are checked; media is not transcoded or scanned by antivirus. A format allowlist is not a guarantee that arbitrary media is harmless. Downloads default to attachments with `nosniff` and a sandbox CSP.
- Accounts have 100 MB of storage and 20 upload attempts per rolling 24 hours. Invalid attempts count. The shared application limit is 9.5 GB, leaving headroom below a provider's 10 GB allowance.
- Capacity includes pending uploads and objects awaiting deletion. Transactions reserve bytes before storage writes, so concurrent uploads cannot oversubscribe the pool.
- Links are bearer links: anyone with the URL can download. Recipients can retain copies after expiry. No public directory or bucket listing is exposed.

## Production configuration

Copy `.env.example` to `.env.local` and fill in values. Generate separate auth and cleanup secrets using `openssl rand -base64 48`. Do not commit secrets.

Use a **private R2 Standard bucket** for the intended free-egress setup:

```dotenv
DATABASE_URL=<pooled postgres connection string>
DATABASE_URL_UNPOOLED=<direct postgres connection string>
BETTER_AUTH_URL=https://your-app-domain
BETTER_AUTH_SECRET=<random auth secret>
GITHUB_CLIENT_ID=<github oauth client id>
GITHUB_CLIENT_SECRET=<github oauth client secret>
CRON_SECRET=<different random cleanup secret>
STORAGE_DRIVER=s3
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=<private-bucket-name>
S3_ACCESS_KEY_ID=<scoped access key>
S3_SECRET_ACCESS_KEY=<scoped secret>
```

The same adapter supports B2's S3 endpoint and region. **Routing B2 downloads through this Node server does not by itself guarantee Bandwidth Alliance egress**; that depends on the server's actual network route/provider. R2 avoids that dependency. Free storage and egress do not make hosting, requests, domains, or databases universally free.

Use a dedicated bucket with versioning disabled, or configure deletion of noncurrent versions as well. Hidden versions and files written outside this app are not reflected in its meter. Use provider billing controls independently of the app's quota.

```sh
bun run db:migrate
bun run build
bun run start
```

`bun run start` checks required production configuration before launching. Run behind an HTTPS reverse proxy with an approximately 11 MB request-body limit and a request timeout. The app needs a Node.js-compatible host with PostgreSQL TCP connections and support for 10 MB uploads. With Postgres and R2/B2 configured, no persistent application disk is needed, and multiple app instances share the same database-backed quota locks. This is not a Cloudflare Worker build. `DATA_DIR` is used only for the optional local file-storage driver. Database and storage credentials stay on the server.

Optional `FILE_BASE_URL` sets a separate file origin, routed to this app's `/f/*` paths. Inline media is enabled only when that configured origin differs from the authentication origin and matches the actual request origin. Otherwise downloads remain attachments. Keep auth cookies host-only. Configure Cloudflare to **bypass caching on `/f/*`, `/api/*`**; do not override the returned `no-store` headers with a cache-everything rule. Direct links use the application gateway so each new request checks expiry and deletion before serving bytes.

## Expiry and physical deletion

Links return HTTP 410 after exactly ten days, independently of cleanup. Expiry also gets checked after storage retrieval. Bytes already downloaded cannot be recalled, and a download that began before expiry may complete afterward.

Run cleanup every five minutes from the application directory using the same database and R2/B2 environment settings:

```cron
*/5 * * * * cd /absolute/path/to/zora && /absolute/path/to/bun run cleanup >> /var/log/zora-cleanup.log 2>&1
```

Alternatively, configure an external scheduler to POST `/api/cleanup` with `Authorization: Bearer <CRON_SECRET>`. The endpoint rejects missing/incorrect secrets. This project supplies both cleanup mechanisms; it does not install a system scheduler. Cleanup handles 100 files per invocation; increase frequency if the backlog grows. Failed deletions retain quota accounting and retry on the next run. Stale reservations are recovered after an hour. Configure a provider-side lifecycle rule as a backup for orphan objects, including incomplete multipart uploads and noncurrent versions if applicable.

## Reports and moderation

The footer's **Report a file** form flags an active file for operator review. Review the local moderation queue:

```sh
bun run reports
bun run reports <file-id>
```

The second command deletes that object and invalidates its link. Reports do not automatically delete files, and no automated moderation service is claimed. Before a broad public launch, operate the review queue and add invite controls or further account restrictions if account abuse becomes an issue.

## Verification

```sh
bun run typecheck
bun run test
bun run build
```

Tests cover script/executable blocking, double extensions, renamed executable content, image normalization, bounded streaming, transactional quotas, attempt limits, and cleanup. Integration tests start a separate app on port 3107 with a disposable real Postgres instance and local object storage, then exercise GitHub OAuth initiation, state validation, callback handling, sessions, disabled password endpoints, access control, public downloads, reporting, deletion, and expiry. GitHub token/profile/email responses are mocked only in the test child process using a Node preload module; application OAuth logic remains unchanged. Tests do not call live GitHub or R2/B2, or validate real credentials or provider billing. Tests use `.next-test/` for isolation. `embedded-postgres` supplies a local Postgres binary; tests do not use Docker, a live Neon account, or your configured database. The test helper restores bundled symlinks if needed; it does not create system users and must run as a non-root user. Database tests also exercise concurrent reservations, concurrent daily attempt limits, cleanup, and migrations.

The app uses a dark neutral and lime interface, with Mona Sans / Geist Mono and Lucide interface icons. No stock images, generated imagery, invented customer data, or example uploads are used. Fonts have system fallbacks when Google Fonts is unavailable.
