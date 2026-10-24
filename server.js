import express from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { db, save, newId, now, PDF_DIR } from "./lib/db.js";
import { extractConcepts, evaluateExplanation, AIError, PROVIDER } from "./lib/ai.js";
import { newCardState, schedule, describeDelay, RATINGS } from "./lib/srs.js";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 32 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype === "application/pdf"),
});

const pdfPath = (doc) => path.join(PDF_DIR, `${doc.id}.pdf`);

const find = (list, id, res, label) => {
  const item = list.find((x) => x.id === id);
  if (!item) res.status(404).json({ error: `${label}が見つかりません` });
  return item;
};

const withCardInfo = (card) => ({
  ...card,
  intervals: Object.fromEntries(RATINGS.map((r) => [r, describeDelay(card, r)])),
});

// --- 教材 (PDF) ---
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
  if (!req.file) return res.status(400).json({ error: "PDFファイルを選んでください" });
  const doc = { id: newId(), filename: req.file.originalname, title: "", createdAt: now() };
  fs.writeFileSync(pdfPath(doc), req.file.buffer);
  try {
    const result = await extractConcepts(pdfPath(doc));
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
  const doc = find(db.docs, req.params.id, res, "教材");
  if (!doc) return;
  const concepts = db.concepts.filter((c) => c.docId === doc.id).sort((a, b) => a.order - b.order);
  res.json({ ...doc, concepts });
});

app.get("/api/docs/:id/pdf", (req, res) => {
  const doc = find(db.docs, req.params.id, res, "教材");
  if (doc) res.sendFile(pdfPath(doc));
});

app.delete("/api/docs/:id", (req, res) => {
  const doc = find(db.docs, req.params.id, res, "教材");
  if (!doc) return;
  const keep = (x) => x.docId !== doc.id;
  db.docs = db.docs.filter((d) => d.id !== doc.id);
  db.concepts = db.concepts.filter(keep);
  db.attempts = db.attempts.filter(keep);
  db.cards = db.cards.filter(keep);
  db.reviews = db.reviews.filter(keep);
  fs.rmSync(pdfPath(doc), { force: true });
  save();
  res.json({ ok: true });
});

// --- 概念と説明の試行 ---
app.get("/api/concepts", (_req, res) => {
  const titles = Object.fromEntries(db.docs.map((d) => [d.id, d.title]));
  res.json(db.concepts.map((c) => ({ ...c, docTitle: titles[c.docId] })));
});

app.get("/api/concepts/:id", (req, res) => {
  const concept = find(db.concepts, req.params.id, res, "概念");
  if (!concept) return;
  const doc = db.docs.find((d) => d.id === concept.docId);
  const attempts = db.attempts.filter((a) => a.conceptId === concept.id);
  const card = db.cards.find((c) => c.conceptId === concept.id) || null;
  res.json({ ...concept, docTitle: doc?.title, attemptsList: attempts, card });
});

app.post("/api/concepts/:id/attempts", async (req, res) => {
  const concept = find(db.concepts, req.params.id, res, "概念");
  if (!concept) return;
  const transcript = String(req.body?.transcript || "").trim();
  if (!transcript) return res.status(400).json({ error: "説明が空です" });
  const doc = db.docs.find((d) => d.id === concept.docId);

  // 「正しくなるまで繰り返す」1サイクル分の履歴だけをAIに渡す
  const all = db.attempts.filter((a) => a.conceptId === concept.id);
  const lastCorrect = all.findLastIndex((a) => a.result.verdict === "correct");
  const history = all.slice(lastCorrect + 1);

  try {
    const result = await evaluateExplanation({ pdfPath: pdfPath(doc), concept, transcript, history });
    const attempt = { id: newId(), conceptId: concept.id, docId: doc.id, transcript, result, createdAt: now() };
    db.attempts.push(attempt);
    concept.attempts += 1;

    let card = db.cards.find((c) => c.conceptId === concept.id) || null;
    if (result.verdict === "correct") {
      concept.status = "mastered";
      concept.masteredAt = now();
      if (card) {
        Object.assign(card, { front: result.card_front, back: result.card_back, updatedAt: now() });
      } else {
        card = { id: newId(), conceptId: concept.id, docId: doc.id, front: result.card_front, back: result.card_back, createdAt: now(), ...newCardState() };
        db.cards.push(card);
      }
    } else {
      concept.status = "learning";
    }
    save();
    res.json({ attempt, concept, card, round: history.length + 1 });
  } catch (err) {
    sendError(res, err);
  }
});

// --- フラッシュカード ---
app.get("/api/cards", (req, res) => {
  let cards = db.cards;
  if (req.query.docId) cards = cards.filter((c) => c.docId === req.query.docId);
  if (req.query.due === "1") cards = cards.filter((c) => Date.parse(c.due) <= Date.now());
  res.json(cards.sort((a, b) => Date.parse(a.due) - Date.parse(b.due)).map(withCardInfo));
});

app.put("/api/cards/:id", (req, res) => {
  const card = find(db.cards, req.params.id, res, "カード");
  if (!card) return;
  for (const key of ["front", "back"]) if (typeof req.body?.[key] === "string") card[key] = req.body[key];
  card.updatedAt = now();
  save();
  res.json(withCardInfo(card));
});

app.delete("/api/cards/:id", (req, res) => {
  db.cards = db.cards.filter((c) => c.id !== req.params.id);
  save();
  res.json({ ok: true });
});

app.post("/api/cards/:id/review", (req, res) => {
  const card = find(db.cards, req.params.id, res, "カード");
  if (!card) return;
  const rating = req.body?.rating;
  if (!RATINGS.includes(rating)) return res.status(400).json({ error: "評価が不正です" });
  Object.assign(card, schedule(card, rating));
  db.reviews.push({ id: newId(), cardId: card.id, docId: card.docId, rating, createdAt: now() });
  save();
  res.json(withCardInfo(card));
});

// --- カレンダー用の活動ログ ---
app.get("/api/activity", (_req, res) => {
  res.json({
    attempts: db.attempts.map((a) => ({ at: a.createdAt, verdict: a.result.verdict, conceptId: a.conceptId })),
    reviews: db.reviews.map((r) => ({ at: r.createdAt })),
    cardsDue: db.cards.map((c) => ({ due: c.due })),
  });
});

function sendError(res, err) {
  if (err instanceof AIError) return res.status(502).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: "サーバーエラーが発生しました" });
}

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === "LIMIT_FILE_SIZE" ? "PDFは32MBまでです" : "アップロードに失敗しました";
    return res.status(400).json({ error: msg });
  }
  sendError(res, err);
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  const label = { "claude-code": "Claude Code（Proプランのログインを使用）", api: "Claude API（従量課金）", mock: "モック" }[PROVIDER];
  console.log(`ONSEI_LRN: http://localhost:${PORT}  AI: ${label}`);
});
