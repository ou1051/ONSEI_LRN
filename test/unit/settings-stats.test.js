import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempData, DAY } from "../helpers.js";

useTempData();
const { getSettings, updateSettings, DEFAULTS } = await import("../../lib/settings.js");
const { computeStats, dayKey } = await import("../../lib/stats.js");
const { db } = await import("../../lib/db.js");

test("defaults", () => {
  const s = getSettings();
  assert.equal(s.lang, "en");
  assert.equal(s.retention, 0.9);
  assert.equal(s.keys.toggleRecord, "Space");
  assert.equal(s.reminders.enabled, false);
  assert.equal(s.progress.enabled, false);
});

test("partial updates merge and persist", () => {
  updateSettings({ lang: "ja", endPhrases: { ja: " 以上 " }, reminders: { time: "07:45" } });
  const s = getSettings();
  assert.equal(s.lang, "ja");
  assert.equal(s.endPhrases.ja, "以上");
  assert.equal(s.endPhrases.en, DEFAULTS.endPhrases.en, "other language untouched");
  assert.equal(s.reminders.time, "07:45");
  assert.equal(s.reminders.list, "ONSEI_LRN");
  updateSettings({ endPhrases: { ja: "   " } });
  assert.equal(getSettings().endPhrases.ja, DEFAULTS.endPhrases.ja, "blank falls back to default");
});

test("invalid values are rejected without saving anything", () => {
  const before = JSON.stringify(getSettings());
  for (const bad of [
    { lang: "fr" },
    { retention: 0.5 },
    { retention: 0.99 },
    { retention: "abc" },
    { reminders: { time: "25:00" } },
    { reminders: { list: "  " } },
    { keys: { again: "Digit1+" } },
    { keys: { hard: "Digit1" } }, // same as Again
    { progress: { repo: "relative/path" } },
    null,
    [],
  ]) {
    assert.throws(() => updateSettings(bad), Error, JSON.stringify(bad));
  }
  assert.equal(JSON.stringify(getSettings()), before);
});

test("keys: unknown actions ignored, Mod counts as the platform key for conflicts", () => {
  updateSettings({ keys: { nonsense: "KeyQ", again: "KeyQ" } });
  assert.equal(getSettings().keys.again, "KeyQ");
  assert.equal(getSettings().keys.nonsense, undefined);
  const platformMod = process.platform === "darwin" ? "Meta" : "Ctrl";
  assert.throws(() => updateSettings({ keys: { stopRecording: `${platformMod}+Enter` } }), /same key/);
  updateSettings({ keys: { again: "Digit1" } });
});

test("retention is rounded; ~ expands in the repo path", () => {
  updateSettings({ retention: 0.934 });
  assert.equal(getSettings().retention, 0.93);
  updateSettings({ progress: { repo: "~/log" } });
  assert.ok(getSettings().progress.repo.endsWith("/log") && !getSettings().progress.repo.startsWith("~"));
  updateSettings({ progress: { repo: "" } });
});

test("stats: counts per day, today/week/total, minutes, streak, and explanations not double-counted", () => {
  const now = Date.parse("2026-06-10T12:00:00");
  const iso = (daysAgo, h = 10) => {
    const d = new Date(now);
    d.setDate(d.getDate() - daysAgo);
    d.setHours(h);
    return d.toISOString();
  };
  db.concepts = [{ id: "c1", status: "mastered" }, { id: "c2", status: "learning" }, { id: "c3", status: "new" }];
  db.attempts = [
    { conceptId: "c1", createdAt: iso(0), durationMs: 120000, result: { verdict: "incorrect", score: 40 } },
    { conceptId: "c1", createdAt: iso(0), durationMs: 60000, result: { verdict: "correct", score: 90 } },
    { conceptId: "c2", createdAt: iso(1), durationMs: 0, result: { verdict: "incorrect", score: 20 } },
    { conceptId: "c2", createdAt: iso(3), result: { verdict: "correct" } }, // older attempt without score
  ];
  db.reviews = [
    { createdAt: iso(0), durationMs: 30000, rating: "good" },
    { createdAt: iso(1), durationMs: 30000, rating: "again" },
    { createdAt: iso(0), source: "explanation", rating: "good" }, // not a review
    { createdAt: iso(10), durationMs: 5000, rating: "good" },
  ];
  db.cards = [
    { stability: 10, lastReview: iso(1) }, // remembered
    { stability: 1, lastReview: iso(10) }, // forgotten by now
  ];
  db.docs = [{ id: "d" }];
  const s = computeStats(db, { now, days: 14 });
  assert.deepEqual(s.today, { explained: 2, mastered: 1, reviewed: 1, minutes: 4 });
  assert.equal(s.week.explained, 4);
  assert.equal(s.week.reviewed, 2);
  assert.equal(s.total.reviewed, 3);
  assert.equal(s.total.conceptsMastered, 2, "c1 and c2 were each explained correctly once");
  assert.equal(s.total.remembered, 1);
  assert.equal(s.total.averageScore, 50);
  assert.equal(s.streak, 2, "today and yesterday; the gap on day 2 ends it");
  assert.equal(s.series.length, 14);
  assert.equal(s.series.at(-1).day, dayKey(now));
  assert.equal(s.series.at(-1).explained, 2);
});

test("stats: streak counts from yesterday when nothing is done yet today", () => {
  const now = Date.parse("2026-06-10T08:00:00");
  db.attempts = [{ conceptId: "c1", createdAt: new Date(now - DAY).toISOString(), result: { verdict: "correct" } }];
  db.reviews = [];
  assert.equal(computeStats(db, { now }).streak, 1);
  db.attempts = [];
  assert.equal(computeStats(db, { now }).streak, 0);
});
