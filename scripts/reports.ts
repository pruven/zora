import { eq } from "drizzle-orm";
import { db, pool } from "../lib/db";
import { files, reports } from "../lib/schema";
import { deleteFile } from "../lib/files";
const id = process.argv[2];
try {
  if (id) {
    if (!/^[a-f0-9]{48}$/.test(id))
      throw new Error("Expected a file ID to remove.");
    await deleteFile(id);
    console.log("File removed.");
  } else {
    console.table(
      await db
        .select({
          fileId: reports.fileId,
          name: files.name,
          userId: files.userId,
          createdAt: reports.createdAt,
        })
        .from(reports)
        .innerJoin(files, eq(reports.fileId, files.id)),
    );
  }
} finally {
  await pool.end();
}
