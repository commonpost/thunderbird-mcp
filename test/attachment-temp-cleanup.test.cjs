"use strict";

// A message with several inline base64 attachments where a later one is
// refused fails as a whole (see attachment-refusal.test.cjs). The earlier
// ones were already decoded to a temp file on disk before the refusal was
// found: those files are removed immediately, not left until the add-on
// next shuts down.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const apiSource = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");
function marked(startMarker, endMarker) {
  const start = apiSource.indexOf(startMarker);
  const end = apiSource.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `marker missing: ${startMarker}`);
  return apiSource.slice(start, end);
}

// A minimal fake filesystem/XPCOM environment: only what filePathsToAttachDescs
// touches on the inline-base64 path (Services.dirsvc.get("TmpD"), nsIFile
// append/exists/create/clone/remove, the output-stream pair that writes bytes).
function makeFakeFileSystem() {
  const existing = new Set(); // paths that "exist" on disk
  const removed = [];

  function makeFile(initialPath) {
    let p = initialPath;
    return {
      get path() { return p; },
      append(seg) { p = `${p}/${seg}`; },
      clone() { return makeFile(p); },
      exists() { return existing.has(p); },
      create() { existing.add(p); },
      remove() { existing.delete(p); removed.push(p); },
      get fileSize() { return 0; },
    };
  }

  const Ci = {
    nsIFile: { DIRECTORY_TYPE: 1, NORMAL_FILE_TYPE: 0 },
    nsIFileOutputStream: {},
    nsIBinaryOutputStream: {},
  };
  const Cc = {
    "@mozilla.org/network/file-output-stream;1": {
      createInstance: () => {
        const stream = { file: null, init(file) { stream.file = file; existing.add(file.path); }, close() {} };
        return stream;
      },
    },
    "@mozilla.org/binaryoutputstream;1": {
      createInstance: () => {
        let targetFile = null;
        return {
          setOutputStream(ostream) { targetFile = ostream.file; },
          writeByteArray() { if (targetFile) existing.add(targetFile.path); },
          close() {},
        };
      },
    },
  };

  const Services = {
    dirsvc: { get: () => makeFile("/tmp") },
    io: { newFileURI: (file) => ({ spec: `file://${file.path}` }) },
  };

  return { Ci, Cc, Services, existing, removed };
}

function loadWithFakeFs() {
  const fake = makeFakeFileSystem();
  const sandbox = {
    Ci: fake.Ci,
    Cc: fake.Cc,
    Services: fake.Services,
    _tempAttachFiles: new Set(),
    _tempFileCounter: 0,
    isSensitiveFilePath: () => false,
    isWindowsHost: () => false,
    getConfiguredGetMessagesLimit: () => 20,
  };
  vm.createContext(sandbox);
  vm.runInContext([
    marked("// BEGIN STRIP HELPERS", "// END STRIP HELPERS"),
    marked("// BEGIN INLINE ATTACHMENT BASE64 HELPERS", "// END INLINE ATTACHMENT BASE64 HELPERS"),
    marked("// BEGIN OUTBOUND ATTACHMENT LIMITS", "// END OUTBOUND ATTACHMENT LIMITS"),
    marked("// BEGIN OUTBOUND ATTACHMENT CONVERSION", "// END OUTBOUND ATTACHMENT CONVERSION"),
    "this.filePathsToAttachDescs = filePathsToAttachDescs;",
    "this._tempAttachFiles = _tempAttachFiles;",
  ].join("\n"), sandbox);
  return { api: sandbox, fake };
}

describe("decoded inline attachments are cleaned up when the call fails", () => {
  it("removes a temp file already written for an earlier attachment when a later one is refused", () => {
    const { api, fake } = loadWithFakeFs();
    const good = { name: "a.txt", base64: Buffer.from("hello").toString("base64") };
    const bad = { name: "b.txt", base64: "not valid base64 at all !!" };

    const { descs, failed } = api.filePathsToAttachDescs([good, bad]);

    assert.equal(descs.length, 1, "the first (valid) attachment was decoded before the second failed");
    assert.equal(failed.length, 1);
    assert.match(failed[0], /b\.txt/);
    // The file written for the first attachment must not remain on disk...
    assert.equal(fake.existing.has(descs[0].url.replace("file://", "")), false);
    // ...and must actually have gone through remove(), not just been forgotten.
    assert.ok(fake.removed.includes(descs[0].url.replace("file://", "")));
    // ...and the shutdown-time cleanup set no longer references it either.
    assert.equal(api._tempAttachFiles.size, 0);
  });

  it("leaves the decoded file in place when every attachment succeeds", () => {
    const { api, fake } = loadWithFakeFs();
    const good = { name: "a.txt", base64: Buffer.from("hello").toString("base64") };

    const { descs, failed } = api.filePathsToAttachDescs([good]);

    assert.equal(failed.length, 0);
    assert.equal(descs.length, 1);
    const writtenPath = descs[0].url.replace("file://", "");
    assert.ok(fake.existing.has(writtenPath));
    assert.equal(fake.removed.length, 0);
    assert.equal(api._tempAttachFiles.size, 1);
  });
});

