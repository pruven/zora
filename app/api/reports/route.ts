import { findFile, reportFile } from "@/lib/files";
import { failure, HttpError, sameOrigin } from "@/lib/http";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    if (Number(request.headers.get("content-length")) > 1024)
      throw new HttpError(413, "Report is too large.");
    if (!request.body) throw new HttpError(400, "File link is required.");
    const reader = request.body.getReader();
    let length = 0;
    const chunks = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 1024) {
          await reader.cancel();
          throw new HttpError(413, "Report is too large.");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    let id: unknown;
    try {
      id = JSON.parse(Buffer.concat(chunks).toString()).id;
    } catch {
      throw new HttpError(400, "Invalid report.");
    }
    if (typeof id !== "string" || !/^[a-f0-9]{48}$/.test(id))
      throw new HttpError(400, "Invalid file link.");
    const file = await findFile(id);
    if (!file || file.status !== "ready" || file.expiresAt <= Date.now())
      throw new HttpError(404, "File not found or already expired.");
    await reportFile(id);
    return Response.json({ success: true });
  } catch (error) {
    return failure(error);
  }
}
