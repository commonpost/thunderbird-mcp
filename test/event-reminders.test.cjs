"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");
const start = source.indexOf("// BEGIN EVENT REMINDER HELPERS");
const end = source.indexOf("// END EVENT REMINDER HELPERS", start);
assert.ok(start >= 0 && end > start, "EVENT REMINDER HELPERS markers missing");
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(`${source.slice(start, end)}
this.helpers = { normalizeReminderMinutes, reminderMinutesOfAlarm, eventReminderMinutes, reminderCapabilityError, reminderSuppressedWarning, planReminderUpdate };`, sandbox);
const {
  normalizeReminderMinutes, reminderMinutesOfAlarm, eventReminderMinutes, reminderCapabilityError, reminderSuppressedWarning,
  planReminderUpdate,
} = sandbox.helpers;

// calIAlarm.ALARM_RELATED_*
const ABSOLUTE = 0, START = 1, END = 2;
const alarm = (action, related, seconds) => ({
  action, related, offset: seconds === null ? null : { inSeconds: seconds },
});
const calendar = (props) => ({ name: "Lab", getProperty: (name) => (name in props ? props[name] : null) });
// Arrays made in the sandbox have another Array.prototype: compare as plain JSON.
const plain = (v) => JSON.parse(JSON.stringify(v));

describe("normalizeReminderMinutes", () => {
  it("deduplicates and puts the earliest reminder first", () => {
    assert.deepEqual(plain(normalizeReminderMinutes([15, 1440, 15, 0])), { minutes: [1440, 15, 0] });
  });

  it("accepts an empty list (removes the reminders)", () => {
    assert.deepEqual(plain(normalizeReminderMinutes([])), { minutes: [] });
  });

  it("accepts the bounds and treats -0 as 0", () => {
    assert.deepEqual(plain(normalizeReminderMinutes([40320, -0])), { minutes: [40320, 0] });
  });

  for (const bad of [-1, 40321, 1.5, "15", null, NaN, Infinity]) {
    it(`refuses ${String(bad)}`, () => {
      assert.match(normalizeReminderMinutes([bad]).error, /Invalid reminder/);
    });
  }

  it("refuses a value that is not an array", () => {
    assert.match(normalizeReminderMinutes(15).error, /must be an array/);
    assert.match(normalizeReminderMinutes("[15]").error, /must be an array/);
  });

  it("counts the limit after deduplication", () => {
    assert.deepEqual(plain(normalizeReminderMinutes([1, 2, 3, 4, 5, 5])), { minutes: [5, 4, 3, 2, 1] });
    assert.match(normalizeReminderMinutes([1, 2, 3, 4, 5, 6]).error, /At most 5 reminders/);
  });
});

describe("reminderMinutesOfAlarm", () => {
  it("reads a display alarm before the start", () => {
    assert.equal(reminderMinutesOfAlarm(alarm("DISPLAY", START, -900), START), 15);
    assert.equal(reminderMinutesOfAlarm(alarm("display", START, -86400), START), 1440);
  });

  it("reads a display alarm at the start as 0", () => {
    assert.equal(reminderMinutesOfAlarm(alarm("DISPLAY", START, 0), START), 0);
  });

  it("leaves every other alarm alone", () => {
    assert.equal(reminderMinutesOfAlarm(alarm("EMAIL", START, -900), START), null);
    assert.equal(reminderMinutesOfAlarm(alarm("AUDIO", START, -900), START), null);
    assert.equal(reminderMinutesOfAlarm(alarm("DISPLAY", END, -900), START), null);
    assert.equal(reminderMinutesOfAlarm(alarm("DISPLAY", ABSOLUTE, null), START), null);
    assert.equal(reminderMinutesOfAlarm(alarm("DISPLAY", START, 600), START), null, "after the start");
    assert.equal(reminderMinutesOfAlarm(alarm("DISPLAY", START, -90), START), null, "not whole minutes");
    assert.equal(reminderMinutesOfAlarm(alarm("DISPLAY", START, null), START), null);
    assert.equal(reminderMinutesOfAlarm(null, START), null);
  });
});

describe("eventReminderMinutes", () => {
  it("lists the display reminders only, deduplicated, earliest first", () => {
    const alarms = [
      alarm("DISPLAY", START, -900),
      alarm("EMAIL", START, -3600),
      alarm("DISPLAY", START, -86400),
      alarm("DISPLAY", START, -900),
      alarm("DISPLAY", END, 0),
    ];
    assert.deepEqual(plain(eventReminderMinutes(alarms, START)), [1440, 15]);
  });

  it("returns [] without alarms", () => {
    assert.deepEqual(plain(eventReminderMinutes([], START)), []);
    assert.deepEqual(plain(eventReminderMinutes(null, START)), []);
  });
});

