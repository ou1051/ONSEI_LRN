// User settings, stored with the rest of the data so the server (scheduler, Reminders sync)
// and every browser see the same values.
import os from "node:os";
import path from "node:path";
import { db, save } from "./db.js";
import { DEFAULT_RETENTION } from "./srs.js";
import { DEFAULT_KEYS } from "../public/keys.js";

// Key combos are "<modifiers>+<KeyboardEvent.code>", e.g. "Space", "Alt+KeyR", "Mod+Enter".
// "Mod" means ⌘ on macOS and Ctrl elsewhere.
export { DEFAULT_KEYS };

// Keys that are active on the same screen must differ
export const KEY_GROUPS = [
  ["toggleRecord", "toggleRecordAnywhere", "submit", "stopRecording", "nextConcept"],
  ["showAnswer", "again", "hard", "good", "easy", "undo"],
];

export const DEFAULTS = {
  lang: "en",
  autoSubmit: true,
  endPhrases: { en: "that's all, that is all", ja: "以上, 以上です" },
  keys: DEFAULT_KEYS,
  retention: DEFAULT_RETENTION,
  reminders: { enabled: false, list: "ONSEI_LRN", time: "09:00" },
  // repo "" = this app's own folder
  progress: { enabled: false, repo: "", push: true },
};

// Same modifiers in any order (and "Mod" vs the platform key) count as the same combo
const canonical = (combo) => {
  const parts = combo.split("+");
  const code = parts.pop();
  const mods = new Set(parts.map((m) => (m === "Mod" ? (process.platform === "darwin" ? "Meta" : "Ctrl") : m)));
  return [...["Ctrl", "Alt", "Shift", "Meta"].filter((m) => mods.has(m)), code].join("+");
};

const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
const COMBO = /^((Ctrl|Alt|Shift|Meta|Mod)\+)*[A-Za-z0-9]+$/;

export function getSettings() {
  const s = isObj(db.settings) ? db.settings : {};
  return {
    ...DEFAULTS,
    ...s,
    endPhrases: { ...DEFAULTS.endPhrases, ...s.endPhrases },
    keys: { ...DEFAULT_KEYS, ...s.keys },
    reminders: { ...DEFAULTS.reminders, ...s.reminders },
    progress: { ...DEFAULTS.progress, ...s.progress },
  };
}

// Validates a partial update, merges it in, saves, and returns the full settings.
// Throws an Error with a user-facing message on invalid input.
export function updateSettings(patch) {
  if (!isObj(patch)) throw new Error("Invalid settings.");
  const next = getSettings();

  if ("lang" in patch) {
    if (!["en", "ja"].includes(patch.lang)) throw new Error("Unknown language.");
    next.lang = patch.lang;
  }
  if ("autoSubmit" in patch) next.autoSubmit = Boolean(patch.autoSubmit);
  if (isObj(patch.endPhrases)) {
    for (const [lang, v] of Object.entries(patch.endPhrases)) {
      if (lang in next.endPhrases && typeof v === "string") next.endPhrases[lang] = v.trim().slice(0, 200) || DEFAULTS.endPhrases[lang];
    }
  }
  if (isObj(patch.keys)) {
    for (const [action, combo] of Object.entries(patch.keys)) {
      if (!(action in DEFAULT_KEYS)) continue;
      if (typeof combo !== "string" || !COMBO.test(combo)) throw new Error(`Invalid key for ${action}.`);
      next.keys[action] = combo;
    }
    for (const group of KEY_GROUPS) {
      const seen = new Map();
      for (const action of group) {
        const combo = canonical(next.keys[action]);
        if (seen.has(combo)) throw new Error(`"${action}" and "${seen.get(combo)}" use the same key.`);
        seen.set(combo, action);
      }
    }
  }
  if ("retention" in patch) {
    const r = Number(patch.retention);
    if (!(r >= 0.7 && r <= 0.97)) throw new Error("Target retention must be between 70% and 97%.");
    next.retention = Math.round(r * 100) / 100;
  }
  if (isObj(patch.reminders)) {
    const r = patch.reminders;
    if ("enabled" in r) next.reminders.enabled = Boolean(r.enabled);
    if ("list" in r) {
      const list = String(r.list).trim().slice(0, 100);
      if (!list) throw new Error("The Reminders list name cannot be empty.");
      next.reminders.list = list;
    }
    if ("time" in r) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(r.time)) throw new Error("Invalid reminder time.");
      next.reminders.time = r.time;
    }
  }

  if (isObj(patch.progress)) {
    const p = patch.progress;
    if ("enabled" in p) next.progress.enabled = Boolean(p.enabled);
    if ("push" in p) next.progress.push = Boolean(p.push);
    if ("repo" in p) {
      const repo = String(p.repo).trim().replace(/^~(?=$|\/)/, os.homedir());
      if (repo && !path.isAbsolute(repo)) throw new Error("Use a full folder path, like /Users/you/learning-log.");
      next.progress.repo = repo;
    }
  }

  db.settings = next;
  save();
  return next;
}
