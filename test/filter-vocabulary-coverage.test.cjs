// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";

// Filter conditions and actions are resolved by name from the running Thunderbird. These tests run the real search
// term and rule helpers of api.js (FILTER SEARCH TERM HELPERS, FILTER RULE HELPERS) against stand-ins for XPCOM, in
// three kinds of Thunderbird: a complete one, one without the add-on (Custom) constants and the priority and flag
// tables, and one that exposes none of the filter interfaces.

process.env.TZ = "America/Toronto";

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
  block("// BEGIN FILTER SEARCH TERM HELPERS", "// END FILTER SEARCH TERM HELPERS"),
  block("// BEGIN FILTER RULE HELPERS", "// END FILTER RULE HELPERS"),
].join("\n");

const ATTRIB = {
  Custom: -2, Default: -1,
  Subject: 0, Sender: 1, Body: 2, Date: 3, Priority: 4, MsgStatus: 5,
  To: 6, CC: 7, ToOrCC: 8, AllAddresses: 9, Location: 10, MessageKey: 11,
  AgeInDays: 12, FolderInfo: 13, Size: 14, AnyText: 15, Keywords: 16,
  HasAttachmentStatus: 44, JunkStatus: 45, JunkPercent: 46, JunkScoreOrigin: 47,
  HdrProperty: 49, FolderFlag: 50, Uint32HdrProperty: 51, OtherHeader: 52,
};
const ACTIONS = {
  Custom: -1, None: 0, MoveToFolder: 1, ChangePriority: 2, Delete: 3,
  MarkRead: 4, KillThread: 5, WatchThread: 6, MarkFlagged: 7, Reply: 9,
  Forward: 10, StopExecution: 11, DeleteFromPop3Server: 12,
  LeaveOnPop3Server: 13, JunkScore: 14, FetchBodyFromPop3Server: 15,
  CopyToFolder: 16, AddTag: 17, KillSubthread: 18, MarkUnread: 19,
};
const OPS = {
  Contains: 0, DoesntContain: 1, Is: 2, Isnt: 3, IsEmpty: 4,
  IsBefore: 5, IsAfter: 6, IsHigherThan: 7, IsLowerThan: 8,
  BeginsWith: 9, EndsWith: 10, SoundsLike: 11, LdapDwim: 12,
  IsGreaterThan: 13, IsLessThan: 14, NameCompletion: 15,
  IsInAB: 16, IsntInAB: 17, IsntEmpty: 18, Matches: 19, DoesntMatch: 20,
};
const FLAGS = { Read: 0x1, Replied: 0x2, Marked: 0x4, Forwarded: 0x1000, New: 0x10000, Attachment: 0x10000000 };
const PRIORITIES = { lowest: 2, low: 3, normal: 4, high: 5, highest: 6 };

// The extension context answers named lookups on Ci but lists no keys.
function nonEnumerable(constants) {
  return new Proxy({}, {
    get: (_t, name) => constants[name],
    has: (_t, name) => name in constants,
    ownKeys: () => [],
    getOwnPropertyDescriptor: () => undefined,
  });
}

// A value that crossed a vm realm: compare it as plain JSON.
const plain = (value) => JSON.parse(JSON.stringify(value));

const without = (table, ...names) => Object.fromEntries(Object.entries(table).filter(([k]) => !names.includes(k)));

const FULL_CI = () => ({
  nsMsgSearchAttrib: nonEnumerable(ATTRIB),
  nsMsgSearchOp: nonEnumerable(OPS),
  nsMsgFilterAction: nonEnumerable(ACTIONS),
  nsMsgFilterType: nonEnumerable({ InboxRule: 1, InboxJavaScript: 2, Manual: 0x10, PostOutgoing: 0x40 }),
  nsMsgMessageFlags: nonEnumerable(FLAGS),
  nsMsgPriority: nonEnumerable(PRIORITIES),
});
// No add-on constants, no priority table, no message flags (the attachment flag among them), no OtherHeader.
const BARE_CI = () => ({
  nsMsgSearchAttrib: nonEnumerable(without(ATTRIB, "Custom", "OtherHeader", "HdrProperty", "Uint32HdrProperty")),
  nsMsgSearchOp: nonEnumerable(OPS),
  nsMsgFilterAction: nonEnumerable(without(ACTIONS, "Custom")),
});

