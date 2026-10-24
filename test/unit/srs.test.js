import { test } from "node:test";
import assert from "node:assert/strict";
import {
  retrievability,
  preview,
  schedule,
  gradeFromAttempts,
  describeInterval,
  memoryInfo,
  migrateCard,
  rescheduleDue,
  RATINGS,
} from "../../lib/srs.js";
import { DAY } from "../helpers.js";

const AT = Date.parse("2026-03-10T15:30:00");

test("forgetting curve: 100% right after review, 90% after S days, then keeps falling", () => {
  assert.equal(retrievability(0, 5), 1);
  assert.ok(Math.abs(retrievability(5, 5) - 0.9) < 1e-9);
  assert.ok(retrievability(10, 5) < retrievability(5, 5));
  assert.ok(retrievability(1000, 5) > 0);
});

test("new card: Again < Hard <= Good < Easy, Again is a 10-minute step", () => {
  const p = preview({}, 0.9, AT, "c1");
  assert.equal(Date.parse(p.again.due) - AT, 10 * 60 * 1000);
  const due = (r) => Date.parse(p[r].due);
  assert.ok(due("again") < due("hard"));
  assert.ok(due("hard") <= due("good"));
  assert.ok(due("good") < due("easy"));
  assert.equal(p.again.state, "learning");
  assert.equal(p.good.state, "review");
});

test("intervals of a day or more land at local midnight", () => {
  const p = preview({}, 0.9, AT, "c1");
  for (const r of ["hard", "good", "easy"]) {
    const d = new Date(p[r].due);
    assert.equal(d.getHours() + d.getMinutes() + d.getSeconds(), 0, r);
  }
});

test("successful reviews at the right time make intervals grow", () => {
  let card = { id: "grow", ...schedule({}, "good", 0.9, AT, "grow") };
  let last = 0;
  for (let i = 0; i < 6; i++) {
    const t = Date.parse(card.due);
    const next = { ...card, ...schedule(card, "good", 0.9, t) };
    const interval = Date.parse(next.due) - t;
    assert.ok(interval > last, `review ${i}: ${interval / DAY}d should exceed ${last / DAY}d`);
    last = interval;
    card = next;
  }
  assert.ok(last > 180 * DAY, "after six good reviews the interval is many months");
});

test("forgetting (Again) on a mature card lowers stability and counts a lapse", () => {
  const card = { id: "m", stability: 60, difficulty: 5, state: "review", lastReview: new Date(AT - 60 * DAY).toISOString(), reps: 5, lapses: 0 };
  const next = schedule(card, "again", 0.9, AT);
  assert.ok(next.stability < card.stability);
  assert.equal(next.lapses, 1);
  assert.equal(next.state, "relearning");
});

test("higher target retention means shorter intervals", () => {
  const card = { id: "r", stability: 20, difficulty: 5, state: "review", lastReview: new Date(AT - 20 * DAY).toISOString(), reps: 3 };
  const at = (ret) => Date.parse(schedule(card, "good", ret, AT).due);
  assert.ok(at(0.95) < at(0.9));
  assert.ok(at(0.9) < at(0.8));
});

test("fuzz is deterministic per card and spreads different cards", () => {
  const base = { stability: 30, difficulty: 5, state: "review", lastReview: new Date(AT - 30 * DAY).toISOString(), reps: 3 };
  const a1 = schedule({ ...base, id: "a" }, "good", 0.9, AT).due;
  const a2 = schedule({ ...base, id: "a" }, "good", 0.9, AT).due;
  assert.equal(a1, a2);
  const dues = new Set(Array.from({ length: 30 }, (_, i) => schedule({ ...base, id: `x${i}` }, "good", 0.9, AT).due));
  assert.ok(dues.size > 3, "different cards get different days");
  // ...but within a few percent of the unfuzzed interval
  const unfuzzed = Date.parse(schedule({ ...base }, "good", 0.9, AT, null).due);
  for (const d of dues) assert.ok(Math.abs(Date.parse(d) - unfuzzed) <= 0.1 * (unfuzzed - AT) + DAY);
});

test("the interval on a button is exactly what you get", () => {
  const card = { id: "btn", stability: 12, difficulty: 6, state: "review", lastReview: new Date(AT - 12 * DAY).toISOString(), reps: 4 };
  const p = preview(card, 0.9, AT);
  for (const r of RATINGS) assert.equal(schedule(card, r, 0.9, AT).due, p[r].due);
});

test("first grade follows the number of attempts", () => {
  assert.equal(gradeFromAttempts(1), "good");
  assert.equal(gradeFromAttempts(2), "hard");
  assert.equal(gradeFromAttempts(3), "again");
  assert.equal(gradeFromAttempts(7), "again");
});

test("interval labels", () => {
  assert.equal(describeInterval(10 / 1440), "10m");
  assert.equal(describeInterval(0.5), "12h");
  assert.equal(describeInterval(1), "1d");
  assert.equal(describeInterval(45), "1.5mo");
  assert.equal(describeInterval(730), "2.0y");
});

test("memory info and migration of old SM-2 cards", () => {
  assert.equal(memoryInfo({}), null);
  const old = { id: "o", interval: 10, ease: 2.5, reps: 3, due: new Date(AT).toISOString(), updatedAt: new Date(AT - 10 * DAY).toISOString() };
  migrateCard(old);
  assert.equal(old.stability, 10);
  assert.equal(old.state, "review");
  assert.equal(old.ease, undefined);
  const info = memoryInfo(old, AT);
  assert.ok(Math.abs(info.retention - 0.9) < 1e-9);
  // already-migrated cards are untouched
  const copy = { ...old };
  migrateCard(old);
  assert.deepEqual(old, copy);
});

test("rescheduling after a retention change only moves review cards", () => {
  const review = { id: "rv", stability: 10, difficulty: 5, state: "review", lastReview: new Date(AT).toISOString(), reps: 2, due: "x" };
  const learning = { ...review, state: "relearning", due: "keep" };
  assert.notEqual(rescheduleDue(review, 0.8), rescheduleDue(review, 0.95));
  assert.ok(Date.parse(rescheduleDue(review, 0.8)) > Date.parse(rescheduleDue(review, 0.95)));
  assert.equal(rescheduleDue(learning, 0.8), "keep");
});
