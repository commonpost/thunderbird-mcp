// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";

// An IMAP server can list a folder as \All: a view of the messages of its
// other folders (Gmail's "All Mail"). Thunderbird learns that a message left
// that view only when it updates the folder, so a replaced draft or a deleted
// message stayed listed there. saveDraft with draftId, deleteMessages and
// updateMessage with trash now update the view before they answer. The real functions of api.js run
// against stand-in folders.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadTagHelpers } = require("./support/message-tags.cjs");

const apiSource = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");

function slice(begin, end) {
  const start = apiSource.indexOf(begin);
  const stop = apiSource.indexOf(end, start);
  assert.ok(start >= 0 && stop > start, `${begin} not found in api.js`);
  return apiSource.slice(start, stop);
}

const ALL_MAIL = 0x8000; // kImapAllMail
const ARCHIVE = 0x400000; // kImapArchive: an ordinary Archives folder, not a view

const Ci = {
  nsIMsgImapMailFolder: Symbol("nsIMsgImapMailFolder"),
  nsITimer: { TYPE_ONE_SHOT: 0 },
  nsIImapIncomingServer: Symbol("nsIImapIncomingServer"),
  nsMsgFolderFlags: { Trash: 0x100, Drafts: 0x400 },
  nsMsgImapDeleteModels: { IMAPDelete: 0, MoveToTrash: 1, DeleteNoTrash: 2 },
};

function imapFolder(name, boxFlags, extra = {}) {
  const folder = {
    URI: `imap://user@host/${name}`,
    boxFlags,
    QueryInterface(iid) {
      if (iid === Ci.nsIMsgImapMailFolder) return folder;
      throw new Error("NS_NOINTERFACE");
    },
    ...extra,
  };
  return folder;
}

