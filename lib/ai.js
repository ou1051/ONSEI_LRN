// AI calls: extract concepts from a PDF, and grade a spoken explanation.
// - claude-code: runs the local Claude Code CLI (`claude -p`). Uses your Claude Pro/Max login, no extra cost.
// - api: calls the Claude API with ANTHROPIC_API_KEY. Pay-as-you-go.
import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readClaudeToken } from "./secrets.js";

export const MOCK = process.env.ONSEI_MOCK === "1";
export const PROVIDER = MOCK
  ? "mock"
  : process.env.ONSEI_PROVIDER || (process.env.ANTHROPIC_API_KEY ? "api" : "claude-code");
const MODEL = process.env.ONSEI_MODEL || (PROVIDER === "api" ? "claude-opus-5-5" : "");
const EFFORT = process.env.ONSEI_EFFORT || "medium";
const USE_FALLBACKS = process.env.ONSEI_FALLBACKS !== "0";
const CLAUDE_BIN = process.env.ONSEI_CLAUDE_BIN || "claude";
const CLAUDE_TIMEOUT_MS = 10 * 60 * 1000;

export const LANGUAGES = { en: "English", ja: "Japanese" };
const langName = (lang) => LANGUAGES[lang] || LANGUAGES.en;

const client = PROVIDER === "api" ? new Anthropic() : null;

export class AIError extends Error {}

// Ask for structured output and return the parsed JSON object
function callJSON(req) {
  return PROVIDER === "api" ? callAPI(req) : callClaudeCode(req);
}

// Problems you can fix, recognized in Claude Code's output
const CLAUDE_PROBLEMS = [
  {
    code: "auth",
    re: /not logged in|please run \/login|\/login|invalid api key|invalid bearer token|authentication[_ ]error|oauth token (has )?expired|login expired|401\b|unauthori[sz]ed|credential is only authorized/i,
    message:
      "Claude Code could not use your Claude login from the background app. Connect it once: Settings → Claude connection " +
      "(run `claude setup-token` in Terminal and paste the token).",
  },
  {
    code: "usage_limit",
    re: /usage limit|limit reached|rate limit|429\b|overloaded|529\b/i,
    message: "Your Claude plan's usage limit was reached, or Claude is busy. Wait a while and try again.",
  },
];

export const aiStatus = { checkedAt: null, ok: null, code: null, message: "", detail: "" };

function record(ok, code = null, message = "", detail = "") {
  Object.assign(aiStatus, { checkedAt: new Date().toISOString(), ok, code, message, detail });
}

function claudeError(raw, fallback) {
  const text = String(raw || "").trim();
  const problem = CLAUDE_PROBLEMS.find((p) => p.re.test(text));
  const message = problem ? problem.message : `${fallback}${text ? `: ${text.slice(0, 300)}` : ""}`;
  record(false, problem?.code || "error", message, text.slice(0, 500));
  return Object.assign(new AIError(message), { code: problem?.code || "error", detail: text.slice(0, 500) });
}

// Runs `claude -p` and resolves with its JSON result object
function runClaude(args, prompt, cwd) {
  // With an API key present, Claude Code would bill the API instead; remove it so the subscription is used.
  // A token saved in Settings (from `claude setup-token`) takes the place of the Keychain login, which
  // background processes started by launchd often cannot read.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  const token = readClaudeToken();
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;

  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, { cwd, env });
    let out = "";
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, CLAUDE_TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      const message =
        e.code === "ENOENT"
          ? "Claude Code was not found. Run the installer again, or install it with `npm install -g @anthropic-ai/claude-code`."
          : `Could not start Claude Code: ${e.message}`;
      record(false, "missing", message, e.message);
      reject(Object.assign(new AIError(message), { code: "missing" }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new AIError("Claude Code took too long (over 10 minutes). Try a shorter PDF."));
      let res;
      try {
        res = JSON.parse(out);
      } catch {
        return reject(claudeError(`${err}\n${out}`, `Claude Code failed (exit code ${code})`));
      }
      if (res.is_error) return reject(claudeError(`${res.result || ""} ${res.subtype || ""} ${err}`, "Claude Code error"));
      record(true);
      resolve(res);
    });
    child.stdin.end(prompt);
  });
}

// Run Claude Code headless; it reads the PDF with its Read tool
async function callClaudeCode({ system, pdfPath, text, schema }) {
  const prompt =
    `First, use the Read tool to read ${path.basename(pdfPath)} (this PDF is the study material). ` +
    `Read every page; for a long PDF, read it in page ranges until you have covered the whole document.\n\n${text}`;
  const args = [
    "-p",
    "--output-format", "json",
    "--json-schema", JSON.stringify(schema),
    "--system-prompt", system,
    "--tools", "Read",
    "--no-session-persistence",
    "--strict-mcp-config",
  ];
  if (MODEL) args.push("--model", MODEL);

  const res = await runClaude(args, prompt, path.dirname(pdfPath));
  if (res.structured_output) return res.structured_output;
  const m = String(res.result || "").match(/\{[\s\S]*\}/);
  try {
    return JSON.parse(m[0]);
  } catch {
    throw new AIError("Could not read the AI's response. Please try again.");
  }
}

