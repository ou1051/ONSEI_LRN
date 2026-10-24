// AI 呼び出し（PDFからの概念抽出 / 音声説明の判定）
// - claude-code: ローカルの Claude Code CLI (`claude -p`) 経由。Pro/Max プランのログインで動き、追加料金なし
// - api: Claude API (ANTHROPIC_API_KEY) 経由。従量課金
import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const MOCK = process.env.ONSEI_MOCK === "1";
export const PROVIDER = MOCK
  ? "mock"
  : process.env.ONSEI_PROVIDER || (process.env.ANTHROPIC_API_KEY ? "api" : "claude-code");
const MODEL = process.env.ONSEI_MODEL || (PROVIDER === "api" ? "claude-opus-5-5" : "");
const EFFORT = process.env.ONSEI_EFFORT || "medium";
const USE_FALLBACKS = process.env.ONSEI_FALLBACKS !== "0";
const CLAUDE_BIN = process.env.ONSEI_CLAUDE_BIN || "claude";
const CLAUDE_TIMEOUT_MS = 5 * 60 * 1000;

const client = PROVIDER === "api" ? new Anthropic() : null;

export class AIError extends Error {}

// 構造化出力で JSON を返させ、パースして返す
function callJSON(req) {
  return PROVIDER === "api" ? callAPI(req) : callClaudeCode(req);
}

// Claude Code CLI をヘッドレスで実行する。PDF は Read ツールで読ませる
function callClaudeCode({ system, pdfPath, text, schema }) {
  const prompt = `まず Read ツールで ${path.basename(pdfPath)} を読んでください（このPDFが教材です）。\n\n${text}`;
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

  // API キーがあると従量課金側が使われるので外し、サブスクリプションのログインを使わせる
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;

  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, { cwd: path.dirname(pdfPath), env });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill(), CLAUDE_TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(
        new AIError(
          e.code === "ENOENT"
            ? "Claude Code が見つかりません。`npm install -g @anthropic-ai/claude-code` でインストールし、`claude` でログインしてください。"
            : `Claude Code を起動できませんでした: ${e.message}`,
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let res;
      try {
        res = JSON.parse(out);
      } catch {
        return reject(new AIError(`Claude Code の実行に失敗しました (code ${code}): ${(err || out).trim().slice(0, 300)}`));
      }
      if (res.is_error) {
        return reject(new AIError(`Claude Code エラー: ${String(res.result || res.subtype).slice(0, 300)}（未ログインなら \`claude\` を起動してログインしてください）`));
      }
      if (res.structured_output) return resolve(res.structured_output);
      const m = String(res.result || "").match(/\{[\s\S]*\}/);
      try {
        resolve(JSON.parse(m[0]));
      } catch {
        reject(new AIError("AIの応答を読み取れませんでした。もう一度お試しください。"));
      }
    });
    child.stdin.end(prompt);
  });
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
      throw new AIError("APIキーが無効です。ANTHROPIC_API_KEY を確認してください。");
    } else if (error instanceof Anthropic.RateLimitError) {
      throw new AIError("APIのレート制限に達しました。少し待ってから再度お試しください。");
    } else if (error instanceof Anthropic.APIError) {
      throw new AIError(`Claude API エラー (${error.status}): ${error.message}`);
    }
    throw error;
  }

  if (response.stop_reason === "refusal") {
    throw new AIError("この内容はAIが処理を拒否しました。別の内容でお試しください。");
  }
  if (response.stop_reason === "max_tokens") {
    throw new AIError("AIの応答が長すぎて途中で切れました。PDFを分割してお試しください。");
  }
  const output = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  try {
    return JSON.parse(output);
  } catch {
    throw new AIError("AIの応答を読み取れませんでした。もう一度お試しください。");
  }
}

// PDF はプロンプトキャッシュの対象にする（同じPDFで何度も判定するため）
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

const SYSTEM = `あなたは学習者の「説明による学習（ファインマン・テクニック）」を支える厳密で親切なチューターです。
教材は添付のPDFだけです。PDFに書かれている内容を正解の基準にし、PDFに無い事実を基準にしないでください。
出力はすべて日本語で書いてください。`;

