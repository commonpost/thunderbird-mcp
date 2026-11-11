// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";

// What became of the dialog that createEvent or createTask opened: open, saved by the user (with the id), closed
// without saving, or a failed save. listEvents and listTasks read it with the reviewId of the result. The store and
// the dialog's save callback are run from api.js, then the real createEvent, createTask and calendarReviewState
// against stand-ins for Thunderbird's windows and calendars.

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

const describeErrorSource = slice("function describeError(e) {", "\n}\n") + "\n}\n";
const reviewHelpers = slice("// BEGIN CALENDAR REVIEW HELPERS", "// END CALENDAR REVIEW HELPERS");
const plain = (v) => JSON.parse(JSON.stringify(v));

function loadHelpers() {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${describeErrorSource}\n${reviewHelpers}\nthis.api = { createCalendarReviewStore, calendarReviewSave, CALENDAR_REVIEW_HISTORY };`, sandbox);
  return sandbox.api;
}

// A dialog window: open until close().
function fakeDialog() {
  return { closed: false, close() { this.closed = true; } };
}

function newStore(options = {}) {
  const { createCalendarReviewStore } = loadHelpers();
  let n = 0;
  let t = Date.UTC(2026, 10, 7, 15, 0, 0);
  const clock = { advance(ms) { t += ms; } };
  const store = createCalendarReviewStore({
    now: () => t,
    newId: () => `rv-${++n}`,
    isDialogOpen: (d) => !d.closed,
    ...options,
  });
  return { store, clock };
}

describe("calendar review store", () => {
  it("an open dialog: status open, nothing saved", () => {
    const { store } = newStore();
    const id = store.open({ kind: "event", title: "AGM", dialog: fakeDialog() });
    assert.deepEqual(plain(store.view(id)), {
      reviewId: id, kind: "event", title: "AGM", status: "open", dialogOpen: true,
      requestedAt: "2026-11-07T15:00:00.000Z", message: "The dialog is open; nothing is saved yet.",
    });
  });

  it("a dialog closed without saving: closed, nothing was created", () => {
    const { store } = newStore();
    const dialog = fakeDialog();
    const id = store.open({ kind: "event", title: "AGM", dialog });
    dialog.close();
    const view = store.view(id);
    assert.equal(view.status, "closed");
    assert.equal(view.dialogOpen, false);
    assert.equal(view.eventId, undefined);
    assert.match(view.message, /closed without saving: nothing was created/);
  });

  it("a save, then the dialog closed: saved, with the event's id and calendar", () => {
    const { store, clock } = newStore();
    const dialog = fakeDialog();
    const id = store.open({ kind: "event", title: "AGM", dialog });
    clock.advance(60_000);
    store.saved(id, { id: "ev-1", calendarId: "home" });
    let view = store.view(id);
    assert.equal(view.status, "saved");
    assert.equal(view.eventId, "ev-1");
    assert.equal(view.calendarId, "home");
    assert.equal(view.savedAt, "2026-11-07T15:01:00.000Z");
    assert.equal(view.dialogOpen, true);
    assert.match(view.message, /still open: the user may change it again/);
    dialog.close();
    view = store.view(id);
    assert.equal(view.status, "saved");
    assert.equal(view.dialogOpen, false);
    assert.equal(view.message, "Saved by the user. listEvents shows it as it is now.");
  });

  it("a task gives taskId and points to listTasks", () => {
    const { store } = newStore();
    const id = store.open({ kind: "task", title: "Call", dialog: fakeDialog() });
    store.saved(id, { id: "td-1", calendarId: "home" });
    const view = store.view(id);
    assert.equal(view.taskId, "td-1");
    assert.equal(view.eventId, undefined);
    assert.match(view.message, /listTasks shows it/);
  });

  it("a later save that fails keeps the status saved, with the error", () => {
    const { store } = newStore();
    const id = store.open({ kind: "event", title: "AGM", dialog: fakeDialog() });
    store.saved(id, { id: "ev-1", calendarId: "home" });
    store.failed(id, "server unreachable");
    const view = store.view(id);
    assert.equal(view.status, "saved");
    assert.equal(view.eventId, "ev-1");
    assert.equal(view.error, "server unreachable");
  });

  it("a failed save: failed, and stays failed once the dialog closes; a later save clears it", () => {
    const { store } = newStore();
    const dialog = fakeDialog();
    const id = store.open({ kind: "event", title: "AGM", dialog });
    store.failed(id, "server unreachable");
    assert.equal(store.view(id).status, "failed");
    assert.equal(store.view(id).message, "Saving failed: nothing was created. The dialog is still open.");
    store.saved(id, { id: "ev-1", calendarId: "home" });
    assert.equal(store.view(id).status, "saved");
    assert.equal(store.view(id).error, undefined);

    const other = store.open({ kind: "event", title: "B", dialog });
    store.failed(other, "server unreachable");
    dialog.close();
    assert.equal(store.view(other).status, "failed");
    assert.equal(store.view(other).message, "Saving failed: nothing was created.");
  });

  it("does not name the event or its calendar when the client may not see that calendar", () => {
    const { store } = newStore();
    const id = store.open({ kind: "event", title: "AGM", dialog: fakeDialog() });
    store.saved(id, { id: "ev-1", calendarId: "private" });
    for (const canSeeCalendar of [(c) => c !== "private", () => { throw new Error("unreadable"); }]) {
      const view = store.view(id, { canSeeCalendar });
      assert.equal(view.status, "saved");
      assert.equal(view.eventId, undefined);
      assert.equal(view.calendarId, undefined);
      assert.match(view.message, /^Saved by the user, in a calendar this client cannot see\./);
    }
    assert.equal(store.view(id, { canSeeCalendar: () => true }).eventId, "ev-1");
  });

  it("a save whose id is not known says so", () => {
    const { store } = newStore();
    const id = store.open({ kind: "event", title: "AGM", dialog: fakeDialog() });
    store.saved(id, { id: null, calendarId: "home" });
    const view = store.view(id);
    assert.equal(view.eventId, undefined);
    assert.equal(view.calendarId, "home");
    assert.match(view.message, /its id is not known: find it with listEvents/);
  });

  it("a window that cannot be read counts as closed", () => {
    const { store } = newStore({ isDialogOpen: () => { throw new Error("dead object"); } });
    const id = store.open({ kind: "event", title: "AGM", dialog: fakeDialog() });
    assert.equal(store.view(id).status, "closed");
  });

  it("only a true answer keeps a dialog open", () => {
    const { store } = newStore({ isDialogOpen: () => 1 });
    const id = store.open({ kind: "event", title: "AGM", dialog: fakeDialog() });
    assert.equal(store.view(id).status, "closed");
  });

  it("unknown ids and ids that are not strings give null; saved and failed on them change nothing", () => {
    const { store } = newStore();
    store.saved("rv-x", { id: "ev-1", calendarId: "home" });
    store.failed("rv-x", "no");
    for (const id of ["rv-x", undefined, null, 1, {}]) assert.equal(store.view(id), null);
  });

  it("keeps every open dialog and the last 20 others", () => {
    const { store } = newStore();
    const { CALENDAR_REVIEW_HISTORY } = loadHelpers();
    assert.equal(CALENDAR_REVIEW_HISTORY, 20);
    const stillOpen = store.open({ kind: "event", title: "first", dialog: fakeDialog() });
    const ended = [];
    for (let i = 0; i < 25; i++) {
      const dialog = fakeDialog();
      ended.push(store.open({ kind: "event", title: `n${i}`, dialog }));
      dialog.close();
    }
    store.view(stillOpen);
    assert.equal(store.view(stillOpen).status, "open");
    assert.equal(ended.filter((id) => store.view(id) === null).length, 5);
    assert.deepEqual(ended.slice(0, 5).map((id) => store.view(id)), [null, null, null, null, null]);
    assert.equal(store.view(ended[24]).status, "closed");
  });

  it("refuses a review without a dialog, and an id already used", () => {
    const { createCalendarReviewStore } = loadHelpers();
    const store = createCalendarReviewStore({ newId: () => "same", isDialogOpen: () => true });
    assert.throws(() => store.open({ kind: "event", title: "x", dialog: null }), /needs its dialog/);
    store.open({ kind: "event", title: "x", dialog: fakeDialog() });
    assert.throws(() => store.open({ kind: "event", title: "y", dialog: fakeDialog() }), /collision/);
    assert.throws(() => createCalendarReviewStore({ newId: () => "a" }), /needs newId\(\) and isDialogOpen\(\)/);
  });
});

// Thunderbird's main window, reduced to doTransaction: it stores the item as a calendar does (a new id on "add") and
// calls the observer, unless a batch is active (no call, as in calendar-item-editing.js).
function fakeMainWindow({ reject = null, batch = false, throwSync = null } = {}) {
  const calls = [];
  let n = 0;
  return {
    calls,
    doTransaction(action, item, target, oldItem, observer, extResponse) {
      calls.push({ action, item, calendar: target, oldItem, extResponse });
      if (throwSync) throw throwSync;
      if (reject) return Promise.reject(reject);
      const saved = { ...item, id: item.id || `ev-${++n}`, calendar: target };
      if (!batch) observer?.onTransactionComplete(saved, oldItem);
      return Promise.resolve();
    },
  };
}

function saveSetup(windowOptions) {
  const { calendarReviewSave } = loadHelpers();
  const { store } = newStore();
  const dialog = fakeDialog();
  const review = { id: null };
  const win = windowOptions === null ? null : fakeMainWindow(windowOptions);
  const onOk = calendarReviewSave({ store, review, mainWindow: () => win });
  review.id = store.open({ kind: "event", title: "AGM", dialog });
  const listener = { completed: [], onTransactionComplete(item, old) { this.completed.push([item, old]); } };
  return { store, review, win, onOk, listener, dialog };
}

const flush = () => new Promise((resolve) => { setImmediate(resolve); });

describe("the save callback of a review dialog", () => {
  it("adds the item through Thunderbird's transaction, records its id and tells the dialog", async () => {
    const { store, review, win, onOk, listener } = saveSetup({});
    const home = { id: "home" };
    const ext = { responseMode: 0 };
    onOk({ id: null, title: "AGM" }, home, { id: null }, listener, ext);
    await flush();
    assert.equal(win.calls.length, 1);
    assert.equal(win.calls[0].action, "add");
    assert.equal(win.calls[0].oldItem, null);
    assert.equal(win.calls[0].extResponse, ext);
    assert.equal(listener.completed.length, 1);
    assert.equal(listener.completed[0][0].id, "ev-1");
    const view = store.view(review.id);
    assert.equal(view.status, "saved");
    assert.equal(view.eventId, "ev-1");
    assert.equal(view.calendarId, "home");
  });

  it("modifies the saved item on a second Save instead of adding another one", async () => {
    const { store, review, win, onOk, listener } = saveSetup({});
    const home = { id: "home" };
    onOk({ id: null, title: "AGM" }, home, null, listener, null);
    const saved = listener.completed[0][0];
    const work = { id: "work" };
    onOk({ ...saved, title: "AGM 2" }, work, saved, listener, null);
    await flush();
    assert.deepEqual(win.calls.map((c) => c.action), ["add", "modify"]);
    assert.equal(win.calls[1].oldItem, saved);
    assert.equal(store.view(review.id).eventId, "ev-1");
    assert.equal(store.view(review.id).calendarId, "work");
  });

  it("records a failed save, with Thunderbird's error, and does not tell the dialog", async () => {
    const { store, review, onOk, listener } = saveSetup({ reject: new Error("CalDAV: 503") });
    onOk({ id: null }, { id: "home" }, null, listener, null);
    await flush();
    assert.equal(listener.completed.length, 0);
    assert.equal(store.view(review.id).status, "failed");
    assert.equal(store.view(review.id).error, "CalDAV: 503");
  });

  it("records an error thrown at once as a failed save", async () => {
    const { store, review, onOk, listener } = saveSetup({ throwSync: new Error("boom") });
    onOk({ id: null }, { id: "home" }, null, listener, null);
    await flush();
    assert.equal(store.view(review.id).status, "failed");
    assert.equal(store.view(review.id).error, "boom");
  });

  it("a save inside a batch (no observer call) still counts as saved, without an id for a new item", async () => {
    const { store, review, onOk } = saveSetup({ batch: true });
    onOk({ id: null }, { id: "home" }, null, null, null);
    await flush();
    const view = store.view(review.id);
    assert.equal(view.status, "saved");
    assert.equal(view.eventId, undefined);
    assert.equal(view.calendarId, "home");
    onOk({ id: "ev-9" }, { id: "home" }, { id: "ev-9" }, null, null);
    await flush();
    assert.equal(store.view(review.id).eventId, "ev-9");
  });

  it("an error of the dialog's own listener after the save is not a failed save", async () => {
    const { calendarReviewSave } = loadHelpers();
    const { store } = newStore();
    const review = { id: store.open({ kind: "event", title: "AGM", dialog: fakeDialog() }) };
    // As in Thunderbird, doTransaction is async: an error of the observer rejects its promise.
    const win = {
      async doTransaction(action, item, target, oldItem, observer) {
        observer.onTransactionComplete({ id: "ev-1", calendar: target }, oldItem);
      },
    };
    const onOk = calendarReviewSave({ store, review, mainWindow: () => win });
    onOk({ id: null }, { id: "home" }, null, { onTransactionComplete() { throw new Error("dialog gone"); } }, null);
    await flush();
    assert.equal(store.view(review.id).status, "saved");
    assert.equal(store.view(review.id).error, undefined);
  });

  it("refuses to save without a main window, and says so", async () => {
    const { store, review, onOk } = saveSetup(null);
    onOk({ id: null }, { id: "home" }, null, null, null);
    await flush();
    assert.equal(store.view(review.id).status, "failed");
    assert.match(store.view(review.id).error, /main window is closed/);
  });
});

// The real createEvent, createTask, openCalendarReviewDialog and calendarReviewState, with one main window whose
// openDialog records its arguments and returns a dialog window.
// calendarBlocked: the block of skipReview for events and tasks, on by default here (the dialog unless skipReview is
// false), as an install from before it existed has it; a new install turns it off.
function loadTools({ calendars, accessible = calendars, openDialogReturns = "dialog", calendarBlocked = true } = {}) {
  const opened = [];
  const win = {
    closed: false,
    openDialog(url, name, features, args) {
      const dialog = openDialogReturns === "dialog" ? fakeDialog() : null;
      opened.push({ url, name, features, args, dialog });
      return dialog;
    },
    ...fakeMainWindow(),
    createEventWithDialog(...a) { opened.push({ native: "event", a }); },
    createTodoWithDialog(...a) { opened.push({ native: "task", a }); },
  };
  let n = 0;
  const sandbox = {
    cal: {
      dtz: {
        defaultTimezone: {}, floating: {}, jsDateToDateTime: (d) => ({ js: d, nativeTime: d.getTime() * 1000, isDate: false }),
        getDefaultStartDate: () => ({ defaultStart: true }),
      },
      createDateTime: () => ({ resetTo() {} }),
    },
    CalEvent: class {
      constructor() { this.props = {}; }
      setProperty(k, v) { this.props[k] = v; }
      getProperty(k) { return this.props[k] ?? null; }
      setCategories() {}
      getCategories() { return []; }
      addAlarm(alarm) { (this.alarms ||= []).push(alarm); }
    },
    CalAlarm: class {},
    normalizeReminderMinutes: (minutes) => ({ minutes }),
    reminderCapabilityError: () => null,
    buildDisplayReminder: (minutes) => ({ minutes }),
    reminderSuppressedWarning: () => "reminders may not show",
    CalTodo: class { setCategories() {} getCategories() { return []; } getProperty() { return null; } },
    Services: { wm: { getMostRecentWindow: (type) => (type === "mail:3pane" ? win : null) } },
    isCalendarSkipReviewBlocked: () => calendarBlocked,
    stripEmailContentMarkers: (v) => v,
    normalizeEventStatus: (s) => String(s).toUpperCase(),
    descriptionToHTML: (v) => v,
    getAccessibleCalendars: () => accessible,
    itemReminderMinutes: () => [],
    randomCalendarReviewId: () => `rv-${String(++n).padStart(24, "0")}`,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${describeErrorSource}
${slice("// BEGIN CALENDAR WRITE TARGET HELPERS", "// END CALENDAR WRITE TARGET HELPERS")}
${reviewHelpers}
${slice("// One store per running extension (survives a server restart, not a reload).\nfunction getCalendarReviewStore()", "\n}\n")}
}
${slice("// BEGIN EVENT RANGE HELPERS", "// END EVENT RANGE HELPERS")}
${apiSource.match(/^const CALENDAR_SKIPREVIEW_BLOCKED_ERROR = .*$/m)[0]}
${slice("\nfunction calendarCreateMode(", "\n}\n")}
}
${slice("            function calDateToISO(", "            // VEVENT STATUS values")}
${slice("            function formatEvent(", "            // A task of `calendar` by id")}
${slice("            function openCalendarReviewDialog(", "            async function getCalendarItems(")}
${slice("            async function createTask(", "            // BEGIN RAW MIME PARSING HELPERS")}
${slice("            function calendarReviewState(", "            async function listEvents(")}
this.api = { createEvent, createTask, calendarReviewState };`, sandbox);
  return { ...sandbox.api, opened, win, sandbox };
}

