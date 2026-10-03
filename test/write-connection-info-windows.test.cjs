"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadWriteConnectionInfo(sandbox) {
  const apiPath = path.resolve(__dirname, "../extension/mcp_server/api.js");
  const source = fs.readFileSync(apiPath, "utf8");
  const startMarker = "// BEGIN CONNECTION INFO WRITER";
  const endMarker = "// END CONNECTION INFO WRITER";
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  assert.ok(start >= 0, "connection info writer start marker missing");
  assert.ok(end > start, "connection info writer end marker missing");

  const snippet = source.slice(start, end);
  vm.createContext(sandbox);
  vm.runInContext(
    `${snippet}
this.writeConnectionInfo = writeConnectionInfo;`,
    sandbox
  );
  return sandbox.writeConnectionInfo;
}

/**
 * Minimal nsIFile stand-in for <TmpD>/commonpost-mcp. `permissions` mimics
 * platform behaviour: on Windows nsIFile reports a synthesised mode (0o777
 * for directories) and assignments are ignored (NTFS ACLs); on POSIX the
 * assignment takes effect unless `chmodFails` is set.
 */
function makeTmpDir({ exists = true, permissions = 0o777, chmodWorks = true }) {
  let mode = permissions;
  const dir = {
    segments: [],
    chmodCalls: [],
    append(name) { this.segments.push(name); },
    exists() { return exists; },
    isSymlink() { return false; },
    create() { exists = true; },
    get permissions() { return mode; },
    set permissions(value) {
      this.chmodCalls.push(value);
      if (chmodWorks) mode = value;
    },
    clone() {
      const file = {
        segments: [...this.segments],
        append(name) { this.segments.push(name); },
        exists() { return false; },
        remove() {},
        get path() { return this.segments.join("/"); },
      };
      return file;
    },
  };
  return dir;
}

function makeSandbox({ os, tmpDir }) {
  const written = [];
  return {
    written,
    sandbox: {
      Services: {
        dirsvc: { get: () => tmpDir },
        appinfo: { OS: os, processID: 4242 },
      },
      Ci: { nsIFile: { DIRECTORY_TYPE: 1 } },
      Cc: {
        "@mozilla.org/network/file-output-stream;1": {
          createInstance: () => ({ init() {} }),
        },
        "@mozilla.org/intl/converter-output-stream;1": {
          createInstance: () => ({
            init() {},
            writeString(data) { written.push(data); },
            close() {},
          }),
        },
      },
    },
  };
}

describe("writeConnectionInfo directory hardening", () => {
  it("skips the POSIX permission check on Windows where nsIFile reports 0o777", () => {
    const tmpDir = makeTmpDir({ permissions: 0o777, chmodWorks: false });
    const { sandbox, written } = makeSandbox({ os: "WINNT", tmpDir });
    const writeConnectionInfo = loadWriteConnectionInfo(sandbox);

    const result = writeConnectionInfo(8780, "token");

    assert.equal(result, "commonpost-mcp/connection.json");
    assert.deepEqual(tmpDir.chmodCalls, []);
    assert.deepEqual(JSON.parse(written[0]), { port: 8780, token: "token", pid: 4242, protectedDirs: [] });
  });

  it("still refuses a group/world-accessible directory on POSIX when chmod fails", () => {
    const tmpDir = makeTmpDir({ permissions: 0o777, chmodWorks: false });
    const { sandbox } = makeSandbox({ os: "Linux", tmpDir });
    const writeConnectionInfo = loadWriteConnectionInfo(sandbox);

    assert.throws(
      () => writeConnectionInfo(8780, "token"),
      /group\/world permissions/
    );
    assert.deepEqual(tmpDir.chmodCalls, [0o700]);
  });

  it("repairs a permissive directory on POSIX when chmod succeeds", () => {
    const tmpDir = makeTmpDir({ permissions: 0o755, chmodWorks: true });
    const { sandbox, written } = makeSandbox({ os: "Linux", tmpDir });
    const writeConnectionInfo = loadWriteConnectionInfo(sandbox);

    const result = writeConnectionInfo(8770, "token");

    assert.equal(result, "commonpost-mcp/connection.json");
    assert.equal(tmpDir.permissions, 0o700);
    assert.equal(written.length, 1);
  });
});

// A directory as nsIFile hands it out (only .path is read: no file-system
// access while the list is built).
function makeDir(givenPath) {
  return { path: givenPath };
}

// The writer together with the deny-list helpers it uses to skip directories
// that are already refused (isSensitiveFilePath, isInsideProtectedDirs).
function loadWriterWithPathHelpers(sandbox) {
  const source = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");
  const helpers = source.slice(source.indexOf("// BEGIN SENSITIVE ATTACHMENT PATH HELPERS"), source.indexOf("// END SENSITIVE ATTACHMENT PATH HELPERS"));
  const writer = source.slice(source.indexOf("// BEGIN CONNECTION INFO WRITER"), source.indexOf("// END CONNECTION INFO WRITER"));
  vm.createContext(sandbox);
  vm.runInContext(`${helpers}\n${writer}\nthis.writeConnectionInfo = writeConnectionInfo;`, sandbox);
  return sandbox.writeConnectionInfo;
}

