// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";
// Where a draft is looked for (locateDraft), the own addresses used to link a conversation, and the newest message of
// a conversation (findLatestInThread) when the search gives nothing usable. Runs the real functions of api.js.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const API = fs.readFileSync(path.join(__dirname, "..", "extension", "mcp_server", "api.js"), "utf8");

function slice(start, end) {
  const i = API.indexOf(start);
  assert.ok(i >= 0, `${start} not found`);
  const j = API.indexOf(end, i);
  assert.ok(j > i, `${end} not found`);
  return API.slice(i, j);
}

const DRAFTS = 0x400;
const plain = v => JSON.parse(JSON.stringify(v));

// accounts: [{ key, folders: [folder] | Error }], folders hold { URI } and answer to the lookups of locateDraft
function loadLocate({ accessible = {}, accounts = [], messages = {} }) {
  const lookups = [];
  const sandbox = {
    Ci: { nsMsgFolderFlags: { Drafts: DRAFTS } },
    normalizeMessageIdForDedup: v => String(v || "").trim().replace(/^<|>$/g, "").toLowerCase(),
    getAccessibleFolder: folderPath => (folderPath in accessible ? accessible[folderPath] : { error: `Folder not found: ${folderPath}` }),
    getAccessibleAccounts: () => accounts.map(account => ({
      key: account.key,
      incomingServer: { rootFolder: { getFoldersWithFlags(flags) { assert.equal(flags, DRAFTS); if (account.folders instanceof Error) throw account.folders; return account.folders; } } },
    })),
    findMessage: (id, folderPath) => { lookups.push([id, folderPath]); return messages[`${id}@${folderPath}`] || { error: "Message not found" }; },
  };
  vm.createContext(sandbox);
  const start = API.indexOf("function locateDraft(");
  assert.ok(start >= 0);
  const close = "\n            }\n";
  vm.runInContext(`${API.slice(start, API.indexOf(close, start) + close.length)}\nthis.locateDraft = locateDraft;`, sandbox);
  return { locateDraft: sandbox.locateDraft, lookups };
}

describe("locateDraft with a folderPath", () => {
  const draftsFolder = { isSpecialFolder: (flags, ancestors) => { assert.equal(ancestors, true); return !!(flags & DRAFTS); } };
  const inboxFolder = { isSpecialFolder: () => false };
  const found = { msgHdr: { key: 3 }, folder: draftsFolder };

  it("looks the message up by its normalised id in that folder, when it is a Drafts folder", () => {
    const { locateDraft, lookups } = loadLocate({
      accessible: { "imap://me/Drafts": { folder: draftsFolder } },
      messages: { "abc@x.test@imap://me/Drafts": found },
    });
    assert.equal(locateDraft(" <ABC@x.test> ", "imap://me/Drafts"), found);
    assert.deepEqual(lookups, [["abc@x.test", "imap://me/Drafts"]]);
  });

  it("passes on the error of a folder that is not accessible", () => {
    const { locateDraft, lookups } = loadLocate({});
    assert.deepEqual(plain(locateDraft("abc@x.test", "imap://me/Gone")), { error: "Folder not found: imap://me/Gone" });
    assert.deepEqual(lookups, []);
  });

  it("refuses a folder that is not a Drafts folder, so that no other message can be read or replaced as a draft", () => {
    const { locateDraft, lookups } = loadLocate({ accessible: { "imap://me/INBOX": { folder: inboxFolder } } });
    assert.deepEqual(plain(locateDraft("abc@x.test", "imap://me/INBOX")), {
      error: "folderPath is not a Drafts folder. draftId must be a draft (saveDraft result or a message in Drafts).",
    });
    assert.deepEqual(lookups, []);
  });

  it("returns what the search for the message says, an error included", () => {
    const { locateDraft } = loadLocate({ accessible: { "imap://me/Drafts": { folder: draftsFolder } } });
    assert.deepEqual(plain(locateDraft("abc@x.test", "imap://me/Drafts")), { error: "Message not found" });
  });
});

