// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";
// updateTask: start date, categories and reminders. The real functions of api.js run against stand-ins for a
// calendar and a task. Task reminders count from the due date (TRIGGER;RELATED=END): Thunderbird stores them so,
// and without a due date they never go off, so a reminder with no due date is refused.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const API = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");

function fn(name) {
  const indent = "            ";
  let start = API.indexOf(`\n${indent}async function ${name}(`);
  if (start < 0) start = API.indexOf(`\n${indent}function ${name}(`);
  assert.ok(start >= 0, `${name} not found in api.js`);
  const close = `\n${indent}}\n`;
  const end = API.indexOf(close, start);
  return API.slice(start, end + close.length);
}
function region(name) {
  const start = API.indexOf(`// BEGIN ${name}`);
  const end = API.indexOf(`// END ${name}`, start);
  assert.ok(start >= 0 && end > start, `${name} markers missing`);
  return API.slice(start, end);
}

const START = 0;
const END = 1;
// A date-time: minutes since an origin, enough for compare() and for reading it back.
const at = (iso) => ({ ms: new Date(iso).getTime(), iso, isDate: false, compare(o) { return Math.sign(this.ms - o.ms); } });

function duration() {
  return {
    minutes: 0, isNegative: false, normalize() {},
    get inSeconds() { return (this.isNegative ? -1 : 1) * this.minutes * 60; },
  };
}
function alarm(related, minutesBefore) {
  const offset = duration();
  offset.minutes = minutesBefore; offset.isNegative = minutesBefore > 0;
  return { action: "DISPLAY", related, offset };
}

function todo({ due = null, entry = null, categories = [], alarms = [] } = {}) {
  const t = {
    id: "t1", title: "Report", isTodo: () => true, dueDate: due, entryDate: entry, priority: 0, percentComplete: 0,
    categories, alarms, props: new Map(), recurrenceInfo: null, alarmLastAck: null,
    getCategories() { return [...this.categories]; }, setCategories(c) { this.categories = [...c]; },
    getAlarms() { return [...this.alarms]; }, clearAlarms() { this.alarms = []; }, addAlarm(a) { this.alarms.push(a); },
    get properties() { return [...this.props.entries()]; },
    getProperty(k) { return this.props.get(k) ?? null; }, setProperty(k, v) { this.props.set(k, v); }, deleteProperty(k) { this.props.delete(k); },
    clone() { return todo({ due: this.dueDate, entry: this.entryDate, categories: [...this.categories], alarms: [...this.alarms] }); },
  };
  return t;
}

function load(item) {
  const modified = [];
  const calendar = {
    id: "cal1", name: "Home", readOnly: false,
    getProperty: () => undefined,
    getItem: async (id) => (id === item.id ? item : null),
    modifyItem: async (n) => { modified.push(n); },
  };
  const sandbox = {
    Ci: { calIAlarm: { ALARM_RELATED_START: START, ALARM_RELATED_END: END } },
    CalAlarm: class { constructor() { this.action = null; this.related = null; this.offset = null; } },
    cal: {
      createDuration: duration,
      createDateTime: () => ({ resetTo(y, m, d) { Object.assign(this, at(new Date(y, m, d).toISOString())); } }),
      dtz: { defaultTimezone: {}, floating: {}, jsDateToDateTime: (js) => at(js.toISOString()) },
    },
    parseDateArg: (v) => new Date(v),
    stripEmailContentMarkers: (v) => v,
    descriptionToHTML: (v) => v,
    calDateToLocalISO: (d) => (d ? d.iso : null),
    getAccessibleCalendars: () => [calendar],
  };
  vm.createContext(sandbox);
  vm.runInContext(`${region("EVENT REMINDER HELPERS")}
${["findTaskItem", "updateTask", "formatTask", "taskReminderMinutes", "itemReminderMinutes", "taskDateArg", "taskDatesError",
    "buildDisplayReminder", "replaceDisplayReminders"].map(fn).join("\n")}
this.updateTask = updateTask;`, sandbox);
  const update = (fields) => sandbox.updateTask("t1", "cal1", fields.title, fields.dueDate, undefined, undefined, undefined,
    undefined, fields.startDate, fields.categories, fields.reminders).then((r) => JSON.parse(JSON.stringify(r)));
  return { update, modified };
}

const reminderView = (item) => item.alarms.map((a) => [a.related === END ? "END" : "START", a.offset.inSeconds / 60]);

describe("updateTask: start date, categories, reminders", () => {
  it("sets them; the reminders count from the due date, and the result reads them back", async () => {
    const { update, modified } = load(todo({ due: at("2026-11-20T17:00:00Z") }));
    const r = await update({ startDate: "2026-11-18T09:00:00Z", categories: ["Work"], reminders: [60, 1440] });
    assert.deepEqual(r.updated, ["startDate", "categories", "reminders"]);
    assert.deepEqual([r.task.startDate, r.task.categories, r.task.reminders], ["2026-11-18T09:00:00.000Z", ["Work"], [1440, 60]]);
    assert.deepEqual(reminderView(modified[0]), [["END", -1440], ["END", -60]]);
  });

  it("'' clears the start date and [] the categories and reminders", async () => {
    const item = todo({ due: at("2026-11-20T17:00:00Z"), entry: at("2026-11-18T09:00:00Z"), categories: ["Work"], alarms: [alarm(END, 30)] });
    const { update, modified } = load(item);
    const r = await update({ startDate: "", categories: [], reminders: [] });
    assert.deepEqual([r.task.startDate, r.task.categories, r.task.reminders], [null, [], []]);
    assert.equal(modified[0].alarms.length, 0);
  });

  it("keeps an alarm it does not manage (one before the start, set in Thunderbird)", async () => {
    const { update, modified } = load(todo({ due: at("2026-11-20T17:00:00Z"), alarms: [alarm(START, 15), alarm(END, 30)] }));
    await update({ reminders: [10] });
    assert.deepEqual(reminderView(modified[0]), [["START", -15], ["END", -10]]);
  });

  it("refuses a reminder for a task with no due date, and changes nothing", async () => {
    const { update, modified } = load(todo());
    assert.deepEqual(await update({ reminders: [10] }), { error: "Task reminders count from the due date: give the task a dueDate" });
    assert.equal(modified.length, 0);
  });

  it("refuses to clear the due date while reminders count from it, unless they go too", async () => {
    const { update, modified } = load(todo({ due: at("2026-11-20T17:00:00Z"), alarms: [alarm(END, 30)] }));
    assert.match((await update({ dueDate: "" })).error, /reminders count from its due date: pass reminders: \[\]/);
    assert.equal(modified.length, 0);
    const r = await update({ dueDate: "", reminders: [] });
    assert.deepEqual(r.updated, ["dueDate", "reminders"]);
  });

  it("refuses a due date before the start, as Thunderbird's dialog does", async () => {
    const { update, modified } = load(todo({ due: at("2026-11-20T17:00:00Z") }));
    assert.deepEqual(await update({ startDate: "2026-11-22T09:00:00Z" }), { error: "dueDate must not be before startDate" });
    assert.equal(modified.length, 0);
  });

  it("refuses a start date it cannot read", async () => {
    const { update } = load(todo());
    assert.deepEqual(await update({ startDate: "soon" }), { error: "Invalid startDate: soon" });
  });

  it("says what the minutes count from in a wrong reminder", async () => {
    const { update } = load(todo({ due: at("2026-11-20T17:00:00Z") }));
    assert.match((await update({ reminders: [-5] })).error, /minutes before the due date/);
  });
});
