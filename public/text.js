// Text helpers for dictation. Shared by the browser app and the unit tests.

export const LANGS = {
  en: { label: "English", speech: "en-US" },
  ja: { label: "日本語 (Japanese)", speech: "ja-JP" },
};

export const parsePhrases = (text) =>
  String(text || "")
    .split(/[,、]/)
    .map((p) => p.trim().replace(/[’‘]/g, "'"))
    .filter(Boolean);

// Matches an end phrase at the very end of the transcript (ignoring trailing punctuation/space).
// Latin phrases must start on a word boundary ("that's all", not "...xthat's all");
// other phrases must not follow a digit (so "10以上" does not count as "以上").
export function endPhraseRegex(phrases) {
  const parts = [...phrases]
    .sort((a, b) => b.length - a.length)
    .map((p) => {
      const body = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
      return /^[a-z0-9]/i.test(p) ? `(?<![\\p{L}\\p{N}'])${body}` : `(?<!\\p{N})${body}`;
    });
  return parts.length ? new RegExp(`(?:${parts.join("|")})[\\s\\p{P}]*$`, "iu") : null;
}

// Removes a trailing end phrase; returns null when there is none
export function stripEndPhrase(text, re) {
  const m = re?.exec(text);
  return m ? text.slice(0, m.index).replace(/[\s、。,]+$/, "") : null;
}

// Appends a recognized segment, separated by a space (English) or "。" (Japanese)
export function appendSegment(text, segment, lang) {
  const t = String(segment).trim().replace(/[’‘]/g, "'");
  if (!t) return text;
  let sep = "";
  if (text && !/\s$/.test(text)) sep = lang === "ja" ? (/[。、！？!?]$/.test(text) ? "" : "。") : " ";
  return text + sep + t;
}
