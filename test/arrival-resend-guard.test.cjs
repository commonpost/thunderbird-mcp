// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";

// Thunderbird runs an IMAP account's filter rules on mail that appears in a
// folder, also when it was moved or copied there: in the Inbox (or a folder
// with "applyIncomingFilters"), the rules acting on new mail, read or not; in
// any folder, the rules run "after classification", on unread mail. A rule
// there that forwards or replies then sends that mail.
//
// MCP refuses the case the lab measured and nothing more: mail put where the
// rules for new mail run (an IMAP Inbox, a folder with
// "applyIncomingFilters") and a rule there sends it. Elsewhere the request
// goes through and the result warns, naming the rule: a refusal would stop
// ordinary work for a rule that may not even match (findArrivalResend,
// arrivalResendBlocks and their callers in api.js).
//
// Two layers: the pure helpers of FILTER RULE HELPERS, and the REAL handler
// code (updateMessage, deleteMessages, the folder handlers, the filter target
// checks, the draft save) run in a vm with XPCOM doubles.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const apiSource = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");

const ACTIONS = { Custom: -1, MoveToFolder: 1, MarkRead: 4, Reply: 9, Forward: 10, CopyToFolder: 16, AddTag: 17 };
const TYPES = { InboxRule: 0x1, InboxJavaScript: 0x2, NewsRule: 0x4, NewsJavaScript: 0x8, Manual: 0x10, PostPlugin: 0x20,
  PostOutgoing: 0x40, Archive: 0x80, Periodic: 0x100 };
const FLAGS = { Virtual: 0x20, Trash: 0x100, SentMail: 0x200, Drafts: 0x400, Queue: 0x800, Inbox: 0x1000, Archive: 0x4000,
  Templates: 0x400000, Junk: 0x40000000 };
const CI = { nsMsgFilterAction: ACTIONS, nsMsgFilterType: TYPES, nsMsgFolderFlags: FLAGS, nsIImapIncomingServer: {},
  nsMsgImapDeleteModels: { IMAPDelete: 0, MoveToTrash: 1, DeleteNoTrash: 2 }, nsIMsgCompType: { New: 0 },
  nsIMsgCompDeliverMode: { SaveAsDraft: 1 }, nsIMsgCompSendFormat: { Unset: -1, Auto: 0 } };