const LEGAL_VALUE_MEMBER = {
  [ATTRIB.Priority]: "priority", [ATTRIB.MsgStatus]: "status", [ATTRIB.Date]: "date",
  [ATTRIB.AgeInDays]: "age", [ATTRIB.Size]: "size", [ATTRIB.JunkStatus]: "junkStatus",
  [ATTRIB.JunkPercent]: "junkPercent", [ATTRIB.HasAttachmentStatus]: "status",
};

// An nsIMsgSearchValue: only the member that fits the attribute can be read or written.
function makeValue() {
  const state = { attrib: undefined, stored: undefined };
  const value = { get attrib() { return state.attrib; }, set attrib(v) { state.attrib = v; } };
  for (const member of ["str", "status", "priority", "date", "age", "size", "junkStatus", "junkPercent", "msgKey", "folder"]) {
    Object.defineProperty(value, member, {
      enumerable: true,
      get() {
        if ((LEGAL_VALUE_MEMBER[state.attrib] || "str") !== member) throw new Error(`NS_ERROR_ILLEGAL_VALUE [nsIMsgSearchValue.${member}]`);
        return state.stored;
      },
      set(v) {
        if ((LEGAL_VALUE_MEMBER[state.attrib] || "str") !== member) throw new Error(`NS_ERROR_ILLEGAL_VALUE [nsIMsgSearchValue.${member}]`);
        state.stored = v;
      },
    });
  }
  return value;
}

function makeAction() {
  return { type: 0, strValue: "", customId: "", targetFolderUri: "", priority: 0, junkScore: 0 };
}

function makeTerm() {
  return {
    attrib: undefined, op: undefined, booleanAnd: true, arbitraryHeader: "", customId: "",
    hdrProperty: "", matchAll: false, beginsGrouping: false, endsGrouping: false, value: makeValue(),
  };
}

function makeFilter(name = "f", { dropActions = false } = {}) {
  const terms = [];
  const actions = [];
  return {
    filterName: name, enabled: true, filterType: 17, temporary: false, filterDesc: "", unparseable: false,
    searchTerms: terms,
    get actionCount() { return actions.length; },
    createTerm: makeTerm,
    appendTerm(t) { terms.push(t); },
    createAction: makeAction,
    appendAction(a) { if (!dropActions) actions.push(a); },
    getActionAt(i) { return actions[i]; },
  };
}

function load({ ci = FULL_CI(), customHeaders = "", noWellFormed = false } = {}) {
  const sandbox = { Ci: ci, Services: { prefs: { getCharPref: (_name, fallback) => customHeaders ?? fallback } } };
  vm.createContext(sandbox);
  if (noWellFormed) vm.runInContext("delete String.prototype.isWellFormed", sandbox);
  vm.runInContext(`${HELPERS}
this.api = { VALUE_CODECS, parseStrictInteger, assertFilterText, arbitraryHeaderAttrib, setSearchValue, getSearchValue,
  buildTerms, buildRuleActions, copySearchValue, copySearchTerm, copyRuleAction, serializeSearchTerm,
  serializeFilterRule, planFilterUpdate, assertForwardAddress, filterSendingActionKinds, describeError,
  FILTER_ATTRIBUTES, ATTRIB_MAP, OP_MAP, FILTER_ACTION_VALUE_DESCRIPTION, FILTER_ATTRIB_DESCRIPTION,
  FILTER_OP_DESCRIPTION, FILTER_VALUE_DESCRIPTION, FILTER_HEADER_DESCRIPTION, FILTER_ACTION_TYPE_DESCRIPTION,
  validateFilterType, isAddressBookOp, selectManualRunFilters, assertFilterListGuard, listSendingRules };`, sandbox);
  return sandbox.api;
}

const full = load();

