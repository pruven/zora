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

- Maximum 10,000,000 bytes per file. The signed upload is bound to its declared byte length, and the server checks actual object size, reads with a byte limit, and checks the result again after processing.
- Allowlist: JPG, JPEG, PNG, WebP, MP3, WAV, MP4, WebM, OGG, FLAC.
- Scripts, executables, archives, HTML, SVG, PDF, and office documents are blocked. Documents are excluded because many formats support scripts, macros, or embedded objects.
- The server checks normalized filenames, dangerous double extensions, and detected binary content. Client `Content-Type` is never trusted.
- Images are decoded with a 40-megapixel limit and re-encoded, stripping metadata and trailing payloads. This also flattens animated WebP to its first frame.
- Media signatures are checked; media is not transcoded or scanned by antivirus. A format allowlist is not a guarantee that arbitrary media is harmless. R2 downloads default to attachments with the validated MIME type. The application gateway returns no-store and sandbox headers; gateway headers do not transfer to the R2 response.
- Accounts have 100 MB of storage and 20 upload attempts per rolling 24 hours. Invalid attempts count. The shared application limit is 9.5 GB, leaving headroom below a provider's 10 GB allowance.
- Capacity includes pending uploads, temporary staging bytes, processed files, and objects awaiting deletion. A new upload reserves its declared size plus 10 MB for the processed output. After validation that becomes actual output bytes plus retained staging bytes. This is deliberately conservative so both copies fit within the pool and per-account allowance. Cleanup releases staging reservations after the upload authorization and grace period expire.
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

## Direct uploads and R2 CORS

The deployed app uses a private R2 bucket and three steps:

1. `POST /api/files` accepts a small JSON object (`name`, `size`), checks the GitHub session and attempt limit, reserves quota, and returns a five-minute signed PUT URL for `staging/<id>`.
2. The browser PUTs the file **directly to R2**. The signature covers its exact `Content-Length`, `Content-Type`, `Cache-Control`, and `If-None-Match: *`. The browser sets the byte length from the file automatically. Conditional writes prevent overwriting that staging key while its object exists. Client MIME declarations never approve a file.
3. `POST /api/files/<id>/complete` has no file body. It atomically claims the pending upload, fetches its staging object from R2, validates the byte count and detected file type, sanitizes images with Sharp, and writes the approved output to `files/<id>`. Only then is the file published in the database. The PUT URL grants no write access to this final key. Repeated completion of a ready file is idempotent; concurrent completion returns a processing conflict. Validation failures never publish a link.

The Vercel upload/completion requests carry only metadata. Server-side reads from R2 during validation do not put the file in an incoming Vercel request body. The local driver follows the same workflow through a development-only PUT route; that route returns 404 in cloud mode and production.