function calendar({ id, name = id, tasks = true, disabled = false, readOnly = false }) {
  return {
    id, name, readOnly, type: "storage",
    getProperty(key) {
      if (key === "disabled") return disabled ? true : null;
      if (key === "capabilities.tasks.supported") return tasks;
      return null;
    },
    items: [],
    // As CalStorageCalendar does: it stores a clone, which gets the id; the item passed keeps none.
    async addItem(item) {
      const stored = Object.assign(Object.create(Object.getPrototypeOf(item)), item);
      if (!stored.id) stored.id = `added-${this.items.length + 1}`;
      this.items.push(stored);
      return stored;
    },
  };
}

const EVENT_DIALOG = "chrome://calendar/content/calendar-event-dialog.xhtml";

describe("createEvent and createTask open a review dialog and give its reviewId", () => {
  it("createEvent: Thunderbird's event dialog in a window, saved through the review", async () => {
    const home = calendar({ id: "home", name: "Home" });
    const tools = loadTools({ calendars: [home] });
    const result = plain(await tools.createEvent("AGM", "2026-11-20T19:00:00", undefined, undefined, undefined, "home"));
    assert.equal(result.success, true, JSON.stringify(result));
    const id = result.reviewId;
    assert.equal(id, "rv-000000000000000000000001");
    assert.match(result.message, /^Event dialog opened for "AGM" on calendar "Home"\. Nothing is created until the user saves it: listEvents with this reviewId tells whether they did\.$/);
    const [{ url, name, features, args, dialog }] = tools.opened;
    assert.equal(url, EVENT_DIALOG);
    assert.equal(name, "_blank");
    assert.equal(features, "centerscreen,chrome,titlebar,toolbar,resizable");
    assert.equal(args.mode, "new");
    assert.equal(args.inTab, false);
    assert.equal(args.calendar, home);
    assert.equal(args.calendarEvent.title, "AGM");
    assert.deepEqual(plain(args.initialStartDateValue), { defaultStart: true });
    assert.equal(tools.calendarReviewState(id, "event").review.status, "open");

    // The user saves: Thunderbird's dialog calls onOk with its copy of the item.
    args.onOk({ id: null, title: "AGM" }, home, args.calendarEvent, null, null);
    await flush();
    const review = plain(tools.calendarReviewState(id, "event").review);
    assert.equal(review.status, "saved");
    assert.equal(review.eventId, "ev-1");
    assert.equal(review.calendarId, "home");
    assert.equal(tools.win.calls[0].action, "add");

    dialog.close();
    assert.equal(tools.calendarReviewState(id, "event").review.dialogOpen, false);
  });

  it("createEvent: closing the dialog without saving reads as closed", async () => {
    const home = calendar({ id: "home" });
    const tools = loadTools({ calendars: [home] });
    const { reviewId } = await tools.createEvent("AGM", "2026-11-20T19:00:00");
    tools.opened[0].dialog.close();
    const { review } = plain(tools.calendarReviewState(reviewId, "event"));
    assert.equal(review.status, "closed");
    assert.equal(review.title, "AGM");
  });

  it("createTask: the same dialog in a window (not a tab), on the calendar a direct save would use", async () => {
    const off = calendar({ id: "off", disabled: true });
    const noTasks = calendar({ id: "events-only", tasks: false });
    const home = calendar({ id: "home", name: "Home" });
    const tools = loadTools({ calendars: [off, noTasks, home] });
    const result = plain(await tools.createTask("Call", "2026-11-20", undefined, "notes", 1));
    assert.equal(result.success, true, JSON.stringify(result));
    const id = result.reviewId;
    assert.equal(id, "rv-000000000000000000000001");
    assert.match(result.message, /^Task dialog opened for "Call" on calendar "Home"\. Nothing is created until the user saves it: listTasks with this reviewId tells whether they did\.$/);
    assert.equal(tools.opened.length, 1);
    const [{ url, args }] = tools.opened;
    assert.equal(url, EVENT_DIALOG);
    assert.equal(args.inTab, false);
    assert.equal(args.calendar, home);
    assert.equal(args.calendarEvent.calendar, home);
    assert.equal(args.calendarEvent.title, "Call");
    assert.equal(tools.calendarReviewState(id, "task").review.kind, "task");

    args.onOk({ id: null, title: "Call" }, home, args.calendarEvent, null, null);
    await flush();
    assert.equal(tools.calendarReviewState(id, "task").review.taskId, "ev-1");
  });

  it("createTask: no enabled task calendar: refused, no dialog", async () => {
    const tools = loadTools({ calendars: [calendar({ id: "home", disabled: true })] });
    const result = plain(await tools.createTask("Call"));
    assert.match(result.error, /^No enabled writable task-capable calendar found/);
    assert.equal(tools.opened.length, 0);
  });

  it("no reviewId when no window opened", async () => {
    const home = calendar({ id: "home" });
    const tools = loadTools({ calendars: [home], openDialogReturns: null });
    const event = plain(await tools.createEvent("AGM", "2026-11-20T19:00:00"));
    const task = plain(await tools.createTask("Call"));
    for (const result of [event, task]) {
      assert.equal(result.success, true);
      assert.equal(result.reviewId, undefined);
    }
  });

  it("New event or task from the dialog's menu opens Thunderbird's own dialogs", async () => {
    const home = calendar({ id: "home" });
    const tools = loadTools({ calendars: [home] });
    await tools.createEvent("AGM", "2026-11-20T19:00:00");
    const { args } = tools.opened[0];
    args.onNewEvent(home);
    args.onNewTodo(home);
    assert.deepEqual(tools.opened.slice(1).map((o) => [o.native, o.a[0]]), [["event", home], ["task", home]]);
  });

  it("calendarReviewState: no id of a calendar the client may not see; errors for bad and unknown ids", async () => {
    const home = calendar({ id: "home" });
    const hidden = calendar({ id: "hidden" });
    const tools = loadTools({ calendars: [home, hidden], accessible: [home] });
    const { reviewId } = await tools.createEvent("AGM", "2026-11-20T19:00:00");
    tools.opened[0].args.onOk({ id: null }, hidden, null, null, null);
    await flush();
    const { review } = plain(tools.calendarReviewState(reviewId, "event"));
    assert.equal(review.status, "saved");
    assert.equal(review.eventId, undefined);
    assert.equal(review.calendarId, undefined);
    const badEvent = { error: "reviewId must be the reviewId of a createEvent result (rv- and 24 hexadecimal digits)" };
    for (const bad of ["", 7, "rv-404", `${reviewId}x`, `${reviewId}\n`, "RV-000000000000000000000001", "x".repeat(5000)]) {
      assert.deepEqual(plain(tools.calendarReviewState(bad, "event")), badEvent, JSON.stringify(bad).slice(0, 40));
    }
    assert.match(plain(tools.calendarReviewState("", "task")).error, /of a createTask result/);
    assert.match(tools.calendarReviewState("rv-0000000000000000000000ff", "event").error, /^Unknown reviewId for createEvent: rv-0000000000000000000000ff\. Reviews are kept in memory, the last 20 of the closed dialogs, until Thunderbird or the extension restarts\.$/);
  });

  it("listEvents reads only event dialogs and listTasks only task dialogs", async () => {
    const home = calendar({ id: "home" });
    const tools = loadTools({ calendars: [home] });
    const event = (await tools.createEvent("AGM", "2026-11-20T19:00:00")).reviewId;
    const task = (await tools.createTask("Call")).reviewId;
    assert.equal(tools.calendarReviewState(event, "event").review.kind, "event");
    assert.equal(tools.calendarReviewState(task, "task").review.kind, "task");
    assert.match(tools.calendarReviewState(event, "task").error, /^Unknown reviewId for createTask: /);
    assert.match(tools.calendarReviewState(task, "event").error, /^Unknown reviewId for createEvent: /);
  });

  it("the main window that opened the dialog saves it; once it is closed, the current one does", async () => {
    const home = calendar({ id: "home" });
    const tools = loadTools({ calendars: [home] });
    await tools.createEvent("AGM", "2026-11-20T19:00:00");
    const other = fakeMainWindow();
    tools.win.closed = true;
    tools.sandbox.Services.wm.getMostRecentWindow = () => other;
    tools.opened[0].args.onOk({ id: null }, home, null, null, null);
    await flush();
    assert.equal(tools.win.calls.length, 0);
    assert.equal(other.calls.length, 1);
  });
});

