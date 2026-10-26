// ONSEI_LRN front end (a small single-page app with hash routing)
import { ACTIONS, DEFAULT_KEYS, comboFromEvent, comboParts, findConflicts, isPlainKey, matches } from "./keys.js";
import { LANGS, appendSegment, endPhraseRegex, parsePhrases, stripEndPhrase } from "./text.js";

const view = document.getElementById("view");
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const num = (n, cls) => `<td class="num ${n ? cls : "zero"}">${n}</td>`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const fmtMinutes = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${Math.round(m % 60)}m` : `${Math.round(m)}m`);
const fmtDate = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const kbd = (combo) => (combo ? comboParts(combo, isMac).map((p) => `<kbd>${esc(p)}</kbd>`).join("+") : "<span class=\"subtle\">none</span>");

async function api(path, opts = {}) {
  const init = { ...opts };
  if (opts.json !== undefined) {
    init.method = init.method || "POST";
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(opts.json);
  }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error (${res.status})`);
  return data;
}

function toast(msg, isError = false) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = "toast" + (isError ? " error" : "");
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), isError ? 8000 : 3000);
}

const dayKey = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
};

// ---------------- Settings (stored on the server) ----------------
let settings = null;

async function saveSettings(patch) {
  try {
    settings = await api("/api/settings", { method: "PUT", json: patch });
    return true;
  } catch (err) {
    toast(err.message, true);
    return false;
  }
}

// Earlier versions kept settings in the browser; move them to the server once
async function migrateLocalSettings() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem("onsei-settings") || "null");
    localStorage.removeItem("onsei-settings");
  } catch {
    return;
  }
  if (saved && typeof saved === "object") {
    const { lang, autoSubmit, endPhrases } = saved;
    await api("/api/settings", { method: "PUT", json: { lang, autoSubmit, endPhrases } }).catch(() => {});
  }
}

const isTyping = (e) => ["TEXTAREA", "INPUT", "SELECT"].includes(e.target.tagName) || e.target.isContentEditable;

// True when the event is the key bound to `action` (plain keys are ignored while typing)
function hit(e, action) {
  const combo = settings.keys[action];
  if (!combo || (isPlainKey(combo) && isTyping(e))) return false;
  return matches(e, combo, isMac);
}

// ---------------- Dictation (Web Speech API) ----------------
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const FATAL_ERRORS = {
  "not-allowed": "Microphone access is blocked. Allow the microphone for this site in your browser settings.",
  "service-not-allowed": "Speech recognition is not allowed in this browser.",
  "audio-capture": "No microphone was found.",
  network: "Speech recognition needs an internet connection.",
  "language-not-supported": "This browser does not support speech recognition for the selected language.",
};
let activeDictation = null;

const currentEndRegex = () => (settings.autoSubmit ? endPhraseRegex(parsePhrases(settings.endPhrases[settings.lang])) : null);

function createDictation({ textarea, interimEl, onChange, onEndPhrase, onStart }) {
  const lang = settings.lang;
  const endRe = currentEndRegex();
  let rec = null;
  let wantOn = false;
  let waiters = [];

  const settle = () => {
    waiters.forEach((w) => w());
    waiters = [];
  };

  const spawn = () => {
    const r = new SpeechRecognition();
    r.lang = LANGS[lang].speech;
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (e) => {
      if (r.ignored || !textarea.isConnected) return;
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) textarea.value = appendSegment(textarea.value, e.results[i][0].transcript, lang);
        else interim += e.results[i][0].transcript;
      }
      interimEl.textContent = interim;
      if (wantOn && endRe) {
        const stripped = stripEndPhrase(textarea.value, endRe);
        if (stripped !== null) {
          textarea.value = stripped;
          ctl.abort();
          onEndPhrase();
        }
      }
    };
    r.onerror = (e) => {
      if (FATAL_ERRORS[e.error]) {
        wantOn = false;
        toast(FATAL_ERRORS[e.error], true);
      }
    };
    // Browsers end recognition after a silence; keep listening until the user stops
    r.onend = () => {
      if (rec !== r) return;
      interimEl.textContent = "";
      if (wantOn) {
        try {
          spawn();
          return;
        } catch {
          wantOn = false;
        }
      }
      rec = null;
      onChange(false);
      settle();
    };
    rec = r;
    r.start();
  };

  const ctl = {
    get listening() {
      return wantOn;
    },
    start() {
      if (!SpeechRecognition) return toast("This browser has no speech recognition. Use Chrome, or type your explanation.", true);
      if (wantOn) return;
      wantOn = true;
      activeDictation = ctl;
      onStart?.();
      // Still shutting down from a stop: its onend sees wantOn and resumes listening
      if (rec) return onChange(true);
      try {
        spawn();
      } catch (err) {
        wantOn = false;
        return toast(`Could not start the microphone: ${err.message}`, true);
      }
      onChange(true);
    },
    // Stops listening and resolves once the last words have been transcribed
    stop() {
      wantOn = false;
      if (!rec) return Promise.resolve();
      const r = rec;
      return new Promise((resolve) => {
        waiters.push(resolve);
        setTimeout(() => {
          if (rec === r) {
            rec = null;
            r.ignored = true;
            interimEl.textContent = "";
            onChange(false);
            settle();
          }
        }, 2000);
        r.stop();
      });
    },
    // Stops immediately and drops anything still being transcribed
    abort() {
      wantOn = false;
      if (rec) {
        rec.ignored = true;
        rec.abort();
        rec = null;
      }
      interimEl.textContent = "";
      onChange(false);
      settle();
    },
    toggle() {
      return wantOn ? ctl.stop() : ctl.start();
    },
  };
  return ctl;
}

// ---------------- Decks ----------------
// Checks the Claude connection once per server start and shows a banner if it fails
let aiChecking = null;
async function aiBanner() {
  let ai = await api("/api/ai").catch(() => null);
  if (ai && ai.provider === "claude-code" && !ai.status.checkedAt) {
    aiChecking ||= api("/api/ai/test", { method: "POST" }).catch(() => null);
    ai = (await aiChecking) || ai;
  }
  const el = document.getElementById("ai-banner");
  if (!el || !ai || ai.status.ok !== false) return;
  el.innerHTML = `<div class="banner">${esc(ai.status.message)} <a href="#/settings">Open Claude connection</a></div>`;
}

