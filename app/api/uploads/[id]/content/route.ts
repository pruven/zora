import { failure, HttpError, requireUser, sameOrigin } from "@/lib/http";
import { findFile } from "@/lib/files";
import { isCloud, stagingKey, putObject } from "@/lib/storage";
import { readLimitedBody } from "@/lib/validation";
export const runtime = "nodejs";
// Local development only. Production uploads must go directly to private R2.
export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  if (isCloud() || process.env.NODE_ENV === "production")
    return new Response("Not found", { status: 404 });
  try {
    sameOrigin(request);
    const user = await requireUser(request);
    const { id } = await context.params;
    const file = await findFile(id, user.id);
    if (
      !file ||
      file.status !== "pending" ||
      !file.uploadExpiresAt ||
      file.stagingSize === null
    )
      throw new HttpError(404, "Upload not found.");
    if (file.uploadExpiresAt <= Date.now())
      throw new HttpError(410, "This upload has expired.");
    const body = await readLimitedBody(request);
    if (body.length !== file.stagingSize)
      throw new HttpError(
        413,
        "Uploaded file size does not match its reservation.",
      );
    await putObject(stagingKey(id), body, "application/octet-stream");
    return new Response(null, {
      status: 204,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return failure(error);
  }
}