describe("planReminderUpdate", () => {
  // A managed alarm with properties of its own, as another client may have written it
  const rich = (seconds, extra) => ({ ...alarm("DISPLAY", START, seconds), ...extra });

  it("keeps the alarms whose minutes stay, as they are, and adds only the new minutes", () => {
    const at15 = rich(-900, { repeat: 2, description: "Standup", props: { "X-CUSTOM": "1" } });
    const at60 = rich(-3600, {});
    const email = alarm("EMAIL", START, -900);
    const plan = planReminderUpdate([at60, email, at15], [1440, 15], START);
    assert.equal(plan.changed, true);
    assert.equal(plan.kept.length, 2);
    assert.equal(plan.kept[0], email);
    assert.equal(plan.kept[1], at15); // the same object: REPEAT, DESCRIPTION and X- properties kept
    assert.deepEqual(plain(plan.add), [1440]);
    assert.equal(plan.managedCount, 2);
    assert.equal(plan.otherCount, 1);
  });

  it("changes nothing when the list is the same, duplicates and order included", () => {
    const a = rich(-900, {}), b = rich(-900, { description: "second" }), c = rich(0, {});
    const plan = planReminderUpdate([c, a, b], [15, 0], START);
    assert.equal(plan.changed, false);
    assert.equal(plan.kept.length, 3);
    assert.deepEqual(plain(plan.add), []);
  });

  it("keeps two alarms at one offset when other minutes change", () => {
    const a = rich(-900, {}), b = rich(-900, {}), old = rich(-60, {});
    const plan = planReminderUpdate([a, b, old], [15, 30], START);
    assert.equal(plan.changed, true);
    assert.deepEqual([...plan.kept], [a, b]);
    assert.deepEqual(plain(plan.add), [30]);
    assert.equal(plan.managedCount, 3);
  });

  it("removes every managed alarm for [] and keeps the others", () => {
    const other = alarm("DISPLAY", END, -900);
    const plan = planReminderUpdate([rich(-900, {}), other, rich(-60, {})], [], START);
    assert.equal(plan.changed, true);
    assert.deepEqual([...plan.kept], [other]);
    assert.equal(plan.managedCount, 0);
    assert.equal(planReminderUpdate([other], [], START).changed, false);
    assert.equal(planReminderUpdate([], [], START).changed, false);
  });

  it("adds every minute to an event without reminders", () => {
    const plan = planReminderUpdate(undefined, [60, 5], START);
    assert.equal(plan.changed, true);
    assert.deepEqual(plain(plan.add), [60, 5]);
  });
});

describe("reminderCapabilityError", () => {
  it("accepts a calendar without limits", () => {
    assert.equal(reminderCapabilityError(calendar({}), 5, 3), null);
  });

  it("never refuses removing reminders", () => {
    assert.equal(reminderCapabilityError(calendar({ "capabilities.alarms.maxCount": 0, "capabilities.alarms.actionValues": ["EMAIL"] }), 0, 2), null);
  });

  it("refuses a calendar without display alarms", () => {
    assert.match(reminderCapabilityError(calendar({ "capabilities.alarms.actionValues": ["EMAIL"] }), 1, 0), /does not support display reminders/);
    assert.equal(reminderCapabilityError(calendar({ "capabilities.alarms.actionValues": ["DISPLAY", "EMAIL"] }), 1, 0), null);
  });

  it("counts the alarms the event keeps against maxCount", () => {
    const limited = calendar({ "capabilities.alarms.maxCount": 2 });
    assert.equal(reminderCapabilityError(limited, 2, 0), null);
    assert.match(reminderCapabilityError(limited, 3, 0), /at most 2 alarm\(s\) per event; got 3/);
    assert.match(reminderCapabilityError(limited, 2, 1), /keeps 1 other alarm/);
  });

  it("treats limits it cannot read as none", () => {
    const broken = { name: "Broken", getProperty() { throw new Error("gone"); } };
    assert.equal(reminderCapabilityError(broken, 1, 0), null, "unknown limits are no limits");
  });
});

describe("reminderSuppressedWarning", () => {
  it("warns when the calendar's reminders are off", () => {
    assert.match(reminderSuppressedWarning(calendar({ suppressAlarms: true }), 1), /turned off for calendar "Lab"/);
    assert.equal(reminderSuppressedWarning(calendar({ suppressAlarms: true }), 0), null);
    assert.equal(reminderSuppressedWarning(calendar({}), 2), null);
  });
});
