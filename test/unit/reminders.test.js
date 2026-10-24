import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempData, DAY } from "../helpers.js";

useTempData();
const { dailyPlan, diffReminders, dayKey, calendarFeed } = await import("../../lib/reminders.js");
const { db } = await import("../../lib/db.js");

const NOW = Date.parse("2026-05-20T14:00:00"); // local time
const at = (days, hh = 0) => {
  const d = new Date(NOW);
  d.setHours(hh, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d.toISOString();
};
const docs = [
  { id: "d1", title: "Biology" },
  { id: "d2", title: "Chemistry" },
];

test("dailyPlan groups due cards per day, rolls overdue into today, and respects the horizon", () => {
  const cards = [
    { docId: "d1", due: at(-3) }, // overdue -> today
    { docId: "d1", due: at(0, 18) },
    { docId: "d2", due: at(0, 1) },
    { docId: "d1", due: at(2) },
    { docId: "d2", due: at(45) }, // beyond 30 days
  ];
  const plan = dailyPlan({ cards, docs, time: "09:30", now: NOW });
  assert.equal(plan.length, 2);
  assert.equal(plan[0].day, dayKey(NOW));
  assert.equal(plan[0].count, 3);
  assert.equal(plan[0].name, "ONSEI_LRN: review 3 cards");
  assert.match(plan[0].body, /Biology \(2\)\nChemistry \(1\)/);
  assert.match(plan[0].body, /http:\/\/localhost:\d+\/#\/review/);
  const due = new Date(plan[0].due);
  assert.equal(`${due.getHours()}:${due.getMinutes()}`, "9:30");
  assert.equal(plan[1].name, "ONSEI_LRN: review 1 card");
});

const plan = (days) => dailyPlan({ cards: days.map((d) => ({ docId: "d1", due: at(d) })), docs, time: "09:00", now: NOW });

test("diff: creates reminders for an empty list", () => {
  const ops = diffReminders({ existing: [], plan: plan([0, 1]), now: NOW });
  assert.deepEqual(ops.map((o) => o.type), ["create", "create"]);
});

test("diff: unchanged reminders produce no operations (no repeated notifications)", () => {
  const p = plan([0, 1]);
  const existing = p.map((x, i) => ({ id: `r${i}`, name: x.name, body: x.body, due: x.due, completed: false }));
  assert.deepEqual(diffReminders({ existing, plan: p, now: NOW }), []);
});

test("diff: a changed count updates in place", () => {
  const p = plan([0, 0]);
  const existing = [{ id: "r0", name: "ONSEI_LRN: review 1 card", body: "old", due: p[0].due, completed: false }];
  const ops = diffReminders({ existing, plan: p, now: NOW });
  assert.equal(ops.length, 1);
  assert.equal(ops[0].type, "update");
  assert.equal(ops[0].name, "ONSEI_LRN: review 2 cards");
  assert.equal(ops[0].due, undefined, "same time, due date untouched");
});

test("diff: finishing today's reviews completes today's reminder; future days that vanish are deleted", () => {
  const today = Date.parse(at(0, 9));
  const later = Date.parse(at(3, 9));
  const existing = [
    { id: "t", name: "x", body: "", due: today, completed: false },
    { id: "f", name: "x", body: "", due: later, completed: false },
  ];
  const ops = diffReminders({ existing, plan: [], now: NOW });
  assert.deepEqual(ops, [
    { type: "complete", id: "t" },
    { type: "delete", id: "f" },
  ]);
});

test("diff: yesterday's open reminder is removed when its cards roll into today", () => {
  const existing = [{ id: "y", name: "x", body: "", due: Date.parse(at(-1, 9)), completed: false }];
  const ops = diffReminders({ existing, plan: plan([0]), now: NOW });
  assert.deepEqual(ops.map((o) => o.type).sort(), ["create", "delete"]);
});

test("diff: does not bring back today's reminder after you completed it", () => {
  const p = plan([0]);
  const existing = [{ id: "done", name: p[0].name, body: p[0].body, due: p[0].due, completed: true }];
  assert.deepEqual(diffReminders({ existing, plan: p, now: NOW }), []);
});

test("diff: duplicates for the same day are cleaned up; changed time moves the due date", () => {
  const p = dailyPlan({ cards: [{ docId: "d1", due: at(1) }], docs, time: "07:15", now: NOW });
  const old = Date.parse(at(1, 9));
  const existing = [
    { id: "a", name: p[0].name, body: p[0].body, due: old, completed: false },
    { id: "b", name: p[0].name, body: p[0].body, due: old, completed: false },
  ];
  const ops = diffReminders({ existing, plan: p, now: NOW });
  assert.deepEqual(ops, [
    { type: "update", id: "a", due: p[0].due },
    { type: "delete", id: "b" },
  ]);
});

test("calendar feed is valid iCalendar with CRLF lines of at most 75 octets", () => {
  db.docs = [{ id: "d1", title: "A very long deck title, with commas; semicolons and a backslash \\ that needs escaping ".repeat(2) }];
  db.cards = [{ docId: "d1", due: new Date(Date.now() + DAY).toISOString() }];
  const ics = calendarFeed();
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n"));
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
  assert.ok(!/[^\r]\n/.test(ics), "only CRLF line endings");
  for (const line of ics.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75, line);
  assert.match(ics, /BEGIN:VEVENT[\s\S]*BEGIN:VALARM[\s\S]*END:VEVENT/);
  const unfolded = ics.replace(/\r\n /g, "");
  assert.match(unfolded, /DESCRIPTION:A very long deck title\\, with commas\\; semicolons and a backslash \\\\ that/);
  assert.match(unfolded, /SUMMARY:ONSEI_LRN: review 1 card/);
});
