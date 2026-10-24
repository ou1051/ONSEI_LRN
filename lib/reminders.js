// Review reminders: Apple Reminders sync (macOS) and an iCalendar feed.
//
// The app keeps one reminder per day that has reviews due ("ONSEI_LRN: review 5 cards") in a
// dedicated Reminders list, for the next 30 days. Through iCloud they also reach your iPhone.
// Reminders are updated in place rather than recreated, so you are not notified twice.
import { spawn } from "node:child_process";
import { db } from "./db.js";
import { getSettings } from "./settings.js";

const DAY = 24 * 60 * 60 * 1000;
const HORIZON_DAYS = 30;
const OSA_TIMEOUT_MS = 2 * 60 * 1000; // the first run waits for the macOS permission dialog
export const APP_URL = `http://localhost:${Number(process.env.PORT) || 3000}`;
export const SUPPORTED = process.platform === "darwin";

const pad = (n) => String(n).padStart(2, "0");
export const dayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const startOfDay = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const atTime = (dayStartMs, hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(dayStartMs);
  d.setHours(h, m, 0, 0);
  return d.getTime();
};

// One entry per day with reviews due, from today (overdue cards count as today) for `days` days
export function dailyPlan({ cards, docs, time, now = Date.now(), days = HORIZON_DAYS }) {
  const today = startOfDay(now);
  const titles = Object.fromEntries(docs.map((d) => [d.id, d.title]));
  const byDay = new Map();
  for (const card of cards) {
    const due = Math.max(startOfDay(Date.parse(card.due)), today);
    if (due >= today + days * DAY) continue;
    const key = dayKey(due);
    if (!byDay.has(key)) byDay.set(key, { day: key, start: due, count: 0, decks: {} });
    const entry = byDay.get(key);
    entry.count += 1;
    const title = titles[card.docId] || "Untitled";
    entry.decks[title] = (entry.decks[title] || 0) + 1;
  }
  return [...byDay.values()]
    .sort((a, b) => a.start - b.start)
    .map((e) => ({
      day: e.day,
      due: atTime(e.start, time),
      count: e.count,
      name: `ONSEI_LRN: review ${e.count} card${e.count === 1 ? "" : "s"}`,
      body:
        Object.entries(e.decks)
          .map(([title, n]) => `${title} (${n})`)
          .join("\n") + `\n\nOpen ${APP_URL}/#/review`,
    }));
}

// Works out the changes that make the Reminders list match the plan.
// `existing` = reminders currently in the app's list: {id, name, body, due (ms|null), completed}.
export function diffReminders({ existing, plan, now = Date.now() }) {
  const today = dayKey(now);
  const wanted = new Map(plan.map((p) => [p.day, p]));
  const matched = new Set();
  const ops = [];

  for (const r of existing) {
    if (r.completed) continue;
    const day = r.due == null ? null : dayKey(r.due);
    const want = day && wanted.get(day);
    if (want && !matched.has(day)) {
      matched.add(day);
      const changed = {};
      if (r.name !== want.name) changed.name = want.name;
      if ((r.body || "") !== want.body) changed.body = want.body;
      if (Math.abs(r.due - want.due) > 60 * 1000) changed.due = want.due;
      if (Object.keys(changed).length) ops.push({ type: "update", id: r.id, ...changed });
    } else if (day === today) {
      ops.push({ type: "complete", id: r.id }); // nothing left to review today
    } else if (day && day < today) {
      // A past day's reminder: done if nothing is due any more, otherwise rolled into today's
      ops.push(wanted.has(today) ? { type: "delete", id: r.id } : { type: "complete", id: r.id });
    } else {
      ops.push({ type: "delete", id: r.id }); // the schedule changed, or a duplicate
    }
  }

  // Do not bring back today's reminder after it was completed (by you, or because you finished)
  const doneToday = existing.some((r) => r.completed && r.due != null && dayKey(r.due) === today);
  for (const p of plan) {
    if (matched.has(p.day) || (p.day === today && doneToday)) continue;
    ops.push({ type: "create", name: p.name, body: p.body, due: p.due });
  }
  return ops;
}

// ---- osascript (JavaScript for Automation) ----

export const READ_SCRIPT = `
function run(argv) {
  const { list } = JSON.parse(argv[0]);
  const app = Application("Reminders");
  const lists = app.lists.whose({ name: list });
  if (lists.length === 0) return JSON.stringify({ exists: false, items: [] });
  const rs = lists[0].reminders;
  const ids = rs.id(), names = rs.name(), bodies = rs.body(), dues = rs.dueDate(), done = rs.completed();
  return JSON.stringify({
    exists: true,
    items: ids.map((id, i) => ({
      id, name: names[i], body: bodies[i] || "", completed: done[i],
      due: dues[i] ? dues[i].getTime() : null,
    })),
  });
}`;

