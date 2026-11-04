// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";

// What the user reads before a filter rule that sends mail is written, and the store that keeps one confirmation
// pending at a time. The real helpers of api.js (FILTER CONFIRMATION HELPERS) run against stand-ins for XPCOM; the
// edge cases here are the odd inputs: missing fields, unknown codes, too much text, hooks that fail.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const apiSource = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");

function block(begin, end) {
  const start = apiSource.indexOf(begin);
  const stop = apiSource.indexOf(end, start);
  assert.ok(start >= 0 && stop > start, `marker missing: ${begin}`);
  return apiSource.slice(start, stop);
}

const HELPERS = [
  block("// BEGIN UNTRUSTED CONTENT HELPERS", "// END UNTRUSTED CONTENT HELPERS"),
  block("// BEGIN FOLDER NAME HELPERS", "// END FOLDER NAME HELPERS"),
  block("// BEGIN FILTER SEARCH TERM HELPERS", "// END FILTER SEARCH TERM HELPERS"),
  block("// BEGIN FILTER RULE HELPERS", "// END FILTER RULE HELPERS"),
  block("// BEGIN FILTER CONFIRMATION HELPERS", "// END FILTER CONFIRMATION HELPERS"),
].join("\n");

const ATTRIB = {
  Custom: -2, Default: -1, Subject: 0, Sender: 1, Body: 2, Date: 3, Priority: 4, MsgStatus: 5,
  To: 6, CC: 7, ToOrCC: 8, AllAddresses: 9, Location: 10, MessageKey: 11, AgeInDays: 12, FolderInfo: 13,
  Size: 14, AnyText: 15, Keywords: 16, HasAttachmentStatus: 44, JunkStatus: 45, JunkPercent: 46,
  JunkScoreOrigin: 47, HdrProperty: 49, FolderFlag: 50, Uint32HdrProperty: 51, OtherHeader: 52,
};
const ACTIONS = {
  Custom: -1, None: 0, MoveToFolder: 1, ChangePriority: 2, Delete: 3, MarkRead: 4, KillThread: 5, WatchThread: 6,
  MarkFlagged: 7, Reply: 9, Forward: 10, StopExecution: 11, DeleteFromPop3Server: 12, LeaveOnPop3Server: 13,
  JunkScore: 14, FetchBodyFromPop3Server: 15, CopyToFolder: 16, AddTag: 17, KillSubthread: 18, MarkUnread: 19,
};
const OPS = {
  Contains: 0, DoesntContain: 1, Is: 2, Isnt: 3, IsEmpty: 4, IsBefore: 5, IsAfter: 6, IsHigherThan: 7, IsLowerThan: 8,
  BeginsWith: 9, EndsWith: 10, SoundsLike: 11, LdapDwim: 12, IsGreaterThan: 13, IsLessThan: 14, NameCompletion: 15,
  IsInAB: 16, IsntInAB: 17, IsntEmpty: 18, Matches: 19, DoesntMatch: 20,
};

function nonEnumerable(constants) {
  return new Proxy({}, {
    get: (_t, name) => constants[name],
    has: (_t, name) => name in constants,
    ownKeys: () => [],
    getOwnPropertyDescriptor: () => undefined,
  });
}

const plain = (value) => JSON.parse(JSON.stringify(value));

function fullCi() {
  return {
    nsMsgSearchAttrib: nonEnumerable(ATTRIB),
    nsMsgSearchOp: nonEnumerable(OPS),
    nsMsgFilterAction: nonEnumerable(ACTIONS),
    nsMsgFilterType: nonEnumerable({ InboxRule: 1, InboxJavaScript: 2, NewsRule: 4, NewsJavaScript: 8, Manual: 0x10, PostPlugin: 0x20, PostOutgoing: 0x40, Archive: 0x80, Periodic: 0x100 }),
    nsMsgMessageFlags: { Attachment: 0x10000000 },
  };
}