describe("filter value codecs: missing or unusual values", () => {
  it("an integer condition refuses a missing value and names it", () => {
    for (const [raw, shown] of [[undefined, "undefined"], [null, "null"], ["", '""'], ["  ", '"  "']]) {
      assert.throws(() => full.setSearchValue(makeValue(), ATTRIB.AgeInDays, raw),
        new RegExp(`Condition value for "ageInDays" must be a non-negative integer up to 2147483647 \\(days\\), got: ${shown}`));
    }
  });

  it("a text condition takes a missing value as empty text", () => {
    const value = makeValue();
    full.setSearchValue(value, ATTRIB.Subject, null);
    assert.equal(value.str, "");
    full.setSearchValue(value, ATTRIB.Subject, undefined);
    assert.equal(value.str, "");
  });

  it("text and tag key read back an empty or absent stored value as empty text", () => {
    for (const codec of ["text", "tagKey"]) {
      assert.equal(full.VALUE_CODECS[codec].format(""), "");
      assert.equal(full.VALUE_CODECS[codec].format(undefined), "");
      assert.equal(full.VALUE_CODECS[codec].format("$label1"), "$label1");
    }
  });

  it("a tag key action value of null becomes empty text and is then refused as a tag key", () => {
    assert.throws(() => full.VALUE_CODECS.tagKey.parse(null, "Action value for \"addTag\""), /must be a tag key: ""/);
    assert.equal(full.VALUE_CODECS.tagKey.parse("$label1", "x"), "$label1");
  });

  it("a date condition refuses a missing value, and reads a stored 0 as empty", () => {
    assert.throws(() => full.VALUE_CODECS.date.parse(undefined, "Condition value for \"date\""), /must be YYYY-MM-DD/);
    assert.equal(full.VALUE_CODECS.date.format(0), "");
    assert.equal(full.VALUE_CODECS.date.format(undefined), "");
  });

  it("a junk status refuses a missing value, and reads an unknown stored number as its digits", () => {
    assert.throws(() => full.VALUE_CODECS.junkStatus.parse(undefined, "Condition value for \"junkStatus\""), /must be junk, good or unclassified \(or 2, 1, 0\), got: ""/);
    assert.equal(full.VALUE_CODECS.junkStatus.format(7), "7");
    assert.equal(full.VALUE_CODECS.junkStatus.format(2), "junk");
    assert.equal(full.VALUE_CODECS.junkStatus.parse("notJunk"), 1);
    assert.equal(full.VALUE_CODECS.junkStatus.parse("2"), 2);
  });

  it("reads a typed value back as text when the typed member fails, and as empty when the text is empty too", () => {
    const value = makeValue();
    value.attrib = ATTRIB.Subject;
    assert.equal(full.getSearchValue(value, ATTRIB.Subject), "", "nothing stored");
    // A date condition whose date member cannot be read: falls back to .str
    const broken = { get date() { throw new Error("NS_ERROR_ILLEGAL_VALUE"); }, str: "" };
    assert.equal(full.getSearchValue(broken, ATTRIB.Date), "");
    const withText = { get date() { throw new Error("NS_ERROR_ILLEGAL_VALUE"); }, str: "2026-01-02" };
    assert.equal(full.getSearchValue(withText, ATTRIB.Date), "2026-01-02");
    const hopeless = { get date() { throw new Error("typed read failed"); }, get str() { throw new Error("text read failed"); } };
    assert.throws(() => full.getSearchValue(hopeless, ATTRIB.Date), /typed read failed/);
  });

  it("a condition value that is not valid text is reported with the offending position", () => {
    assert.throws(() => full.assertFilterText("Condition value", 12, 100), /Condition value must be a string/);
    assert.throws(() => full.assertFilterText("Condition value", "a\nb", 100), /control or line-separator character \(U\+000A at position 1\)/);
    assert.throws(() => full.assertFilterText("Condition value", "a\\b", 100), /contains a backslash \(position 1\)/);
    assert.throws(() => full.assertFilterText("Condition value", "x".repeat(11), 10), /too long \(11 characters, limit 10\)/);
    assert.throws(() => full.assertFilterText("Condition value", "a\ud800b", 100), /lone UTF-16 surrogate/);
  });

  it("on an engine without String.prototype.isWellFormed the surrogate check is skipped, the other checks stay", () => {
    const old = load({ noWellFormed: true });
    assert.equal(old.assertFilterText("Condition value", "a\ud800b", 100), "a\ud800b");
    assert.throws(() => old.assertFilterText("Condition value", "a\nb", 100), /control or line-separator/);
  });
});