function slice(begin, end) {
  const start = apiSource.indexOf(begin);
  assert.ok(start >= 0, `marker missing: ${begin}`);
  const stop = apiSource.indexOf(end, start + begin.length);
  assert.ok(stop > start, `marker missing: ${end}`);
  return apiSource.slice(start, stop);
}
function functionSource(name, prefix = "") {
  const indent = "            ";
  const start = apiSource.indexOf(`\n${indent}${prefix}function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  const close = `\n${indent}}\n`;
  return apiSource.slice(start, apiSource.indexOf(close, start) + close.length);
}

const HELPERS = [
  slice("// BEGIN FILTER SEARCH TERM HELPERS", "// END FILTER SEARCH TERM HELPERS"),
  slice("// BEGIN FILTER RULE HELPERS", "// END FILTER RULE HELPERS"),
].join("\n");
const GLUE = slice("            // Mail put into a folder where Thunderbird runs filter rules on it",
  "            // A moveToFolder/copyToFolder action files");
const TARGET_CHECKS = slice("            function resolveFilterTargetFolder(uri) {", "            // An address book named by a filter condition");
// Up to createFolder: holds the special folder guards updateMessage uses.
const UPDATE_MESSAGE = slice("            function updateMessage(", "\n            function createFolder(");
const DELETE_MESSAGES = slice("            function isTrashOrDescendant(folder) {", "            function updateMessage(");
// FOLDER_TEXT_NOTE and the special folder guards come with UPDATE_MESSAGE.
const FOLDER_HANDLERS = [functionSource("isTrashOrDescendant"), functionSource("renameFolder"), functionSource("deleteFolder"),
  functionSource("moveFolder")].join("\n");
const DRAFT_SAVE = functionSource("getDraftsFolder") + functionSource("draftArrivalCheck") + functionSource("accountKeyForIdentity")
  + functionSource("saveComposeFieldsAsDraft", "async ");

function loadHelpers() {
  const sandbox = { Ci: CI, Services: { prefs: { getCharPref: (_n, d) => d } } };
  vm.createContext(sandbox);
  vm.runInContext(`${HELPERS}
this.api = { arrivalFilterScope, arrivalRuleMask, arrivalRules, findArrivalResend, describeArrivalResend,
  arrivalResendBlocks, ARRIVAL_FILTER_MAX_FOLDERS };`, sandbox);
  return sandbox.api;
}
const api = loadHelpers();
const plain = (v) => JSON.parse(JSON.stringify(v));

// ── Doubles ──

function action(type, value) {
  return type === "forward" ? { type: ACTIONS.Forward, strValue: value }
    : type === "reply" ? { type: ACTIONS.Reply, strValue: value }
      : type === "move" ? { type: ACTIONS.MoveToFolder, targetFolderUri: value }
        : type === "copy" ? { type: ACTIONS.CopyToFolder, targetFolderUri: value }
          : type === "custom" ? { type: ACTIONS.Custom }
            : { type: ACTIONS.MarkRead };
}

// rules: [{ name, type = 17, enabled = true, actions: [["forward", "a@b.test"], ...], broken }]
function makeFilterList(rules) {
  return {
    get filterCount() { return rules.length; },
    getFilterAt(i) {
      const r = rules[i];
      if (r.broken) throw new Error("NS_ERROR_FAILURE");
      const acts = r.actions.map(([t, v]) => action(t, v));
      return { filterName: r.name, enabled: r.enabled !== false, filterType: r.type ?? 17, temporary: false,
        get actionCount() { return acts.length; }, getActionAt: (a) => acts[a] };
    },
  };
}

const IMAP = "imap://me@imap.example.test";
const IMAP_INBOX = `${IMAP}/INBOX`;
const IMAP_ARCHIVE = `${IMAP}/Archive`;
const IMAP_SORTED = `${IMAP}/Sorted`;
const IMAP_TRASH = `${IMAP}/Trash`;
const IMAP_DRAFTS = `${IMAP}/Drafts`;
const OTHER = "imap://other@mail.example.test";
const OTHER_INBOX = `${OTHER}/INBOX`;
const LOCAL = "mailbox://nobody@Local%20Folders";
const LOCAL_INBOX = `${LOCAL}/Inbox`;
const LOCAL_ARCHIVE = `${LOCAL}/Archive`;
const FORWARD_RULE = { name: "To my phone", actions: [["forward", "me@phone.example.test"]] };

// A mail world. Options: rules of the three servers, folder properties, what is broken.
function world({ imapRules = [FORWARD_RULE], otherRules = [], localRules = [], archiveProp, trashProp, sortedProp,
  imapBroken, extraFolders = {} } = {}) {
  const servers = {
    imap: { type: "imap", rules: imapRules, broken: imapBroken },
    other: { type: "imap", rules: otherRules },
    local: { type: "none", rules: localRules },
  };
  const defs = {
    [IMAP]: { server: "imap", root: true },
    [IMAP_INBOX]: { server: "imap", flags: FLAGS.Inbox, parent: IMAP },
    [IMAP_ARCHIVE]: { server: "imap", prop: archiveProp, parent: IMAP },
    [IMAP_SORTED]: { server: "imap", prop: sortedProp, parent: IMAP },
    [IMAP_TRASH]: { server: "imap", flags: FLAGS.Trash, prop: trashProp, parent: IMAP },
    [IMAP_DRAFTS]: { server: "imap", flags: FLAGS.Drafts, parent: IMAP },
    [OTHER]: { server: "other", root: true },
    [OTHER_INBOX]: { server: "other", flags: FLAGS.Inbox, parent: OTHER },
    [LOCAL]: { server: "local", root: true },
    [LOCAL_INBOX]: { server: "local", flags: FLAGS.Inbox, parent: LOCAL },
    [LOCAL_ARCHIVE]: { server: "local", parent: LOCAL },
    ...extraFolders,
  };
  const serverObjs = {};
  for (const [key, s] of Object.entries(servers)) {
    serverObjs[key] = { type: s.type, deleteModel: 1, QueryInterface() { return this; },
      getFilterList: () => { if (s.broken) throw new Error("NS_ERROR_FILE_CORRUPTED"); return makeFilterList(s.rules || []); } };
  }
  const byUri = new Map();
  for (const [uri, d] of Object.entries(defs)) {
    const folder = {
      URI: uri, name: decodeURIComponent(uri.split("/").pop()), flags: d.flags || 0, server: serverObjs[d.server],
      parent: null, isServer: !!d.root, hasSubFolders: false, subFolders: [], unread: d.unread ?? 1,
      get prettyName() { return this.name; },
      getFlag(flag) { return (this.flags & flag) !== 0; },
      isSpecialFolder(flag) { return this.getFlag(flag); },
      getFilterList(w) { return this.server.getFilterList(w); },
      getNumUnread() { return this.unread; },
      getInheritedStringProperty(name) {
        assert.equal(name, "applyIncomingFilters");
        if (d.propThrows) throw new Error("NS_ERROR_NOT_AVAILABLE");
        return d.prop ?? (this.parent ? this.parent.getInheritedStringProperty(name) : "");
      },
    };
    byUri.set(uri, folder);
  }
  for (const [uri, d] of Object.entries(defs)) {
    if (!d.parent) continue;
    const f = byUri.get(uri);
    f.parent = byUri.get(d.parent);
    f.parent.subFolders.push(f);
    f.parent.hasSubFolders = true;
  }
  return byUri;
}

// The real handler code, with `byUri` as the whole mail store. `restricted`:
// account roots MCP cannot reach.
function loadHandlers(byUri, { restricted = [], hdrs = [], source = IMAP_ARCHIVE, trash = IMAP_TRASH } = {}) {
  const calls = [];
  const mutations = [];
  const src = byUri.get(source);
  Object.assign(src, {
    markMessagesRead: (_h, v) => mutations.push(["read", v]),
    markMessagesFlagged: () => mutations.push(["flagged"]),
    addKeywordsToMessages: (_h, k) => mutations.push(["addTags", k]),
    removeKeywordsFromMessages: (_h, k) => mutations.push(["removeTags", k]),
    deleteMessages: () => calls.push(["deleteMessages", src.URI]),
  });
  const db = { getMsgHdrForMessageID: (id) => hdrs.find((h) => h.messageId === id) || null, enumerateMessages: () => [] };
  for (const f of byUri.values()) f.rename = (n) => calls.push(["rename", f.URI, n]);
  const sandbox = {
    Ci: CI,
    Services: { prefs: { getCharPref: (_n, d) => d, getIntPref: (_n, d) => d }, wm: { getMostRecentWindow: () => null },
      tm: { dispatchToMainThread: (fn) => fn() } },
    MailServices: {
      folderLookup: { getFolderForURL: (uri) => byUri.get(uri) || null },
      copy: {
        copyMessages: (_from, _hdrs, to) => calls.push(["copyMessages", to.URI]),
        copyFolder: (f, to) => calls.push(["copyFolder", f.URI, to.URI]),
      },
      accounts: {
        allIdentities: [],
        accounts: [{ key: "a-imap", identities: [{ key: "id-imap" }], incomingServer: { rootFolder: byUri.get(IMAP) } }],
        getAccount: (k) => (k === "a-imap" ? { incomingServer: { rootFolder: byUri.get(IMAP) } } : null),
        allServers: [IMAP, OTHER, LOCAL].map((uri) => ({ serverURI: uri, rootFolder: byUri.get(uri) })),
      },
    },
    console: { warn: () => {} },
    getAccessibleFolder: (uri) => {
      if (!byUri.has(uri)) return { error: `Folder not found: ${uri}` };
      if (restricted.some((r) => uri.startsWith(r))) return { error: `Account not accessible for folder: ${uri}` };
      return { folder: byUri.get(uri) };
    },
    openFolder: () => ({ folder: src, db }),
    findTrashFolder: () => byUri.get(trash) || null,
    folderDisplayName: (f) => f.name,
    assertFilterText: () => {},
    FILTER_NAME_MAX_LENGTH: 512,
    deleteVirtualFolder: () => ({ success: true }),
    isAccountAllowed: () => true,
    // Thunderbird's own draft save, stubbed: only the arrival check is under test here.
    Components: { isSuccessCode: () => true },
    descsToMsgAttachments: () => [],
    composeDraftSave: async () => { calls.push(["composeDraftSave"]); return { msgCompose: { compFields: { draftId: "", messageId: "<d1@example.test>" } }, status: 0 }; },
    saveDraftViaSend: async () => { calls.push(["saveDraftViaSend"]); return { success: true, messageId: "d1@example.test" }; },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${HELPERS}
${GLUE}
${TARGET_CHECKS}
${UPDATE_MESSAGE}
${FOLDER_HANDLERS}
${DRAFT_SAVE}
this.h = { arrivalResendCheck, resolveFilterTargetFolder, checkExistingFilterTarget, updateMessage, renameFolder,
  deleteFolder, moveFolder, draftArrivalCheck, saveComposeFieldsAsDraft, selectManualRunFilters, buildRuleActions, FILTER_TYPE_MANUAL,
  FILTER_TARGET_RESENDS };`, sandbox);
  const delSandbox = { ...sandbox };
  vm.createContext(delSandbox);
  vm.runInContext(`${HELPERS}\n${GLUE}\n${DELETE_MESSAGES}\nthis.deleteMessages = deleteMessages;`, delSandbox);
  return { h: { ...sandbox.h, deleteMessages: delSandbox.deleteMessages }, calls, mutations };
}

