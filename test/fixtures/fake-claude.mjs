#!/usr/bin/env node
// Stand-in for the Claude Code CLI in tests. Behavior is chosen with FAKE_CLAUDE_MODE.
import fs from "node:fs";

const GOOD_TOKEN = "sk-ant-oat01-good-token-for-tests";

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null;
  if (process.env.FAKE_CLAUDE_LOG) {
    fs.writeFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, cwd: process.cwd(), apiKey: process.env.ANTHROPIC_API_KEY ?? null, token, prompt: input }));
  }
  const schemaArg = args.indexOf("--json-schema");
  const schema = schemaArg >= 0 ? JSON.parse(args[schemaArg + 1]) : null;
  const out = !schema
    ? "OK"
    : schema.properties.doc_title
      ? { doc_title: "Fake deck", concepts: [{ title: "A", question: "What is A?", key_points: ["x", "y"], pages: "1" }] }
      : { verdict: "correct", score: 120, covered: [true], overall: "Good.", mistakes: [], missing: [], jargon: ["a", "b", "c", "d"], card_front: "What is A?", card_back: "A is x" };
  const ok = (value) =>
    console.log(JSON.stringify({ type: "result", is_error: false, result: typeof value === "string" ? value : "", structured_output: typeof value === "string" ? undefined : value }));
  const notLoggedIn = () => {
    console.log(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" }));
    process.exitCode = 1;
  };

  switch (process.env.FAKE_CLAUDE_MODE) {
    case "structured":
      return ok(out);
    case "error":
      return console.log(JSON.stringify({ type: "result", is_error: true, result: "Invalid API key · Please run /login" }));
    case "notloggedin":
      return notLoggedIn();
    case "plaintext-auth":
      // Some failures print plain text instead of JSON
      process.stdout.write("Invalid API key · Please run /login\n");
      process.exitCode = 1;
      return;
    case "usage":
      return console.log(JSON.stringify({ type: "result", is_error: true, result: "Claude AI usage limit reached|1767225600" }));
    case "garbage":
      return console.log("not json at all");
    case "noresult":
      return console.log(JSON.stringify({ type: "result", is_error: false, result: "I could not do it" }));
    case "needs-token":
      // Like a launchd-started CLI that cannot read the Keychain: only a valid token works
      if (token === GOOD_TOKEN) return ok(out);
      if (token) {
        console.log(JSON.stringify({ type: "result", is_error: true, result: 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid bearer token"}}' }));
        process.exitCode = 1;
        return;
      }
      return notLoggedIn();
    default:
      if (!schema) return ok(out);
      return console.log(JSON.stringify({ type: "result", is_error: false, result: "```json\n" + JSON.stringify(out) + "\n```" }));
  }
});
