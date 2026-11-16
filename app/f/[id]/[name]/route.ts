import { findFile } from "@/lib/files";
import { getObject, isCloud, downloadURL } from "@/lib/storage";
import { appURL } from "@/lib/config";
import { HttpError } from "@/lib/errors";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; name: string }> },
) {
  const { id, name } = await context.params;
  const headers = {
    "Cache-Control": "private, no-store, max-age=0",
    "CDN-Cache-Control": "no-store",
    "Cloudflare-CDN-Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
  };
  try {
    const file = await findFile(id);
    if (!file || file.status !== "ready" || file.name !== name)
      return new Response("File not found.", { status: 404, headers });
    if (file.expiresAt <= Date.now())
      return new Response("This file has expired.", { status: 410, headers });
    const isolated =
      process.env.FILE_BASE_URL &&
      new URL(process.env.FILE_BASE_URL).origin !== new URL(appURL()).origin &&
      new URL(request.url).origin === new URL(process.env.FILE_BASE_URL).origin;
    if (isCloud()) {
      const url = await downloadURL(
        file.objectKey || id,
        file.name,
        file.expiresAt,
        !!isolated,
      );
      const current = await findFile(id);
      if (
        !current ||
        current.status !== "ready" ||
        current.expiresAt <= Date.now()
      )
        return new Response("This file is no longer available.", {
          status: 410,
          headers,
        });
      return new Response(null, {
        status: 302,
        headers: { ...headers, Location: url },
      });
    }
    const body = await getObject(file.objectKey || id);
    // Recheck after origin I/O so an expiry during retrieval cannot open a new download.
    const current = await findFile(id);
    if (
      !current ||
      current.status !== "ready" ||
      current.expiresAt <= Date.now()
    )
      return new Response("This file is no longer available.", {
        status: 410,
        headers,
      });
    return new Response(new Uint8Array(body), {
      headers: {
        ...headers,
        "Content-Type": file.mime,
        "Content-Length": String(body.length),
        "Content-Disposition": `${isolated ? "inline" : "attachment"}; filename="download.${file.name.split(".").pop()}"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}`,
      },
    });
  } catch (error) {
    if (error instanceof HttpError && error.status === 410)
      return new Response(error.message, { status: 410, headers });
    console.error("Download failed:", error);
    return new Response("File is temporarily unavailable.", {
      status: 503,
      headers,
    });
  }
}
