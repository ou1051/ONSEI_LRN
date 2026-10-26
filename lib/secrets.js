// The Claude Code token (from `claude setup-token`) that lets the background service use your
// Claude subscription. Stored in a file only your user account can read (mode 0600), the same
// protection Claude Code uses for its own credentials file. It is never sent back to the browser.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./db.js";

const DIR = path.join(DATA_DIR, "secrets");
const FILE = path.join(DIR, "claude-oauth-token");

export function readClaudeToken() {
  try {
    return fs.readFileSync(FILE, "utf8").trim() || null;
  } catch {
    return null;
  }
}

// Validates and saves a token; throws an Error with a user-facing message if it looks wrong
export function saveClaudeToken(raw) {
  const token = String(raw ?? "").trim();
  if (!token) throw new Error("Paste the token that `claude setup-token` printed.");
  if (/\s/.test(token) || token.length < 20 || token.length > 1000) {
    throw new Error("That does not look like a token. Copy the whole line that starts with sk-ant-oat.");
  }
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(DIR, 0o700);
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, token + "\n", { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, FILE);
  return token;
}

export function clearClaudeToken() {
  fs.rmSync(FILE, { force: true });
}

// Where the token Claude Code will use comes from: saved in the app, your environment, or nowhere
export function tokenSource() {
  if (readClaudeToken()) return "app";
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return "env";
  return null;
}
