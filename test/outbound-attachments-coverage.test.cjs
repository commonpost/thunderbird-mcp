// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";

// filePathsToAttachDescs and findSymlinkAncestor with the real deny-list, on a fake file system: the paths that are
// refused, the size limits (file, inline base64, aggregate), the invalid entries and the clean-up after a failure.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");
function region(name) {
  const start = source.indexOf(`// BEGIN ${name}`);
  const end = source.indexOf(`// END ${name}`, start);
  assert.ok(start >= 0 && end > start, `${name} missing`);
  return source.slice(start, end);
}

const MiB = 1024 * 1024;
const plain = value => JSON.parse(JSON.stringify(value));

// A file the path attachments are read from, as nsIFile gives it. ancestors: its directories, root-first.
function makeFile(filePath, options = {}) {
  const {
    exists = true, normalizedPath = filePath, normalizeError = null, symlink = false, regularFile = true,
    size = 1, ancestors = ["/"], parentError = null, symlinkError = null, typeError = null, sizeError = null,
  } = options;
  const chain = (index) => {
    const entry = typeof ancestors[index] === "string" ? { path: ancestors[index] } : ancestors[index];
    return {
      get path() { return entry.path; },
      isSymlink() {
        if (entry.symlinkError) throw entry.symlinkError;
        return !!entry.symlink;
      },
      get parent() {
        if (entry.parentError) throw entry.parentError;
        return chain(Math.max(index - 1, 0));
      },
    };
  };
  return {
    path: filePath,
    leafName: filePath.split("/").pop(),
    exists: () => exists,
    isSymlink() {
      if (symlinkError) throw symlinkError;
      return symlink;
    },
    normalize() {
      if (normalizeError) throw normalizeError;
      this.path = normalizedPath;
    },
    get parent() {
      if (parentError) throw parentError;
      return chain(ancestors.length - 1);
    },
    isFile() {
      if (typeError) throw typeError;
      return regularFile;
    },
    get fileSize() {
      if (sizeError) throw sizeError;
      return size;
    },
  };
}

// The temporary directory the decoded attachments go to
function makeTempFs({ removeError = null } = {}) {
  const dirs = new Set(["/tmp"]);
  const written = new Map();
  const removed = [];
  class TempFile {
    constructor(p) { this.p = p; }
    get path() { return this.p; }
    append(name) { this.p = `${this.p}/${name}`; }
    clone() { return new TempFile(this.p); }
    exists() { return dirs.has(this.p) || written.has(this.p); }
    create() { dirs.add(this.p); }
    remove() {
      if (removeError) throw removeError;
      written.delete(this.p);
      removed.push(this.p);
    }
    get fileSize() { return written.has(this.p) ? written.get(this.p).length : 0; }
  }
  return { TempFile, dirs, written, removed };
}

function load({ files = new Map(), protectedDirs = [], os = "Linux", tempFs = makeTempFs(), atob = globalThis.atob, newFileURIError = null } = {}) {
  const warnings = [];
  const created = [];
  const sandbox = {
    Uint8Array,
    console: { warn: (...args) => warnings.push(args) },
    Ci: { nsIFile: { DIRECTORY_TYPE: 1 }, nsIFileOutputStream: {}, nsIBinaryOutputStream: {} },
    Cc: {
      "@mozilla.org/network/file-output-stream;1": { createInstance: () => ({ file: null, init(file) { this.file = file; }, close() {} }) },
      "@mozilla.org/binaryoutputstream;1": {
        createInstance: () => ({
          target: null,
          setOutputStream(stream) { this.target = stream; },
          writeByteArray(bytes) { tempFs.written.set(this.target.file.path, Uint8Array.from(bytes)); },
          close() {},
        }),
      },
    },
    Services: {
      appinfo: { OS: os },
      dirsvc: { get: () => new tempFs.TempFile("/tmp") },
      io: {
        extractScheme(url) {
          const m = /^([a-z][a-z0-9+.-]*):/i.exec(url);
          if (!m) throw new Error("NS_ERROR_MALFORMED_URI");
          return m[1];
        },
        newFileURI(file) {
          if (newFileURIError) throw newFileURIError;
          return { spec: `file://${file.path}` };
        },
      },
    },
    createLocalFile(p) {
      created.push(p);
      const file = files.get(p);
      if (!file) throw new Error(`no such file: ${p}`);
      return file;
    },
    protectedMailDirectories: () => protectedDirs,
  };
  if (atob) sandbox.atob = atob;
  vm.createContext(sandbox);
  vm.runInContext(`let _tempFileCounter = 0;
const _tempAttachFiles = new Set();
${["INLINE ATTACHMENT BASE64 HELPERS", "OUTBOUND ATTACHMENT LIMITS", "SENSITIVE ATTACHMENT PATH HELPERS", "OUTBOUND ATTACHMENT CONVERSION"]
    .map(region).join("\n")}
Object.assign(this, { filePathsToAttachDescs, findSymlinkAncestor, realDirectoryPaths, storedAttachmentDescs, _tempAttachFiles });`, sandbox);
  return { api: sandbox, warnings, created, tempFs };
}

