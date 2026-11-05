// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";
// deleteTask: the real function of api.js (and findTaskItem, shared with updateTask) against stand-ins for a
// calendar. It deletes a task without a review dialog, like deleteEvent, and refuses an event's id.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const API = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");

function fn(name) {
  const indent = "            ";
  const start = API.indexOf(`\n${indent}async function ${name}(`);
  assert.ok(start >= 0, `${name} not found in api.js`);
  const close = `\n${indent}}\n`;
  const end = API.indexOf(close, start);
  assert.ok(end > start, `end of ${name} not found in api.js`);
  return API.slice(start, end + close.length);
}

const task = (id, extra = {}) => ({ id, isTodo: () => true, isEvent: () => false, ...extra });
const event = (id) => ({ id, isTodo: () => false, isEvent: () => true });

// A calendar holding `items`; getItem finds events and tasks alike, getItemsAsArray (the task filter) only tasks.
function calendar({ items = [], readOnly = false, tasks = true, getItem = true, asArray = true, deleteError = null } = {}) {
  const deleted = [];
  const c = {
    id: "cal1", name: "Home", readOnly, deleted,
    getProperty: (name) => (name === "capabilities.tasks.supported" ? tasks : undefined),
    deleteItem: async (item) => {
      if (deleteError) throw new Error(deleteError);
      deleted.push(item.id);
    },
  };
  if (getItem) c.getItem = async (id) => items.find((i) => i.id === id) || null;
  const todos = () => items.filter((i) => typeof i.isTodo !== "function" || i.isTodo());
  if (asArray) c.getItemsAsArray = async () => todos();
  else c.getItems = () => "stream";
  c.todos = todos;
  return c;
}

function load(calendars, { calAvailable = true } = {}) {
  const sandbox = {
    cal: calAvailable ? {
      iterate: {
        // Thunderbird yields chunks of items
        streamValues: () => (async function* () { yield calendars[0].todos(); })(),
      },
    } : null,
    getAccessibleCalendars: () => calendars,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${fn("findTaskItem")}\n${fn("deleteTask")}\nthis.deleteTask = deleteTask;`, sandbox);
  return (taskId, calendarId) => sandbox.deleteTask(taskId, calendarId).then((r) => JSON.parse(JSON.stringify(r)));
}

describe("deleteTask", () => {
  it("deletes the task found by id and says which", async () => {
    const c = calendar({ items: [task("t1"), task("t2")] });
    assert.deepEqual(await load([c])("t1", "cal1"), { success: true, deleted: "t1" });
    assert.deepEqual(c.deleted, ["t1"]);
  });

  it("warns that the whole series went for a recurring task", async () => {
    const c = calendar({ items: [task("t1", { recurrenceInfo: {} })] });
    const result = await load([c])("t1", "cal1");
    assert.equal(result.success, true);
    assert.match(result.warning, /recurring task -- the entire series was deleted/);
  });

  it("refuses an event's id: getItem finds events too", async () => {
    const c = calendar({ items: [event("e1"), task("t1")] });
    assert.deepEqual(await load([c])("e1", "cal1"), { error: "Task not found: e1" });
    assert.deepEqual(c.deleted, []);
  });

  it("falls back to the task list without getItem, as an array or a stream", async () => {
    for (const asArray of [true, false]) {
      const c = calendar({ items: [task("t1")], getItem: false, asArray });
      assert.deepEqual(await load([c])("t1", "cal1"), { success: true, deleted: "t1" }, `asArray ${asArray}`);
    }
  });

  it("confirms with the task list when the item cannot say whether it is a task", async () => {
    const odd = { id: "x1" };
    const c = calendar({ items: [odd] });
    assert.deepEqual(await load([c])("x1", "cal1"), { success: true, deleted: "x1" });
    const missing = calendar({ items: [] });
    missing.getItem = async () => ({ id: "x2" });
    assert.deepEqual(await load([missing])("x2", "cal1"), { error: "Task not found: x2" });
  });

  it("says a task was not found, and a lookup that throws counts as not found", async () => {
    const c = calendar({ items: [task("t1")] });
    c.getItem = async () => { throw new Error("NS_ERROR_FAILURE"); };
    assert.deepEqual(await load([c])("t9", "cal1"), { error: "Task not found: t9" });
    assert.deepEqual(await load([c])("t1", "cal1"), { success: true, deleted: "t1" });
  });

  it("needs both ids, an accessible writable calendar that supports tasks", async () => {
    const c = calendar({ items: [task("t1")] });
    const del = load([c]);
    assert.deepEqual(await del("", "cal1"), { error: "taskId is required" });
    assert.deepEqual(await del("t1", undefined), { error: "calendarId is required" });
    assert.deepEqual(await del("t1", "other"), { error: "Calendar not found: other" });
    assert.deepEqual(await load([calendar({ readOnly: true })])("t1", "cal1"), { error: "Calendar is read-only: Home" });
    assert.match((await load([calendar({ tasks: false })])("t1", "cal1")).error, /does not support tasks/);
    assert.deepEqual(c.deleted, []);
  });

  it("reports a failed deletion as an error", async () => {
    const c = calendar({ items: [task("t1")], deleteError: "NS_ERROR_NOT_AVAILABLE" });
    assert.match((await load([c])("t1", "cal1")).error, /NS_ERROR_NOT_AVAILABLE/);
  });

  it("needs the calendar module", async () => {
    assert.deepEqual(await load([calendar()], { calAvailable: false })("t1", "cal1"), { error: "Calendar not available" });
  });
});

describe("updateTask shares the task lookup", () => {
  it("refuses an event's id instead of editing the event", async () => {
    const c = calendar({ items: [event("e1")] });
    const sandbox = { cal: {}, getAccessibleCalendars: () => [c] };
    vm.createContext(sandbox);
    vm.runInContext(`${fn("findTaskItem")}\n${fn("updateTask")}\nthis.updateTask = updateTask;`, sandbox);
    const result = await sandbox.updateTask("e1", "cal1", "New title");
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { error: "Task not found: e1" });
  });
});
