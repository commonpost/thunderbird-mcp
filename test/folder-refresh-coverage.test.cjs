// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";

// listFolders with refresh: true asks the mail server for new mail and waits,
// within a time limit, for Thunderbird to say it is done. emptyTrash and
// emptyJunk clear the Trash and Junk folders of the accounts the caller may
// reach. The real functions of api.js run against stand-in folders.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const apiSource = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");

function slice(begin, end) {
  const start = apiSource.indexOf(begin);
  const stop = apiSource.indexOf(end, start);
  assert.ok(start >= 0 && stop > start, `${begin} not found in api.js`);
  return apiSource.slice(start, stop);
}

function functionSource(name, indent = "            ") {
  const start = apiSource.indexOf(`\n${indent}function ${name}(`);
  assert.ok(start >= 0, `${name} not found in api.js`);
  const close = `\n${indent}}\n`;
  return apiSource.slice(start, apiSource.indexOf(close, start) + close.length);
}

const plain = (value) => JSON.parse(JSON.stringify(value));

const NS_ERROR_FAILURE = 0x80004005;

function makeRefreshWorld({ offline = false } = {}) {
  const listeners = new Set();
  const timers = [];
  const warnings = [];
  const state = { removeFails: false };
  const sandbox = {
    console: { warn: (...args) => warnings.push(args) },
    Ci: {
      nsIMsgImapMailFolder: Symbol("nsIMsgImapMailFolder"),
      nsIFolderListener: { event: 0x80 },
      nsITimer: { TYPE_ONE_SHOT: 0 },
    },
    Components: { isSuccessCode: (status) => (status & 0x80000000) === 0 },
    ChromeUtils: { generateQI: () => function QueryInterface() { return this; } },
    Services: { io: { offline } },
    Cc: {
      "@mozilla.org/timer;1": {
        createInstance: () => {
          const timer = {
            cancelled: false,
            initWithCallback(callback, ms) { timer.ms = ms; timer.fire = () => callback.notify(); },
            cancel() { timer.cancelled = true; },
          };
          timers.push(timer);
          return timer;
        },
      },
    },
    MailServices: {
      mailSession: {
        AddFolderListener(listener, mask) { assert.equal(mask, 0x80); listeners.add(listener); },
        RemoveFolderListener(listener) {
          if (state.removeFails) throw new Error("NS_ERROR_FAILURE");
          listeners.delete(listener);
        },
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${slice("// BEGIN FOLDER REFRESH", "// END FOLDER REFRESH")}
this.refreshFolderFromServer = refreshFolderFromServer;
this.FOLDER_REFRESH_TIMEOUT_MS = FOLDER_REFRESH_TIMEOUT_MS;`, sandbox);

  // A folder of the given server type. `imap` makes QueryInterface succeed for nsIMsgImapMailFolder.
  function makeFolder({ type = "imap", imap = type === "imap", totals = [4], totalFails = false, updateFails = null } = {}) {
    let reads = 0;
    const folder = {
      URI: `${type}://user@host/INBOX`,
      server: type === null ? undefined : { type },
      updates: [],
      imapUpdates: [],
      getTotalMessages(deep) {
        assert.equal(deep, false);
        if (totalFails) throw new Error("NS_ERROR_NOT_INITIALIZED");
        return totals[Math.min(reads++, totals.length - 1)];
      },
      QueryInterface(iid) {
        if (imap && iid === sandbox.Ci.nsIMsgImapMailFolder) return folder;
        throw new Error("NS_NOINTERFACE");
      },
      updateFolder(win) { folder.updates.push(win); if (updateFails !== null) throw updateFails; },
      updateFolderWithListener(win, urlListener) {
        folder.imapUpdates.push({ win, urlListener });
        if (updateFails !== null) throw updateFails;
      },
    };
    return folder;
  }
  return { refresh: sandbox.refreshFolderFromServer, sandbox, listeners, timers, warnings, state, makeFolder };
}

describe("refreshFolderFromServer: folders that are not refreshed", () => {
  for (const type of ["none", "pop3"]) {
    it(`a ${type} folder is local: nothing to fetch, no listener, no timer`, async () => {
      const w = makeRefreshWorld();
      const folder = w.makeFolder({ type, imap: false });
      assert.deepEqual(plain(await w.refresh(folder)), { status: "local", newMessages: 0, ms: 0 });
      assert.equal(w.listeners.size + w.timers.length, 0);
      assert.deepEqual(folder.updates, []);
    });
  }

  for (const type of ["nntp", "rss"]) {
    it(`a ${type} folder is not refreshed (a newsgroup with many new articles opens a dialog)`, async () => {
      const w = makeRefreshWorld();
      const folder = w.makeFolder({ type, imap: false });
      assert.deepEqual(plain(await w.refresh(folder)), { status: "unsupported", newMessages: 0, ms: 0 });
      assert.deepEqual(folder.updates, []);
    });
  }

  it("nothing is fetched while Thunderbird is offline", async () => {
    const w = makeRefreshWorld({ offline: true });
    const folder = w.makeFolder();
    assert.deepEqual(plain(await w.refresh(folder)), { status: "offline", newMessages: 0, ms: 0 });
    assert.deepEqual(folder.imapUpdates, []);
    assert.equal(w.timers.length, 0);
  });
});

describe("refreshFolderFromServer: IMAP", () => {
  it("is done when the server update succeeds, and counts the new messages", async () => {
    const w = makeRefreshWorld();
    const folder = w.makeFolder({ totals: [4, 7] });
    const pending = w.refresh(folder);
    assert.equal(folder.imapUpdates.length, 1);
    assert.equal(folder.imapUpdates[0].win, null);
    assert.equal(w.timers[0].ms, w.sandbox.FOLDER_REFRESH_TIMEOUT_MS);
    assert.equal(w.listeners.size, 1);
    folder.imapUpdates[0].urlListener.OnStartRunningUrl();
    folder.imapUpdates[0].urlListener.OnStopRunningUrl(null, 0);
    const result = plain(await pending);
    assert.equal(result.status, "done");
    assert.equal(result.newMessages, 3);
    assert.equal(typeof result.ms, "number");
    assert.equal("error" in result, false);
    assert.equal(w.timers[0].cancelled, true, "the time limit is cancelled");
    assert.equal(w.listeners.size, 0, "the folder listener is removed");
  });

  it("never reports a negative count when messages left the folder meanwhile", async () => {
    const w = makeRefreshWorld();
    const folder = w.makeFolder({ totals: [9, 2] });
    const pending = w.refresh(folder);
    folder.imapUpdates[0].urlListener.OnStopRunningUrl(null, 0);
    assert.equal((await pending).newMessages, 0);
  });

  it("is failed, with the status in hexadecimal, when the update ends in an error", async () => {
    const w = makeRefreshWorld();
    const folder = w.makeFolder();
    const pending = w.refresh(folder);
    folder.imapUpdates[0].urlListener.OnStopRunningUrl(null, NS_ERROR_FAILURE | 0);
    const result = plain(await pending);
    assert.equal(result.status, "failed");
    assert.equal(result.error, "Thunderbird could not update the folder (status 0x80004005)");
  });

  it("does not take FolderLoaded for the end of an IMAP update: its URL listener decides", async () => {
    const w = makeRefreshWorld();
    const folder = w.makeFolder();
    const pending = w.refresh(folder);
    for (const listener of w.listeners) listener.onFolderEvent(folder, "FolderLoaded");
    assert.equal(w.listeners.size, 1, "still waiting");
    folder.imapUpdates[0].urlListener.OnStopRunningUrl(null, 0);
    assert.equal((await pending).status, "done");
  });

  it("answers pending, not failed, when the time limit passes first; a late answer changes nothing", async () => {
    const w = makeRefreshWorld();
    const folder = w.makeFolder({ totals: [1, 5] });
    const pending = w.refresh(folder);
    w.timers[0].fire();
    const result = plain(await pending);
    assert.equal(result.status, "pending");
    assert.equal(result.newMessages, 4);
    folder.imapUpdates[0].urlListener.OnStopRunningUrl(null, 0); // settled once only: no throw, no second answer
    assert.equal(w.listeners.size, 0);
  });

  it("is failed, with Thunderbird's message, when the update cannot even start", async () => {
    const w = makeRefreshWorld();
    const folder = w.makeFolder({ updateFails: new Error("NS_ERROR_OFFLINE") });
    const result = plain(await w.refresh(folder));
    assert.equal(result.status, "failed");
    assert.equal(result.error, "NS_ERROR_OFFLINE");
    assert.equal(w.listeners.size, 0);
    assert.equal(w.timers[0].cancelled, true);
  });

  it("is failed, with the thrown text, when something that is not an Error is thrown", async () => {
    const first = makeRefreshWorld();
    assert.equal(plain(await first.refresh(first.makeFolder({ updateFails: "refused" }))).error, "refused");
    const second = makeRefreshWorld();
    assert.equal(plain(await second.refresh(second.makeFolder({ updateFails: { code: 7 } }))).error, "[object Object]");
    const falsy = makeRefreshWorld();
    assert.equal(plain(await falsy.refresh(falsy.makeFolder({ updateFails: 0 }))).error, "0", "a falsy value is still shown");
  });

  it("still answers when the folder listener cannot be removed, and says so in the log", async () => {
    const w = makeRefreshWorld();
    w.state.removeFails = true;
    const folder = w.makeFolder();
    const pending = w.refresh(folder);
    folder.imapUpdates[0].urlListener.OnStopRunningUrl(null, 0);
    assert.equal((await pending).status, "done");
    assert.equal(w.warnings.length, 1);
    assert.match(String(w.warnings[0][0]), /could not remove the folder listener/);
  });

  it("counts no new messages when the message total cannot be read", async () => {
    const w = makeRefreshWorld();
    const folder = w.makeFolder({ totalFails: true });
    const pending = w.refresh(folder);
    folder.imapUpdates[0].urlListener.OnStopRunningUrl(null, 0);
    const result = plain(await pending);
    assert.equal(result.status, "done");
    assert.equal(result.newMessages, 0);
  });
});

describe("refreshFolderFromServer: other mail servers", () => {
  it("asks the folder to update and is done when Thunderbird reports that same folder loaded", async () => {
    const w = makeRefreshWorld();
    const folder = w.makeFolder({ type: "exquilla", imap: false, totals: [10, 12] });
    const pending = w.refresh(folder);
    assert.deepEqual(folder.updates, [null]);
    assert.deepEqual(folder.imapUpdates, []);
    const [listener] = [...w.listeners];
    listener.onFolderEvent({ URI: "exquilla://user@host/Other" }, "FolderLoaded"); // another folder
    listener.onFolderEvent(folder, "DeleteOrMoveMsgCompleted"); // another event
    listener.onFolderEvent(null, "FolderLoaded"); // no folder
    assert.equal(w.listeners.size, 1, "still waiting");
    listener.onFolderEvent(folder, "FolderLoaded");
    const result = plain(await pending);
    assert.equal(result.status, "done");
    assert.equal(result.newMessages, 2);
  });

  it("answers pending when no FolderLoaded comes (nothing changed) before the time limit", async () => {
    const w = makeRefreshWorld();
    const folder = w.makeFolder({ type: "owl", imap: false });
    const pending = w.refresh(folder);
    w.timers[0].fire();
    assert.equal((await pending).status, "pending");
  });

  it("treats a folder with no server like any other kind", async () => {
    const w = makeRefreshWorld();
    const folder = w.makeFolder({ type: null, imap: false });
    const pending = w.refresh(folder);
    assert.deepEqual(folder.updates, [null]);
    w.timers[0].fire();
    assert.equal((await pending).status, "pending");
  });

  it("is failed when updateFolder throws", async () => {
    const w = makeRefreshWorld();
    const folder = w.makeFolder({ type: "owl", imap: false, updateFails: new Error("provider refused") });
    const result = plain(await w.refresh(folder));
    assert.equal(result.status, "failed");
    assert.equal(result.error, "provider refused");
  });
});

// ── emptyTrash and emptyJunk ──

const TRASH = 0x100;
const JUNK = 0x40000000;

function makeFolderTree(world, { root, flag = 0, messages = 0, deleteFails = false, nativeEmpty = null, children = [], failRead = false, noUri = false }) {
  const hdrs = Array.from({ length: messages }, (_, i) => ({ id: i }));
  const folder = {
    URI: noUri ? undefined : `mailbox://acct/${root}`,
    name: root,
    hasSubFolders: children.length > 0,
    subFolders: children,
    getFlag: (f) => (flag & f) !== 0,
    deleteMessages(list, win, deleteStorage, isMove, listener, allowUndo) {
      world.deleted.push([root, list.length, win, deleteStorage, isMove, listener, allowUndo]);
      if (deleteFails) throw new Error("NS_ERROR_FAILURE");
    },
  };
  Object.defineProperty(folder, "msgDatabase", {
    get() {
      if (failRead) throw new Error("summary out of date");
      return { enumerateMessages: () => hdrs };
    },
  });
  if (nativeEmpty) folder.emptyTrash = nativeEmpty;
  return folder;
}

function makeEmptyWorld({ allowed = null, window = null, listFails = false } = {}) {
  const world = { deleted: [], errors: [], accounts: [] };
  const sandbox = {
    console: { error: (...args) => world.errors.push(args) },
    Ci: { nsMsgFolderFlags: { Trash: TRASH } },
    MailServices: { accounts: { getAccount: (key) => world.accounts.find((a) => a.key === key) || null } },
    getAccessibleAccounts: () => {
      if (listFails) throw new Error("accounts unavailable");
      return world.accounts.filter((a) => allowed === null || allowed.includes(a.key));
    },
    isAccountAllowed: (key) => allowed === null || allowed.includes(key),
    Services: { wm: { getMostRecentWindow: (type) => { world.windowAsked = type; return window; } } },
  };
  vm.createContext(sandbox);
  vm.runInContext([
    functionSource("findSpecialFolder"),
    functionSource("deleteAllMessagesRecursive"),
    functionSource("emptyTrash"),
    functionSource("emptyJunk"),
    "this.api = { emptyTrash, emptyJunk };",
  ].join("\n"), sandbox);
  world.api = sandbox.api;
  world.tree = (spec) => makeFolderTree(world, spec);
  // An account whose folder tree is `root` (undefined: no server; null: a server without root folder).
  world.addAccount = (key, root) => {
    world.accounts.push({ key, incomingServer: root === undefined ? undefined : { rootFolder: root } });
  };
  return world;
}

describe("emptyTrash", () => {
  it("has Thunderbird empty the Trash folder of every accessible account, and skips accounts without a root folder", () => {
    const w = makeEmptyWorld();
    const calls = [];
    const trash = w.tree({ root: "Trash", flag: TRASH, nativeEmpty: (...args) => calls.push(args) });
    w.addAccount("account1", w.tree({ root: "root", children: [w.tree({ root: "Inbox" }), trash] }));
    w.addAccount("accountNoServer");
    w.addAccount("accountNoRoot", null);
    const result = plain(w.api.emptyTrash());
    assert.deepEqual(result, { success: true, results: [{ account: "account1", folder: "mailbox://acct/Trash", status: "emptied" }] });
    assert.deepEqual(calls, [[null]], "the current signature (listener only) is tried first");
  });

  it("reports an account that has no Trash folder and goes on with the others", () => {
    const w = makeEmptyWorld();
    w.addAccount("account1", w.tree({ root: "root", children: [w.tree({ root: "Inbox" })] }));
    w.addAccount("account2", w.tree({ root: "root2", children: [w.tree({ root: "Trash", flag: TRASH, nativeEmpty() {} })] }));
    assert.deepEqual(plain(w.api.emptyTrash()).results, [
      { account: "account1", status: "no Trash folder found" },
      { account: "account2", folder: "mailbox://acct/Trash", status: "emptied" },
    ]);
  });

  it("only touches the account asked for, and refuses an unknown or a restricted one", () => {
    const w = makeEmptyWorld({ allowed: ["accountA"] });
    const calls = [];
    w.addAccount("accountA", w.tree({ root: "rootA", children: [w.tree({ root: "TrashA", flag: TRASH, nativeEmpty: () => calls.push("A") })] }));
    w.addAccount("accountB", w.tree({ root: "rootB", children: [w.tree({ root: "TrashB", flag: TRASH, nativeEmpty: () => calls.push("B") })] }));
    assert.deepEqual(plain(w.api.emptyTrash("accountA")).results.map((r) => r.account), ["accountA"]);
    assert.deepEqual(calls, ["A"]);
    assert.deepEqual(plain(w.api.emptyTrash("nope")), { error: "Account not found: nope" });
    assert.deepEqual(plain(w.api.emptyTrash("accountB")), { error: "Account not accessible: accountB" });
    assert.deepEqual(calls, ["A"], "the restricted account's Trash is never emptied");
  });

  for (const [label, makeError] of [
    ["a result code that says the argument list is wrong", () => Object.assign(new Error("x"), { result: 0x80570001 })],
    ["a conversion failure code", () => Object.assign(new Error("x"), { result: 0x80570009 })],
    ["a 'Not enough arguments' message", () => new Error("Not enough arguments")],
    ["a 'Could not convert JavaScript argument' message", () => new Error("Could not convert JavaScript argument arg 0")],
  ]) {
    it(`falls back to the old signature with the mail window after ${label}`, () => {
      const msgWindow = { id: "msgWindow" };
      const w = makeEmptyWorld({ window: { msgWindow } });
      const calls = [];
      const trash = w.tree({
        root: "Trash", flag: TRASH,
        nativeEmpty: (...args) => { calls.push(args); if (calls.length === 1) throw makeError(); },
      });
      w.addAccount("account1", w.tree({ root: "root", children: [trash] }));
      assert.equal(plain(w.api.emptyTrash()).results[0].status, "emptied");
      assert.equal(calls.length, 2);
      assert.equal(calls[1][0], msgWindow);
      assert.equal(calls[1][1], null);
      assert.equal(w.windowAsked, "mail:3pane");
    });
  }

  it("passes null for the window when no mail window is open", () => {
    const w = makeEmptyWorld({ window: null });
    const calls = [];
    const trash = w.tree({
      root: "Trash", flag: TRASH,
      nativeEmpty: (...args) => { calls.push(args); if (calls.length === 1) throw new Error("Not enough arguments"); },
    });
    w.addAccount("account1", w.tree({ root: "root", children: [trash] }));
    assert.equal(plain(w.api.emptyTrash()).success, true);
    assert.deepEqual(calls, [[null], [null, null]]);
  });

  it("returns the error of any other failure of the native call", () => {
    const w = makeEmptyWorld();
    const trash = w.tree({ root: "Trash", flag: TRASH, nativeEmpty() { throw new Error("IMAP expunge failed"); } });
    w.addAccount("account1", w.tree({ root: "root", children: [trash] }));
    assert.deepEqual(plain(w.api.emptyTrash()), { error: "Error: IMAP expunge failed" });
  });

  it("deletes the messages of the Trash folder and its subfolders itself when Thunderbird has no emptyTrash", () => {
    const w = makeEmptyWorld();
    const sub = w.tree({ root: "TrashSub", messages: 2 });
    const broken = w.tree({ root: "TrashBroken", messages: 4, deleteFails: true });
    const unreadable = w.tree({ root: "TrashUnreadable", failRead: true });
    const trash = w.tree({ root: "Trash", flag: TRASH, messages: 3, children: [sub, broken, unreadable] });
    w.addAccount("account1", w.tree({ root: "root", children: [trash] }));
    const result = plain(w.api.emptyTrash());
    assert.deepEqual(result.results, [{ account: "account1", folder: "mailbox://acct/Trash", deleted: 5 }]);
    assert.deepEqual(w.deleted.map((d) => [d[0], d[1]]), [["Trash", 3], ["TrashSub", 2], ["TrashBroken", 4]]);
    for (const call of w.deleted) {
      assert.deepEqual(call.slice(2), [null, true, false, null, false], "deleted for good, not moved, no undo");
    }
    assert.equal(w.errors.length, 2, "each folder that failed is logged and the others are still emptied");
    assert.match(String(w.errors[0][0]), /deleteMessages failed for folder/);
    assert.equal(w.errors[0][1], "mailbox://acct/TrashBroken");
    assert.equal(w.errors[1][1], "mailbox://acct/TrashUnreadable");
  });

  it("finds the Trash folder below a folder that has no flags to read", () => {
    const w = makeEmptyWorld();
    const calls = [];
    const trash = w.tree({ root: "Trash", flag: TRASH, nativeEmpty: () => calls.push("emptied") });
    const flagless = w.tree({ root: "Flagless", children: [trash] });
    delete flagless.getFlag;
    w.addAccount("account1", w.tree({ root: "root", children: [flagless] }));
    assert.equal(plain(w.api.emptyTrash()).results[0].status, "emptied");
    assert.deepEqual(calls, ["emptied"]);
  });

  it("returns a failure that is falsy as its text", () => {
    const w = makeEmptyWorld();
    const trash = w.tree({ root: "Trash", flag: TRASH, nativeEmpty() { throw 0; } }); // eslint-disable-line no-throw-literal -- a failure that is not an Error
    w.addAccount("account1", w.tree({ root: "root", children: [trash] }));
    assert.deepEqual(plain(w.api.emptyTrash()), { error: "0" });
  });

  it("deletes nothing from a folder with an empty database, and names a failing folder without an address by its name", () => {
    const w = makeEmptyWorld();
    const empty = w.tree({ root: "TrashEmpty", messages: 0 });
    const nameless = w.tree({ root: "TrashNameless", messages: 2, deleteFails: true, noUri: true });
    const trash = w.tree({ root: "Trash", flag: TRASH, messages: 1, children: [empty, nameless] });
    w.addAccount("account1", w.tree({ root: "root", children: [trash] }));
    const result = plain(w.api.emptyTrash());
    assert.equal(result.results[0].deleted, 1);
    assert.deepEqual(w.deleted.map((d) => d[0]), ["Trash", "TrashNameless"], "the empty folder was not asked to delete anything");
    assert.equal(w.errors[0][1], "TrashNameless");
  });

  it("returns the error when the accounts cannot be listed", () => {
    const w = makeEmptyWorld({ listFails: true });
    assert.deepEqual(plain(w.api.emptyTrash()), { error: "Error: accounts unavailable" });
  });
});

describe("emptyJunk", () => {
  it("deletes the messages of the Junk folder of every accessible account and reports the counts", () => {
    const w = makeEmptyWorld();
    w.addAccount("account1", w.tree({ root: "root", children: [w.tree({ root: "Junk", flag: JUNK, messages: 6 })] }));
    w.addAccount("account2", w.tree({ root: "root2", children: [w.tree({ root: "Inbox" })] }));
    w.addAccount("account3");
    assert.deepEqual(plain(w.api.emptyJunk()), {
      success: true,
      results: [
        { account: "account1", folder: "mailbox://acct/Junk", deleted: 6 },
        { account: "account2", status: "no Junk folder found" },
      ],
    });
    assert.equal(w.deleted.length, 1);
  });

  it("refuses an unknown or a restricted account and deletes nothing", () => {
    const w = makeEmptyWorld({ allowed: ["account1"] });
    w.addAccount("accountB", w.tree({ root: "rootB", children: [w.tree({ root: "Junk", flag: JUNK, messages: 2 })] }));
    assert.deepEqual(plain(w.api.emptyJunk("nope")), { error: "Account not found: nope" });
    assert.deepEqual(plain(w.api.emptyJunk("accountB")), { error: "Account not accessible: accountB" });
    assert.deepEqual(w.deleted, []);
  });

  it("returns the error when the accounts cannot be listed", () => {
    const w = makeEmptyWorld({ listFails: true });
    assert.deepEqual(plain(w.api.emptyJunk()), { error: "Error: accounts unavailable" });
  });
});
