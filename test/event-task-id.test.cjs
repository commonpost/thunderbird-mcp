// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";
// updateEvent and deleteEvent through findEventItem, the real functions of api.js against stand-ins for a calendar:
// getItem finds tasks too, so a task's id must not reach them. Otherwise an assistant could change or delete a task
// through the event tools while the tool settings keep updateTask or deleteTask disabled.
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

const task = (id) => ({ id, isTodo: () => true, isEvent: () => false, title: "Task" });
const event = (id, extra = {}) => ({ id, isTodo: () => false, isEvent: () => true, title: "Event", ...extra });

// A calendar holding `items`; getItem finds events and tasks alike, getItemsAsArray (the event filter) only events.
function calendar({ items = [], getItem = true } = {}) {
  const deleted = [];
  const modified = [];
  const c = {
    id: "cal1", name: "Home", readOnly: false, deleted, modified,
    deleteItem: async (item) => { deleted.push(item.id); },
    modifyItem: async (newItem) => { modified.push(newItem.id); return newItem; },
    getItemsAsArray: async () => items.filter((i) => typeof i.isEvent !== "function" || i.isEvent()),
  };
  if (getItem) c.getItem = async (id) => items.find((i) => i.id === id) || null;
  return c;
}

function load(c) {
  const sandbox = { cal: {}, getAccessibleCalendars: () => [c] };
  vm.createContext(sandbox);
  vm.runInContext(`${fn("getCalendarItems")}\n${fn("findEventItem")}\n${fn("deleteEvent")}\n${fn("updateEvent")}
this.deleteEvent = deleteEvent; this.updateEvent = updateEvent; this.findEventItem = findEventItem;`, sandbox);
  const plain = (r) => JSON.parse(JSON.stringify(r));
  return {
    deleteEvent: (id) => sandbox.deleteEvent(id, "cal1").then(plain),
    updateEvent: (id, title) => sandbox.updateEvent(id, "cal1", title).then(plain),
    findEventItem: (id) => sandbox.findEventItem(c, id),
  };
}

describe("deleteEvent and updateEvent refuse a task's id", () => {
  it("deleteEvent: a task found by getItem is not deleted", async () => {
    const c = calendar({ items: [task("t1"), event("e1")] });
    assert.deepEqual(await load(c).deleteEvent("t1"), { error: "Event not found: t1" });
    assert.deepEqual(c.deleted, []);
  });

  it("updateEvent: a task found by getItem is not changed", async () => {
    const c = calendar({ items: [task("t1")] });
    assert.deepEqual(await load(c).updateEvent("t1", "Renamed"), { error: "Event not found: t1" });
    assert.deepEqual(c.modified, []);
  });

  it("deleteEvent still deletes an event, found by getItem or by the scan of events", async () => {
    const c = calendar({ items: [event("e1"), event("e2")] });
    assert.deepEqual(await load(c).deleteEvent("e1"), { success: true, deleted: "e1" });
    const scan = calendar({ items: [event("e2")], getItem: false });
    assert.deepEqual(await load(scan).deleteEvent("e2"), { success: true, deleted: "e2" });
    assert.deepEqual([c.deleted, scan.deleted], [["e1"], ["e2"]]);
  });

  it("without getItem, the scan sees only events, so a task's id is not found", async () => {
    const c = calendar({ items: [task("t1")], getItem: false });
    assert.equal(await load(c).findEventItem("t1"), null);
  });

  it("an item without isEvent falls back to the scan of events", async () => {
    const odd = { id: "x1" };
    const c = calendar({ items: [odd] });
    c.getItemsAsArray = async () => [];
    assert.equal(await load(c).findEventItem("x1"), null);
    c.getItemsAsArray = async () => [odd];
    assert.equal(await load(c).findEventItem("x1"), odd);
  });
});
