// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";
// Event and task times are returned as the calendar shows them, with their offset (api.js, CAL LOCAL ISO block).

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const api = fs.readFileSync(path.join(__dirname, "..", "extension/mcp_server/api.js"), "utf8");
const a = api.indexOf("// BEGIN CAL LOCAL ISO");
const b = api.indexOf("// END CAL LOCAL ISO");
assert.ok(a >= 0 && b > a, "CAL LOCAL ISO block missing");
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(`${api.slice(a, b)}\nthis.format = formatDateTimeWithOffset; this.mail = localISOFromMs;`, sandbox);
const dt = (year, month, day, hour, minute, second, timezoneOffset) => ({ year, month, day, hour, minute, second, timezoneOffset });

describe("formatDateTimeWithOffset", () => {
  it("writes the wall-clock time with a negative offset; month is 0-based", () => {
    assert.equal(sandbox.format(dt(2026, 10, 12, 9, 30, 0, -18000)), "2026-11-12T09:30:00-05:00");
  });
  it("writes a positive offset, and a half-hour one", () => {
    assert.equal(sandbox.format(dt(2026, 6, 1, 18, 5, 7, 7200)), "2026-07-01T18:05:07+02:00");
    assert.equal(sandbox.format(dt(2026, 0, 31, 23, 59, 59, 19800)), "2026-01-31T23:59:59+05:30");
    assert.equal(sandbox.format(dt(2026, 0, 2, 0, 0, 0, -12600)), "2026-01-02T00:00:00-03:30");
  });
  it("writes UTC as it always did", () => {
    assert.equal(sandbox.format(dt(2026, 2, 3, 4, 5, 6, 0)), "2026-03-03T04:05:06.000Z");
  });
  it("denotes the same instant as the UTC value", () => {
    assert.equal(new Date(sandbox.format(dt(2026, 10, 12, 9, 30, 0, -18000))).toISOString(), "2026-11-12T14:30:00.000Z");
  });
});

describe("the calendar results use it", () => {
  for (const line of ["startDate: calDateToLocalISO(item.startDate)", "dueDate: calDateToLocalISO(item.dueDate)",
    "startDate: calDateToLocalISO(item.entryDate)", "completedDate: calDateToLocalISO(item.completedDate)", "let endDateISO = calDateToLocalISO(item.endDate)"]) {
    it(line, () => assert.ok(api.includes(line)));
  }
});

describe("localISOFromMs (mail dates)", () => {
  const at = (tz, fn) => { const old = process.env.TZ; process.env.TZ = tz; try { return fn(); } finally { if (old === undefined) delete process.env.TZ; else process.env.TZ = old; } };
  const ms = Date.UTC(2026, 10, 9, 6, 40, 0);
  it("writes the user's clock with its offset", () => {
    assert.equal(at("America/Toronto", () => sandbox.mail(ms)), "2026-11-09T01:40:00-05:00");
    assert.equal(at("Europe/Paris", () => sandbox.mail(ms)), "2026-11-09T07:40:00+01:00");
  });
  it("keeps the UTC form in UTC, and the same instant everywhere", () => {
    assert.equal(at("UTC", () => sandbox.mail(ms)), "2026-11-09T06:40:00.000Z");
    assert.equal(new Date(at("Asia/Kolkata", () => sandbox.mail(ms))).getTime(), ms);
  });
  it("crosses a daylight-saving change with the right offset", () => {
    assert.equal(at("America/Toronto", () => sandbox.mail(Date.UTC(2026, 9, 28, 14, 0, 0))), "2026-10-28T10:00:00-04:00");
  });
});