Configure **R2 → your bucket → Settings → CORS Policy** with `r2-cors.example.json`. Replace `https://your-app-domain.com` with your real Vercel/custom origin. List every origin you actually use, including localhost only for development. The policy permits PUT/GET/HEAD and the upload headers; it does not make the bucket public. See [Cloudflare's CORS guide](https://developers.cloudflare.com/r2/buckets/cors/) and [presigned URL documentation](https://developers.cloudflare.com/r2/api/s3/presigned-urls/).

Keep `r2.dev` public access disabled and do not attach a public bucket domain. `FILE_BASE_URL` is an optional separate **app gateway** origin, not an R2 public URL. The app's `/f/<id>/<name>` link checks the database status and ten-day expiry, then redirects to a signed R2 GET URL valid for at most 60 seconds and never past the file's deadline. Downloads go directly from R2 to the recipient. The gateway's redirect is not cached. The local development driver serves bytes from disk instead.

The storage adapter can work with other S3-compatible providers only if they support the signed headers and atomic `If-None-Match` PUT behavior. R2 is the deployment target tested with the S3 fixture; live B2 compatibility is not verified. Free storage and R2 egress do not make hosting, requests, processing, domains, or databases universally free.

## Deploy to Vercel

1. Run `bun run db:migrate` against your intended database before deploying. Migration `0001_staged_uploads` adds nullable fields and preserves existing metadata and share links; old objects keep their existing keys.
2. Import the repository into Vercel as a Next.js project. `vercel.json` uses `bun install --frozen-lockfile` and validates production configuration before building. Set Node.js 22.16+ and enable Fluid compute. The completion and cleanup routes request up to 120 seconds of execution time.
3. Add the production environment variables above in Vercel, especially `STORAGE_DRIVER=s3`, `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, GitHub credentials, R2 credentials, and `CRON_SECRET`. `DATA_DIR` is not needed with R2. Use a separate GitHub OAuth App for production with `<BETTER_AUTH_URL>/api/auth/callback/github` as its callback. Deploy previews need matching auth and R2 CORS configuration; adding a preview URL to CORS alone does not configure GitHub OAuth.
4. Apply the R2 CORS policy for the deployed origin. Add backup lifecycle rules: delete objects under `staging/` after one day and under `files/` after eleven days. Lifecycle rules are crash/orphan backstops, not the exact link-expiry clock.
5. Configure the external cleanup schedule below. No cron schedule is silently installed by the repository. Choose a Node.js function region close to Neon, then test upload, copy-link/download, and deletion through the deployed site.

The same code can run on another Node.js host with PostgreSQL TCP access. With Postgres and R2 configured, no persistent application disk is needed. Multiple app instances share the database-backed quota and completion locks. This is not a Cloudflare Worker build. `DATA_DIR` is used only by the optional local development driver.

## Expiry and physical deletion

The ten-day expiry is recorded when the file is published, after validation and successful storage of the final object. The app gateway rejects new requests after the deadline; each signed R2 download URL also expires no later than that deadline. Recipients can keep copies, and downloads that started before expiry can finish afterward. Deletion hides the file immediately and removes the published R2 object.

Staging objects and reservations remain until the upload URL has expired plus a one-hour grace period. This prevents an issued PUT URL from recreating a deleted staging key while it is still valid, and allows for in-flight requests. Failed, cancelled, and abandoned uploads remain private and count toward capacity during that interval. A recently cancelled processing request retains its reservation for an hour as well. Cleanup then removes staging, releases its reserved bytes, retries failed deletions, and recovers stuck processing. Configure the provider lifecycle backstop for crashes and unusually delayed requests; the application meter is not a provider-enforced billing cap.

Run cleanup every five minutes from a machine with the same database and R2 environment settings:

```cron
*/5 * * * * cd /absolute/path/to/zora && /absolute/path/to/bun run cleanup >> /var/log/zora-cleanup.log 2>&1
```

For Vercel, use an external scheduler to send `POST https://your-app-domain/api/cleanup` with `Authorization: Bearer <CRON_SECRET>`. GET is also supported with the same authentication for schedulers that require it. Use HTTPS and store the secret in the scheduler's secret/header settings. The repository supplies the endpoint; it does not register a cron job or assume a paid scheduling plan. Cleanup handles up to 100 expired/tombstoned files and 100 ready staging objects per invocation; increase frequency if a backlog grows. Responses report `deleted`, `stagingDeleted`, and `failed` counts.

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

Tests cover script/executable blocking, double extensions, renamed executable content, image normalization, bounded streaming, transactional quotas, attempt limits, and cleanup. Integration tests start a separate app on port 3107 with a disposable real Postgres instance and local object storage, then exercise GitHub OAuth initiation, state validation, callback handling, sessions, disabled password endpoints, access control, public downloads, reporting, deletion, and expiry. GitHub token/profile/email responses are mocked only in the test child process using a Node preload module; application OAuth logic remains unchanged. Tests do not call live GitHub or R2/B2, or validate real credentials or provider billing. Tests use `.next-test/` for isolation. `embedded-postgres` supplies a local Postgres binary; tests do not use Docker, a live Neon account, or your configured database. The test helper restores bundled symlinks if needed; it does not create system users and must run as a non-root user. Database tests also exercise concurrent reservations, concurrent daily attempt limits, cleanup, and migrations. The cloud integration flow uses a local S3 fixture that verifies AWS SigV4 presigned URLs and exact signed headers, stores objects privately, and enforces single-write staging. It tests a 5 MB direct upload/download, ownership, size tampering, replay, simultaneous completion, cancellation during processing, and cleanup. It does not prove live R2 browser CORS or Vercel deployment behavior.

The app uses a dark neutral and lime interface, with Mona Sans / Geist Mono and Lucide interface icons. No stock images, generated imagery, invented customer data, or example uploads are used. Fonts have system fallbacks when Google Fonts is unavailable.