describe("while the block for events and tasks is off, createEvent and createTask add the item at once", () => {
  it("createEvent without skipReview: added, no dialog, with the id and dates listEvents gives", async () => {
    const home = calendar({ id: "home", name: "Home" });
    const tools = loadTools({ calendars: [home], calendarBlocked: false });
    const result = plain(await tools.createEvent("AGM", "2026-11-20T19:00:00Z", "2026-11-20T21:00:00Z", undefined, undefined, "home"));
    assert.deepEqual(result, {
      success: true,
      eventId: "added-1",
      calendarId: "home",
      startDate: "2026-11-20T19:00:00.000Z",
      endDate: "2026-11-20T21:00:00.000Z",
      allDay: false,
      message: 'Event "AGM" added to calendar "Home"',
    });
    assert.equal(tools.opened.length, 0);
    assert.equal(home.items.length, 1);
    assert.equal(home.items[0].title, "AGM");
  });

  it("createTask without skipReview: added, no dialog, with taskId and dueDate", async () => {
    const home = calendar({ id: "home", name: "Home" });
    const tools = loadTools({ calendars: [home], calendarBlocked: false });
    const result = plain(await tools.createTask("Call", "2026-11-20T10:00:00Z"));
    assert.deepEqual(result, {
      success: true,
      taskId: "added-1",
      calendarId: "home",
      dueDate: "2026-11-20T10:00:00.000Z",
      message: 'Task "Call" created in calendar "Home"',
    });
    assert.equal(tools.opened.length, 0);
    assert.equal(home.items.length, 1);
  });

  it("skipReview false still opens the dialog, and adds nothing", async () => {
    const home = calendar({ id: "home" });
    const tools = loadTools({ calendars: [home], calendarBlocked: false });
    const event = plain(await tools.createEvent("AGM", "2026-11-20T19:00:00Z", undefined, undefined, undefined, "home", false, false));
    const task = plain(await tools.createTask("Call", undefined, undefined, undefined, undefined, undefined, false));
    assert.match(event.reviewId, /^rv-/);
    assert.match(task.reviewId, /^rv-/);
    assert.equal(tools.opened.length, 2);
    assert.equal(home.items.length, 0);
  });

  it("needs no Thunderbird main window", async () => {
    const home = calendar({ id: "home" });
    const tools = loadTools({ calendars: [home], calendarBlocked: false });
    tools.sandbox.Services.wm.getMostRecentWindow = () => null;
    assert.equal(plain(await tools.createEvent("AGM", "2026-11-20T19:00:00Z")).eventId, "added-1");
    assert.equal(plain(await tools.createTask("Call")).taskId, "added-2");
  });

  it("an added item that cannot be read back is still a success, never an error a client would retry", async () => {
    const home = calendar({ id: "home", name: "Home" });
    home.addItem = async () => ({ get id() { throw new Error("gone"); } });
    const tools = loadTools({ calendars: [home], calendarBlocked: false });
    const result = plain(await tools.createEvent("AGM", "2026-11-20T19:00:00Z"));
    assert.deepEqual(result, { success: true, message: 'Event "AGM" added to calendar "Home"' });
  });

  it("createEvent: the reminders and their warning are in the result", async () => {
    const home = calendar({ id: "home" });
    const tools = loadTools({ calendars: [home], calendarBlocked: false });
    const result = plain(await tools.createEvent("AGM", "2026-11-20T19:00:00Z", undefined, undefined, undefined, "home",
      false, undefined, undefined, undefined, undefined, undefined, [15]));
    assert.equal(result.eventId, "added-1");
    assert.deepEqual(result.reminders, [15]);
    assert.equal(result.warning, "reminders may not show");
    assert.deepEqual(plain(home.items[0].alarms), [{ minutes: 15 }]);
  });

  it("an addItem that resolves to nothing: the item that was passed is read", async () => {
    const home = calendar({ id: "home" });
    home.addItem = async (item) => { item.id = "own-id"; };
    const tools = loadTools({ calendars: [home], calendarBlocked: false });
    assert.equal(plain(await tools.createEvent("AGM", "2026-11-20T19:00:00Z")).eventId, "own-id");
  });
});