async function renderDecks() {
  const docs = await api("/api/docs");
  view.innerHTML = `
    <div id="ai-banner"></div>
    <h1>Decks</h1>
    ${
      docs.length
        ? `<table class="decks">
            <tr><th>Deck</th><th class="num">New</th><th class="num">Learning</th><th class="num">Mastered</th><th class="num">Due</th></tr>
            ${docs
              .map(
                (d) => `<tr>
                  <td><a href="#/doc/${d.id}">${esc(d.title)}</a></td>
                  ${num(d.total - d.mastered - d.learning, "new")}
                  ${num(d.learning, "learn")}
                  ${num(d.mastered, "review")}
                  ${num(d.due, "review")}
                </tr>`,
              )
              .join("")}
          </table>`
        : `<div class="empty">No decks yet. Add a PDF to get started.</div>`
    }
    <div class="bottom-bar">
      <label class="button">Add PDF<input type="file" accept="application/pdf" id="pdf" hidden></label>
    </div>
    <p id="upload-status" class="subtle small center"></p>`;

  aiBanner();
  document.getElementById("pdf").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const status = document.getElementById("upload-status");
    status.textContent = `Reading "${file.name}" and extracting concepts… this can take a minute or two.`;
    const form = new FormData();
    form.append("lang", settings.lang);
    form.append("pdf", file);
    try {
      const doc = await api("/api/docs", { method: "POST", body: form });
      location.hash = `#/doc/${doc.id}`;
    } catch (err) {
      status.textContent = "";
      e.target.value = "";
      toast(err.message, true);
      aiBanner();
    }
  });
}

// ---------------- Deck detail (concept list) ----------------
const STATUS = { new: ["New", "new"], learning: ["Learning", "learn"], mastered: ["Mastered", "review"] };

async function renderDoc(id) {
  const doc = await api(`/api/docs/${id}`);
  const mastered = doc.concepts.filter((c) => c.status === "mastered").length;
  const next = doc.concepts.find((c) => c.status !== "mastered");
  view.innerHTML = `
    <h1>${esc(doc.title)}</h1>
    <div class="subtle small">${esc(doc.filename)} · ${mastered} / ${doc.concepts.length} mastered</div>
    <div class="progress"><div style="width:${doc.concepts.length ? (mastered / doc.concepts.length) * 100 : 0}%"></div></div>
    <table class="decks">
      <tr><th>Concept</th><th>Pages</th><th class="num">Attempts</th><th class="num">Status</th></tr>
      ${doc.concepts
        .map(
          (c) => `<tr>
            <td><a href="#/practice/${c.id}">${esc(c.title)}</a></td>
            <td class="subtle">${esc(c.pages)}</td>
            <td class="num">${c.attempts}</td>
            <td class="num ${STATUS[c.status][1]}">${STATUS[c.status][0]}</td>
          </tr>`,
        )
        .join("")}
    </table>
    <div class="bottom-bar">
      ${next ? `<a class="button primary" href="#/practice/${next.id}">Explain next concept</a>` : ""}
      <a class="button" href="#/review?doc=${doc.id}">Review this deck</a>
      <a class="button" href="/api/docs/${doc.id}/pdf" target="_blank">Open PDF</a>
      <a class="button" href="/api/export/anki.txt?docId=${doc.id}" download>Export for Anki</a>
      <button id="del">Delete</button>
    </div>`;
  document.getElementById("del").onclick = async () => {
    if (!confirm(`Delete "${doc.title}" with all of its cards and history?`)) return;
    await api(`/api/docs/${doc.id}`, { method: "DELETE" });
    location.hash = "#/";
  };
}