export const APPLY_SCRIPT = `
function run(argv) {
  const { list, ops } = JSON.parse(argv[0]);
  const app = Application("Reminders");
  let lists = app.lists.whose({ name: list });
  if (lists.length === 0) {
    try { app.make({ new: "list", withProperties: { name: list } }); }
    catch (e) { app.lists.push(app.List({ name: list })); }
    lists = app.lists.whose({ name: list });
  }
  const l = lists[0];
  for (const op of ops) {
    if (op.type === "create") {
      l.reminders.push(app.Reminder({ name: op.name, body: op.body, dueDate: new Date(op.due) }));
      continue;
    }
    const r = l.reminders.byId(op.id);
    if (op.type === "update") {
      if (op.name !== undefined) r.name = op.name;
      if (op.body !== undefined) r.body = op.body;
      if (op.due !== undefined) r.dueDate = new Date(op.due);
    } else if (op.type === "complete") {
      r.completed = true;
    } else if (op.type === "delete") {
      app.delete(r);
    }
  }
  return "ok";
}`;

export class RemindersError extends Error {}

function osa(script, arg) {
  return new Promise((resolve, reject) => {
    const child = spawn("osascript", ["-l", "JavaScript", "-e", script, JSON.stringify(arg)]);
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill(), OSA_TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new RemindersError(e.code === "ENOENT" ? "Apple Reminders sync is only available on macOS." : e.message));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(out.trim());
      if (/-1743|not authori[sz]ed|not allowed/i.test(err)) {
        return reject(
          new RemindersError(
            "ONSEI_LRN is not allowed to use Reminders. Open System Settings → Privacy & Security → Automation " +
              "(and → Reminders), allow it for “node” (or your Terminal), then press Sync now.",
          ),
        );
      }
      reject(new RemindersError(`Reminders sync failed: ${(err || `exit code ${code}`).trim().slice(0, 300)}`));
    });
  });
}

// ---- Sync orchestration ----

export const status = { lastSync: null, ok: null, message: "", reminders: 0 };
let running = null;
let again = false;
let timer = null;

// clear: remove the app's open reminders (used when sync is turned off or the list is renamed)
async function runSync({ clear = false, list } = {}) {
  const settings = getSettings();
  list = list || settings.reminders.list;
  const read = JSON.parse(await osa(READ_SCRIPT, { list }));
  const plan = clear ? [] : dailyPlan({ cards: db.cards, docs: db.docs, time: settings.reminders.time });
  // When clearing, remove open reminders entirely instead of marking them completed
  const ops = clear
    ? read.items.filter((r) => !r.completed).map((r) => ({ type: "delete", id: r.id }))
    : diffReminders({ existing: read.items, plan });
  if (ops.length || (!read.exists && plan.length)) await osa(APPLY_SCRIPT, { list, ops });
  Object.assign(status, {
    lastSync: new Date().toISOString(),
    ok: true,
    message: clear ? "Removed open reminders." : `Up to date: ${plan.length} day${plan.length === 1 ? "" : "s"} with reviews in the next ${HORIZON_DAYS} days.`,
    reminders: plan.length,
  });
}

// Runs a sync now (one at a time; a request during a run triggers one more run afterwards)
export async function syncNow(opts) {
  if (!SUPPORTED) throw new RemindersError("Apple Reminders sync is only available on macOS.");
  if (running) {
    again = true;
    return running;
  }
  running = runSync(opts)
    .catch((err) => {
      Object.assign(status, { lastSync: new Date().toISOString(), ok: false, message: err.message });
      throw err;
    })
    .finally(() => {
      running = null;
      if (again) {
        again = false;
        scheduleSync(0);
      }
    });
  return running;
}

// Debounced background sync after a change (only when enabled)
export function scheduleSync(delay = 5000) {
  if (!SUPPORTED || !getSettings().reminders.enabled) return;
  clearTimeout(timer);
  timer = setTimeout(() => syncNow().catch((err) => console.error(err.message)), delay);
}

// Keeps reminders right as days roll over, even if nothing else changes
export function startBackgroundSync() {
  scheduleSync(10 * 1000);
  setInterval(() => scheduleSync(0), 60 * 60 * 1000).unref();
}

// ---- iCalendar feed (subscribe from Apple Calendar, etc.) ----

const icsText = (s) => String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const icsLocal = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
};
const icsUtc = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

// Folds lines longer than 75 octets, as RFC 5545 requires
const fold = (line) => {
  const out = [];
  let cur = "";
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = "";
    }
    cur += ch;
  }
  out.push(cur);
  return out.join("\r\n ");
};

export function calendarFeed() {
  const settings = getSettings();
  const plan = dailyPlan({ cards: db.cards, docs: db.docs, time: settings.reminders.time, days: 60 });
  const stamp = icsUtc(Date.now());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ONSEI_LRN//Review schedule//EN",
    "CALSCALE:GREGORIAN",
    "X-WR-CALNAME:ONSEI_LRN reviews",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];
  for (const p of plan) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:onsei-lrn-${p.day}@localhost`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsLocal(p.due)}`,
      `DTEND:${icsLocal(p.due + 15 * 60 * 1000)}`,
      `SUMMARY:${icsText(p.name)}`,
      `DESCRIPTION:${icsText(p.body)}`,
      `URL:${APP_URL}/#/review`,
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${icsText(p.name)}`,
      "TRIGGER:PT0M",
      "END:VALARM",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
