// Starts the real server (mock AI) and exercises the HTTP API end to end
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = tempDir();
let server;

// An old-format card (SM-2 fields) that must be migrated on startup
fs.writeFileSync(
  path.join(DATA, "db.json"),
  JSON.stringify({
    docs: [{ id: "old-doc", title: "Old deck", filename: "old.pdf" }],
    concepts: [{ id: "old-c", docId: "old-doc", order: 0, status: "mastered", attempts: 1, title: "Old", question: "Q?", key_points: ["k"], pages: "" }],
    attempts: [],
    cards: [{ id: "old-card", conceptId: "old-c", docId: "old-doc", front: "Q?", back: "A", interval: 6, ease: 2.5, reps: 2, due: "2020-01-01T00:00:00.000Z", updatedAt: "2019-12-26T00:00:00.000Z" }],
    reviews: [],
  }),
);

function startServer(port = PORT) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), ONSEI_MOCK: "1", ONSEI_DATA_DIR: DATA },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return child;
}

async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
}

async function call(method, url, body) {
  const init = { method, headers: {} };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + url, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text, type: res.headers.get("content-type") };
}

const pdfForm = (name = "notes.pdf", type = "application/pdf") => {
  const f = new FormData();
  f.append("lang", "en");
  f.append("pdf", new Blob(["%PDF-1.4\n%%EOF\n"], { type }), name);
  return f;
};

before(async () => {
  server = startServer();
  await waitUp();
});
after(() => server.kill());

test("health and static files", async () => {
  assert.deepEqual((await call("GET", "/api/health")).json, { ok: true, app: "onsei-lrn", provider: "mock" });
  const page = await call("GET", "/");
  assert.match(page.text, /<title>ONSEI_LRN<\/title>/);
  assert.match((await call("GET", "/keys.js")).type, /javascript/);
});

test("old cards are migrated to the forgetting-curve scheduler on startup", async () => {
  const cards = (await call("GET", "/api/cards")).json;
  const old = cards.find((c) => c.id === "old-card");
  assert.equal(old.stability, 6);
  assert.equal(old.state, "review");
  assert.ok(old.memory.retention > 0 && old.memory.retention < 1);
  assert.deepEqual(Object.keys(old.intervals), ["again", "hard", "good", "easy"]);
});

test("upload validation", async () => {
  assert.equal((await call("POST", "/api/docs", pdfForm("x.txt", "text/plain"))).status, 400);
  assert.equal((await call("POST", "/api/docs", new FormData())).status, 400);
});