function load(ci = fullCi()) {
  const sandbox = { Ci: ci, Services: { prefs: { getCharPref: (_n, d) => d } } };
  vm.createContext(sandbox);
  vm.runInContext(`${HELPERS}
this.api = { createFilterConfirmationStore, decideSendRuleChange, resolveFilterConfirmTtlMs, describeConfirmationRefusal,
  displayFilterText, describeFilterType, describeFilterTerm, describeFilterAction, describeSendTargets,
  describeFilterRuleLines, describeSendingRuleLine, buildFilterConfirmationDialog, summarizeFilterConfirmation,
  fingerprintFilterList, layoutFilterTerms };`, sandbox);
  return sandbox.api;
}

const api = load();

describe("pending confirmations: the store", () => {
  const makeStore = (options = {}) => {
    let time = 1_000_000;
    let n = 0;
    const settled = [];
    const store = api.createFilterConfirmationStore({
      now: () => time,
      newId: () => `fc-${++n}`,
      onSettle: (entry) => settled.push(entry.id),
      ...options,
    });
    return { store, settled, advance: (ms) => { time += ms; } };
  };

  it("cannot be created without a way to make confirmation ids", () => {
    assert.throws(() => api.createFilterConfirmationStore(), /needs newId\(\)/);
    assert.throws(() => api.createFilterConfirmationStore({ newId: "fc-1" }), /needs newId\(\)/);
  });

  it("refuses an id that is not text, is empty or is already used, and opens nothing", () => {
    for (const id of [42, "", null]) {
      const { store } = makeStore({ newId: () => id });
      assert.throws(() => store.open({ operation: "create", accountId: "a", ttlMs: 1000 }), /confirmation id collision/, String(id));
    }
    const { store } = makeStore({ newId: () => "same" });
    store.open({ operation: "create", accountId: "a", ttlMs: 1000 });
    store.settle("same", "refused");
    assert.throws(() => store.open({ operation: "create", accountId: "a", ttlMs: 1000 }), /confirmation id collision/);
  });

  it("get answers only for a text id, and isLive only for a pending entry that has not run out", () => {
    const { store, advance } = makeStore();
    const { entry } = store.open({ operation: "create", accountId: "a", ttlMs: 5000 });
    assert.equal(store.get(entry.id), entry);
    assert.equal(store.get(42), undefined);
    assert.equal(store.get(undefined), undefined);
    assert.equal(store.get("nope"), undefined);
    assert.equal(store.isLive(entry), true);
    assert.equal(store.isLive(null), false);
    assert.equal(store.isLive(undefined), false);
    advance(5000);
    assert.equal(store.isLive(entry), false, "at its expiry time it is no longer live");
    store.settle(entry.id, "accepted");
    assert.equal(store.isLive(entry), false, "a settled entry is never live");
  });

  it("settling an unknown id or an entry that is already settled does nothing", () => {
    const { store, settled } = makeStore();
    assert.equal(store.settle("missing", "refused"), null);
    const { entry } = store.open({ operation: "update", accountId: "a", ttlMs: 1000 });
    assert.equal(store.settle(entry.id, "accepted").status, "accepted");
    assert.equal(store.settle(entry.id, "refused"), null, "the first answer stands");
    assert.equal(entry.status, "accepted");
    assert.deepEqual(settled, [entry.id], "onSettle ran once");
    assert.throws(() => store.settle(entry.id, "pending"), /invalid confirmation status: pending/);
  });

  it("a cleanup hook that fails is noted on the entry and does not stop the others or the answer", () => {
    const { store, settled } = makeStore();
    const { entry } = store.open({ operation: "delete", accountId: "a", ttlMs: 1000 });
    const ran = [];
    entry.hooks.push(() => { throw new Error("hook broke"); }, () => ran.push("second"));
    const result = store.settle(entry.id, "failed", { reason: "x" });
    assert.equal(result.status, "failed");
    assert.equal(result.hookError, "hook broke");
    assert.deepEqual(ran, ["second"]);
    assert.deepEqual(settled, [entry.id]);
  });

  it("an onSettle callback that fails is noted on the entry as well", () => {
    const { store } = makeStore({ onSettle: () => { throw new Error("journal full"); } });
    const { entry } = store.open({ operation: "delete", accountId: "a", ttlMs: 1000 });
    assert.equal(store.settle(entry.id, "refused").hookError, "journal full");
  });

  it("keeps only the most recent settled confirmations", () => {
    const { store } = makeStore({ historyMax: 3 });
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const { entry } = store.open({ operation: "create", accountId: "a", ttlMs: 1000 });
      store.settle(entry.id, "refused");
      ids.push(entry.id);
    }
    assert.deepEqual(plain(store.recent(10).map((v) => v.confirmationId)), ids.slice(2).reverse());
  });

  it("expires what ran out, with the reason, and a shutdown expires what is pending with its own reason", () => {
    const { store, advance } = makeStore({ maxPerHour: 10 });
    const { entry } = store.open({ operation: "create", accountId: "a", ttlMs: 1000 });
    advance(1000);
    const view = store.view(entry.id);
    assert.equal(view.status, "expired");
    assert.equal(view.reason, "no answer in time; nothing was written");
    const second = store.open({ operation: "apply", accountId: "a", ttlMs: 60000 }).entry;
    const ended = store.shutdown("extension disabled");
    assert.equal(ended.length, 1);
    assert.equal(second.reason, "extension disabled");
    assert.equal(store.pending(), null);
    assert.equal(store.view("unknown"), null);
  });

  it("limits the dialogs to one pending at a time and a number per hour, and says when the next one may open", () => {
    const { store, advance } = makeStore({ maxPerHour: 2 });
    const first = store.open({ operation: "create", accountId: "a", ttlMs: 600000 }).entry;
    const blocked = store.open({ operation: "create", accountId: "a", ttlMs: 600000 });
    assert.equal(blocked.error.code, "pending");
    assert.equal(blocked.error.pending.confirmationId, first.id);
    store.settle(first.id, "refused");
    const second = store.open({ operation: "create", accountId: "a", ttlMs: 600000 }).entry;
    store.settle(second.id, "refused");
    const rate = store.open({ operation: "create", accountId: "a", ttlMs: 600000 });
    assert.equal(rate.error.code, "rate");
    assert.equal(rate.error.used, 2);
    assert.equal(store.usage().nextSlotAt, rate.error.retryAt);
    advance(60 * 60 * 1000);
    assert.equal(store.admit().ok, true, "an hour later the slots are free again");
    assert.equal(store.usage().nextSlotAt, null);
  });

  it("the time to answer keeps its default when the preference is an integer that is not whole", () => {
    const prefs = { type: () => "int", int: () => 1.5 };
    assert.equal(api.resolveFilterConfirmTtlMs(prefs), 600000);
  });
});