// ---------------- Explain out loud → AI feedback ----------------
async function renderPractice(id) {
  const c = await api(`/api/concepts/${id}`);
  const doc = await api(`/api/docs/${c.docId}`);
  const idx = doc.concepts.findIndex((x) => x.id === c.id);
  const nextConcept =
    doc.concepts.slice(idx + 1).find((x) => x.status !== "mastered") ||
    doc.concepts.find((x) => x.status !== "mastered" && x.id !== c.id);

  // Attempts since the last correct one = the current cycle
  const lastOk = c.attemptsList.findLastIndex((a) => a.result.verdict === "correct");
  let cycle = c.attemptsList.slice(lastOk + 1);
  const phrases = parsePhrases(settings.endPhrases[settings.lang]);
  const k = settings.keys;
  const endHint =
    settings.autoSubmit && phrases.length
      ? `say <b>“${esc(phrases[0])}”</b> to finish and submit`
      : `${kbd(k.submit)} to submit`;

  view.innerHTML = `
    <div class="subtle small"><a href="#/doc/${doc.id}">${esc(doc.title)}</a> · ${idx + 1} / ${doc.concepts.length}</div>
    <div class="question">${esc(c.question)}</div>
    <div class="subtle small center">Without looking at the PDF, explain it out loud in your own words.</div>
    <div id="history"></div>
    <div class="panel" id="speak">
      <div class="speak-head">
        <span id="round" class="subtle small"></span>
        <span class="subtle small">${esc(LANGS[settings.lang].label)} · <a href="#/settings">Settings</a></span>
      </div>
      <textarea id="transcript" placeholder="Start recording and explain. Your words appear here, and you can edit them before submitting."></textarea>
      <div id="interim" class="interim"></div>
      <div class="bottom-bar">
        <button id="rec"></button>
        <button id="send" class="primary">Done – check my explanation</button>
      </div>
      <div class="hint subtle small center">
        ${kbd(k.toggleRecord)} start / stop · ${endHint} · ${kbd(k.stopRecording)} stop without submitting
      </div>
      ${SpeechRecognition ? "" : `<p class="learn small center">This browser has no speech recognition. Open the app in Chrome, or type your explanation.</p>`}
    </div>
    <div id="result"></div>
    <details><summary>Show key points (spoiler)</summary><ul class="tight">${c.key_points.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>
      <a href="/api/docs/${doc.id}/pdf${c.pages ? `#page=${parseInt(c.pages, 10) || 1}` : ""}" target="_blank">Open the PDF at this page</a></details>`;

  const ta = document.getElementById("transcript");
  const recBtn = document.getElementById("rec");
  const sendBtn = document.getElementById("send");
  let busy = false;
  let done = false;
  let startedAt = null; // when you started this attempt, for study time
  const markStart = () => (startedAt ??= Date.now());
  ta.addEventListener("input", markStart);

  const drawHistory = () => {
    document.getElementById("round").textContent = `Attempt ${cycle.length + 1}`;
    document.getElementById("history").innerHTML = cycle.length
      ? `<h2>Previous attempts</h2>` + cycle.map((a, i) => feedbackHTML(a, i + 1, c, true)).join("")
      : "";
  };
  drawHistory();

  const setRec = (on) => {
    recBtn.innerHTML = on ? `<span class="dot"></span>Stop recording` : "● Start recording";
    recBtn.classList.toggle("recording", on);
  };
  setRec(false);

  const dictation = createDictation({
    textarea: ta,
    interimEl: document.getElementById("interim"),
    onChange: setRec,
    onEndPhrase: () => submit(),
    onStart: markStart,
  });

  async function submit() {
    if (busy || done) return;
    await dictation.stop();
    // Also drop an end phrase left at the end when recording was stopped by hand
    const stripped = stripEndPhrase(ta.value, currentEndRegex());
    if (stripped !== null) ta.value = stripped;
    const transcript = ta.value.trim();
    if (!transcript) return toast("Your explanation is empty.", true);
    busy = true;
    sendBtn.disabled = recBtn.disabled = true;
    sendBtn.textContent = "Checking your explanation…";
    document.activeElement?.blur();
    const durationMs = startedAt ? Date.now() - startedAt : 0;
    try {
      const { attempt, card } = await api(`/api/concepts/${c.id}/attempts`, {
        json: { transcript, lang: settings.lang, durationMs },
      });
      if (!view.contains(ta)) return; // the user navigated away while waiting
      startedAt = null;
      const res = document.getElementById("result");
      if (attempt.result.verdict === "correct") {
        done = true;
        document.getElementById("toast").hidden = true;
        document.getElementById("speak").hidden = true;
        res.innerHTML =
          feedbackHTML(attempt, cycle.length + 1, c) +
          `<h2>Flashcard created</h2>
          <div class="card">${esc(card.front)}<hr>${esc(card.back)}</div>
          <p class="subtle small center">First review in ${esc(nextReviewText(card))}, timed by the forgetting curve.</p>
          <div class="bottom-bar">
            ${
              nextConcept
                ? `<a class="button primary" id="next" href="#/practice/${nextConcept.id}">Next concept ${kbd(k.nextConcept)}</a>`
                : `<a class="button primary" id="next" href="#/doc/${doc.id}">Back to deck ${kbd(k.nextConcept)}</a>`
            }
            <a class="button" href="#/cards?edit=${card.id}">Edit card</a>
          </div>`;
      } else {
        cycle = [...cycle, attempt];
        drawHistory();
        res.innerHTML = "";
        ta.value = "";
        document.getElementById("history").lastElementChild.scrollIntoView({ behavior: "smooth", block: "start" });
        toast("Read the feedback, then start recording and explain it again.");
      }
    } catch (err) {
      toast(err.message, true);
    } finally {
      busy = false;
      sendBtn.disabled = recBtn.disabled = false;
      sendBtn.textContent = "Done – check my explanation";
    }
  }

  recBtn.onclick = () => {
    recBtn.blur(); // so a later Space press is not also treated as a button click
    if (!busy) dictation.toggle();
  };
  sendBtn.onclick = () => submit();

  keyHandler = (e) => {
    if (e.repeat) return;
    if (hit(e, "submit")) {
      e.preventDefault();
      return submit();
    }
    if (done) {
      if (hit(e, "nextConcept")) {
        e.preventDefault();
        document.getElementById("next")?.click();
      }
      return;
    }
    if (busy) return;
    if (hit(e, "toggleRecordAnywhere") || hit(e, "toggleRecord")) {
      e.preventDefault();
      if (e.target.tagName === "BUTTON") e.target.blur();
      return dictation.toggle();
    }
    if (hit(e, "stopRecording") && dictation.listening) {
      e.preventDefault();
      dictation.stop();
    }
  };
}

function nextReviewText(card) {
  const ms = Date.parse(card.due) - Date.now();
  if (ms < 60 * 60 * 1000) return `${Math.max(1, Math.round(ms / 60000))} minutes`;
  if (ms < 24 * 60 * 60 * 1000) return `${Math.round(ms / 3600000)} hours`;
  const days = Math.round(ms / 86400000);
  return `${plural(days, "day")} (${fmtDate(card.due)})`;
}

