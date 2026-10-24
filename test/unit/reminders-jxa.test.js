// Runs the JavaScript-for-Automation scripts against a fake Reminders app that mimics the JXA API
import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempData } from "../helpers.js";

useTempData();
const { READ_SCRIPT, APPLY_SCRIPT } = await import("../../lib/reminders.js");

function fakeReminders(initialLists = {}) {
  let nextId = 1;
  const lists = Object.entries(initialLists).map(([name, items]) => ({ name, items: items.map((r) => ({ id: `x-apple-reminder://${nextId++}`, ...r })) }));
  const collection = (getItems) => {
    const fn = () => getItems();
    // like JXA, collection.name() returns every item's name (functions have a read-only `name`, hence defineProperty)
    for (const prop of ["id", "name", "body", "dueDate", "completed"]) {
      Object.defineProperty(fn, prop, { value: () => getItems().map((r) => r[prop] ?? null) });
    }
    fn.push = (spec) => getItems().push({ id: `x-apple-reminder://${nextId++}`, completed: false, ...spec.props });
    fn.byId = (id) => {
      const find = () => getItems().find((r) => r.id === id) || (() => { throw new Error("Can't get reminder"); })();
      return new Proxy({}, {
        get: (_, k) => (k === "__item" ? find() : find()[k]),
        set: (_, k, v) => ((find()[k] = v), true),
      });
    };
    return fn;
  };
  const listObj = (l) => ({ name: () => l.name, reminders: collection(() => l.items) });
  const app = {
    lists: {
      whose: ({ name }) => {
        const found = lists.filter((l) => l.name === name).map(listObj);
        return found;
      },
      push: (spec) => lists.push({ name: spec.props.name, items: [] }),
    },
    make: ({ new: kind, withProperties }) => {
      if (kind !== "list") throw new Error("unsupported");
      lists.push({ name: withProperties.name, items: [] });
    },
    List: (props) => ({ props }),
    Reminder: (props) => ({ props }),
    delete: (proxy) => {
      const item = proxy.__item;
      for (const l of lists) l.items = l.items.filter((r) => r !== item);
    },
  };
  return { app, lists };
}

const run = (script, app, arg) => {
  // eslint-disable-next-line no-new-func
  const fn = new Function("Application", `${script}\nreturn run;`)(() => app);
  return fn([JSON.stringify(arg)]);
};

test("read: missing list, then items with due dates as epoch ms", () => {
  const { app } = fakeReminders({ ONSEI_LRN: [{ name: "a", body: null, dueDate: new Date(1700000000000), completed: false }, { name: "b", body: "x", dueDate: null, completed: true }] });
  assert.deepEqual(JSON.parse(run(READ_SCRIPT, app, { list: "Other" })), { exists: false, items: [] });
  const r = JSON.parse(run(READ_SCRIPT, app, { list: "ONSEI_LRN" }));
  assert.equal(r.exists, true);
  assert.deepEqual(r.items.map((i) => [i.name, i.body, i.due, i.completed]), [
    ["a", "", 1700000000000, false],
    ["b", "x", null, true],
  ]);
});

test("apply: creates the list when missing, then create/update/complete/delete", () => {
  const { app, lists } = fakeReminders({});
  run(APPLY_SCRIPT, app, { list: "ONSEI_LRN", ops: [{ type: "create", name: "n1", body: "b1", due: 1700000000000 }, { type: "create", name: "n2", body: "b2", due: 1700086400000 }] });
  assert.equal(lists.length, 1);
  const items = lists[0].items;
  assert.deepEqual(items.map((i) => i.name), ["n1", "n2"]);
  assert.ok(items[0].dueDate instanceof Date && items[0].dueDate.getTime() === 1700000000000);

  const [a, b] = items.map((i) => i.id);
  run(APPLY_SCRIPT, app, {
    list: "ONSEI_LRN",
    ops: [
      { type: "update", id: a, name: "n1b", due: 1700001000000 },
      { type: "complete", id: b },
    ],
  });
  assert.equal(lists[0].items[0].name, "n1b");
  assert.equal(lists[0].items[0].body, "b1", "fields not in the update are untouched");
  assert.equal(lists[0].items[0].dueDate.getTime(), 1700001000000);
  assert.equal(lists[0].items[1].completed, true);

  run(APPLY_SCRIPT, app, { list: "ONSEI_LRN", ops: [{ type: "delete", id: a }] });
  assert.deepEqual(lists[0].items.map((i) => i.name), ["n2"]);
  assert.equal(lists.length, 1, "list is not created twice");
});