export async function extractConcepts(pdfPath) {
  if (MOCK) return mockConcepts();
  return callJSON({
    system: SYSTEM,
    schema: CONCEPTS_SCHEMA,
    pdfPath,
    text: `このPDFを読み、学習者が自分の言葉で口頭説明できるようになるべき重要な概念を、PDFに出てくる順に5〜15個挙げてください。

各概念について:
- title: 概念名（短く）
- question: 学習者に投げかける問い（例:「〇〇とは何か、なぜ重要かを説明してください」）
- key_points: 正しい説明に含まれるべき要点（PDFの記述に基づく。2〜5個）
- pages: 該当ページ（例: "3-4"。不明なら空文字）

doc_title にはPDFの内容を表す短いタイトルを入れてください。`,
  });
}

const EVAL_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["correct", "incorrect"] },
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
    card_front: { type: "string" },
    card_back: { type: "string" },
  },
  required: ["verdict", "overall", "mistakes", "missing", "card_front", "card_back"],
  additionalProperties: false,
};

export async function evaluateExplanation({ pdfPath, concept, transcript, history }) {
  if (MOCK) return mockEvaluate(transcript, concept);

  const past = history.length
    ? history
        .map(
          (a, i) =>
            `【${i + 1}回目の説明】\n${a.transcript}\n【そのときのフィードバック】\n${a.result.overall}\n` +
            a.result.mistakes.map((m) => `- 「${m.quote}」: ${m.problem}`).join("\n"),
        )
        .join("\n\n")
    : "（今回が初回）";

  return callJSON({
    system: SYSTEM,
    schema: EVAL_SCHEMA,
    pdfPath,
    text: `学習者が次の概念をPDFを見ずに口頭で説明しました。説明は音声認識で文字起こししたものです。

# 概念
${concept.title}
問い: ${concept.question}
要点（PDFに基づく）:
${concept.key_points.map((k) => `- ${k}`).join("\n")}
該当ページ: ${concept.pages || "不明"}

# これまでの説明とフィードバック
${past}

# 今回の説明（文字起こし）
${transcript}

# 判定のしかた
- 音声認識による同音異義語の誤変換・言い淀み・語順の乱れは誤りとして扱わず、意図を汲んでください。
- verdict は、PDFの内容と矛盾する誤り（誤解）がなく、概念の核心となる要点を自分の言葉で押さえていれば "correct"。誤りがある、または核心が抜けていれば "incorrect"。細かい言い回しや網羅性の不足だけで "incorrect" にしないでください。
- mistakes: 間違っている箇所ごとに、quote に学習者の言葉をそのまま引用し、problem に「なぜ間違いか」をPDFの内容（可能ならページ）を根拠に説明し、correction に正しい理解を書いてください。誤りが無ければ空配列。
- missing: 核心なのに抜けている要点。無ければ空配列。
- overall: 2〜3文の総評。前回からの改善点があれば触れてください。答えを丸ごと教えるのではなく、学習者が次の説明で自分で直せるようにヒントを与えてください。
- card_front: フラッシュカードの表（問いの形）。
- card_back: verdict が "correct" のとき、学習者が今回話した言葉をできるだけそのまま使ったカードの裏。言い淀み・フィラー・誤変換だけを直し、簡潔に整えてください。学習者が言っていない内容を付け足さないでください。"incorrect" のときは空文字。`,
  });
}

// --- オフライン動作確認用のモック (ONSEI_MOCK=1) ---
function mockConcepts() {
  return {
    doc_title: "サンプル教材",
    concepts: [
      { title: "光合成", question: "光合成とは何かを説明してください", key_points: ["光エネルギーを使う", "二酸化炭素と水から糖を作る", "酸素が出る"], pages: "1" },
      { title: "呼吸", question: "細胞呼吸とは何かを説明してください", key_points: ["糖を分解してATPを得る", "酸素を使う"], pages: "2" },
    ],
  };
}

function mockEvaluate(transcript, concept) {
  const ok = transcript.length > 30;
  return {
    verdict: ok ? "correct" : "incorrect",
    overall: ok ? "核心を押さえた説明です。" : "説明が短く、要点が不足しています。",
    mistakes: ok ? [] : [{ quote: transcript.slice(0, 20), problem: "説明が短すぎます（モック判定）", correction: concept.key_points.join("、") }],
    missing: ok ? [] : concept.key_points,
    card_front: concept.question,
    card_back: ok ? transcript : "",
  };
}
