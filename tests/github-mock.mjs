// Loaded only into the integration-test child process with Node's --import.
// Exercise Better Auth's real OAuth state/callback/session handling without GitHub credentials.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (
    url.origin === "https://github.com" &&
    url.pathname === "/login/oauth/access_token"
  ) {
    const body = new URLSearchParams(await request.text());
    const code = body.get("code");
    if (!["one", "two"].includes(code))
      return Response.json({ error: "bad_verification_code" }, { status: 400 });
    return Response.json({
      access_token: `test-github-${code}`,
      token_type: "bearer",
      scope: "read:user,user:email",
    });
  }
  if (url.origin === "https://api.github.com") {
    const token = request.headers.get("authorization");
    const identity =
      token === "Bearer test-github-one"
        ? "one"
        : token === "Bearer test-github-two"
          ? "two"
          : null;
    if (!identity)
      return Response.json({ message: "Bad credentials" }, { status: 401 });
    const email = `${identity}@example.com`;
    if (url.pathname === "/user")
      return Response.json({
        id: identity === "one" ? 101 : 202,
        login: `tester-${identity}`,
        name: "Tester",
        email: null,
        avatar_url: null,
      });
    if (url.pathname === "/user/emails")
      return Response.json([
        { email, primary: true, verified: true, visibility: null },
      ]);
    throw new Error(`Unexpected GitHub API request: ${url.pathname}`);
  }
  return originalFetch(input, init);
};
