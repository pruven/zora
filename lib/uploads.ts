import { and, eq, gt } from "drizzle-orm";
import { db } from "./db";
import { files } from "./schema";
import { findFile, deleteFile, reserve } from "./files";
import { MAX_FILE_BYTES, RETENTION_MS, STAGING_GRACE_MS } from "./config";
import { HttpError } from "./errors";
import { validateName, validateUpload } from "./validation";
import {
  isCloud,
  putObject,
  stagedObject,
  removeObject,
  uploadTarget,
} from "./storage";

export async function initiateUpload(
  userId: string,
  input: Record<string, unknown>,
) {
  if (process.env.NODE_ENV === "production" && !isCloud())
    throw new HttpError(503, "Direct object storage is not configured.");
  if (typeof input.name !== "string")
    throw new HttpError(400, "A filename is required.");
  const { name } = validateName(input.name);
  if (
    typeof input.size !== "number" ||
    !Number.isSafeInteger(input.size) ||
    input.size < 1 ||
    input.size > MAX_FILE_BYTES
  )
    throw new HttpError(413, "Choose a non-empty file up to 10 MB.");
  const file = await reserve(
    userId,
    name,
    "application/octet-stream",
    input.size,
    Date.now(),
    true,
  );
  try {
    return {
      id: file.id,
      expiresAt: file.uploadExpiresAt,
      upload: await uploadTarget(file.id, input.size),
    };
  } catch (error) {
    // A failed signer returned no upload URL, so this reservation can be released immediately.
    await db
      .delete(files)
      .where(and(eq(files.id, file.id), eq(files.status, "pending")));
    throw error;
  }
}
export async function completeUpload(id: string, userId: string) {
  const file = await findFile(id, userId);
  if (!file || file.status === "deleting")
    throw new HttpError(404, "File not found.");
  if (file.status === "ready") {
    if (file.expiresAt <= Date.now())
      throw new HttpError(410, "This file has expired.");
    return file;
  }
  if (
    file.uploadExpiresAt === null ||
    file.stagingSize === null ||
    !file.objectKey ||
    file.uploadExpiresAt + STAGING_GRACE_MS <= Date.now()
  )
    throw new HttpError(410, "This upload has expired. Choose the file again.");
  const [claimed] = await db
    .update(files)
    .set({ status: "processing", processingAt: Date.now() })
    .where(
      and(
        eq(files.id, id),
        eq(files.userId, userId),
        eq(files.status, "pending"),
        gt(files.uploadExpiresAt, Date.now() - STAGING_GRACE_MS),
      ),
    )
    .returning();
  if (!claimed)
    throw new HttpError(
      409,
      "This file is already being processed. Refresh your files shortly.",
    );
  let wroteFinal = false;
  try {
    const validated = await validateUpload(
      file.name,
      await stagedObject(id, file.stagingSize),
    );
    await putObject(
      file.objectKey,
      validated.body,
      validated.mime,
      validated.name,
    );
    wroteFinal = true;
    const now = Date.now();
    const [ready] = await db
      .update(files)
      .set({
        status: "ready",
        mime: validated.mime,
        size: validated.body.length,
        reservedBytes: validated.body.length + file.stagingSize,
        createdAt: now,
        expiresAt: now + RETENTION_MS,
        processingAt: null,
      })
      .where(
        and(
          eq(files.id, id),
          eq(files.status, "processing"),
          eq(files.processingAt, claimed.processingAt!),
        ),
      )
      .returning();
    if (!ready)
      throw new HttpError(409, "This upload was cancelled while processing.");
    return ready;
  } catch (error) {
    if (error instanceof HttpError && [400, 413, 415].includes(error.status)) {
      try {
        await deleteFile(id);
      } catch {
        /* Cleanup retries; reserved bytes remain accounted for. */
      }
    } else {
      // Missing objects and transient storage errors may be retried. Never revive a deleted file.
      await db
        .update(files)
        .set({ status: "pending", processingAt: null })
        .where(
          and(
            eq(files.id, id),
            eq(files.status, "processing"),
            eq(files.processingAt, claimed.processingAt!),
          ),
        )
        .catch(() => {});
      if (wroteFinal) {
        await findFile(id)
          .then(async (current) => {
            if (!current || current.status === "deleting")
              await removeObject(file.objectKey!);
          })
          .catch(() => {});
      }
    }
    throw error;
  }
}
