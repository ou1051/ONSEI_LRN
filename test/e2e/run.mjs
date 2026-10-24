// End-to-end browser tests: real server (mock AI) + Chromium with a scripted fake speech
// recognizer. Run with: npm run test:e2e   (needs Playwright with Chromium installed)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "../helpers.js";

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  console.log("Playwright is not installed; skipping browser tests. (npm i -D playwright && npx playwright install chromium)");
  process.exit(0);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = 3800 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}/`;
let server, browser, page;
const errors = [];
const attempts = [];

// Fake Web Speech API, driven from the test with window.__emit(text, isFinal)
const FAKE_SPEECH = () => {
  window.__recs = [];
  class FakeSR {
    constructor() {
      window.__recs.push(this);
      this.results = [];
      this.started = false;
    }
    start() {
      if (this.started) throw new Error("already started");
      this.started = true;
      window.__cur = this;
    }
    stop() {
      setTimeout(() => {
        if (window.__late) {
          this._emit(window.__late, true);
          window.__late = null;
        }
        this.started = false;
        this.onend?.();
      }, 80);
    }
    abort() {
      setTimeout(() => {
        this.started = false;
        this.onend?.();
      }, 10);
    }
    _emit(text, isFinal) {
      const r = [{ transcript: text }];
      r.isFinal = isFinal;
      this.results.push(r);
      this.onresult({ resultIndex: this.results.length - 1, results: this.results });
      if (!isFinal) this.results.pop();
    }
  }
  window.SpeechRecognition = FakeSR;
  window.__emit = (t, f = true) => window.__cur._emit(t, f);
};

const emit = (t, f = true) => page.evaluate(([t, f]) => window.__emit(t, f), [t, f]);
const recLabel = () => page.textContent("#rec");
const api = (url, init) => page.evaluate(([u, i]) => fetch(u, i).then((r) => r.json()), [url, init]);
const blur = () => page.evaluate(() => document.activeElement?.blur());

// One card that is already due, so the Review screen has something to show
function seedData() {
  const dir = tempDir();
  const old = "2020-01-01T00:00:00.000Z";
  fs.writeFileSync(
    path.join(dir, "db.json"),
    JSON.stringify({
      docs: [{ id: "seed-doc", title: "Seed deck", filename: "seed.pdf", createdAt: old }],
      concepts: [{ id: "seed-c", docId: "seed-doc", order: 0, status: "mastered", attempts: 1, title: "Seed", question: "Seed question?", key_points: ["k"], pages: "", createdAt: old }],
      attempts: [],
      cards: [{ id: "seed-card", conceptId: "seed-c", docId: "seed-doc", front: "Seed question?", back: "Seed answer", createdAt: old, due: old, stability: 3, difficulty: 5, state: "review", lastReview: old, reps: 1, lapses: 0 }],
      reviews: [],
    }),
  );
  return dir;
}

// Concepts of the uploaded deck (not the seed deck), in order
const deckConcepts = async () => (await api("/api/concepts")).filter((c) => c.docId !== "seed-doc").sort((a, b) => a.order - b.order);

before(async () => {
  server = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), ONSEI_MOCK: "1", ONSEI_DATA_DIR: seedData() },
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(BASE + "api/health")).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 } });
  await ctx.addInitScript(FAKE_SPEECH);
  page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("request", (r) => r.url().includes("/attempts") && attempts.push(JSON.parse(r.postData())));
});

after(async () => {
  await browser?.close();
  server?.kill();
});

test("add a PDF from the Decks screen", async () => {
  await page.goto(BASE);
  await page.setInputFiles("#pdf", { name: "notes.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF\n") });
  await page.waitForURL(/#\/doc\//);
  await page.waitForSelector(".progress");
  assert.equal(await page.locator("table.decks a").count(), 2);
});

test("Space starts recording; the end phrase submits everything before it", async () => {
  await page.click("table.decks a");
  await page.waitForSelector("#transcript");
  await page.keyboard.press("Space");
  assert.match(await recLabel(), /Stop/);
  assert.equal(await page.evaluate(() => window.__cur.lang), "en-US");
  await emit("Plants use light", false);
  assert.equal(await page.textContent("#interim"), "Plants use light");
  await emit(" Plants use light");
  // The browser stops after a silence; recording must continue transparently
  await page.evaluate(() => {
    window.__cur.started = false;
    window.__cur.onend();
  });
  assert.equal(await page.evaluate(() => window.__recs.length), 2);
  await emit("and that's all.");
  await page.waitForSelector(".verdict.incorrect");
  assert.equal(attempts.at(-1).transcript, "Plants use light and");
  assert.equal(attempts.at(-1).lang, "en");
  assert.ok(attempts.at(-1).durationMs >= 0);
  assert.match(await recLabel(), /Start/);
  assert.equal(await page.inputValue("#transcript"), "");
  assert.match(await page.textContent(".score"), /\/100/);
  assert.match(await page.textContent("#history"), /Key points covered: 0 \/ 3/);
});

test("mid-sentence phrase does not submit; late words are kept; Ctrl/⌘+Enter submits", async () => {
  await page.keyboard.press("Space");
  await emit("Photosynthesis is how plants turn light into sugar, that's all there is");
  await emit("and oxygen is released as a by-product of the process");
  assert.equal(attempts.length, 1);
  await page.evaluate(() => (window.__late = "late words"));
  await page.keyboard.press("Control+Enter");
  await page.waitForSelector(".verdict.correct");
  assert.match(attempts.at(-1).transcript, /process late words$/);
  assert.ok(await page.isVisible(".card"));
  assert.match(await page.textContent("#result"), /First review in/);
  assert.equal(await page.locator("ul.checklist li.yes").count(), 3, "key points revealed once correct");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("#round")?.textContent === "Attempt 1");
});

test("Space on a focused button toggles once; Esc stops; typing is safe; Alt+R works anywhere", async () => {
  await page.click("#rec");
  assert.match(await recLabel(), /Stop/);
  await page.keyboard.press("Space");
  await page.waitForTimeout(150);
  assert.match(await recLabel(), /Start/);
  await page.keyboard.press("Space");
  await emit("some words");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  assert.match(await recLabel(), /Start/);
  assert.equal(attempts.length, 2);
  await page.focus("#transcript");
  await page.keyboard.press("Space");
  assert.match(await recLabel(), /Start/, "Space types a space in the text box");
  await page.keyboard.press("Alt+KeyR");
  assert.match(await recLabel(), /Stop/);
  await page.keyboard.press("Alt+KeyR");
  await page.waitForTimeout(150);
  await page.fill("#transcript", "");
});

test("quick stop/start resumes with exactly one recognizer", async () => {
  await blur();
  await page.keyboard.press("Space");
  await page.keyboard.press("Space");
  await page.keyboard.press("Space");
  await page.waitForTimeout(200);
  assert.match(await recLabel(), /Stop/);
  assert.equal(await page.evaluate(() => window.__recs.filter((r) => r.started).length), 1);
  await emit("resumed words");
  assert.match(await page.inputValue("#transcript"), /resumed words$/);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  await page.fill("#transcript", "");
});

test("leaving the page stops the microphone", async () => {
  await blur();
  await page.keyboard.press("Space");
  await page.click('a[data-nav="board"]');
  await page.waitForSelector(".board");
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.__cur.started), false);
});

test("rebinding a key in Settings changes the shortcut everywhere", async () => {
  await page.goto(BASE + "#/settings");
  await page.waitForSelector('[data-bind="toggleRecord"]');
  await page.click('[data-bind="toggleRecord"]');
  await page.waitForSelector(".capturing");
  await page.keyboard.press("Shift"); // a lone modifier is ignored
  assert.ok(await page.isVisible(".capturing"));
  await page.keyboard.press("KeyK");
  await page.waitForFunction(() => !document.querySelector(".capturing"));
  assert.equal((await api("/api/settings")).keys.toggleRecord, "KeyK");
  // A conflicting key is refused
  await page.click('[data-bind="hard"]');
  await page.waitForSelector(".capturing");
  await page.keyboard.press("Digit1");
  await page.waitForSelector(".toast.error");
  assert.match(await page.textContent("#toast"), /already used/);
  assert.equal((await api("/api/settings")).keys.hard, "Digit2");

  const concepts = await deckConcepts();
  await page.goto(BASE + "#/practice/" + concepts[1].id);
  await page.waitForSelector("#transcript");
  assert.match(await page.textContent(".hint"), /^\s*K start \/ stop/);
  await page.keyboard.press("Space");
  assert.match(await recLabel(), /Start/, "Space no longer records");
  await page.keyboard.press("KeyK");
  assert.match(await recLabel(), /Stop/, "K records");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);

  await page.goto(BASE + "#/settings");
  await page.click("#keys-reset");
  await page.waitForFunction(() => document.querySelector("#toast")?.textContent === "Saved.");
  assert.equal((await api("/api/settings")).keys.toggleRecord, "Space");
});

test("Japanese: 以上 submits, 10以上 does not", async () => {
  await page.goto(BASE + "#/settings");
  await page.selectOption("#lang", "ja");
  await page.waitForFunction(() => document.querySelector("#phrases")?.value === "以上, 以上です");
  const concepts = await deckConcepts();
  await page.goto(BASE + "#/practice/" + concepts[1].id);
  await page.waitForSelector("#transcript");
  await page.keyboard.press("Space");
  assert.equal(await page.evaluate(() => window.__cur.lang), "ja-JP");
  const n = attempts.length;
  await emit("呼吸は酸素を使って糖を分解しATPを作る仕組みで効率は10以上");
  assert.equal(attempts.length, n);
  await emit("以上です");
  await page.waitForSelector(".verdict");
  assert.equal(attempts.at(-1).transcript, "呼吸は酸素を使って糖を分解しATPを作る仕組みで効率は10以上");
  assert.equal(attempts.at(-1).lang, "ja");
  await page.goto(BASE + "#/settings");
  await page.selectOption("#lang", "en");
  await page.waitForFunction(() => document.querySelector("#phrases")?.value.startsWith("that's all"));
});

test("review: show answer, rate with keys, undo", async () => {
  await page.goto(BASE + "#/review");
  await page.waitForSelector("#show");
  assert.match(await page.textContent("#card"), /Seed question\?/);
  assert.ok(!(await page.isVisible("#undo")), "nothing to undo yet");
  await page.keyboard.press("Space");
  await page.waitForSelector("[data-r]");
  assert.match(await page.textContent("#card"), /Seed answer/);
  const labels = await page.$$eval(".btn-wrap .ivl:first-child", (e) => e.map((x) => x.textContent));
  assert.equal(labels[0], "10m", "Again = 10 minutes");
  assert.ok(labels.slice(1).every((l) => /^\d+(\.\d)?(d|mo|y)$/.test(l)), labels.join(","));
  await page.keyboard.press("Digit3");
  await page.waitForSelector(".empty");
  assert.match(await page.textContent(".empty"), /Congratulations/);
  const rated = (await api("/api/cards")).find((c) => c.id === "seed-card");
  assert.ok(Date.parse(rated.due) > Date.now(), "Good pushed the card into the future");
  assert.equal(rated.reps, 2);
  await page.keyboard.press("Control+KeyZ");
  await page.waitForSelector("#show");
  const back = (await api("/api/cards")).find((c) => c.id === "seed-card");
  assert.equal(back.due, "2020-01-01T00:00:00.000Z", "undo restored the card");
  assert.equal(back.reps, 1);
  // Space after showing the answer = Good (Anki behavior)
  await page.keyboard.press("Space");
  await page.waitForSelector("[data-r]");
  await page.keyboard.press("Space");
  await page.waitForSelector(".empty");
});

test("stats, cards, calendar, board and settings render without errors", async () => {
  for (const [hash, selector] of [
    ["#/stats", ".chart svg"],
    ["#/cards", "svg.curve"],
    ["#/calendar", ".calendar"],
    ["#/board", ".board"],
    ["#/settings", "#retention"],
  ]) {
    await page.goto(BASE + hash);
    await page.waitForSelector(selector);
  }
  // Hover tooltip on the stats chart
  await page.goto(BASE + "#/stats");
  const bar = await page.waitForSelector('.hit[data-i="29"]');
  const box = await bar.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForSelector(".viz-tip:not([hidden])");
  assert.match(await page.textContent(".viz-tip"), /Explanations: \d+/);
  // Retention slider updates the explanation live
  await page.goto(BASE + "#/settings");
  await page.locator("#retention").fill("80");
  assert.equal(await page.textContent("#ret-val"), "80%");
});

test("no horizontal scrolling on a phone-sized screen", async () => {
  await page.setViewportSize({ width: 375, height: 800 });
  for (const hash of ["#/", "#/stats", "#/settings", "#/calendar", "#/cards", "#/board"]) {
    await page.goto(BASE + hash);
    await page.waitForTimeout(200);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `${hash} overflows by ${overflow}px`);
  }
  await page.setViewportSize({ width: 1000, height: 900 });
});

test("no console errors", () => {
  assert.deepEqual(errors, []);
});
