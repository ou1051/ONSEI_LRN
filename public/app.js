// ONSEI_LRN フロントエンド（ハッシュルーティングの小さなSPA）
const view = document.getElementById("view");

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const num = (n, cls) => `<td class="num ${n ? cls : "zero"}">${n}</td>`;

async function api(path, opts = {}) {
  const init = { ...opts };
  if (opts.json !== undefined) {
    init.method = init.method || "POST";
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(opts.json);
  }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `エラー (${res.status})`);
  return data;
}

function toast(msg, isError = false) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = "toast" + (isError ? " error" : "");
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), isError ? 6000 : 3000);
}

const dayKey = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
};

// ---------------- 教材一覧 ----------------
async function renderDecks() {
  const docs = await api("/api/docs");
  view.innerHTML = `
    <h1>教材</h1>
    ${
      docs.length
        ? `<table class="decks">
            <tr><th>教材</th><th class="num">未着手</th><th class="num">学習中</th><th class="num">習得</th><th class="num">復習</th></tr>
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
        : `<div class="empty">まだ教材がありません。PDFを追加してください。</div>`
    }
    <div class="bottom-bar">
      <label class="button">PDFを追加<input type="file" accept="application/pdf" id="pdf" hidden></label>
    </div>
    <p id="upload-status" class="subtle small" style="text-align:center"></p>`;

  document.getElementById("pdf").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const status = document.getElementById("upload-status");
    status.textContent = `「${file.name}」を読み込み、概念を抽出しています…（数十秒かかることがあります）`;
    const form = new FormData();
    form.append("pdf", file);
    try {
      const doc = await api("/api/docs", { method: "POST", body: form });
      location.hash = `#/doc/${doc.id}`;
    } catch (err) {
      status.textContent = "";
      toast(err.message, true);
    }
  });
}

// ---------------- 教材詳細（概念リスト） ----------------
const STATUS = { new: ["未着手", "new"], learning: ["学習中", "learn"], mastered: ["習得", "review"] };

async function renderDoc(id) {
  const doc = await api(`/api/docs/${id}`);
  const mastered = doc.concepts.filter((c) => c.status === "mastered").length;
  const next = doc.concepts.find((c) => c.status !== "mastered");
  view.innerHTML = `
    <h1>${esc(doc.title)}</h1>
    <div class="subtle small">${esc(doc.filename)} ・ ${mastered} / ${doc.concepts.length} 習得</div>
    <div class="progress"><div style="width:${doc.concepts.length ? (mastered / doc.concepts.length) * 100 : 0}%"></div></div>
    <table class="decks">
      <tr><th>概念</th><th>ページ</th><th class="num">試行</th><th class="num">状態</th></tr>
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
      ${next ? `<a class="button primary" href="#/practice/${next.id}">次の概念を説明する</a>` : ""}
      <a class="button" href="#/review?doc=${doc.id}">この教材のカードを復習</a>
      <a class="button" href="/api/docs/${doc.id}/pdf" target="_blank">PDFを開く</a>
      <button id="del">削除</button>
    </div>`;
  document.getElementById("del").onclick = async () => {
    if (!confirm(`「${doc.title}」と関連するカード・履歴をすべて削除しますか？`)) return;
    await api(`/api/docs/${doc.id}`, { method: "DELETE" });
    location.hash = "#/";
  };
}

// ---------------- 音声で説明 → AIフィードバック ----------------
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let activeRecognizer = null;

function stopRecognizer() {
  if (activeRecognizer) {
    activeRecognizer.keep = false;
    activeRecognizer.stop();
    activeRecognizer = null;
  }
}

