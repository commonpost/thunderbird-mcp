// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";

// The options page reads and writes the two blocks of skipReview (mail; events
// and tasks) through getBlockSkipReview / setBlockSkipReview and
// getBlockCalendarSkipReview / setBlockCalendarSkipReview. These tests run the
// real methods of api.js against an in-memory preference store.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const apiSource = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");

const MAIL = "extensions.commonpost-mcp.blockSkipReview";
const CALENDAR = "extensions.commonpost-mcp.blockCalendarSkipReview";

function constSource(name) {
  const start = apiSource.indexOf(`const ${name} =`);
  assert.ok(start >= 0, `${name} not found in api.js`);
  return apiSource.slice(start, apiSource.indexOf(";", start) + 1);
}

function functionSource(name) {
  const start = apiSource.indexOf(`\nfunction ${name}(`);
  assert.ok(start >= 0, `${name} not found in api.js`);
  return apiSource.slice(start, apiSource.indexOf("\n}\n", start) + 3);
}

// An entry of the object that getAPI() returns: "        name: async function(...) { ... },"
function methodSource(name) {
  const start = apiSource.indexOf(`\n        ${name}: async function(`);
  assert.ok(start >= 0, `${name} not found in api.js`);
  const close = "\n        },\n";
  return apiSource.slice(start + 1, apiSource.indexOf(close, start) + close.length);
}

const plain = (value) => JSON.parse(JSON.stringify(value));

// nsIPrefBranch with its type constants; `values` holds what the user set.
function makeWorld(values = {}) {
  const store = new Map(Object.entries(values));
  const prefs = {
    PREF_INVALID: 0, PREF_STRING: 32, PREF_INT: 64, PREF_BOOL: 128,
    getPrefType(name) {
      if (!store.has(name)) return 0;
      const v = store.get(name);
      return typeof v === "boolean" ? 128 : typeof v === "number" ? 64 : 32;
    },
    getBoolPref(name, fallback) {
      if (!store.has(name)) {
        if (fallback === undefined) throw new Error("NS_ERROR_UNEXPECTED");
        return fallback;
      }
      if (typeof store.get(name) !== "boolean") throw new Error("NS_ERROR_UNEXPECTED");
      return store.get(name);
    },
    setBoolPref(name, value) { store.set(name, value); },
  };
  const sandbox = { Services: { prefs } };
  vm.createContext(sandbox);
  const methods = ["getBlockSkipReview", "setBlockSkipReview", "getBlockCalendarSkipReview", "setBlockCalendarSkipReview"];
  vm.runInContext(`${constSource("PREF_BLOCK_SKIPREVIEW")}
${constSource("PREF_BLOCK_CALENDAR_SKIPREVIEW")}
${functionSource("calendarSkipReviewBlocked")}
this.api = {
${methods.map(methodSource).join("")}};`, sandbox);
  const api = {};
  for (const name of methods) api[name] = async (...args) => plain(await sandbox.api[name](...args));
  return { api, store };
}

describe("the blocks of skipReview read and written by the options page", () => {
  it("both are on in a new profile, and the block for events and tasks is not written by reading it", async () => {
    const { api, store } = makeWorld();
    assert.deepEqual(await api.getBlockSkipReview(), { blockSkipReview: true });
    assert.deepEqual(await api.getBlockCalendarSkipReview(), { blockCalendarSkipReview: true });
    assert.equal(store.size, 0);
  });

  it("a profile that turned off the one block of an earlier version keeps direct creation of events and tasks", async () => {
    const { api } = makeWorld({ [MAIL]: false });
    assert.deepEqual(await api.getBlockCalendarSkipReview(), { blockCalendarSkipReview: false });
  });

  it("once saved, the block for events and tasks no longer follows the one for mail", async () => {
    const { api, store } = makeWorld();
    assert.deepEqual(await api.setBlockCalendarSkipReview(true), { success: true, blockCalendarSkipReview: true });
    assert.deepEqual(await api.setBlockSkipReview(false), { success: true, blockSkipReview: false });
    assert.equal(store.get(CALENDAR), true);
    assert.deepEqual(await api.getBlockCalendarSkipReview(), { blockCalendarSkipReview: true });
    assert.deepEqual(await api.setBlockCalendarSkipReview(false), { success: true, blockCalendarSkipReview: false });
    assert.deepEqual(await api.setBlockSkipReview(true), { success: true, blockSkipReview: true });
    assert.deepEqual(await api.getBlockCalendarSkipReview(), { blockCalendarSkipReview: false });
  });

  it("refuses a value that is not a boolean and writes nothing", async () => {
    const { api, store } = makeWorld();
    assert.deepEqual(await api.setBlockCalendarSkipReview("false"), { error: "blockCalendarSkipReview must be a boolean" });
    assert.equal(store.has(CALENDAR), false);
  });

  it("a value set by hand that is not a boolean blocks", async () => {
    const { api } = makeWorld({ [MAIL]: false, [CALENDAR]: "false" });
    assert.deepEqual(await api.getBlockCalendarSkipReview(), { blockCalendarSkipReview: true });
  });
});
