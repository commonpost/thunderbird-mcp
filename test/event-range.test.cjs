"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");
const start = source.indexOf("// BEGIN EVENT RANGE HELPERS");
const end = source.indexOf("// END EVENT RANGE HELPERS", start);
assert.ok(start >= 0 && end > start, "EVENT RANGE HELPERS markers missing");
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(`${source.slice(start, end)}\nthis.eventRangeBounds = eventRangeBounds;`, sandbox);
const { eventRangeBounds } = sandbox;

// Local-time parts of a Date made in the sandbox: the helper works in local time,
// so the test reads it the same way and passes in any timezone.
const parts = (d) => [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()];
const NOW = new Date(2026, 9, 2, 8, 30);

describe("listEvents range (eventRangeBounds)", () => {
  it("lists one whole day when startDate and endDate are the same date", () => {
    const r = eventRangeBounds("2026-10-15", "2026-10-15", NOW);
    assert.deepEqual(parts(r.startJs), [2026, 10, 15, 0, 0]);
    assert.deepEqual(parts(r.endJs), [2026, 10, 16, 0, 0]);
    assert.ok(r.endJs.getTime() > r.startJs.getTime(), "the range must not be empty");
  });

  it("includes the whole last day of a date-only endDate", () => {
    const r = eventRangeBounds("2026-10-15T09:00:00", "2026-10-31", NOW);
    assert.deepEqual(parts(r.startJs), [2026, 10, 15, 9, 0]);
    assert.deepEqual(parts(r.endJs), [2026, 11, 1, 0, 0]);
  });

  it("keeps a date with a time as the instant it names", () => {
    const r = eventRangeBounds("2026-10-15T00:00:00", "2026-10-15T23:59:59", NOW);
    assert.deepEqual(parts(r.startJs), [2026, 10, 15, 0, 0]);
    assert.deepEqual(parts(r.endJs), [2026, 10, 15, 23, 59]);
    assert.equal(eventRangeBounds("2026-10-15T12:00:00Z", undefined, NOW).startJs.getTime(), Date.UTC(2026, 9, 15, 12));
  });

  it("defaults to now and to 30 days after the start", () => {
    const r = eventRangeBounds(undefined, undefined, NOW);
    assert.equal(r.startJs.getTime(), NOW.getTime());
    assert.equal(r.endJs.getTime(), NOW.getTime() + 30 * 86400000);
    const day = eventRangeBounds("2026-10-15", undefined, NOW);
    assert.equal(day.endJs.getTime(), day.startJs.getTime() + 30 * 86400000);
  });

  it("tolerates spaces around a date-only value", () => {
    assert.deepEqual(parts(eventRangeBounds(" 2026-10-15 ", " 2026-10-15 ", NOW).endJs), [2026, 10, 16, 0, 0]);
  });

  it("refuses a value that is not a date, and a day that does not exist", () => {
    assert.equal(eventRangeBounds("tomorrow", undefined, NOW).error, "Invalid startDate: tomorrow");
    assert.equal(eventRangeBounds("2026-10-15", "soon", NOW).error, "Invalid endDate: soon");
    assert.equal(eventRangeBounds("2026-02-30", undefined, NOW).error, "Invalid startDate: 2026-02-30");
    assert.equal(eventRangeBounds("2026-10-15", "2026-13-01", NOW).error, "Invalid endDate: 2026-13-01");
  });

  it("is what listEvents uses", () => {
    const body = source.slice(source.indexOf("async function listEvents("), source.indexOf("async function listEvents(") + 1500);
    assert.match(body, /eventRangeBounds\(startDate, endDate, new Date\(\)\)/);
  });
});
