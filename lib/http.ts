import { auth } from "./auth";
import { appURL } from "./config";
import { HttpError } from "./errors";
export { HttpError } from "./errors";
export function sameOrigin(request: Request) {
  if (request.headers.get("origin") !== new URL(appURL()).origin)
    throw new HttpError(403, "Request origin is not allowed.");
}
export async function requireUser(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) throw new HttpError(401, "Sign in to manage your files.");
  return session.user;
}
export function failure(error: unknown) {
  if (error instanceof HttpError)
    return Response.json({ error: error.message }, { status: error.status });
  console.error("Request failed:", error);
  return Response.json(
    { error: "Something went wrong. Please try again." },
    { status: 500 },
  );
}
