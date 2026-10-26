import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { useTempData, tempDir } from "../helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = useTempData();
process.env.ONSEI_PROVIDER = "claude-code";
process.env.ONSEI_CLAUDE_BIN = path.join(here, "../fixtures/fake-claude.mjs");
process.env.ANTHROPIC_API_KEY = "sk-should-not-be-passed";
const log = path.join(tempDir(), "call.json");
process.env.FAKE_CLAUDE_LOG = log;

const ai = await import("../../lib/ai.js");

const pdf = path.join(dataDir, "doc.pdf");
fs.writeFileSync(pdf, "%PDF-1.4\n%%EOF\n");
const concept = { title: "A", question: "What is A?", key_points: ["x", "y"], pages: "1" };

test("provider is Claude Code; the API key is not passed to it", async () => {
  assert.equal(ai.PROVIDER, "claude-code");
  process.env.FAKE_CLAUDE_MODE = "";
  const r = await ai.extractConcepts(pdf, "ja");
  assert.equal(r.doc_title, "Fake deck");
  const call = JSON.parse(fs.readFileSync(log, "utf8"));
  assert.equal(call.apiKey, null);
  assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(dataDir), "runs next to the PDF");
  assert.ok(call.args.includes("--tools") && call.args[call.args.indexOf("--tools") + 1] === "Read", "only the Read tool");
  assert.ok(call.args.includes("--no-session-persistence"));
  assert.match(call.prompt, /Read tool to read doc\.pdf/);
  assert.match(call.prompt, /Write every text field in Japanese/);
});

test("grading: history and language reach the prompt; output is normalized", async () => {
  process.env.FAKE_CLAUDE_MODE = "structured";
  const history = [{ transcript: "first try", result: { overall: "Missing y.", mistakes: [{ quote: "q", problem: "p" }] } }];
  const r = await ai.evaluateExplanation({ pdfPath: pdf, concept, transcript: "A is x and y", history, lang: "en" });
  const call = JSON.parse(fs.readFileSync(log, "utf8"));
  assert.match(call.prompt, /\[Attempt 1\]\nfirst try/);
  assert.match(call.prompt, /A is x and y/);
  assert.match(call.prompt, /exactly 2 items/);
  assert.equal(r.score, 100, "clamped to 0-100");
  assert.deepEqual(r.covered, [true, false], "padded to one entry per key point");
  assert.equal(r.jargon.length, 3, "at most three terms");
  assert.equal(r.card_back, "A is x");
});

test("Claude Code errors become clear messages", async () => {
  process.env.FAKE_CLAUDE_MODE = "error";
  await assert.rejects(ai.extractConcepts(pdf, "en"), (e) => e instanceof ai.AIError && e.code === "auth" && /Claude connection/.test(e.message));
  process.env.FAKE_CLAUDE_MODE = "garbage";
  await assert.rejects(ai.extractConcepts(pdf, "en"), /Claude Code failed/);
  process.env.FAKE_CLAUDE_MODE = "noresult";
  await assert.rejects(ai.extractConcepts(pdf, "en"), /Could not read the AI's response/);
});

test("normalizeEvaluation guards against odd model output", () => {
  const r = ai.normalizeEvaluation(
    { verdict: "maybe", score: "high", covered: "yes", overall: null, mistakes: [null, { quote: 1 }], missing: ["ok", 3], jargon: null, card_back: "x" },
    concept,
  );
  assert.equal(r.verdict, "incorrect");
  assert.equal(r.score, null);
  assert.deepEqual(r.covered, [false, false]);
  assert.equal(r.overall, "");
  assert.deepEqual(r.mistakes, [{ quote: "1", problem: "", correction: "" }]);
  assert.deepEqual(r.missing, ["ok"]);
  assert.deepEqual(r.jargon, []);
  assert.equal(r.card_back, "", "no card text for an incorrect verdict");
  assert.equal(r.card_front, "What is A?");
});

test("auth failures are recognized (JSON or plain text) and point to the token fix", async () => {
  for (const mode of ["notloggedin", "plaintext-auth", "error"]) {
    process.env.FAKE_CLAUDE_MODE = mode;
    await assert.rejects(ai.extractConcepts(pdf, "en"), (e) => e.code === "auth" && /Settings → Claude connection/.test(e.message) && /claude setup-token/.test(e.message), mode);
    assert.equal(ai.aiStatus.ok, false);
    assert.equal(ai.aiStatus.code, "auth");
    assert.match(ai.aiStatus.detail, /Please run \/login/);
  }
});

test("usage limits get their own message", async () => {
  process.env.FAKE_CLAUDE_MODE = "usage";
  await assert.rejects(ai.extractConcepts(pdf, "en"), (e) => e.code === "usage_limit" && /usage limit/.test(e.message));
});

test("testConnection: a tiny request with no tools; status reflects the result", async () => {
  process.env.FAKE_CLAUDE_MODE = "";
  const s = await ai.testConnection();
  assert.equal(s.ok, true);
  assert.equal(s.code, null);
  const call = JSON.parse(fs.readFileSync(log, "utf8"));
  assert.equal(call.args[call.args.indexOf("--tools") + 1], "", "all tools disabled");
  assert.ok(!call.args.includes("--json-schema"));
  assert.match(call.prompt, /Reply with the single word OK/);

  process.env.FAKE_CLAUDE_MODE = "notloggedin";
  const bad = await ai.testConnection();
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "auth");
});

test("a saved token is passed to Claude Code as CLAUDE_CODE_OAUTH_TOKEN and fixes the launchd login problem", async () => {
  const secrets = await import("../../lib/secrets.js");
  process.env.FAKE_CLAUDE_MODE = "needs-token";
  secrets.clearClaudeToken();
  assert.equal((await ai.testConnection()).code, "auth", "without a token: not logged in");

  secrets.saveClaudeToken("  sk-ant-oat01-good-token-for-tests \n");
  const s = await ai.testConnection();
  assert.equal(s.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(log, "utf8")).token, "sk-ant-oat01-good-token-for-tests");
  const r = await ai.extractConcepts(pdf, "en");
  assert.equal(r.doc_title, "Fake deck");

  secrets.saveClaudeToken("sk-ant-oat01-wrong-token-xxxxxxxx");
  assert.equal((await ai.testConnection()).code, "auth", "a wrong token is an auth error too");
  secrets.clearClaudeToken();
});

test("token storage: owner-only permissions, validation, source", async () => {
  const secrets = await import("../../lib/secrets.js");
  assert.throws(() => secrets.saveClaudeToken(""), /Paste the token/);
  assert.throws(() => secrets.saveClaudeToken("short"), /does not look like a token/);
  assert.throws(() => secrets.saveClaudeToken("sk-ant-oat01 with spaces inside it"), /does not look like a token/);
  secrets.saveClaudeToken("sk-ant-oat01-abcdefghijklmnopqrstuvwxyz");
  assert.equal(secrets.readClaudeToken(), "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz");
  assert.equal(secrets.tokenSource(), "app");
  const file = path.join(dataDir, "secrets", "claude-oauth-token");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  secrets.clearClaudeToken();
  assert.equal(secrets.readClaudeToken(), null);
  assert.equal(secrets.tokenSource(), null);
});