describe("filter vocabulary of a Thunderbird without priority and flag tables", () => {
  const bare = load({ ci: BARE_CI() });

  it("accepts any integer for a priority, as no bounds are known", () => {
    assert.equal(bare.VALUE_CODECS.priority.parse("12", "Condition value"), 12);
    assert.equal(bare.VALUE_CODECS.priority.parse("-3", "Condition value"), -3);
    assert.match(bare.VALUE_CODECS.priority.hint, /^an integer$/);
    assert.equal(bare.VALUE_CODECS.status.hint, "a message-flag bitmask");
  });

  it("still refuses what is not an integer", () => {
    assert.throws(() => bare.VALUE_CODECS.priority.parse("high", "Condition value"), /must be an integer, got: "high"/);
    assert.throws(() => bare.parseStrictInteger("1.5", "Value", "a whole number", {}), /Value must be a whole number, got: "1.5"/);
    assert.equal(bare.parseStrictInteger(" 42 ", "Value", "x"), 42, "no bounds at all");
  });

  it("drops the attribute whose flag is unknown, so it cannot be used", () => {
    assert.equal("hasAttachment" in bare.ATTRIB_MAP, false);
    assert.equal("otherHeader" in bare.ATTRIB_MAP, false);
    assert.equal(bare.VALUE_CODECS.attachmentFlag.available, false);
    assert.throws(() => bare.buildTerms(makeFilter(), [{ attrib: "hasAttachment", op: "is" }]), /Unknown attribute: hasAttachment/);
  });

  it("describes the attributes it has and no header-name attribute", () => {
    assert.doesNotMatch(bare.FILTER_ATTRIB_DESCRIPTION, /hasAttachment|otherHeader/);
    assert.equal(bare.FILTER_HEADER_DESCRIPTION, "Not used by any available attribute");
    assert.match(bare.FILTER_ACTION_VALUE_DESCRIPTION, /^Action parameter\. /);
  });

  it("an attribute id above OtherHeader is not an arbitrary header when OtherHeader is unknown, so it reads as text", () => {
    const value = makeValue();
    value.attrib = 60;
    value.str = "kept";
    assert.equal(bare.getSearchValue(value, 60), "kept");
    assert.equal(bare.serializeSearchTerm({ attrib: 60, op: 0, booleanAnd: true, value, arbitraryHeader: "" }).attrib, "60");
  });
});

describe("filter vocabulary of a Thunderbird that exposes no filter interface", () => {
  const none = load({ ci: {} });

  it("refuses to build conditions and actions, and says why", () => {
    assert.throws(() => none.buildTerms(makeFilter(), [{ attrib: "subject", op: "contains", value: "x" }]),
      /Cannot build filter conditions -- unavailable: this Thunderbird did not expose nsMsgSearchAttrib\/nsMsgSearchOp/);
    assert.throws(() => none.buildRuleActions(makeFilter(), [{ type: "delete" }], () => ({})),
      /Cannot build filter actions -- this Thunderbird did not expose nsMsgFilterAction/);
  });

  it("describes every part of the vocabulary as unavailable", () => {
    assert.match(none.FILTER_ATTRIB_DESCRIPTION, /^Attribute -- unavailable/);
    assert.match(none.FILTER_OP_DESCRIPTION, /^Operator -- unavailable/);
    assert.match(none.FILTER_ACTION_TYPE_DESCRIPTION, /^Action -- unavailable/);
  });

  it("falls back to the known filter-type bits and to the outgoing-mail bit", () => {
    assert.equal(none.validateFilterType(0x1ff), 0x1ff);
    assert.throws(() => none.validateFilterType(0x200), /known bits: 0x1ff/);
  });
});

describe("arbitrary header conditions", () => {
  it("a header listed in mailnews.customHeaders gets its own id, one that is not listed gets the base id", () => {
    const api = load({ customHeaders: "X-First: X-Second :X-Third" });
    assert.equal(api.arbitraryHeaderAttrib("X-Second"), ATTRIB.OtherHeader + 1 + 1);
    assert.equal(api.arbitraryHeaderAttrib("x-third"), ATTRIB.OtherHeader + 1 + 2, "case does not matter");
    assert.equal(api.arbitraryHeaderAttrib("X-Unlisted"), ATTRIB.OtherHeader + 1);
  });

  it("a header too far down a long customHeaders list for its id to be valid gets the base id", () => {
    const names = Array.from({ length: 70 }, (_, i) => `X-H${i}`);
    const api = load({ customHeaders: names.join(": ") });
    assert.equal(api.arbitraryHeaderAttrib("X-H10"), ATTRIB.OtherHeader + 1 + 10);
    assert.equal(api.arbitraryHeaderAttrib("X-H60"), ATTRIB.OtherHeader + 1, "52 + 1 + 60 would be 113, past the last attribute id");
  });

  it("refuses a header name that Thunderbird would parse differently", () => {
    for (const bad of ["", "A:B", 'A"B', "A,B", "A B", 42, undefined, "x".repeat(101)]) {
      assert.throws(() => full.arbitraryHeaderAttrib(bad), /Invalid header name/, String(bad).slice(0, 20));
    }
  });
});

