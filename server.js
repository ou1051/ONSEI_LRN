import express from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, save, newId, now, PDF_DIR } from "./lib/db.js";
import { extractConcepts, evaluateExplanation, testConnection, aiStatus, AIError, PROVIDER, LANGUAGES } from "./lib/ai.js";
import { saveClaudeToken, clearClaudeToken, tokenSource } from "./lib/secrets.js";
import { schedule, preview, describeInterval, memoryInfo, migrateCard, rescheduleDue, gradeFromAttempts, RATINGS } from "./lib/srs.js";
import { getSettings, updateSettings } from "./lib/settings.js";
import * as reminders from "./lib/reminders.js";
import * as progress from "./lib/progress.js";
import { computeStats } from "./lib/stats.js";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";

const app = express();

// The app listens only on this computer, but web pages you visit could still send requests to
// localhost. Refuse requests addressed to another host name (DNS rebinding) and changes that come
// from another website (cross-site request forgery).
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", HOST].map((h) => `${h}:${PORT}`));
app.use((req, res, next) => {
  if (!ALLOWED_HOSTS.has(req.headers.host)) return res.status(403).json({ error: "Forbidden host" });
  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.origin;
    const crossSite = req.headers["sec-fetch-site"] === "cross-site";
    if (crossSite || (origin && !ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, "")))) {
      return res.status(403).json({ error: "Requests from other websites are not allowed" });
    }
  }
  next();
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(APP_DIR, "public")));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 32 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype === "application/pdf"),
});

const pdfPath = (doc) => path.join(PDF_DIR, `${doc.id}.pdf`);
const pickLang = (lang) => (lang in LANGUAGES ? lang : "en");

const find = (list, id, res, label) => {
  const item = list.find((x) => x.id === id);
  if (!item) res.status(404).json({ error: `${label} not found` });
  return item;
};

// Cards saved by the earlier scheduler get forgetting-curve fields
if (db.cards.some((c) => !c.stability)) {
  db.cards.forEach(migrateCard);
  save();
}

// Time spent, as reported by the browser, capped so a forgotten open tab does not count
const duration = (ms, capMin) => Math.round(Math.min(Math.max(Number(ms) || 0, 0), capMin * 60 * 1000));

// Card fields a review changes, kept on the review so it can be undone
const SCHEDULE_FIELDS = ["due", "stability", "difficulty", "state", "lastReview", "reps", "lapses"];
const snapshot = (card) => Object.fromEntries(SCHEDULE_FIELDS.map((f) => [f, card[f] ?? null]));

const withCardInfo = (card) => {
  const next = preview(card, getSettings().retention);
  return {
    ...card,
    intervals: Object.fromEntries(RATINGS.map((r) => [r, describeInterval(next[r].days)])),
    memory: memoryInfo(card),
  };
};

app.get("/api/health", (_req, res) => res.json({ ok: true, app: "onsei-lrn", provider: PROVIDER }));

// --- Decks (PDFs) ---
app.get("/api/docs", (_req, res) => {
  res.json(
    db.docs.map((d) => {
      const cs = db.concepts.filter((c) => c.docId === d.id);
      return {
        ...d,
        total: cs.length,
        mastered: cs.filter((c) => c.status === "mastered").length,
        learning: cs.filter((c) => c.status === "learning").length,
        due: db.cards.filter((c) => c.docId === d.id && Date.parse(c.due) <= Date.now()).length,
      };
    }),
  );
});

app.post("/api/docs", upload.single("pdf"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Please choose a PDF file." });
  const doc = { id: newId(), filename: req.file.originalname, title: "", createdAt: now() };
  fs.writeFileSync(pdfPath(doc), req.file.buffer);
  try {
    const result = await extractConcepts(pdfPath(doc), pickLang(req.body?.lang));
    if (!result.concepts?.length) throw new AIError("No concepts could be found in this PDF.");
    doc.title = result.doc_title || doc.filename;
    db.docs.push(doc);
    result.concepts.forEach((c, i) =>
      db.concepts.push({ id: newId(), docId: doc.id, order: i, status: "new", attempts: 0, ...c, createdAt: now() }),
    );
    save();
    res.json(doc);
  } catch (err) {
    fs.rmSync(pdfPath(doc), { force: true });
    sendError(res, err);
  }
});

