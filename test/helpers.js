// Test helpers: a private data folder per test file, set before any app module loads
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function tempDir(prefix = "onsei-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Points the app's data store at a fresh folder. Call before importing lib/*.
export function useTempData() {
  const dir = tempDir();
  process.env.ONSEI_DATA_DIR = dir;
  return dir;
}

export const DAY = 24 * 60 * 60 * 1000;
