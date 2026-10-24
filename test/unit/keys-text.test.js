import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_KEYS, comboFromEvent, resolveCombo, matches, isPlainKey, comboParts, findConflicts, normalizeCode } from "../../public/keys.js";
import { parsePhrases, endPhraseRegex, stripEndPhrase, appendSegment } from "../../public/text.js";

const ev = (code, mods = {}) => ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

test("combo from key events", () => {
  assert.equal(comboFromEvent(ev("Space")), "Space");
  assert.equal(comboFromEvent(ev("KeyR", { altKey: true })), "Alt+KeyR");
  assert.equal(comboFromEvent(ev("Enter", { metaKey: true, shiftKey: true })), "Shift+Meta+Enter");
  assert.equal(comboFromEvent(ev("ShiftLeft", { shiftKey: true })), null, "lone modifier");
  assert.equal(comboFromEvent(ev("NumpadEnter")), "Enter");
  assert.equal(comboFromEvent(ev("Numpad3")), "Digit3");
  assert.equal(normalizeCode("KeyA"), "KeyA");
});

test("Mod is ⌘ on a Mac and Ctrl elsewhere", () => {
  assert.equal(resolveCombo("Mod+Enter", true), "Meta+Enter");
  assert.equal(resolveCombo("Mod+Enter", false), "Ctrl+Enter");
  assert.ok(matches(ev("Enter", { metaKey: true }), "Mod+Enter", true));
  assert.ok(!matches(ev("Enter", { ctrlKey: true }), "Mod+Enter", true));
  assert.ok(matches(ev("Enter", { ctrlKey: true }), "Mod+Enter", false));
  assert.ok(!matches(ev("Enter"), "Mod+Enter", false), "plain Enter is not Mod+Enter");
  assert.equal(resolveCombo("Shift+Alt+KeyX", true), "Alt+Shift+KeyX", "canonical modifier order");
});

test("plain keys vs. command shortcuts", () => {
  assert.ok(isPlainKey("Space"));
  assert.ok(isPlainKey("Shift+KeyA"));
  assert.ok(!isPlainKey("Alt+KeyR"));
  assert.ok(!isPlainKey("Mod+Enter"));
});

test("readable labels", () => {
  assert.deepEqual(comboParts("Mod+Enter", true), ["⌘", "Return"]);
  assert.deepEqual(comboParts("Mod+Enter", false), ["Ctrl", "Enter"]);
  assert.deepEqual(comboParts("Alt+KeyR", true), ["⌥", "R"]);
  assert.deepEqual(comboParts("Digit1", true), ["1"]);
  assert.deepEqual(comboParts("Escape", false), ["Esc"]);
});

test("defaults have no conflicts; conflicts are found per screen only", () => {
  assert.deepEqual(findConflicts(DEFAULT_KEYS, true), []);
  assert.deepEqual(findConflicts(DEFAULT_KEYS, false), []);
  // Space for both recording (explain screen) and show answer (review screen) is fine
  assert.equal(DEFAULT_KEYS.toggleRecord, DEFAULT_KEYS.showAnswer);
  assert.deepEqual(findConflicts({ ...DEFAULT_KEYS, hard: "Digit1" }, true), [["again", "hard"]]);
  assert.deepEqual(findConflicts({ ...DEFAULT_KEYS, submit: "Meta+Enter" }, true), [], "Mod+Enter replaced, not duplicated");
  assert.deepEqual(findConflicts({ ...DEFAULT_KEYS, stopRecording: "Meta+Enter" }, true), [["submit", "stopRecording"]]);
});

test("end phrases: English", () => {
  const re = endPhraseRegex(parsePhrases("that's all, that is all"));
  assert.equal(stripEndPhrase("Plants use light. That's all.", re), "Plants use light.");
  assert.equal(stripEndPhrase("plants use light that is all", re), "plants use light");
  assert.equal(stripEndPhrase("plants use light thats all", re), null, "needs the apostrophe form or 'that is'");
  assert.equal(stripEndPhrase("that's all there is to it", re), null, "only at the very end");
  assert.equal(stripEndPhrase("xthat's all", re), null, "word boundary");
  assert.equal(stripEndPhrase("ok THAT'S ALL!!", re), "ok", "case and punctuation");
});

test("end phrases: Japanese", () => {
  const re = endPhraseRegex(parsePhrases("以上, 以上です"));
  assert.equal(stripEndPhrase("光合成は光を使う。以上", re), "光合成は光を使う");
  assert.equal(stripEndPhrase("光合成は光を使う。以上です。", re), "光合成は光を使う");
  assert.equal(stripEndPhrase("効率は10以上", re), null, "a number followed by 以上 is not the end phrase");
  assert.equal(stripEndPhrase("以上のように", re), null);
});

test("phrases: comma lists, curly apostrophes, special characters, empty", () => {
  assert.deepEqual(parsePhrases(" a ,b、c ,, "), ["a", "b", "c"]);
  assert.deepEqual(parsePhrases("that’s all"), ["that's all"]);
  assert.equal(endPhraseRegex([]), null);
  const re = endPhraseRegex(parsePhrases("done (really)?"));
  assert.equal(stripEndPhrase("text done (really)?", re), "text");
});

test("appending recognized segments", () => {
  assert.equal(appendSegment("", " Hello ", "en"), "Hello");
  assert.equal(appendSegment("Hello", "world", "en"), "Hello world");
  assert.equal(appendSegment("Hello ", "world", "en"), "Hello world");
  assert.equal(appendSegment("こんにちは", "世界", "ja"), "こんにちは。世界");
  assert.equal(appendSegment("こんにちは。", "世界", "ja"), "こんにちは。世界");
  assert.equal(appendSegment("x", "   ", "en"), "x");
  assert.equal(appendSegment("", "it’s", "en"), "it's");
});
