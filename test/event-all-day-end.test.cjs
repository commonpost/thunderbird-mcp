// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";
// createEvent with allDay: endDate is the last day of the event, as listEvents returns it and updateEvent takes it.
// The iCal DTEND of an all-day event is exclusive, so createEvent stores the day after. A date-only value is a local
// calendar day (parseDateArg), also west of Greenwich, where midnight UTC is still the day before: the tests run in
// Montreal time. Runs the real createEvent of api.js against stand-ins for the calendar service.
process.env.TZ = "America/Montreal";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const API = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");

function region(name) {
  const start = API.indexOf(`// BEGIN ${name}`);
  const end = API.indexOf(`// END ${name}`, start);
  assert.ok(start >= 0 && end > start, `${name} markers missing`);
  return API.slice(start, end);
}

function fn(name) {
  const indent = "            ";
  const start = API.indexOf(`\n${indent}async function ${name}(`);
  assert.ok(start >= 0, `${name} not found in api.js`);
  const close = `\n${indent}}\n`;
  const end = API.indexOf(close, start);
  assert.ok(end > start, `end of ${name} not found in api.js`);
  return API.slice(start, end + close.length);
}

// A calIDateTime reduced to what createEvent uses: resetTo, isDate and compare.
class DateTime {
  resetTo(year, month, day, hour, minute, second, timezone) {
    Object.assign(this, { year, month, day, hour, minute, second, timezone });
  }
  compare(other) {
    const key = (d) => d.year * 10000 + d.month * 100 + d.day;
    return Math.sign(key(this) - key(other));
  }
  get ymd() {
    return `${this.year}-${String(this.month + 1).padStart(2, "0")}-${String(this.day).padStart(2, "0")}`;
  }
}

function load() {
  const added = [];
  const calendar = { id: "cal1", name: "Home", readOnly: false, addItem: async (item) => { added.push(item); } };
  const sandbox = {
    cal: {
      createDateTime: () => new DateTime(),
      dtz: { floating: "floating", defaultTimezone: "UTC", jsDateToDateTime: (d) => ({ js: d }) },
    },
    CalEvent: class {
      constructor() { this.props = {}; }
      setProperty(k, v) { this.props[k] = v; }
      setCategories(c) { this.categories = c; }
    },
    CalAlarm: null,
    Services: { wm: { getMostRecentWindow: () => ({ openDialog() {} }) } },
    isCalendarSkipReviewBlocked: () => false,
    stripEmailContentMarkers: (s) => s,
    normalizeEventStatus: (s) => s.toUpperCase(),
    getAccessibleCalendars: () => [calendar],
    isCalendarDisabled: () => false,
    disabledCalendarError: () => "disabled",
    pickDefaultWriteCalendar: (cals) => ({ calendar: cals[0] }),
    normalizeReminderMinutes: () => ({ minutes: [] }),
  };
  vm.createContext(sandbox);
  vm.runInContext(`${region("EVENT RANGE HELPERS")}\n${fn("createEvent")}\nthis.createEvent = createEvent;\nthis.parseDateArg = parseDateArg;`, sandbox);
  const create = (startDate, endDate) =>
    sandbox.createEvent("Trip", startDate, endDate, undefined, undefined, undefined, true, true);
  return { create, added, parseDateArg: sandbox.parseDateArg };
}

describe("createEvent: the end of an all-day event", () => {
  it("takes endDate as the last day: 12 to 14 December is stored with DTEND on the 15th", async () => {
    const { create, added } = load();
    const result = await create("2026-12-12", "2026-12-14");
    assert.equal(result.success, true, JSON.stringify(result));
    const [event] = added;
    assert.equal(event.startDate.ymd, "2026-12-12");
    assert.equal(event.startDate.isDate, true);
    assert.equal(event.endDate.ymd, "2026-12-15");
    assert.equal(event.endDate.isDate, true);
  });

  it("stores one day when endDate is the start day, and when it is omitted", async () => {
    const { create, added } = load();
    await create("2026-12-12", "2026-12-12");
    await create("2026-12-12");
    assert.deepEqual(added.map((e) => [e.startDate.ymd, e.endDate.ymd]), [["2026-12-12", "2026-12-13"], ["2026-12-12", "2026-12-13"]]);
  });

  it("crosses the end of a month and of a year", async () => {
    const { create, added } = load();
    await create("2026-11-29", "2026-11-30");
    await create("2026-12-30", "2026-12-31");
    assert.deepEqual(added.map((e) => e.endDate.ymd), ["2026-12-01", "2027-01-01"]);
  });

  it("refuses an endDate before the start day", async () => {
    const { create, added } = load();
    assert.deepEqual({ ...await create("2026-12-12", "2026-12-11") }, { error: "endDate must not be before startDate" });
    assert.equal(added.length, 0);
  });

  it("reads a date-only value as that day in local time, not as midnight UTC (the day before in Montreal)", async () => {
    const { create, added } = load();
    await create("2026-12-12", "2026-12-12");
    assert.equal(added[0].startDate.ymd, "2026-12-12");
    // A date with a time is an instant: 03:00 UTC on the 12th is still the 11th in Montreal.
    await create("2026-12-12T03:00:00Z");
    assert.equal(added[1].startDate.ymd, "2026-12-11");
  });
});

describe("parseDateArg", () => {
  const { parseDateArg } = load();
  const local = (d) => [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()];

  it("gives local midnight for a date-only value, spaces allowed", () => {
    assert.deepEqual(local(parseDateArg("2026-12-12")), [2026, 12, 12, 0, 0]);
    assert.deepEqual(local(parseDateArg(" 2026-03-08 ")), [2026, 3, 8, 0, 0]);
  });

  it("reads anything else as Date does", () => {
    assert.equal(parseDateArg("2026-12-12T15:30:00Z").getTime(), Date.UTC(2026, 11, 12, 15, 30));
    assert.deepEqual(local(parseDateArg("2026-12-12T15:30:00")), [2026, 12, 12, 15, 30]);
  });

  it("gives an invalid date for an impossible day or a value that is not a date", () => {
    assert.ok(isNaN(parseDateArg("2026-02-30").getTime()));
    assert.ok(isNaN(parseDateArg("tomorrow").getTime()));
  });
});
