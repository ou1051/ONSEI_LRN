// ONSEI_LRN front end (a small single-page app with hash routing)
const view = document.getElementById("view");

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const num = (n, cls) => `<td class="num ${n ? cls : "zero"}">${n}</td>`;
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl";
const ALT = isMac ? "⌥" : "Alt";

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

// ---------------- Settings (kept in this browser) ----------------
const LANGS = {
  en: { label: "English", speech: "en-US", endPhrases: "that's all, that is all" },
  ja: { label: "日本語 (Japanese)", speech: "ja-JP", endPhrases: "以上, 以上です" },
};
const DEFAULT_SETTINGS = { lang: "en", autoSubmit: true, endPhrases: { en: LANGS.en.endPhrases, ja: LANGS.ja.endPhrases } };

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem("onsei-settings") || "{}");
    return { ...DEFAULT_SETTINGS, ...saved, endPhrases: { ...DEFAULT_SETTINGS.endPhrases, ...saved.endPhrases } };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}
let settings = loadSettings();

function saveSettings() {
  try {
    localStorage.setItem("onsei-settings", JSON.stringify(settings));
  } catch {
    // Storage can be unavailable (e.g. private window); settings then last for this visit only
  }
}

const phrasesFor = (lang) =>
  settings.endPhrases[lang]
    .split(/[,、]/)
    .map((p) => p.trim().replace(/[’‘]/g, "'"))
    .filter(Boolean);

