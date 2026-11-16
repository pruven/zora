import { db } from "@/lib/db";
import { deleteFile } from "@/lib/files";
import { failure, HttpError, requireUser, sameOrigin } from "@/lib/http";
export const runtime = "nodejs";
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    sameOrigin(request);
    const user = await requireUser(request);
    const { id } = await context.params;
    if (
      !db
        .prepare("SELECT id FROM files WHERE id = ? AND userId = ?")
        .get(id, user.id)
    )
      throw new HttpError(404, "File not found.");
    await deleteFile(id);
    return Response.json({ success: true });
  } catch (error) {
    return failure(error);
  }
}