describe("copying conditions and actions", () => {
  it("copySearchValue refuses a value object that lacks the member of the attribute", () => {
    assert.throws(() => full.copySearchValue({}, makeValue(), ATTRIB.Subject),
      /nsIMsgSearchValue has no "str" member \(needed to copy attribute "subject"\)/);
  });

  it("setSearchValue refuses a value object that lacks the member too", () => {
    assert.throws(() => full.setSearchValue({}, ATTRIB.Size, "5"), /has no "size" member \(needed for attribute "size"\)/);
  });

  it("copies a condition without add-on or header-property fields when the Thunderbird has no such constants", () => {
    const bare = load({ ci: BARE_CI() });
    const filter = makeFilter();
    const source = makeTerm();
    source.attrib = ATTRIB.Subject;
    source.op = OPS.Contains;
    source.customId = "addon@example.org";
    source.hdrProperty = "X-Prop";
    source.value.attrib = ATTRIB.Subject;
    source.value.str = "invoice";
    const copy = bare.copySearchTerm(filter, source);
    assert.equal(copy.value.str, "invoice");
    assert.equal(copy.customId, "", "no add-on id without the Custom constant");
    assert.equal(copy.hdrProperty, "");
    assert.equal(filter.searchTerms.length, 1);
  });

  it("copies a rule action of a type this Thunderbird does not know, keeping its text, and nothing for the None action", () => {
    const filter = makeFilter();
    const unknown = full.copyRuleAction(filter, { type: 99, strValue: "kept text", customId: "" });
    assert.equal(unknown.type, 99);
    assert.equal(unknown.strValue, "kept text");
    const none = full.copyRuleAction(filter, { type: 0, strValue: "ignored" });
    assert.equal(none.type, 0);
    assert.equal(none.strValue, "");
    const noCustom = load({ ci: BARE_CI() });
    const custom = noCustom.copyRuleAction(makeFilter(), { type: -1, strValue: "text", customId: "id" });
    assert.equal(custom.customId, "", "without the Custom constant -1 is just an unknown type");
    assert.equal(custom.strValue, "text");
  });

  it("copies the typed member of a move action, and a custom action with its id", () => {
    const filter = makeFilter();
    const moved = full.copyRuleAction(filter, { type: ACTIONS.MoveToFolder, targetFolderUri: "imap://x/Archive" });
    assert.equal(moved.targetFolderUri, "imap://x/Archive");
    const custom = full.copyRuleAction(filter, { type: ACTIONS.Custom, customId: "addon@example.org", strValue: "param" });
    assert.equal(custom.customId, "addon@example.org");
    assert.equal(custom.strValue, "param");
  });
});

describe("building actions", () => {
  const folder = { folder: { URI: "imap://x/Archive" } };

  it("refuses an action that is null, a string or a list", () => {
    for (const bad of [null, undefined, "delete", ["delete"], 7]) {
      assert.throws(() => full.buildRuleActions(makeFilter(), [bad], () => folder), /Each filter action must be an object with a "type"/, String(bad));
    }
  });

  it("refuses a custom action by any spelling, and a type that is not a known name", () => {
    assert.throws(() => full.buildRuleActions(makeFilter(), [{ type: " Custom " }], () => folder), /Custom \(add-on\) filter actions cannot be created/);
    assert.throws(() => full.buildRuleActions(makeFilter(), [{ type: 3 }], () => folder), /Unknown action type: 3/);
    assert.throws(() => full.buildRuleActions(makeFilter(), [{ type: "toString" }], () => folder), /Unknown action type: toString/);
  });

  it("refuses a target folder that the resolver returns nothing, an error or no folder for", () => {
    for (const resolved of [undefined, null, { error: "Folder not found" }, {}]) {
      assert.throws(() => full.buildRuleActions(makeFilter(), [{ type: "moveToFolder", value: "imap://x/Gone" }], () => resolved),
        /Filter target folder not accessible: imap:\/\/x\/Gone/);
    }
  });

  it("stores the canonical URI the resolver gives, not the text the caller wrote", () => {
    const filter = makeFilter();
    full.buildRuleActions(filter, [{ type: "copyToFolder", value: "imap://x/archive" }], () => folder);
    assert.equal(filter.getActionAt(0).targetFolderUri, "imap://x/Archive");
  });

  it("an action without a value member takes none, and one with a member needs one", () => {
    assert.throws(() => full.buildRuleActions(makeFilter(), [{ type: "delete", value: "x" }], () => folder), /Action "delete" does not take a value/);
    assert.throws(() => full.buildRuleActions(makeFilter(), [{ type: "addTag" }], () => folder), /Action "addTag" requires a value/);
  });
});