// Matches an end phrase at the very end of the transcript (ignoring trailing punctuation/space).
// Latin phrases must start on a word boundary ("that's all", not "...xthat's all");
// other phrases must not follow a digit (so "10以上" does not count as "以上").
function endPhraseRegex(lang) {
  const parts = phrasesFor(lang)
    .sort((a, b) => b.length - a.length)
    .map((p) => {
      const body = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
      return /^[a-z0-9]/i.test(p) ? `(?<![\\p{L}\\p{N}'])${body}` : `(?<!\\p{N})${body}`;
    });
  return parts.length ? new RegExp(`(?:${parts.join("|")})[\\s\\p{P}]*$`, "iu") : null;
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

function createDictation({ textarea, interimEl, onChange, onEndPhrase }) {
  const lang = settings.lang;
  const endRe = settings.autoSubmit ? endPhraseRegex(lang) : null;
  let rec = null;
  let wantOn = false;
  let waiters = [];

  const settle = () => {
    waiters.forEach((w) => w());
    waiters = [];
  };

  const appendFinal = (raw) => {
    const t = raw.trim().replace(/[’‘]/g, "'");
    if (!t) return;
    const v = textarea.value;
    let sep = "";
    if (v && !/\s$/.test(v)) sep = lang === "ja" ? (/[。、！？!?]$/.test(v) ? "" : "。") : " ";
    textarea.value = v + sep + t;
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
        if (e.results[i].isFinal) appendFinal(e.results[i][0].transcript);
        else interim += e.results[i][0].transcript;
      }
      interimEl.textContent = interim;
      if (wantOn && endRe) {
        const m = endRe.exec(textarea.value);
        if (m) {
          textarea.value = textarea.value.slice(0, m.index).replace(/[\s、。,]+$/, "");
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
async function renderDecks() {
  const docs = await api("/api/docs");
  view.innerHTML = `
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
  const phrases = phrasesFor(settings.lang);
  const endHint =
    settings.autoSubmit && phrases.length
      ? `Finish by saying <b>“${esc(phrases[0])}”</b> to submit`
      : `Press <kbd>${MOD}</kbd>+<kbd>Enter</kbd> to submit`;

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
      <textarea id="transcript" placeholder="Press Space to start talking. Your words appear here, and you can edit them before submitting."></textarea>
      <div id="interim" class="interim"></div>
      <div class="bottom-bar">
        <button id="rec"></button>
        <button id="send" class="primary">Done – check my explanation</button>
      </div>
      <div class="hint subtle small center">
        <kbd>Space</kbd> start / stop · ${endHint} · <kbd>Esc</kbd> stop without submitting
      </div>
      ${SpeechRecognition ? "" : `<p class="learn small center">This browser has no speech recognition. Open the app in Chrome, or type your explanation.</p>`}
    </div>
    <div id="result"></div>
    <details><summary>Show key points (spoiler)</summary><ul class="tight">${c.key_points.map((k) => `<li>${esc(k)}</li>`).join("")}</ul>
      <a href="/api/docs/${doc.id}/pdf${c.pages ? `#page=${parseInt(c.pages, 10) || 1}` : ""}" target="_blank">Open the PDF at this page</a></details>`;

  const ta = document.getElementById("transcript");
  const recBtn = document.getElementById("rec");
  const sendBtn = document.getElementById("send");
  let busy = false;
  let done = false;

  const drawHistory = () => {
    document.getElementById("round").textContent = `Attempt ${cycle.length + 1}`;
    document.getElementById("history").innerHTML = cycle.length
      ? `<h2>Previous attempts</h2>` + cycle.map((a, i) => feedbackHTML(a, i + 1, true)).join("")
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
  });

  async function submit() {
    if (busy || done) return;
    await dictation.stop();
    // Also drop an end phrase left at the end when recording was stopped by hand
    const endRe = settings.autoSubmit ? endPhraseRegex(settings.lang) : null;
    const m = endRe?.exec(ta.value);
    if (m) ta.value = ta.value.slice(0, m.index).replace(/[\s、。,]+$/, "");
    const transcript = ta.value.trim();
    if (!transcript) return toast("Your explanation is empty.", true);
    busy = true;
    sendBtn.disabled = recBtn.disabled = true;
    sendBtn.textContent = "Checking your explanation…";
    document.activeElement?.blur();
    try {
      const { attempt, card } = await api(`/api/concepts/${c.id}/attempts`, { json: { transcript, lang: settings.lang } });
      if (!view.contains(ta)) return; // the user navigated away while waiting
      const res = document.getElementById("result");
      if (attempt.result.verdict === "correct") {
        done = true;
        document.getElementById("toast").hidden = true;
        document.getElementById("speak").hidden = true;
        res.innerHTML =
          feedbackHTML(attempt, cycle.length + 1) +
          `<h2>Flashcard created</h2>
          <div class="card">${esc(card.front)}<hr>${esc(card.back)}</div>
          <div class="bottom-bar">
            ${
              nextConcept
                ? `<a class="button primary" id="next" href="#/practice/${nextConcept.id}">Next concept <kbd>Enter</kbd></a>`
                : `<a class="button primary" id="next" href="#/doc/${doc.id}">Back to deck <kbd>Enter</kbd></a>`
            }
            <a class="button" href="#/cards?edit=${card.id}">Edit card</a>
          </div>`;
      } else {
        cycle = [...cycle, attempt];
        drawHistory();
        res.innerHTML = "";
        ta.value = "";
        document.getElementById("history").lastElementChild.scrollIntoView({ behavior: "smooth", block: "start" });
        toast("Read the feedback, then press Space and explain it again.");
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
    const typing = e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT";
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      return submit();
    }
    if (done) {
      if (e.key === "Enter" && !typing) {
        e.preventDefault();
        document.getElementById("next")?.click();
      }
      return;
    }
    if (busy) return;
    if (e.altKey && e.code === "KeyR") {
      e.preventDefault();
      return dictation.toggle();
    }
    if (e.key === "Escape" && dictation.listening) {
      e.preventDefault();
      return dictation.stop();
    }
    if (e.code === "Space" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      if (e.target.tagName === "BUTTON") e.target.blur();
      dictation.toggle();
    }
  };
}

function feedbackHTML(a, n, collapsedTranscript = false) {
  const r = a.result;
  const ok = r.verdict === "correct";
  return `<div class="panel">
    <div class="verdict ${ok ? "correct" : "incorrect"}">Attempt ${n}: ${ok ? "Correct" : "Needs work"}</div>
    <details ${collapsedTranscript ? "" : "open"}><summary>What you said</summary><p>${esc(a.transcript)}</p></details>
    <p>${esc(r.overall)}</p>
    ${r.mistakes
      .map(
        (m) => `<div class="mistake">
          <div class="quote">“${esc(m.quote)}”</div>
          <div><span class="label">Why it's wrong: </span>${esc(m.problem)}</div>
          <div><span class="label">Correct idea: </span>${esc(m.correction)}</div>
        </div>`,
      )
      .join("")}
    ${r.missing.length ? `<div class="label subtle small">Missing key points</div><ul class="tight">${r.missing.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>` : ""}
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
                  <div class="subtle small">${esc(c.docTitle)}${c.attempts ? ` · ${c.attempts} attempt${c.attempts === 1 ? "" : "s"}` : ""}</div></a>`,
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
  const bump = (k, f) => ((stats[k] ||= { att: 0, ok: 0, rev: 0, due: 0 })[f] += 1);
  act.attempts.forEach((a) => {
    bump(dayKey(a.at), "att");
    if (a.verdict === "correct") bump(dayKey(a.at), "ok");
  });
  act.reviews.forEach((r) => bump(dayKey(r.at), "rev"));
  const todayKey = dayKey(new Date());
  act.cardsDue.forEach((c) => {
    const k = dayKey(c.due);
    bump(k < todayKey ? todayKey : k, "due");
  });

  // Study streak (today counts once you study; an empty today does not break it)
  let streak = 0;
  for (let d = new Date(); ; d.setDate(d.getDate() - 1)) {
    const s = stats[dayKey(d)];
    if (s && (s.att || s.rev)) streak++;
    else if (dayKey(d) !== todayKey) break;
  }

  const y = calMonth.getFullYear();
  const m = calMonth.getMonth();
  const start = new Date(y, m, 1 - new Date(y, m, 1).getDay());
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const k = dayKey(d);
    const s = stats[k] || {};
    const total = (s.att || 0) + (s.rev || 0);
    const heat = total === 0 ? "" : total < 4 ? "heat-1" : total < 10 ? "heat-2" : "heat-3";
    cells.push(`<div class="day ${heat} ${d.getMonth() !== m ? "other" : ""} ${k === todayKey ? "today" : ""}">
      <div class="n">${d.getDate()}</div>
      ${s.att ? `<div>Explained ${s.att}</div>` : ""}
      ${s.ok ? `<div class="review">Mastered ${s.ok}</div>` : ""}
      ${s.rev ? `<div>Reviewed ${s.rev}</div>` : ""}
      ${s.due && k >= todayKey ? `<div class="new">Due ${s.due}</div>` : ""}
    </div>`);
  }

  view.innerHTML = `
    <h1>Calendar</h1>
    <div class="subtle small">Study streak: ${streak} day${streak === 1 ? "" : "s"}</div>
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
    </div>`;
  document.getElementById("prev").onclick = () => (calMonth.setMonth(m - 1), renderCalendar());
  document.getElementById("next").onclick = () => (calMonth.setMonth(m + 1), renderCalendar());
}

// ---------------- Review (Anki's study screen) ----------------
const RATING_LABEL = { again: "Again", hard: "Hard", good: "Good", easy: "Easy" };

async function renderReview(params) {
  const docId = params.get("doc");
  const cards = await api(`/api/cards?due=1${docId ? `&docId=${encodeURIComponent(docId)}` : ""}`);
  if (!cards.length) {
    view.innerHTML = `<div class="empty">Congratulations! You have finished your reviews for now.</div>
      <div class="bottom-bar"><a class="button" href="#/">Back to decks</a></div>`;
    return;
  }
  const card = cards[0];
  let shown = false;
  view.innerHTML = `
    <div class="subtle small center">Remaining <span class="review">${cards.length}</span></div>
    <div class="card" id="card">${esc(card.front)}</div>
    <div class="bottom-bar" id="actions"><button id="show" class="primary">Show Answer</button></div>`;
  const show = () => {
    shown = true;
    document.getElementById("card").innerHTML = `${esc(card.front)}<hr>${esc(card.back)}`;
    document.getElementById("actions").outerHTML = `<div class="answer-buttons">
      ${Object.entries(RATING_LABEL)
        .map(([k, label], i) => `<div class="btn-wrap"><div class="ivl">${card.intervals[k]}</div><button data-r="${k}" title="Shortcut: ${i + 1}">${label}</button></div>`)
        .join("")}
    </div>`;
    view.querySelectorAll("[data-r]").forEach((b) => (b.onclick = () => rate(b.dataset.r)));
  };
  let rating = false;
  const rate = async (r) => {
    if (rating) return;
    rating = true;
    try {
      await api(`/api/cards/${card.id}/review`, { json: { rating: r } });
      renderReview(params);
    } catch (err) {
      rating = false;
      toast(err.message, true);
    }
  };
  document.getElementById("show").onclick = show;
  keyHandler = (e) => {
    if (e.repeat || e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT") return;
    if (!shown && (e.code === "Space" || e.key === "Enter")) {
      e.preventDefault();
      return show();
    }
    const r = { Digit1: "again", Digit2: "hard", Digit3: "good", Digit4: "easy", Space: "good", Enter: "good" }[e.code];
    if (shown && r) {
      e.preventDefault();
      rate(r);
    }
  };
}

// ---------------- Card browser ----------------
async function renderCards(params) {
  const [cards, docs] = await Promise.all([api("/api/cards"), api("/api/docs")]);
  const titles = Object.fromEntries(docs.map((d) => [d.id, d.title]));
  const editId = params.get("edit");
  view.innerHTML = `
    <h1>Cards <span class="subtle">${cards.length}</span></h1>
    ${cards.length ? "" : `<div class="empty">Concepts you explain correctly are saved here as flashcards.</div>`}
    ${cards
      .map(
        (c) => `<div class="panel" data-id="${c.id}">
          <div class="subtle small">${esc(titles[c.docId])} · next review ${new Date(c.due).toLocaleDateString("en-US")}</div>
          <label class="subtle small">Front</label><textarea class="front short">${esc(c.front)}</textarea>
          <label class="subtle small">Back (your words)</label><textarea class="back">${esc(c.back)}</textarea>
          <div class="bottom-bar"><button class="save">Save</button><button class="delete">Delete</button></div>
        </div>`,
      )
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
async function renderSettings() {
  const health = await api("/api/health").catch(() => ({}));
  const AI_LABELS = { "claude-code": "Claude Code (your Claude Pro/Max login, no extra cost)", api: "Claude API (pay-as-you-go)", mock: "Mock (no AI)" };
  view.innerHTML = `
    <h1>Settings</h1>
    <div class="panel form">
      <label for="lang">Language you explain in</label>
      <select id="lang">${Object.entries(LANGS).map(([k, l]) => `<option value="${k}" ${k === settings.lang ? "selected" : ""}>${esc(l.label)}</option>`).join("")}</select>
      <div class="subtle small">Used for speech recognition, AI feedback, and concepts extracted from new PDFs.</div>

      <label class="check"><input type="checkbox" id="auto" ${settings.autoSubmit ? "checked" : ""}> Submit automatically when I say an end phrase</label>

      <label for="phrases">End phrases for <span id="lang-name"></span></label>
      <input type="text" id="phrases">
      <div class="subtle small">Separate with commas. Say one of these as the last thing in your explanation; it is removed and everything before it is submitted.</div>
    </div>

    <h2>Keyboard shortcuts</h2>
    <table class="decks shortcuts">
      <tr><td><kbd>Space</kbd></td><td>Start / stop recording (when not typing in the text box)</td></tr>
      <tr><td><kbd>${ALT}</kbd>+<kbd>R</kbd></td><td>Start / stop recording, even while typing</td></tr>
      <tr><td><kbd>${MOD}</kbd>+<kbd>Enter</kbd></td><td>Submit your explanation</td></tr>
      <tr><td><kbd>Esc</kbd></td><td>Stop recording without submitting</td></tr>
      <tr><td><kbd>Enter</kbd></td><td>After a correct explanation: go to the next concept</td></tr>
      <tr><td><kbd>Space</kbd> / <kbd>1</kbd>–<kbd>4</kbd></td><td>Review: show answer / Again, Hard, Good, Easy</td></tr>
    </table>

    <h2>AI</h2>
    <p class="subtle">${esc(AI_LABELS[health.provider] || "Unknown")}</p>`;

  const lang = document.getElementById("lang");
  const phrases = document.getElementById("phrases");
  const fill = () => {
    document.getElementById("lang-name").textContent = LANGS[settings.lang].label;
    phrases.value = settings.endPhrases[settings.lang];
  };
  fill();
  lang.onchange = () => {
    settings.lang = lang.value;
    saveSettings();
    fill();
    toast("Saved.");
  };
  document.getElementById("auto").onchange = (e) => {
    settings.autoSubmit = e.target.checked;
    saveSettings();
    toast("Saved.");
  };
  phrases.onchange = () => {
    settings.endPhrases[settings.lang] = phrases.value.trim() || LANGS[settings.lang].endPhrases;
    saveSettings();
    fill();
    toast("Saved.");
  };
}

// ---------------- Router ----------------
let keyHandler = null;
document.addEventListener("keydown", (e) => keyHandler?.(e));

async function route() {
  activeDictation?.abort();
  activeDictation = null;
  keyHandler = null;
  document.getElementById("toast").hidden = true;
  const [path, query] = location.hash.slice(1).split("?");
  const params = new URLSearchParams(query);
  const [, page, id] = (path || "/").split("/");
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === (page || "decks")));
  try {
    if (page === "doc") await renderDoc(id);
    else if (page === "practice") await renderPractice(id);
    else if (page === "board") await renderBoard();
    else if (page === "calendar") await renderCalendar();
    else if (page === "review") await renderReview(params);
    else if (page === "cards") await renderCards(params);
    else if (page === "settings") await renderSettings();
    else await renderDecks();
  } catch (err) {
    view.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
  window.scrollTo(0, 0);
}

window.addEventListener("hashchange", route);
route();