function feedbackHTML(a, n, concept, collapsedTranscript = false) {
  const r = a.result;
  const ok = r.verdict === "correct";
  const covered = Array.isArray(r.covered) ? r.covered : null;
  const coveredCount = covered ? covered.filter(Boolean).length : 0;
  // Key point texts stay hidden until you get it right; before that only the count shows
  const coverage = covered
    ? ok
      ? `<ul class="checklist">${concept.key_points.map((p, i) => `<li class="${covered[i] ? "yes" : "no"}">${covered[i] ? "✓" : "✗"} ${esc(p)}</li>`).join("")}</ul>`
      : `<div class="small"><span class="subtle">Key points covered:</span> ${coveredCount} / ${covered.length} <span class="dots" aria-hidden="true">${covered.map((x) => (x ? "●" : "○")).join("")}</span></div>`
    : "";
  return `<div class="panel">
    <div class="verdict-row">
      <span class="verdict ${ok ? "correct" : "incorrect"}">Attempt ${n}: ${ok ? "Correct" : "Needs work"}</span>
      ${Number.isFinite(r.score) ? `<span class="score" title="Explanation score">${r.score}<span class="subtle">/100</span></span>` : ""}
    </div>
    <details ${collapsedTranscript ? "" : "open"}><summary>What you said</summary><p>${esc(a.transcript)}</p></details>
    <p>${esc(r.overall)}</p>
    ${(r.mistakes || [])
      .map(
        (m) => `<div class="mistake">
          <div class="quote">“${esc(m.quote)}”</div>
          <div><span class="label">Why it's wrong: </span>${esc(m.problem)}</div>
          <div><span class="label">Correct idea: </span>${esc(m.correction)}</div>
        </div>`,
      )
      .join("")}
    ${(r.missing || []).length ? `<div class="label subtle small">Missing key points</div><ul class="tight">${r.missing.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>` : ""}
    ${coverage}
    ${(r.jargon || []).length ? `<div class="small jargon"><span class="subtle">Explain in plain words:</span> ${r.jargon.map((j) => `<span class="term">${esc(j)}</span>`).join(" ")}</div>` : ""}
  </div>`;
}

// ---------------- Board ----------------
async function renderBoard() {
  const concepts = await api("/api/concepts");
  const mastered = concepts.filter((c) => c.status === "mastered").length;
  view.innerHTML = `
    <h1>Progress board</h1>
    <div class="subtle small">${mastered} / ${concepts.length} concepts mastered</div>
    <div class="progress"><div style="width:${concepts.length ? (mastered / concepts.length) * 100 : 0}%"></div></div>
    <div class="board">
      ${Object.entries(STATUS)
        .map(([key, [label, cls]]) => {
          const list = concepts.filter((c) => c.status === key);
          return `<div class="column">
            <h2 class="${cls}">${label} <span class="subtle">${list.length}</span></h2>
            ${list
              .map(
                (c) => `<a class="tile" href="#/practice/${c.id}">${esc(c.title)}
                  <div class="subtle small">${esc(c.docTitle)}${c.attempts ? ` · ${plural(c.attempts, "attempt")}` : ""}</div></a>`,
              )
              .join("")}
          </div>`;
        })
        .join("")}
    </div>`;
}

// ---------------- Calendar ----------------
let calMonth = new Date();
calMonth.setDate(1);

async function renderCalendar() {
  const act = await api("/api/activity");
  const stats = {};
  const bump = (key, f) => ((stats[key] ||= { att: 0, ok: 0, rev: 0, due: 0 })[f] += 1);
  act.attempts.forEach((a) => {
    bump(dayKey(a.at), "att");
    if (a.verdict === "correct") bump(dayKey(a.at), "ok");
  });
  act.reviews.forEach((r) => bump(dayKey(r.at), "rev"));
  const todayKey = dayKey(new Date());
  act.cardsDue.forEach((c) => {
    const key = dayKey(c.due);
    bump(key < todayKey ? todayKey : key, "due");
  });

  const y = calMonth.getFullYear();
  const m = calMonth.getMonth();
  const start = new Date(y, m, 1 - new Date(y, m, 1).getDay());
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const key = dayKey(d);
    const s = stats[key] || {};
    const total = (s.att || 0) + (s.rev || 0);
    const heat = total === 0 ? "" : total < 4 ? "heat-1" : total < 10 ? "heat-2" : "heat-3";
    cells.push(`<div class="day ${heat} ${d.getMonth() !== m ? "other" : ""} ${key === todayKey ? "today" : ""}">
      <div class="n">${d.getDate()}</div>
      ${s.att ? `<div>Explained ${s.att}</div>` : ""}
      ${s.ok ? `<div class="review">Mastered ${s.ok}</div>` : ""}
      ${s.rev ? `<div>Reviewed ${s.rev}</div>` : ""}
      ${s.due && key >= todayKey ? `<div class="new">Due ${s.due}</div>` : ""}
    </div>`);
  }

  view.innerHTML = `
    <h1>Calendar</h1>
    <div class="cal-head">
      <button id="prev" aria-label="Previous month">‹</button>
      <strong>${calMonth.toLocaleDateString("en-US", { month: "long", year: "numeric" })}</strong>
      <button id="next" aria-label="Next month">›</button>
    </div>
    <div class="calendar">
      ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => `<div class="dow">${d}</div>`).join("")}
      ${cells.join("")}
    </div>
    <div class="legend subtle small">
      <span>Explained = explanations given</span><span class="review">Mastered = concepts explained correctly</span>
      <span>Reviewed = cards reviewed</span><span class="new">Due = cards scheduled for review</span>
    </div>
    <p class="subtle small">Get these as reminders on your phone: <a href="#/settings">Settings → Review reminders</a>.</p>`;
  document.getElementById("prev").onclick = () => (calMonth.setMonth(m - 1), renderCalendar());
  document.getElementById("next").onclick = () => (calMonth.setMonth(m + 1), renderCalendar());
}

// ---------------- Stats ----------------
let statsDays = 30;

async function renderStats() {
  const s = await api(`/api/stats?days=${statsDays}`);
  const t = s.total;
  const tiles = (title, d) => `<div class="tile-group">
      <h2>${title}</h2>
      <div class="tiles">
        <div class="stat"><div class="value">${d.explained}</div><div class="subtle small">explanations</div></div>
        <div class="stat"><div class="value">${d.mastered}</div><div class="subtle small">concepts mastered</div></div>
        <div class="stat"><div class="value">${d.reviewed}</div><div class="subtle small">cards reviewed</div></div>
        <div class="stat"><div class="value">${fmtMinutes(d.minutes)}</div><div class="subtle small">study time</div></div>
      </div>
    </div>`;
  view.innerHTML = `
    <h1>Stats</h1>
    ${tiles("Today", s.today)}
    ${tiles("Last 7 days", s.week)}
    <div class="tile-group">
      <h2>All time</h2>
      <div class="tiles">
        <div class="stat"><div class="value">${t.conceptsMastered}<span class="subtle small"> / ${t.concepts}</span></div><div class="subtle small">concepts mastered</div></div>
        <div class="stat"><div class="value">${t.cards}</div><div class="subtle small">flashcards · ${t.remembered} remembered now</div></div>
        <div class="stat"><div class="value">${t.reviewed}</div><div class="subtle small">cards reviewed</div></div>
        <div class="stat"><div class="value">${fmtMinutes(t.minutes)}</div><div class="subtle small">study time</div></div>
        <div class="stat"><div class="value">${plural(s.streak, "day")}</div><div class="subtle small">study streak</div></div>
        <div class="stat"><div class="value">${t.averageScore ?? "–"}</div><div class="subtle small">average score</div></div>
      </div>
    </div>
    <div class="filters" role="group" aria-label="Time range">
      ${[30, 90, 365].map((d) => `<button data-days="${d}" class="${d === statsDays ? "active" : ""}">${d === 365 ? "1 year" : `${d} days`}</button>`).join("")}
    </div>
    <h2>Explanations and reviews per day</h2>
    <div class="legend-row small">
      <span><span class="swatch s1"></span>Explanations</span><span><span class="swatch s2"></span>Cards reviewed</span>
    </div>
    <div class="chart" id="chart-count"></div>
    <h2>Study time per day</h2>
    <div class="chart" id="chart-time"></div>
    <details><summary>Show as a table</summary>
      <table class="decks">
        <tr><th>Day</th><th class="num">Explained</th><th class="num">Mastered</th><th class="num">Reviewed</th><th class="num">Minutes</th></tr>
        ${s.series
          .filter((d) => d.explained || d.reviewed)
          .reverse()
          .map((d) => `<tr><td>${d.day}</td><td class="num">${d.explained}</td><td class="num">${d.mastered}</td><td class="num">${d.reviewed}</td><td class="num">${Math.round(d.minutes)}</td></tr>`)
          .join("")}
      </table>
    </details>`;

  barChart(document.getElementById("chart-count"), s.series, [
    { key: "explained", label: "Explanations", cls: "s1" },
    { key: "reviewed", label: "Cards reviewed", cls: "s2" },
  ]);
  barChart(document.getElementById("chart-time"), s.series, [{ key: "minutes", label: "Minutes", cls: "s1", format: (v) => fmtMinutes(v) }]);
  view.querySelectorAll("[data-days]").forEach((b) => (b.onclick = () => ((statsDays = Number(b.dataset.days)), renderStats())));
}