app.get("/api/docs/:id", (req, res) => {
  const doc = find(db.docs, req.params.id, res, "Deck");
  if (!doc) return;
  const concepts = db.concepts.filter((c) => c.docId === doc.id).sort((a, b) => a.order - b.order);
  res.json({ ...doc, concepts });
});

app.get("/api/docs/:id/pdf", (req, res) => {
  const doc = find(db.docs, req.params.id, res, "Deck");
  if (doc) res.sendFile(pdfPath(doc), (err) => err && !res.headersSent && res.status(404).json({ error: "PDF file not found" }));
});

app.delete("/api/docs/:id", (req, res) => {
  const doc = find(db.docs, req.params.id, res, "Deck");
  if (!doc) return;
  const keep = (x) => x.docId !== doc.id;
  db.docs = db.docs.filter((d) => d.id !== doc.id);
  db.concepts = db.concepts.filter(keep);
  db.attempts = db.attempts.filter(keep);
  db.cards = db.cards.filter(keep);
  db.reviews = db.reviews.filter(keep);
  fs.rmSync(pdfPath(doc), { force: true });
  save();
  reminders.scheduleSync();
  res.json({ ok: true });
});

// --- Concepts and explanation attempts ---
app.get("/api/concepts", (_req, res) => {
  const titles = Object.fromEntries(db.docs.map((d) => [d.id, d.title]));
  res.json(db.concepts.map((c) => ({ ...c, docTitle: titles[c.docId] })));
});

app.get("/api/concepts/:id", (req, res) => {
  const concept = find(db.concepts, req.params.id, res, "Concept");
  if (!concept) return;
  const doc = db.docs.find((d) => d.id === concept.docId);
  const attempts = db.attempts.filter((a) => a.conceptId === concept.id);
  const card = db.cards.find((c) => c.conceptId === concept.id) || null;
  res.json({ ...concept, docTitle: doc?.title, attemptsList: attempts, card });
});

app.post("/api/concepts/:id/attempts", async (req, res) => {
  const concept = find(db.concepts, req.params.id, res, "Concept");
  if (!concept) return;
  const transcript = String(req.body?.transcript || "").trim();
  if (!transcript) return res.status(400).json({ error: "The explanation is empty." });
  const doc = db.docs.find((d) => d.id === concept.docId);

  // Only the current "until it's correct" cycle is sent to the AI as history
  const all = db.attempts.filter((a) => a.conceptId === concept.id);
  const lastCorrect = all.findLastIndex((a) => a.result.verdict === "correct");
  const history = all.slice(lastCorrect + 1);

  try {
    const result = await evaluateExplanation({
      pdfPath: pdfPath(doc),
      concept,
      transcript,
      history,
      lang: pickLang(req.body?.lang),
    });
    const attempt = {
      id: newId(),
      conceptId: concept.id,
      docId: doc.id,
      transcript,
      result,
      durationMs: duration(req.body?.durationMs, 30),
      createdAt: now(),
    };
    db.attempts.push(attempt);
    concept.attempts += 1;

    let card = db.cards.find((c) => c.conceptId === concept.id) || null;
    if (result.verdict === "correct") {
      concept.status = "mastered";
      concept.masteredAt = now();
      // Explaining it correctly counts as a review, graded by how many attempts it took
      const grade = gradeFromAttempts(history.length + 1);
      const fields = { front: result.card_front, back: result.card_back || transcript, updatedAt: now() };
      if (card) {
        Object.assign(card, fields, schedule(card, grade, getSettings().retention));
      } else {
        const id = newId();
        card = { id, conceptId: concept.id, docId: doc.id, createdAt: now(), ...fields, ...schedule({}, grade, getSettings().retention, Date.now(), id) };
        db.cards.push(card);
      }
      db.reviews.push({ id: newId(), cardId: card.id, docId: card.docId, rating: grade, source: "explanation", createdAt: now() });
      reminders.scheduleSync();
    } else {
      concept.status = "learning";
    }
    save();
    progress.noteActivity();
    res.json({ attempt, concept, card: card && withCardInfo(card), round: history.length + 1 });
  } catch (err) {
    sendError(res, err);
  }
});

