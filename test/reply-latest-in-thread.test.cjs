"use strict";
// replyToMessage latestInThread: the newest message of the conversation is found with the threadOf search
// (findLatestInThread), never for a direct send, and with the folders prepared as for a search.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const API = fs.readFileSync(path.join(__dirname, "..", "extension", "mcp_server", "api.js"), "utf8");

function slice(start, end, from = 0) {
  const i = API.indexOf(start, from);
  assert.ok(i >= 0, `${start} not found`);
  const j = API.indexOf(end, i);
  assert.ok(j > i, `${end} not found`);
  return API.slice(i, j);
}

const DRAFTS = 0x400;
const TEMPLATES = 0x400000;
const QUEUE = 0x800;

// folders: { uri: flags }; a folder that is not listed cannot be looked up
function load(searchResult, folders) {
  const calls = [];
  const sandbox = {
    Ci: { nsMsgFolderFlags: { Drafts: DRAFTS, Templates: TEMPLATES, Queue: QUEUE } },
    MailServices: {
      folderLookup: {
        getFolderForURL(uri) {
          if (!(uri in folders)) throw new Error("no such folder");
          return { isSpecialFolder: (flags, ancestors) => { assert.equal(ancestors, true); return !!(folders[uri] & flags); } };
        },
      },
    },
    MAX_SEARCH_RESULTS_CAP: 200,
    normalizeMessageIdForDedup: v => String(v || "").trim().replace(/^<|>$/g, "").toLowerCase(),
    searchMessages(args) { calls.push(args); return searchResult; },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${slice("// BEGIN LATEST IN THREAD", "// END LATEST IN THREAD")}\nthis.findLatestInThread = findLatestInThread;`, sandbox);
  return { find: sandbox.findLatestInThread, calls };
}

const plain = v => JSON.parse(JSON.stringify(v));
const INBOX = "imap://me@example.test/INBOX";
const SENT = "imap://me@example.test/Sent";
const DRAFTS_URI = "imap://me@example.test/Drafts";
const folders = { [INBOX]: 0, [SENT]: 0x200, [DRAFTS_URI]: DRAFTS, "imap://me@example.test/Templates": TEMPLATES, "mailbox://nobody@Local%20Folders/Unsent%20Messages": QUEUE };

describe("findLatestInThread", () => {
  it("reads the whole conversation, newest first", () => {
    const { find, calls } = load({ messages: [] }, folders);
    find("seed@example.test", INBOX);
    assert.deepEqual(plain(calls), [{ query: "", threadOf: { messageId: "seed@example.test", folderPath: INBOX }, sortOrder: "desc", maxResults: 200 }]);
  });

  it("returns the newest message when it is another one, with its date", () => {
    const { find } = load({ messages: [
      { id: "newer@example.test", folderPath: SENT, date: "2026-10-01T10:00:00.000Z", author: "Me <me@example.test>" },
      { id: "seed@example.test", folderPath: INBOX, date: "2026-09-30T10:00:00.000Z" },
    ] }, folders);
    assert.deepEqual(plain(find("seed@example.test", INBOX)), {
      latest: { messageId: "newer@example.test", folderPath: SENT, date: "2026-10-01T10:00:00.000Z" },
      incomplete: false,
    });
  });

  it("keeps the caller's message when it is the newest, also as a copy in another folder", () => {
    for (const row of [
      { id: "seed@example.test", folderPath: INBOX },
      { id: "seed@example.test", folderPath: SENT },
      { id: "<Seed@Example.test>", folderPath: SENT },
    ]) {
      const { find } = load({ messages: [row, { id: "older@example.test", folderPath: INBOX }] }, folders);
      assert.deepEqual(plain(find("seed@example.test", INBOX)), { latest: null, incomplete: false });
    }
  });

  it("skips Drafts, Templates, the Outbox and folders that cannot be looked up", () => {
    const { find } = load({ messages: [
      { id: "draft@example.test", folderPath: DRAFTS_URI },
      { id: "template@example.test", folderPath: "imap://me@example.test/Templates" },
      { id: "queued@example.test", folderPath: "mailbox://nobody@Local%20Folders/Unsent%20Messages" },
      { id: "gone@example.test", folderPath: "imap://me@example.test/Gone" },
      { id: "newer@example.test", folderPath: INBOX },
      { id: "seed@example.test", folderPath: INBOX },
    ] }, folders);
    assert.deepEqual(plain(find("seed@example.test", INBOX).latest), { messageId: "newer@example.test", folderPath: INBOX });
  });

  it("says when the newest message joined the conversation by its subject only", () => {
    const { find } = load({ messages: [{ id: "other@example.test", folderPath: INBOX, linkedBy: "subject" }] }, folders);
    assert.equal(find("seed@example.test", INBOX).latest.linkedBy, "subject");
  });

  it("passes on a scan that stopped at its cap, and a search error", () => {
    const capped = load({ messages: [{ id: "seed@example.test", folderPath: INBOX }], incomplete: true }, folders);
    assert.deepEqual(plain(capped.find("seed@example.test", INBOX)), { latest: null, incomplete: true });
    const failed = load({ error: "Message not found" }, folders);
    assert.deepEqual(plain(failed.find("seed@example.test", INBOX)), { error: "Message not found" });
  });

  it("returns nothing to answer instead when the conversation has no eligible message", () => {
    const { find } = load({ messages: [{ id: "draft@example.test", folderPath: DRAFTS_URI }] }, folders);
    assert.deepEqual(plain(find("seed@example.test", INBOX)), { latest: null, incomplete: false });
  });
});

describe("replyToMessage latestInThread wiring", () => {
  const reply = slice("async function replyToMessage(", "async function forwardMessage(");

  it("is refused before the conversation or the message is read", () => {
    const refusal = reply.indexOf("latestInThreadRefusal(composeMode, { searchEnabled: isToolEnabled(\"searchMessages\") })");
    const search = reply.indexOf("findLatestInThread(messageId, folderPath)");
    const found = reply.indexOf("findMessage(messageId, folderPath)");
    assert.ok(refusal >= 0 && search > refusal && found > search, `${refusal} ${search} ${found}`);
  });

  it("answers the message the search found, and reports it only in a success", () => {
    assert.ok(reply.includes("({ messageId, folderPath } = repliedTo);"));
    assert.ok(reply.includes("if (result.success && repliedTo) result.repliedTo = repliedTo;"));
    assert.ok(reply.includes("if (result.success && threadIncomplete) result.threadIncomplete = true;"));
    // every success of the three modes goes through withContext
    assert.equal(reply.split("return withContext(result);").length - 1, 3);
  });

  it("gets latestInThread from the tool call", () => {
    const call = slice("case \"replyToMessage\":", "case \"forwardMessage\":");
    assert.ok(call.includes("args.mode, args.latestInThread)"));
  });

  it("prepares the folders of the conversation as a threadOf search does", () => {
    const callTool = slice("async function callTool(name, args) {", "switch (name) {");
    const latest = callTool.indexOf("name === \"replyToMessage\" && args.latestInThread ? await prepareSearchFolders({ threadOf: { messageId: args.messageId, folderPath: args.folderPath } })");
    const reading = callTool.indexOf("FOLDER_READING_TOOLS.has(name)");
    assert.ok(latest >= 0 && reading > latest, `${latest} ${reading}`);
  });
});