const niceMax = (v) => {
  if (v <= 4) return 4;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
};

// Stacked bar chart with a hover tooltip per day. Bars sit on the baseline with rounded tops,
// a 2px gap between stacked segments, and recessive gridlines.
function barChart(el, series, layers) {
  const W = 640;
  const H = 180;
  const L = 32;
  const B = 22;
  const T = 8;
  const totals = series.map((d) => layers.reduce((sum, l) => sum + d[l.key], 0));
  const max = niceMax(Math.max(1, ...totals));
  const step = (W - L) / series.length;
  const bw = Math.max(2, Math.min(18, step * 0.7));
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const ticks = [0, max / 2, max];
  const fmtTick = (v) => (layers[0].format ? fmtMinutes(v) : Number.isInteger(v) ? v : v.toFixed(1));

  const topRounded = (x, yTop, w, h, r) => {
    r = Math.min(r, w / 2, h);
    return `M${x},${yTop + h}V${yTop + r}Q${x},${yTop} ${x + r},${yTop}H${x + w - r}Q${x + w},${yTop} ${x + w},${yTop + r}V${yTop + h}Z`;
  };

  let bars = "";
  series.forEach((d, i) => {
    const x = L + i * step + (step - bw) / 2;
    let base = 0;
    const visible = layers.filter((l) => d[l.key] > 0);
    visible.forEach((l, j) => {
      const v = d[l.key];
      const y0 = y(base);
      const y1 = y(base + v);
      const gap = j > 0 ? 2 : 0; // surface gap between stacked segments
      const h = Math.max(1, y0 - y1 - gap);
      bars +=
        j === visible.length - 1
          ? `<path class="${l.cls}" d="${topRounded(x, y1, bw, h, 4)}"/>`
          : `<rect class="${l.cls}" x="${x}" y="${y1}" width="${bw}" height="${h}"/>`;
      base += v;
    });
    bars += `<rect class="hit" data-i="${i}" x="${L + i * step}" y="${T}" width="${step}" height="${H - T - B}"/>`;
  });

  const labelIdx = [0, Math.floor(series.length / 2), series.length - 1];
  const xLabels = labelIdx
    .map((i, j) => {
      const [x, anchor] = j === 0 ? [L, "start"] : j === 2 ? [W, "end"] : [L + i * step + step / 2, "middle"];
      return `<text x="${x}" y="${H - 6}" text-anchor="${anchor}">${fmtDate(series[i].day + "T12:00:00")}</text>`;
    })
    .join("");
  const grid = ticks
    .map((v) => `<line class="grid" x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${fmtTick(v)}</text>`)
    .join("");

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(layers.map((l) => l.label).join(" and "))} per day">${grid}${bars}${xLabels}</svg><div class="viz-tip" hidden></div>`;
  const tip = el.querySelector(".viz-tip");
  el.querySelectorAll(".hit").forEach((r) => {
    r.addEventListener("mouseenter", () => {
      const d = series[Number(r.dataset.i)];
      tip.innerHTML =
        `<b>${new Date(d.day + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}</b>` +
        layers.map((l) => `<div><span class="swatch ${l.cls}"></span>${esc(l.label)}: ${l.format ? l.format(d[l.key]) : d[l.key]}</div>`).join("");
      tip.hidden = false;
      r.classList.add("on");
    });
    r.addEventListener("mousemove", (e) => {
      const box = el.getBoundingClientRect();
      const x = e.clientX - box.left;
      tip.style.left = `${Math.min(x + 12, box.width - tip.offsetWidth - 4)}px`;
      tip.style.top = `${e.clientY - box.top + 12}px`;
    });
    r.addEventListener("mouseleave", () => {
      tip.hidden = true;
      r.classList.remove("on");
    });
  });
}

// ---------------- Review (Anki's study screen) ----------------
const RATING_LABEL = { again: "Again", hard: "Hard", good: "Good", easy: "Easy" };
let canUndo = false;

async function undoReview(params) {
  try {
    await api("/api/reviews/undo", { method: "POST" });
    canUndo = false;
    toast("Undid the last review.");
    renderReview(params);
  } catch (err) {
    toast(err.message, true);
  }
}

async function renderReview(params) {
  const docId = params.get("doc");
  const cards = await api(`/api/cards?due=1${docId ? `&docId=${encodeURIComponent(docId)}` : ""}`);
  const undoBtn = canUndo ? `<button id="undo">Undo ${kbd(settings.keys.undo)}</button>` : "";
  keyHandler = (e) => {
    if (!e.repeat && canUndo && hit(e, "undo")) {
      e.preventDefault();
      undoReview(params);
    }
  };
  if (!cards.length) {
    view.innerHTML = `<div class="empty">Congratulations! You have finished your reviews for now.</div>
      <div class="bottom-bar"><a class="button" href="#/">Back to decks</a>${undoBtn}</div>`;
    document.getElementById("undo")?.addEventListener("click", () => undoReview(params));
    return;
  }
  const card = cards[0];
  let shown = false;
  let rating = false;
  const shownAt = Date.now();
  view.innerHTML = `
    <div class="subtle small center">Remaining <span class="review">${cards.length}</span>
      ${card.memory ? ` · memory now ${Math.round(card.memory.retention * 100)}%` : ""}</div>
    <div class="card" id="card">${esc(card.front)}</div>
    <div class="bottom-bar" id="actions"><button id="show" class="primary">Show Answer</button>${undoBtn}</div>`;
  const show = () => {
    shown = true;
    document.getElementById("card").innerHTML = `${esc(card.front)}<hr>${esc(card.back)}`;
    document.getElementById("actions").outerHTML = `<div class="answer-buttons">
      ${Object.entries(RATING_LABEL)
        .map(([key, label]) => `<div class="btn-wrap"><div class="ivl">${card.intervals[key]}</div><button data-r="${key}">${label}</button><div class="ivl">${kbd(settings.keys[key])}</div></div>`)
        .join("")}
    </div>${canUndo ? `<div class="bottom-bar">${undoBtn}</div>` : ""}`;
    view.querySelectorAll("[data-r]").forEach((b) => (b.onclick = () => rate(b.dataset.r)));
    document.getElementById("undo")?.addEventListener("click", () => undoReview(params));
  };
  const rate = async (r) => {
    if (rating) return;
    rating = true;
    try {
      await api(`/api/cards/${card.id}/review`, { json: { rating: r, durationMs: Date.now() - shownAt } });
      canUndo = true;
      renderReview(params);
    } catch (err) {
      rating = false;
      toast(err.message, true);
    }
  };
  document.getElementById("show").onclick = show;
  document.getElementById("undo")?.addEventListener("click", () => undoReview(params));
  keyHandler = (e) => {
    if (e.repeat) return;
    if (canUndo && hit(e, "undo")) {
      e.preventDefault();
      return undoReview(params);
    }
    if (!shown) {
      if (hit(e, "showAnswer")) {
        e.preventDefault();
        show();
      }
      return;
    }
    const r = Object.keys(RATING_LABEL).find((key) => hit(e, key)) || (hit(e, "showAnswer") ? "good" : null);
    if (r) {
      e.preventDefault();
      rate(r);
    }
  };
}

