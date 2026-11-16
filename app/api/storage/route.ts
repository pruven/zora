import { GLOBAL_BYTES, USER_BYTES } from "@/lib/config";
import { usage } from "@/lib/files";
import { requireUser, failure, HttpError } from "@/lib/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    let personal: number | null = null;
    try {
      personal = await usage((await requireUser(request)).id);
    } catch (error) {
      if (!(error instanceof HttpError && error.status === 401)) throw error;
    }
    return Response.json(
      {
        used: await usage(),
        total: GLOBAL_BYTES,
        personal,
        personalTotal: USER_BYTES,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}
