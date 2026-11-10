// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";
// listEvents eventId / listTasks taskId: getCalendarItemById of api.js (with the real findEventItem and findTaskItem)
// against stand-ins for calendars. One item, in the list's row format; an event id is not a task, and the reverse.
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

const task = (id) => ({ id, isTodo: () => true, isEvent: () => false });
const event = (id) => ({ id, isTodo: () => false, isEvent: () => true });

function calendar(id, items, { tasks = true } = {}) {
  return {
    id, name: id,
    getProperty: (name) => (name === "capabilities.tasks.supported" ? tasks : undefined),
    getItem: async (itemId) => items.find((i) => i.id === itemId) || null,
    getItemsAsArray: async () => items.filter((i) => i.isTodo()),
  };
}

function load(calendars, { calAvailable = true } = {}) {
  const sandbox = {
    cal: calAvailable ? { iterate: { streamValues: () => (async function* () {})() } } : null,
    getAccessibleCalendars: () => calendars,
    getCalendarItems: async () => [],
    formatEvent: (item, c) => ({ kind: "event", id: item.id, calendarId: c.id }),
    formatTask: (item, c) => ({ kind: "task", id: item.id, calendarId: c.id }),
  };
  vm.createContext(sandbox);
  vm.runInContext(`${fn("findEventItem")}\n${fn("findTaskItem")}\n${fn("getCalendarItemById")}\nthis.byId = getCalendarItemById;`, sandbox);
  return (...args) => sandbox.byId(...args).then((r) => JSON.parse(JSON.stringify(r)));
}

describe("one calendar item by id", () => {
  const work = calendar("work", [event("e1"), task("t1")]);
  const home = calendar("home", [event("e2")]);

  it("finds an event in any accessible calendar, as a one-row list", async () => {
    assert.deepEqual(await load([work, home])("event", "e2"), [{ kind: "event", id: "e2", calendarId: "home" }]);
  });

  it("finds a task, and only in the calendar named when there is one", async () => {
    const byId = load([work, home]);
    assert.deepEqual(await byId("task", "t1"), [{ kind: "task", id: "t1", calendarId: "work" }]);
    assert.deepEqual(await byId("task", "t1", "home"), { error: "Task not found: t1" });
    assert.deepEqual(await byId("event", "e1", "nope"), { error: "Calendar not found: nope" });
  });

  it("does not return a task for an eventId, nor an event for a taskId", async () => {
    const byId = load([work]);
    assert.match((await byId("event", "t1")).error, /^Event not found: t1/);
    assert.match((await byId("task", "e1")).error, /^Task not found: e1/);
  });

  it("refuses an empty id and works only with the calendar", async () => {
    assert.deepEqual(await load([work])("event", "  "), { error: "eventId must be a non-empty string" });
    assert.deepEqual(await load([work])("task", 7), { error: "taskId must be a non-empty string" });
    assert.deepEqual(await load([work], { calAvailable: false })("event", "e1"), { error: "Calendar not available" });
  });

  it("skips calendars without tasks when looking for a task", async () => {
    const noTasks = calendar("events-only", [task("t9")], { tasks: false });
    assert.match((await load([noTasks])("task", "t9")).error, /^Task not found/);
  });
});
