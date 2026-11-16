import { failure, requireUser, sameOrigin } from "@/lib/http";
import { consumeUploadAttempt, listFiles, publicFile } from "@/lib/files";
import { readJSON } from "@/lib/request-json";
import { initiateUpload } from "@/lib/uploads";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    return Response.json(
      { files: (await listFiles(user.id)).map(publicFile) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const user = await requireUser(request);
    await consumeUploadAttempt(user.id);
    return Response.json(
      await initiateUpload(user.id, await readJSON(request)),
      { status: 201, headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}
