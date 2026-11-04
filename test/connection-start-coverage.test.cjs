// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";

// The connection file (<TmpD>/commonpost-mcp/connection.json) and the bookkeeping of the server start: what the
// writer refuses, what it replaces, how a failed or odd start is reported and when the file is rewritten. The real
// code of api.js (CONNECTION INFO WRITER, CONNECTION INFO REFRESH HELPERS, SERVER START STATE HELPERS) runs here.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const apiSource = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");

function snippet(name) {
  const start = apiSource.indexOf(`// BEGIN ${name}`);
  const end = apiSource.indexOf(`// END ${name}`, start);
  assert.ok(start >= 0 && end > start, `marker missing: ${name}`);
  return apiSource.slice(start, end);
}

const plain = (value) => JSON.parse(JSON.stringify(value));

function topLevelFunctionSource(name) {
  const start = apiSource.indexOf(`\nfunction ${name}(`);
  assert.ok(start >= 0, `${name} not found in api.js`);
  return apiSource.slice(start + 1, apiSource.indexOf("\n}\n", start) + 3);
}

describe("ensureFreshConnectionInfo", () => {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${snippet("CONNECTION INFO REFRESH HELPERS")}\nthis.ensureFreshConnectionInfo = ensureFreshConnectionInfo;`, sandbox);
  const { ensureFreshConnectionInfo } = sandbox;

  it("rewrites the file when it cannot be read, also when the caller gave no handler for that error", () => {
    const writes = [];
    const result = ensureFreshConnectionInfo({
      port: 8780,
      token: "t",
      expectedPid: 1,
      readConnectionInfo() { throw new Error("NS_ERROR_FILE_ACCESS_DENIED"); },
      writeConnectionInfo: (port, token) => { writes.push([port, token]); return "/tmp/commonpost-mcp/connection.json"; },
    });
    assert.equal(result, "/tmp/commonpost-mcp/connection.json");
    assert.deepEqual(writes, [[8780, "t"]]);
  });

  it("hands the read error to the handler when there is one, and a handler that is not a function is ignored", () => {
    const seen = [];
    const options = {
      port: 8780, token: "t", expectedPid: 1,
      readConnectionInfo() { throw new Error("unreadable"); },
      writeConnectionInfo: () => "written",
    };
    assert.equal(ensureFreshConnectionInfo({ ...options, onCheckError: (e) => seen.push(e.message) }), "written");
    assert.deepEqual(seen, ["unreadable"]);
    assert.equal(ensureFreshConnectionInfo({ ...options, onCheckError: "not a function" }), "written");
  });

  it("rewrites the file when reading it gives nothing at all", () => {
    const writes = [];
    for (const current of [null, undefined]) {
      ensureFreshConnectionInfo({
        port: 1, token: "t", expectedPid: 1,
        readConnectionInfo: () => current,
        writeConnectionInfo: () => { writes.push("rewritten"); return "p"; },
      });
    }
    assert.deepEqual(writes, ["rewritten", "rewritten"]);
  });
});

describe("server start bookkeeping", () => {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${snippet("SERVER START STATE HELPERS")}
this.api = { runGuardedStart, computeServerRunState, describeStartError };`, sandbox);
  const { runGuardedStart, computeServerRunState, describeStartError } = sandbox.api;

  it("describes an error of any kind as text", () => {
    assert.equal(describeStartError(null), "Unknown error");
    assert.equal(describeStartError(undefined), "Unknown error");
    assert.equal(describeStartError("port busy"), "port busy");
    assert.equal(describeStartError(new Error("boom")), "Error: boom");
    assert.equal(describeStartError(0), "0");
    assert.equal(describeStartError(false), "false");
    assert.equal(describeStartError(NaN), "NaN");
    assert.equal(describeStartError(Object.create(null)), "Unknown error", "an object that cannot be turned into text");
    assert.equal(describeStartError({ toString() { throw new Error("no text"); } }), "Unknown error");
  });

  it("a start body that returns nothing is a failed start with an unknown error", async () => {
    for (const result of [undefined, null]) {
      const state = {};
      const answer = await runGuardedStart(state, async () => result);
      assert.equal(answer, result);
      assert.equal(state.__cpMcpStartError.message, "Unknown error");
      assert.equal(state.__cpMcpStartPromise, null);
    }
  });

  it("a start body that throws is a failed start with the error as text", async () => {
    const state = {};
    const answer = await runGuardedStart(state, async () => { throw new Error("tmp directory refused"); });
    assert.deepEqual(plain(answer), { success: false, error: "Error: tmp directory refused" });
    assert.equal(state.__cpMcpStartError.message, "Error: tmp directory refused");
  });

  it("a failed start does not drop the promise of a newer attempt that was stored meanwhile", async () => {
    const state = {};
    const newer = Promise.resolve({ success: true });
    const answer = await runGuardedStart(state, async () => {
      await null;
      state.__cpMcpStartPromise = newer;
      return { success: false, error: "first attempt failed" };
    });
    assert.equal(answer.success, false);
    assert.equal(state.__cpMcpStartPromise, newer, "only the failed attempt's own promise is cleared");
    assert.equal(state.__cpMcpStartError.message, "first attempt failed");
  });

  it("two callers at the same time share one attempt", async () => {
    const state = {};
    let runs = 0;
    const body = async () => { runs++; await null; return { success: true }; };
    const [a, b] = await Promise.all([runGuardedStart(state, body), runGuardedStart(state, body)]);
    assert.equal(runs, 1);
    assert.equal(a, b);
  });

  it("the run state shows no error for a server that runs and none when nothing failed", () => {
    assert.deepEqual(plain(computeServerRunState({})), { running: false, startError: null, startErrorAt: null });
    assert.deepEqual(plain(computeServerRunState({ __cpMcpServer: {} })), { running: true, startError: null, startErrorAt: null });
  });
});