describe("while the block for events and tasks is on", () => {
  it("without skipReview, the dialog opens and nothing is added", async () => {
    const home = calendar({ id: "home" });
    const tools = loadTools({ calendars: [home], calendarBlocked: true });
    assert.match(plain(await tools.createEvent("AGM", "2026-11-20T19:00:00Z")).reviewId, /^rv-/);
    assert.match(plain(await tools.createTask("Call")).reviewId, /^rv-/);
    assert.equal(home.items.length, 0);
  });

  it("without a Thunderbird main window, the dialog cannot open: an error, nothing added", async () => {
    const home = calendar({ id: "home" });
    const tools = loadTools({ calendars: [home], calendarBlocked: true });
    tools.sandbox.Services.wm.getMostRecentWindow = () => null;
    assert.deepEqual(plain(await tools.createEvent("AGM", "2026-11-20T19:00:00Z")), { error: "No Thunderbird window found" });
    assert.deepEqual(plain(await tools.createTask("Call")), { error: "No Thunderbird window found" });
    assert.equal(home.items.length, 0);
  });

  it("skipReview true is refused: no dialog, nothing added", async () => {
    const home = calendar({ id: "home" });
    const tools = loadTools({ calendars: [home], calendarBlocked: true });
    for (const result of [
      plain(await tools.createEvent("AGM", "2026-11-20T19:00:00Z", undefined, undefined, undefined, undefined, false, true)),
      plain(await tools.createTask("Call", undefined, undefined, undefined, undefined, undefined, true)),
    ]) {
      assert.equal(result.error, "User preference blocks skipReview for events and tasks. Retry with skipReview: false (or omitted) to open the review dialog instead.");
    }
    assert.equal(tools.opened.length, 0);
    assert.equal(home.items.length, 0);
  });
});

describe("listEvents and listTasks read a review with reviewId", () => {
  it("both route reviewId to calendarReviewState before listing", () => {
    for (const tool of ["listEvents", "listTasks"]) {
      const at = apiSource.indexOf(`                case "${tool}":\n`);
      assert.ok(at > 0, tool);
      const next = apiSource.slice(at, apiSource.indexOf("\n", apiSource.indexOf("\n", at) + 1));
      const kind = tool === "listTasks" ? "task" : "event";
      assert.ok(next.includes(`if (args.reviewId !== undefined) return calendarReviewState(args.reviewId, "${kind}");`), tool);
    }
  });
});