describe("decideSendRuleChange: odd inputs", () => {
  const D = (x) => api.decideSendRuleChange(x);
  const rule = (actions, index = 0) => ({ index, name: `r${index}`, enabled: true, actions });

  it("refuses an operation it does not know and a call without arguments", () => {
    assert.deepEqual(plain(D({ operation: "rename" })), { verdict: "refuse", reason: "Unknown filter operation: rename" });
    assert.equal(D().verdict, "refuse");
  });

  it("takes a result with no action kinds as a rule that does not send, and a missing type as 0", () => {
    assert.equal(D({ operation: "create", listRules: [], result: { type: 17 } }).verdict, "allow");
    const withSend = D({ operation: "create", listRules: [], result: { kinds: ["forward"] } });
    assert.equal(withSend.verdict, "confirm", "a missing type is not outgoing mail");
    assert.equal(D({ operation: "create", listRules: [], result: { kinds: ["forward"], type: "abc" } }).verdict, "confirm");
  });

  it("does not care about the actions of a listed rule when it has none to show", () => {
    const d = D({ operation: "reorder", listRules: [{ index: 0, name: "r0", enabled: true }] });
    assert.equal(d.verdict, "confirm");
    assert.equal(d.context.length, 1);
  });

  it("refuses a list that holds a rule with an action it cannot read, and one with too many sending rules", () => {
    assert.match(D({ operation: "reorder", listRules: [rule(["unreadable (boom)"])] }).reason, /cannot read/);
    const many = Array.from({ length: 11 }, (_, i) => rule(["forward"], i));
    assert.match(D({ operation: "reorder", listRules: many }).reason, /holds 11 rules that send mail/);
  });

  it("a result with an add-on action sends, and an unreadable one is refused", () => {
    assert.equal(D({ operation: "create", listRules: [], result: { kinds: ["custom"], type: 17 } }).resultSends, true);
    assert.equal(D({ operation: "update", listRules: [], result: { kinds: ["unreadable (x)"], type: 17 } }).verdict, "refuse");
  });
});

