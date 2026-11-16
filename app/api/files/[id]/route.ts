import { deleteFile, findFile } from "@/lib/files";
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
    if (!(await findFile(id, user.id)))
      throw new HttpError(404, "File not found.");
    await deleteFile(id);
    return Response.json({ success: true });
  } catch (error) {
    return failure(error);
  }
}
