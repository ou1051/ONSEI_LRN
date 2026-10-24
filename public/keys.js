// Keyboard shortcuts: combos are "<modifiers>+<KeyboardEvent.code>", e.g. "Space",
// "Alt+KeyR", "Mod+Enter". "Mod" is ⌘ on macOS and Ctrl elsewhere. Using `code` (the physical
// key) keeps shortcuts working with any keyboard layout and with ⌥ held down on a Mac.
// Shared by the browser app and the unit tests.

export const DEFAULT_KEYS = {
  toggleRecord: "Space",
  toggleRecordAnywhere: "Alt+KeyR",
  submit: "Mod+Enter",
  stopRecording: "Escape",
  nextConcept: "Enter",
  showAnswer: "Space",
  again: "Digit1",
  hard: "Digit2",
  good: "Digit3",
  easy: "Digit4",
  undo: "Mod+KeyZ",
};

export const ACTIONS = {
  toggleRecord: { label: "Start / stop recording", group: "explain" },
  toggleRecordAnywhere: { label: "Start / stop recording, even while typing", group: "explain" },
  submit: { label: "Submit your explanation", group: "explain" },
  stopRecording: { label: "Stop recording without submitting", group: "explain" },
  nextConcept: { label: "Next concept (after a correct explanation)", group: "explain" },
  showAnswer: { label: "Show answer (then: answer Good)", group: "review" },
  again: { label: "Again", group: "review" },
  hard: { label: "Hard", group: "review" },
  good: { label: "Good", group: "review" },
  easy: { label: "Easy", group: "review" },
  undo: { label: "Undo last review", group: "review" },
};

const MODIFIER_CODES = new Set(["ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight", "CapsLock", "Fn", "FnLock", "OSLeft", "OSRight"]);
const ORDER = ["Ctrl", "Alt", "Shift", "Meta"];

// Numpad keys behave like their main-keyboard twins
export function normalizeCode(code) {
  if (code === "NumpadEnter") return "Enter";
  const m = /^Numpad(\d)$/.exec(code);
  return m ? `Digit${m[1]}` : code;
}

// Combo string for a key event, or null for a lone modifier key
export function comboFromEvent(e) {
  if (!e.code || MODIFIER_CODES.has(e.code)) return null;
  const mods = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Meta");
  return [...mods, normalizeCode(e.code)].join("+");
}

// Replaces "Mod" with the platform key and puts modifiers in canonical order
export function resolveCombo(combo, isMac) {
  const parts = combo.split("+");
  const code = parts.pop();
  const mods = new Set(parts.map((p) => (p === "Mod" ? (isMac ? "Meta" : "Ctrl") : p)));
  return [...ORDER.filter((m) => mods.has(m)), code].join("+");
}

export const matches = (e, combo, isMac) => comboFromEvent(e) === resolveCombo(combo, isMac);

// Combos without Ctrl/Alt/⌘ are ignored while typing in a text field
export const isPlainKey = (combo) => !/(^|\+)(Ctrl|Alt|Meta|Mod)\+/.test(combo);

const NAMES = {
  Space: "Space",
  Enter: "Return",
  Escape: "Esc",
  Backspace: "Delete",
  Tab: "Tab",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Slash: "/",
  Period: ".",
  Comma: ",",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
};

// Human-readable parts, e.g. ["⌘", "Return"] on a Mac or ["Ctrl", "Enter"] elsewhere
export function comboParts(combo, isMac) {
  const parts = resolveCombo(combo, isMac).split("+");
  const code = parts.pop();
  const mods = parts.map((m) => (isMac ? { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Meta: "⌘" }[m] : { Meta: "Win" }[m] || m));
  let key = NAMES[code] || code.replace(/^Key/, "").replace(/^Digit/, "");
  if (code === "Enter" && !isMac) key = "Enter";
  return [...mods, key];
}

// Pairs of actions on the same screen that share a key: [[actionA, actionB], ...]
export function findConflicts(keys, isMac) {
  const out = [];
  for (const group of ["explain", "review"]) {
    const seen = new Map();
    for (const [action, meta] of Object.entries(ACTIONS)) {
      if (meta.group !== group || !keys[action]) continue;
      const combo = resolveCombo(keys[action], isMac);
      if (seen.has(combo)) out.push([seen.get(combo), action]);
      else seen.set(combo, action);
    }
  }
  return out;
}
