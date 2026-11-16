import { db } from "../lib/db";
import { deleteFile } from "../lib/files";
const id = process.argv[2];
if (id) {
  if (!/^[a-f0-9]{48}$/.test(id))
    throw new Error("Expected a file ID to remove.");
  await deleteFile(id);
  console.log("File removed.");
} else {
  console.table(
    db
      .prepare(
        "SELECT reports.fileId, files.name, files.userId, reports.createdAt FROM reports JOIN files ON reports.fileId = files.id",
      )
      .all(),
  );
}
