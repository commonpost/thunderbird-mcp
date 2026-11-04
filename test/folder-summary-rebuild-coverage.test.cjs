// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";

// The odd inputs of the folder summary rebuild: failures that are not Error objects, a listener that cannot be
// removed, events that do not end the rebuild, and a reply template that cannot be read. The real region of api.js
// runs against stand-ins; test/folder-summary-rebuild.test.cjs covers the main flow.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const API = fs.readFileSync(path.join(__dirname, "..", "extension", "mcp_server", "api.js"), "utf8");
const BEGIN = API.indexOf("// BEGIN FOLDER SUMMARY REBUILD");
const END = API.indexOf("// END FOLDER SUMMARY REBUILD");
assert.ok(BEGIN >= 0 && END > BEGIN, "folder summary rebuild markers missing");
const REGION = API.slice(BEGIN, END);

const OUT_OF_DATE = 0x80550005;
const NOT_INITIALIZED = 0xC1F30001;
const TEMPLATES_FLAG = 0x400000;
const TPL = "mailbox://nobody@Local%20Folders/Templates";

const tick = () => new Promise((resolve) => { setImmediate(resolve); });

function load({ getAccessibleFolder, serializeFilter = (f) => f, listSendingRules = () => [], filterList = null, removeFails = false } = {}) {
  const timers = [];
  const listeners = new Set();
  const warnings = [];
  const folders = new Map();
  const sandbox = {
    Ci: {
      nsITimer: { TYPE_ONE_SHOT: 0 },
      nsIFolderListener: { event: 0x80 },
      nsIMsgLocalMailFolder: Symbol("nsIMsgLocalMailFolder"),
      nsMsgFolderFlags: { Templates: TEMPLATES_FLAG },
    },
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
        AddFolderListener(listener) { listeners.add(listener); },
        RemoveFolderListener(listener) {
          if (removeFails) throw new Error("NS_ERROR_FAILURE");
          listeners.delete(listener);
        },
      },
    },
    console: { warn: (...args) => warnings.push(args) },
    getAccessibleFolder: getAccessibleFolder || ((uri) => (folders.has(uri) ? { folder: folders.get(uri) } : { error: "Folder not found" })),
    getAccessibleAccounts: () => [],
    isTrashOrJunkFolder: () => false,
    filterSendRulePolicy: () => "confirm",
    getFilterListForAccount: () => (filterList ? { filterList } : { error: "Account not found" }),
    listSendingRules,
    serializeFilter,
    parseReplyTemplateValue(value) {
      const m = /^([^?]+)\?messageId=([^&]+)/.exec(String(value));
      if (!m) throw new Error("bad template value");
      return { folderUri: m[1], messageId: m[2] };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${REGION}
this.ensureFolderDatabase = ensureFolderDatabase;
this.prepareFolderSummary = prepareFolderSummary;
this.prepareFolderDatabase = prepareFolderDatabase;
this.prepareReplyTemplateFolders = prepareReplyTemplateFolders;`, sandbox);

  function addFolder(uri, { throws = OUT_OF_DATE, flags = 0, reparse = "start" } = {}) {
    const db = { uri };
    const folder = {
      URI: uri, rebuilt: false, reparseCalls: 0,
      get msgDatabase() {
        if (!folder.rebuilt) {
          if (typeof throws === "function") throws();
          // An XPCOM failure can reach the extension as a bare number.
          throw throws;
        }
        return db;
      },
      QueryInterface: (iid) => { if (iid === sandbox.Ci.nsIMsgLocalMailFolder) return folder; throw new Error("NS_NOINTERFACE"); },
      getDatabaseWithReparse() {
        folder.reparseCalls++;
        throw reparse === "start" ? { result: NOT_INITIALIZED } : reparse;
      },
      getFlag: (flag) => (flags & flag) !== 0,
    };
    folders.set(uri, folder);
    return folder;
  }
  const finish = (folder) => {
    folder.rebuilt = true;
    for (const listener of [...listeners]) listener.onFolderEvent(folder, "FolderLoaded");
  };
  return { sandbox, timers, listeners, warnings, addFolder, finish };
}

describe("the failure thrown is a bare number", () => {
  it("a bare XPCOM result code is read like the result of an error object", async () => {
    const lab = load();
    const folder = lab.addFolder(`${TPL}Number`, { throws: OUT_OF_DATE });
    const pending = lab.sandbox.ensureFolderDatabase(folder);
    await tick();
    assert.equal(folder.reparseCalls, 1, "the rebuild was started on the strength of the bare number");
    lab.finish(folder);
    assert.equal((await pending).uri, folder.URI);
  });

  it("a code that is not a stale-summary code is thrown as it came", async () => {
    const lab = load();
    const folder = lab.addFolder(`${TPL}Other`, { throws: 0x80004005 });
    await assert.rejects(lab.sandbox.ensureFolderDatabase(folder), (e) => e === 0x80004005);
    assert.equal(folder.reparseCalls, 0);
  });
});

describe("the rebuild listener", () => {
  it("ignores an event that is not FolderLoaded, a missing folder and another folder, and settles once", async () => {
    const lab = load();
    const folder = lab.addFolder(`${TPL}Events`);
    const pending = lab.sandbox.ensureFolderDatabase(folder);
    await tick();
    const [listener] = [...lab.listeners];
    listener.onFolderEvent(folder, "DeleteOrMoveMsgCompleted");
    listener.onFolderEvent(null, "FolderLoaded");
    listener.onFolderEvent({ URI: "mailbox://other/Inbox" }, "FolderLoaded");
    assert.equal(lab.listeners.size, 1, "still waiting");
    lab.finish(folder);
    assert.equal((await pending).uri, folder.URI);
    assert.doesNotThrow(() => listener.onFolderEvent(folder, "FolderLoaded"), "a second FolderLoaded changes nothing");
    assert.equal(lab.timers.filter((t) => t.cancelled).length, lab.timers.length);
  });

  it("goes on when the listener cannot be removed, and says so in the log", async () => {
    const lab = load({ removeFails: true });
    const folder = lab.addFolder(`${TPL}Remove`);
    const pending = lab.sandbox.ensureFolderDatabase(folder);
    await tick();
    lab.finish(folder);
    assert.equal((await pending).uri, folder.URI);
    assert.equal(lab.warnings.length, 1);
    assert.match(String(lab.warnings[0][0]), /could not remove the folder listener/);
  });
});

describe("prepareFolderSummary and prepareFolderDatabase: what is left to the tool", () => {
  it("leaves a failure that is no object at all to the tool (nothing thrown, nothing reported)", async () => {
    const lab = load();
    // eslint-disable-next-line no-throw-literal -- the odd value is the point
    const folder = lab.addFolder(`${TPL}Undefined`, { throws: () => { throw undefined; } });
    assert.equal(await lab.sandbox.prepareFolderSummary(folder), null);
    const text = lab.addFolder(`${TPL}Text`, { throws: "NS_ERROR_FAILURE" });
    assert.equal(await lab.sandbox.prepareFolderSummary(text), null);
  });

  it("leaves a folder lookup that throws, or answers nothing, to the tool", async () => {
    const throwing = load({ getAccessibleFolder: () => { throw new Error("accounts unavailable"); } });
    assert.equal(await throwing.sandbox.prepareFolderDatabase("mailbox://x/Inbox"), null);
    for (const answer of [undefined, null, {}, { error: "no" }]) {
      const lab = load({ getAccessibleFolder: () => answer });
      assert.equal(await lab.sandbox.prepareFolderDatabase("mailbox://x/Inbox"), null, JSON.stringify(answer));
    }
  });
});

describe("prepareReplyTemplateFolders: replies that cannot be read", () => {
  const reply = (value) => ({ type: "reply", value });

  it("skips actions that are null or not replies, in the request and in the rules of the list", async () => {
    const rule = { actions: [{ type: "markRead" }, reply(`${TPL}?messageId=t1`)] };
    const lab = load({ filterList: { getFilterAt: () => rule }, listSendingRules: () => [{ index: 0 }] });
    const folder = lab.addFolder(TPL, { flags: TEMPLATES_FLAG });
    const pending = lab.sandbox.prepareReplyTemplateFolders({
      accountId: "account1",
      actions: [null, undefined, { type: "markRead" }, "reply"],
    });
    await tick();
    assert.equal(folder.reparseCalls, 1, "only the template of the list's reply rule was prepared");
    lab.finish(folder);
    assert.equal(await pending, null);
  });

  it("skips a reply value that is not a template address", async () => {
    const lab = load();
    const folder = lab.addFolder(TPL, { flags: TEMPLATES_FLAG });
    const result = await lab.sandbox.prepareReplyTemplateFolders({ accountId: "account1", actions: [reply("not a template"), reply("")] });
    assert.equal(result, null);
    assert.equal(folder.reparseCalls, 0);
  });

  it("prepares a Templates folder once however many replies name it", async () => {
    const lab = load();
    const folder = lab.addFolder(TPL, { flags: TEMPLATES_FLAG });
    const pending = lab.sandbox.prepareReplyTemplateFolders({
      accountId: "account1",
      actions: [reply(`${TPL}?messageId=a`), reply(`${TPL}?messageId=b`), reply(`${TPL}?messageId=c`)],
    });
    await tick();
    assert.equal(folder.reparseCalls, 1);
    lab.finish(folder);
    assert.equal(await pending, null);
  });

  it("skips a folder whose lookup fails while its flags are read", async () => {
    const lab = load({ getAccessibleFolder: () => ({ folder: { URI: TPL, getFlag() { throw new Error("NS_ERROR_FAILURE"); } } }) });
    assert.equal(await lab.sandbox.prepareReplyTemplateFolders({ accountId: "account1", actions: [reply(`${TPL}?messageId=a`)] }), null);
    const thrown = load({ getAccessibleFolder: () => { throw new Error("accounts unavailable"); } });
    assert.equal(await thrown.sandbox.prepareReplyTemplateFolders({ accountId: "account1", actions: [reply(`${TPL}?messageId=a`)] }), null);
  });

  it("reads the reply rules of the list even when the list cannot be read", async () => {
    const lab = load({ filterList: { getFilterAt: () => { throw new Error("NS_ERROR_FAILURE"); } }, listSendingRules: () => { throw new Error("cannot list"); } });
    assert.equal(await lab.sandbox.prepareReplyTemplateFolders({ accountId: "account1" }), null);
  });
});