describe("reading a rule back", () => {
  it("builds and reads actions the same way when the Thunderbird has no add-on action constant", () => {
    const bare = load({ ci: BARE_CI() });
    const filter = makeFilter();
    bare.buildRuleActions(filter, [{ type: "markRead" }, { type: "junkScore", value: "80" }], () => ({}));
    assert.deepEqual(plain(bare.serializeFilterRule(filter, 0).actions), [{ type: "markRead" }, { type: "junkScore", value: "80" }]);
  });

  it("reports a condition list that cannot be read, and still reads the actions", () => {
    const filter = makeFilter("broken rule");
    Object.defineProperty(filter, "searchTerms", { get() { throw new Error("NS_ERROR_FAILURE reading terms"); } });
    const action = makeAction();
    action.type = ACTIONS.Delete;
    filter.appendAction(action);
    const rule = full.serializeFilterRule(filter, 3);
    assert.equal(rule.termsError, "NS_ERROR_FAILURE reading terms");
    assert.deepEqual(plain(rule.terms), []);
    assert.deepEqual(plain(rule.actions.map((a) => a.type)), ["delete"]);
    assert.equal(rule.index, 3);
  });

  it("reads an action type it does not know by its number, an add-on action with its id and an empty parameter as empty text", () => {
    const filter = makeFilter();
    const unknown = makeAction();
    unknown.type = 99;
    const addon = makeAction();
    addon.type = ACTIONS.Custom;
    addon.customId = "addon@example.org";
    addon.strValue = "";
    const move = makeAction();
    move.type = ACTIONS.MoveToFolder;
    move.targetFolderUri = "";
    for (const a of [unknown, addon, move]) filter.appendAction(a);
    const rule = full.serializeFilterRule(filter, 0);
    assert.deepEqual(plain(rule.actions), [
      { type: "99" },
      { type: "custom", customId: "addon@example.org", value: "" },
      { type: "moveToFolder", value: "" },
    ]);
  });

  it("reports an add-on action whose fields cannot be read, and an action value that cannot be read", () => {
    const filter = makeFilter();
    const addon = { type: ACTIONS.Custom, get customId() { throw new Error("no id"); } };
    const priority = { type: ACTIONS.ChangePriority, get priority() { throw new Error("no priority"); } };
    for (const a of [addon, priority]) filter.appendAction(a);
    const rule = full.serializeFilterRule(filter, 0);
    assert.deepEqual(plain(rule.actions), [
      { type: "custom", error: "no id" },
      { type: "changePriority", valueError: "no priority" },
    ]);
  });

  it("reports an action that cannot be fetched as unreadable", () => {
    const filter = makeFilter();
    Object.defineProperty(filter, "actionCount", { get: () => 1 });
    filter.getActionAt = () => { throw new Error("index out of range"); };
    assert.deepEqual(plain(full.serializeFilterRule(filter, 0).actions), [{ type: "unreadable", error: "index out of range" }]);
  });

  it("names an operator it does not know by its number", () => {
    const term = makeTerm();
    term.attrib = ATTRIB.Subject;
    term.op = 77;
    term.value.attrib = ATTRIB.Subject;
    term.value.str = "x";
    assert.equal(full.serializeSearchTerm(term).op, "77");
  });

  it("keeps the grouping of a condition, the header property and the add-on id", () => {
    const term = makeTerm();
    term.attrib = ATTRIB.Custom;
    term.op = OPS.Contains;
    term.customId = "addon@example.org";
    term.hdrProperty = "X-Prop";
    term.beginsGrouping = true;
    term.endsGrouping = true;
    term.value.attrib = ATTRIB.Custom;
    term.value.str = "v";
    const out = full.serializeSearchTerm(term);
    assert.equal(out.customId, "addon@example.org");
    assert.equal(out.hdrProperty, "X-Prop");
    assert.equal(out.beginsGrouping, true);
    assert.equal(out.endsGrouping, true);
    const bare = load({ ci: BARE_CI() });
    assert.equal("customId" in bare.serializeSearchTerm(term), false, "no add-on terms without the Custom constant");
  });
});