const convert = (entries, options = {}, callOptions) => {
  const world = load(options);
  return { ...world, result: plain(world.api.filePathsToAttachDescs(entries, callOptions)) };
};

describe("path attachments refused by the deny-list or by the file system", () => {
  it("refuses a sensitive path before touching the file system, saying which rule applied", () => {
    const { result, created } = convert([
      "/home/me/.ssh/id_rsa",
      "/mnt/c/Users/Me/AppData/Local/Temp/report.pdf",
      "//server/share/a.txt",
    ]);
    assert.deepEqual(result.descs, []);
    assert.deepEqual(result.failed, [
      "/home/me/.ssh/id_rsa (sensitive path blocked)",
      "/mnt/c/Users/Me/AppData/Local/Temp/report.pdf (files under AppData (on Windows this includes %TEMP%) can't be attached; copy the file to another folder, for example Documents)",
      "//server/share/a.txt (sensitive path blocked)",
    ]);
    assert.deepEqual(created, [], "no file was looked up");
  });

  it("refuses every file path on Windows, where a link or junction cannot be seen", () => {
    const files = new Map([["C:/Users/me/a.txt", makeFile("C:/Users/me/a.txt")]]);
    const { result, created } = convert(["C:/Users/me/a.txt"], { files, os: "WINNT" });
    assert.deepEqual(result.descs, []);
    assert.match(result.failed[0], /^C:\/Users\/me\/a\.txt \(a file path attachment cannot be verified on Windows through this tool/);
    assert.deepEqual(created, []);
  });

  it("names a file that does not exist by its path alone", () => {
    const files = new Map([["/data/gone.txt", makeFile("/data/gone.txt", { exists: false })]]);
    assert.deepEqual(convert(["/data/gone.txt"], { files }).result.failed, ["/data/gone.txt"]);
  });

  it("refuses a path that is a profile or mail store directory, or under one", () => {
    const files = new Map([["/data/profile/prefs.txt", makeFile("/data/profile/prefs.txt")]]);
    const { result } = convert(["/data/profile/prefs.txt"], { files, protectedDirs: ["/DATA/Profile/"] });
    assert.deepEqual(result.failed, ["/data/profile/prefs.txt (Thunderbird profile or mail store path blocked)"]);
  });

  it("refuses a link that leads into a protected directory once the path is normalized", () => {
    const files = new Map([["/data/innocent.txt", makeFile("/data/innocent.txt", { normalizedPath: "/data/profile/prefs.txt" })]]);
    const { result } = convert(["/data/innocent.txt"], { files, protectedDirs: ["/data/profile"] });
    assert.deepEqual(result.failed, ["/data/innocent.txt (Thunderbird profile or mail store path blocked)"]);
  });

  it("refuses a path that is only sensitive once normalized, and a file it cannot normalize", () => {
    const files = new Map([
      ["/data/innocent.txt", makeFile("/data/innocent.txt", { normalizedPath: "/home/me/.ssh/id_rsa" })],
      ["/data/odd.txt", makeFile("/data/odd.txt", { normalizeError: new Error("bad path") })],
    ]);
    const { result } = convert(["/data/innocent.txt", "/data/odd.txt"], { files });
    assert.deepEqual(result.failed, ["/data/innocent.txt (sensitive path blocked)", "/data/odd.txt (path normalization failed)"]);
  });

  it("refuses a symlink, and a file whose link check fails", () => {
    const files = new Map([
      ["/data/link.txt", makeFile("/data/link.txt", { symlink: true })],
      ["/data/broken.txt", makeFile("/data/broken.txt", { symlinkError: new Error("stat failed") })],
    ]);
    assert.deepEqual(convert(["/data/link.txt", "/data/broken.txt"], { files }).result.failed, [
      "/data/link.txt (symlinked path blocked)",
      "/data/broken.txt (symlink check failed)",
    ]);
  });

  it("refuses a file under a symlinked directory, and names a parent it cannot check", () => {
    const files = new Map([
      ["/data/linked/a.txt", makeFile("/data/linked/a.txt", { ancestors: ["/", "/data", { path: "/data/linked", symlink: true }] })],
      ["/data/denied/a.txt", makeFile("/data/denied/a.txt", { ancestors: ["/", "/data", { path: "/data/denied", symlinkError: new Error("EACCES") }] })],
      ["/data/lost/a.txt", makeFile("/data/lost/a.txt", { parentError: new Error("no parent") })],
    ]);
    assert.deepEqual(convert(["/data/linked/a.txt", "/data/denied/a.txt", "/data/lost/a.txt"], { files }).result.failed, [
      "/data/linked/a.txt (a parent directory is a symlink or reparse point: /data/linked)",
      "/data/denied/a.txt (parent directory check failed: EACCES)",
      "/data/lost/a.txt (parent directory check failed: no parent)",
    ]);
  });

  it("names a directory, a file whose type or size cannot be read, and a size that is not a size", () => {
    const files = new Map([
      ["/data/dir", makeFile("/data/dir", { regularFile: false })],
      ["/data/type.txt", makeFile("/data/type.txt", { typeError: new Error("x") })],
      ["/data/size.txt", makeFile("/data/size.txt", { sizeError: new Error("x") })],
      ["/data/negative.txt", makeFile("/data/negative.txt", { size: -1 })],
      ["/data/fraction.txt", makeFile("/data/fraction.txt", { size: 1.5 })],
      ["/data/nan.txt", makeFile("/data/nan.txt", { size: NaN })],
    ]);
    assert.deepEqual(convert([...files.keys()], { files }).result.failed, [
      "/data/dir (not a regular file)",
      "/data/type.txt (file type check failed)",
      "/data/size.txt (file size check failed)",
      "/data/negative.txt (invalid file size)",
      "/data/fraction.txt (invalid file size)",
      "/data/nan.txt (invalid file size)",
    ]);
  });

  it("allows a file of exactly the limit and refuses one a byte over, and then any more than the total", () => {
    const files = new Map([
      ["/data/exact.bin", makeFile("/data/exact.bin", { size: 50 * MiB })],
      ["/data/over.bin", makeFile("/data/over.bin", { size: 50 * MiB + 1 })],
      ["/data/one.bin", makeFile("/data/one.bin", { size: 1 })],
    ]);
    const { result } = convert(["/data/exact.bin", "/data/over.bin", "/data/one.bin"], { files });
    assert.deepEqual(result.descs, [{ url: "file:///data/exact.bin", name: "exact.bin", size: 50 * MiB }]);
    assert.deepEqual(result.failed, [
      "/data/over.bin (exceeds 50MB size limit)",
      "/data/one.bin (exceeds 50MB aggregate attachment limit)",
    ]);
  });

  it("describes a file that passes every check", () => {
    const files = new Map([["/data/report.pdf", makeFile("/data/report.pdf", { size: 1234, ancestors: ["/", "/data"] })]]);
    assert.deepEqual(convert(["/data/report.pdf"], { files }).result, {
      descs: [{ url: "file:///data/report.pdf", name: "report.pdf", size: 1234 }],
      failed: [],
    });
  });

  it("names a file the file system cannot open and a URL it cannot build, by what the caller gave", () => {
    assert.deepEqual(convert(["/data/unreadable.txt"]).result.failed, ["/data/unreadable.txt"]);
    const files = new Map([["/data/a.txt", makeFile("/data/a.txt")]]);
    assert.deepEqual(convert(["/data/a.txt"], { files, newFileURIError: new Error("no uri") }).result.failed, ["/data/a.txt"]);
  });

  it("reads no list as an empty one, and cuts a list at twenty attachments", () => {
    for (const value of [undefined, null, "/data/a.txt", {}]) {
      assert.deepEqual(convert(value).result, { descs: [], failed: [] });
    }
    const files = new Map();
    const entries = Array.from({ length: 22 }, (_, i) => {
      files.set(`/data/f${i}.txt`, makeFile(`/data/f${i}.txt`));
      return `/data/f${i}.txt`;
    });
    const { result } = convert(entries, { files });
    assert.equal(result.descs.length, 20);
    assert.deepEqual(result.failed, ["Attachment count 22 exceeds the 20 attachment limit; skipped 2 attachment(s)"]);
  });
});

describe("findSymlinkAncestor", () => {
  const { api } = load();

  it("returns null for a file whose directories are all real, up to a root that is its own parent", () => {
    assert.equal(api.findSymlinkAncestor(makeFile("/a/b/c.txt", { ancestors: ["/", "/a", "/a/b"] })), null);
    assert.equal(api.findSymlinkAncestor({ path: "/c.txt", parent: null }), null);
  });

  it("names the nearest linked directory", () => {
    const file = makeFile("/a/b/c.txt", { ancestors: ["/", { path: "/a", symlink: true }, { path: "/a/b", symlink: true }] });
    assert.equal(api.findSymlinkAncestor(file), "/a/b");
  });

  it("wraps every failure to read a parent in an error that keeps the cause", () => {
    const cause = new Error("EIO");
    const failing = [
      makeFile("/a/c.txt", { parentError: cause }),
      makeFile("/a/c.txt", { ancestors: ["/", { path: "/a", symlinkError: cause }] }),
      makeFile("/a/c.txt", { ancestors: ["/", { path: "/a", parentError: cause }] }),
    ];
    for (const file of failing) {
      assert.throws(() => api.findSymlinkAncestor(file), error => error.message === "parent directory check failed: EIO" && error.cause === cause);
    }
    assert.throws(() => api.findSymlinkAncestor(makeFile("/a/c.txt", { parentError: "plain text" })), /parent directory check failed: plain text/);
  });

  it("reports whatever was thrown, even a bare string, nothing or an error without a message", () => {
    // Where the check fails: reading the file's parent, a directory's link flag, or a directory's parent
    const failingAt = (where, thrown) => ({
      path: "/a/c.txt",
      get parent() {
        if (where === "file") throw thrown;
        return {
          path: "/a",
          isSymlink() {
            if (where === "link") throw thrown;
            return false;
          },
          get parent() {
            if (where === "directory") throw thrown;
            return { path: "/", isSymlink: () => false, get parent() { return this; } };
          },
        };
      },
    });
    const cases = [
      [undefined, "undefined"], [null, "null"], [0, "0"], ["", ""], ["plain text", "plain text"],
      [{ message: "described" }, "described"], [{ message: "" }, "[object Object]"],
    ];
    for (const where of ["file", "link", "directory"]) {
      for (const [thrown, text] of cases) {
        assert.throws(() => api.findSymlinkAncestor(failingAt(where, thrown)), error => error.message === `parent directory check failed: ${text}`, `${where} ${String(thrown)}`);
      }
    }
  });

  it("gives up on a chain that never reaches a root", () => {
    let calls = 0;
    const endless = { get path() { return `/d${calls}`; }, isSymlink: () => false, get parent() { calls++; return endless; } };
    assert.equal(api.findSymlinkAncestor({ path: "/f", parent: endless }), null);
    assert.ok(calls <= 256 && calls > 1);
  });
});

describe("realDirectoryPaths", () => {
  it("resolves each directory and leaves out one that cannot be resolved", () => {
    const resolved = makeFile("/link/profile", { normalizedPath: "/real/profile" });
    const broken = makeFile("/missing", { normalizeError: new Error("gone") });
    const files = new Map([["/link/profile", resolved], ["/missing", broken]]);
    const { api } = load({ files });
    assert.deepEqual(plain(api.realDirectoryPaths(["/link/profile", "/missing", "/unknown"])), ["/real/profile"]);
  });
});

describe("storedAttachmentDescs", () => {
  const { api } = load();

  it("names an external attachment by its name, else its part, else as unnamed", () => {
    const { descs, external } = api.storedAttachmentDescs({
      allUserAttachments: [
        { isExternal: true, name: "linked.pdf", partName: "1.2" },
        { isExternal: true, partName: "1.3" },
        { isExternal: true },
        { url: "mailbox:///Inbox?number=4&part=1.4", name: "kept.pdf", contentType: "application/pdf" },
      ],
    });
    assert.deepEqual(Array.from(external, text => text.match(/^"([^"]*)"/)[1]), ["linked.pdf", "1.3", "unnamed attachment"]);
    assert.deepEqual(plain(descs), [{ url: "mailbox:///Inbox?number=4&part=1.4", name: "kept.pdf", contentType: "application/pdf" }]);
  });
});

describe("inline base64 attachments", () => {
  const b64 = text => Buffer.from(text).toString("base64");

  it("writes the decoded bytes to a temporary file named by the sanitized name, and returns its description", () => {
    const { result, tempFs } = convert([{ name: "re port.pdf", base64: b64("hello"), contentType: "application/pdf" }]);
    assert.equal(result.failed.length, 0);
    const [desc] = result.descs;
    assert.match(desc.url, /^file:\/\/\/tmp\/commonpost-mcp\/attachments\/\d+_\d+_re_port\.pdf$/);
    assert.equal(desc.name, "re port.pdf");
    assert.equal(desc.size, 5);
    assert.equal(desc.contentType, "application/pdf");
    assert.equal(Buffer.from(tempFs.written.get(desc.url.replace("file://", ""))).toString(), "hello");
    assert.ok(tempFs.dirs.has("/tmp/commonpost-mcp/attachments"));
  });

  it("accepts the content key, and leaves out the content type when there is none", () => {
    const { result } = convert([{ name: "a.txt", content: b64("hi") }]);
    assert.equal(result.descs[0].size, 2);
    assert.equal("contentType" in result.descs[0], false);
  });

  it("keeps a name made of dots or slashes inside the attachments directory", () => {
    const { result } = convert([{ name: "..", base64: b64("x") }, { name: "../../etc/passwd", base64: b64("y") }, { name: ".", base64: b64("z") }]);
    assert.deepEqual(result.failed, []);
    const urls = result.descs.map(d => d.url);
    assert.match(urls[0], /^file:\/\/\/tmp\/commonpost-mcp\/attachments\/\d+_\d+_attachment$/);
    assert.match(urls[1], /^file:\/\/\/tmp\/commonpost-mcp\/attachments\/\d+_\d+_.._.._etc_passwd$/);
    assert.match(urls[2], /^file:\/\/\/tmp\/commonpost-mcp\/attachments\/\d+_\d+_attachment$/);
    assert.equal(new Set(urls).size, 3);
  });

  it("decodes without atob and without ChromeUtils, by hand, for every padding length", () => {
    for (const text of ["a", "ab", "abc", "abcd", "abcde", "\u00ff\u0000\u0080"]) {
      const { result, tempFs } = convert([{ name: "m.txt", base64: Buffer.from(text, "latin1").toString("base64") }], { atob: null });
      assert.deepEqual(result.failed, [], text);
      assert.equal(Buffer.from(tempFs.written.get(result.descs[0].url.replace("file://", ""))).toString("latin1"), text, text);
    }
  });

  it("refuses base64 that is not canonical, naming the attachment", () => {
    for (const value of ["abc", "ab=c", "ab==c===", "====", "a b c d", "ab\ncd==", "é===", 12345, true]) {
      const { result } = convert([{ name: "bad.bin", base64: value }]);
      assert.deepEqual(result.failed, ["bad.bin (invalid base64 data)"], String(value));
    }
  });

  it("refuses base64 longer than the limit without decoding it", () => {
    const { result } = convert([{ name: "huge.bin", base64: "A".repeat(25 * MiB + 4) }]);
    assert.deepEqual(result.failed, ["huge.bin (exceeds 25MB size limit)"]);
  });

  it("counts decoded bytes against the total, files included", () => {
    const files = new Map([["/data/big.bin", makeFile("/data/big.bin", { size: 50 * MiB })]]);
    const { result } = convert(["/data/big.bin", { name: "one.txt", base64: b64("x") }], { files });
    assert.equal(result.descs.length, 1);
    assert.deepEqual(result.failed, ["one.txt (exceeds 50MB aggregate attachment limit)"]);
  });

  it("only checks an attachment in a dry run, writing nothing", () => {
    const { result, tempFs } = convert([{ name: "a.txt", base64: b64("abc"), contentType: "text/plain" }, { name: "b.txt", base64: b64("de") }], {}, { dryRun: true });
    assert.deepEqual(result.descs, [{ name: "a.txt", size: 3, contentType: "text/plain" }, { name: "b.txt", size: 2, contentType: "" }]);
    assert.equal(tempFs.written.size, 0);
    assert.equal(tempFs.dirs.size, 1);
  });

  it("refuses an entry that is neither a path nor a named attachment with data", () => {
    const { result } = convert([null, 42, true, {}, { name: "nodata.txt" }, { base64: b64("x") }, { filename: "f.txt", base64: b64("x") }, ["a"]]);
    assert.deepEqual(result.descs, []);
    assert.deepEqual(result.failed, ["null", "42", "true", "{}", '{"name":"nodata.txt"}', '{"base64":"eA=="}', '{"filename":"f.txt","base64":"eA=="}', '["a"]']);
  });

  it("names an attachment that fails while it is written by its own name", () => {
    const { result } = convert([{ name: "boom.txt", base64: b64("x") }], { newFileURIError: new Error("no uri") });
    assert.deepEqual(result.failed, ["boom.txt"]);
  });
});

describe("clean-up of decoded attachments when the call fails", () => {
  const b64 = text => Buffer.from(text).toString("base64");

  it("removes the files already written, and forgets them, but not those of a call that succeeds", () => {
    const failing = load();
    const outcome = plain(failing.api.filePathsToAttachDescs([{ name: "a.txt", base64: b64("a") }, { name: "b.txt", base64: b64("b") }, { name: "bad.txt", base64: "!" }]));
    assert.equal(outcome.descs.length, 2);
    assert.equal(failing.tempFs.written.size, 0);
    assert.equal(failing.tempFs.removed.length, 2);
    assert.equal(failing.api._tempAttachFiles.size, 0);
    const passing = load();
    passing.api.filePathsToAttachDescs([{ name: "a.txt", base64: b64("a") }]);
    assert.equal(passing.tempFs.written.size, 1);
    assert.equal(passing.api._tempAttachFiles.size, 1);
  });

  it("goes on with the others, and says so, when one file cannot be removed", () => {
    const world = load({ tempFs: makeTempFs({ removeError: new Error("busy") }) });
    world.api.filePathsToAttachDescs([{ name: "a.txt", base64: b64("a") }, { name: "b.txt", base64: b64("b") }, 7]);
    assert.equal(world.warnings.length, 2);
    assert.match(world.warnings[0][0], /could not remove a decoded attachment after the call failed/);
    assert.equal(world.api._tempAttachFiles.size, 2, "files that could not be removed stay registered for the shutdown clean-up");
  });

  it("forgets a file that is already gone, without trying to remove it", () => {
    const tempFs = makeTempFs();
    // The file vanishes as soon as it is written
    const exists = tempFs.TempFile.prototype.exists;
    tempFs.TempFile.prototype.exists = function () { return this.p === "/tmp" || (exists.call(this) && !this.p.endsWith("a.txt")); };
    const world = load({ tempFs });
    const outcome = world.api.filePathsToAttachDescs([{ name: "a.txt", base64: b64("a") }, 7]);
    assert.equal(outcome.failed.length, 1);
    assert.deepEqual(tempFs.removed, []);
    assert.equal(world.api._tempAttachFiles.size, 0);
  });
});
