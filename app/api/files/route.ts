import { db, StoredFile } from "@/lib/db";
import { failure, requireUser, sameOrigin } from "@/lib/http";
import {
  validateName,
  validateUpload,
  readLimitedBody,
} from "@/lib/validation";
import {
  reserve,
  publicFile,
  deleteFile,
  consumeUploadAttempt,
} from "@/lib/files";
import { putObject } from "@/lib/storage";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const files = db
      .prepare(
        "SELECT * FROM files WHERE userId = ? AND status = 'ready' AND expiresAt > ? ORDER BY createdAt DESC",
      )
      .all(user.id, Date.now()) as StoredFile[];
    return Response.json(
      { files: files.map(publicFile) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request) {
  let id: string | undefined;
  try {
    sameOrigin(request);
    const user = await requireUser(request);
    consumeUploadAttempt(user.id);
    let rawName: string;
    try {
      rawName = decodeURIComponent(request.headers.get("x-file-name") || "");
    } catch {
      return Response.json(
        { error: "Invalid filename encoding." },
        { status: 400 },
      );
    }
    validateName(rawName);
    const file = await validateUpload(rawName, await readLimitedBody(request));
    const stored = reserve(user.id, file.name, file.mime, file.body.length);
    id = stored.id;
    await putObject(stored.id, file.body, file.mime);
    db.prepare(
      "UPDATE files SET status = 'ready' WHERE id = ? AND status = 'pending'",
    ).run(stored.id);
    return Response.json(
      { file: publicFile(stored) },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (id) {
      try {
        await deleteFile(id);
      } catch {
        /* Reservation retained for cleanup; bytes stay accounted for. */
      }
    }
    return failure(error);
  }
}
