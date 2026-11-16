import { cleanup } from "../lib/files";
const result = await cleanup();
console.log(JSON.stringify(result));
if (result.failed) process.exitCode = 1;
