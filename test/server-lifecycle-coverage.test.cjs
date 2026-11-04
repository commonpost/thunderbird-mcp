// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";

// What the options page learns from getServerInfo, what setListenAll does to a
// running server, and what onShutdown leaves behind when the add-on is
// disabled, updated or Thunderbird closes. The real methods of api.js run
// against stand-ins for XPCOM.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const apiSource = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");

const PREF_LISTEN_ALL = "extensions.commonpost-mcp.listenAll";

function slice(begin, end) {
  const start = apiSource.indexOf(begin);
  const stop = apiSource.indexOf(end, start);
  assert.ok(start >= 0 && stop > start, `${begin} not found in api.js`);
  return apiSource.slice(start, stop);
}

function constSource(name) {
  const start = apiSource.indexOf(`const ${name} =`);
  assert.ok(start >= 0, `${name} not found in api.js`);
  return apiSource.slice(start, apiSource.indexOf(";", start) + 1);
}

function topLevelFunctionSource(name) {
  const start = apiSource.indexOf(`\nfunction ${name}(`);
  assert.ok(start >= 0, `${name} not found in api.js`);
  return apiSource.slice(start + 1, apiSource.indexOf("\n}\n", start) + 3);
}

function methodSource(name) {
  const start = apiSource.indexOf(`\n        ${name}: async function(`);
  assert.ok(start >= 0, `${name} not found in api.js`);
  const close = "\n        },\n";
  return apiSource.slice(start + 1, apiSource.indexOf(close, start) + close.length);
}

const plain = (value) => JSON.parse(JSON.stringify(value));

function namedError(name, message = name) {
  return Object.assign(new Error(message), { name });
}

const BUILDINFO_URI = "resource://commonpost-mcp/buildinfo.json";

