#!/usr/bin/env node
// Stand-in for the Claude Code CLI in tests. Behavior is chosen with FAKE_CLAUDE_MODE.
import fs from "node:fs";
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  if (process.env.FAKE_CLAUDE_LOG) {
    fs.writeFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, cwd: process.cwd(), apiKey: process.env.ANTHROPIC_API_KEY ?? null, prompt: input }));
  }
  const schema = JSON.parse(args[args.indexOf("--json-schema") + 1]);
  const out = schema.properties.doc_title
    ? { doc_title: "Fake deck", concepts: [{ title: "A", question: "What is A?", key_points: ["x", "y"], pages: "1" }] }
    : { verdict: "correct", score: 120, covered: [true], overall: "Good.", mistakes: [], missing: [], jargon: ["a", "b", "c", "d"], card_front: "What is A?", card_back: "A is x" };
  switch (process.env.FAKE_CLAUDE_MODE) {
    case "structured":
      return console.log(JSON.stringify({ type: "result", is_error: false, result: "", structured_output: out }));
    case "error":
      return console.log(JSON.stringify({ type: "result", is_error: true, result: "Invalid API key · Please run /login" }));
    case "garbage":
      return console.log("not json at all");
    case "noresult":
      return console.log(JSON.stringify({ type: "result", is_error: false, result: "I could not do it" }));
    default:
      return console.log(JSON.stringify({ type: "result", is_error: false, result: "```json\n" + JSON.stringify(out) + "\n```" }));
  }
});