const READ = { messageId: "old@example.test", isRead: true };
const UNREAD = { messageId: "old@example.test", isRead: false };
function move(h, to, { read, trash } = {}) {
  return h.updateMessage("old@example.test", undefined, IMAP_ARCHIVE, read, undefined, undefined, undefined, to, trash);
}

// ── Pure helpers ──

describe("arrivalFilterScope and arrivalRuleMask", () => {
  const prop = (v) => () => v;
  it("local servers run filters only while downloading", () => {
    for (const serverType of ["none", "pop3", "rss", "nntp"]) {
      assert.equal(api.arrivalFilterScope({ serverType, isInbox: true, inheritedProperty: prop("true") }), "none", serverType);
    }
  });
  it("an IMAP Inbox or applyIncomingFilters folder runs every rule on new mail; any other folder, rules after classification", () => {
    assert.equal(api.arrivalFilterScope({ serverType: "imap", isInbox: true, inheritedProperty: prop("") }), "all");
    assert.equal(api.arrivalFilterScope({ serverType: "imap", isInbox: false, inheritedProperty: prop("true") }), "all");
    assert.equal(api.arrivalFilterScope({ serverType: "imap", isInbox: false, inheritedProperty: prop("") }), "unread");
    assert.equal(api.arrivalFilterScope({ serverType: "imap", isInbox: false, inheritedProperty: prop("false") }), "unread");
  });
  it("an unknown server type is treated like IMAP; an unreadable property counts as \"true\"", () => {
    assert.equal(api.arrivalFilterScope({ serverType: "ews", isInbox: true, inheritedProperty: prop("") }), "all");
    assert.equal(api.arrivalFilterScope({ serverType: undefined, isInbox: false, inheritedProperty: prop("") }), "unread");
    assert.equal(api.arrivalFilterScope({ serverType: "imap", isInbox: false,
      inheritedProperty: () => { throw new Error("x"); } }), "all");
  });
  it("the Inbox adds the periodic rules; elsewhere only unread mail meets the rules after classification", () => {
    assert.equal(api.arrivalRuleMask("all", true, false), 0x1 | 0x2 | 0x4 | 0x8 | 0x20 | 0x100);
    assert.equal(api.arrivalRuleMask("all", false, false), 0x1 | 0x2 | 0x4 | 0x8 | 0x20);
    assert.equal(api.arrivalRuleMask("unread", false, true), 0x20);
    assert.equal(api.arrivalRuleMask("unread", false, false), 0);
    assert.equal(api.arrivalRuleMask("none", true, true), 0);
  });
});

describe("arrivalRules", () => {
  it("keeps the enabled rules of the mask, with what they send and their targets", () => {
    const list = makeFilterList([
      { name: "default type", type: 17, actions: [["forward", "a@b.test"]] },
      { name: "manual only", type: TYPES.Manual, actions: [["forward", "a@b.test"]] },
      { name: "disabled", enabled: false, actions: [["reply", "x"]] },
      { name: "after junk", type: TYPES.PostPlugin, actions: [["copy", OTHER_INBOX]] },
      { name: "outgoing", type: TYPES.PostOutgoing, actions: [["forward", "a@b.test"]] },
      { name: "custom", type: 1, actions: [["custom"]] },
    ]);
    assert.deepEqual(plain(api.arrivalRules(list, api.arrivalRuleMask("all", false, true))), [
      { index: 0, name: "default type", actions: ["forward"], targets: [] },
      { index: 3, name: "after junk", actions: [], targets: [OTHER_INBOX] },
      { index: 5, name: "custom", actions: ["custom"], targets: [] },
    ]);
    assert.deepEqual(plain(api.arrivalRules(list, TYPES.PostPlugin)).map((r) => r.index), [3]);
  });
  it("a rule that cannot be read counts as sending", () => {
    const rules = api.arrivalRules(makeFilterList([{ name: "x", broken: true, actions: [] }]), 0xffff);
    assert.match(rules[0].actions[0], /^unreadable/);
  });
});