// ---------------- Card browser ----------------
const FACTOR = 19 / 81;
const recall = (days, stability) => Math.pow(1 + (FACTOR * Math.max(0, days)) / stability, -0.5);

// Forgetting curve since the last review: how likely you are to remember the card over time
function curveSVG(card) {
  if (!card.stability || !card.lastReview) return "";
  const DAY = 86400000;
  const now = (Date.now() - Date.parse(card.lastReview)) / DAY;
  const due = (Date.parse(card.due) - Date.parse(card.lastReview)) / DAY;
  const span = Math.max(due * 1.4, now * 1.2, 1);
  const W = 220;
  const H = 56;
  const P = 6;
  const target = settings.retention;
  // Zoom the y-axis to the part of the curve that matters (down to just below the target)
  const lo = Math.max(0, Math.min(target, recall(span, card.stability)) - 0.08);
  const x = (d) => P + (d / span) * (W - 2 * P);
  const y = (r) => P + (H - 2 * P) * ((1 - r) / (1 - lo));
  let d = "";
  for (let i = 0; i <= 60; i++) {
    const t = (span * i) / 60;
    d += `${i ? "L" : "M"}${x(t).toFixed(1)},${y(recall(t, card.stability)).toFixed(1)}`;
  }
  return `<svg class="curve" viewBox="0 0 ${W} ${H}" role="img" aria-label="Forgetting curve: ${Math.round(recall(now, card.stability) * 100)}% now">
    <title>Forgetting curve: chance you remember this card over time. Dot = now, dashed line = next review, dotted line = target retention.</title>
    <line class="grid" x1="0" x2="${W}" y1="${y(target)}" y2="${y(target)}"/>
    <path class="line" d="${d}"/>
    <line class="due" x1="${x(due)}" x2="${x(due)}" y1="2" y2="${H - 2}"/>
    <circle class="now" cx="${x(Math.min(now, span))}" cy="${y(recall(now, card.stability))}" r="4"/>
  </svg>`;
}

async function renderCards(params) {
  const [cards, docs] = await Promise.all([api("/api/cards"), api("/api/docs")]);
  const titles = Object.fromEntries(docs.map((d) => [d.id, d.title]));
  const editId = params.get("edit");
  view.innerHTML = `
    <h1>Cards <span class="subtle">${cards.length}</span></h1>
    ${cards.length ? `<p class="small"><a href="/api/export/anki.txt" download>Export all cards for Anki</a> <span class="subtle">(in Anki: File → Import)</span></p>` : `<div class="empty">Concepts you explain correctly are saved here as flashcards.</div>`}
    ${cards
      .map((c) => {
        const mem = c.memory;
        return `<div class="panel" data-id="${c.id}">
          <div class="card-meta">
            <div class="subtle small">${esc(titles[c.docId])}<br>
              ${mem ? `Memory now <b>${Math.round(mem.retention * 100)}%</b> · stable for ${plural(Math.round(mem.stability), "day")} · ` : ""}next review ${fmtDate(c.due)}
            </div>
            ${curveSVG(c)}
          </div>
          <label class="subtle small">Front</label><textarea class="front short">${esc(c.front)}</textarea>
          <label class="subtle small">Back (your words)</label><textarea class="back">${esc(c.back)}</textarea>
          <div class="bottom-bar"><button class="save">Save</button><button class="delete">Delete</button></div>
        </div>`;
      })
      .join("")}`;
  view.querySelectorAll(".panel[data-id]").forEach((p) => {
    const id = p.dataset.id;
    p.querySelector(".save").onclick = async () => {
      await api(`/api/cards/${id}`, { method: "PUT", json: { front: p.querySelector(".front").value, back: p.querySelector(".back").value } });
      toast("Saved.");
    };
    p.querySelector(".delete").onclick = async () => {
      if (!confirm("Delete this card?")) return;
      await api(`/api/cards/${id}`, { method: "DELETE" });
      p.remove();
    };
  });
  if (editId) view.querySelector(`[data-id="${CSS.escape(editId)}"]`)?.scrollIntoView({ block: "center" });
}

// ---------------- Settings ----------------
const AI_LABELS = { "claude-code": "Claude Code (your Claude Pro/Max login, no extra cost)", api: "Claude API (pay-as-you-go)", mock: "Mock (no AI)" };
let capturing = null; // action whose key is being recorded

function firstIntervalDays(retention) {
  const S = 3.7145; // stability after a first correct explanation
  return Math.round((S / FACTOR) * (Math.pow(retention, -2) - 1));
}

