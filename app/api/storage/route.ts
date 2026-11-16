import { GLOBAL_BYTES, USER_BYTES } from "@/lib/config";
import { usage } from "@/lib/files";
import { requireUser } from "@/lib/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  let personal: number | null = null;
  try {
    personal = usage((await requireUser(request)).id);
  } catch {
    /* Public global capacity. */
  }
  return Response.json(
    { used: usage(), total: GLOBAL_BYTES, personal, personalTotal: USER_BYTES },
    { headers: { "Cache-Control": "no-store" } },
  );
}
