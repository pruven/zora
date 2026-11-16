import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { mkdir, rm, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { dataDir } from "./local-data";
import {
  MAX_FILE_BYTES,
  UPLOAD_URL_SECONDS,
  DOWNLOAD_URL_SECONDS,
} from "./config";
import { HttpError } from "./errors";

export function isCloud() {
  return process.env.STORAGE_DRIVER === "s3";
}
let client: S3Client;
function s3() {
  for (const key of [
    "S3_ENDPOINT",
    "S3_BUCKET",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
  ])
    if (!process.env[key]) throw new Error(`Missing ${key}`);
  return (client ??= new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION || "auto",
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
  }));
}
function checkedKey(key: string) {
  if (!/^(?:(?:staging|files)\/)?[a-f0-9]{48}$/.test(key))
    throw new Error("Invalid storage key");
  return key;
}
function localPath(key: string) {
  return resolve(dataDir, "objects", checkedKey(key));
}
export const stagingKey = (id: string) => checkedKey(`staging/${id}`);
export function disposition(name: string, inline = false) {
  return `${inline ? "inline" : "attachment"}; filename="download.${name.split(".").pop()}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}`;
}
export async function putObject(
  key: string,
  body: Buffer,
  mime: string,
  name = "download.bin",
) {
  checkedKey(key);
  if (isCloud()) {
    await s3().send(
      new PutObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: key,
        Body: body,
        ContentType: mime,
        CacheControl: "private, no-store, max-age=0",
        ContentDisposition: disposition(name),
        ...(key.startsWith("staging/") ? { IfNoneMatch: "*" } : {}),
      }),
      { abortSignal: AbortSignal.timeout(45_000) },
    );
    return;
  }
  await mkdir(dirname(localPath(key)), { recursive: true, mode: 0o700 });
  try {
    await writeFile(localPath(key), body, {
      mode: 0o600,
      flag: key.startsWith("staging/") ? "wx" : "w",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new HttpError(409, "This upload has already been written.");
    throw error;
  }
}
async function boundedBuffer(
  stream: AsyncIterable<Uint8Array> & { destroy?: () => void },
  expected?: number,
) {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      size += chunk.byteLength;
      if (size > MAX_FILE_BYTES || (expected !== undefined && size > expected))
        throw new HttpError(413, "Uploaded file exceeds its reserved size.");
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    stream.destroy?.();
    throw error;
  }
  if (expected !== undefined && size !== expected)
    throw new HttpError(
      400,
      "Uploaded file size does not match its reservation.",
    );
  return Buffer.concat(chunks, size);
}
export async function getObject(key: string, expected?: number) {
  checkedKey(key);
  if (isCloud()) {
    const response = await s3().send(
      new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }),
      { abortSignal: AbortSignal.timeout(45_000) },
    );
    if (!response.Body) throw new Error("Object missing");
    const body = response.Body as AsyncIterable<Uint8Array> & {
      destroy?: () => void;
    };
    if (
      response.ContentLength !== undefined &&
      (response.ContentLength > MAX_FILE_BYTES ||
        (expected !== undefined && response.ContentLength !== expected))
    ) {
      body.destroy?.();
      throw new HttpError(
        413,
        "Uploaded file size does not match its reservation.",
      );
    }
    return boundedBuffer(body, expected);
  }
  return boundedBuffer(createReadStream(localPath(key)), expected);
}
export async function stagedObject(id: string, expected: number) {
  const key = stagingKey(id);
  let size: number | undefined;
  try {
    size = isCloud()
      ? (
          await s3().send(
            new HeadObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }),
            { abortSignal: AbortSignal.timeout(15_000) },
          )
        ).ContentLength
      : (await stat(localPath(key))).size;
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode === 404
    )
      throw new HttpError(
        409,
        "The upload has not finished. Please try completing it again.",
      );
    throw error;
  }
  if (size !== expected || size > MAX_FILE_BYTES)
    throw new HttpError(
      413,
      "Uploaded file size does not match its reservation.",
    );
  return getObject(key, expected);
}
export async function removeObject(key: string) {
  checkedKey(key);
  if (isCloud()) {
    await s3().send(
      new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }),
      { abortSignal: AbortSignal.timeout(15_000) },
    );
    return;
  }
  await rm(localPath(key), { force: true });
}
export async function uploadTarget(id: string, size: number) {
  const headers = {
    "Content-Type": "application/octet-stream",
    "If-None-Match": "*",
    "Cache-Control": "private, no-store",
  };
  if (!isCloud())
    return { url: `/api/uploads/${id}/content`, method: "PUT", headers };
  const url = await getSignedUrl(
    s3(),
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: stagingKey(id),
      ContentLength: size,
      ContentType: headers["Content-Type"],
      IfNoneMatch: "*",
      CacheControl: headers["Cache-Control"],
    }),
    {
      expiresIn: UPLOAD_URL_SECONDS,
      signableHeaders: new Set([
        "content-length",
        "content-type",
        "if-none-match",
        "cache-control",
      ]),
    },
  );
  return { url, method: "PUT", headers };
}
export async function downloadURL(
  key: string,
  name: string,
  expiresAt: number,
  inline: boolean,
) {
  checkedKey(key);
  const signingDate = new Date();
  const expiresIn = Math.min(
    DOWNLOAD_URL_SECONDS,
    Math.floor((expiresAt - signingDate.getTime()) / 1000),
  );
  if (expiresIn < 1) throw new HttpError(410, "This file has expired.");
  return getSignedUrl(
    s3(),
    new GetObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      ResponseContentDisposition: disposition(name, inline),
      ResponseCacheControl: "private, no-store, max-age=0",
    }),
    { expiresIn, signingDate },
  );
}
