import { resolve } from "node:path";
// Only the optional local object-storage driver uses this directory.
export const dataDir = resolve(
  /* turbopackIgnore: true */ process.env.DATA_DIR || "./data",
);