// --- Flashcards ---
app.get("/api/cards", (req, res) => {
  let cards = db.cards;
  if (req.query.docId) cards = cards.filter((c) => c.docId === req.query.docId);
  if (req.query.due === "1") cards = cards.filter((c) => Date.parse(c.due) <= Date.now());
  res.json(cards.sort((a, b) => Date.parse(a.due) - Date.parse(b.due)).map(withCardInfo));
});

app.put("/api/cards/:id", (req, res) => {
  const card = find(db.cards, req.params.id, res, "Card");
  if (!card) return;
  for (const key of ["front", "back"]) if (typeof req.body?.[key] === "string") card[key] = req.body[key];
  card.updatedAt = now();
  save();
  res.json(withCardInfo(card));
});

app.delete("/api/cards/:id", (req, res) => {
  db.cards = db.cards.filter((c) => c.id !== req.params.id);
  save();
  reminders.scheduleSync();
  res.json({ ok: true });
});

app.post("/api/cards/:id/review", (req, res) => {
  const card = find(db.cards, req.params.id, res, "Card");
  if (!card) return;
  const rating = req.body?.rating;
  if (!RATINGS.includes(rating)) return res.status(400).json({ error: "Invalid rating." });
  const prev = snapshot(card);
  Object.assign(card, schedule(card, rating, getSettings().retention));
  db.reviews.push({
    id: newId(),
    cardId: card.id,
    docId: card.docId,
    rating,
    prev,
    durationMs: duration(req.body?.durationMs, 5),
    createdAt: now(),
  });
  save();
  reminders.scheduleSync();
  progress.noteActivity();
  res.json(withCardInfo(card));
});

// Undoes the most recent review from the Review screen
app.post("/api/reviews/undo", (_req, res) => {
  const i = db.reviews.findLastIndex((r) => r.prev);
  const review = db.reviews[i];
  const card = review && db.cards.find((c) => c.id === review.cardId);
  if (!card) return res.status(404).json({ error: "Nothing to undo." });
  for (const f of SCHEDULE_FIELDS) {
    if (review.prev[f] === null) delete card[f];
    else card[f] = review.prev[f];
  }
  db.reviews.splice(i, 1);
  save();
  reminders.scheduleSync();
  res.json(withCardInfo(card));
});

// Tab-separated file that Anki imports directly (File → Import)
app.get("/api/export/anki.txt", (req, res) => {
  const titles = Object.fromEntries(db.docs.map((d) => [d.id, d.title]));
  const field = (s) => esc(s).replace(/\t/g, " ").replace(/\r?\n/g, "<br>");
  const deckName = (id) => `ONSEI_LRN::${String(titles[id] || "Untitled").replace(/::/g, ":").replace(/[\t\r\n]/g, " ")}`;
  const cards = db.cards.filter((c) => !req.query.docId || c.docId === req.query.docId);
  const lines = ["#separator:tab", "#html:true", "#notetype:Basic", "#deck column:3", "#tags column:4"];
  for (const c of cards) lines.push([field(c.front), field(c.back), deckName(c.docId), "onsei_lrn"].join("\t"));
  res.attachment("onsei_lrn_cards.txt").type("text/plain; charset=utf-8").send(lines.join("\n") + "\n");
});

