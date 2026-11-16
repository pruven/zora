import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import { MAX_FILE_BYTES } from "./config";
import { HttpError } from "./http";

const formats: Record<string, string[]> = {
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/webp": ["webp"],
  "audio/mpeg": ["mp3"],
  "audio/wav": ["wav"],
  "audio/x-wav": ["wav"],
  "video/mp4": ["mp4"],
  "video/webm": ["webm"],
  "audio/webm": ["webm"],
  "audio/ogg": ["ogg"],
  "video/ogg": ["ogg"],
  "audio/flac": ["flac"],
  "audio/x-flac": ["flac"],
};
const forbiddenSegment =
  /\.(?:exe|dll|com|scr|msi|msp|bat|cmd|ps1|psm1|sh|bash|zsh|fish|js|mjs|cjs|jsx|ts|tsx|py|pyw|rb|php\d*|phtml|pl|cgi|jar|class|vbs|vbe|wsf|hta|html?|xhtml|svg|wasm|app|dmg|deb|rpm|apk|ipa|lnk|url|desktop)(?:\.|$)/i;

export function validateName(raw: string) {
  const name = raw.normalize("NFKC");
  if (
    !name ||
    name.length > 160 ||
    /[\x00-\x1f\x7f/\\\u202a-\u202e\u2066-\u2069]/.test(name) ||
    name.startsWith(".") ||
    name.endsWith(".") ||
    name.trim() !== name
  )
    throw new HttpError(
      400,
      "Use a simple filename of 160 characters or fewer.",
    );
  if (forbiddenSegment.test(name))
    throw new HttpError(
      415,
      "Scripts and executables cannot be uploaded, even with another extension.",
    );
  const extension = name.split(".").pop()?.toLowerCase() || "";
  if (
    !Object.values(formats).some((extensions) => extensions.includes(extension))
  )
    throw new HttpError(
      415,
      "Choose a JPG, PNG, WebP, MP3, WAV, MP4, WebM, OGG, or FLAC file. Archives, documents, scripts, and executables are blocked.",
    );
  return { name, extension };
}
export async function readLimitedBody(request: Request) {
  const declared = request.headers.get("content-length");
  if (
    declared &&
    (!/^\d+$/.test(declared) || Number(declared) > MAX_FILE_BYTES)
  )
    throw new HttpError(413, "Files must be 10 MB or smaller.");
  if (!request.body) throw new HttpError(400, "Choose a non-empty file.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FILE_BYTES) {
        await reader.cancel();
        throw new HttpError(413, "Files must be 10 MB or smaller.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!size) throw new HttpError(400, "Empty files cannot be uploaded.");
  return Buffer.concat(chunks, size);
}
export async function validateUpload(rawName: string, input: Buffer) {
  const { name, extension } = validateName(rawName);
  if (!input.length || input.length > MAX_FILE_BYTES)
    throw new HttpError(413, "Choose a non-empty file up to 10 MB.");
  const type = await fileTypeFromBuffer(input).catch(() => undefined);
  if (!type || !formats[type.mime]?.includes(extension))
    throw new HttpError(
      415,
      "File contents do not match a supported format. Renaming a script or executable does not make it an allowed file.",
    );
  let body = input;
  if (type.mime.startsWith("image/")) {
    // Fully decode and re-encode; strip metadata and trailing embedded payloads.
    try {
      body = await sharp(input, {
        limitInputPixels: 40_000_000,
        failOn: "warning",
      })
        .toFormat(
          type.mime === "image/jpeg"
            ? "jpeg"
            : type.mime === "image/png"
              ? "png"
              : "webp",
        )
        .toBuffer();
    } catch {
      throw new HttpError(
        415,
        "This image is damaged, unsupported, or too large to decode.",
      );
    }
  }
  if (body.length > MAX_FILE_BYTES)
    throw new HttpError(413, "The processed file exceeds 10 MB.");
  return { name, mime: type.mime, body };
}
