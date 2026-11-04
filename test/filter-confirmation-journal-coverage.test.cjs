// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";

// Every filter confirmation event (requested, refused, accepted, expired, failed) is written as one JSON line to
// <profile>/commonpost-mcp-confirmations.log and to the console. The journal must never stop a request: any failure
// to write it is a warning. These tests run the real appendFilterConfirmationLog against stand-in files.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const apiSource = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");

function constSource(name) {
  const start = apiSource.indexOf(`const ${name} =`);
  assert.ok(start >= 0, `${name} not found in api.js`);
  return apiSource.slice(start, apiSource.indexOf(";", start) + 1);
}

function functionSource(name) {
  const start = apiSource.indexOf(`\nfunction ${name}(`);
  assert.ok(start >= 0, `${name} not found in api.js`);
  return apiSource.slice(start + 1, apiSource.indexOf("\n}\n", start) + 3);
}

const LOG_NAME = "commonpost-mcp-confirmations.log";

function makeWorld({ exists = false, symlink = false, regular = true, size = 10, oldExists = false, failWrite = false } = {}) {
  const logged = [];
  const warned = [];
  const written = [];
  const ops = [];
  const sandbox = {
    console: { log: (...args) => logged.push(args.join(" ")), warn: (...args) => warned.push(args) },
    Ci: { nsIFile: "nsIFile", nsIFileOutputStream: "stream", nsIConverterOutputStream: "converter" },
    Services: {
      dirsvc: {
        get(key) {
          assert.equal(key, "ProfD");
          const segments = [];
          const file = {
            get path() { return `/profile/${segments.join("/")}`; },
            append(name) { segments.push(name); },
            exists() { return segments.at(-1) === `${LOG_NAME}.1` ? oldExists : exists; },
            isSymlink: () => symlink,
            isFile: () => regular,
            fileSize: size,
            remove(recursive) { ops.push(["remove", segments.join("/"), recursive]); },
            moveTo(dir, name) { ops.push(["moveTo", dir, name]); },
            get parent() { return { clone: () => ({ append(name) { segments.splice(0, segments.length, name); }, exists: () => oldExists, remove(recursive) { ops.push(["removeOld", segments.join("/"), recursive]); } }) }; },
          };
          return file;
        },
      },
    },
    Cc: {
      "@mozilla.org/network/file-output-stream;1": { createInstance: () => ({ init(file, flags, perms, behavior) { if (failWrite) throw new Error("disk full"); ops.push(["init", file.path, flags, perms, behavior]); } }) },
      "@mozilla.org/intl/converter-output-stream;1": {
        createInstance: () => ({ init(stream, charset) { ops.push(["converter", charset]); }, writeString: (s) => written.push(s), close() { ops.push(["close"]); } }),
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext([
    constSource("FILTER_CONFIRM_LOG_NAME"),
    constSource("FILTER_CONFIRM_LOG_MAX_BYTES"),
    functionSource("describeError"),
    functionSource("appendFilterConfirmationLog"),
    "this.append = appendFilterConfirmationLog;",
  ].join("\n"), sandbox);
  return { append: sandbox.append, logged, warned, written, ops };
}

describe("appendFilterConfirmationLog", () => {
  it("writes one timestamped JSON line, readable by the user only, to the profile's journal and to the console", () => {
    const w = makeWorld();
    w.append({ event: "requested", id: "fc-1", operation: "create", accountId: "account1" });
    assert.equal(w.written.length, 1);
    assert.ok(w.written[0].endsWith("\n"));
    const { t, ...rest } = JSON.parse(w.written[0]);
    assert.match(t, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.deepEqual(rest, { event: "requested", id: "fc-1", operation: "create", accountId: "account1" });
    assert.equal(w.logged.length, 1);
    assert.equal(w.logged[0], `commonpost-mcp: filter confirmation ${w.written[0].trimEnd()}`);
    // 0x02 write only | 0x08 create | 0x10 append, mode 0600
    assert.deepEqual(w.ops.filter((o) => o[0] === "init"), [["init", `/profile/${LOG_NAME}`, 0x1a, 0o600, 0]]);
    assert.deepEqual(w.ops.filter((o) => o[0] === "converter"), [["converter", "UTF-8"]]);
    assert.ok(w.ops.some((o) => o[0] === "close"));
    assert.deepEqual(w.warned, []);
  });

  it("keeps appending to a journal that exists and is small enough", () => {
    const w = makeWorld({ exists: true, size: 1000 });
    w.append({ event: "accepted" });
    assert.equal(w.written.length, 1);
    assert.deepEqual(w.ops.filter((o) => o[0] === "moveTo" || o[0] === "removeOld"), []);
  });

  it("moves a journal of more than 256 KiB to .1 first, replacing an older .1", () => {
    const w = makeWorld({ exists: true, size: 256 * 1024 + 1, oldExists: true });
    w.append({ event: "accepted" });
    assert.deepEqual(w.ops.filter((o) => o[0] === "removeOld"), [["removeOld", `${LOG_NAME}.1`, false]]);
    assert.deepEqual(w.ops.filter((o) => o[0] === "moveTo"), [["moveTo", null, `${LOG_NAME}.1`]]);
    assert.equal(w.written.length, 1, "the event is still written, to a fresh journal");
  });

  it("rotates without removing anything when there is no older .1", () => {
    const w = makeWorld({ exists: true, size: 256 * 1024 + 1, oldExists: false });
    w.append({ event: "accepted" });
    assert.deepEqual(w.ops.filter((o) => o[0] === "removeOld"), []);
    assert.deepEqual(w.ops.filter((o) => o[0] === "moveTo"), [["moveTo", null, `${LOG_NAME}.1`]]);
  });

  it("does not rotate a journal of exactly 256 KiB", () => {
    const w = makeWorld({ exists: true, size: 256 * 1024 });
    w.append({ event: "accepted" });
    assert.deepEqual(w.ops.filter((o) => o[0] === "moveTo"), []);
  });

  for (const [label, options] of [["a symlink", { exists: true, symlink: true }], ["not a regular file", { exists: true, regular: false }]]) {
    it(`never writes through a journal that is ${label}: a warning, and the console line is still logged`, () => {
      const w = makeWorld(options);
      w.append({ event: "refused" });
      assert.deepEqual(w.written, []);
      assert.equal(w.logged.length, 1);
      assert.equal(w.warned.length, 1);
      assert.match(String(w.warned[0][0]), /could not write the filter confirmation journal/);
      assert.match(w.warned[0][1].message, /is not a regular file/);
    });
  }

  it("warns, and does not throw, when the journal cannot be written", () => {
    const w = makeWorld({ failWrite: true });
    assert.doesNotThrow(() => w.append({ event: "failed" }));
    assert.equal(w.warned.length, 1);
    assert.equal(w.warned[0][1].message, "disk full");
  });

  it("logs an event that cannot be turned into JSON as an error line that keeps the event name", () => {
    const w = makeWorld();
    const loop = { event: "requested" };
    loop.self = loop;
    w.append(loop);
    const record = JSON.parse(w.written[0]);
    assert.equal(record.event, "requested");
    assert.match(record.error, /^unserializable: .*circular/i);
    assert.match(record.t, /^\d{4}-/);
    const big = makeWorld();
    big.append({ event: "requested", size: 10n });
    assert.match(JSON.parse(big.written[0]).error, /^unserializable: /);
  });
});

describe("describeError", () => {
  it("gives the message of an error, the text of anything else and 'unknown error' for nothing", () => {
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(`${functionSource("describeError")}\nthis.describeError = describeError;`, sandbox);
    const d = sandbox.describeError;
    assert.equal(d(new Error("boom")), "boom");
    assert.equal(d(null), "unknown error");
    assert.equal(d(undefined), "unknown error");
    assert.equal(d("plain text"), "plain text");
    assert.equal(d(0), "0");
    assert.equal(d(false), "false");
    assert.equal(d({ message: "" }), "[object Object]");
    assert.equal(d({ message: "from a plain object" }), "from a plain object");
    assert.equal(d({ toString() { throw new Error("no text"); } }), "unknown error");
    assert.equal(d(Object.create(null)), "unknown error", "an object without toString cannot be turned into text");
  });
});

describe("the preferences and ids of the filter confirmations", () => {
  const start = apiSource.indexOf("const FILTER_PREFS = {");
  const prefsSource = apiSource.slice(start, apiSource.indexOf("\n};\n", start) + 4);

  function load(prefs) {
    const sandbox = {
      Services: { prefs },
      Cc: { "@mozilla.org/security/random-generator;1": { createInstance: () => ({ generateRandomBytes: (n) => Uint8Array.from({ length: n }, (_, i) => i * 17 % 256) }) } },
      Ci: { nsIRandomGenerator: "nsIRandomGenerator" },
    };
    vm.createContext(sandbox);
    vm.runInContext(`${prefsSource}\n${functionSource("newUntrustedContentNonce")}\n${functionSource("randomConfirmationId")}
this.api = { FILTER_PREFS, newUntrustedContentNonce, randomConfirmationId };`, sandbox);
    return sandbox.api;
  }

  const PREFS = { PREF_STRING: 32, PREF_INT: 64, PREF_BOOL: 128, PREF_INVALID: 0 };

  it("names the type of a preference as string, bool, int or none", () => {
    const types = { "p.s": 32, "p.b": 128, "p.i": 64 };
    const { FILTER_PREFS } = load({ ...PREFS, getPrefType: (name) => types[name] ?? 0 });
    assert.equal(FILTER_PREFS.type("p.s"), "string");
    assert.equal(FILTER_PREFS.type("p.b"), "bool");
    assert.equal(FILTER_PREFS.type("p.i"), "int");
    assert.equal(FILTER_PREFS.type("p.missing"), "none");
  });

  it("reads a preference through the accessor of its type, without a default", () => {
    const calls = [];
    const { FILTER_PREFS } = load({
      ...PREFS,
      getStringPref: (...args) => { calls.push(["string", ...args]); return "text"; },
      getBoolPref: (...args) => { calls.push(["bool", ...args]); return true; },
      getIntPref: (...args) => { calls.push(["int", ...args]); return 7; },
    });
    assert.deepEqual([FILTER_PREFS.string("a"), FILTER_PREFS.bool("b"), FILTER_PREFS.int("c")], ["text", true, 7]);
    assert.deepEqual(calls, [["string", "a"], ["bool", "b"], ["int", "c"]]);
  });

  it("makes a confirmation id of fc- and 24 hexadecimal digits, and a nonce of 24 hexadecimal digits, from random bytes", () => {
    const { randomConfirmationId, newUntrustedContentNonce } = load({});
    assert.equal(randomConfirmationId(), "fc-00112233445566778899aabb");
    assert.match(randomConfirmationId(), /^fc-[0-9a-f]{24}$/);
    assert.match(newUntrustedContentNonce(), /^[0-9a-f]{24}$/);
  });
});