describe("describeConfirmationRefusal", () => {
  it("names the pending confirmation when it is known, and copes with a missing description of it", () => {
    const text = api.describeConfirmationRefusal({ code: "pending", pending: { confirmationId: "fc-1", operation: "create", expiresAt: "2026-11-04T12:00:00.000Z" } });
    assert.match(text, /\(fc-1, create, expires 2026-11-04T12:00:00\.000Z\)/);
    assert.match(api.describeConfirmationRefusal({ code: "pending" }), /\(undefined, undefined, expires undefined\)/);
  });

  it("states the count and the next time for the hourly limit, and falls back to a plain refusal for any other code", () => {
    assert.match(api.describeConfirmationRefusal({ code: "rate", used: 5, retryAt: "2026-11-04T13:00:00.000Z" }), /5 dialogs in the last hour \(limit 5\).*next possible at 2026-11-04T13:00:00\.000Z/);
    assert.equal(api.describeConfirmationRefusal({ code: "something else" }), "Filter confirmation refused");
  });
});

describe("text shown in the dialog", () => {
  it("shows nothing for a missing value and the text of anything else", () => {
    assert.equal(api.displayFilterText(null), "");
    assert.equal(api.displayFilterText(undefined), "");
    assert.equal(api.displayFilterText(0), "0");
    assert.equal(api.displayFilterText(false), "false");
  });

  it("describes the types a rule runs on, names the bits it does not know and says when there are none", () => {
    assert.equal(api.describeFilterType(undefined), "never (type 0)");
    assert.equal(api.describeFilterType("junk"), "never (type 0)");
    assert.equal(api.describeFilterType(0x11), "new mail (before junk classification), manual run");
    assert.equal(api.describeFilterType(0x240), "OUTGOING mail, after sending, unknown bits 0x200");
    assert.equal(api.describeFilterType(0x200), "unknown bits 0x200");
  });

  it("uses the bits it knows by heart when this Thunderbird names none", () => {
    const old = load({});
    assert.equal(old.describeFilterType(0x41), "new mail (before junk classification), OUTGOING mail, after sending");
    assert.equal(old.describeFilterType(0x400), "unknown bits 0x400");
  });

  it("describes a condition on every message, an add-on condition, a header property and a header", () => {
    assert.equal(api.describeFilterTerm({ matchAll: true }), "every message (no condition)");
    assert.equal(api.describeFilterTerm({ attrib: "custom", customId: "addon@x", op: "is", value: "v" }), "add-on condition “addon@x” is “v”");
    assert.equal(api.describeFilterTerm({ attrib: "hdrProperty", hdrProperty: "X-Prop", op: "contains", value: "v" }), "message property “X-Prop” contains “v”");
    assert.equal(api.describeFilterTerm({ attrib: "otherHeader", header: "X-List", op: "contains", value: "v" }), "otherHeader “X-List” contains “v”");
  });

  it("names an operator it has no label for, and says what could not be read or has no value", () => {
    assert.equal(api.describeFilterTerm({ attrib: "subject", op: "weirdOp", value: "x" }), "subject weirdOp “x”");
    assert.equal(api.describeFilterTerm({ attrib: "subject", op: "contains", valueError: "NS_ERROR_ILLEGAL_VALUE" }), "subject contains (value unreadable: NS_ERROR_ILLEGAL_VALUE)");
    assert.equal(api.describeFilterTerm({ attrib: "subject", op: "isEmpty" }), "subject is empty");
    assert.equal(api.describeFilterTerm({ attrib: "subject", op: "isEmpty", value: "" }), "subject is empty");
    assert.equal(api.describeFilterTerm({ attrib: "subject", op: "is", value: "" }), "subject is");
  });

  it("describes a reply whose template is not found, with Thunderbird's reason or a generic one", () => {
    const value = "imap://x/Templates?messageId=abc%40x&subject=Hi";
    assert.match(api.describeFilterAction({ type: "reply", value }, {}), /Reply with template Message-ID “abc%40x” in imap:\/\/x\/Templates \(template not found: not resolved\)/);
    assert.match(api.describeFilterAction({ type: "reply", value }, { [value]: { error: "no such message" } }), /\(template not found: no such message\)/);
  });

  it("shows a reply value that is not a template URI as quoted text", () => {
    assert.match(api.describeFilterAction({ type: "reply", value: "not a template" }), /Reply with template “not a template” \(template not found: not resolved\)/);
  });

  it("describes a reply whose template is known, with the optional parts only when they are there", () => {
    const value = "imap://x/Templates?messageId=1";
    const full = api.describeFilterAction({ type: "reply", value }, { [value]: { subject: "Out of office", folder: "Templates", author: "Me", date: "2026-11-01", size: 2048 } });
    assert.match(full, /Reply with template “Out of office” \(folder “Templates”; from “Me”; 2026-11-01; 2 KB\)/);
    const minimal = api.describeFilterAction({ type: "reply", value }, { [value]: { subject: "Out of office", folder: "Templates", size: 0 } });
    assert.match(minimal, /\(folder “Templates”\) -- its whole content/);
    assert.match(api.describeFilterAction({ type: "reply", value }, { [value]: { subject: "S", folder: "F", size: 10 } }), /1 KB/);
  });

  it("describes add-on actions, actions that cannot be read, unknown types and values that cannot be read", () => {
    assert.equal(api.describeFilterAction({ type: "custom", customId: "addon@x" }), "Add-on action “addon@x” (effect unknown)");
    assert.equal(api.describeFilterAction({ type: "unreadable", error: "gone" }), "(action Thunderbird cannot read: gone)");
    assert.equal(api.describeFilterAction({ type: "frobnicate" }), "Action frobnicate");
    assert.equal(api.describeFilterAction({ type: "markRead", valueError: "bad" }), "Mark as read (value unreadable: bad)");
    assert.equal(api.describeFilterAction({ type: "moveToFolder", value: "imap://x/A" }), "Move to folder “imap://x/A”");
    assert.equal(api.describeFilterAction({ type: "markRead", value: "" }), "Mark as read");
    assert.equal(api.describeFilterAction({ type: "forward", value: "a@example.com" }), "Forward to a@example.com");
  });

  it("names where mail goes: addresses, the sender for replies and add-on actions, each once", () => {
    const rules = [
      null,
      { actions: [{ type: "forward", value: "a@example.com" }, { type: "forward", value: "a@example.com" }, { type: "reply", value: "t" }] },
      { name: "no actions listed" },
      { actions: [{ type: "custom", customId: "addon@x" }, { type: "custom", customId: "addon@x" }, { type: "custom", customId: "other@x" }, { type: "delete" }] },
    ];
    assert.equal(api.describeSendTargets(rules),
      "a@example.com; the sender of each matching message (reply); unknown (add-on action “addon@x”, “other@x”)");
    assert.equal(api.describeSendTargets([]), "");
    assert.equal(api.describeSendTargets([{ actions: [{ type: "delete" }] }]), "");
  });

  it("describes a rule whose conditions cannot be read, and tolerates conditions and actions that are not lists", () => {
    const unreadable = api.describeFilterRuleLines({ name: "R", enabled: false, type: 1, termsError: "NS_ERROR", terms: [], actions: [] }, {});
    assert.deepEqual(plain(unreadable), [
      "  Name: “R”   (DISABLED)",
      "  Runs on: new mail (before junk classification)",
      "  If: (conditions unreadable: NS_ERROR)",
      "  Then:",
    ]);
    const odd = api.describeFilterRuleLines({ name: "R", enabled: true, type: 1, terms: "no", actions: null }, {});
    assert.deepEqual(plain(odd.slice(2)), ["  If: (no condition)", "  Then:"]);
  });

  it("refuses a rule with too many conditions or actions to show in full", () => {
    const terms = Array.from({ length: 21 }, () => ({ attrib: "subject", op: "contains", value: "x" }));
    assert.throws(() => api.describeFilterRuleLines({ name: "R", enabled: true, type: 1, terms, actions: [] }, {}), /21 conditions \(more than 20/);
    const actions = Array.from({ length: 11 }, () => ({ type: "markRead" }));
    assert.throws(() => api.describeFilterRuleLines({ name: "R", enabled: true, type: 1, terms: [], actions }, {}), /11 actions \(more than 10/);
  });

  it("lists at most five sending actions of a rule and marks the rest, naming a rule that has no actions list", () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ type: "forward", value: `a${i}@example.com` }));
    const line = api.describeSendingRuleLine({ index: 2, name: "Many", enabled: false, actions: [...six, { type: "markRead" }] }, {});
    assert.match(line, /^ {2}#2 “Many” \(disabled\): Forward to a0@example.com; .*Forward to a4@example.com; …$/);
    assert.doesNotMatch(line, /a5@example\.com/);
    assert.equal(api.describeSendingRuleLine({ index: 0, name: "Plain", enabled: true }, {}), "  #0 “Plain”: ");
  });
});

