import { failure, requireUser, sameOrigin } from "@/lib/http";
import { completeUpload } from "@/lib/uploads";
import { publicFile } from "@/lib/files";
export const runtime = "nodejs";
export const maxDuration = 120;
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    sameOrigin(request);
    const user = await requireUser(request);
    const { id } = await context.params;
    return Response.json(
      { file: publicFile(await completeUpload(id, user.id)) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}