async function renderSettings() {
  const [ai, rem, prog] = await Promise.all([
    api("/api/ai").catch(() => ({ status: {} })),
    api("/api/reminders").catch(() => ({})),
    api("/api/progress").catch(() => ({})),
  ]);
  const r = settings.reminders;
  const p = settings.progress;
  const keyRows = (group) =>
    Object.entries(ACTIONS)
      .filter(([, meta]) => meta.group === group)
      .map(
        ([action, meta]) => `<tr>
          <td>${esc(meta.label)}</td>
          <td class="keycell">${capturing === action ? `<span class="capturing">Press a key…</span>` : kbd(settings.keys[action])}</td>
          <td class="num"><button class="small-btn" data-bind="${action}">${capturing === action ? "Cancel" : "Change"}</button></td>
        </tr>`,
      )
      .join("");
  const statusLine = (s) =>
    s.lastSync || s.lastRun
      ? `<div class="small ${s.ok ? "review" : "learn"}">${esc(s.message)} <span class="subtle">(${new Date(s.lastSync || s.lastRun).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })})</span></div>`
      : "";
  const webcal = `webcal://${location.host}/calendar.ics`;

  const st = ai.status || {};
  const aiLine =
    st.ok === true
      ? `<div class="small review">✓ Connected to Claude <span class="subtle">(checked ${new Date(st.checkedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })})</span></div>`
      : st.ok === false
        ? `<div class="small learn">${esc(st.message)}</div>${st.detail ? `<details class="small"><summary>Details</summary><pre class="detail">${esc(st.detail)}</pre></details>` : ""}`
        : `<div class="small subtle">Not checked yet.</div>`;
  const source = { app: "Using the token you saved here.", env: "Using CLAUDE_CODE_OAUTH_TOKEN from the environment." }[ai.tokenSource] || "Using your Claude Code login.";

  view.innerHTML = `
    <h1>Settings</h1>

    <h2>Claude connection</h2>
    <div class="panel form">
      <div class="small">${esc(AI_LABELS[ai.provider] || "Unknown")} · ${esc(source)}</div>
      ${aiLine}
      <div class="bottom-bar left">
        <button id="ai-test">Test connection</button>
        ${ai.tokenSource === "app" ? `<button id="ai-clear">Remove saved token</button>` : ""}
      </div>
      ${
        ai.provider === "claude-code"
          ? `<details ${st.ok === false ? "open" : ""}>
              <summary>Connect with a token (fixes “not logged in” / authentication errors)</summary>
              <ol class="steps small">
                <li>Open <b>Terminal</b> and run: <code id="setup-cmd">claude setup-token</code> <button class="small-btn" id="copy-cmd">Copy</button></li>
                <li>Approve access in the browser window that opens. Terminal then prints a token starting with <code>sk-ant-oat</code>.</li>
                <li>Paste it here:</li>
              </ol>
              <div class="row-input">
                <input type="password" id="ai-token" placeholder="sk-ant-oat…" autocomplete="off" spellcheck="false">
                <button id="ai-save" class="primary">Save &amp; test</button>
              </div>
              <div class="subtle small">The background app cannot always read your Claude Code login from the macOS Keychain; this token replaces it. It uses your Claude Pro/Max plan, lasts one year, and is stored only on this Mac (readable by your user account only).</div>
            </details>`
          : ""
      }
    </div>

    <h2>Explaining</h2>
    <div class="panel form">
      <label for="lang">Language you explain in</label>
      <select id="lang">${Object.entries(LANGS).map(([key, l]) => `<option value="${key}" ${key === settings.lang ? "selected" : ""}>${esc(l.label)}</option>`).join("")}</select>
      <div class="subtle small">Used for speech recognition, AI feedback, and concepts extracted from new PDFs.</div>
      <label class="check"><input type="checkbox" id="auto" ${settings.autoSubmit ? "checked" : ""}> Submit automatically when I say an end phrase</label>
      <label for="phrases">End phrases for ${esc(LANGS[settings.lang].label)}</label>
      <input type="text" id="phrases" value="${esc(settings.endPhrases[settings.lang])}">
      <div class="subtle small">Separate with commas. Say one as the last thing in your explanation; it is removed and everything before it is submitted.</div>
    </div>

    <h2>Review schedule</h2>
    <div class="panel form">
      <label for="retention">Target retention: <b id="ret-val">${Math.round(settings.retention * 100)}%</b></label>
      <input type="range" id="retention" min="70" max="97" step="1" value="${Math.round(settings.retention * 100)}">
      <div class="subtle small">
        Each card comes back right before your chance of remembering it drops to this level, following the forgetting curve
        (FSRS, a modern version of Ebbinghaus's curve). Every successful review stretches the next interval.
        Higher means more reviews and fewer forgotten cards. With <span id="ret-val2">${Math.round(settings.retention * 100)}%</span>,
        a concept you explain correctly on the first try comes back after about <b id="ret-days">${plural(firstIntervalDays(settings.retention), "day")}</b>.
      </div>
    </div>

    <h2>Keyboard shortcuts</h2>
    <table class="decks shortcuts">
      <tr><th colspan="3">While explaining</th></tr>${keyRows("explain")}
      <tr><th colspan="3">While reviewing</th></tr>${keyRows("review")}
    </table>
    <div class="bottom-bar"><button id="keys-reset">Reset shortcuts to defaults</button></div>

    <h2>Review reminders</h2>
    <div class="panel form">
      ${
        rem.supported
          ? `<label class="check"><input type="checkbox" id="rem-on" ${r.enabled ? "checked" : ""}> Add review reminders to Apple Reminders</label>
             <div class="subtle small">One reminder per day with reviews due, for the next 30 days, kept up to date automatically. Through iCloud they also appear on your iPhone. The first time, macOS asks to let ONSEI_LRN control Reminders.</div>
             <div class="row2">
               <div><label for="rem-list">List</label><input type="text" id="rem-list" value="${esc(r.list)}"></div>
               <div><label for="rem-time">Remind me at</label><input type="time" id="rem-time" value="${esc(r.time)}"></div>
             </div>
             <div class="bottom-bar left"><button id="rem-sync" ${r.enabled ? "" : "disabled"}>Sync now</button></div>
             ${statusLine(rem)}`
          : `<div class="subtle small">Apple Reminders sync works when ONSEI_LRN runs on a Mac.</div>`
      }
      <label>Calendar</label>
      <div class="small"><a href="${esc(webcal)}">Subscribe in Calendar</a> · <a href="/calendar.ics" download="onsei_lrn_reviews.ics">Download .ics</a></div>
      <div class="subtle small">Shows the same daily reviews as calendar events with an alert, updated hourly.</div>
    </div>

    <h2>Progress on GitHub</h2>
    <div class="panel form">
      <label class="check"><input type="checkbox" id="prog-on" ${p.enabled ? "checked" : ""}> After each study session, save my progress to git and push it</label>
      <div class="subtle small">Writes your numbers (concepts mastered, cards reviewed, study time) to <code>progress/</code>, commits, and pushes 15 minutes after you stop studying, so your study shows up on your GitHub profile.</div>
      <label for="prog-repo">Repository folder</label>
      <input type="text" id="prog-repo" value="${esc(p.repo)}" placeholder="${esc(prog.repo || "")} (this app's folder)">
      <label class="check"><input type="checkbox" id="prog-push" ${p.push ? "checked" : ""}> Push to GitHub (otherwise only commit)</label>
      <div class="bottom-bar left"><button id="prog-run">Commit &amp; push now</button></div>
      ${statusLine(prog)}
    </div>

    <h2>Data</h2>
    <p class="small"><a href="/api/export/anki.txt" download>Export all cards for Anki</a> <span class="subtle">(in Anki: File → Import)</span></p>`;

  const $ = (id) => document.getElementById(id);
  const saved = () => toast("Saved.");

  const busy = (btn, label) => {
    btn.disabled = true;
    btn.textContent = label;
  };
  $("ai-test").onclick = async (e) => {
    busy(e.target, "Testing…");
    const r = await api("/api/ai/test", { method: "POST" }).catch((err) => (toast(err.message, true), null));
    if (r) toast(r.status.ok ? "Connected to Claude." : r.status.message, !r.status.ok);
    renderSettings();
  };
  $("ai-clear")?.addEventListener("click", async () => {
    await api("/api/ai/token", { method: "DELETE" });
    toast("Removed the saved token.");
    renderSettings();
  });
  $("copy-cmd")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText("claude setup-token");
      toast("Copied. Paste it into Terminal.");
    } catch {
      toast("Select the command and copy it by hand.", true);
    }
  });
  $("ai-save")?.addEventListener("click", async (e) => {
    const token = $("ai-token").value;
    busy(e.target, "Testing…");
    try {
      const r = await api("/api/ai/token", { json: { token } });
      toast(r.status.ok ? "Connected to Claude." : r.status.message, !r.status.ok);
    } catch (err) {
      toast(err.message, true);
    }
    renderSettings();
  });

  $("lang").onchange = async (e) => (await saveSettings({ lang: e.target.value })) && (saved(), renderSettings());
  $("auto").onchange = async (e) => (await saveSettings({ autoSubmit: e.target.checked })) && saved();
  $("phrases").onchange = async (e) => {
    if (await saveSettings({ endPhrases: { [settings.lang]: e.target.value } })) {
      e.target.value = settings.endPhrases[settings.lang];
      saved();
    }
  };

  const ret = $("retention");
  ret.oninput = () => {
    const v = Number(ret.value) / 100;
    $("ret-val").textContent = $("ret-val2").textContent = `${ret.value}%`;
    $("ret-days").textContent = plural(firstIntervalDays(v), "day");
  };
  ret.onchange = async () => (await saveSettings({ retention: Number(ret.value) / 100 })) && toast("Saved. Due dates were updated.");

  view.querySelectorAll("[data-bind]").forEach((b) => {
    b.onclick = () => {
      b.blur(); // so pressing Space/Return to bind it does not click this button again
      capturing = capturing === b.dataset.bind ? null : b.dataset.bind;
      renderSettings();
    };
  });
  $("keys-reset").onclick = async () => (await saveSettings({ keys: DEFAULT_KEYS })) && (saved(), renderSettings());

  keyHandler = async (e) => {
    if (!capturing) return;
    const combo = comboFromEvent(e);
    if (!combo) return; // a lone modifier: wait for the actual key
    e.preventDefault();
    e.stopPropagation();
    const action = capturing;
    capturing = null;
    const conflict = findConflicts({ ...settings.keys, [action]: combo }, isMac).find((pair) => pair.includes(action));
    if (conflict) {
      const other = conflict.find((a) => a !== action);
      toast(`That key is already used for “${ACTIONS[other].label}”.`, true);
    } else if (await saveSettings({ keys: { [action]: combo } })) {
      saved();
    }
    renderSettings();
  };

  if (rem.supported) {
    const remSave = async (patch) => {
      if (await saveSettings({ reminders: patch })) {
        saved();
        renderSettings();
      }
    };
    $("rem-on").onchange = (e) => remSave({ enabled: e.target.checked });
    $("rem-list").onchange = (e) => remSave({ list: e.target.value });
    $("rem-time").onchange = (e) => e.target.value && remSave({ time: e.target.value });
    $("rem-sync").onclick = async (e) => {
      e.target.disabled = true;
      e.target.textContent = "Syncing…";
      try {
        const s = await api("/api/reminders/sync", { method: "POST" });
        toast(s.message);
      } catch (err) {
        toast(err.message, true);
      }
      renderSettings();
    };
  }

  $("prog-on").onchange = async (e) => (await saveSettings({ progress: { enabled: e.target.checked } })) && saved();
  $("prog-push").onchange = async (e) => (await saveSettings({ progress: { push: e.target.checked } })) && saved();
  $("prog-repo").onchange = async (e) => (await saveSettings({ progress: { repo: e.target.value } })) && (saved(), renderSettings());
  $("prog-run").onclick = async (e) => {
    e.target.disabled = true;
    e.target.textContent = "Working…";
    try {
      const s = await api("/api/progress/run", { method: "POST" });
      toast(s.message);
    } catch (err) {
      toast(err.message, true);
    }
    renderSettings();
  };
}