test("full learning loop: explain wrong, explain right, card, review, undo", async () => {
  const doc = (await call("POST", "/api/docs", pdfForm())).json;
  assert.ok(doc.id);
  const detail = (await call("GET", `/api/docs/${doc.id}`)).json;
  assert.equal(detail.concepts.length, 2);
  assert.ok(detail.concepts.every((c) => c.status === "new"));
  const cid = detail.concepts[0].id;

  assert.equal((await call("POST", `/api/concepts/${cid}/attempts`, { transcript: "   " })).status, 400);

  const wrong = (await call("POST", `/api/concepts/${cid}/attempts`, { transcript: "short", durationMs: 60000 })).json;
  assert.equal(wrong.attempt.result.verdict, "incorrect");
  assert.equal(wrong.concept.status, "learning");
  assert.equal(wrong.card, null);
  assert.equal(wrong.attempt.durationMs, 60000);

  const right = (await call("POST", `/api/concepts/${cid}/attempts`, {
    transcript: "Photosynthesis uses light energy to turn carbon dioxide and water into sugar, releasing oxygen.",
    durationMs: 10 ** 9,
  })).json;
  assert.equal(right.attempt.result.verdict, "correct");
  assert.equal(right.attempt.durationMs, 30 * 60 * 1000, "capped at 30 minutes");
  assert.equal(right.concept.status, "mastered");
  assert.equal(right.round, 2);
  const card = right.card;
  assert.match(card.back, /Photosynthesis/);
  // Correct on the second attempt = "hard": due tomorrow at the earliest
  assert.equal(card.state, "review");
  assert.ok(Date.parse(card.due) > Date.now());

  // Not due yet, so not in the due queue
  assert.ok(!(await call("GET", "/api/cards?due=1")).json.some((c) => c.id === card.id));

  assert.equal((await call("POST", `/api/cards/${card.id}/review`, { rating: "meh" })).status, 400);
  const reviewed = (await call("POST", `/api/cards/${card.id}/review`, { rating: "again", durationMs: 9000 })).json;
  assert.equal(reviewed.state, "relearning");
  assert.equal(reviewed.reps, card.reps + 1);
  const undone = (await call("POST", "/api/reviews/undo")).json;
  assert.equal(undone.due, card.due);
  assert.equal(undone.state, card.state);
  assert.equal(undone.reps, card.reps);
  assert.equal((await call("POST", "/api/reviews/undo")).status, 404, "explanation reviews are not undoable");

  // Edit the card
  const edited = (await call("PUT", `/api/cards/${card.id}`, { front: "F", back: "B", due: "hacked" })).json;
  assert.equal(edited.front, "F");
  assert.equal(edited.due, card.due, "only front/back can be edited");

  // Stats and calendar activity
  const stats = (await call("GET", "/api/stats?days=7")).json;
  assert.equal(stats.series.length, 7);
  assert.ok(stats.today.explained >= 2);
  assert.equal(stats.today.reviewed, 0, "the undone review is gone; explanations are not reviews");
  const act = (await call("GET", "/api/activity")).json;
  assert.equal(act.reviews.length, 0);

  // Anki export
  const exp = await call("GET", `/api/export/anki.txt?docId=${doc.id}`);
  assert.match(exp.type, /text\/plain/);
  assert.match(exp.text, /^#separator:tab\n#html:true\n/);
  assert.match(exp.text, /\nF\tB\tONSEI_LRN::Sample material\tonsei_lrn\n/);

  // Deleting the deck removes its concepts, attempts and cards
  assert.equal((await call("DELETE", `/api/docs/${doc.id}`)).status, 200);
  assert.equal((await call("GET", `/api/docs/${doc.id}`)).status, 404);
  assert.ok(!(await call("GET", "/api/cards")).json.some((c) => c.docId === doc.id));
  assert.ok(!(await call("GET", "/api/concepts")).json.some((c) => c.docId === doc.id));
});

test("settings: validation, retention reschedules review cards", async () => {
  assert.equal((await call("PUT", "/api/settings", { retention: 2 })).status, 400);
  assert.equal((await call("PUT", "/api/settings", { keys: { again: "Digit2" } })).status, 400);
  const before = (await call("GET", "/api/cards")).json.find((c) => c.id === "old-card").due;
  const s = (await call("PUT", "/api/settings", { retention: 0.8 })).json;
  assert.equal(s.retention, 0.8);
  const afterDue = (await call("GET", "/api/cards")).json.find((c) => c.id === "old-card").due;
  assert.ok(Date.parse(afterDue) > Date.parse(before), "lower retention -> later review");
  assert.equal((await call("GET", "/api/settings")).json.retention, 0.8, "persisted");
});

test("reminders and calendar feed", async () => {
  const r = (await call("GET", "/api/reminders")).json;
  assert.equal(r.supported, process.platform === "darwin");
  if (process.platform !== "darwin") {
    const sync = await call("POST", "/api/reminders/sync");
    assert.equal(sync.status, 502);
    assert.match(sync.json.error, /only available on macOS/);
  }
  const ics = await call("GET", "/calendar.ics");
  assert.match(ics.type, /text\/calendar/);
  assert.match(ics.text, /^BEGIN:VCALENDAR\r\n/);
});

test("requests from other websites and other host names are refused", async () => {
  const post = (headers) => fetch(`${BASE}/api/reviews/undo`, { method: "POST", headers }).then((r) => r.status);
  assert.equal(await post({ Origin: "https://evil.example" }), 403);
  assert.equal(await post({ "Sec-Fetch-Site": "cross-site" }), 403);
  assert.equal(await post({ Origin: `http://localhost:${PORT}` }), 404, "same origin passes (nothing to undo)");
  assert.equal(await post({ Origin: `http://127.0.0.1:${PORT}` }), 404);
  const { request } = await import("node:http");
  const status = await new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: PORT, path: "/api/settings", headers: { Host: `attacker.example:${PORT}` } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 403, "DNS-rebinding host name refused");
});

test("a deck whose PDF file is missing gives 404, not a server error", async () => {
  assert.equal((await call("GET", "/api/docs/old-doc/pdf")).status, 404);
});

test("unknown ids give 404", async () => {
  for (const [m, u, b] of [
    ["GET", "/api/docs/nope"],
    ["GET", "/api/concepts/nope"],
    ["POST", "/api/concepts/nope/attempts", { transcript: "x" }],
    ["POST", "/api/cards/nope/review", { rating: "good" }],
    ["PUT", "/api/cards/nope", { front: "x" }],
    ["GET", "/api/docs/nope/pdf"],
  ]) {
    assert.equal((await call(m, u, b)).status, 404, `${m} ${u}`);
  }
});

test("a second copy on the same port exits cleanly instead of crashing", async () => {
  const second = startServer();
  const code = await new Promise((resolve) => second.on("exit", resolve));
  assert.equal(code, 0);
});

test("data survives a restart", async () => {
  server.kill();
  await new Promise((r) => server.on("exit", r));
  server = startServer();
  await waitUp();
  assert.equal((await call("GET", "/api/settings")).json.retention, 0.8);
  assert.ok((await call("GET", "/api/cards")).json.some((c) => c.id === "old-card"));
});
