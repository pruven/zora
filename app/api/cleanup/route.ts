import { timingSafeEqual } from "node:crypto";
import { cleanup } from "@/lib/files";
export const runtime = "nodejs";
export const maxDuration = 120;
async function handle(request: Request) {
  const secret = process.env.CRON_SECRET;
  const given = Buffer.from(request.headers.get("authorization") || "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (
    !secret ||
    given.length !== expected.length ||
    !timingSafeEqual(given, expected)
  )
    return new Response("Unauthorized", { status: 401 });
  return Response.json(await cleanup());
}

export { handle as GET, handle as POST };
