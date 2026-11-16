import { auth, ensureAuth } from "@/lib/auth";
export const runtime = "nodejs";
async function handle(request: Request) {
  if (
    new URL(request.url).pathname === "/api/auth/sign-in/social" &&
    (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET)
  ) {
    return Response.json(
      { message: "GitHub sign-in is not configured. Please try again later." },
      { status: 503 },
    );
  }
  await ensureAuth();
  return auth.handler(request);
}
export { handle as GET, handle as POST };
