"use strict";

// A message can never be filed into a Templates folder through MCP: a
// filter's "reply" action sends a template's whole content to the sender of
// each matching message, without the review a compose window gives, so a
// Templates folder must only ever hold what the user put there directly in
// Thunderbird (see resolveReplyTemplate's own comment in api.js).

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const TEMPLATES_FLAG = 0x400000;
const QUEUE_FLAG = 0x800; // nsMsgFolderFlags.Queue: the Outbox ("Unsent Messages")
const Ci = { nsMsgFolderFlags: { Templates: TEMPLATES_FLAG, Queue: QUEUE_FLAG } };

function loadUpdateMessage(dependencies) {
  const apiPath = path.resolve(__dirname, "../extension/mcp_server/api.js");
  const source = fs.readFileSync(apiPath, "utf8");
  const startMarker = "function updateMessage(";
  const endMarker = "\n            function createFolder(";
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, "updateMessage start marker missing");
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, "updateMessage end marker missing");

  const sandbox = { Ci, ...dependencies };
  vm.createContext(sandbox);
  vm.runInContext(`${source.slice(start, end)}\nthis.updateMessage = updateMessage;`, sandbox);
  return sandbox.updateMessage;
}

function makeHdr(messageId) {
  return { messageId };
}

function makeHarness({ templatesFolderUri = "mailbox://n@Local%20Folders/Templates", otherFolderUri = "mailbox://n@Local%20Folders/Archive",
  outboxUri = "mailbox://n@Local%20Folders/Unsent%20Messages" } = {}) {
  const hdr = makeHdr("msg-1@example.test");
  const sourceFolder = {
    markMessagesRead() {}, markMessagesFlagged() {}, addKeywordsToMessages() {}, removeKeywordsFromMessages() {},
  };
  const db = { getMsgHdrForMessageID: (id) => (id === hdr.messageId ? hdr : null), enumerateMessages: () => [] };
  const templatesFolder = { URI: templatesFolderUri, getFlag: (f) => (f & TEMPLATES_FLAG) !== 0 };
  const otherFolder = { URI: otherFolderUri, getFlag: () => false };
  const outboxFolder = { URI: outboxUri, getFlag: (f) => (f & QUEUE_FLAG) !== 0 };
  const copyCalls = [];
  const deps = {
    openFolder: () => ({ folder: sourceFolder, db }),
    findTrashFolder: () => null,
    getAccessibleFolder: (uri) => {
      if (uri === templatesFolderUri) return { folder: templatesFolder };
      if (uri === otherFolderUri) return { folder: otherFolder };
      if (uri === outboxUri) return { folder: outboxFolder };
      return { error: `Folder not found: ${uri}` };
    },
    MailServices: { copy: { copyMessages: (...args) => copyCalls.push(args) } },
  };
  return { updateMessage: loadUpdateMessage(deps), copyCalls, hdr };
}

describe("updateMessage: moveTo a Templates folder", () => {
  it("refuses to move a message into a Templates folder", () => {
    const { updateMessage, copyCalls } = makeHarness();
    const result = updateMessage("msg-1@example.test", undefined, "mailbox://n@Local%20Folders/Inbox", undefined, undefined,
      undefined, undefined, "mailbox://n@Local%20Folders/Templates", undefined);
    assert.match(result.error, /Cannot move a message into a Templates folder through MCP/);
    assert.match(result.error, /Templates/);
    assert.equal(copyCalls.length, 0, "nothing was actually moved");
  });

  it("still allows moving into an ordinary folder", () => {
    const { updateMessage, copyCalls } = makeHarness();
    const result = updateMessage("msg-1@example.test", undefined, "mailbox://n@Local%20Folders/Inbox", undefined, undefined,
      undefined, undefined, "mailbox://n@Local%20Folders/Archive", undefined);
    assert.ok(!result.error, JSON.stringify(result));
    assert.equal(copyCalls.length, 1);
  });
});

describe("updateMessage: moveTo the Outbox", () => {
  it("refuses to move a message into the Outbox", () => {
    const { updateMessage, copyCalls } = makeHarness();
    const result = updateMessage("msg-1@example.test", undefined, "mailbox://n@Local%20Folders/Inbox", undefined, undefined,
      undefined, undefined, "mailbox://n@Local%20Folders/Unsent%20Messages", undefined);
    assert.match(result.error, /Cannot move a message into the Outbox \(Unsent Messages\) through MCP/);
    assert.equal(copyCalls.length, 0, "nothing was actually moved");
  });

  it("refuses it in a bulk move too", () => {
    const { updateMessage, copyCalls } = makeHarness();
    const result = updateMessage(undefined, ["msg-1@example.test"], "mailbox://n@Local%20Folders/Inbox", undefined, undefined,
      undefined, undefined, "mailbox://n@Local%20Folders/Unsent%20Messages", undefined);
    assert.match(result.error, /Outbox/);
    assert.equal(copyCalls.length, 0);
  });
});