// A tiny request that checks Claude Code can reach Claude with your login
export async function testConnection() {
  if (PROVIDER === "mock") {
    record(true);
    return aiStatus;
  }
  if (PROVIDER === "api") {
    try {
      await client.messages.create({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "Reply with OK." }] });
      record(true);
    } catch (error) {
      record(false, error instanceof Anthropic.AuthenticationError ? "auth" : "error", `Claude API error: ${error.message}`);
    }
    return aiStatus;
  }
  const args = ["-p", "--output-format", "json", "--tools", "", "--no-session-persistence", "--strict-mcp-config"];
  if (MODEL) args.push("--model", MODEL);
  try {
    await runClaude(args, "Reply with the single word OK.", os.tmpdir());
  } catch {
    // runClaude recorded the problem in aiStatus
  }
  return aiStatus;
}

async function callAPI({ system, pdfPath, text, schema }) {
  const params = {
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: EFFORT, format: { type: "json_schema", schema } },
    system,
    messages: [{ role: "user", content: [pdfBlock(fs.readFileSync(pdfPath).toString("base64")), { type: "text", text }] }],
  };

  let response;
  try {
    response = USE_FALLBACKS
      ? await client.beta.messages.create({
          ...params,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        })
      : await client.messages.create(params);
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      record(false, "auth", "Invalid API key. Check ANTHROPIC_API_KEY.");
      throw new AIError("Invalid API key. Check ANTHROPIC_API_KEY.");
    } else if (error instanceof Anthropic.RateLimitError) {
      throw new AIError("API rate limit reached. Wait a moment and try again.");
    } else if (error instanceof Anthropic.APIError) {
      throw new AIError(`Claude API error (${error.status}): ${error.message}`);
    }
    throw error;
  }

  if (response.stop_reason === "refusal") {
    throw new AIError("The AI declined to process this content. Try different material.");
  }
  if (response.stop_reason === "max_tokens") {
    throw new AIError("The AI's response was cut off. Try splitting the PDF into smaller parts.");
  }
  const output = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  try {
    return JSON.parse(output);
  } catch {
    throw new AIError("Could not read the AI's response. Please try again.");
  }
}

// The PDF is prompt-cached, since the same PDF is sent for every grading request
const pdfBlock = (pdfBase64) => ({
  type: "document",
  source: { type: "base64", media_type: "application/pdf", data: pdfBase64 },
  cache_control: { type: "ephemeral" },
});

const strArray = { type: "array", items: { type: "string" } };

const CONCEPTS_SCHEMA = {
  type: "object",
  properties: {
    doc_title: { type: "string" },
    concepts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          question: { type: "string" },
          key_points: strArray,
          pages: { type: "string" },
        },
        required: ["title", "question", "key_points", "pages"],
        additionalProperties: false,
      },
    },
  },
  required: ["doc_title", "concepts"],
  additionalProperties: false,
};

// Kept identical across requests so the API prompt cache stays valid
const SYSTEM = `You are a rigorous but encouraging tutor supporting "learning by explaining" (the Feynman technique).
The attached PDF is the only study material. Treat what the PDF says as the standard of correctness, and do not judge against facts that are not in the PDF.`;

export async function extractConcepts(pdfPath, lang) {
  if (MOCK) return mockConcepts();
  return callJSON({
    system: SYSTEM,
    schema: CONCEPTS_SCHEMA,
    pdfPath,
    text: `Read this PDF and list the 5-15 most important concepts a learner should be able to explain out loud in their own words, in the order they appear in the PDF.

For each concept:
- title: the concept's name (short)
- question: a prompt for the learner (e.g. "Explain what X is and why it matters.")
- key_points: the points a correct explanation must cover, based on the PDF (2-5 items)
- pages: the relevant pages (e.g. "3-4"; empty string if unknown)

Set doc_title to a short title describing the PDF.

Write every text field in ${langName(lang)}, even if the PDF is in another language.`,
  });
}

const EVAL_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["correct", "incorrect"] },
    score: { type: "integer" },
    covered: { type: "array", items: { type: "boolean" } },
    overall: { type: "string" },
    mistakes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          quote: { type: "string" },
          problem: { type: "string" },
          correction: { type: "string" },
        },
        required: ["quote", "problem", "correction"],
        additionalProperties: false,
      },
    },
    missing: strArray,
    jargon: strArray,
    card_front: { type: "string" },
    card_back: { type: "string" },
  },
  required: ["verdict", "score", "covered", "overall", "mistakes", "missing", "jargon", "card_front", "card_back"],
  additionalProperties: false,
};

export async function evaluateExplanation(args) {
  return normalizeEvaluation(await gradeExplanation(args), args.concept);
}