async function renderPractice(id) {
  const c = await api(`/api/concepts/${id}`);
  const doc = await api(`/api/docs/${c.docId}`);
  const idx = doc.concepts.findIndex((x) => x.id === c.id);
  const nextConcept = doc.concepts.slice(idx + 1).find((x) => x.status !== "mastered") || doc.concepts.find((x) => x.status !== "mastered" && x.id !== c.id);

  // 直近の「正解」以降の試行 = 現在のサイクル
  const lastOk = c.attemptsList.findLastIndex((a) => a.result.verdict === "correct");
  let cycle = c.attemptsList.slice(lastOk + 1);

  view.innerHTML = `
    <div class="subtle small"><a href="#/doc/${doc.id}">${esc(doc.title)}</a> ・ ${idx + 1} / ${doc.concepts.length}</div>
    <div class="question">${esc(c.question)}</div>
    <div class="subtle small" style="text-align:center">PDFを見ずに、自分の言葉で声に出して説明してください。</div>
    <div id="history"></div>
    <div class="panel" id="speak">
      <div id="round" class="subtle small"></div>
      <textarea id="transcript" placeholder="録音ボタンを押して説明を始めてください（ここに文字起こしが入ります。手で直すこともできます）"></textarea>
      <div id="interim" class="interim"></div>
      <div class="bottom-bar">
        <button id="rec"></button>
        <button id="send" class="primary">説明を終えて判定する</button>
      </div>
      ${SpeechRecognition ? "" : `<p class="learn small">このブラウザは音声認識に対応していません。Chrome / Edge / Safari で開くか、テキストで入力してください。</p>`}
    </div>
    <div id="result"></div>
    <details><summary>要点を見る（ネタバレ）</summary><ul class="tight">${c.key_points.map((k) => `<li>${esc(k)}</li>`).join("")}</ul>
      <a href="/api/docs/${doc.id}/pdf${c.pages ? `#page=${parseInt(c.pages)}` : ""}" target="_blank">PDFの該当ページを開く</a></details>`;

  const ta = document.getElementById("transcript");
  const interim = document.getElementById("interim");
  const recBtn = document.getElementById("rec");
  const sendBtn = document.getElementById("send");

  const drawHistory = () => {
    document.getElementById("round").textContent = `${cycle.length + 1}回目の説明`;
    document.getElementById("history").innerHTML = cycle.length
      ? `<h2>これまでの説明</h2>` + cycle.map((a, i) => feedbackHTML(a, i + 1, true)).join("")
      : "";
  };
  drawHistory();

  const setRec = (on) => {
    recBtn.innerHTML = on ? `<span class="dot"></span>録音を止める` : "● 録音して説明する";
    recBtn.classList.toggle("recording", on);
  };
  setRec(false);

  recBtn.onclick = () => {
    if (activeRecognizer) return stopRecognizer(), setRec(false);
    if (!SpeechRecognition) return toast("音声認識に対応していないブラウザです", true);
    const r = new SpeechRecognition();
    r.lang = "ja-JP";
    r.continuous = true;
    r.interimResults = true;
    r.keep = true;
    r.onresult = (e) => {
      let tmp = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) ta.value += (ta.value && !/[\s。、]$/.test(ta.value) ? "。" : "") + t;
        else tmp += t;
      }
      interim.textContent = tmp;
    };
    r.onerror = (e) => {
      if (e.error === "not-allowed") toast("マイクの使用が許可されていません", true);
      if (e.error === "not-allowed" || e.error === "service-not-allowed") r.keep = false;
    };
    // 無音で自動停止したら録音中は再開する
    r.onend = () => {
      interim.textContent = "";
      if (r.keep) r.start();
      else setRec(false);
    };
    activeRecognizer = r;
    r.start();
    setRec(true);
  };

  sendBtn.onclick = async () => {
    stopRecognizer();
    setRec(false);
    const transcript = ta.value.trim();
    if (!transcript) return toast("説明が空です", true);
    sendBtn.disabled = recBtn.disabled = true;
    sendBtn.textContent = "AIが判定中…";
    try {
      const { attempt, card } = await api(`/api/concepts/${c.id}/attempts`, { json: { transcript } });
      const res = document.getElementById("result");
      if (attempt.result.verdict === "correct") {
        document.getElementById("speak").hidden = true;
        res.innerHTML =
          feedbackHTML(attempt, cycle.length + 1) +
          `<h2>フラッシュカードを作成しました</h2>
          <div class="card">${esc(card.front)}<hr>${esc(card.back)}</div>
          <div class="bottom-bar">
            ${nextConcept ? `<a class="button primary" href="#/practice/${nextConcept.id}">次の概念へ</a>` : `<a class="button primary" href="#/doc/${doc.id}">教材に戻る</a>`}
            <a class="button" href="#/cards?edit=${card.id}">カードを編集</a>
          </div>`;
      } else {
        cycle = [...cycle, attempt];
        drawHistory();
        res.innerHTML = "";
        ta.value = "";
        document.getElementById("history").lastElementChild.scrollIntoView({ behavior: "smooth", block: "start" });
        toast("フィードバックを読んで、もう一度説明してみましょう");
      }
    } catch (err) {
      toast(err.message, true);
    } finally {
      sendBtn.disabled = recBtn.disabled = false;
      sendBtn.textContent = "説明を終えて判定する";
    }
  };
}

