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
  listFiles,
  markReady,
} from "@/lib/files";
import { putObject } from "@/lib/storage";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const files = await listFiles(user.id);
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
    await consumeUploadAttempt(user.id);
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
    const stored = await reserve(
      user.id,
      file.name,
      file.mime,
      file.body.length,
    );
    id = stored.id;
    await putObject(stored.id, file.body, file.mime);
    await markReady(stored.id);
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