describe("locateDraft without a folderPath", () => {
  const folder = uri => ({ URI: uri });

  it("looks in the Drafts folders of every accessible account, and returns the first draft it finds", () => {
    const hit = { msgHdr: { key: 9 }, folder: folder("imap://b/Drafts") };
    const { locateDraft, lookups } = loadLocate({
      accounts: [
        { key: "a", folders: [folder("imap://a/Drafts"), folder("imap://a/Drafts/Old")] },
        { key: "b", folders: [folder("imap://b/Drafts")] },
        { key: "c", folders: [folder("imap://c/Drafts")] },
      ],
      messages: { "abc@x.test@imap://b/Drafts": hit },
    });
    assert.equal(locateDraft("<abc@x.test>"), hit);
    assert.deepEqual(lookups, [["abc@x.test", "imap://a/Drafts"], ["abc@x.test", "imap://a/Drafts/Old"], ["abc@x.test", "imap://b/Drafts"]]);
  });

  it("goes on with the next account when one cannot list its Drafts folders", () => {
    const hit = { msgHdr: { key: 1 } };
    const { locateDraft } = loadLocate({
      accounts: [{ key: "a", folders: new Error("no root folder") }, { key: "b", folders: [folder("imap://b/Drafts")] }],
      messages: { "abc@x.test@imap://b/Drafts": hit },
    });
    assert.equal(locateDraft("abc@x.test", ""), hit);
  });

  it("says which draft it did not find, and how to name it", () => {
    const { locateDraft } = loadLocate({ accounts: [{ key: "a", folders: [folder("imap://a/Drafts")] }, { key: "b", folders: new Error("gone") }] });
    assert.deepEqual(plain(locateDraft("<Gone@x.test>")), { error: "Draft not found: <Gone@x.test>. Pass the messageId returned by saveDraft (and its folderPath)." });
    assert.deepEqual(plain(loadLocate({ accounts: [] }).locateDraft("x@y.test")), { error: "Draft not found: x@y.test. Pass the messageId returned by saveDraft (and its folderPath)." });
  });
});

describe("getOwnEmails", () => {
  it("collects the addresses of the identities of the accessible accounts only, in lower case, and skips an identity without one", () => {
    const accounts = [
      { key: "open", identities: [{ email: "Me@Home.test" }, { email: "" }, { email: undefined }, { email: "alias@home.test" }] },
      { key: "restricted", identities: [{ email: "secret@work.test" }] },
    ];
    const sandbox = { getAccessibleAccounts: () => accounts.filter(account => account.key === "open") };
    vm.createContext(sandbox);
    vm.runInContext(`${slice("// BEGIN OWN ADDRESSES", "// END OWN ADDRESSES")}\nthis.getOwnEmails = getOwnEmails;`, sandbox);
    assert.deepEqual([...sandbox.getOwnEmails()], ["me@home.test", "alias@home.test"]);
  });
});

describe("findLatestInThread with an unusual search result", () => {
  function loadFind(searchResult) {
    const sandbox = {
      Ci: { nsMsgFolderFlags: { Drafts: DRAFTS, Templates: 0x400000, Queue: 0x800 } },
      MailServices: { folderLookup: { getFolderForURL: () => ({ isSpecialFolder: () => false }) } },
      MAX_SEARCH_RESULTS_CAP: 200,
      normalizeMessageIdForDedup: v => String(v || "").trim().replace(/^<|>$/g, "").toLowerCase(),
      searchMessages: () => searchResult,
    };
    vm.createContext(sandbox);
    vm.runInContext(`${slice("// BEGIN LATEST IN THREAD", "// END LATEST IN THREAD")}\nthis.findLatestInThread = findLatestInThread;`, sandbox);
    return sandbox.findLatestInThread;
  }

  it("takes a search without a message list for a conversation that has no other message", () => {
    assert.deepEqual(plain(loadFind({})("seed@x.test", "imap://me/INBOX")), { latest: null, incomplete: false });
    assert.deepEqual(plain(loadFind({ incomplete: true })("seed@x.test", "imap://me/INBOX")), { latest: null, incomplete: true });
  });

  it("passes on the error of the search", () => {
    assert.deepEqual(plain(loadFind({ error: "searchMessages is disabled" })("seed@x.test", "imap://me/INBOX")), { error: "searchMessages is disabled" });
  });

  it("keeps the thread link of the newest message and warns when the scan stopped at its cap", () => {
    const find = loadFind({ messages: [{ id: "new@x.test", folderPath: "imap://me/Sent", linkedBy: "subject" }, { id: "seed@x.test", folderPath: "imap://me/INBOX" }], incomplete: true });
    assert.deepEqual(plain(find("seed@x.test", "imap://me/INBOX")), { latest: { messageId: "new@x.test", folderPath: "imap://me/Sent", linkedBy: "subject" }, incomplete: true });
  });
});
