import { HttpError } from "./errors";

export async function readJSON(
  request: Request,
  maxBytes = 2048,
): Promise<Record<string, unknown>> {
  const mediaType = request.headers
    .get("content-type")
    ?.split(";")[0]
    .trim()
    .toLowerCase();
  if (mediaType !== "application/json")
    throw new HttpError(415, "Send a JSON request.");
  if (Number(request.headers.get("content-length")) > maxBytes)
    throw new HttpError(413, "Request is too large.");
  if (!request.body) throw new HttpError(400, "Request body is required.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new HttpError(413, "Request is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString());
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value;
  } catch {
    throw new HttpError(400, "Invalid JSON request.");
  }
}