describe("writeConnectionInfo lists the profile and mail-store directories for the bridge", () => {
  function sandboxWith({ profiles = [], servers = [], profD, profLD } = {}) {
    const tmpDir = makeTmpDir({ permissions: 0o700, chmodWorks: true });
    const { sandbox, written } = makeSandbox({ os: "Linux", tmpDir });
    sandbox.Services.dirsvc.get = (key) => {
      if (key === "TmpD") return tmpDir;
      if (key === "ProfD") return profD;
      if (key === "ProfLD") return profLD;
      throw new Error(`no ${key}`);
    };
    sandbox.Ci.nsIToolkitProfileService = {};
    sandbox.Cc["@mozilla.org/toolkit/profile-service;1"] = { getService: () => ({ profiles }) };
    sandbox.MailServices = { accounts: { allServers: servers } };
    const warnings = [];
    sandbox.console = { warn: (...args) => warnings.push(args.join(" ")) };
    return { sandbox, written, warnings };
  }

  it("running profile and its servers first, then other profiles; every directory listed once, even one that seems covered by its path (it may be a link elsewhere)", () => {
    const { sandbox, written } = sandboxWith({
      profD: makeDir("/data/tb-profile"),
      profLD: makeDir("/data/tb-profile"),
      servers: [{ localPath: makeDir("/data/tb-profile/Mail/Local Folders") }, { localPath: makeDir("/mnt/mail/imap") }],
      profiles: [
        { rootDir: makeDir("/data/tb-profile"), localDir: makeDir("/data/tb-profile") },
        { rootDir: makeDir("/home/u/.thunderbird/old.default"), localDir: makeDir("/home/u/.cache/thunderbird/old.default") },
        { rootDir: makeDir("/media/usb/portable-profile"), localDir: makeDir("/media/usb/portable-profile") },
      ],
    });
    loadWriterWithPathHelpers(sandbox)(8700, "token");
    assert.deepEqual(JSON.parse(written[0]).protectedDirs, [
      "/data/tb-profile",
      "/data/tb-profile/Mail/Local Folders",
      "/mnt/mail/imap",
      "/home/u/.thunderbird/old.default",
      "/home/u/.cache/thunderbird/old.default",
      "/media/usb/portable-profile",
    ]);
  });

  it("caps the list by the size of its JSON, keeps the running profile's servers, and warns once", () => {
    const long = (i) => `/data/other-profiles/${String(i).padStart(4, "0")}-${"x".repeat(900)}`;
    const profiles = Array.from({ length: 60 }, (_, i) => ({ rootDir: makeDir(long(i)), localDir: makeDir(long(i)) }));
    const { sandbox, written, warnings } = sandboxWith({
      profD: makeDir("/data/tb-profile"),
      servers: [{ localPath: makeDir("D-drive/Mail".replace("D-drive", "/mnt/d")) }],
      profiles,
    });
    const write = loadWriterWithPathHelpers(sandbox);
    write(8700, "token");
    write(8700, "token");
    const dirs = JSON.parse(written[0]).protectedDirs;
    assert.deepEqual(dirs.slice(0, 2), ["/data/tb-profile", "/mnt/d/Mail"]);
    assert.ok(written[0].length < 40 * 1024, `connection file of ${written[0].length} bytes`);
    assert.ok(dirs.length < 62);
    assert.equal(warnings.filter((w) => w.includes("size limit")).length, 1);
  });

  it("writes ASCII only, so that the file reads back the same (no endless rewrite for an accented path)", () => {
    const { sandbox, written } = sandboxWith({ profD: makeDir("C:/Users/Frédéric/Documents/Thunderbird-profil-ñ-漢") });
    loadWriterWithPathHelpers(sandbox)(8700, "token");
    assert.match(written[0], /^[\x20-\x7e]*$/);
    // readConnectionInfo reads the bytes one by one (Latin-1): the same text comes back.
    const readBack = JSON.parse(Buffer.from(written[0], "utf8").toString("latin1"));
    assert.deepEqual(readBack.protectedDirs, ["C:/Users/Frédéric/Documents/Thunderbird-profil-ñ-漢"]);
  });

  it("still writes the file when Thunderbird cannot list profiles or servers, and warns once", () => {
    const { sandbox, written, warnings } = sandboxWith({ profD: makeDir("/data/tb-profile") });
    sandbox.Cc["@mozilla.org/toolkit/profile-service;1"] = { getService: () => { throw new Error("no profile service"); } };
    sandbox.MailServices = undefined;
    const write = loadWriterWithPathHelpers(sandbox);
    write(8700, "token");
    write(8700, "token");
    assert.deepEqual(JSON.parse(written[0]).protectedDirs, ["/data/tb-profile"]);
    assert.equal(warnings.filter((w) => w.includes("profiles")).length, 1);
    assert.equal(warnings.filter((w) => w.includes("servers")).length, 1);
  });
});