describe("findArrivalResend", () => {
  const info = (rules, scope = "all") => ({ rules, scope });
  const send = { index: 2, name: "fwd", actions: ["forward"], targets: [] };
  const copyTo = (uri) => ({ index: 0, name: "copy", actions: [], targets: [uri] });

  it("finds a sending rule where the mail is put, with the scope", () => {
    const found = api.findArrivalResend("A", (uri) => (uri === "A" ? info([send], "unread") : null));
    assert.deepEqual(plain(found), { uri: "A", rule: send, via: [], scope: "unread" });
  });
  it("follows the move/copy rules to another folder", () => {
    const found = api.findArrivalResend("A", (uri) => ({ A: info([copyTo("B")]), B: info([send]) })[uri] || null);
    assert.equal(found.uri, "B");
    assert.deepEqual([...found.via], ["A"]);
  });
  it("returns null when nothing sends, and does not loop on a cycle", () => {
    assert.equal(api.findArrivalResend("A", (uri) => ({ A: info([copyTo("B")]), C: info([send]) })[uri] || null), null);
    assert.equal(api.findArrivalResend("A", (uri) => ({ A: info([copyTo("B")]), B: info([copyTo("A")]) })[uri]), null);
  });
  it("many sorting targets without rules do not count toward the limit", () => {
    const targets = Array.from({ length: 80 }, (_, i) => copyTo(`T${i}`));
    assert.equal(api.findArrivalResend("A", (uri) => (uri === "A" ? info(targets) : info([]))), null);
  });
  it("reports the limit of folders with rules, and filters that cannot be read, with the scope", () => {
    const tooMany = api.findArrivalResend("A", (uri) => info([copyTo(`${uri}x`)]));
    assert.equal(tooMany.tooMany, true);
    const thrown = api.findArrivalResend("A", () => { throw new Error("NS_ERROR_FILE_CORRUPTED"); });
    assert.match(thrown.unreadable, /CORRUPTED/);
    assert.equal(thrown.scope, undefined);
    const reported = api.findArrivalResend("A", () => ({ rules: [], unreadable: "NS_ERROR_FAILURE", scope: "all" }));
    assert.deepEqual(plain(reported), { uri: "A", via: [], unreadable: "NS_ERROR_FAILURE", scope: "all" });
  });

  it("the same server and mask is not checked twice (one filter list for every folder)", () => {
    let calls = 0;
    const found = api.findArrivalResend("A", () => {
      calls++;
      return { rules: [copyTo("B"), copyTo("C")], scope: "all", server: "s1", mask: 1 };
    });
    assert.equal(found, null);
    assert.equal(calls, 3, "each folder is described, but its rules are walked once per (server, mask)");
  });
});

describe("arrivalResendBlocks: only the case the lab measured is refused", () => {
  it("refuses the scope where the rules for new mail run, warns elsewhere", () => {
    assert.equal(api.arrivalResendBlocks({ scope: "all" }), true);
    assert.equal(api.arrivalResendBlocks({ scope: "all", unreadable: "x" }), true);
    assert.equal(api.arrivalResendBlocks({ scope: "unread" }), false);
    assert.equal(api.arrivalResendBlocks({ tooMany: true }), false, "no scope: not the measured case");
    assert.equal(api.arrivalResendBlocks(null), false);
  });
});