function makeWorld({ refresh } = {}) {
  const timers = [];
  const warnings = [];
  const refreshes = [];
  const sandbox = {
    console: { warn: (...args) => warnings.push(args) },
    Ci,
    ChromeUtils: { generateQI: () => function QueryInterface() { return this; } },
    Cc: {
      "@mozilla.org/timer;1": {
        createInstance: () => {
          const timer = {
            cancelled: false,
            initWithCallback(callback, ms, type) { timer.ms = ms; timer.type = type; timer.fire = () => callback.notify(); },
            cancel() { timer.cancelled = true; },
          };
          timers.push(timer);
          return timer;
        },
      },
    },
    FOLDER_REFRESH_TIMEOUT_MS: 20000,
    refreshFolderFromServer: async (folder, timeoutMs) => {
      refreshes.push({ folder, timeoutMs });
      if (refresh) await refresh(refreshes.length);
      return { status: "done", newMessages: 0, ms: 1 };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${slice("// BEGIN ALL MAIL VIEW", "// END ALL MAIL VIEW")}
this.h = { allMailTimers, allMailFolderOf, changeDone, syncAllMailView, updateAllMailViewOf, IMAP_BOX_ALL_MAIL, ALL_MAIL_SYNC_TIMEOUT_MS,
  ALL_MAIL_SYNC_PAUSE_MS, ALL_MAIL_CHANGE_WAIT_MS };`, sandbox);
  return { h: sandbox.h, sandbox, timers, warnings, refreshes };
}

// A folder of a server whose folders are `others` plus, unless null, an All Mail view listing `listed`.
function makeServer({ type = "imap", listed = [], others = [], allMail = true, dbFails = false } = {}) {
  const view = allMail ? imapFolder("[Gmail]/All Mail", ALL_MAIL | 0x20) : null;
  if (view) {
    Object.defineProperty(view, "msgDatabase", {
      get() {
        if (dbFails) throw new Error("NS_ERROR_NOT_INITIALIZED");
        return { getMsgHdrForMessageID: (id) => (listed.includes(id) ? { messageId: id } : null) };
      },
    });
  }
  const drafts = imapFolder("Drafts", 0);
  const server = { type, rootFolder: { descendants: [...others, drafts, ...(view ? [view] : [])] } };
  drafts.server = server;
  return { drafts, view, server, listed };
}

const plain = (value) => JSON.parse(JSON.stringify(value));

const settle = () => new Promise((resolve) => { setImmediate(resolve); });

describe("allMailFolderOf: the \\All folder of an IMAP server", () => {
  it("is the folder whose box flags hold kImapAllMail (0x8000)", () => {
    const w = makeWorld();
    assert.equal(w.h.IMAP_BOX_ALL_MAIL, 0x8000);
    const s = makeServer({ others: [imapFolder("INBOX", 0x10), imapFolder("Archives", ARCHIVE)] });
    assert.equal(w.h.allMailFolderOf(s.drafts), s.view);
  });

  it("is null when no folder is flagged, an Archives folder (\\Archive) included", () => {
    const w = makeWorld();
    const s = makeServer({ allMail: false, others: [imapFolder("Archives", ARCHIVE)] });
    assert.equal(w.h.allMailFolderOf(s.drafts), null);
  });

  it("is null for other kinds of server, which are not even walked", () => {
    const w = makeWorld();
    for (const type of ["pop3", "none", "nntp", "rss", "graph"]) {
      const folder = { server: { type, get rootFolder() { throw new Error("walked"); } } };
      assert.equal(w.h.allMailFolderOf(folder), null);
    }
    assert.equal(w.h.allMailFolderOf(null), null);
    assert.equal(w.h.allMailFolderOf({}), null);
    assert.deepEqual(w.warnings, []);
  });

  it("skips a folder that is not an IMAP folder and goes on", () => {
    const w = makeWorld();
    const odd = { QueryInterface() { throw new Error("NS_NOINTERFACE"); } };
    const s = makeServer({ others: [odd] });
    assert.equal(w.h.allMailFolderOf(s.drafts), s.view);
  });

  it("is null, with a warning, when the folders cannot be listed", () => {
    const w = makeWorld();
    const folder = { server: { type: "imap", get rootFolder() { throw new Error("NS_ERROR_FAILURE"); } } };
    assert.equal(w.h.allMailFolderOf(folder), null);
    assert.equal(w.warnings.length, 1);
    assert.match(String(w.warnings[0][0]), /could not look for the All Mail folder/);
  });
});

describe("changeDone: the end of a deletion, as Thunderbird reports it", () => {
  it("is settled by onStopCopy, and the time limit is cancelled", async () => {
    const w = makeWorld();
    const done = w.h.changeDone();
    assert.equal(w.timers.length, 1);
    assert.equal(w.timers[0].ms, w.h.ALL_MAIL_CHANGE_WAIT_MS);
    assert.equal(w.h.ALL_MAIL_CHANGE_WAIT_MS, 3000);
    done.listener.onStartCopy();
    done.listener.onProgress(1, 2);
    done.listener.setMessageKey(7);
    assert.equal(done.listener.getMessageId(), null);
    assert.equal(done.listener.QueryInterface(), done.listener);
    let settled = false;
    const watched = done.promise.then(() => { settled = true; });
    await settle();
    assert.equal(settled, false);
    done.listener.onStopCopy(0);
    await watched;
    assert.equal(settled, true);
    assert.equal(w.timers[0].cancelled, true);
    assert.equal(w.h.allMailTimers.size, 0);
  });

  it("is settled by the time limit when Thunderbird never calls the listener", async () => {
    const w = makeWorld();
    const done = w.h.changeDone(1234);
    assert.equal(w.timers[0].ms, 1234);
    assert.equal(w.h.allMailTimers.size, 1, "kept while it runs, so that it is not collected");
    w.timers[0].fire();
    await done.promise;
    assert.equal(w.h.allMailTimers.size, 0);
  });
});

describe("syncAllMailView: the view is updated until the messages left it", () => {
  it("updates the folder once by default, within the time limit", async () => {
    const w = makeWorld();
    const s = makeServer({ listed: ["old@example.test"] });
    await w.h.syncAllMailView(s.view, ["old@example.test"]);
    assert.equal(w.refreshes.length, 1);
    assert.equal(w.refreshes[0].folder, s.view);
    assert.ok(w.refreshes[0].timeoutMs > 0 && w.refreshes[0].timeoutMs <= w.h.ALL_MAIL_SYNC_TIMEOUT_MS);
    assert.equal(w.h.ALL_MAIL_SYNC_TIMEOUT_MS, 8000);
    assert.equal(w.timers.length, 0);
  });

  it("stops as soon as the view no longer lists the messages", async () => {
    const s = makeServer({ listed: ["old@example.test"] });
    const w = makeWorld({ refresh: () => { s.listed.length = 0; } });
    await w.h.syncAllMailView(s.view, ["old@example.test"], 3);
    assert.equal(w.refreshes.length, 1);
    assert.equal(w.timers.length, 0);
  });

  it("asks again after a pause while a message is still listed, up to the number of attempts", async () => {
    const s = makeServer({ listed: ["other@example.test", "old@example.test"] });
    const w = makeWorld();
    const run = w.h.syncAllMailView(s.view, ["gone@example.test", "old@example.test"], 3);
    for (let pause = 0; pause < 2; pause++) {
      await settle();
      assert.equal(w.timers.length, pause + 1);
      assert.equal(w.timers[pause].ms, w.h.ALL_MAIL_SYNC_PAUSE_MS);
      w.timers[pause].fire();
    }
    await run;
    assert.equal(w.refreshes.length, 3);
    assert.equal(w.h.allMailTimers.size, 0);
    assert.equal(w.timers.length, 2);
    assert.equal(w.h.ALL_MAIL_SYNC_PAUSE_MS, 500);
  });

  it("does not start an update once the time limit has passed", async () => {
    const s = makeServer({ listed: ["old@example.test"] });
    let now = 1000;
    const w = makeWorld({ refresh: () => { now += 7800; } });
    // The clock of the sandbox, which has its own Date
    vm.runInContext("Date", w.sandbox).now = () => now;
    await w.h.syncAllMailView(s.view, ["old@example.test"], 3);
    // 200 ms were left: less than a pause, so no second attempt
    assert.equal(w.refreshes.length, 1);
    assert.equal(w.refreshes[0].timeoutMs, 8000);
    assert.equal(w.timers.length, 0);
  });

  it("an unreadable view counts as up to date", async () => {
    const w = makeWorld();
    const s = makeServer({ listed: ["old@example.test"], dbFails: true });
    await w.h.syncAllMailView(s.view, ["old@example.test"], 3);
    assert.equal(w.refreshes.length, 1);
  });

  it("never throws: the change is already made", async () => {
    const w = makeWorld({ refresh: () => { throw new Error("NS_ERROR_FAILURE"); } });
    const s = makeServer({ listed: ["old@example.test"] });
    await w.h.syncAllMailView(s.view, ["old@example.test"], 3);
    assert.equal(w.warnings.length, 1);
    assert.match(String(w.warnings[0][0]), /could not update the All Mail folder/);
  });
});

describe("updateAllMailViewOf: only a server with an All Mail view is asked", () => {
  it("updates the view of the folder's server", async () => {
    const w = makeWorld();
    const s = makeServer({ listed: [] });
    await w.h.updateAllMailViewOf(s.drafts, ["old@example.test"], 3);
    assert.deepEqual(w.refreshes.map((r) => r.folder), [s.view]);
  });

  it("does nothing on a server without one", async () => {
    const w = makeWorld();
    const s = makeServer({ allMail: false });
    await w.h.updateAllMailViewOf(s.drafts, ["old@example.test"], 3);
    assert.deepEqual(w.refreshes, []);
  });
});

describe("saveDraft with draftId", () => {
  it("updates the All Mail view after the old version is replaced, before it answers", () => {
    const i = apiSource.indexOf("async function updateDraft(args)");
    assert.ok(i > 0);
    const fn = apiSource.slice(i, apiSource.indexOf("\n            }\n", i));
    const saved = fn.indexOf("await saveComposeFieldsAsDraft(");
    const synced = fn.indexOf("await updateAllMailViewOf(folder, [replacedDraftId], 3);");
    assert.ok(saved > 0 && synced > saved);
    assert.ok(fn.lastIndexOf("if (result.success) {", synced) > saved, "only after a successful save");
    assert.ok(synced < fn.lastIndexOf("return result;"));
  });
});

describe("deleteMessages on a server with an All Mail view", () => {
  function loadDeleteMessages({ drafts = false, allMail = true, trash = true } = {}) {
    const start = apiSource.indexOf("function isTrashOrDescendant(folder) {");
    const end = apiSource.indexOf("function updateMessage(", start);
    assert.ok(start >= 0 && end > start);
    const calls = [];
    const view = { URI: "imap://user@host/[Gmail]/All Mail" };
    const trashFolder = { URI: "imap://user@host/Trash" };
    const hdrs = { "a@example.test": { messageId: "a@example.test" }, "b@example.test": { messageId: "b@example.test" } };
    const folder = {
      URI: "imap://user@host/Label",
      getFlag: (flag) => drafts && flag === Ci.nsMsgFolderFlags.Drafts,
      isSpecialFolder: () => false,
      server: { type: "imap", QueryInterface: () => ({ deleteModel: Ci.nsMsgImapDeleteModels.MoveToTrash }) },
      deleteMessages(found, _win, _deleteStorage, _isMove, listener) {
        calls.push(["deleteMessages", found.map((h) => h.messageId), listener === done.listener ? "listener" : listener]);
      },
    };
    const done = { listener: { name: "copy listener" } };
    done.promise = new Promise((resolve) => { done.end = resolve; });
    const sandbox = {
      Ci,
      arrivalResendCheck: () => null,
      someUnread: () => false,
      openFolder: () => ({ folder, db: { getMsgHdrForMessageID: (id) => hdrs[id] || null, enumerateMessages: () => [] } }),
      findTrashFolder: () => (trash ? trashFolder : null),
      MailServices: { copy: { copyMessages(src, found, dest, isMove, listener) {
        calls.push(["copyMessages", found.map((h) => h.messageId), listener === done.listener ? "listener" : listener]);
      } } },
      allMailFolderOf: (asked) => { assert.equal(asked, folder); return allMail ? view : null; },
      changeDone: () => { calls.push(["changeDone"]); return done; },
      syncAllMailView: async (target, ids, ...rest) => { calls.push(["syncAllMailView", target === view ? "view" : target, ids, ...rest]); },
    };
    vm.createContext(sandbox);
    vm.runInContext(`${apiSource.slice(start, end)}\nthis.deleteMessages = deleteMessages;`, sandbox);
    return { deleteMessages: sandbox.deleteMessages, calls, done };
  }

  it("waits for the deletion, then updates the view once, then answers", async () => {
    const t = loadDeleteMessages();
    const answer = t.deleteMessages(["a@example.test", "missing@example.test", "b@example.test"], "imap://user@host/Label");
    assert.ok(answer instanceof Promise || typeof answer.then === "function");
    assert.deepEqual(plain(t.calls), [["changeDone"], ["deleteMessages", ["a@example.test", "b@example.test"], "listener"]]);
    let result = null;
    const watched = answer.then((r) => { result = r; });
    await settle();
    assert.equal(result, null, "not before Thunderbird reports the end");
    t.done.end();
    await watched;
    assert.deepEqual(plain(t.calls[2]), ["syncAllMailView", "view", ["a@example.test", "b@example.test"]]);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { success: true, deleted: 2, notFound: ["missing@example.test"] });
  });

  it("does the same for a draft moved to Trash", async () => {
    const t = loadDeleteMessages({ drafts: true });
    const answer = t.deleteMessages(["a@example.test"], "imap://user@host/Label");
    assert.deepEqual(plain(t.calls), [["changeDone"], ["copyMessages", ["a@example.test"], "listener"]]);
    t.done.end();
    assert.deepEqual(JSON.parse(JSON.stringify(await answer)), { success: true, deleted: 1, movedToTrash: true });
    assert.equal(t.calls[2][0], "syncAllMailView");
  });

  it("and for a draft deleted for want of a Trash folder", async () => {
    const t = loadDeleteMessages({ drafts: true, trash: false });
    const answer = t.deleteMessages(["a@example.test"], "imap://user@host/Label");
    assert.deepEqual(plain(t.calls), [["changeDone"], ["deleteMessages", ["a@example.test"], "listener"]]);
    t.done.end();
    assert.deepEqual(JSON.parse(JSON.stringify(await answer)), { success: true, deleted: 1 });
  });

  it("starts no wait when the call is refused before anything is deleted", () => {
    const t = loadDeleteMessages({ trash: false });
    assert.deepEqual(JSON.parse(JSON.stringify(t.deleteMessages(["a@example.test"], "imap://user@host/Label"))),
      { error: "Trash folder not found" });
    assert.deepEqual(plain(t.calls), []);
  });

  it("answers at once, without a listener, on a server without such a view", () => {
    const t = loadDeleteMessages({ allMail: false });
    const answer = t.deleteMessages(["a@example.test"], "imap://user@host/Label");
    assert.deepEqual(JSON.parse(JSON.stringify(answer)), { success: true, deleted: 1 });
    assert.deepEqual(plain(t.calls), [["deleteMessages", ["a@example.test"], null]]);
  });
});

describe("updateMessage on a server with an All Mail view", () => {
  function loadUpdateMessage({ allMail = true } = {}) {
    const start = apiSource.indexOf("function updateMessage(");
    const end = apiSource.indexOf("\n            function createFolder(", start);
    assert.ok(start >= 0 && end > start);
    const calls = [];
    const view = { URI: "imap://user@host/[Gmail]/All Mail" };
    const hdr = { messageId: "a@example.test" };
    const source = { URI: "imap://user@host/INBOX", markMessagesRead: () => calls.push(["read"]) };
    const trashFolder = { URI: "imap://user@host/Trash", getFlag: () => false };
    const other = { URI: "imap://user@host/Label", getFlag: () => false };
    const done = { listener: { name: "copy listener" } };
    done.promise = new Promise((resolve) => { done.end = resolve; });
    const sandbox = {
      Ci: { nsMsgFolderFlags: { Templates: 0x400000, Queue: 0x800 } },
      arrivalResendCheck: () => null,
      someUnread: () => false,
      resolveMessageTags: loadTagHelpers().resolveMessageTags,
      openFolder: () => ({ folder: source, db: { getMsgHdrForMessageID: (id) => (id === hdr.messageId ? hdr : null), enumerateMessages: () => [] } }),
      findTrashFolder: () => trashFolder,
      getAccessibleFolder: (uri) => (uri === other.URI ? { folder: other } : { error: `Folder not found: ${uri}` }),
      MailServices: {
        accounts: { allIdentities: [] },
        copy: { copyMessages(_src, _hdrs, dest, _isMove, listener) {
          calls.push(["copyMessages", dest.URI, listener === done.listener ? "listener" : listener]);
        } },
      },
      allMailFolderOf: (asked) => { assert.equal(asked, source); calls.push(["allMailFolderOf"]); return allMail ? view : null; },
      changeDone: () => { calls.push(["changeDone"]); return done; },
      syncAllMailView: async (target, ids, ...rest) => { calls.push(["syncAllMailView", target === view ? "view" : target, ids, ...rest]); },
    };
    vm.createContext(sandbox);
    vm.runInContext(`${apiSource.slice(start, end)}\nthis.updateMessage = updateMessage;`, sandbox);
    const run = (args) => sandbox.updateMessage("a@example.test", undefined, source.URI, args.read, undefined, undefined, undefined,
      args.moveTo, args.trash);
    return { run, calls, done, other };
  }

  it("trash: waits for the move, then updates the view once, then answers", async () => {
    const t = loadUpdateMessage();
    const answer = t.run({ trash: true });
    assert.equal(typeof answer.then, "function");
    assert.deepEqual(plain(t.calls), [["allMailFolderOf"], ["changeDone"], ["copyMessages", "imap://user@host/Trash", "listener"]]);
    let result = null;
    const watched = answer.then((r) => { result = r; });
    await settle();
    assert.equal(result, null, "not before Thunderbird reports the end");
    t.done.end();
    await watched;
    assert.deepEqual(plain(t.calls[3]), ["syncAllMailView", "view", ["a@example.test"]]);
    assert.deepEqual(plain(result), { success: true, updated: 1, actions: [{ type: "move", to: "imap://user@host/Trash" }] });
  });

  it("trash on a server without such a view answers at once, without a listener", () => {
    const t = loadUpdateMessage({ allMail: false });
    assert.deepEqual(plain(t.run({ trash: true })),
      { success: true, updated: 1, actions: [{ type: "move", to: "imap://user@host/Trash" }] });
    assert.deepEqual(plain(t.calls), [["allMailFolderOf"], ["copyMessages", "imap://user@host/Trash", null]]);
  });

  it("a move to another folder leaves the message in the view: no wait, the view is not even looked for", () => {
    const t = loadUpdateMessage();
    assert.equal(plain(t.run({ moveTo: t.other.URI })).success, true);
    assert.deepEqual(plain(t.calls), [["copyMessages", "imap://user@host/Label", null]]);
  });

  it("a change without a move does not look for the view either", () => {
    const t = loadUpdateMessage();
    assert.equal(plain(t.run({ read: true })).success, true);
    assert.deepEqual(plain(t.calls), [["read"]]);
  });
});
