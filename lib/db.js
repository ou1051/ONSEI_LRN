// Tiny store backed by a single JSON file. Meant for personal, single-user use.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = process.env.ONSEI_DATA_DIR || path.join(APP_DIR, "data");
export const PDF_DIR = path.join(DATA_DIR, "pdfs");
const DB_FILE = path.join(DATA_DIR, "db.json");

fs.mkdirSync(PDF_DIR, { recursive: true });

const empty = () => ({ docs: [], concepts: [], attempts: [], cards: [], reviews: [] });

function load() {
  try {
    return { ...empty(), ...JSON.parse(fs.readFileSync(DB_FILE, "utf8")) };
  } catch {
    return empty();
  }
}

export const db = load();

export function save() {
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

export const newId = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