describe("describeArrivalResend", () => {
  const rule = (actions) => ({ index: 0, name: "To my phone", actions });
  it("names the setting, the rule, what it does and where the user acts", () => {
    const text = api.describeArrivalResend({ uri: IMAP_INBOX, via: [], rule: rule(["forward"]), scope: "all" },
      IMAP_INBOX, "Moving messages into");
    assert.ok(text.startsWith(`Moving messages into ${IMAP_INBOX} is refused, whatever the setting of "Filter rules that send mail"`));
    assert.match(text, /as on new mail, and rule #0 "To my phone" forwards: it would send those messages/);
    assert.match(text, /Tools > Message Filters/);
    assert.doesNotMatch(text, /mark the messages read/);
  });
  it("for the rules after classification, says unread and that marking read avoids it", () => {
    const text = api.describeArrivalResend({ uri: IMAP_SORTED, via: [], rule: rule(["reply"]), scope: "unread" },
      IMAP_SORTED, "Moving messages into");
    assert.match(text, /on unread mail put there \(rules run "after classification"\)/);
    assert.match(text, /replies: it would send/);
    assert.match(text, /mark the messages read first/);
  });
  it("an add-on action 'would run on' the messages", () => {
    assert.match(api.describeArrivalResend({ uri: "A", via: [], rule: rule(["custom"]), scope: "all" }, "A", "X"),
      /runs an add-on action: it would run on those messages/);
  });

  it("the warning form says what may happen, not that the request is refused", () => {
    const text = api.describeArrivalResend({ uri: IMAP_SORTED, via: [], rule: rule(["forward"]), scope: "unread" },
      IMAP_SORTED, "Moving messages into", () => true, { blocked: false });
    assert.ok(!text.includes("refused"), text);
    assert.match(text, /^Moving messages into imap:\/\/me@imap\.example\.test\/Sorted: Thunderbird runs filters on unread mail/);
    assert.match(text, /so it may send those messages by itself/);
    assert.match(text, /turn that rule off in Thunderbird \(Tools > Message Filters\) if that is not wanted/);
    assert.doesNotMatch(text, /mark the messages read/);
  });
  it("does not name a folder or rule of an account MCP cannot access", () => {
    const text = api.describeArrivalResend({ uri: OTHER_INBOX, via: [IMAP_INBOX], rule: rule(["forward"]), scope: "all" },
      IMAP_INBOX, "Moving messages into", (uri) => !uri.startsWith(OTHER));
    assert.ok(!text.includes(OTHER), text);
    assert.ok(!text.includes("To my phone"), text);
    assert.match(text, /in a folder of an account MCP cannot access, where the filter rules of imap:\/\/me@imap\.example\.test\/INBOX move or copy it/);
    assert.match(text, /one of its rules forwards/);
  });
  it("the fail-closed refusals say where to look too", () => {
    for (const found of [{ uri: "A", via: [], tooMany: true }, { uri: "A", via: [], unreadable: "x" }]) {
      assert.match(api.describeArrivalResend(found, "A", "Moving messages into"), /Tools > Message Filters/);
    }
  });
});

// ── The real handler code ──

describe("updateMessage: no move into a folder where a filter rule would send the messages", () => {
  it("refuses a move into an IMAP Inbox whose account forwards new mail, even a read message, and changes nothing", () => {
    const { h, calls, mutations } = loadHandlers(world(), { hdrs: [READ] });
    const result = move(h, IMAP_INBOX, { read: true });
    assert.match(result.error, /is refused, whatever the setting/);
    assert.match(result.error, /"To my phone" forwards/);
    assert.deepEqual(calls, []);
    assert.deepEqual(mutations, [], "a refused move changes no read, flag or tag either");
  });

  it("refuses it when a rule copies the mail to another account's Inbox that forwards it", () => {
    const { h, calls } = loadHandlers(world({ imapRules: [{ name: "Copy to the shared box", actions: [["copy", OTHER_INBOX]] }],
      otherRules: [{ name: "Forward all", actions: [["forward", "boss@example.test"]] }] }), { hdrs: [READ] });
    const result = move(h, IMAP_INBOX);
    assert.match(result.error, /"Forward all" forwards/);
    assert.ok(result.error.includes(OTHER_INBOX));
    assert.deepEqual(calls, []);
  });

  it("follows an account MCP cannot access, without naming it", () => {
    const { h, calls } = loadHandlers(world({ imapRules: [{ name: "Copy", actions: [["copy", OTHER_INBOX]] }],
      otherRules: [{ name: "Secret rule", actions: [["forward", "x@example.test"]] }] }), { hdrs: [READ], restricted: [OTHER] });
    const result = move(h, IMAP_INBOX);
    assert.match(result.error, /a folder of an account MCP cannot access/);
    assert.ok(!result.error.includes(OTHER) && !result.error.includes("Secret rule"), result.error);
    assert.deepEqual(calls, []);
  });

  it("a rule after classification: moves unread mail to an ordinary folder and warns; read mail moves without a warning", () => {
    const options = { imapRules: [{ ...FORWARD_RULE, type: TYPES.PostPlugin }] };
    const t = loadHandlers(world(options), { hdrs: [UNREAD] });
    const warned = move(t.h, IMAP_SORTED);
    assert.ok(warned.success, JSON.stringify(warned));
    assert.match(warned.warning, /on unread mail put there \(rules run "after classification"\)/);
    assert.match(warned.warning, /"To my phone" forwards, so it may send those messages by itself/);
    assert.deepEqual(t.calls, [["copyMessages", IMAP_SORTED]]);
    const r = loadHandlers(world(options), { hdrs: [READ] });
    const quiet = move(r.h, IMAP_SORTED);
    assert.ok(quiet.success && !quiet.warning, JSON.stringify(quiet));
    assert.match(move(r.h, IMAP_SORTED, { read: false }).warning, /after classification/, "marked unread first: warned");
  });

  it("a move to the Trash warns too", () => {
    const { h, calls } = loadHandlers(world({ imapRules: [{ ...FORWARD_RULE, type: TYPES.PostPlugin }] }), { hdrs: [UNREAD] });
    const r = move(h, undefined, { trash: true });
    assert.ok(r.success, JSON.stringify(r));
    assert.match(r.warning, /after classification/);
    assert.deepEqual(calls, [["copyMessages", IMAP_TRASH]]);
  });

  it("the warning joins the one about tags", () => {
    const { h } = loadHandlers(world({ imapRules: [{ ...FORWARD_RULE, type: TYPES.PostPlugin }] }), { hdrs: [UNREAD] });
    const r = h.updateMessage("old@example.test", undefined, IMAP_ARCHIVE, undefined, undefined, ["$label1"], undefined,
      IMAP_SORTED, undefined);
    assert.match(r.warning, /^Tags were applied before move;/);
    assert.match(r.warning, /after classification/);
  });

  it("the same account checked under another scope is checked again: an ordinary folder filing into its own Inbox", () => {
    // The rule after classification copies to the Inbox, where the forward rule for new mail waits: refused,
    // although the account was already checked under the mask of an ordinary folder.
    const { h, calls } = loadHandlers(world({ imapRules: [
      { name: "Copy to Inbox", type: TYPES.PostPlugin, actions: [["copy", IMAP_INBOX]] },
      FORWARD_RULE,
    ] }), { hdrs: [UNREAD] });
    const result = move(h, IMAP_SORTED);
    assert.match(result.error, /is refused/);
    assert.match(result.error, /"To my phone" forwards/);
    assert.deepEqual(calls, []);
  });

  it("a periodic rule runs on the Inbox: moving there is refused", () => {
    const { h, calls } = loadHandlers(world({ imapRules: [{ ...FORWARD_RULE, type: TYPES.Periodic }] }), { hdrs: [READ] });
    assert.match(move(h, IMAP_INBOX).error, /"To my phone" forwards/);
    assert.ok(!move(h, IMAP_SORTED).error);
    assert.deepEqual(calls, [["copyMessages", IMAP_SORTED]]);
  });

  it("refuses a move into an IMAP folder with applyIncomingFilters, and into a Trash that inherits it", () => {
    const { h, calls } = loadHandlers(world({ trashProp: "true", sortedProp: "true" }), { hdrs: [READ] });
    assert.match(move(h, IMAP_SORTED).error, /refused/);
    assert.match(move(h, undefined, { trash: true }).error, /refused/);
    assert.deepEqual(calls, []);
  });

  it("refuses when the filters of such a folder cannot be read (fail closed), warns elsewhere", () => {
    const { h, calls } = loadHandlers(world({ imapBroken: true }), { hdrs: [READ] });
    assert.match(move(h, IMAP_INBOX).error, /cannot be read \(NS_ERROR_FILE_CORRUPTED\)/);
    assert.deepEqual(calls, []);
    const t = loadHandlers(world({ imapBroken: true }), { hdrs: [UNREAD] });
    const warned = move(t.h, IMAP_SORTED);
    assert.ok(warned.success, JSON.stringify(warned));
    assert.match(warned.warning, /cannot be read \(NS_ERROR_FILE_CORRUPTED\)/);
  });

  const sorting = Array.from({ length: 60 }, (_, i) => ({ name: `sort ${i}`, actions: [["move", `${IMAP}/S${i}`]] }));
  const sortingFolders = Object.fromEntries(sorting.map((_, i) => [`${IMAP}/S${i}`, { server: "imap", parent: IMAP }]));
  for (const [label, options, to, hdr] of [
    ["the forwarding rule is disabled", { imapRules: [{ ...FORWARD_RULE, enabled: false }] }, IMAP_INBOX, UNREAD],
    ["the forwarding rule runs only by hand", { imapRules: [{ ...FORWARD_RULE, type: TYPES.Manual }] }, IMAP_INBOX, UNREAD],
    ["the rule only marks mail read", { imapRules: [{ name: "read", actions: [["read"]] }] }, IMAP_INBOX, UNREAD],
    ["an Inbox rule forwards (it does not run elsewhere), the target is an ordinary IMAP folder", {}, IMAP_SORTED, UNREAD],
    ["the target is the Inbox of Local Folders", { localRules: [FORWARD_RULE] }, LOCAL_INBOX, UNREAD],
    ["a rule after classification on Local Folders, unread mail", { localRules: [{ ...FORWARD_RULE, type: TYPES.PostPlugin }] },
      LOCAL_ARCHIVE, UNREAD],
    ["60 sorting rules and no rule that sends", { imapRules: sorting, extraFolders: sortingFolders }, IMAP_INBOX, UNREAD],
  ]) {
    it(`moves without a word when ${label}`, () => {
      const { h, calls } = loadHandlers(world(options), { hdrs: [hdr] });
      const result = move(h, to);
      assert.ok(result.success && !result.warning, JSON.stringify(result));
      assert.deepEqual(calls, [["copyMessages", to]]);
    });
  }
});

describe("deleteMessages: no move to a Trash where a filter rule would send the messages", () => {
  for (const drafts of [false, true]) {
    const what = drafts ? "a draft" : "a message";
    it(`${what}: refused into a Trash that inherits applyIncomingFilters, deleted otherwise`, () => {
      const w = world({ trashProp: "true" });
      if (drafts) w.get(IMAP_ARCHIVE).flags |= FLAGS.Drafts;
      const refused = loadHandlers(w, { hdrs: [READ] });
      assert.match(refused.h.deleteMessages(["old@example.test"], IMAP_ARCHIVE).error, /^Moving messages into .*Trash is refused/);
      assert.deepEqual(refused.calls, []);
      const w2 = world();
      if (drafts) w2.get(IMAP_ARCHIVE).flags |= FLAGS.Drafts;
      const allowed = loadHandlers(w2, { hdrs: [READ] });
      assert.ok(allowed.h.deleteMessages(["old@example.test"], IMAP_ARCHIVE).success);
      assert.deepEqual(allowed.calls, [drafts ? ["copyMessages", IMAP_TRASH] : ["deleteMessages", IMAP_ARCHIVE]]);
    });
  }
  it("a rule after classification: unread mail is deleted with a warning, read mail without one", () => {
    const options = { imapRules: [{ ...FORWARD_RULE, type: TYPES.PostPlugin }], trashProp: "" };
    const t = loadHandlers(world(options), { hdrs: [UNREAD] });
    const warned = t.h.deleteMessages(["old@example.test"], IMAP_ARCHIVE);
    assert.ok(warned.success, JSON.stringify(warned));
    assert.match(warned.warning, /after classification/);
    assert.deepEqual(t.calls, [["deleteMessages", IMAP_ARCHIVE]]);
    const r = loadHandlers(world(options), { hdrs: [READ] });
    const quiet = r.h.deleteMessages(["old@example.test"], IMAP_ARCHIVE);
    assert.ok(quiet.success && !quiet.warning, JSON.stringify(quiet));
  });
});

describe("folders: a folder moved, renamed or deleted is a new folder for Thunderbird", () => {
  it("moveFolder and deleteFolder are refused where the folder would inherit applyIncomingFilters", () => {
    const w = world({ archiveProp: "true" });
    const { h, calls } = loadHandlers(w);
    assert.match(h.moveFolder(IMAP_SORTED, IMAP_ARCHIVE).error, /^Moving a folder into .*Archive is refused/);
    const w2 = world({ trashProp: "true" });
    const t2 = loadHandlers(w2);
    assert.match(t2.h.deleteFolder(IMAP_SORTED).error, /^Moving a folder into .*Trash is refused/);
    assert.deepEqual([...calls, ...t2.calls], []);
  });

  it("a rule after classification: done with a warning while the folder holds unread mail, quietly once it is all read", () => {
    const options = { imapRules: [{ ...FORWARD_RULE, type: TYPES.PostPlugin }] };
    const w = world(options);
    const { h, calls } = loadHandlers(w);
    const renamed = h.renameFolder(IMAP_SORTED, "Sorted 2026");
    assert.ok(renamed.success, JSON.stringify(renamed));
    assert.match(renamed.warning, /^Renaming a folder in .*: Thunderbird runs filters on unread mail/);
    assert.match(h.moveFolder(IMAP_SORTED, IMAP_ARCHIVE).warning, /after classification/);
    assert.match(h.deleteFolder(IMAP_SORTED).warning, /after classification/);
    assert.equal(calls.length, 3);
    w.get(IMAP_SORTED).unread = 0;
    assert.ok(!h.renameFolder(IMAP_SORTED, "Sorted 2026").warning);
    assert.ok(!h.moveFolder(IMAP_SORTED, IMAP_ARCHIVE).warning);
    assert.ok(!h.deleteFolder(IMAP_SORTED).warning);
    assert.equal(calls.length, 6);
  });

  it("renameFolder: the folder's own applyIncomingFilters counts; a subfolder of the Inbox is not the Inbox", () => {
    const w = world({ sortedProp: "true" });
    w.get(IMAP_SORTED).unread = 0;
    const { h, calls } = loadHandlers(w);
    assert.match(h.renameFolder(IMAP_SORTED, "x").error, /"To my phone" forwards/);
    assert.match(h.renameFolder(IMAP_SORTED, "x").error, /keep its name/);
    const w2 = world({ extraFolders: { [`${IMAP_INBOX}/Sub`]: { server: "imap", parent: IMAP_INBOX, unread: 0 } } });
    const t2 = loadHandlers(w2);
    assert.ok(t2.h.renameFolder(`${IMAP_INBOX}/Sub`, "Sub2").success);
    assert.ok(t2.h.moveFolder(IMAP_SORTED, IMAP_INBOX).success, "an Inbox rule does not run in a subfolder");
    assert.deepEqual(calls, []);
  });

  it("local folders are moved, renamed and deleted with any rule", () => {
    const w = world({ localRules: [{ ...FORWARD_RULE, type: 17 | TYPES.PostPlugin }] });
    const { h } = loadHandlers(w);
    assert.ok(h.renameFolder(LOCAL_ARCHIVE, "Archive 2").success);
  });
});

describe("drafts: refused where the rules for new mail run, warned where they run after classification", () => {
  const identity = (draftsFolderURI) => ({ key: "id-imap", draftsFolderURI });
  it("refused when the Drafts folder is the Inbox; nothing to say for an IMAP Drafts folder with only Inbox rules", () => {
    const { h } = loadHandlers(world());
    assert.match(h.draftArrivalCheck(identity(IMAP_INBOX)).error, /^Saving a draft into .*INBOX is refused/);
    assert.equal(h.draftArrivalCheck(identity(IMAP_DRAFTS)), null);
  });
  it("a rule after classification runs on a draft (it counts as unread): saved, with a warning about the draft", () => {
    const { h } = loadHandlers(world({ imapRules: [{ ...FORWARD_RULE, type: TYPES.PostPlugin }] }));
    const { warning, error } = h.draftArrivalCheck(identity(IMAP_DRAFTS));
    assert.ok(!error && warning, warning);
    assert.match(warning, /after classification/);
    assert.match(warning, /may send the draft by itself/);
    assert.doesNotMatch(warning, /mark the messages read/);
  });
  it("a Drafts folder not created yet is checked as a new folder of the server its address names", () => {
    const { h } = loadHandlers(world({ imapRules: [{ ...FORWARD_RULE, type: TYPES.PostPlugin }] }));
    assert.match(h.draftArrivalCheck(identity(`${IMAP}/NotYet`)).warning, /^Saving a draft into imap:\/\/me@imap\.example\.test:/);
    const t = loadHandlers(world());
    assert.equal(t.h.draftArrivalCheck(identity(`${IMAP}/NotYet`)), null);
  });
  it("an address on no known server is saved with a warning that nothing was checked", () => {
    const { h } = loadHandlers(world());
    assert.match(h.draftArrivalCheck(identity("imap://elsewhere/Drafts")).warning,
      /cannot be found, so the filter rules Thunderbird may run on the draft .* were not checked/);
  });
  it("the warning reaches the result of the save, and a refusal saves nothing", async () => {
    const { h, calls } = loadHandlers(world({ imapRules: [{ ...FORWARD_RULE, type: TYPES.PostPlugin }] }));
    const saved = await h.saveComposeFieldsAsDraft({ deliveryFormat: -1, addAttachment: () => {} },
      identity(IMAP_DRAFTS), [], false);
    assert.ok(saved.success, JSON.stringify(saved));
    assert.match(saved.warning, /after classification/);
    assert.deepEqual(calls, [["composeDraftSave"]]);
    const refused = await h.saveComposeFieldsAsDraft({ deliveryFormat: -1, addAttachment: () => {} },
      identity(IMAP_INBOX), [], false);
    assert.match(refused.error, /^Saving a draft into .*INBOX is refused/);
    assert.deepEqual(calls, [["composeDraftSave"]], "nothing more was saved");
  });

  it("Local Folders drafts are saved without a word, whatever the rules", () => {
    const { h } = loadHandlers(world({ localRules: [{ ...FORWARD_RULE, type: 17 | TYPES.PostPlugin }],
      imapRules: [{ ...FORWARD_RULE, type: 17 | TYPES.PostPlugin }],
      extraFolders: { [`${LOCAL}/Drafts`]: { server: "local", flags: FLAGS.Drafts, parent: LOCAL } } }));
    assert.equal(h.draftArrivalCheck(identity(`${LOCAL}/Drafts`)), null);
  });
});

describe("filter rules: no move/copy target where a filter rule would send the messages", () => {
  it("a new target is refused with the reason; an ordinary one is accepted", () => {
    const { h } = loadHandlers(world());
    const refused = h.resolveFilterTargetFolder(IMAP_INBOX);
    assert.match(refused.error, /^A filter rule moving or copying mail into .* forwards/);
    assert.equal(refused.refused, true);
    assert.equal(h.resolveFilterTargetFolder(LOCAL_ARCHIVE).folder.URI, LOCAL_ARCHIVE);
  });

  it("filed by a rule, the mail counts as unread: a target where a rule after classification sends is kept, with a warning", () => {
    const { h } = loadHandlers(world({ imapRules: [{ ...FORWARD_RULE, type: TYPES.PostPlugin }] }));
    const target = h.resolveFilterTargetFolder(IMAP_SORTED);
    assert.equal(target.folder.URI, IMAP_SORTED);
    assert.match(target.warning, /after classification/);
    assert.match(target.warning, /may send the mail it files there by itself/);
    const warnings = [];
    const filter = { createAction: () => ({}), appendAction: () => {} };
    h.buildRuleActions(filter, [{ type: "copyToFolder", value: IMAP_SORTED }], h.resolveFilterTargetFolder, { warnings });
    assert.equal(warnings.length, 1);
    assert.equal(h.checkExistingFilterTarget(IMAP_SORTED, warnings), true);
    assert.equal(warnings.length, 2);
  });

  it("createFilter and updateFilter give that reason (buildRuleActions), not \"not accessible\"", () => {
    const { h } = loadHandlers(world());
    const appended = [];
    const filter = { createAction: () => ({}), appendAction: (a) => appended.push(a) };
    assert.throws(() => h.buildRuleActions(filter, [{ type: "copyToFolder", value: IMAP_INBOX }], h.resolveFilterTargetFolder),
      /^Error: A filter rule moving or copying mail into .* "To my phone" forwards/);
    assert.throws(() => h.buildRuleActions(filter, [{ type: "moveToFolder", value: "imap://nowhere/INBOX" }], h.resolveFilterTargetFolder),
      /Filter target folder not accessible/);
    h.buildRuleActions(filter, [{ type: "moveToFolder", value: LOCAL_ARCHIVE }], h.resolveFilterTargetFolder);
    assert.equal(appended.length, 1);
  });

  it("a kept target is refused, and applyFilters skips a rule that copies there", () => {
    const { h } = loadHandlers(world());
    assert.equal(h.checkExistingFilterTarget(IMAP_INBOX), h.FILTER_TARGET_RESENDS);
    assert.match(h.FILTER_TARGET_RESENDS, /Tools > Message Filters/);
    assert.doesNotMatch(h.resolveFilterTargetFolder(IMAP_INBOX).error, /mark the messages read/);
    assert.equal(h.checkExistingFilterTarget(LOCAL_ARCHIVE), true);
    const list = makeFilterList([
      { name: "benign copy", type: 17, actions: [["copy", IMAP_INBOX]] },
      { name: "archive", type: 17, actions: [["move", LOCAL_ARCHIVE]] },
    ]);
    const { run, skipped } = h.selectManualRunFilters(list, h.FILTER_TYPE_MANUAL, h.checkExistingFilterTarget);
    assert.deepEqual([...run].map((r) => r.index), [1]);
    assert.deepEqual(plain(skipped), [{ index: 0, name: "benign copy", reason: h.FILTER_TARGET_RESENDS }]);
  });
});

describe("wiring: every way MCP puts mail into a folder is checked first", () => {
  const body = (name, indent) => functionSource(name, indent);
  it("each copy, move, delete into the Trash, rename and draft save is preceded by its own check", () => {
    for (const [name, pattern, indent, reach = 700] of [
      // The destination (moveTo or the Trash) is checked before any change, the copy comes last.
      ["updateMessage", /MailServices\.copy\.copyMessages\(/g, "", Infinity],
      ["deleteMessages", /MailServices\.copy\.copyMessages\(|folder\.deleteMessages\(found, null, false, true/g],
      ["deleteFolder", /MailServices\.copy\.copyFolder\(/g],
      ["moveFolder", /MailServices\.copy\.copyFolder\(/g],
      ["renameFolder", /folder\.rename\(/g],
      ["saveComposeFieldsAsDraft", /composeDraftSave\(|saveDraftViaSend\(/g, "async ", Infinity],
    ]) {
      const src = body(name, indent || "");
      const sites = [...src.matchAll(pattern)];
      assert.ok(sites.length > 0, name);
      for (const site of sites) {
        const before = src.slice(Math.max(0, site.index - reach), site.index);
        assert.ok(/arrivalResendCheck\(|draftArrivalCheck\(/.test(before), `${name}: a site without its own arrival check`);
      }
    }
  });
  it("no other copy of messages or folders in api.js", () => {
    const all = [...apiSource.matchAll(/MailServices\.copy\.copy\w*\(/g)].length;
    const checked = ["updateMessage", "deleteMessages", "deleteFolder", "moveFolder"]
      .reduce((n, name) => n + [...body(name).matchAll(/MailServices\.copy\.copy\w*\(/g)].length, 0);
    assert.equal(all, checked);
  });
});