// <TmpD>/commonpost-mcp as nsIFile hands it out, with the pieces the writer touches.
function makeTmpDir({ exists = true, symlink = false, permissions = 0o700, permissionsThrow, connectionExists = false, onChmod } = {}) {
  const log = [];
  let mode = permissions;
  const dir = {
    log,
    segments: [],
    append(name) { this.segments.push(name); },
    exists: () => exists,
    isSymlink: () => symlink,
    create(type, perms) { log.push(["create", type, perms]); },
    get permissions() {
      if (permissionsThrow !== undefined) throw permissionsThrow;
      return mode;
    },
    set permissions(value) {
      log.push(["chmod", value]);
      if (onChmod) onChmod(value, (m) => { mode = m; });
      else mode = value;
    },
    clone() {
      return {
        segments: [...this.segments],
        append(name) { this.segments.push(name); },
        exists: () => connectionExists,
        remove(recursive) { log.push(["remove", this.segments.join("/"), recursive]); },
        get path() { return this.segments.join("/"); },
      };
    },
  };
  return dir;
}

function makeWriter({ tmpDir, os = "Linux" }) {
  const written = [];
  const initCalls = [];
  const sandbox = {
    Services: { dirsvc: { get: () => tmpDir }, appinfo: { OS: os, processID: 99 } },
    Ci: { nsIFile: { DIRECTORY_TYPE: 1 } },
    Cc: {
      "@mozilla.org/network/file-output-stream;1": { createInstance: () => ({ init: (...args) => initCalls.push(args) }) },
      "@mozilla.org/intl/converter-output-stream;1": {
        createInstance: () => ({ init() {}, writeString: (data) => written.push(data), close() {} }),
      },
    },
    console: { warn() {} },
    MailServices: { accounts: { allServers: [] } },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${topLevelFunctionSource("stopConnectionInfoRefreshTimer")}\n${snippet("CONNECTION INFO WRITER")}\nthis.write = writeConnectionInfo;`, sandbox);
  return { write: sandbox.write, written, initCalls };
}

describe("writeConnectionInfo", () => {
  it("creates the directory for the user alone when it does not exist yet", () => {
    const tmpDir = makeTmpDir({ exists: false });
    const { write, written, initCalls } = makeWriter({ tmpDir });
    assert.equal(write(8780, "tok", []), "commonpost-mcp/connection.json");
    assert.deepEqual(tmpDir.log, [["create", 1, 0o700]]);
    assert.deepEqual(JSON.parse(written[0]), { port: 8780, token: "tok", pid: 99, protectedDirs: [] });
    // O_WRONLY | O_CREAT | O_EXCL, readable by the user only
    assert.deepEqual(initCalls[0].slice(1), [0x02 | 0x08 | 0x80, 0o600, 0]);
  });

  it("refuses to write through a directory that is a symlink, and writes nothing", () => {
    const tmpDir = makeTmpDir({ symlink: true });
    const { write, written } = makeWriter({ tmpDir });
    assert.throws(() => write(8780, "tok", []), /commonpost-mcp tmp directory is a symlink/);
    assert.deepEqual(written, []);
    assert.deepEqual(tmpDir.log, []);
  });

  it("leaves a directory with no readable mode alone (a mode of 0)", () => {
    const tmpDir = makeTmpDir({ permissions: 0 });
    const { write, written } = makeWriter({ tmpDir });
    assert.equal(write(8780, "tok", []), "commonpost-mcp/connection.json");
    assert.equal(written.length, 1);
    assert.deepEqual(tmpDir.log, []);
  });

  it("does not touch the permissions of a directory that only the user can reach", () => {
    const tmpDir = makeTmpDir({ permissions: 0o700 });
    const { write } = makeWriter({ tmpDir });
    write(8780, "tok", []);
    assert.deepEqual(tmpDir.log, []);
  });

  for (const [label, thrown] of [
    ["undefined", undefined],
    ["null", null],
    ["an object with no message", { code: 1 }],
    ["an error about something else", new Error("permissions accessor unsupported on this platform")],
  ]) {
    it(`writes the file when reading the permissions throws ${label}: that platform has no such accessor`, () => {
      const tmpDir = makeTmpDir({ permissionsThrow: thrown });
      const { write, written } = makeWriter({ tmpDir });
      assert.equal(write(8780, "tok", []), "commonpost-mcp/connection.json");
      assert.equal(written.length, 1);
    });
  }

  it("replaces a connection file that is already there, removing it first", () => {
    const tmpDir = makeTmpDir({ connectionExists: true });
    const { write, written } = makeWriter({ tmpDir });
    write(8780, "tok", []);
    assert.deepEqual(tmpDir.log, [["remove", "commonpost-mcp/connection.json", false]]);
    assert.equal(written.length, 1);
  });

  it("repairs a directory that others can read when the change sticks, and refuses it when it does not", () => {
    const repaired = makeTmpDir({ permissions: 0o755 });
    makeWriter({ tmpDir: repaired }).write(8780, "tok", []);
    assert.deepEqual(repaired.log, [["chmod", 0o700]]);

    const stuck = makeTmpDir({ permissions: 0o755, onChmod: () => { throw new Error("EPERM"); } });
    assert.throws(() => makeWriter({ tmpDir: stuck }).write(8780, "tok", []), /group\/world permissions/);
  });
});

describe("the refresh timer and the listen-all setting", () => {
  function load(prefs) {
    const warnings = [];
    const sandbox = {
      PREF_LISTEN_ALL: "extensions.commonpost-mcp.listenAll",
      Services: { prefs },
      console: { warn: (...args) => warnings.push(args) },
    };
    vm.createContext(sandbox);
    vm.runInContext(`${topLevelFunctionSource("isListenAllEnabled")}\n${topLevelFunctionSource("stopConnectionInfoRefreshTimer")}
this.api = { isListenAllEnabled, stopConnectionInfoRefreshTimer };`, sandbox);
    return { api: sandbox.api, sandbox, warnings };
  }

  it("reads the listen-all preference, and counts one that cannot be read as off", () => {
    assert.equal(load({ getBoolPref: (name, fallback) => { assert.equal(name, "extensions.commonpost-mcp.listenAll"); assert.equal(fallback, false); return true; } }).api.isListenAllEnabled(), true);
    assert.equal(load({ getBoolPref: () => { throw new Error("NS_ERROR_UNEXPECTED"); } }).api.isListenAllEnabled(), false);
  });

  it("cancels the timer and forgets it; a timer that cannot be cancelled is warned about and forgotten all the same", () => {
    const cancelled = [];
    const ok = load({});
    ok.sandbox.__cpMcpConnectionInfoRefreshTimer = { cancel: () => cancelled.push("ok") };
    ok.api.stopConnectionInfoRefreshTimer();
    assert.deepEqual(cancelled, ["ok"]);
    assert.equal(ok.sandbox.__cpMcpConnectionInfoRefreshTimer, null);

    const stuck = load({});
    stuck.sandbox.__cpMcpConnectionInfoRefreshTimer = { cancel() { throw new Error("already fired"); } };
    stuck.api.stopConnectionInfoRefreshTimer();
    assert.equal(stuck.sandbox.__cpMcpConnectionInfoRefreshTimer, null);
    assert.equal(stuck.warnings.length, 1);
    assert.match(String(stuck.warnings[0][0]), /failed to stop connection info refresh timer/);

    const none = load({});
    assert.doesNotThrow(() => none.api.stopConnectionInfoRefreshTimer());
    assert.equal(none.warnings.length, 0);
  });
});