describe("buildFilterConfirmationDialog", () => {
  const account = { key: "account1", name: "Work", email: "me@work.example" };
  const sendingRule = { index: 0, name: "Fwd", enabled: true, type: 17, terms: [{ attrib: "subject", op: "contains", value: "invoice" }], actions: [{ type: "forward", value: "boss@example.com" }] };
  const base = { account, position: 0, count: 0, expiresAt: Date.UTC(2026, 10, 4, 12, 0, 0), formatTime: () => "12:00" };
  const build = (extra) => api.buildFilterConfirmationDialog({ ...base, ...extra });
  // A sending rule of the list as serializeFilterRule reads it.
  const ctxRule = (index, name = "Fwd", actions = [{ type: "forward", value: "boss@example.com" }]) => ({ index, name, enabled: true, type: 17, terms: [], actions });

  it("refuses an operation it does not know", () => {
    assert.throws(() => build({ operation: "teleport", rule: sendingRule }), /unknown operation teleport/);
  });

  it("names a disabled sending rule as 'has' an action that sends mail once enabled, when it is created", () => {
    const text = build({ operation: "create", rule: { ...sendingRule, enabled: false }, resultSends: true }).text;
    assert.match(text, /create this mail filter rule, which has an action that SENDS MAIL AUTOMATICALLY \(rule disabled for now\):/);
    assert.match(text, /Once enabled, mail is sent automatically to: boss@example\.com/);
    assert.match(text, /The rule is disabled for now; once enabled/);
  });

  it("a create that does not send mail still has a title about the filter list", () => {
    const d = build({ operation: "create", rule: { ...sendingRule, actions: [{ type: "markRead" }] }, resultSends: false, context: [ctxRule(5, "Other")] });
    assert.equal(d.title, "Commonpost MCP: change a filter list that sends mail?");
    assert.doesNotMatch(d.text, /which SENDS/);
  });

  it("an update names what changed, or 'nothing', and copes with a missing before-rule and change list", () => {
    const withChanges = build({ operation: "update", position: 3, before: { name: "Old name" }, changes: ["name", "enabled"], rule: sendingRule, resultSends: true });
    assert.match(withChanges.text, /change filter rule #3 “Old name” \(changed: name, enabled\); after the change it SENDS MAIL AUTOMATICALLY\./);
    assert.equal(withChanges.title, "Commonpost MCP: change a filter rule that SENDS MAIL?");
    const bare = build({ operation: "update", position: 1, rule: { ...sendingRule, actions: [] }, resultSends: false, context: [ctxRule(9, "Elsewhere", [{ type: "reply", value: "t" }])] });
    assert.match(bare.text, /change filter rule #1 “” \(changed: nothing\)\./);
    assert.equal(bare.title, "Commonpost MCP: change a filter list that sends mail?");
    const disabled = build({ operation: "update", position: 1, before: { name: "x" }, changes: ["enabled"], rule: { ...sendingRule, enabled: false }, resultSends: true });
    assert.match(disabled.text, /after the change it has an action that SENDS MAIL AUTOMATICALLY \(rule disabled for now\)\./);
  });

  it("a delete and a reorder show the rule's name when they have it, and an empty name otherwise", () => {
    assert.match(build({ operation: "delete", position: 2, rule: { name: "Old" }, context: [ctxRule(2, "Old")] }).text, /delete filter rule #2 “Old”\./);
    assert.match(build({ operation: "delete", position: 2 }).text, /delete filter rule #2 “”\./);
    assert.match(build({ operation: "reorder", fromIndex: 2, toIndex: 0, rule: { name: "Mover" } }).text, /move filter rule #2 “Mover” to position 0/);
    assert.match(build({ operation: "reorder", fromIndex: 2, toIndex: 0 }).text, /move filter rule #2 “” to position 0/);
  });

  it("an apply without a folder, without lists of rules, shows what it can", () => {
    const text = build({ operation: "apply", context: [ctxRule(0)] }).text;
    assert.match(text, /apply filters including 1 sending rule\(s\) to the messages already in folder “” \(\):/);
    assert.doesNotMatch(text, /Rules that will run|No rule will run/);
  });

  it("an apply lists the rules that will run, or says none will, and the ones skipped", () => {
    const none = build({ operation: "apply", folder: { name: "Inbox", uri: "imap://x/INBOX" }, run: [], skipped: [{ index: 3, name: "Off", reason: "disabled" }], context: [ctxRule(0)] }).text;
    assert.match(none, /No rule will run \(none is enabled and marked Manually Run\)\./);
    assert.match(none, /Rules that will be skipped:\n {2}#3 “Off”: disabled/);
    const some = build({ operation: "apply", folder: { name: "Inbox", uri: "imap://x/INBOX" }, run: [{ index: 1, name: "Go" }], skipped: [], context: [] }).text;
    assert.match(some, /Rules that will run \(enabled, marked Manually Run\):\n {2}#1 “Go”/);
    assert.doesNotMatch(some, /will be skipped/);
  });

  it("an apply names at most twenty rules per list and counts the rest", () => {
    const rules = Array.from({ length: 25 }, (_, i) => ({ index: i, name: `rule ${i}` }));
    const text = build({ operation: "apply", folder: { name: "Inbox", uri: "u" }, run: rules, skipped: rules.map((r) => ({ ...r, reason: "disabled" })), context: [] }).text;
    assert.equal(text.match(/… and 5 more/g).length, 2);
    assert.doesNotMatch(text, /rule 20”/);
  });

  it("works without an account, a context list or templates, and shows the expiry as an ISO time when no formatter is given", () => {
    const d = api.buildFilterConfirmationDialog({ operation: "delete", position: 0, rule: { name: "R" }, context: "no list", expiresAt: Date.UTC(2026, 10, 4, 12, 0, 0) });
    assert.match(d.text, /Account: “” \(\)/);
    assert.match(d.text, /This request expires at 2026-11-04T12:00:00\.000Z; closing this window refuses it\./);
    assert.equal(d.refuseLabel, "Refuse");
  });

  it("refuses a change too long to be shown in full in a dialog", () => {
    const terms = Array.from({ length: 20 }, () => ({ attrib: "subject", op: "contains", value: "x".repeat(100) }));
    const longActions = Array.from({ length: 5 }, (_, i) => ({ type: "forward", value: `${"a".repeat(60)}${i}@${"b".repeat(60)}.example.com` }));
    const actions = Array.from({ length: 10 }, (_, i) => ({ type: "forward", value: `${"a".repeat(60)}${i}@${"b".repeat(60)}.example.com` }));
    const context = Array.from({ length: 10 }, (_, i) => ctxRule(i, "n".repeat(60), longActions));
    assert.throws(() => build({ operation: "create", rule: { ...sendingRule, terms, actions }, resultSends: true, context }),
      /too long to review in a dialog \(\d+ characters\)/);
  });
});

describe("summarizeFilterConfirmation and fingerprintFilterList", () => {
  it("summarizes a rule that forwards, replies and runs an add-on action, and one reply template it cannot parse", () => {
    const summary = api.summarizeFilterConfirmation({
      operation: "create",
      rule: { name: "R", enabled: true, actions: [
        { type: "forward", value: "a@example.com" },
        { type: "reply", value: "imap://x/Templates?messageId=abc" },
        { type: "reply", value: "garbage" },
        { type: "custom", customId: "addon@x" },
        { type: "markRead" },
      ] },
      context: [{ index: 4, name: "Other" }],
      folder: { uri: "imap://x/INBOX" },
    });
    assert.deepEqual(plain(summary), {
      operation: "create",
      ruleName: "R",
      ruleEnabled: true,
      sends: ["forward to a@example.com", "reply with template abc", "reply with template (unparsed)", "add-on action addon@x"],
      sendingRulesInList: ["#4 Other"],
      folder: "imap://x/INBOX",
    });
  });

  it("summarizes a delete with no rule at all", () => {
    assert.deepEqual(plain(api.summarizeFilterConfirmation({ operation: "delete" })), { operation: "delete" });
    assert.deepEqual(plain(api.summarizeFilterConfirmation()), {}, "no operation: nothing to say");
  });

  it("a fingerprint of a list notes a rule that cannot be read, and a rule with no description", () => {
    const readable = {
      filterName: "ok", enabled: true, filterType: 1, temporary: false, searchTerms: [], actionCount: 0,
      getActionAt() { throw new Error("none"); },
    };
    const list = {
      filterCount: 2,
      getFilterAt(i) {
        if (i === 1) throw new Error("NS_ERROR_FAILURE");
        return readable;
      },
    };
    const fingerprint = JSON.parse(api.fingerprintFilterList(list));
    assert.equal(fingerprint.count, 2);
    assert.equal(fingerprint.rules[0].desc, "");
    assert.equal(fingerprint.rules[0].rule.name, "ok");
    assert.deepEqual(fingerprint.rules[1], { index: 1, error: "NS_ERROR_FAILURE" });
    readable.filterDesc = "note";
    assert.equal(JSON.parse(api.fingerprintFilterList(list)).rules[0].desc, "note");
  });
});