function makeServerInfoWorld({ buildinfo = JSON.stringify({ version: "0.18.0", builtAt: "2026-11-03T10:00:00Z" }), connection = { path: "/tmp/commonpost-mcp/connection.json", data: { port: 8780 } }, addon = null } = {}) {
  const warnings = [];
  const state = { buildinfo, connection, addon };
  const sandbox = {
    console: { warn: (...args) => warnings.push(args) },
    Ci: {
      nsIScriptableInputStream: "nsIScriptableInputStream",
      nsILoadInfo: { SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL: 1 },
      nsIContentPolicy: { TYPE_OTHER: 1 },
    },
    Cc: {
      "@mozilla.org/scriptableinputstream;1": {
        createInstance: () => {
          let text = "";
          return {
            init(stream) { text = stream.text; },
            available: () => text.length,
            read: () => text,
            close() {},
          };
        },
      },
    },
    Services: {
      io: {
        newURI: (spec) => ({ spec }),
        newChannelFromURI(uri) {
          assert.equal(uri.spec, BUILDINFO_URI);
          return {
            open() {
              if (state.buildinfo instanceof Error) throw state.buildinfo;
              return { text: state.buildinfo };
            },
          };
        },
      },
      scriptSecurityManager: { getSystemPrincipal: () => ({}) },
    },
    ChromeUtils: {
      importESModule: () => ({
        AddonManager: {
          getAddonByID: async (id) => {
            warnings.push(["lookup", id]);
            if (state.addon instanceof Error) throw state.addon;
            return state.addon;
          },
        },
      }),
    },
    readConnectionInfo() {
      if (state.connection instanceof Error) throw state.connection;
      return state.connection;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext([
    slice("// BEGIN SERVER START STATE HELPERS", "// END SERVER START STATE HELPERS"),
    slice("// BEGIN ORIGINAL EXTENSION NOTICE", "// END ORIGINAL EXTENSION NOTICE"),
    `this.api = {\n${methodSource("getServerInfo")}};`,
  ].join("\n"), sandbox);
  return { api: sandbox.api, sandbox, state, warnings };
}

describe("getServerInfo", () => {
  it("reports a running server with its port, connection file and build", async () => {
    const world = makeServerInfoWorld();
    world.sandbox.__cpMcpServer = {};
    const info = plain(await world.api.getServerInfo());
    assert.deepEqual(info, {
      running: true,
      port: 8780,
      connectionFile: "/tmp/commonpost-mcp/connection.json",
      buildVersion: "0.18.0",
      buildDate: "2026-11-03T10:00:00Z",
      startError: null,
      startErrorAt: null,
      originalExtensionActive: false,
    });
  });

  it("names the build by its commit when buildinfo has no version, and has no date when builtAt is missing", async () => {
    const world = makeServerInfoWorld({ buildinfo: JSON.stringify({ commit: "abc1234" }) });
    const info = plain(await world.api.getServerInfo());
    assert.equal(info.buildVersion, "abc1234");
    assert.equal(info.buildDate, null);
    const bare = makeServerInfoWorld({ buildinfo: "{}" });
    const bareInfo = plain(await bare.api.getServerInfo());
    assert.equal(bareInfo.buildVersion, null);
    assert.equal(bareInfo.buildDate, null);
  });

  it("is silent about a buildinfo.json that is absent (a development build)", async () => {
    const world = makeServerInfoWorld({ buildinfo: namedError("NS_ERROR_FILE_NOT_FOUND") });
    const info = plain(await world.api.getServerInfo());
    assert.equal(info.buildVersion, null);
    assert.deepEqual(world.warnings, [["lookup", "thunderbird-mcp@tkasperczyk.dev"]]);
  });

  it("warns about a buildinfo.json that cannot be read or parsed, and still answers", async () => {
    const world = makeServerInfoWorld({ buildinfo: "{ not json" });
    const info = plain(await world.api.getServerInfo());
    assert.equal(info.buildVersion, null);
    assert.equal(info.port, 8780);
    const warned = world.warnings.filter((w) => w[0] === "commonpost-mcp: read buildinfo failed:");
    assert.equal(warned.length, 1);
    assert.equal(warned[0][1].name, "SyntaxError");
  });

  it("has no port when the connection file has no data or a port of 0", async () => {
    for (const connection of [{ path: "/c.json", data: null }, { path: "/c.json", data: { port: 0 } }, { path: "/c.json", data: {} }]) {
      const world = makeServerInfoWorld({ connection });
      const info = plain(await world.api.getServerInfo());
      assert.equal(info.port, null, JSON.stringify(connection));
      assert.equal(info.connectionFile, "/c.json");
    }
  });

  it("is silent when the connection file is absent, warns about any other fault", async () => {
    const absent = makeServerInfoWorld({ connection: namedError("NS_ERROR_FILE_NOT_FOUND") });
    const info = plain(await absent.api.getServerInfo());
    assert.equal(info.port, null);
    assert.equal(info.connectionFile, null);
    assert.equal(absent.warnings.some((w) => String(w[0]).includes("connection info")), false);

    const broken = makeServerInfoWorld({ connection: namedError("NS_ERROR_FILE_ACCESS_DENIED") });
    const brokenInfo = plain(await broken.api.getServerInfo());
    assert.equal(brokenInfo.port, null);
    assert.equal(broken.warnings.filter((w) => w[0] === "commonpost-mcp: read connection info failed:").length, 1);
  });

  it("does not call a failed start running, and reports its error and time", async () => {
    const world = makeServerInfoWorld();
    world.sandbox.__cpMcpStartError = { message: "port 8780 is busy", at: "2026-11-04T12:00:00.000Z" };
    const info = plain(await world.api.getServerInfo());
    assert.equal(info.running, false);
    assert.equal(info.startError, "port 8780 is busy");
    assert.equal(info.startErrorAt, "2026-11-04T12:00:00.000Z");
  });

  it("reports no start error once the server runs, whatever an older failure left behind", async () => {
    const world = makeServerInfoWorld();
    world.sandbox.__cpMcpServer = {};
    world.sandbox.__cpMcpStartError = { message: "old failure", at: "2026-11-04T12:00:00.000Z" };
    const info = plain(await world.api.getServerInfo());
    assert.equal(info.running, true);
    assert.equal(info.startError, null);
    assert.equal(info.startErrorAt, null);
  });

  it("asks the add-on manager for the original extension and reports whether it is active", async () => {
    const active = makeServerInfoWorld({ addon: { isActive: true } });
    assert.equal(plain(await active.api.getServerInfo()).originalExtensionActive, true);
    assert.deepEqual(active.warnings.filter((w) => w[0] === "lookup"), [["lookup", "thunderbird-mcp@tkasperczyk.dev"]]);
    const disabled = makeServerInfoWorld({ addon: { isActive: false } });
    assert.equal(plain(await disabled.api.getServerInfo()).originalExtensionActive, false);
    const missing = makeServerInfoWorld({ addon: null });
    assert.equal(plain(await missing.api.getServerInfo()).originalExtensionActive, false);
  });

  it("answers false, with a warning, when the add-on manager fails", async () => {
    const world = makeServerInfoWorld({ addon: new Error("AddonManager not ready") });
    const info = plain(await world.api.getServerInfo());
    assert.equal(info.originalExtensionActive, false);
    assert.equal(world.warnings.filter((w) => w[0] === "commonpost-mcp: original extension check failed:").length, 1);
  });
});

function makeListenAllWorld({ server = null, connectionFileExists = true, dirsvcFails = false, clearFails = false } = {}) {
  const events = [];
  const prefs = new Map();
  const sandbox = {
    events,
    console: { log() {}, warn() {} },
    Ci: { nsIFile: "nsIFile" },
    Services: {
      prefs: {
        setBoolPref(name, value) { events.push(["setBoolPref", name, value]); prefs.set(name, value); },
        clearUserPref(name) {
          events.push(["clearUserPref", name]);
          if (clearFails) throw new Error("NS_ERROR_UNEXPECTED");
          prefs.delete(name);
        },
      },
      dirsvc: {
        get(key) {
          if (dirsvcFails) throw new Error("no TmpD");
          assert.equal(key, "TmpD");
          const segments = [];
          const file = {
            append(name) { segments.push(name); },
            clone: () => file,
            exists: () => connectionFileExists,
            remove(recursive) { events.push(["remove", segments.join("/"), recursive]); },
          };
          return file;
        },
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext([
    constSource("PREF_LISTEN_ALL"),
    topLevelFunctionSource("stopConnectionInfoRefreshTimer"),
    `this.api = {
  start: async function() { events.push(["start"]); return { success: true, port: 8781 }; },
${methodSource("setListenAll")}};`,
  ].join("\n"), sandbox);
  sandbox.__cpMcpServer = server;
  return { api: sandbox.api, sandbox, events, prefs };
}

describe("setListenAll", () => {
  it("refuses a value that is not a boolean and changes nothing", async () => {
    const world = makeListenAllWorld({ server: { stop() { throw new Error("must not stop"); } } });
    for (const bad of ["true", 1, null, undefined]) {
      assert.deepEqual(plain(await world.api.setListenAll(bad)), { error: "listenAll must be a boolean" }, String(bad));
    }
    assert.deepEqual(world.events, []);
    assert.ok(world.sandbox.__cpMcpServer, "the running server is left alone");
  });

  it("turning it on stores the preference, stops the running server, clears the connection file and starts again", async () => {
    const timer = { cancelled: false, cancel() { this.cancelled = true; } };
    let world;
    const server = {
      stop(callback) {
        world.events.push(["stop"]);
        setTimeout(callback, 5); // the socket closes later: the port must be free before start()
      },
    };
    world = makeListenAllWorld({ server });
    world.sandbox.__cpMcpConnectionInfoRefreshTimer = timer;
    world.sandbox.__cpMcpStartPromise = Promise.resolve("old");
    const result = plain(await world.api.setListenAll(true));
    assert.deepEqual(result, { success: true, port: 8781 });
    assert.deepEqual(plain(world.events), [
      ["setBoolPref", PREF_LISTEN_ALL, true],
      ["stop"],
      ["remove", "commonpost-mcp/connection.json", false],
      ["start"],
    ]);
    assert.equal(world.sandbox.__cpMcpServer, null);
    assert.equal(world.sandbox.__cpMcpStartPromise, null);
    assert.equal(timer.cancelled, true);
    assert.equal(world.sandbox.__cpMcpConnectionInfoRefreshTimer, null);
  });

  it("turning it off removes the preference, also when the removal fails, and restarts", async () => {
    const world = makeListenAllWorld({ clearFails: true });
    const result = plain(await world.api.setListenAll(false));
    assert.equal(result.success, true);
    assert.deepEqual(world.events.map((e) => e[0]), ["clearUserPref", "remove", "start"]);
  });

  it("restarts even when the server cannot be stopped", async () => {
    const world = makeListenAllWorld({ server: { stop() { throw new Error("already closed"); } } });
    const result = plain(await world.api.setListenAll(true));
    assert.equal(result.success, true);
    assert.equal(world.events.at(-1)[0], "start");
    assert.equal(world.sandbox.__cpMcpServer, null);
  });

  it("does not try to stop a server that is not running, and leaves no connection file alone when there is none", async () => {
    const world = makeListenAllWorld({ connectionFileExists: false });
    await world.api.setListenAll(true);
    assert.deepEqual(world.events.map((e) => e[0]), ["setBoolPref", "start"]);
  });

  it("still restarts when the temporary directory cannot be found", async () => {
    const world = makeListenAllWorld({ dirsvcFails: true });
    const result = plain(await world.api.setListenAll(true));
    assert.equal(result.success, true);
    assert.deepEqual(world.events.map((e) => e[0]), ["setBoolPref", "start"]);
  });
});

function onShutdownSource() {
  const start = apiSource.indexOf("\n  onShutdown(isAppShutdown) {");
  assert.ok(start >= 0, "onShutdown not found in api.js");
  const close = "\n  }\n";
  return apiSource.slice(start + 1, apiSource.indexOf(close, start) + close.length);
}

function makeShutdownWorld({ tempFiles = [], connectionFileExists = true, dirsvcFails = false } = {}) {
  const events = [];
  const errors = [];
  const existing = new Set(tempFiles.filter((f) => !f.startsWith("gone:")));
  const sandbox = {
    events,
    console: { error: (...args) => errors.push(args), warn() {} },
    Ci: { nsIFile: "nsIFile" },
    ChromeUtils: {
      importESModule: () => ({
        AddonManager: { removeAddonListener(listener) { events.push(["removeAddonListener", listener]); } },
      }),
    },
    resProto: { setSubstitution: (...args) => events.push(["setSubstitution", ...args]) },
    Services: {
      obs: { notifyObservers: (...args) => events.push(["notifyObservers", args[1]]) },
      dirsvc: {
        get() {
          if (dirsvcFails) throw new Error("no TmpD");
          const segments = [];
          const file = {
            append(name) { segments.push(name); },
            clone: () => file,
            exists: () => connectionFileExists,
            remove() { events.push(["removeConnectionFile", segments.join("/")]); },
          };
          return file;
        },
      },
    },
    Cc: {
      "@mozilla.org/file/local;1": {
        createInstance: () => {
          let p = "";
          return {
            initWithPath(value) {
              p = value;
              if (value.startsWith("bad:")) throw new Error("NS_ERROR_FILE_UNRECOGNIZED_PATH");
            },
            exists: () => existing.has(p),
            remove() { events.push(["removeTemp", p]); },
          };
        },
      },
    },
    _tempAttachFiles: new Set(tempFiles),
  };
  vm.createContext(sandbox);
  vm.runInContext([
    topLevelFunctionSource("stopConnectionInfoRefreshTimer"),
    `class Host {\n${onShutdownSource()}}\nthis.host = new Host();`,
  ].join("\n"), sandbox);
  return { host: sandbox.host, sandbox, events, errors };
}

describe("onShutdown", () => {
  it("removes the uninstall listener and forgets it; a failure to remove it is logged and the shutdown goes on", () => {
    const listener = { name: "uninstall listener" };
    const ok = makeShutdownWorld();
    ok.sandbox.__commonpostUninstallListener = listener;
    ok.host.onShutdown(true);
    assert.deepEqual(ok.events[0], ["removeAddonListener", listener]);
    assert.equal(ok.sandbox.__commonpostUninstallListener, null);

    const broken = makeShutdownWorld();
    broken.sandbox.__commonpostUninstallListener = listener;
    broken.sandbox.ChromeUtils.importESModule = () => { throw new Error("AddonManager gone"); };
    broken.host.onShutdown(true);
    assert.equal(broken.errors.length, 1);
    assert.match(String(broken.errors[0][0]), /could not remove the uninstall listener/);
    assert.equal(broken.sandbox.__commonpostUninstallListener, null);
    assert.ok(broken.events.some((e) => e[0] === "removeConnectionFile"), "the shutdown went on");
  });

  it("ends the pending filter confirmations with a reason that says nothing was written, then forgets the store", () => {
    const reasons = [];
    const world = makeShutdownWorld();
    world.sandbox.__commonpostMcpFilterConfirmations = { shutdown: (reason) => reasons.push(reason) };
    world.host.onShutdown(true);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /nothing was written/);
    assert.equal(world.sandbox.__commonpostMcpFilterConfirmations, null);
  });

  it("logs a confirmation store that fails to shut down and forgets it all the same", () => {
    const world = makeShutdownWorld();
    world.sandbox.__commonpostMcpFilterConfirmations = { shutdown() { throw new Error("store broken"); } };
    world.host.onShutdown(true);
    assert.equal(world.errors.length, 1);
    assert.match(String(world.errors[0][0]), /could not end pending filter confirmations/);
    assert.equal(world.sandbox.__commonpostMcpFilterConfirmations, null);
  });

  it("stops the HTTP server so the port is released, even when it refuses to stop", () => {
    const stopped = [];
    const ok = makeShutdownWorld();
    ok.sandbox.__cpMcpServer = { stop: (cb) => { stopped.push(typeof cb); } };
    ok.host.onShutdown(true);
    assert.deepEqual(stopped, ["function"]);
    assert.equal(ok.sandbox.__cpMcpServer, null);

    const stubborn = makeShutdownWorld();
    stubborn.sandbox.__cpMcpServer = { stop() { throw new Error("already closed"); } };
    stubborn.host.onShutdown(true);
    assert.equal(stubborn.sandbox.__cpMcpServer, null);
  });

  it("cancels the connection-file refresh timer and clears the start bookkeeping for a fresh start", () => {
    const world = makeShutdownWorld();
    const timer = { cancelled: false, cancel() { this.cancelled = true; } };
    Object.assign(world.sandbox, {
      __cpMcpConnectionInfoRefreshTimer: timer,
      __cpMcpStartPromise: Promise.resolve(),
      __cpMcpStartError: { message: "x", at: "y" },
      __cpMcpBridgesSeen: new Map(),
    });
    world.host.onShutdown(false);
    assert.equal(timer.cancelled, true);
    assert.equal(world.sandbox.__cpMcpConnectionInfoRefreshTimer, null);
    assert.equal(world.sandbox.__cpMcpStartPromise, null);
    assert.equal(world.sandbox.__cpMcpStartError, null);
    assert.equal(world.sandbox.__cpMcpBridgesSeen, null);
  });

  it("removes the connection file, so that no stale token lingers, and survives a missing temporary directory", () => {
    const present = makeShutdownWorld();
    present.host.onShutdown(true);
    assert.deepEqual(present.events.filter((e) => e[0] === "removeConnectionFile"), [["removeConnectionFile", "commonpost-mcp/connection.json"]]);

    const absent = makeShutdownWorld({ connectionFileExists: false });
    absent.host.onShutdown(true);
    assert.equal(absent.events.some((e) => e[0] === "removeConnectionFile"), false);

    const noTmp = makeShutdownWorld({ dirsvcFails: true, tempFiles: ["/tmp/a.bin"] });
    noTmp.host.onShutdown(true);
    assert.deepEqual(noTmp.events.filter((e) => e[0] === "removeTemp"), [["removeTemp", "/tmp/a.bin"]], "the cleanup after it still runs");
  });

  it("deletes the temporary attachment files that still exist, skips the others and empties the list", () => {
    const world = makeShutdownWorld({ tempFiles: ["/tmp/a.bin", "gone:/tmp/b.bin", "bad:///x", "/tmp/c.bin"] });
    world.host.onShutdown(true);
    assert.deepEqual(world.events.filter((e) => e[0] === "removeTemp").map((e) => e[1]), ["/tmp/a.bin", "/tmp/c.bin"]);
    assert.equal(world.sandbox._tempAttachFiles.size, 0);
  });

  it("when Thunderbird itself closes, keeps the resource mapping and the startup cache", () => {
    const world = makeShutdownWorld();
    world.host.onShutdown(true);
    assert.equal(world.events.some((e) => e[0] === "setSubstitution" || e[0] === "notifyObservers"), false);
  });

  it("when the add-on is disabled or updated, unregisters the resource mapping and invalidates the startup cache", () => {
    const world = makeShutdownWorld();
    world.host.onShutdown(false);
    assert.deepEqual(world.events.slice(-2), [
      ["setSubstitution", "commonpost-mcp", null],
      ["notifyObservers", "startupcache-invalidate"],
    ]);
  });
});