// ---------------- Router ----------------
let keyHandler = null;
document.addEventListener("keydown", (e) => keyHandler?.(e));

async function route() {
  activeDictation?.abort();
  activeDictation = null;
  keyHandler = null;
  capturing = null;
  document.getElementById("toast").hidden = true;
  const [path, query] = location.hash.slice(1).split("?");
  const params = new URLSearchParams(query);
  const [, page, id] = (path || "/").split("/");
  if (page !== "review") canUndo = false;
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === (page || "decks")));
  try {
    if (page === "doc") await renderDoc(id);
    else if (page === "practice") await renderPractice(id);
    else if (page === "board") await renderBoard();
    else if (page === "calendar") await renderCalendar();
    else if (page === "stats") await renderStats();
    else if (page === "review") await renderReview(params);
    else if (page === "cards") await renderCards(params);
    else if (page === "settings") await renderSettings();
    else await renderDecks();
  } catch (err) {
    view.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
  window.scrollTo(0, 0);
}

async function boot() {
  try {
    await migrateLocalSettings();
    settings = await api("/api/settings");
  } catch (err) {
    view.innerHTML = `<div class="empty">Could not reach the ONSEI_LRN server. Is it running? (${esc(err.message)})</div>`;
    return;
  }
  window.addEventListener("hashchange", route);
  route();
}

boot();
