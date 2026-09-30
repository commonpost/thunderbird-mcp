"use strict";

// A local folder whose summary (.msf) Thunderbird finds out of date or missing
// makes msgDatabase throw NS_MSG_ERROR_FOLDER_SUMMARY_OUT_OF_DATE (0x80550005)
// or _MISSING (0x80550006). The tools that read such a folder have Thunderbird
// rebuild the summary (getDatabaseWithReparse, then FolderLoaded), wait for it
// within a time limit and try once more; any other error is left as is.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const API = fs.readFileSync(path.join(__dirname, "..", "extension", "mcp_server", "api.js"), "utf8");
const BEGIN = API.indexOf("// BEGIN FOLDER SUMMARY REBUILD");
const END = API.indexOf("// END FOLDER SUMMARY REBUILD");
const region = API.slice(BEGIN, END);

const OUT_OF_DATE = 0x80550005;
const MISSING = 0x80550006;
const NOT_INITIALIZED = 0xC1F30001;
const TEMPLATES_FLAG = 0x400000;

const xpcomError = (result) => Object.assign(new Error(`NS error 0x${result.toString(16)}`), { result });

function load({ accessible = () => true, policy = "confirm", filterList = null } = {}) {
  const timers = [];
  const listeners = new Set();
  const Ci = {
    nsITimer: { TYPE_ONE_SHOT: 0 },
    nsIFolderListener: { event: 0x80 },
    nsIMsgLocalMailFolder: Symbol("nsIMsgLocalMailFolder"),
    nsMsgFolderFlags: { Templates: TEMPLATES_FLAG },
  };
  const folders = new Map();
  const accounts = [];
  const sandbox = {
    Ci,
    Cc: {
      "@mozilla.org/timer;1": {
        createInstance: () => {
          const timer = {
            cancelled: false,
            initWithCallback(cb, ms) { timer.ms = ms; timer.fire = () => { if (!timer.cancelled) cb.notify(); }; },
            cancel() { timer.cancelled = true; },
          };
          timers.push(timer);
          return timer;
        },
      },
    },
    ChromeUtils: { generateQI: () => function QueryInterface() { return this; } },
    MailServices: {
      mailSession: {
        AddFolderListener(listener, mask) {
          assert.equal(mask, Ci.nsIFolderListener.event);
          listeners.add(listener);
        },
        RemoveFolderListener(listener) { listeners.delete(listener); },
      },
    },
    console: { warn() {} },
    getAccessibleFolder(uri) {
      const folder = folders.get(uri);
      if (!folder) return { error: `Folder not found: ${uri}` };
      if (!accessible(uri)) return { error: `Account not accessible for folder: ${uri}` };
      return { folder };
    },
    getAccessibleAccounts: () => accounts.filter((a) => accessible(a.incomingServer.rootFolder.URI)),
    isTrashOrJunkFolder: (f, checkAncestors) => {
      assert.equal(checkAncestors, false, "flag check only, as walkSearchFolders");
      return f.trashOrJunk === true;
    },
    filterSendRulePolicy: () => (typeof policy === "function" ? policy() : policy),
    getFilterListForAccount: () => (filterList ? { filterList } : { error: "Account not found" }),
    listSendingRules: (list) => list.rules.map((_, index) => ({ index })),
    serializeFilter: (filter) => filter,
    parseReplyTemplateValue(value) {
      const m = /^([^?]+)\?messageId=([^&]+)/.exec(String(value));
      if (!m) throw new Error("bad template value");
      return { folderUri: m[1], messageId: m[2] };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${region}
this.ensureFolderDatabase = ensureFolderDatabase;
this.prepareFolderDatabase = prepareFolderDatabase;
this.prepareReplyTemplateFolders = prepareReplyTemplateFolders;
this.prepareSearchFolders = prepareSearchFolders;
this.pendingRebuilds = () => folderSummaryRebuilds.size;`, sandbox);

  // A folder whose msgDatabase fails with `fail` until Thunderbird has rebuilt
  // its summary; getDatabaseWithReparse behaves as `reparse` says.
  function addFolder(uri, { fail = OUT_OF_DATE, local = true, reparse = "start", afterRebuild = null, flags = 0 } = {}) {
    const db = { uri };
    const folder = {
      URI: uri,
      rebuilt: false,
      reads: 0,
      reparseCalls: 0,
      get msgDatabase() {
        folder.reads++;
        if (fail !== null && !folder.rebuilt) throw xpcomError(fail);
        if (folder.rebuilt && afterRebuild !== null) throw xpcomError(afterRebuild);
        return db;
      },
      QueryInterface(iid) {
        if (iid === Ci.nsIMsgLocalMailFolder && local) return folder;
        throw xpcomError(0x80004002); // NS_NOINTERFACE
      },
      getDatabaseWithReparse(urlListener, msgWindow) {
        folder.reparseCalls++;
        assert.equal(urlListener, null);
        assert.equal(msgWindow, null);
        if (reparse === "start") throw xpcomError(NOT_INITIALIZED);
        if (reparse === "running") throw xpcomError(OUT_OF_DATE);
        if (reparse === "ok") { folder.rebuilt = true; return db; }
        throw xpcomError(reparse);
      },
      getFlag: (flag) => (flags & flag) !== 0,
    };
    folders.set(uri, folder);
    return { folder, db };
  }

  // What Thunderbird does at the end of a rebuild (FinishUpAfterParseFolder).
  function finishRebuild(folder) {
    folder.rebuilt = true;
    for (const listener of [...listeners]) listener.onFolderEvent(folder, "FolderLoaded");
  }

  // Settles `promise`, finishing each rebuild Thunderbird was asked for, in turn.
  async function finishRebuildsUntil(promise) {
    let settled = false;
    const result = promise.then((v) => { settled = true; return v; }, (e) => { settled = true; throw e; });
    for (let i = 0; i < 50 && !settled; i++) {
      await tick();
      for (const f of folders.values()) if (f.reparseCalls > 0 && !f.rebuilt) finishRebuild(f);
    }
    return result;
  }

  return { sandbox, timers, listeners, addFolder, finishRebuild, finishRebuildsUntil, accounts };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("ensureFolderDatabase: summary out of date or missing", () => {
  it("has Thunderbird rebuild the summary, waits for FolderLoaded, then reads the database", async () => {
    const lab = load();
    const { folder, db } = lab.addFolder("mailbox://nobody@Local%20Folders/Inbox");
    const pending = lab.sandbox.ensureFolderDatabase(folder);
    await tick();
    assert.equal(folder.reparseCalls, 1);
    assert.equal(lab.listeners.size, 1, "waits on FolderLoaded");
    lab.finishRebuild(folder);
    assert.equal(await pending, db);
    assert.equal(folder.reads, 2, "one read, one retry");
    assert.equal(lab.listeners.size, 0, "listener removed");
    assert.equal(lab.timers.length, 2, "the rebuild's time limit and the caller's");
    assert.equal(lab.timers[0].ms, 20000);
    assert.ok(lab.timers[1].ms > 19000 && lab.timers[1].ms <= 20000, String(lab.timers[1].ms));
    assert.ok(lab.timers.every((t) => t.cancelled), "time limits cancelled");
    assert.equal(lab.sandbox.pendingRebuilds(), 0);
  });

  it("does the same for a missing summary (0x80550006)", async () => {
    const lab = load();
    const { folder, db } = lab.addFolder("mailbox://nobody@Local%20Folders/Templates", { fail: MISSING });
    const pending = lab.sandbox.ensureFolderDatabase(folder);
    await tick();
    lab.finishRebuild(folder);
    assert.equal(await pending, db);
    assert.equal(folder.reparseCalls, 1);
  });

  it("waits for a rebuild Thunderbird had already started (getDatabaseWithReparse throws OUT_OF_DATE)", async () => {
    const lab = load();
    const { folder, db } = lab.addFolder("mailbox://nobody@Local%20Folders/Inbox", { reparse: "running" });
    const pending = lab.sandbox.ensureFolderDatabase(folder);
    await tick();
    assert.equal(lab.listeners.size, 1);
    lab.finishRebuild(folder);
    assert.equal(await pending, db);
  });

  it("does not wait when getDatabaseWithReparse opens the database after all", async () => {
    const lab = load();
    const { folder, db } = lab.addFolder("mailbox://nobody@Local%20Folders/Inbox", { reparse: "ok" });
    assert.equal(await lab.sandbox.ensureFolderDatabase(folder), db);
    assert.equal(lab.listeners.size, 0);
    assert.equal(lab.timers[0].cancelled, true);
  });

  it("ignores FolderLoaded for another folder", async () => {
    const lab = load();
    const { folder } = lab.addFolder("mailbox://nobody@Local%20Folders/Inbox");
    const other = lab.addFolder("mailbox://nobody@Local%20Folders/Archive").folder;
    let done = false;
    const pending = lab.sandbox.ensureFolderDatabase(folder).then((db) => { done = true; return db; });
    await tick();
    lab.finishRebuild(other);
    await tick();
    assert.equal(done, false);
    lab.finishRebuild(folder);
    await pending;
  });

  it("gives the caller a clear error at its deadline; the rebuild goes on and a later call joins it", async () => {
    const lab = load();
    const { folder, db } = lab.addFolder("mailbox://nobody@Local%20Folders/Inbox");
    const first = lab.sandbox.ensureFolderDatabase(folder, Date.now() + 5000);
    await tick();
    lab.timers[1].fire(); // the caller's deadline, before the rebuild's own limit
    await assert.rejects(first, /^Error: Thunderbird is still rebuilding the summary of folder /);
    assert.equal(lab.listeners.size, 1, "the rebuild is still followed");
    const later = lab.sandbox.ensureFolderDatabase(folder);
    await tick();
    assert.equal(folder.reparseCalls, 1, "joined, not started again");
    lab.finishRebuild(folder);
    assert.equal(await later, db);
  });

  it("starts no rebuild once the caller's deadline has passed (the stale error is thrown as is)", async () => {
    const lab = load();
    const { folder } = lab.addFolder("mailbox://nobody@Local%20Folders/Inbox");
    await assert.rejects(lab.sandbox.ensureFolderDatabase(folder, Date.now() - 1), (e) => e.result === OUT_OF_DATE);
    assert.equal(folder.reparseCalls, 0);
    assert.equal(lab.listeners.size, 0);
    assert.equal(await lab.sandbox.prepareFolderDatabase(folder.URI, Date.now() - 1), null, "left to the tool");
  });

  it("gives a clear error when the rebuild does not end within the time limit", async () => {
    const lab = load();
    const { folder } = lab.addFolder("mailbox://nobody@Local%20Folders/Inbox");
    const pending = lab.sandbox.ensureFolderDatabase(folder);
    await tick();
    lab.timers[0].fire();
    await assert.rejects(pending, (e) => {
      assert.match(e.message, /^Thunderbird is still rebuilding the summary of folder mailbox:\/\/nobody@Local%20Folders\/Inbox; try again/);
      assert.equal(e.folderSummaryRebuilding, true);
      return true;
    });
    assert.equal(lab.listeners.size, 0, "listener removed");
    assert.equal(lab.sandbox.pendingRebuilds(), 0, "a later call can wait again");
    assert.equal(folder.reads, 1, "no retry after the time limit");
  });

  it("tries only once more: a second failure after the rebuild is thrown as is", async () => {
    const lab = load();
    const { folder } = lab.addFolder("mailbox://nobody@Local%20Folders/Inbox", { afterRebuild: OUT_OF_DATE });
    const pending = lab.sandbox.ensureFolderDatabase(folder);
    await tick();
    lab.finishRebuild(folder);
    await assert.rejects(pending, (e) => e.result === OUT_OF_DATE);
    assert.equal(folder.reparseCalls, 1);
    assert.equal(folder.reads, 2);
  });

  it("throws Thunderbird's error when the rebuild cannot start", async () => {
    const lab = load();
    const { folder } = lab.addFolder("mailbox://nobody@Local%20Folders/Inbox", { reparse: 0x80004003 });
    await assert.rejects(lab.sandbox.ensureFolderDatabase(folder), (e) => e.result === 0x80004003);
    assert.equal(lab.listeners.size, 0);
    assert.equal(lab.timers[0].cancelled, true);
    assert.equal(lab.sandbox.pendingRebuilds(), 0);
  });

  it("starts one rebuild for two simultaneous calls on the same folder", async () => {
    const lab = load();
    const { folder, db } = lab.addFolder("mailbox://nobody@Local%20Folders/Inbox");
    const first = lab.sandbox.ensureFolderDatabase(folder);
    const second = lab.sandbox.ensureFolderDatabase(folder);
    await tick();
    assert.equal(folder.reparseCalls, 1, "a single rebuild");
    assert.equal(lab.listeners.size, 1, "a single listener");
    assert.equal(lab.timers.length, 3, "one rebuild time limit, one per caller");
    lab.finishRebuild(folder);
    assert.deepEqual(await Promise.all([first, second]), [db, db]);
  });
});

describe("ensureFolderDatabase: other errors", () => {
  it("throws any other error as is, without a rebuild", async () => {
    const lab = load();
    const { folder } = lab.addFolder("mailbox://nobody@Local%20Folders/Inbox", { fail: 0x80004005 });
    await assert.rejects(lab.sandbox.ensureFolderDatabase(folder), (e) => e.result === 0x80004005);
    assert.equal(folder.reparseCalls, 0);
    assert.equal(lab.listeners.size, 0);
    assert.equal(lab.timers.length, 0);
  });

  it("does not rebuild a folder that is not a local mail folder (IMAP, news)", async () => {
    const lab = load();
    const { folder } = lab.addFolder("imap://me@example.test/INBOX", { local: false });
    await assert.rejects(lab.sandbox.ensureFolderDatabase(folder), (e) => e.result === OUT_OF_DATE);
    assert.equal(folder.reparseCalls, 0);
  });

  it("does not rebuild a server's root folder (it holds no messages)", async () => {
    const lab = load();
    const { folder } = lab.addFolder("mailbox://nobody@Local%20Folders", { fail: MISSING });
    folder.isServer = true;
    await assert.rejects(lab.sandbox.ensureFolderDatabase(folder), (e) => e.result === MISSING);
    assert.equal(folder.reparseCalls, 0);
    assert.equal(await lab.sandbox.prepareFolderDatabase(folder.URI), null, "left to the tool, as before");
  });

  it("reads a healthy folder once, without a rebuild", async () => {
    const lab = load();
    const { folder, db } = lab.addFolder("mailbox://nobody@Local%20Folders/Inbox", { fail: null });
    assert.equal(await lab.sandbox.ensureFolderDatabase(folder), db);
    assert.equal(folder.reads, 1);
    assert.equal(folder.reparseCalls, 0);
  });
});

describe("prepareFolderDatabase: pre-flight of a tool", () => {
  it("returns the clear error only when the rebuild is still running", async () => {
    const lab = load();
    const { folder } = lab.addFolder("mailbox://nobody@Local%20Folders/Inbox");
    const pending = lab.sandbox.prepareFolderDatabase(folder.URI);
    await tick();
    lab.timers[0].fire();
    const result = await pending;
    assert.match(result.error, /^Thunderbird is still rebuilding the summary of folder /);
  });

  it("returns null after a successful rebuild, so the tool reads the folder", async () => {
    const lab = load();
    const { folder } = lab.addFolder("mailbox://nobody@Local%20Folders/Inbox");
    const pending = lab.sandbox.prepareFolderDatabase(folder.URI);
    await tick();
    lab.finishRebuild(folder);
    assert.equal(await pending, null);
  });

  it("leaves any other error to the tool (reported as before)", async () => {
    const lab = load();
    lab.addFolder("mailbox://nobody@Local%20Folders/Inbox", { fail: 0x80004005 });
    assert.equal(await lab.sandbox.prepareFolderDatabase("mailbox://nobody@Local%20Folders/Inbox"), null);
    lab.addFolder("mailbox://nobody@Local%20Folders/Gone", { reparse: 0x80004003 });
    assert.equal(await lab.sandbox.prepareFolderDatabase("mailbox://nobody@Local%20Folders/Gone"), null);
    assert.equal(await lab.sandbox.prepareFolderDatabase("mailbox://nobody@Local%20Folders/Unknown"), null);
    assert.equal(await lab.sandbox.prepareFolderDatabase(undefined), null);
  });

  it("does not touch a folder of an account that is not accessible", async () => {
    const lab = load({ accessible: (uri) => !uri.includes("secret") });
    const { folder } = lab.addFolder("mailbox://nobody@secret/Inbox");
    assert.equal(await lab.sandbox.prepareFolderDatabase(folder.URI), null);
    assert.equal(folder.reads, 0);
    assert.equal(folder.reparseCalls, 0);
  });
});

describe("prepareReplyTemplateFolders: Templates folders of reply rules", () => {
  const TPL = "mailbox://nobody@Local%20Folders/Templates";

  it("rebuilds the Templates folder of a requested reply action under \"confirm\"", async () => {
    const lab = load();
    const { folder } = lab.addFolder(TPL, { flags: TEMPLATES_FLAG });
    const pending = lab.sandbox.prepareReplyTemplateFolders({
      accountId: "account1",
      actions: [{ type: "markRead" }, { type: "reply", value: `${TPL}?messageId=t1@example.test&subject=x` }],
    });
    await tick();
    assert.equal(folder.reparseCalls, 1);
    lab.finishRebuild(folder);
    assert.equal(await pending, null);
  });

  it("covers the reply rules already in the account's list (shown in the dialog)", async () => {
    const lab = load({ filterList: { rules: [{ actions: [{ type: "reply", value: `${TPL}?messageId=t2@example.test` }] }], getFilterAt(i) { return this.rules[i]; } } });
    const { folder } = lab.addFolder(TPL, { flags: TEMPLATES_FLAG });
    const pending = lab.sandbox.prepareReplyTemplateFolders({ accountId: "account1" });
    await tick();
    assert.equal(folder.reparseCalls, 1);
    lab.finishRebuild(folder);
    assert.equal(await pending, null);
  });

  it("returns the clear error when the Templates folder is still being rebuilt", async () => {
    const lab = load();
    lab.addFolder(TPL, { flags: TEMPLATES_FLAG });
    const pending = lab.sandbox.prepareReplyTemplateFolders({
      accountId: "account1", actions: [{ type: "reply", value: `${TPL}?messageId=t1@example.test` }],
    });
    await tick();
    lab.timers[0].fire();
    assert.match((await pending).error, /still rebuilding the summary of folder mailbox:\/\/nobody@Local%20Folders\/Templates/);
  });

  it("reads nothing under \"block\", for a non-Templates folder, a non-canonical URI or an inaccessible account", async () => {
    const reply = (uri) => ({ accountId: "account1", actions: [{ type: "reply", value: `${uri}?messageId=t1@example.test` }] });
    const blocked = load({ policy: "block" });
    const tpl = blocked.addFolder(TPL, { flags: TEMPLATES_FLAG }).folder;
    assert.equal(await blocked.sandbox.prepareReplyTemplateFolders(reply(TPL)), null);
    assert.equal(tpl.reads, 0);

    const unreadable = load({ policy: () => { throw new Error("pref unreadable"); } });
    unreadable.addFolder(TPL, { flags: TEMPLATES_FLAG });
    assert.equal(await unreadable.sandbox.prepareReplyTemplateFolders(reply(TPL)), null, "never throws");

    const lab = load({ accessible: (uri) => !uri.includes("secret") });
    const inbox = lab.addFolder("mailbox://nobody@Local%20Folders/Inbox").folder;
    const secret = lab.addFolder("mailbox://nobody@secret/Templates", { flags: TEMPLATES_FLAG }).folder;
    const odd = lab.addFolder("mailbox://nobody@Local Folders/Templates", { flags: TEMPLATES_FLAG }).folder;
    odd.URI = TPL; // lenient lookup: the canonical URI differs from the one given
    for (const uri of ["mailbox://nobody@Local%20Folders/Inbox", "mailbox://nobody@secret/Templates", "mailbox://nobody@Local Folders/Templates"]) {
      assert.equal(await lab.sandbox.prepareReplyTemplateFolders(reply(uri)), null);
    }
    assert.equal(inbox.reads + secret.reads + odd.reads, 0);
  });
});

describe("dispatch: which tools rebuild a folder summary first", () => {
  const callTool = API.slice(API.indexOf("const FOLDER_READING_TOOLS = new Set(["), API.indexOf("switch (name) {", API.indexOf("async function callTool(name, args)")));
  const between = (start, end) => {
    const i = API.indexOf(start);
    assert.ok(i >= 0, start);
    return API.slice(i, API.indexOf(end, i));
  };

  it("pre-flights every tool that reads the folder named by folderPath, before the tool runs", () => {
    for (const name of ["getMessage", "replyToMessage", "forwardMessage", "displayMessage", "deleteMessages", "updateMessage"]) {
      assert.ok(callTool.includes(`"${name}"`), `${name} is not pre-flighted`);
    }
    assert.match(callTool, /FOLDER_READING_TOOLS\.has\(name\) \? await prepareFolderDatabase\(args\.folderPath\)/);
    assert.match(callTool, /REPLY_TEMPLATE_READING_TOOLS\.has\(name\) \? await prepareReplyTemplateFolders\(args\)/);
    assert.ok(callTool.trimEnd().endsWith("if (notReady) return notReady;"), "the tool runs only after the pre-flight");
  });

  it("pre-flights each message of getMessages, within one time limit for the call", () => {
    const body = between("async function getMessages(", "const failed = results.filter");
    assert.match(body, /const rebuildDeadline = Date\.now\(\) \+ FOLDER_SUMMARY_REBUILD_TIMEOUT_MS;/);
    assert.match(body, /await prepareFolderDatabase\(folderPath, rebuildDeadline\)\s+\|\| await getMessage\(/);
  });

  it("searchMessages and getRecentMessages: the named folder, the threadOf seed and every folder they walk", () => {
    assert.match(callTool, /const FOLDER_SEARCHING_TOOLS = new Set\(\["searchMessages", "getRecentMessages"\]\);/);
    assert.match(callTool, /FOLDER_SEARCHING_TOOLS\.has\(name\) \? await prepareSearchFolders\(args\)/);
  });

  it("prepareSearchFolders covers walkSearchFolders' scope (same Trash / Junk and subfolder rules)", () => {
    const walk = between("function walkSearchFolders(args, visit) {", "function threadOfSearch(");
    const prep = between("async function prepareSearchFolders(args) {", "// END FOLDER SUMMARY REBUILD");
    for (const rule of [
      "if (!args.includeTrash && folder !== rootFolder && isTrashOrJunkFolder(folder, false)) return;",
      "args.includeSubfolders !== false && folder.hasSubFolders",
      "const result = getAccessibleFolder(args.folderPath);",
      "for (const account of getAccessibleAccounts()) {",
      "rootFolder = account.incomingServer.rootFolder;",
    ]) {
      const inPrep = rule.replace("const result = ", "const found = ");
      assert.ok(walk.includes(rule), `walkSearchFolders no longer has: ${rule}`);
      assert.ok(prep.includes(inPrep), `prepareSearchFolders does not have: ${inPrep}`);
    }
  });
});

describe("prepareSearchFolders: pre-flight of searchMessages / getRecentMessages", () => {
  const LF = "mailbox://nobody@Local%20Folders";

  function tree(lab) {
    const root = lab.addFolder(LF, { fail: MISSING }).folder;
    root.isServer = true;
    const inbox = lab.addFolder(`${LF}/Inbox`).folder;
    const projects = lab.addFolder(`${LF}/Inbox/Projects`).folder;
    const trash = lab.addFolder(`${LF}/Trash`).folder;
    trash.trashOrJunk = true;
    const archive = lab.addFolder(`${LF}/Archive`, { fail: null }).folder;
    Object.assign(root, { hasSubFolders: true, subFolders: [inbox, trash, archive] });
    Object.assign(inbox, { hasSubFolders: true, subFolders: [projects] });
    lab.accounts.push({ incomingServer: { rootFolder: root } });
    return { root, inbox, projects, trash, archive };
  }

  it("rebuilds every stale folder of the accessible accounts, one after the other, Trash / Junk left out", async () => {
    const lab = load();
    const { root, inbox, projects, trash, archive } = tree(lab);
    const order = [];
    for (const f of [inbox, projects]) {
      const reparse = f.getDatabaseWithReparse;
      f.getDatabaseWithReparse = (...a) => { order.push(f.URI); assert.equal(lab.listeners.size, 1, "one at a time"); return reparse(...a); };
    }
    assert.equal(await lab.finishRebuildsUntil(lab.sandbox.prepareSearchFolders({ query: "" })), null);
    assert.deepEqual(order, [inbox.URI, projects.URI]);
    assert.equal(root.reparseCalls + trash.reparseCalls + archive.reparseCalls, 0);
    assert.equal(archive.reads, 1, "a healthy folder is only read");
  });

  it("follows includeTrash, folderPath and includeSubfolders like walkSearchFolders", async () => {
    let lab = load();
    let f = tree(lab);
    await lab.finishRebuildsUntil(lab.sandbox.prepareSearchFolders({ includeTrash: true }));
    assert.equal(f.trash.reparseCalls, 1);

    lab = load();
    f = tree(lab);
    await lab.finishRebuildsUntil(lab.sandbox.prepareSearchFolders({ folderPath: f.inbox.URI, includeSubfolders: false }));
    assert.deepEqual([f.inbox.reparseCalls, f.projects.reparseCalls, f.trash.reparseCalls], [1, 0, 0]);

    lab = load();
    f = tree(lab);
    await lab.finishRebuildsUntil(lab.sandbox.prepareSearchFolders({ folderPath: f.trash.URI }));
    assert.equal(f.trash.reparseCalls, 1, "a Trash asked for by folderPath is read");
  });

  it("prepares the threadOf seed's folder even outside the scope", async () => {
    const lab = load();
    const f = tree(lab);
    const seed = lab.addFolder("mailbox://nobody@Local%20Folders/Old").folder;
    await lab.finishRebuildsUntil(lab.sandbox.prepareSearchFolders({
      folderPath: f.inbox.URI, includeSubfolders: false, threadOf: { messageId: "m@x", folderPath: seed.URI },
    }));
    assert.deepEqual([f.inbox.reparseCalls, seed.reparseCalls, f.projects.reparseCalls], [1, 1, 0]);
  });

  it("gives the clear error when the named folder is still rebuilding; skips a walked folder silently", async () => {
    let lab = load();
    let f = tree(lab);
    const named = lab.sandbox.prepareSearchFolders({ folderPath: f.inbox.URI });
    await tick();
    lab.timers[0].fire();
    assert.match((await named).error, /still rebuilding the summary of folder mailbox:\/\/nobody@Local%20Folders\/Inbox;/);

    lab = load();
    f = tree(lab);
    const walked = lab.sandbox.prepareSearchFolders({});
    await tick();
    lab.timers[0].fire(); // Inbox, reached by the walk: skipped, the walk goes on
    await tick();
    lab.finishRebuild(f.projects);
    assert.equal(await walked, null);
    assert.equal(f.projects.reparseCalls, 1);
  });

  it("searchBody (Gloda) prepares the named folder only", async () => {
    const lab = load();
    const f = tree(lab);
    await lab.finishRebuildsUntil(lab.sandbox.prepareSearchFolders({ folderPath: f.inbox.URI, searchBody: true, query: "abc" }));
    assert.deepEqual([f.inbox.reparseCalls, f.projects.reparseCalls], [1, 0]);
  });

  it("touches nothing of an account that is not accessible", async () => {
    const lab = load({ accessible: (uri) => !uri.startsWith("mailbox://nobody@Local%20Folders") });
    const f = tree(lab);
    assert.equal(await lab.sandbox.prepareSearchFolders({}), null);
    assert.equal(await lab.sandbox.prepareSearchFolders({ folderPath: f.inbox.URI }), null);
    assert.equal(await lab.sandbox.prepareSearchFolders({ threadOf: { messageId: "m@x", folderPath: f.inbox.URI } }), null);
    assert.equal(f.inbox.reads + f.projects.reads + f.trash.reads + f.archive.reads, 0);
  });
});
