"use strict";

// N6: a filter's moveToFolder/copyToFolder action files matching messages
// into its target as they arrive -- the same route into a Templates folder
// that updateMessage's moveTo already refuses (see
// update-message-templates-guard.test.cjs), and the same reason: Templates
// must only ever hold what the user put there directly in Thunderbird.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const TEMPLATES_FLAG = 0x400000;
const QUEUE_FLAG = 0x800; // nsMsgFolderFlags.Queue: the Outbox ("Unsent Messages")
const Ci = { nsMsgFolderFlags: { Templates: TEMPLATES_FLAG, Queue: QUEUE_FLAG } };

function loadResolveFilterTargetFolder(getAccessibleFolder) {
  const apiPath = path.resolve(__dirname, "../extension/mcp_server/api.js");
  const source = fs.readFileSync(apiPath, "utf8");
  const marker = "\n            function resolveFilterTargetFolder(uri) {";
  const start = source.indexOf(marker);
  assert.ok(start >= 0, "resolveFilterTargetFolder start marker missing");
  const close = "\n            }\n";
  const end = source.indexOf(close, start);
  assert.ok(end > start, "resolveFilterTargetFolder end marker missing");

  const sandbox = { Ci, getAccessibleFolder };
  vm.createContext(sandbox);
  vm.runInContext(`${source.slice(start, end + close.length)}
this.resolveFilterTargetFolder = resolveFilterTargetFolder;`, sandbox);
  return sandbox.resolveFilterTargetFolder;
}

describe("resolveFilterTargetFolder: a filter action cannot target a Templates folder", () => {
  const templatesUri = "mailbox://n@Local%20Folders/Templates";
  const archiveUri = "mailbox://n@Local%20Folders/Archive";
  const templatesFolder = { URI: templatesUri, getFlag: (f) => (f & TEMPLATES_FLAG) !== 0 };
  const archiveFolder = { URI: archiveUri, getFlag: () => false };
  const outboxUri = "mailbox://n@Local%20Folders/Unsent%20Messages";
  const outboxFolder = { URI: outboxUri, getFlag: (f) => (f & QUEUE_FLAG) !== 0 };
  const resolveFilterTargetFolder = loadResolveFilterTargetFolder((uri) => {
    if (uri === templatesUri) return { folder: templatesFolder };
    if (uri === archiveUri) return { folder: archiveFolder };
    if (uri === outboxUri) return { folder: outboxFolder };
    return { error: `Folder not found: ${uri}` };
  });

  it("refuses a Templates folder as a moveToFolder/copyToFolder target", () => {
    const result = resolveFilterTargetFolder(templatesUri);
    assert.ok(result.error, JSON.stringify(result));
    assert.match(result.error, /Templates folder/);
  });

  it("refuses the Outbox (Unsent Messages) as a moveToFolder/copyToFolder target", () => {
    const result = resolveFilterTargetFolder(outboxUri);
    assert.ok(result.error, JSON.stringify(result));
    assert.match(result.error, /Outbox/);
  });

  it("still resolves an ordinary folder", () => {
    const result = resolveFilterTargetFolder(archiveUri);
    assert.equal(result.folder, archiveFolder);
  });

  it("passes through the underlying lookup error unchanged", () => {
    const result = resolveFilterTargetFolder("mailbox://n@Local%20Folders/Nowhere");
    assert.match(result.error, /Folder not found/);
  });
});
