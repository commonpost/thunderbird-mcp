// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";

// The background script passes onInstalled's reason "install" (a new install: events and tasks added at once) or
// "update" (the profile keeps what it had, now written) to applyInstallDefaults; Thunderbird's own update and other
// reasons call nothing. The server starts in every case. Runs extension/background.js against a stand-in for the
// WebExtension API.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../extension/background.js"), "utf8");

function load({ applyFails = false } = {}) {
  const calls = [];
  const listeners = {};
  const event = (name) => ({ addListener(fn) { listeners[name] = fn; } });
  const browser = {
    runtime: { onInstalled: event("onInstalled"), onStartup: event("onStartup") },
    commonpostMcp: {
      async start() { calls.push("start"); return { success: true, port: 8765 }; },
      async applyInstallDefaults(reason) {
        calls.push(`applyInstallDefaults(${reason})`);
        if (applyFails) throw new Error("no experiment");
        return { blockCalendarSkipReview: reason === "install" ? false : true };
      },
    },
  };
  const errors = [];
  const sandbox = { browser, console: { log() {}, error: (...a) => errors.push(a.join(" ")) } };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return { calls, listeners, errors };
}

const settle = () => new Promise((resolve) => { setImmediate(resolve); });

describe("background script: the defaults of a new install", () => {
  it("a new install and an update pass their reason, then start the server", async () => {
    for (const reason of ["install", "update"]) {
      const { calls, listeners } = load();
      await settle();
      calls.length = 0;
      await listeners.onInstalled({ reason, previousVersion: "0.19.2", temporary: false });
      assert.deepEqual(calls, [`applyInstallDefaults(${reason})`, "start"]);
    }
  });

  it("a Thunderbird update or a shared module update calls nothing, and starts the server", async () => {
    for (const reason of ["browser_update", "shared_module_update"]) {
      const { calls, listeners } = load();
      await settle();
      calls.length = 0;
      await listeners.onInstalled({ reason });
      assert.deepEqual(calls, ["start"], reason);
    }
  });

  it("a failure to write them is logged and the server still starts", async () => {
    const { calls, listeners, errors } = load({ applyFails: true });
    await settle();
    calls.length = 0;
    await listeners.onInstalled({ reason: "install" });
    assert.deepEqual(calls, ["applyInstallDefaults(install)", "start"]);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /defaults of the install/);
  });

  it("starts the server when loaded and on startup, without writing the defaults", async () => {
    const { calls, listeners } = load();
    await settle();
    assert.deepEqual(calls, ["start"]);
    await listeners.onStartup();
    assert.deepEqual(calls, ["start", "start"]);
  });
});
