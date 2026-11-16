import { createServer } from "node:http";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const access = "test-access-key",
  secret = "test-secret-key";
const sha = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const encode = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

// Small S3 protocol fixture. Presigned requests use actual AWS SigV4 verification;
// signed server SDK calls are accepted with the fixture's test credentials only.
export async function testS3() {
  const hooks: { beforeGet?: (key: string) => Promise<void> } = {};
  const objects = new Map<
    string,
    { body: Buffer; mime: string; disposition: string; cache: string }
  >();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, `http://${request.headers.host}`);
    const signature = url.searchParams.get("X-Amz-Signature");
    if (signature) {
      const credential =
        url.searchParams.get("X-Amz-Credential")?.split("/") || [];
      const date = url.searchParams.get("X-Amz-Date") || "";
      const signed = (url.searchParams.get("X-Amz-SignedHeaders") || "").split(
        ";",
      );
      const canonicalHeaders = signed
        .map(
          (name) =>
            `${name}:${String(request.headers[name] || "")
              .trim()
              .replace(/\s+/g, " ")}\n`,
        )
        .join("");
      const query = [...url.searchParams]
        .filter(([key]) => key !== "X-Amz-Signature")
        .map(([key, value]) => [encode(key), encode(value)])
        .sort(([a, av], [b, bv]) =>
          a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0,
        )
        .map(([key, value]) => `${key}=${value}`)
        .join("&");
      const canonical = [
        request.method,
        url.pathname,
        query,
        canonicalHeaders,
        signed.join(";"),
        url.searchParams.get("X-Amz-Content-Sha256") || "UNSIGNED-PAYLOAD",
      ].join("\n");
      let key: Buffer = Buffer.from(`AWS4${secret}`);
      for (const part of credential.slice(1))
        key = createHmac("sha256", key).update(part).digest();
      const expected = createHmac("sha256", key)
        .update(
          [
            "AWS4-HMAC-SHA256",
            date,
            credential.slice(1).join("/"),
            sha(canonical),
          ].join("\n"),
        )
        .digest("hex");
      const parsedDate = Date.parse(
        date.replace(
          /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
          "$1-$2-$3T$4:$5:$6Z",
        ),
      );
      if (
        credential[0] !== access ||
        signature.length !== expected.length ||
        !timingSafeEqual(Buffer.from(signature), Buffer.from(expected)) ||
        Date.now() >
          parsedDate + Number(url.searchParams.get("X-Amz-Expires")) * 1000
      ) {
        response.writeHead(403);
        response.end();
        return;
      }
    } else if (
      !request.headers.authorization?.includes(`Credential=${access}/`)
    ) {
      response.writeHead(403);
      response.end();
      return;
    }
    const key = decodeURIComponent(
      url.pathname.replace(/^\/test-bucket\//, ""),
    );
    const fail = (status: number, code: string) => {
      response.writeHead(status, { "Content-Type": "application/xml" });
      response.end(
        `<Error><Code>${code}</Code><Message>${code}</Message></Error>`,
      );
    };
    try {
      if (request.method === "PUT") {
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 11_000_000) {
            fail(413, "EntityTooLarge");
            return;
          }
          chunks.push(chunk);
        }
        if (request.headers["if-none-match"] === "*" && objects.has(key)) {
          fail(412, "PreconditionFailed");
          return;
        }
        objects.set(key, {
          body: Buffer.concat(chunks),
          mime: String(
            request.headers["content-type"] || "application/octet-stream",
          ),
          disposition: String(
            request.headers["content-disposition"] || "attachment",
          ),
          cache: String(
            request.headers["cache-control"] || "private, no-store",
          ),
        });
        response.writeHead(200, { ETag: '"test-etag"' });
        response.end();
        return;
      }
      if (request.method === "DELETE") {
        objects.delete(key);
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method === "GET") await hooks.beforeGet?.(key);
      const object = objects.get(key);
      if (!object) {
        fail(404, "NoSuchKey");
        return;
      }
      response.writeHead(200, {
        "Content-Length": object.body.length,
        "Content-Type": object.mime,
        "Cache-Control":
          url.searchParams.get("response-cache-control") || object.cache,
        "Content-Disposition":
          url.searchParams.get("response-content-disposition") ||
          object.disposition,
        ETag: '"test-etag"',
      });
      response.end(request.method === "HEAD" ? undefined : object.body);
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    objects,
    hooks,
    endpoint,
    env: {
      S3_ENDPOINT: endpoint,
      S3_BUCKET: "test-bucket",
      S3_ACCESS_KEY_ID: access,
      S3_SECRET_ACCESS_KEY: secret,
      S3_REGION: "auto",
    },
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