describe("planFilterUpdate", () => {
  function filterList(options) {
    return { createFilter: (name) => { const f = makeFilter(name, options); return f; } };
  }
  function ruleWith({ actions = [], terms = [], name = "rule", desc = "" } = {}) {
    const filter = makeFilter(name);
    filter.filterDesc = desc;
    for (const t of terms) filter.appendTerm(t);
    for (const a of actions) filter.appendAction(a);
    return filter;
  }
  const subjectTerm = (text) => {
    const t = makeTerm();
    t.attrib = ATTRIB.Subject;
    t.op = OPS.Contains;
    t.value.attrib = ATTRIB.Subject;
    t.value.str = text;
    return t;
  };
  const moveAction = (uri) => { const a = makeAction(); a.type = ACTIONS.MoveToFolder; a.targetFolderUri = uri; return a; };
  const resolve = () => ({ folder: { URI: "imap://x/Archive" } });

  it("refuses to plan without a folder resolver", () => {
    assert.throws(() => full.planFilterUpdate(filterList(), ruleWith(), { name: "x" }), /requires a resolveFolder\(uri\) function/);
  });

  it("rebuilds the rule with the new name, state and type, keeping its description and copying its conditions and actions", () => {
    const filter = ruleWith({ terms: [subjectTerm("invoice")], actions: [moveAction("imap://x/Archive")], desc: "my note" });
    const plan = full.planFilterUpdate(filterList(), filter, { name: "Renamed", enabled: false, type: 0x10, actions: [{ type: "markRead" }] }, resolve);
    assert.deepEqual([...plan.changes], ["name", "enabled", "type", "actions"]);
    assert.equal(plan.replacement.filterName, "Renamed");
    assert.equal(plan.replacement.enabled, false);
    assert.equal(plan.replacement.filterType, 0x10);
    assert.equal(plan.replacement.filterDesc, "my note");
    assert.equal(plan.replacement.searchTerms[0].value.str, "invoice", "the condition is copied");
    assert.equal(plan.replacement.getActionAt(0).type, ACTIONS.MarkRead);
  });

  it("keeps the current name, state and type when the update changes only the conditions", () => {
    const filter = ruleWith({ name: "Original", terms: [subjectTerm("a")], actions: [moveAction("imap://x/Archive")] });
    filter.enabled = false;
    filter.filterType = 0x11;
    const plan = full.planFilterUpdate(filterList(), filter, { conditions: [{ attrib: "subject", op: "contains", value: "b" }] }, resolve);
    assert.deepEqual([...plan.changes], ["conditions"]);
    assert.equal(plan.replacement.filterName, "Original");
    assert.equal(plan.replacement.enabled, false);
    assert.equal(plan.replacement.filterType, 0x11);
    assert.equal(plan.replacement.filterDesc, "", "no description to carry");
    assert.equal(plan.replacement.getActionAt(0).targetFolderUri, "imap://x/Archive", "the action is copied");
  });

  it("refuses to rebuild a rule that has no readable condition when only its actions are replaced", () => {
    const filter = ruleWith({ terms: [], actions: [moveAction("imap://x/Archive")] });
    assert.throws(() => full.planFilterUpdate(filterList(), filter, { actions: [{ type: "markRead" }] }, resolve),
      /Cannot update: failed to read existing filter conditions/);
  });

  it("aborts when a copied action does not end up in the rebuilt rule", () => {
    const filter = ruleWith({ terms: [subjectTerm("a")], actions: [moveAction("imap://x/A"), moveAction("imap://x/B")] });
    assert.throws(() => full.planFilterUpdate(filterList({ dropActions: true }), filter, { conditions: [{ attrib: "subject", op: "contains", value: "b" }] }, resolve),
      /Copied 0 of 2 existing actions -- update aborted/);
  });

  it("names the condition that could not be copied", () => {
    const bad = subjectTerm("a");
    Object.defineProperty(bad, "value", { get() { throw new Error("value unreadable"); } });
    const filter = ruleWith({ terms: [subjectTerm("fine"), bad], actions: [moveAction("imap://x/A")] });
    assert.throws(() => full.planFilterUpdate(filterList(), filter, { actions: [{ type: "markRead" }] }, resolve),
      /Failed to copy existing condition #1: value unreadable/);
  });

  it("names the action that could not be copied", () => {
    const filter = ruleWith({ terms: [subjectTerm("a")], actions: [moveAction("imap://x/A")] });
    filter.getActionAt = () => { throw new Error("action unreadable"); };
    assert.throws(() => full.planFilterUpdate(filterList(), filter, { conditions: [{ attrib: "subject", op: "contains", value: "b" }] }, resolve, { allowSendActions: true }),
      /Failed to copy existing action #0: action unreadable/);
  });

  it("refuses a rule that Thunderbird could not parse when a rebuild is needed", () => {
    const filter = ruleWith({ terms: [subjectTerm("a")] });
    filter.unparseable = true;
    assert.throws(() => full.planFilterUpdate(filterList(), filter, { actions: [{ type: "markRead" }] }, resolve), /could not parse it/);
  });

  it("fails closed when the actions the rule keeps cannot be read", () => {
    const filter = ruleWith({ terms: [subjectTerm("a")], actions: [moveAction("imap://x/A")] });
    filter.getActionAt = () => { throw new Error("NS_ERROR_FAILURE"); };
    assert.throws(() => full.planFilterUpdate(filterList(), filter, { name: "New" }, resolve, { allowSendActions: true, isKeptTargetAllowed: () => true }),
      /has an action Thunderbird cannot read \(NS_ERROR_FAILURE\); it cannot be modified through MCP/);
  });

  it("fails closed when a condition the rule keeps cannot be read", () => {
    const addressBookTerm = makeTerm();
    addressBookTerm.attrib = ATTRIB.Sender;
    addressBookTerm.op = OPS.IsInAB;
    Object.defineProperty(addressBookTerm, "value", { get() { throw new Error("NS_ERROR_FAILURE"); } });
    const filter = ruleWith({ terms: [addressBookTerm] });
    assert.throws(() => full.planFilterUpdate(filterList(), filter, { name: "New" }, resolve, { isAddressBookAllowed: () => true }),
      /has a condition Thunderbird cannot read \(NS_ERROR_FAILURE\); it cannot be modified through MCP/);
  });
});

describe("what sends mail", () => {
  it("assertForwardAddress names a value that is not text by its string form", () => {
    assert.throws(() => full.assertForwardAddress(42), /got: "42"/);
    assert.throws(() => full.assertForwardAddress(undefined), /got: "undefined"/);
    assert.throws(() => full.assertForwardAddress(null), /got: "null"/);
  });

  it("filterSendingActionKinds reports an action that cannot be read, a reply, a forward and an add-on action", () => {
    const filter = makeFilter();
    const reply = makeAction();
    reply.type = ACTIONS.Reply;
    const forward = makeAction();
    forward.type = ACTIONS.Forward;
    const addon = makeAction();
    addon.type = ACTIONS.Custom;
    const harmless = makeAction();
    harmless.type = ACTIONS.Delete;
    for (const a of [reply, forward, addon, harmless]) filter.appendAction(a);
    assert.deepEqual([...full.filterSendingActionKinds(filter)], ["reply", "forward", "custom"]);
    const noCustom = load({ ci: BARE_CI() });
    assert.deepEqual([...noCustom.filterSendingActionKinds(filter)], ["reply", "forward"]);
    const broken = makeFilter();
    Object.defineProperty(broken, "actionCount", { get: () => 1 });
    broken.getActionAt = () => { throw new Error("cannot read"); };
    assert.deepEqual([...full.filterSendingActionKinds(broken)], ["unreadable (cannot read)"]);
  });
});

describe("describeError", () => {
  it("gives a message, a text, or 'unknown error'", () => {
    assert.equal(full.describeError(null), "unknown error");
    assert.equal(full.describeError(undefined), "unknown error");
    assert.equal(full.describeError(new Error("boom")), "boom");
    assert.equal(full.describeError(""), "");
    assert.equal(full.describeError(0), "0");
    assert.equal(full.describeError({ message: "" }), "[object Object]");
  });
});
