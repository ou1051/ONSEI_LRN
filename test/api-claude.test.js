// Reproduces the "authentication error when adding a PDF" problem end to end: the server uses a
// Claude Code CLI that, like one started by launchd, cannot read the Keychain login. Saving a
// token from `claude setup-token` in Settings fixes it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3700 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = tempDir();
let server;

before(async () => {
  server = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      ONSEI_DATA_DIR: DATA,
      ONSEI_PROVIDER: "claude-code",
      ONSEI_CLAUDE_BIN: path.join(ROOT, "test/fixtures/fake-claude.mjs"),
      FAKE_CLAUDE_MODE: "needs-token",
      CLAUDE_CODE_OAUTH_TOKEN: "",
      ONSEI_MOCK: "",
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
});
after(() => server.kill());

const json = async (method, url, body) => {
  const res = await fetch(BASE + url, {
    method,
    headers: body instanceof FormData || body === undefined ? {} : { "Content-Type": "application/json" },
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
const upload = () => {
  const f = new FormData();
  f.append("pdf", new Blob(["%PDF-1.4\n%%EOF\n"], { type: "application/pdf" }), "notes.pdf");
  return json("POST", "/api/docs", f);
};

test("without a token, adding a PDF fails with a clear, fixable message", async () => {
  const r = await upload();
  assert.equal(r.status, 502);
  assert.match(r.body.error, /Settings → Claude connection/);
  assert.match(r.body.error, /claude setup-token/);
  const ai = (await json("GET", "/api/ai")).body;
  assert.equal(ai.provider, "claude-code");
  assert.equal(ai.tokenSource, null);
  assert.equal(ai.status.ok, false);
  assert.equal(ai.status.code, "auth");
  assert.match(ai.status.detail, /Not logged in/);
  assert.equal((await json("GET", "/api/docs")).body.length, 0, "nothing half-saved");
});

test("a malformed or rejected token is refused and not kept", async () => {
  assert.equal((await json("POST", "/api/ai/token", { token: "nope" })).status, 400);
  const wrong = await json("POST", "/api/ai/token", { token: "sk-ant-oat01-wrong-token-xxxxxxxx" });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.error, /did not accept that token/);
  assert.equal((await json("GET", "/api/ai")).body.tokenSource, null);
});

test("saving a valid token connects, and adding a PDF works", async () => {
  const r = await json("POST", "/api/ai/token", { token: "sk-ant-oat01-good-token-for-tests" });
  assert.equal(r.status, 200);
  assert.equal(r.body.status.ok, true);
  assert.equal(r.body.tokenSource, "app");
  assert.ok(!JSON.stringify(r.body).includes("good-token"), "the token is never sent back");
  const file = path.join(DATA, "secrets", "claude-oauth-token");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const doc = await upload();
  assert.equal(doc.status, 200);
  assert.equal(doc.body.title, "Fake deck");
  assert.equal((await json("POST", "/api/ai/test")).body.status.ok, true);
});

test("removing the token goes back to the login (and its error)", async () => {
  assert.equal((await json("DELETE", "/api/ai/token")).body.tokenSource, null);
  const t = (await json("POST", "/api/ai/test")).body;
  assert.equal(t.status.code, "auth");
});
