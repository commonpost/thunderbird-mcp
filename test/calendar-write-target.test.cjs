"use strict";

// createEvent and createTask write only to a calendar that is turned on.
// Thunderbird creates its default "Home" calendar disabled, and a disabled
// calendar accepts addItem but returns nothing to getItems, so writing to it
// reported success for an event or task nobody could see. The real
// createEvent/createTask code is run here against calendars that behave like
// Thunderbird's storage calendar.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const apiSource = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");

function slice(startMarker, endMarker) {
  const start = apiSource.indexOf(startMarker);
  const end = apiSource.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} missing`);
  return apiSource.slice(start, end);
}

const HELPERS_BEGIN = "// BEGIN CALENDAR WRITE TARGET HELPERS";
const HELPERS_END = "// END CALENDAR WRITE TARGET HELPERS";
const hasHelpers = apiSource.includes(HELPERS_BEGIN) && apiSource.includes(HELPERS_END);
const helpersSource = hasHelpers ? slice(HELPERS_BEGIN, HELPERS_END) : "";

// Like CalStorageCalendar: addItem succeeds whether or not the calendar is
// disabled, getItemsAsArray returns nothing while it is disabled.
function storageCalendar({ id, name, disabled = false, readOnly = false, tasks = true, throws = false }) {
  const items = [];
  return {
    id, name, type: "storage", readOnly, items,
    getProperty(key) {
      if (key === "disabled") {
        if (throws) throw new Error("unreadable");
        return disabled ? true : null;
      }
      if (key === "capabilities.tasks.supported") return tasks;
      return null;
    },
    async addItem(item) { items.push(item); return item; },
    async getItemsAsArray() { return disabled ? [] : items.slice(); },
  };
}

class FakeItem {
  constructor() { this.props = {}; }
  setProperty(k, v) { this.props[k] = v; }
  setCategories(c) { this.categories = c; }
}

// Runs createEvent/createTask with `accessible` as what getAccessibleCalendars()
// returns (the account restriction is applied there, not here).
function loadTools(accessible) {
  const sandbox = {
    cal: {
      dtz: { defaultTimezone: {}, floating: {}, jsDateToDateTime: (d) => ({ js: d }) },
      createDateTime: () => ({ resetTo() {} }),
    },
    CalEvent: FakeItem,
    CalTodo: FakeItem,
    Services: { wm: { getMostRecentWindow: () => null } },
    isSkipReviewBlocked: () => false,
    stripEmailContentMarkers: (v) => v,
    normalizeEventStatus: (s) => String(s).toUpperCase(),
    descriptionToHTML: (v) => v,
    getAccessibleCalendars: () => accessible,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${helpersSource}
${slice("async function createEvent(", "async function getCalendarItems(")}
${slice("async function createTask(", "// BEGIN RAW MIME PARSING HELPERS")}
this.api = { createEvent, createTask };`, sandbox);
  const { createEvent, createTask } = sandbox.api;
  return {
    event: (calendarId) => createEvent("t", "2026-10-15T14:00:00", "2026-10-15T15:00:00", undefined, undefined, calendarId, false, true),
    task: (calendarId) => createTask("t", "2026-10-20T10:00:00", calendarId, undefined, undefined, undefined, true),
  };
}

const plain = (v) => JSON.parse(JSON.stringify(v));

describe("createEvent / createTask with skipReview never write to a disabled calendar", () => {
  for (const kind of ["event", "task"]) {
    it(`${kind}: with Thunderbird's default Home calendar still disabled, refuses and writes nothing`, async () => {
      const home = storageCalendar({ id: "home", name: "Home", disabled: true });
      const result = plain(await loadTools([home])[kind]());
      assert.equal(home.items.length, 0, `written to a disabled calendar: ${JSON.stringify(result)}`);
      assert.equal(result.success, undefined);
      assert.match(result.error, /^No enabled writable (calendar|task-capable calendar) found: the only writable one is disabled/);
      assert.match(result.error, /Turn it on in Thunderbird's calendar list/);
    });

    it(`${kind}: skips a disabled calendar and writes to the first enabled writable one`, async () => {
      const home = storageCalendar({ id: "home", name: "Home", disabled: true });
      const ro = storageCalendar({ id: "ro", name: "Holidays", readOnly: true });
      const work = storageCalendar({ id: "work", name: "Work" });
      const result = plain(await loadTools([home, ro, work])[kind]());
      assert.equal(result.success, true, JSON.stringify(result));
      assert.match(result.message, /"Work"/);
      assert.equal(home.items.length, 0);
      assert.equal(work.items.length, 1);
      assert.equal((await work.getItemsAsArray()).length, 1, "the item is visible to a later listEvents/listTasks");
    });

    it(`${kind}: refuses an explicit calendarId that names a disabled calendar`, async () => {
      const home = storageCalendar({ id: "home", name: "Home", disabled: true });
      const work = storageCalendar({ id: "work", name: "Work" });
      const result = plain(await loadTools([home, work])[kind]("home"));
      assert.equal(result.error, "Calendar is disabled: Home. Turn it on in Thunderbird's calendar list (Calendar tab), then retry.");
      assert.equal(home.items.length + work.items.length, 0);
    });

    it(`${kind}: a calendar whose state cannot be read counts as disabled`, async () => {
      const odd = storageCalendar({ id: "odd", name: "Odd", throws: true });
      const result = plain(await loadTools([odd])[kind]("odd"));
      assert.match(result.error, /^Calendar is disabled: Odd\./);
      assert.equal(odd.items.length, 0);
    });

    it(`${kind}: keeps the old message when no writable calendar exists at all`, async () => {
      const ro = storageCalendar({ id: "ro", name: "Holidays", readOnly: true });
      const result = plain(await loadTools([ro])[kind]());
      assert.equal(result.error, kind === "event" ? "No writable calendar found" : "No writable task-capable calendar found");
    });

    it(`${kind}: never reaches a calendar the account restriction left out`, async () => {
      // `restricted` is enabled and writable but not returned by getAccessibleCalendars().
      const restricted = storageCalendar({ id: "restricted", name: "Other account" });
      const home = storageCalendar({ id: "home", name: "Home", disabled: true });
      const tools = loadTools([home]);
      assert.match(plain(await tools[kind]()).error, /^No enabled writable/);
      assert.equal(plain(await tools[kind]("restricted")).error, "Calendar not found: restricted");
      assert.equal(restricted.items.length + home.items.length, 0);
    });
  }

  it("task: a disabled calendar is still refused when it is the only task-capable one", async () => {
    const home = storageCalendar({ id: "home", name: "Home", disabled: true });
    const events = storageCalendar({ id: "ev", name: "Events only", tasks: false });
    const result = plain(await loadTools([events, home]).task());
    assert.match(result.error, /^No enabled writable task-capable calendar found/);
    assert.equal(home.items.length + events.items.length, 0);
  });
});

describe("wiring", () => {
  it("the calendar write target helpers exist", () => {
    assert.ok(hasHelpers, "calendar write target helpers block missing");
  });

  it("listCalendars reports whether each calendar is turned on", () => {
    const fn = slice("function listCalendars()", "async function createEvent(");
    assert.match(fn, /disabled: isCalendarDisabled\(c\),/);
  });

  it("no create path picks a default calendar without the disabled check", () => {
    assert.doesNotMatch(apiSource, /calendars\.find\(c => !c\.readOnly\)/);
    assert.doesNotMatch(apiSource, /\.find\(\s*c => !c\.readOnly && c\.getProperty\("capabilities\.tasks\.supported"\) !== false\s*\)/);
  });
});