// --- Claude connection ---
const aiInfo = () => ({ provider: PROVIDER, tokenSource: tokenSource(), status: aiStatus });

app.get("/api/ai", (_req, res) => res.json(aiInfo()));

app.post("/api/ai/test", async (_req, res) => {
  await testConnection();
  res.json(aiInfo());
});

app.post("/api/ai/token", async (req, res) => {
  try {
    saveClaudeToken(req.body?.token);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  await testConnection();
  if (aiStatus.code === "auth") {
    clearClaudeToken();
    return res.status(400).json({ error: "Claude did not accept that token. Run `claude setup-token` again and paste the new token.", ...aiInfo() });
  }
  res.json(aiInfo());
});

app.delete("/api/ai/token", (_req, res) => {
  clearClaudeToken();
  res.json(aiInfo());
});

// --- Settings ---
app.get("/api/settings", (_req, res) => res.json(getSettings()));

app.put("/api/settings", async (req, res) => {
  const before = getSettings();
  let after;
  try {
    after = updateSettings(req.body);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (after.retention !== before.retention) {
    db.cards.forEach((c) => (c.due = rescheduleDue(c, after.retention)));
    save();
  }
  const r0 = before.reminders;
  const r1 = after.reminders;
  if (reminders.SUPPORTED && r0.enabled && (!r1.enabled || r1.list !== r0.list)) {
    // Turned off or moved to another list: take the open reminders out of the old list
    await reminders.syncNow({ clear: true, list: r0.list }).catch(() => {});
  }
  if (r1.enabled) reminders.scheduleSync(0);
  res.json(after);
});

// --- Reminders and calendar feed ---
app.get("/api/reminders", (_req, res) => res.json({ supported: reminders.SUPPORTED, ...reminders.status }));

app.post("/api/reminders/sync", async (_req, res) => {
  try {
    await reminders.syncNow();
    res.json({ supported: reminders.SUPPORTED, ...reminders.status });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get("/calendar.ics", (_req, res) => {
  res.type("text/calendar; charset=utf-8").send(reminders.calendarFeed());
});

// --- Progress log (git) ---
app.get("/api/progress", (_req, res) => res.json({ repo: progress.repoDir(), ...progress.status }));

app.post("/api/progress/run", async (_req, res) => {
  try {
    await progress.runNow();
    res.json({ repo: progress.repoDir(), ...progress.status });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- Stats ---
app.get("/api/stats", (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 7), 365);
  res.json(computeStats(db, { days }));
});

// --- Activity log for the calendar ---
app.get("/api/activity", (_req, res) => {
  res.json({
    attempts: db.attempts.map((a) => ({ at: a.createdAt, verdict: a.result.verdict, conceptId: a.conceptId })),
    reviews: db.reviews.filter((r) => r.source !== "explanation").map((r) => ({ at: r.createdAt })),
    cardsDue: db.cards.map((c) => ({ due: c.due })),
  });
});

const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function sendError(res, err) {
  if (err instanceof AIError) return res.status(502).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server." });
}

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === "LIMIT_FILE_SIZE" ? "PDFs can be up to 32 MB." : "Upload failed.";
    return res.status(400).json({ error: msg });
  }
  sendError(res, err);
});

const LABELS = { "claude-code": "Claude Code (your Claude Pro/Max login)", api: "Claude API (pay-as-you-go)", mock: "mock (no AI)" };

const server = app.listen(PORT, HOST, () => {
  console.log(`ONSEI_LRN: http://localhost:${PORT}  AI: ${LABELS[PROVIDER]}`);
  reminders.startBackgroundSync();
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    // Usually another copy of the app (e.g. the background service) is already running.
    // Exit with 0 so the background service does not keep retrying.
    console.log(`Port ${PORT} is already in use. ONSEI_LRN is probably already running: open http://localhost:${PORT}`);
    process.exit(0);
  }
  throw err;
});