function feedbackHTML(a, n, collapsedTranscript = false) {
  const r = a.result;
  const ok = r.verdict === "correct";
  return `<div class="panel">
    <div class="verdict ${ok ? "correct" : "incorrect"}">${n}回目: ${ok ? "正しく説明できました" : "修正が必要です"}</div>
    <details ${collapsedTranscript ? "" : "open"}><summary>あなたの説明</summary><p>${esc(a.transcript)}</p></details>
    <p>${esc(r.overall)}</p>
    ${r.mistakes
      .map(
        (m) => `<div class="mistake">
          <div class="quote">「${esc(m.quote)}」</div>
          <div><span class="label">なぜ違うか: </span>${esc(m.problem)}</div>
          <div><span class="label">正しくは: </span>${esc(m.correction)}</div>
        </div>`,
      )
      .join("")}
    ${r.missing.length ? `<div class="label subtle small">抜けている要点</div><ul class="tight">${r.missing.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>` : ""}
  </div>`;
}

// ---------------- ボード ----------------
async function renderBoard() {
  const concepts = await api("/api/concepts");
  const cols = [
    ["new", "未着手"],
    ["learning", "学習中"],
    ["mastered", "習得"],
  ];
  const mastered = concepts.filter((c) => c.status === "mastered").length;
  view.innerHTML = `
    <h1>進捗ボード</h1>
    <div class="subtle small">${mastered} / ${concepts.length} 概念を習得</div>
    <div class="progress"><div style="width:${concepts.length ? (mastered / concepts.length) * 100 : 0}%"></div></div>
    <div class="board">
      ${cols
        .map(([key, label]) => {
          const list = concepts.filter((c) => c.status === key);
          return `<div class="column">
            <h2 class="${STATUS[key][1]}">${label} <span class="subtle">${list.length}</span></h2>
            ${list
              .map(
                (c) => `<a class="tile" href="#/practice/${c.id}">${esc(c.title)}
                  <div class="subtle small">${esc(c.docTitle)}${c.attempts ? ` ・ ${c.attempts}回` : ""}</div></a>`,
              )
              .join("")}
          </div>`;
        })
        .join("")}
    </div>`;
}

// ---------------- カレンダー ----------------
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

  // 連続学習日数
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
      ${s.att ? `<div>説明 ${s.att}</div>` : ""}
      ${s.ok ? `<div class="review">習得 ${s.ok}</div>` : ""}
      ${s.rev ? `<div>復習 ${s.rev}</div>` : ""}
      ${s.due && k >= todayKey ? `<div class="new">予定 ${s.due}</div>` : ""}
    </div>`);
  }

  view.innerHTML = `
    <h1>カレンダー</h1>
    <div class="subtle small">連続学習 ${streak} 日</div>
    <div class="cal-head">
      <button id="prev">‹</button><strong>${y}年 ${m + 1}月</strong><button id="next">›</button>
    </div>
    <div class="calendar">
      ${["日", "月", "火", "水", "木", "金", "土"].map((d) => `<div class="dow">${d}</div>`).join("")}
      ${cells.join("")}
    </div>
    <div class="legend subtle small">
      <span>説明 = 音声で説明した回数</span><span class="review">習得 = 正しく説明できた概念</span>
      <span>復習 = カード復習数</span><span class="new">予定 = 復習予定のカード</span>
    </div>`;
  document.getElementById("prev").onclick = () => (calMonth.setMonth(m - 1), renderCalendar());
  document.getElementById("next").onclick = () => (calMonth.setMonth(m + 1), renderCalendar());
}

// ---------------- 復習（Anki の学習画面） ----------------
const RATING_LABEL = { again: "もう一度", hard: "難しい", good: "正解", easy: "簡単" };

async function renderReview(params) {
  const docId = params.get("doc");
  const cards = await api(`/api/cards?due=1${docId ? `&docId=${docId}` : ""}`);
  if (!cards.length) {
    view.innerHTML = `<div class="empty">おめでとうございます！ 今日の復習は終わりました。</div>
      <div class="bottom-bar"><a class="button" href="#/">教材に戻る</a></div>`;
    return;
  }
  const card = cards[0];
  view.innerHTML = `
    <div class="subtle small" style="text-align:center">残り <span class="review">${cards.length}</span></div>
    <div class="card" id="card">${esc(card.front)}</div>
    <div class="bottom-bar" id="actions"><button id="show" class="primary">答えを表示</button></div>`;
  const show = () => {
    document.getElementById("card").innerHTML = `${esc(card.front)}<hr>${esc(card.back)}`;
    document.getElementById("actions").outerHTML = `<div class="answer-buttons">
      ${Object.entries(RATING_LABEL)
        .map(([k, label], i) => `<div class="btn-wrap"><div class="ivl">${card.intervals[k]}</div><button data-r="${k}" title="${i + 1}">${label}</button></div>`)
        .join("")}
    </div>`;
    view.querySelectorAll("[data-r]").forEach((b) => (b.onclick = () => rate(b.dataset.r)));
  };
  const rate = async (rating) => {
    await api(`/api/cards/${card.id}/review`, { json: { rating } });
    renderReview(params);
  };
  document.getElementById("show").onclick = show;
  keyHandler = (e) => {
    if (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT") return;
    if (e.code === "Space" && document.getElementById("show")) (e.preventDefault(), show());
    const r = { Digit1: "again", Digit2: "hard", Digit3: "good", Digit4: "easy" }[e.code];
    if (r && !document.getElementById("show")) rate(r);
  };
}

// ---------------- カード一覧（ブラウザ） ----------------
async function renderCards(params) {
  const [cards, docs] = await Promise.all([api("/api/cards"), api("/api/docs")]);
  const titles = Object.fromEntries(docs.map((d) => [d.id, d.title]));
  const editId = params.get("edit");
  view.innerHTML = `
    <h1>カード <span class="subtle">${cards.length}</span></h1>
    ${cards.length ? "" : `<div class="empty">正しく説明できた概念がここにカードとして貯まります。</div>`}
    ${cards
      .map(
        (c) => `<div class="panel" data-id="${c.id}">
          <div class="subtle small">${esc(titles[c.docId])} ・ 次回 ${new Date(c.due).toLocaleDateString("ja-JP")}</div>
          <label class="subtle small">表</label><textarea class="front" style="min-height:48px">${esc(c.front)}</textarea>
          <label class="subtle small">裏（あなたの説明）</label><textarea class="back">${esc(c.back)}</textarea>
          <div class="bottom-bar"><button class="save">保存</button><button class="delete">削除</button></div>
        </div>`,
      )
      .join("")}`;
  view.querySelectorAll(".panel[data-id]").forEach((p) => {
    const id = p.dataset.id;
    p.querySelector(".save").onclick = async () => {
      await api(`/api/cards/${id}`, { method: "PUT", json: { front: p.querySelector(".front").value, back: p.querySelector(".back").value } });
      toast("保存しました");
    };
    p.querySelector(".delete").onclick = async () => {
      if (!confirm("このカードを削除しますか？")) return;
      await api(`/api/cards/${id}`, { method: "DELETE" });
      p.remove();
    };
  });
  if (editId) view.querySelector(`[data-id="${editId}"]`)?.scrollIntoView({ block: "center" });
}

// ---------------- ルーター ----------------
let keyHandler = null;
document.addEventListener("keydown", (e) => keyHandler?.(e));

async function route() {
  stopRecognizer();
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
    else await renderDecks();
  } catch (err) {
    view.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
  window.scrollTo(0, 0);
}

window.addEventListener("hashchange", route);
route();
