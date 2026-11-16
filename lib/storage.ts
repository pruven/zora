import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { dataDir } from "./db";

function isCloud() {
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
  }));
}
function localPath(id: string) {
  if (!/^[a-f0-9]{48}$/.test(id)) throw new Error("Invalid storage key");
  return resolve(dataDir, "objects", id);
}
export async function putObject(id: string, body: Buffer, mime: string) {
  if (isCloud()) {
    await s3().send(
      new PutObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: id,
        Body: body,
        ContentType: mime,
        CacheControl: "private, no-store",
      }),
    );
    return;
  }
  await mkdir(resolve(dataDir, "objects"), { recursive: true, mode: 0o700 });
  await writeFile(localPath(id), body, { mode: 0o600, flag: "wx" });
}
export async function getObject(id: string) {
  if (isCloud()) {
    const response = await s3().send(
      new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: id }),
    );
    if (!response.Body) throw new Error("Object missing");
    return Buffer.from(await response.Body.transformToByteArray());
  }
  return readFile(localPath(id));
}
export async function removeObject(id: string) {
  if (isCloud()) {
    await s3().send(
      new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: id }),
    );
    return;
  }
  await rm(localPath(id), { force: true });
}
