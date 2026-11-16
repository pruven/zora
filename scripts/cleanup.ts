import { cleanup } from "../lib/files";
import { pool } from "../lib/db";
try {
  const result = await cleanup();
  console.log(JSON.stringify(result));
  if (result.failed) process.exitCode = 1;
} finally {
  await pool.end();
}