// Guards against slightly off model output (wrong lengths, out-of-range numbers)
export function normalizeEvaluation(r, concept) {
  const arr = (x) => (Array.isArray(x) ? x.filter((v) => typeof v === "string") : []);
  const n = concept.key_points.length;
  const covered = Array.isArray(r.covered) ? r.covered.slice(0, n).map(Boolean) : [];
  while (covered.length < n) covered.push(false);
  const score = Number.isFinite(r.score) ? Math.round(Math.min(100, Math.max(0, r.score))) : null;
  const verdict = r.verdict === "correct" ? "correct" : "incorrect";
  return {
    verdict,
    score,
    covered,
    overall: String(r.overall || ""),
    mistakes: (Array.isArray(r.mistakes) ? r.mistakes : [])
      .filter((m) => m && typeof m === "object")
      .map((m) => ({ quote: String(m.quote || ""), problem: String(m.problem || ""), correction: String(m.correction || "") })),
    missing: arr(r.missing),
    jargon: arr(r.jargon).slice(0, 3),
    card_front: String(r.card_front || concept.question),
    card_back: verdict === "correct" ? String(r.card_back || "") : "",
  };
}

async function gradeExplanation({ pdfPath, concept, transcript, history, lang }) {
  if (MOCK) return mockEvaluate(transcript, concept);

  const past = history.length
    ? history
        .map(
          (a, i) =>
            `[Attempt ${i + 1}]\n${a.transcript}\n[Feedback given]\n${a.result.overall}\n` +
            a.result.mistakes.map((m) => `- "${m.quote}": ${m.problem}`).join("\n"),
        )
        .join("\n\n")
    : "(This is the first attempt.)";

  return callJSON({
    system: SYSTEM,
    schema: EVAL_SCHEMA,
    pdfPath,
    text: `The learner explained the concept below out loud without looking at the PDF. The explanation is a speech-recognition transcript.

# Concept
${concept.title}
Question: ${concept.question}
Key points (from the PDF):
${concept.key_points.map((k, i) => `${i + 1}. ${k}`).join("\n")}
Pages: ${concept.pages || "unknown"}

# Previous attempts and feedback
${past}

# This attempt (transcript)
${transcript}

# How to grade
- Do not count speech-recognition errors (misheard or homophone words), filler words, false starts, or awkward word order as mistakes; infer what the learner meant.
- verdict is "correct" when the explanation has no misconceptions that contradict the PDF and covers the core of the concept in the learner's own words. It is "incorrect" when there is a misconception or the core is missing. Do not mark it "incorrect" only for wording or for leaving out minor details.
- mistakes: one entry per wrong statement. quote = the learner's own words, verbatim; problem = why it is wrong, grounded in the PDF (cite the page when possible); correction = the correct understanding. Empty array if there are none.
- score: 0-100 for how well the explanation shows real understanding (accuracy first, then coverage of the key points, then clarity). Roughly: 90+ excellent, 70-89 correct with small gaps, 50-69 partly right, below 50 major misconceptions or mostly missing.
- covered: one boolean per key point, in the order listed above (exactly ${concept.key_points.length} items): true if the explanation conveys that point correctly.
- missing: core points that were left out. Empty array if none.
- jargon: technical terms the learner used without explaining them in plain words (the Feynman technique asks for simple language a 12-year-old could follow). At most 3; empty array if none. This does not affect the verdict.
- overall: 2-3 sentences of overall feedback. Mention improvements since the previous attempt, if any. Do not hand over the full answer; give hints so the learner can fix the explanation themselves next time.
- card_front: the front of a flashcard, phrased as a question.
- card_back: when verdict is "correct", the back of the flashcard using the learner's own words from this attempt as closely as possible. Only remove fillers and fix speech-recognition errors, and tighten it slightly. Do not add anything the learner did not say. Empty string when verdict is "incorrect".

Write every text field in ${langName(lang)}, except "quote", which must stay verbatim.`,
  });
}

// --- Mock responses for trying the UI without AI (ONSEI_MOCK=1) ---
function mockConcepts() {
  return {
    doc_title: "Sample material",
    concepts: [
      { title: "Photosynthesis", question: "Explain what photosynthesis is.", key_points: ["Uses light energy", "Makes sugar from carbon dioxide and water", "Releases oxygen"], pages: "1" },
      { title: "Cellular respiration", question: "Explain what cellular respiration is.", key_points: ["Breaks down sugar to make ATP", "Uses oxygen"], pages: "2" },
    ],
  };
}

function mockEvaluate(transcript, concept) {
  const ok = transcript.length > 30;
  return {
    verdict: ok ? "correct" : "incorrect",
    score: ok ? 85 : 30,
    covered: concept.key_points.map(() => ok),
    overall: ok ? "You covered the core of the concept." : "The explanation is too short and misses key points.",
    mistakes: ok ? [] : [{ quote: transcript.slice(0, 40), problem: "Too short to judge (mock grading).", correction: concept.key_points.join("; ") }],
    missing: ok ? [] : concept.key_points,
    jargon: [],
    card_front: concept.question,
    card_back: ok ? transcript : "",
  };
}
