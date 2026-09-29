"use strict";

// Human confirmation of filter rules that send mail (policy "confirm" |
// "block", derived from the blockFilterForwardReply preference).
//
// Two layers:
//  - the pure helpers of FILTER CONFIRMATION HELPERS (policy, decision, store
//    and limits, text shown to the user);
//  - the REAL filter tool handlers of api.js (extracted by markers, run in a
//    vm with XPCOM doubles): request -> pending response -> dialog -> the
//    user's answer (simulated the way commonDialog.js reports it) -> write,
//    or nothing written.

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const apiPath = path.resolve(__dirname, "../extension/mcp_server/api.js");
const apiSource = fs.readFileSync(apiPath, "utf8");

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
const FILTER_TYPES = { InboxRule: 0x1, InboxJavaScript: 0x2, NewsRule: 0x4, NewsJavaScript: 0x8, Manual: 0x10,
  PostPlugin: 0x20, PostOutgoing: 0x40, Archive: 0x80, Periodic: 0x100, All: 0x1f };
const TEMPLATES_FLAG = 0x400000;

function nonEnumerable(constants) {
  return new Proxy({}, {
    get: (_t, name) => constants[name],
    has: (_t, name) => name in constants,
    ownKeys: () => [],
    getOwnPropertyDescriptor: () => undefined,
  });
}

function block(begin, end) {
  const start = apiSource.indexOf(begin);
  const stop = apiSource.indexOf(end, start);
  assert.ok(start >= 0 && stop > start, `marker missing: ${begin}`);
  return apiSource.slice(start, stop);
}

const HELPER_BLOCKS = [
  // DISPLAY_INVISIBLE (in FILTER CONFIRMATION HELPERS) now builds on
  // CORE_HIDDEN_CLASS_SRC, the single table shared with the untrusted-content
  // removal helpers -- loaded first so the reference resolves.
  block("// BEGIN UNTRUSTED CONTENT HELPERS", "// END UNTRUSTED CONTENT HELPERS"),
  block("// BEGIN FILTER SEARCH TERM HELPERS", "// END FILTER SEARCH TERM HELPERS"),
  block("// BEGIN FILTER RULE HELPERS", "// END FILTER RULE HELPERS"),
  block("// BEGIN FILTER CONFIRMATION HELPERS", "// END FILTER CONFIRMATION HELPERS"),
].join("\n");

function xpcom() {
  return {
    nsMsgSearchAttrib: nonEnumerable(ATTRIB),
    nsMsgSearchOp: nonEnumerable(OPS),
    nsMsgFilterAction: nonEnumerable(ACTIONS),
    nsMsgFilterType: nonEnumerable(FILTER_TYPES),
    nsMsgMessageFlags: { Attachment: 0x10000000 },
    nsMsgFolderFlags: { Templates: TEMPLATES_FLAG },
    nsITimer: { TYPE_ONE_SHOT: 0 },
  };
}

// ── XPCOM doubles (same behaviour as in commonpost-filter-rules.test.cjs) ──
const LEGAL_VALUE_MEMBER = {
  [ATTRIB.Priority]: "priority", [ATTRIB.MsgStatus]: "status", [ATTRIB.Date]: "date",
  [ATTRIB.AgeInDays]: "age", [ATTRIB.Size]: "size", [ATTRIB.JunkStatus]: "junkStatus",
  [ATTRIB.JunkPercent]: "junkPercent", [ATTRIB.HasAttachmentStatus]: "status",
};
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
const ACTION_MEMBER_TYPES = {
  targetFolderUri: [ACTIONS.MoveToFolder, ACTIONS.CopyToFolder],
  priority: [ACTIONS.ChangePriority],
  junkScore: [ACTIONS.JunkScore],
};
function makeAction() {
  const state = { type: ACTIONS.None, strValue: "", customId: "" };
  const action = {
    get type() { return state.type; }, set type(v) { state.type = v; },
    get strValue() { return state.strValue; }, set strValue(v) { state.strValue = v; },
    get customId() { return state.customId; }, set customId(v) { state.customId = v; },
  };
  for (const [member, types] of Object.entries(ACTION_MEMBER_TYPES)) {
    Object.defineProperty(action, member, {
      enumerable: true,
      get() { if (!types.includes(state.type)) throw new Error(`NS_ERROR_ILLEGAL_VALUE [nsIMsgRuleAction.${member}]`); return state[member]; },
      set(v) { if (!types.includes(state.type)) throw new Error(`NS_ERROR_ILLEGAL_VALUE [nsIMsgRuleAction.${member}]`); state[member] = v; },
    });
  }
  return action;
}
function makeTerm() {
  return {
    attrib: undefined, op: undefined, booleanAnd: true, arbitraryHeader: "", customId: "",
    hdrProperty: "", matchAll: false, beginsGrouping: false, endsGrouping: false, value: makeValue(),
  };
}
function makeFilter(name = "f") {
  const terms = [];
  const actions = [];
  return {
    filterName: name, enabled: true, filterType: 17, temporary: false, filterDesc: "", unparseable: false,
    searchTerms: terms,
    get actionCount() { return actions.length; },
    createTerm: makeTerm,
    appendTerm(t) { terms.push(t); },
    createAction: makeAction,
    appendAction(a) { actions.push(a); },
    getActionAt(i) { return actions[i]; },
  };
}
function makeFilterList() {
  const filters = [];
  const list = {
    filters, saves: 0, loggingEnabled: false,
    createFilter(name) { return makeFilter(name); },
    get filterCount() { return filters.length; },
    getFilterAt(i) {
      if (i < 0 || i >= filters.length) throw new Error("NS_ERROR_ILLEGAL_VALUE");
      return filters[i];
    },
    insertFilterAt(i, f) { filters.splice(i, 0, f); },
    removeFilterAt(i) { filters.splice(i, 1); },
    saveToDefaultFile() { list.saves++; },
  };
  return list;
}

// ── Pure helpers ──
function loadHelpers(extra = {}) {
  const sandbox = { Ci: xpcom(), Services: { prefs: { getCharPref: (_n, d) => d } }, ...extra };
  vm.createContext(sandbox);
  vm.runInContext(`${HELPER_BLOCKS}
this.api = { resolveFilterSendRulePolicy, resolveFilterConfirmTtlMs, decideSendRuleChange, createFilterConfirmationStore,
  describeConfirmationRefusal, displayFilterText, quoteFilterText, buildFilterConfirmationDialog, parseReplyTemplateValue,
  fingerprintFilterList, summarizeFilterConfirmation, assertForwardAddress, buildRuleActions, buildTerms,
  serializeFilterRule, listSendingRules, filterSendingActionKinds, FILTER_CONFIRM_SEND_WARNING,
  FILTER_CONFIRM_MAX_PER_HOUR, FILTER_CONFIRM_MAX_PENDING, FILTER_CONFIRM_TTL_DEFAULT_S };`, sandbox);
  return sandbox.api;
}
const api = loadHelpers();

function fakePrefs(values) {
  return {
    type(name) {
      if (values.__throw) throw new Error("E_PREFS");
      if (!(name in values)) return "none";
      const v = values[name];
      return typeof v === "string" ? "string" : typeof v === "boolean" ? "bool" : "int";
    },
    string(name) { return values[name]; },
    bool(name) { return values[name]; },
    int(name) { return values[name]; },
  };
}
const P_BLOCK = "extensions.commonpost-mcp.blockFilterForwardReply";
const P_TTL = "extensions.commonpost-mcp.filterConfirmTimeoutSeconds";

describe("filterSendRulePolicy: block by default and on doubt, confirm only when asked", () => {
  const cases = [
    [{}, "block", "default"],
    [{ [P_BLOCK]: true }, "block", "pref"],
    [{ [P_BLOCK]: false }, "confirm", "pref"],
    [{ [P_BLOCK]: "false" }, "block", "invalid"],
    [{ [P_BLOCK]: "yes" }, "block", "invalid"],
    [{ [P_BLOCK]: 0 }, "block", "invalid"],
    [{ __throw: true }, "block", "error"],
  ];
  for (const [prefs, policy, source] of cases) {
    it(`${JSON.stringify(prefs)} -> ${policy} (${source})`, () => {
      const r = api.resolveFilterSendRulePolicy(fakePrefs(prefs));
      assert.equal(r.policy, policy);
      assert.equal(r.source, source);
    });
  }
  it("no value of the preference gives a policy that writes without asking", () => {
    for (const v of [true, false, "x", 1, undefined]) {
      const r = api.resolveFilterSendRulePolicy(fakePrefs(v === undefined ? {} : { [P_BLOCK]: v }));
      assert.ok(["block", "confirm"].includes(r.policy));
    }
  });
  it("a boolean that cannot be read is block", () => {
    const prefs = fakePrefs({ [P_BLOCK]: false });
    prefs.bool = () => { throw new Error("E_READ"); };
    assert.equal(api.resolveFilterSendRulePolicy(prefs).policy, "block");
  });
});

describe("time to answer: 10 minutes, the hidden preference can only shorten it", () => {
  for (const [v, ms] of [[undefined, 600000], [30, 30000], [120, 120000], [5, 30000], [0, 30000], [-1, 30000],
    [601, 600000], [100000, 600000]]) {
    it(`${v} -> ${ms} ms`, () => {
      assert.equal(api.resolveFilterConfirmTtlMs(fakePrefs(v === undefined ? {} : { [P_TTL]: v })), ms);
    });
  }
  it("a string or an unreadable value keeps 10 minutes", () => {
    assert.equal(api.resolveFilterConfirmTtlMs(fakePrefs({ [P_TTL]: "5" })), 600000);
    assert.equal(api.resolveFilterConfirmTtlMs(fakePrefs({ __throw: true })), 600000);
  });
});

describe("forward target: exactly one plain address, shown in full", () => {
  for (const ok of ["target@example.net", "a.b+c@sub.example.co.uk", "x_y-z@e-x.org", `${"a".repeat(64)}@example.com`]) {
    it(`accepts ${ok.slice(0, 40)}`, () => assert.equal(api.assertForwardAddress(ok), ok));
  }
  for (const bad of ["", "a@b", "a@x.com, b@y.com", "a@x.com;b@y.com", "Name <a@x.com>", "a b@x.com", "a@x.com ",
    " a@x.com", "a@[127.0.0.1]", "a@127.0.0.1", "\"a\"@x.com", "a..b@x.com", ".a@x.com", "a@x..com", "a@-x.com",
    "é@x.com", "a@exаmple.com" /* Cyrillic а */, "a@x.com\u202E", `${"a".repeat(65)}@x.com`,
    `a@${"b".repeat(250)}.com`, "a@x.com\u0000", "a@x", "@x.com"]) {
    it(`refuses ${JSON.stringify(bad).slice(0, 50)}`, () => {
      assert.throws(() => api.assertForwardAddress(bad), /exactly one plain e-mail address/);
    });
  }
});

describe("sending actions are built only checked", () => {
  const resolveFolder = () => ({ error: "no folder" });
  it("forward: refused when the address is not a single plain address", () => {
    assert.throws(() => api.buildRuleActions(makeFilter(), [{ type: "forward", value: "a@x.com, b@y.com" }], resolveFolder,
      { allowSendActions: true }), /exactly one plain e-mail address/);
  });
  it("reply: refused without a template check (fail closed)", () => {
    assert.throws(() => api.buildRuleActions(makeFilter(), [{ type: "reply", value: "x" }], resolveFolder,
      { allowSendActions: true }), /cannot be checked here/);
  });
  it("the check sees the action name and the parsed value; its refusal is the refusal", () => {
    const seen = [];
    const f = makeFilter();
    api.buildRuleActions(f, [{ type: "forward", value: "a@example.com" }, { type: "reply", value: "tpl" }], resolveFolder, {
      allowSendActions: true, checkSendAction: (n, v) => seen.push([n, v]),
    });
    assert.deepEqual(seen, [["forward", "a@example.com"], ["reply", "tpl"]]);
    assert.deepEqual([f.getActionAt(0).type, f.getActionAt(1).type], [ACTIONS.Forward, ACTIONS.Reply]);
    assert.throws(() => api.buildRuleActions(makeFilter(), [{ type: "reply", value: "tpl" }], resolveFolder, {
      allowSendActions: true, checkSendAction: () => { throw new Error("not a Templates folder"); },
    }), /not a Templates folder/);
  });
  it("without allowSendActions nothing changes: the guard refusal, before any value check", () => {
    assert.throws(() => api.buildRuleActions(makeFilter(), [{ type: "forward", value: "a@x.com, b@y.com" }], resolveFolder),
      /sends mail automatically; blocked by "Filter rules that send mail: Always block"/);
  });
});

function rule(kinds, index = 0, name = `r${index}`, enabled = true) {
  return { index, name, enabled, actions: kinds };
}

describe("decideSendRuleChange (confirm policy)", () => {
  const D = (x) => api.decideSendRuleChange(x);
  it("a benign rule in a list without sending rules is written at once", () => {
    assert.equal(D({ operation: "create", listRules: [], result: { kinds: [], type: 17 } }).verdict, "allow");
    assert.equal(D({ operation: "update", listRules: [], result: { kinds: [], type: 17 }, targetIndex: 0 }).verdict, "allow");
    for (const op of ["delete", "reorder", "apply"]) assert.equal(D({ operation: op, listRules: [], targetIndex: 0 }).verdict, "allow");
  });
  it("a new forward or reply rule is confirmed", () => {
    for (const k of ["forward", "reply"]) {
      const d = D({ operation: "create", listRules: [], result: { kinds: [k], type: 17 } });
      assert.equal(d.verdict, "confirm");
      assert.equal(d.resultSends, true);
    }
  });
  it("a sending rule on OUTGOING mail is refused, whatever else", () => {
    for (const k of [["forward"], ["reply"], ["custom"], ["forward", "custom"]]) {
      const d = D({ operation: "create", listRules: [], result: { kinds: k, type: 17 | 0x40 } });
      assert.equal(d.verdict, "refuse");
      assert.match(d.reason, /cannot run on outgoing mail/);
    }
    assert.equal(D({ operation: "update", listRules: [rule(["forward"])], result: { kinds: ["forward"], type: 0x40 }, targetIndex: 0 }).verdict, "refuse");
    // A benign rule may still be an outgoing rule.
    assert.equal(D({ operation: "create", listRules: [], result: { kinds: [], type: 0x40 } }).verdict, "allow");
  });
  it("any change to a list holding a sending rule is confirmed (create, update, reorder, apply, delete of another rule)", () => {
    const list = [rule(["forward"], 1, "fwd")];
    for (const [op, extra] of [["create", { result: { kinds: [], type: 17 } }], ["update", { result: { kinds: [], type: 17 }, targetIndex: 0 }],
      ["reorder", {}], ["apply", {}], ["delete", { targetIndex: 0 }]]) {
      const d = D({ operation: op, listRules: list, ...extra });
      assert.equal(d.verdict, "confirm", op);
      assert.equal(d.context.length, 1);
    }
  });
  it("changing (even disabling) the sending rule itself is confirmed", () => {
    const d = D({ operation: "update", listRules: [rule(["forward"], 0)], result: { kinds: ["forward"], type: 17 }, targetIndex: 0 });
    assert.equal(d.verdict, "confirm");
    assert.equal(D({ operation: "update", listRules: [rule(["forward"], 0)], result: { kinds: [], type: 17 }, targetIndex: 0 }).verdict, "confirm");
  });
  it("deleting a sending rule is always the way out", () => {
    assert.equal(D({ operation: "delete", listRules: [rule(["forward"], 0), rule(["unreadable (E)"], 1)], targetIndex: 0 }).verdict, "allow");
  });
  it("disabled sending rules and add-on actions count", () => {
    assert.equal(D({ operation: "apply", listRules: [rule(["forward"], 0, "x", false)] }).verdict, "confirm");
    assert.equal(D({ operation: "apply", listRules: [rule(["custom"], 0)] }).verdict, "confirm");
  });
  it("what cannot be read cannot be shown: refused", () => {
    assert.equal(D({ operation: "apply", listRules: [rule(["unreadable (E_READ)"], 0)] }).verdict, "refuse");
    assert.equal(D({ operation: "create", listRules: [], result: { kinds: ["unreadable (E)"], type: 17 } }).verdict, "refuse");
  });
  it("more than 10 sending rules cannot be reviewed: refused", () => {
    const many = Array.from({ length: 11 }, (_, i) => rule(["forward"], i));
    assert.match(D({ operation: "apply", listRules: many }).reason, /11 rules that send mail/);
    assert.equal(D({ operation: "apply", listRules: many.slice(0, 10) }).verdict, "confirm");
  });
  it("an unknown operation is refused", () => {
    assert.equal(D({ operation: "rename", listRules: [] }).verdict, "refuse");
  });
});

function clock(t0 = Date.UTC(2026, 8, 25, 12, 0, 0)) {
  const c = { t: t0, now: () => c.t, advance(ms) { c.t += ms; } };
  return c;
}
function idGen() {
  let n = 0;
  return () => `fc-${String(++n).padStart(4, "0")}`;
}

describe("confirmation store: one pending, five per hour, one decision", () => {
  it("opens a pending entry and refuses a second one while it is pending", () => {
    const c = clock();
    const s = api.createFilterConfirmationStore({ now: c.now, newId: idGen() });
    const { entry } = s.open({ operation: "createFilter", accountId: "account1", ttlMs: 600000 });
    assert.equal(entry.status, "pending");
    const second = s.open({ operation: "createFilter", accountId: "account1", ttlMs: 600000 });
    assert.equal(second.error.code, "pending");
    assert.equal(second.error.pending.confirmationId, entry.id);
    assert.match(api.describeConfirmationRefusal(second.error), /only one at a time/);
    s.settle(entry.id, "refused");
    assert.ok(s.open({ operation: "createFilter", accountId: "account1", ttlMs: 600000 }).entry);
  });
  it("at most 5 dialogs in a rolling hour, then refused until the oldest is an hour old", () => {
    const c = clock();
    const s = api.createFilterConfirmationStore({ now: c.now, newId: idGen() });
    for (let i = 0; i < 5; i++) {
      const { entry } = s.open({ operation: "applyFilters", accountId: "a", ttlMs: 600000 });
      s.settle(entry.id, "refused");
      c.advance(60 * 1000);
    }
    const sixth = s.open({ operation: "applyFilters", accountId: "a", ttlMs: 600000 });
    assert.equal(sixth.error.code, "rate");
    assert.equal(sixth.error.used, 5);
    assert.equal(sixth.error.retryAt, new Date(Date.UTC(2026, 8, 25, 13, 0, 0)).toISOString());
    assert.match(api.describeConfirmationRefusal(sixth.error), /5 dialogs in the last hour \(limit 5\)/);
    c.advance(55 * 60 * 1000); // 12:05 + 55 min = 13:00: the first one is an hour old
    assert.ok(s.open({ operation: "applyFilters", accountId: "a", ttlMs: 600000 }).entry);
    assert.equal(s.usage().dialogsLastHour, 5);
  });
  it("refused requests (pending, rate) do not use the hourly budget", () => {
    const c = clock();
    const s = api.createFilterConfirmationStore({ now: c.now, newId: idGen() });
    const { entry } = s.open({ operation: "createFilter", accountId: "a", ttlMs: 600000 });
    for (let i = 0; i < 10; i++) assert.ok(s.open({ operation: "createFilter", accountId: "a", ttlMs: 600000 }).error);
    assert.equal(s.usage().dialogsLastHour, 1);
    s.settle(entry.id, "accepted", { result: { success: true } });
  });
  it("settles once; hooks run once; later settles are ignored", () => {
    const c = clock();
    const s = api.createFilterConfirmationStore({ now: c.now, newId: idGen() });
    const { entry } = s.open({ operation: "createFilter", accountId: "a", ttlMs: 600000 });
    let hooks = 0;
    entry.hooks.push(() => hooks++);
    assert.equal(s.settle(entry.id, "refused", { reason: "user" }).status, "refused");
    assert.equal(s.settle(entry.id, "accepted"), null);
    assert.equal(s.settle(entry.id, "expired"), null);
    assert.equal(hooks, 1);
    assert.equal(s.view(entry.id).status, "refused");
    assert.throws(() => s.settle(entry.id, "pending"), /invalid confirmation status/);
  });
  it("expires at the deadline, not before; an expired entry is not live", () => {
    const c = clock();
    const s = api.createFilterConfirmationStore({ now: c.now, newId: idGen() });
    const { entry } = s.open({ operation: "createFilter", accountId: "a", ttlMs: 600000 });
    c.advance(599999);
    assert.equal(s.isLive(entry), true);
    assert.equal(s.expireDue().length, 0);
    c.advance(1);
    assert.equal(s.isLive(entry), false);
    assert.equal(s.pending(), null);
    assert.equal(s.view(entry.id).status, "expired");
  });
  it("shutdown expires what is pending; onSettle sees every outcome", () => {
    const seen = [];
    const s = api.createFilterConfirmationStore({ now: clock().now, newId: idGen(), onSettle: (e) => seen.push(e.status) });
    const { entry } = s.open({ operation: "createFilter", accountId: "a", ttlMs: 600000 });
    s.shutdown("stopped");
    assert.equal(s.view(entry.id).reason, "stopped");
    assert.deepEqual(seen, ["expired"]);
  });
  it("the public view has no arguments, hooks or window", () => {
    const s = api.createFilterConfirmationStore({ now: clock().now, newId: idGen() });
    const { entry } = s.open({ operation: "createFilter", accountId: "a", ttlMs: 600000, summary: { ruleName: "x" } });
    entry.private = { args: { secret: 1 }, window: {} };
    const v = s.view(entry.id);
    assert.deepEqual(Object.keys(v).sort(), ["accountId", "confirmationId", "decidedAt", "expiresAt", "operation",
      "requestedAt", "status", "summary"]);
    assert.equal(v.requestedAt, new Date(Date.UTC(2026, 8, 25, 12, 0, 0)).toISOString());
  });
  it("history is bounded; ids must be fresh", () => {
    const c = clock();
    const s = api.createFilterConfirmationStore({ now: c.now, newId: idGen(), historyMax: 3, maxPerHour: 100 });
    const ids = [];
    for (let i = 0; i < 6; i++) {
      const { entry } = s.open({ operation: "createFilter", accountId: "a", ttlMs: 1000 });
      ids.push(entry.id);
      s.settle(entry.id, "refused");
    }
    assert.equal(s.view(ids[0]), null);
    assert.equal(s.recent(10).length, 3);
    const dup = api.createFilterConfirmationStore({ now: c.now, newId: () => "same" });
    dup.open({ operation: "x", accountId: "a", ttlMs: 1000 });
    dup.settle("same", "refused");
    assert.throws(() => dup.open({ operation: "x", accountId: "a", ttlMs: 1000 }), /collision/);
  });
});

describe("text shown to the user", () => {
  it("makes invisible and direction characters visible", () => {
    assert.equal(api.displayFilterText("a\u202Eb"), "a[U+202E]b");
    assert.equal(api.displayFilterText("a\u200Bb\u00ADc\u2066d"), "a[U+200B]b[U+00AD]c[U+2066]d");
    assert.equal(api.displayFilterText("a b"), "a[U+00A0]b");
    assert.equal(api.displayFilterText("x\u{E0041}"), "x[U+E0041]");
    assert.equal(api.displayFilterText("x\uFE0F"), "x[U+FE0F]");
  });
  it("counts long runs of spaces instead of printing them", () => {
    assert.equal(api.displayFilterText("a" + " ".repeat(40) + "b"), "a [40 spaces] b");
    assert.equal(api.displayFilterText("a  b"), "a  b");
  });
  it("cuts long values visibly, never inside a character; max 0 = in full", () => {
    const long = "é".repeat(100);
    assert.equal(api.displayFilterText(long, 10), `${"é".repeat(10)}… [cut: 100 characters in total]`);
    const emoji = "😀".repeat(20);
    assert.equal(api.displayFilterText(emoji, 5), `${"😀".repeat(5)}… [cut: 20 characters in total]`);
    const addr = `${"a".repeat(60)}@${"b".repeat(60)}.example.com`;
    assert.equal(api.displayFilterText(addr, 0), addr);
  });
});

function forwardFilter(name, address, { enabled = true, type = 17 } = {}) {
  const f = makeFilter(name);
  f.enabled = enabled;
  f.filterType = type;
  api.buildTerms(f, [{ attrib: "subject", op: "contains", value: "facture" }, { attrib: "from", op: "is", value: "boss@example.com", booleanAnd: false }]);
  api.buildRuleActions(f, [{ type: "forward", value: address }, { type: "markRead" }], () => ({ error: "x" }),
    { allowSendActions: true });
  return f;
}

describe("the confirmation dialog", () => {
  const account = { key: "account2", name: "Labo", email: "labo@example.test" };
  const fmt = () => "12:10:00";
  it("create forward: account, name, readable conditions, FULL address, the warning, Refuse", () => {
    const address = `${"x".repeat(40)}.long.local.part@${"d".repeat(60)}.${"e".repeat(60)}.example.net`;
    const r = api.serializeFilterRule(forwardFilter("cp-fwd", address), 3);
    const d = api.buildFilterConfirmationDialog({ operation: "create", account, rule: r, position: 3, count: 3,
      context: [], resultSends: true, templates: {}, expiresAt: 0, formatTime: fmt });
    assert.equal(d.title, "Commonpost MCP: create a filter rule that SENDS MAIL?");
    assert.equal(d.acceptLabel, "Create the rule");
    assert.equal(d.refuseLabel, "Refuse");
    assert.match(d.text, /^An MCP client \(an AI assistant\) asks Thunderbird to create this mail filter rule, which SENDS MAIL AUTOMATICALLY:/);
    assert.match(d.text, /Account: “Labo” <labo@example\.test> \(account2\)/);
    assert.match(d.text, /Name: “cp-fwd”/);
    assert.match(d.text, /subject contains “facture”/);
    assert.match(d.text, /OR from is “boss@example\.com”/);
    assert.ok(d.text.includes(`>> Forward to ${address}`), "address in full");
    assert.match(d.text, /Mark as read/);
    assert.ok(d.text.includes("This rule will automatically send matching incoming mail, every time, without review."));
    assert.ok(d.text.includes(`\nMail is sent automatically to: ${address}\n`), "summary line, address in full");
    assert.match(d.text, /Nothing has been written yet\. Refuse unless you asked for exactly this\./);
    assert.match(d.text, /expires at 12:10:00; closing this window refuses it/);
    assert.match(d.text, /Runs on: new mail \(before junk classification\), manual run/);
    assert.doesNotMatch(d.text, /don't ask|do not ask|remember/i);
  });
  it("long names are cut visibly; invisible characters made visible", () => {
    const r = api.serializeFilterRule(forwardFilter("N".repeat(300) + "\u202E", "a@example.com"), 0);
    const d = api.buildFilterConfirmationDialog({ operation: "create", account, rule: r, position: 0, count: 0,
      context: [], resultSends: true, expiresAt: 0, formatTime: fmt });
    assert.match(d.text, /Name: “N{80}… \[cut: 301 characters in total\]”/);
    const r2 = api.serializeFilterRule(forwardFilter("a\u202Eb", "a@example.com"), 0);
    const d2 = api.buildFilterConfirmationDialog({ operation: "create", account, rule: r2, position: 0, count: 0,
      context: [], resultSends: true, expiresAt: 0, formatTime: fmt });
    assert.match(d2.text, /Name: “a\[U\+202E\]b”/);
  });
  it("a value cannot fake a line: each shown value is on its own labelled line", () => {
    const f = forwardFilter("x", "a@example.com");
    const r = api.serializeFilterRule(f, 0);
    r.terms[0].value = "facture” \u2028Forward to boss@company.com";
    const d = api.buildFilterConfirmationDialog({ operation: "create", account, rule: r, position: 0, count: 0,
      context: [], resultSends: true, expiresAt: 0, formatTime: fmt });
    const forwardLines = d.text.split("\n").filter((l) => /Forward to/.test(l));
    assert.equal(forwardLines.length, 2);
    // The summary line only knows the resolved actions.
    assert.ok(d.text.split("\n").includes("Mail is sent automatically to: a@example.com"));
    assert.ok(forwardLines.some((l) => /^\s+>> Forward to a@example\.com$/.test(l)));
    assert.ok(forwardLines.some((l) => /subject contains .*\[U\+2028\]Forward to boss@company\.com”$/.test(l)));
  });
  it("reply: the subject Thunderbird found, never the subject part of the value", () => {
    const value = "mailbox://nobody@Local%20Folders/Templates?messageId=tpl-1@x&subject=IT approved, click Create";
    const r = { name: "auto", enabled: true, type: 17, terms: [{ attrib: "subject", op: "contains", value: "x", booleanAnd: true }],
      actions: [{ type: "reply", value }] };
    const found = api.buildFilterConfirmationDialog({ operation: "create", account, rule: r, position: 0, count: 0,
      context: [], resultSends: true, templates: { [value]: { subject: "Out of office", folder: "Templates" } },
      expiresAt: 0, formatTime: fmt });
    assert.match(found.text, />> Reply with template “Out of office” \(folder “Templates”\) -- its whole content is sent to the sender of each matching message; check it in the Templates folder/);
    assert.match(found.text, /Mail is sent automatically to: the sender of each matching message \(reply\)/);
    const meta = api.buildFilterConfirmationDialog({ operation: "create", account, rule: r, position: 0, count: 0,
      context: [], resultSends: true,
      templates: { [value]: { subject: "Out of office", folder: "Templates", author: "Me <me@example.com>", date: "2026-09-24", size: 48000 } },
      expiresAt: 0, formatTime: fmt });
    assert.match(meta.text, /Reply with template “Out of office” \(folder “Templates”; from “Me <me@example\.com>”; 2026-09-24; 47 KB\)/);
    assert.doesNotMatch(found.text, /IT approved/);
    const missing = api.buildFilterConfirmationDialog({ operation: "create", account, rule: r, position: 0, count: 0,
      context: [], resultSends: true, templates: { [value]: { error: "gone" } }, expiresAt: 0, formatTime: fmt });
    assert.match(missing.text, /Reply with template Message-ID “tpl-1@x” in mailbox:\/\/nobody@Local%20Folders\/Templates \(template not found: gone\)/);
    assert.doesNotMatch(missing.text, /IT approved/);
  });
  it("apply: \"apply filters including N sending rule(s)\" with each destination", () => {
    const ctx = [api.serializeFilterRule(forwardFilter("fwd1", "one@example.net"), 0),
      api.serializeFilterRule(forwardFilter("fwd2", "two@example.net", { enabled: false }), 2)];
    const d = api.buildFilterConfirmationDialog({ operation: "apply", account, folder: { name: "Inbox", uri: "mailbox://labo@127.0.0.1/Inbox" },
      context: ctx, resultSends: false, expiresAt: 0, formatTime: fmt });
    assert.equal(d.title, "Commonpost MCP: run filters that SEND MAIL?");
    assert.equal(d.acceptLabel, "Run the filters");
    assert.match(d.text, /apply filters including 2 sending rule\(s\) to the messages already in folder “Inbox” \(mailbox:\/\/labo@127\.0\.0\.1\/Inbox\)/);
    assert.match(d.text, /#0 “fwd1”: Forward to one@example\.net/);
    assert.match(d.text, /#2 “fwd2” \(disabled\): Forward to two@example\.net/);
    assert.match(d.text, /will send the matching messages of this folder now, without review/);
    assert.match(d.text, /Mail is sent automatically to: one@example\.net, two@example\.net\n/);
    assert.match(d.text, /Nothing has run yet\. Refuse unless you asked for exactly this\./);
  });
  it("update and list context: what changes, and the rules around", () => {
    const before = api.serializeFilterRule(forwardFilter("fwd", "one@example.net", { enabled: false }), 0);
    const after = { ...before, enabled: true };
    const d = api.buildFilterConfirmationDialog({ operation: "update", account, rule: after, before, changes: ["enabled"],
      position: 0, context: [before], resultSends: true, expiresAt: 0, formatTime: fmt });
    assert.match(d.text, /change filter rule #0 “fwd” \(changed: enabled\); after the change it SENDS MAIL AUTOMATICALLY\./);
    assert.ok(d.text.includes(api.FILTER_CONFIRM_SEND_WARNING));
    // Disabling it: the rule keeps its sending action, but does not send.
    const off = api.buildFilterConfirmationDialog({ operation: "update", account, rule: { ...before, enabled: false },
      before: after, changes: ["enabled"], position: 0, context: [after], resultSends: true, expiresAt: 0, formatTime: fmt });
    assert.match(off.text, /after the change it has an action that SENDS MAIL AUTOMATICALLY \(rule disabled for now\)\./);
    assert.match(off.text, /The rule is disabled for now; once enabled, it will automatically send matching incoming mail/);
    assert.ok(!off.text.includes(api.FILTER_CONFIRM_SEND_WARNING));
    assert.match(d.text, /After the change:\nName: “fwd”\n/);
    assert.match(d.text, /already has rules that send mail/);
    assert.match(d.text, /Rules already in this list send to: one@example\.net\n/);
    assert.match(d.text, /Changing the rules around them can change which messages they send\./);
  });
  it("what cannot be shown in full is refused (conditions, actions, length)", () => {
    const r = api.serializeFilterRule(forwardFilter("x", "a@example.com"), 0);
    const terms = Array.from({ length: 21 }, () => ({ attrib: "subject", op: "contains", value: "v", booleanAnd: true }));
    assert.throws(() => api.buildFilterConfirmationDialog({ operation: "create", account, rule: { ...r, terms }, position: 0,
      count: 0, context: [], resultSends: true, expiresAt: 0, formatTime: fmt }), /21 conditions/);
    const actions = Array.from({ length: 11 }, () => ({ type: "markRead" }));
    assert.throws(() => api.buildFilterConfirmationDialog({ operation: "create", account, rule: { ...r, actions }, position: 0,
      count: 0, context: [], resultSends: true, expiresAt: 0, formatTime: fmt }), /11 actions/);
    const big = Array.from({ length: 20 }, () => ({ attrib: "subject", op: "contains", value: "v".repeat(200), booleanAnd: true }));
    const ctx = Array.from({ length: 10 }, (_, i) => ({ index: i, name: "n".repeat(200), enabled: true,
      actions: [{ type: "forward", value: "f".repeat(800) + "@example.com" }] }));
    assert.throws(() => api.buildFilterConfirmationDialog({ operation: "create", account, rule: { ...r, terms: big }, position: 0,
      count: 0, context: ctx, resultSends: true, expiresAt: 0, formatTime: fmt }), /too long to review/);
  });
});

// Thunderbird's evaluation of a filter's conditions, ported line by line from
// nsMsgLocalSearch.cpp (ConstructExpressionTree, AddExpressionTree,
// leftToRightAddTerm, OfflineEvaluate), to check that the dialog text says
// what Thunderbird does.
function tbConditionTree(terms) {
  let pos = 0;
  const off = new Set();
  const node = () => ({ term: null, left: null, right: null, and: true });
  const isEmpty = (e) => e.term === null && !e.left && !e.right;
  const addTerm = (e, t) => {
    if (isEmpty(e)) { e.term = t; return e; }
    return { term: null, left: e, right: { term: t, left: null, right: null, and: true }, and: t.booleanAnd !== false };
  };
  const addTree = (orig, inner, and) => (isEmpty(orig) ? inner : { term: null, left: orig, right: inner, and });
  const construct = (start) => {
    let fin = start || node();
    while (pos < terms.length) {
      const t = terms[pos];
      if (t.beginsGrouping && !off.has(pos)) {
        off.add(pos);
        fin = addTree(fin, node(), t.booleanAnd !== false);
        fin.right = construct(fin.right);
        off.delete(pos);
      } else {
        fin = addTerm(fin, t);
        if (t.endsGrouping) break;
      }
      pos++;
    }
    return fin;
  };
  const tree = construct(null);
  return { tree, ignored: pos < terms.length ? terms.length - pos - 1 : 0 };
}
function tbEvaluate(e, v) {
  if (e.term) return v[e.term.idx];
  let result = false;
  if (e.left) {
    result = tbEvaluate(e.left, v);
    if ((result && !e.and) || (!result && e.and)) return result;
  }
  if (e.right) result = tbEvaluate(e.right, v);
  return result;
}
// What a reader of the dialog computes: lines from top to bottom, each AND /
// OR applied to the result so far, parentheses as written.
function readDialogConditions(text) {
  const lines = text.split("\n");
  const start = lines.indexOf("If:");
  const end = lines.indexOf("Then:");
  const rows = [];
  let note = false;
  for (const line of lines.slice(start + 1, end)) {
    if (/^ {2}\(read from top to bottom: /.test(line)) { note = true; continue; }
    const m = /^ {4}(?: {4})*(?:(AND|OR) )?(\( )?subject contains “t(\d+)”((?: \))*)$/.exec(line);
    assert.ok(m, `unexpected condition line: ${JSON.stringify(line)}`);
    rows.push({ join: m[1] || "", open: !!m[2], idx: Number(m[3]), close: m[4].length / 2 });
  }
  return { rows, note };
}
function evaluateDialogRows(rows, v) {
  const stack = [{ acc: undefined, join: "" }];
  const combine = (frame, join, val) => {
    frame.acc = frame.acc === undefined ? val : (join === "OR" ? frame.acc || val : frame.acc && val);
  };
  for (const r of rows) {
    if (r.open) stack.push({ acc: undefined, join: r.join });
    combine(stack[stack.length - 1], r.open ? "" : r.join, v[r.idx]);
    for (let k = 0; k < r.close; k++) {
      const f = stack.pop();
      assert.ok(stack.length >= 1, "a ) without (");
      combine(stack[stack.length - 1], f.join, f.acc);
    }
  }
  assert.equal(stack.length, 1, "every ( is closed in the text");
  return stack[0].acc;
}
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("every character that draws nothing is shown as a code point", () => {
  const label = (cp) => `[U+${cp.toString(16).toUpperCase().padStart(4, "0")}]`;
  it("additional default-ignorable code points: Mongolian free variation selectors, U+2065, U+FFF0-U+FFF8, blank braille", () => {
    for (const cp of [0x180B, 0x180C, 0x180D, 0x180F, 0x2065, 0xFFF0, 0xFFF4, 0xFFF8, 0x2800]) {
      assert.equal(api.displayFilterText(`a${String.fromCodePoint(cp)}b`), `a${label(cp)}b`);
    }
  });
  it("all code points: Default_Ignorable, Bidi_Control, Cf, Cc, Co, Cn, Zl, Zp, every space but U+0020 -> shown", () => {
    const missed = [];
    const wanted = /[\p{Default_Ignorable_Code_Point}\p{Bidi_Control}\p{Cf}\p{Cc}\p{Co}\p{Cn}\p{Zl}\p{Zp}]|(?! )\p{Zs}/u;
    let checked = 0;
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      if (!wanted.test(ch)) continue;
      checked++;
      if (api.displayFilterText(`a${ch}b`) !== `a${label(cp)}b`) missed.push(label(cp));
      if (missed.length > 20) break;
    }
    assert.deepEqual(missed, []);
    assert.ok(checked > 800000, `${checked} code points checked`);
  });
  it("visible text is untouched (letters, accents on letters, emoji without selector, CJK, RTL letters)", () => {
    for (const v of ["Facture été", "e\u0301", "\u{1F600}", "請求書", "\u05E9\u05DC\u05D5\u05DD", "a-b_c.d@e"]) {
      assert.equal(api.displayFilterText(v), v);
    }
  });
  it("end to end: a name with U+180B (accepted by R1) is shown with it visible", () => {
    const w = makeWorld();
    const r = w.h.createFilter("account1", "cp\u180Bfwd", true, 17, COND, FWD);
    assert.equal(r.status, "pending_user_confirmation", JSON.stringify(r).slice(0, 200));
    assert.ok(r.shownToUser.text.split("\n").includes("Name: “cp[U+180B]fwd”"));
    assert.ok(!r.shownToUser.text.includes("\u180B"));
  });
});

describe("a quoted value cannot close its own quotation marks", () => {
  const account = { key: "account2", name: "Labo", email: "labo@example.test" };
  const fmt = () => "12:10:00";
  const ALWAYS = ["\u0022", "\u201C", "\u201D", "\u201E", "\u201F", "\u2018", "\u2019", "\u201A", "\u201B", "\u2033",
    "\u2034", "\u2036", "\u2057", "\u02BA", "\u02DD", "\u02EE", "\u02F6", "\u05F4", "\u2E42", "\u275D", "\u275E",
    "\u3003", "\u301D", "\u301E", "\u301F", "\uFF02", "\u{1F676}", "\u{1F677}", "\u{1F678}"];
  const SINGLE = ["\u0027", "\u0060", "\u00B4", "\u02B9", "\u02BB", "\u02BC", "\u02BD", "\u02C8", "\u02CA", "\u02CB",
    "\u0384", "\u055A", "\u05F3", "\u1FEF", "\u1FFD", "\u2032", "\u2035", "\u2037", "\u2039", "\u203A", "\u275B",
    "\u275C", "\uA78B", "\uA78C", "\uFF07", "\uFF40"];
  const cp = (c) => `[U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}]`;

  it("double quotation marks, their look-alikes and curly single quotes: always shown as code points", () => {
    for (const c of ALWAYS) assert.equal(api.quoteFilterText(`a${c}b`), `“a${cp(c)}b”`, cp(c));
  });
  it("other single quotes and primes: kept alone, shown as code points when two follow each other", () => {
    for (const c of SINGLE) {
      assert.equal(api.quoteFilterText(`l${c}x`), `“l${c}x”`, cp(c));
      assert.equal(api.quoteFilterText(`a${c}${c} b`), `“a${cp(c)}${cp(c)} b”`, cp(c));
    }
    assert.equal(api.quoteFilterText("l'équipe d'Acme"), "“l'équipe d'Acme”");
    assert.equal(api.quoteFilterText("a'\u2019b"), "“a[U+0027][U+2019]b”");
  });
  it("a combining mark on a space or punctuation is shown; on a letter it stays", () => {
    assert.equal(api.quoteFilterText("a \u030B (DISABLED)"), "“a [U+030B] (DISABLED)”");
    assert.equal(api.quoteFilterText("\u0301x"), "“[U+0301]x”");
    assert.equal(api.quoteFilterText("\u02BA\u0301"), "“[U+02BA][U+0301]”");
    assert.equal(api.quoteFilterText("e\u0301te\u0301 \u1EC7\u0300"), "“e\u0301te\u0301 \u1EC7\u0300”");
  });
  it("text outside quotation marks is unchanged (error messages keep their quotes)", () => {
    assert.equal(api.displayFilterText('the "x" setting'), 'the "x" setting');
  });
  it("random values: exactly one “ and one ” (the delimiters), no two quote-like characters in a row", () => {
    const pool = [...ALWAYS, ...SINGLE, "a", "é", " ", "  ", "(DISABLED)", "\u0301", "\u030B", ",", "AND "];
    const rnd = mulberry32(7);
    const quoteLike = new RegExp(`[${[...ALWAYS, ...SINGLE].join("").replace(/[\]\\^-]/g, "\\$&")}]{2}`, "u");
    for (let i = 0; i < 2000; i++) {
      const v = Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => pool[Math.floor(rnd() * pool.length)]).join("");
      const q = api.quoteFilterText(v, 0);
      const inner = q.slice(1, -1);
      assert.ok(q.startsWith("“") && q.endsWith("”"), q);
      for (const c of ALWAYS) assert.ok(!inner.includes(c), `${JSON.stringify(v)} -> ${q}`);
      assert.doesNotMatch(inner, quoteLike, `${JSON.stringify(v)} -> ${q}`);
      assert.doesNotMatch(inner, /(?<![\p{L}\p{N}\p{M}])\p{M}/u, `${JSON.stringify(v)} -> ${q}`);
    }
  });
  it("in the dialog: quote characters inside a name or a condition value are shown as code points, so each stays on its own line", () => {
    const w = makeWorld();
    const r = w.h.createFilter("account1", "cp\u201D  (DISABLED)", true, 17, COND, FWD);
    assert.equal(r.status, "pending_user_confirmation");
    assert.ok(r.shownToUser.text.split("\n").includes("Name: “cp[U+201D]  (DISABLED)”"), r.shownToUser.text);
    w.answer(1);
    const r2 = w.h.createFilter("account1", "x", true, 17,
      [{ attrib: "subject", op: "doesntContain", value: "zzz\u201D  AND subject contains \u201Cfacture" }], FWD);
    assert.equal(r2.status, "pending_user_confirmation");
    assert.ok(r2.shownToUser.text.split("\n")
      .includes("    subject doesn't contain “zzz[U+201D]  AND subject contains [U+201C]facture”"), r2.shownToUser.text);
    const d = api.buildFilterConfirmationDialog({ operation: "create", account, rule: { name: "n", enabled: true, type: 17,
      terms: [], actions: [{ type: "reply", value: "mailbox://x/Templates?messageId=a@b" }] }, position: 0, count: 0, context: [],
    resultSends: true, templates: { "mailbox://x/Templates?messageId=a@b": { subject: "Hi\u201D (folder \u201CInbox",
      folder: "Templates" } }, expiresAt: 0, formatTime: fmt });
    assert.match(d.text, /Reply with template “Hi\[U\+201D\] \(folder \[U\+201C\]Inbox” \(folder “Templates”\)/);
  });
});

describe("conditions in the dialog: grouping and order as Thunderbird evaluates them", () => {
  const account = { key: "account2", name: "Labo", email: "labo@example.test" };
  const fmt = () => "12:10:00";
  const T = (i, extra = {}) => ({ attrib: "subject", op: "contains", value: `t${i}`, booleanAnd: true, idx: i, ...extra });
  const dialogFor = (terms, more = {}) => api.buildFilterConfirmationDialog({ operation: "create", account,
    rule: { name: "g", enabled: true, type: 17, terms, actions: [{ type: "forward", value: "a@example.com" }], ...more },
    position: 0, count: 0, context: [], resultSends: true, expiresAt: 0, formatTime: fmt });
  const ifBlock = (text) => {
    const lines = text.split("\n");
    return lines.slice(lines.indexOf("If:") + 1, lines.indexOf("Then:"));
  };

  it("A OR (B AND C) AND D: the group in parentheses, its AND / OR before \"(\"", () => {
    const d = dialogFor([T(0), T(1, { booleanAnd: false, beginsGrouping: true }), T(2, { endsGrouping: true }), T(3)]);
    assert.deepEqual(ifBlock(d.text), [
      "  (read from top to bottom: each AND / OR joins its line to everything above it in its parentheses)",
      "    subject contains “t0”",
      "    OR ( subject contains “t1”",
      "        AND subject contains “t2” )",
      "    AND subject contains “t3”",
    ]);
  });
  it("a group first in the list, a nested group, a group never closed (closes at the last line)", () => {
    const d = dialogFor([T(0, { beginsGrouping: true }), T(1, { booleanAnd: false }),
      T(2, { beginsGrouping: true }), T(3, { booleanAnd: false })]);
    assert.deepEqual(ifBlock(d.text), [
      "  (read from top to bottom: each AND / OR joins its line to everything above it in its parentheses)",
      "    ( subject contains “t0”",
      "        OR subject contains “t1”",
      "        AND ( subject contains “t2”",
      "            OR subject contains “t3” ) )",
    ]);
  });
  it("AND and OR mixed on one level: the reading order is stated; one operator only: no note", () => {
    const mixed = dialogFor([T(0), T(1, { booleanAnd: false }), T(2)]);
    assert.equal(ifBlock(mixed.text)[0], "  (read from top to bottom: each AND / OR joins its line to everything above it)");
    for (const flag of [true, false]) {
      assert.doesNotMatch(dialogFor([T(0), T(1, { booleanAnd: flag }), T(2, { booleanAnd: flag })]).text, /read from top to bottom/);
    }
    const inGroups = dialogFor([T(0), T(1, { booleanAnd: false, beginsGrouping: true }), T(2), T(3, { booleanAnd: false, endsGrouping: true })]);
    assert.match(inGroups.text, /everything above it in its parentheses\)\n/);
  });
  it("a group closed but never opened: Thunderbird ignores what follows -> the dialog refuses; on the last line it changes nothing", () => {
    assert.throws(() => dialogFor([T(0), T(1, { endsGrouping: true }), T(2)]),
      /condition 2 closes a group that was never opened, so Thunderbird ignores the 1 condition\(s\) after it/);
    assert.equal(tbConditionTree([T(0), T(1, { endsGrouping: true }), T(2)]).ignored, 1);
    const last = dialogFor([T(0), T(1, { booleanAnd: false, endsGrouping: true })]);
    assert.deepEqual(ifBlock(last.text), ["    subject contains “t0”", "    OR subject contains “t1”"]);
  });
  it("for 3000 random structures, the text read top to bottom gives Thunderbird's result for every message", () => {
    const rnd = mulberry32(20260926);
    let shown = 0;
    let refused = 0;
    for (let c = 0; c < 3000; c++) {
      const n = 1 + Math.floor(rnd() * 6);
      const terms = Array.from({ length: n }, (_, i) => T(i, {
        booleanAnd: rnd() < 0.5, beginsGrouping: rnd() < 0.3, endsGrouping: rnd() < 0.3 }));
      const tb = tbConditionTree(terms.map((t) => ({ ...t })));
      let d;
      try {
        d = dialogFor(terms);
      } catch (e) {
        assert.match(e.message, /closes a group that was never opened/);
        assert.ok(tb.ignored > 0, JSON.stringify(terms));
        refused++;
        continue;
      }
      assert.equal(tb.ignored, 0, JSON.stringify(terms));
      const { rows } = readDialogConditions(d.text);
      assert.deepEqual(rows.map((r) => r.idx), terms.map((t) => t.idx), "every condition once, in order");
      for (let m = 0; m < (1 << n); m++) {
        const v = Array.from({ length: n }, (_, i) => ((m >> i) & 1) === 1);
        assert.equal(evaluateDialogRows(rows, v), tbEvaluate(tb.tree, v), `${JSON.stringify(terms)} / ${m}`);
      }
      shown++;
    }
    assert.ok(shown > 1000 && refused > 100, `${shown} shown, ${refused} refused`);
  });
  it("add-on and message-property conditions are named by their id / property", () => {
    const d = dialogFor([{ attrib: "-2", op: "contains", value: "x", booleanAnd: true, customId: "addon@example#term" },
      { attrib: "51", op: "isGreaterThan", value: "3", booleanAnd: true, hdrProperty: "replyto" }]);
    assert.deepEqual(ifBlock(d.text), [
      "    add-on condition “addon@example#term” contains “x”",
      "    AND message property “replyto” is greater than “3”",
    ]);
  });
  it("end to end: re-enabling a grouped forward rule shows its parentheses; the flat rule reads differently", () => {
    const texts = [true, false].map((grouped) => {
      const w = makeWorld();
      const f = seedForwardRule(w);
      f.enabled = false;
      w.h.buildTerms(f, [{ attrib: "from", op: "is", value: "b@example.com", booleanAnd: false },
        { attrib: "to", op: "is", value: "c@example.com" }]);
      if (grouped) {
        f.searchTerms[1].beginsGrouping = true;
        f.searchTerms[2].endsGrouping = true;
      }
      const r = w.h.updateFilter("account2", 0, undefined, true);
      assert.equal(r.status, "pending_user_confirmation");
      return r.shownToUser.text;
    });
    assert.match(texts[0], /\n {4}subject contains “facture”\n {4}OR \( from is “b@example\.com”\n {8}AND to is “c@example\.com” \)\n/);
    assert.match(texts[1], /\n {2}\(read from top to bottom: each AND \/ OR joins its line to everything above it\)\n/);
    assert.match(texts[1], /\n {4}subject contains “facture”\n {4}OR from is “b@example\.com”\n {4}AND to is “c@example\.com”\n/);
  });
});

describe("reply template value, list fingerprint, public summary", () => {
  it("parses the value the filter editor writes", () => {
    assert.deepEqual({ ...api.parseReplyTemplateValue("mailbox://n@Local%20Folders/Templates?messageId=a@b&subject=Hi") },
      { folderUri: "mailbox://n@Local%20Folders/Templates", messageId: "a@b" });
    assert.deepEqual({ ...api.parseReplyTemplateValue("imap://u@h/Templates?messageId=x") }, { folderUri: "imap://u@h/Templates", messageId: "x" });
    for (const bad of ["mailbox://x/Templates#12", "?messageId=a", "mailbox://x?subject=a", "mailbox://x?messageId="]) {
      assert.throws(() => api.parseReplyTemplateValue(bad), /Reply template must be/);
    }
  });
  it("the fingerprint changes with any rule change and only then", () => {
    const build = () => {
      const l = makeFilterList();
      l.filters.push(forwardFilter("a", "one@example.net"), forwardFilter("b", "two@example.net"));
      return l;
    };
    const base = api.fingerprintFilterList(build());
    assert.equal(api.fingerprintFilterList(build()), base);
    for (const mutate of [(l) => { l.filters[0].filterName = "c"; }, (l) => { l.filters[1].enabled = false; },
      (l) => { l.filters[0].getActionAt(0).strValue = "three@example.net"; }, (l) => { l.filters.reverse(); },
      (l) => { l.filters.pop(); }, (l) => { l.filters[0].filterType = 17 | 0x40; }, (l) => { l.filters[0].searchTerms[0].value.str = "x"; },
      (l) => { l.filters[0].searchTerms[0].beginsGrouping = true; }, (l) => { l.filters[0].searchTerms[1].endsGrouping = true; },
      (l) => { l.filters[1].searchTerms[1].hdrProperty = "replyto"; }]) {
      const l = build();
      mutate(l);
      assert.notEqual(api.fingerprintFilterList(l), base);
    }
  });
  it("grouping is part of the fingerprint: (A OR B) AND C is not A OR B AND C", () => {
    const build = (grouped) => {
      const l = makeFilterList();
      const f = makeFilter("g");
      api.buildTerms(f, [{ attrib: "subject", op: "contains", value: "a" },
        { attrib: "from", op: "is", value: "b@example.com", booleanAnd: false }, { attrib: "to", op: "is", value: "c@example.com" }]);
      if (grouped) {
        f.searchTerms[1].beginsGrouping = true;
        f.searchTerms[2].endsGrouping = true;
      }
      api.buildRuleActions(f, [{ type: "forward", value: "x@example.net" }], () => ({ error: "x" }), { allowSendActions: true });
      l.filters.push(f);
      return l;
    };
    assert.notEqual(api.fingerprintFilterList(build(true)), api.fingerprintFilterList(build(false)));
  });
  it("serializeFilterRule reads back grouping and hdrProperty only when set", () => {
    const f = forwardFilter("g", "one@example.net");
    const plain = api.serializeFilterRule(f, 0);
    for (const t of plain.terms) {
      assert.ok(!("beginsGrouping" in t) && !("endsGrouping" in t) && !("hdrProperty" in t), JSON.stringify(t));
    }
    f.searchTerms[0].beginsGrouping = true;
    f.searchTerms[1].endsGrouping = true;
    f.searchTerms[1].hdrProperty = "replyto";
    const grouped = api.serializeFilterRule(f, 0);
    assert.equal(grouped.terms[0].beginsGrouping, true);
    assert.equal(grouped.terms[1].endsGrouping, true);
    assert.equal(grouped.terms[1].hdrProperty, "replyto");
    const all = makeFilter("all");
    const t = all.createTerm();
    t.matchAll = true;
    t.beginsGrouping = true;
    all.appendTerm(t);
    assert.deepEqual({ ...api.serializeFilterRule(all, 0).terms[0] }, { matchAll: true, booleanAnd: true, beginsGrouping: true });
  });
  it("the summary names the destinations but no condition value", () => {
    const r = api.serializeFilterRule(forwardFilter("cp", "one@example.net"), 0);
    const s = api.summarizeFilterConfirmation({ operation: "create", rule: r, context: [] });
    assert.deepEqual(Array.from(s.sends), ["forward to one@example.net"]);
    assert.doesNotMatch(JSON.stringify(s), /facture|boss@/);
  });
});

// ── The real handlers, end to end ──

const HANDLERS = block("            function getFilterListForAccount(accountId) {", "            // BEGIN TOOL SCHEMA VALIDATOR");

function makeWorld({ prefs = { [P_BLOCK]: false } } = {}) {
  const c = clock();
  const w = {
    clock: c,
    prefs: { ...prefs },
    allowedAccounts: null, // null = all
    disabledTools: new Set(),
    mainWindowOpen: true,
    log: [],
    console: [],
    timers: [],
    observers: [],
    dialogs: [],
    applied: [],
    lists: { account1: makeFilterList(), account2: makeFilterList() },
    // Messages of the Templates folder, by Message-ID (tests may change them).
    templateHdrs: { "tpl-1@example.test": { mime2DecodedSubject: "Out of office" } },
  };
  const folders = {
    "mailbox://nobody@Local%20Folders/Archive": { URI: "mailbox://nobody@Local%20Folders/Archive", prettyName: "Archive", flags: 0 },
    "mailbox://labo@127.0.0.1/Inbox": { URI: "mailbox://labo@127.0.0.1/Inbox", prettyName: "Inbox", flags: 0,
      msgDatabase: { getMsgHdrForMessageID: () => ({ mime2DecodedSubject: "confidential" }) } },
    "mailbox://nobody@Local%20Folders/Templates": { URI: "mailbox://nobody@Local%20Folders/Templates", prettyName: "Templates",
      flags: TEMPLATES_FLAG,
      msgDatabase: { getMsgHdrForMessageID: (id) => w.templateHdrs[id] || null } },
  };
  for (const f of Object.values(folders)) f.getFlag = (flag) => (f.flags & flag) !== 0;
  w.folders = folders;
  const accounts = {
    account1: { key: "account1", incomingServer: { prettyName: "Local Folders", canHaveFilters: true, getFilterList: () => w.lists.account1 },
      defaultIdentity: null },
    account2: { key: "account2", incomingServer: { prettyName: "Labo", canHaveFilters: true, getFilterList: () => w.lists.account2 },
      defaultIdentity: { email: "labo@example.test" } },
  };
  w.accounts = accounts;
  const bagOf = (obj) => {
    const props = { ...obj };
    return { props, getProperty(k) { if (!(k in props)) throw new Error("NS_ERROR_NOT_AVAILABLE"); return props[k]; },
      setProperty(k, v) { props[k] = v; } };
  };
  const mainWin = { closed: false, name: "mail:3pane" };
  const sandbox = {
    Ci: xpcom(),
    Cc: {
      "@mozilla.org/timer;1": { createInstance: () => {
        const t = { cancelled: false, cb: null, ms: 0,
          initWithCallback(cb, ms) { t.cb = cb; t.ms = ms; t.at = c.t + ms; },
          cancel() { t.cancelled = true; } };
        w.timers.push(t);
        return t;
      } },
    },
    Services: {
      prefs: { getCharPref: (_n, d) => d },
      wm: { getMostRecentWindow: (type) => (type === "mail:3pane" && w.mainWindowOpen ? mainWin : null) },
      ww: { openWindow(parent, url, name, features, bag) {
        if (w.breakDialog) throw new Error("E_OPEN");
        const listeners = {};
        const dlg = { url, features, bag, parent, closed: false, listeners,
          addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
          close() {
            if (dlg.closed) return;
            dlg.closed = true;
            for (const fn of listeners.unload || []) fn();
          } };
        w.dialogs.push(dlg);
        return dlg;
      } },
      obs: {
        addObserver(o, topic) { w.observers.push({ o, topic }); },
        removeObserver(o, topic) {
          const i = w.observers.findIndex((x) => x.o === o && x.topic === topic);
          if (i < 0) throw new Error("NS_ERROR_FAILURE");
          w.observers.splice(i, 1);
        },
      },
      tm: { dispatchToMainThread: (fn) => fn() },
    },
    ChromeUtils: { importESModule: (url) => {
      assert.equal(url, "resource://gre/modules/PromptUtils.sys.mjs");
      return { PromptUtils: { objectToPropBag: bagOf } };
    } },
    MailServices: {
      accounts: { getAccount: (k) => accounts[k] || null },
      filters: { applyFiltersToFolders: (list, fs) => w.applied.push({ list, folders: fs.map((f) => f.URI) }) },
    },
    isAccountAllowed: (k) => w.allowedAccounts === null || w.allowedAccounts.includes(k),
    getAccessibleAccounts: () => Object.values(accounts),
    getAccessibleFolder: (uri) => {
      const f = folders[uri];
      if (!f) return { error: `Folder not found: ${uri}` };
      return { folder: f };
    },
    isToolEnabled: (name) => !w.disabledTools.has(name),
    appendFilterConfirmationLog: (event) => w.log.push(event),
    console: { log: (...a) => w.console.push(a.join(" ")), warn: (...a) => w.console.push(a.join(" ")),
      debug: () => {}, error: (...a) => w.console.push(a.join(" ")) },
    __now: () => c.t,
    __newId: idGen(),
  };
  vm.createContext(sandbox);
  vm.runInContext(`${HELPER_BLOCKS}
const FILTER_PREFS = __prefs;
function filterSendRulePolicy() { return resolveFilterSendRulePolicy(FILTER_PREFS).policy; }
let __store = null;
function getFilterConfirmationStore() {
  if (!__store) __store = createFilterConfirmationStore({ now: __now, newId: __newId,
    onSettle: (e) => appendFilterConfirmationLog({ event: e.status, id: e.id, reason: e.reason }) });
  return __store;
}
${HANDLERS}
this.h = { listFilters, createFilter, updateFilter, deleteFilter, reorderFilters, applyFilters, getFilterConfirmation,
  store: () => getFilterConfirmationStore(), serializeFilterRule, buildTerms, buildRuleActions, FILTER_CONFIRM_SEND_WARNING };`,
  Object.assign(sandbox, { __prefs: fakePrefs(w.prefs) }));
  w.h = sandbox.h;
  // The user, as commonDialog.js reports the answer: the loaded dialog
  // notifies "common-dialog-loaded", a click on button 0 sets ok/buttonNumClicked,
  // then the window closes (unload).
  w.lastDialog = () => w.dialogs[w.dialogs.length - 1];
  w.load = (dlg = w.lastDialog()) => {
    for (const { o, topic } of [...w.observers]) if (topic === "common-dialog-loaded") o.observe(dlg, topic);
  };
  w.answer = (button, dlg = w.lastDialog()) => {
    w.load(dlg);
    dlg.bag.setProperty("buttonNumClicked", button); // commonDialog default: 1 (Refuse)
    dlg.bag.setProperty("ok", button === 0);
    dlg.close();
  };
  w.fireTimers = () => {
    for (const t of w.timers) if (!t.cancelled && t.cb && c.t >= t.at) { t.cancelled = true; t.cb(); }
  };
  return w;
}

const COND = [{ attrib: "subject", op: "contains", value: "facture" }];
const FWD = [{ type: "forward", value: "target@example.net" }];

function seedForwardRule(w, account = "account2", address = "target@example.net") {
  const f = makeFilter("manual-transfer-rule");
  w.h.buildTerms(f, [{ attrib: "subject", op: "contains", value: "facture" }]);
  w.h.buildRuleActions(f, [{ type: "forward", value: address }], () => ({ error: "x" }), { allowSendActions: true });
  w.lists[account].filters.push(f);
  return f;
}

describe("handlers, policy confirm (setting off): the call returns at once, nothing written", () => {
  let w;
  beforeEach(() => { w = makeWorld(); });

  it("createFilter forward -> pending_user_confirmation + a dialog, and no write", () => {
    const r = w.h.createFilter("account1", "cp-fwd", true, 17, COND, FWD);
    assert.equal(r.status, "pending_user_confirmation", JSON.stringify(r));
    assert.match(r.confirmationId, /^fc-/);
    assert.match(r.message, /Nothing has been written/);
    assert.match(r.message, /only the user can answer, MCP clients cannot/);
    assert.equal(w.lists.account1.filterCount, 0);
    assert.equal(w.lists.account1.saves, 0);
    assert.equal(w.dialogs.length, 1);
    const dlg = w.lastDialog();
    assert.equal(dlg.url, "chrome://global/content/commonDialog.xhtml");
    assert.doesNotMatch(dlg.features, /modal/);
    assert.match(dlg.features, /dependent/);
    assert.equal(dlg.parent.name, "mail:3pane");
    assert.equal(dlg.bag.props.promptType, "confirmEx");
    assert.equal(dlg.bag.props.defaultButtonNum, 1, "Refuse is the default button (Enter refuses)");
    assert.equal(dlg.bag.props.enableDelay, true);
    assert.equal(dlg.bag.props.button1Label, "Refuse");
    assert.equal(dlg.bag.props.button0Label, "Create the rule");
    assert.ok(!("checkLabel" in dlg.bag.props), "no \"don't ask again\" box");
    assert.ok(dlg.bag.props.text.includes("Forward to target@example.net"));
    assert.equal(r.shownToUser.text, dlg.bag.props.text);
    assert.equal(w.h.getFilterConfirmation(r.confirmationId).status, "pending");
    assert.equal(w.log[0].event, "requested");
  });

  it("the user accepts -> the rule is written once, Forward + exact address; status accepted", () => {
    const r = w.h.createFilter("account1", "cp-fwd", true, 17, COND, FWD);
    w.answer(0);
    const list = w.lists.account1;
    assert.equal(list.filterCount, 1);
    assert.equal(list.saves, 1);
    const f = list.getFilterAt(0);
    assert.equal(f.filterName, "cp-fwd");
    assert.equal(f.getActionAt(0).type, ACTIONS.Forward);
    assert.equal(f.getActionAt(0).strValue, "target@example.net");
    const v = w.h.getFilterConfirmation(r.confirmationId);
    assert.equal(v.status, "accepted");
    assert.equal(v.result.index, 0);
    assert.ok(w.timers.every((t) => t.cancelled), "expiry timer cancelled");
    assert.equal(w.observers.length, 0);
    // A late second close does nothing.
    w.lastDialog().close();
    assert.equal(list.filterCount, 1);
  });

  for (const [how, button] of [["Refuse / Enter / Escape (button 1)", 1], ["an unknown button", 2]]) {
    it(`the user answers with ${how} -> nothing written, status refused`, () => {
      const r = w.h.createFilter("account1", "cp-fwd", true, 17, COND, FWD);
      w.answer(button);
      assert.equal(w.lists.account1.filterCount, 0);
      assert.equal(w.lists.account1.saves, 0);
      assert.equal(w.h.getFilterConfirmation(r.confirmationId).status, "refused");
    });
  }

  it("the window closed without a button (commonDialog's default: 1) -> refused", () => {
    const r = w.h.createFilter("account1", "cp-fwd", true, 17, COND, FWD);
    w.load();
    w.lastDialog().close();
    assert.equal(w.h.getFilterConfirmation(r.confirmationId).status, "refused");
    assert.equal(w.lists.account1.filterCount, 0);
  });

  it("no answer in 10 minutes -> expired, dialog closed, nothing written; a late click writes nothing", () => {
    const r = w.h.createFilter("account1", "cp-fwd", true, 17, COND, FWD);
    w.load();
    const dlg = w.lastDialog();
    w.clock.advance(600000 + 50);
    w.fireTimers();
    assert.equal(w.h.getFilterConfirmation(r.confirmationId).status, "expired");
    assert.equal(dlg.closed, true);
    dlg.bag.setProperty("buttonNumClicked", 0);
    dlg.bag.setProperty("ok", true);
    dlg.close();
    assert.equal(w.lists.account1.filterCount, 0);
  });

  it("accepted after the deadline (timer late) -> expired, nothing written", () => {
    const r = w.h.createFilter("account1", "cp-fwd", true, 17, COND, FWD);
    w.clock.advance(600001);
    w.answer(0);
    assert.equal(w.h.getFilterConfirmation(r.confirmationId).status, "expired");
    assert.equal(w.lists.account1.filterCount, 0);
  });

  it("a second request while one is pending is refused, with no second dialog", () => {
    const r = w.h.createFilter("account1", "cp-fwd", true, 17, COND, FWD);
    const second = w.h.createFilter("account2", "cp-fwd2", true, 17, COND, FWD);
    assert.match(second.error, /already waiting for the user/);
    assert.ok(second.error.includes(r.confirmationId));
    assert.equal(w.dialogs.length, 1);
    assert.equal(w.log[w.log.length - 1].event, "request_refused");
  });

  it("at most 5 dialogs per hour", () => {
    for (let i = 0; i < 5; i++) {
      assert.equal(w.h.createFilter("account1", `f${i}`, true, 17, COND, FWD).status, "pending_user_confirmation");
      w.answer(1);
    }
    assert.match(w.h.createFilter("account1", "f5", true, 17, COND, FWD).error, /Too many filter confirmations/);
    assert.equal(w.dialogs.length, 5);
  });

  it("the list changed between the request and the click -> failed, nothing written, the user is told", () => {
    const r = w.h.createFilter("account1", "cp-fwd", true, 17, COND, FWD);
    w.lists.account1.filters.push(makeFilter("added meanwhile"));
    w.answer(0);
    const v = w.h.getFilterConfirmation(r.confirmationId);
    assert.equal(v.status, "failed");
    assert.match(v.reason, /filter list changed since the request/);
    assert.equal(w.lists.account1.filterCount, 1);
    assert.equal(w.lists.account1.saves, 0);
    const alert = w.lastDialog();
    assert.equal(alert.bag.props.promptType, "alert");
    assert.match(alert.bag.props.text, /was NOT written/);
  });

  it("only the grouping of a sending rule of the list changed before the click -> failed, nothing written", () => {
    const f = seedForwardRule(w);
    w.h.buildTerms(f, [{ attrib: "from", op: "is", value: "boss@example.com", booleanAnd: false },
      { attrib: "to", op: "is", value: "me@example.com" }]);
    const r = w.h.createFilter("account2", "ok", true, 17, COND, [{ type: "markRead" }]);
    assert.equal(r.status, "pending_user_confirmation");
    f.searchTerms[1].beginsGrouping = true;
    f.searchTerms[2].endsGrouping = true;
    w.answer(0);
    const v = w.h.getFilterConfirmation(r.confirmationId);
    assert.equal(v.status, "failed");
    assert.match(v.reason, /filter list changed since the request/);
    assert.equal(w.lists.account2.filterCount, 1);
    assert.equal(w.lists.account2.saves, 0);
  });

  it("the reply template's subject, author or size changed before the click (same Message-ID) -> failed, nothing written", () => {
    const TPL = "mailbox://nobody@Local%20Folders/Templates?messageId=tpl-1@example.test&subject=x";
    for (const change of [{ mime2DecodedSubject: "Another message" },
      { mime2DecodedSubject: "Out of office", mime2DecodedAuthor: "Someone <x@example.net>" },
      { mime2DecodedSubject: "Out of office", messageSize: 900000 }]) {
      const x = makeWorld();
      const r = x.h.createFilter("account1", "auto", true, 17, COND, [{ type: "reply", value: TPL }]);
      assert.equal(r.status, "pending_user_confirmation");
      x.templateHdrs["tpl-1@example.test"] = change;
      x.answer(0);
      const v = x.h.getFilterConfirmation(r.confirmationId);
      assert.equal(v.status, "failed", JSON.stringify(change));
      assert.match(v.reason, /what the dialog showed has changed since/);
      assert.equal(x.lists.account1.filterCount, 0);
      assert.match(x.lastDialog().bag.props.text, /was NOT written/);
    }
  });

  it("the account's shown name changed before the click -> failed; time passing alone changes nothing", () => {
    const r = w.h.createFilter("account2", "cp-fwd", true, 17, COND, FWD);
    w.accounts.account2.incomingServer.prettyName = "Renamed";
    w.answer(0);
    assert.equal(w.h.getFilterConfirmation(r.confirmationId).status, "failed");
    assert.equal(w.lists.account2.filterCount, 0);
    const x = makeWorld();
    const r2 = x.h.createFilter("account1", "auto", true, 17, COND,
      [{ type: "reply", value: "mailbox://nobody@Local%20Folders/Templates?messageId=tpl-1@example.test&subject=x" }]);
    x.clock.advance(9 * 60 * 1000);
    x.answer(0);
    assert.equal(x.h.getFilterConfirmation(r2.confirmationId).status, "accepted");
    assert.equal(x.lists.account1.filterCount, 1);
  });

  it("account no longer allowed / tool disabled / policy now block -> failed, nothing written", () => {
    for (const change of [(x) => { x.allowedAccounts = ["account2"]; }, (x) => { x.disabledTools.add("createFilter"); },
      (x) => { x.prefs[P_BLOCK] = true; }]) {
      const x = makeWorld();
      const r = x.h.createFilter("account1", "cp-fwd", true, 17, COND, FWD);
      change(x);
      x.answer(0);
      assert.equal(x.h.getFilterConfirmation(r.confirmationId).status, "failed");
      assert.equal(x.lists.account1.filterCount, 0);
    }
  });

  it("the target folder of another action became inaccessible -> failed", () => {
    const r = w.h.createFilter("account1", "cp-fwd", true, 17, COND,
      [...FWD, { type: "moveToFolder", value: "mailbox://nobody@Local%20Folders/Archive" }]);
    w.allowedAccounts = []; // nothing allowed any more
    w.answer(0);
    assert.equal(w.h.getFilterConfirmation(r.confirmationId).status, "failed");
  });

  it("outgoing mail (type 64) with a forward: refused, no dialog", () => {
    const r = w.h.createFilter("account1", "cp-out", true, 64, COND, FWD);
    assert.match(r.error, /cannot run on outgoing mail/);
    assert.equal(w.dialogs.length, 0);
  });

  it("an invalid forward target or a non-template reply is refused before any dialog", () => {
    assert.match(w.h.createFilter("account1", "x", true, 17, COND, [{ type: "forward", value: "a@x.com, b@y.com" }]).error,
      /exactly one plain e-mail address/);
    assert.match(w.h.createFilter("account1", "x", true, 17, COND,
      [{ type: "reply", value: "mailbox://labo@127.0.0.1/Inbox?messageId=secret@x&subject=t" }]).error,
    /not one/);
    assert.match(w.h.createFilter("account1", "x", true, 17, COND,
      [{ type: "reply", value: "mailbox://nobody@Local%20Folders/Templates?messageId=nope@x&subject=t" }]).error,
    /Reply template not found/);
    assert.equal(w.dialogs.length, 0);
  });

  it("a reply with a real template is confirmed, showing the template's own subject", () => {
    const r = w.h.createFilter("account1", "auto", true, 17, COND,
      [{ type: "reply", value: "mailbox://nobody@Local%20Folders/Templates?messageId=tpl-1@example.test&subject=anything" }]);
    assert.equal(r.status, "pending_user_confirmation");
    assert.match(r.shownToUser.text, /Reply with template “Out of office” \(folder “Templates”/);
    assert.match(r.shownToUser.text, /its whole content is sent to the sender of each matching message/);
  });

  it("a benign rule in a list without sending rules is written at once (no dialog)", () => {
    const r = w.h.createFilter("account1", "ok", true, 17, COND, [{ type: "markRead" }]);
    assert.equal(r.success, true);
    assert.equal(w.dialogs.length, 0);
  });

  it("list holding a forward rule: benign create, reorder, delete of another rule, update -> confirmed", () => {
    seedForwardRule(w);
    w.lists.account2.filters.push(makeFilter("other"));
    const calls = [
      () => w.h.createFilter("account2", "ok", true, 17, COND, [{ type: "markRead" }]),
      () => w.h.reorderFilters("account2", 1, 0),
      () => w.h.deleteFilter("account2", 1),
      () => w.h.updateFilter("account2", 0, undefined, false),
    ];
    for (const call of calls) {
      const r = call();
      assert.equal(r.status, "pending_user_confirmation");
      assert.match(r.shownToUser.text, /#0 “manual-transfer-rule”: Forward to target@example\.net/);
      w.answer(1);
    }
    assert.equal(w.lists.account2.filterCount, 2);
    assert.equal(w.lists.account2.getFilterAt(0).enabled, true);
    assert.equal(w.lists.account2.saves, 0);
  });

  it("deleting the forward rule itself needs no confirmation", () => {
    seedForwardRule(w);
    assert.equal(w.h.deleteFilter("account2", 0).success, true);
    assert.equal(w.dialogs.length, 0);
  });

  it("updateFilter enabling a disabled forward rule: confirmed, then written only on accept", () => {
    const f = seedForwardRule(w);
    f.enabled = false;
    const r = w.h.updateFilter("account2", 0, undefined, true);
    assert.equal(r.status, "pending_user_confirmation");
    assert.match(r.shownToUser.title, /change a filter rule that SENDS MAIL/);
    assert.match(r.shownToUser.text, /\(changed: enabled\)/);
    assert.equal(f.enabled, false);
    w.answer(0);
    assert.equal(f.enabled, true);
    assert.equal(w.h.getFilterConfirmation(r.confirmationId).status, "accepted");
  });

  it("updateFilter marking the forward rule for outgoing mail: refused", () => {
    seedForwardRule(w);
    assert.match(w.h.updateFilter("account2", 0, undefined, undefined, 17 | 64).error, /cannot run on outgoing mail/);
    assert.equal(w.dialogs.length, 0);
  });

  it("applyFilters on a list holding a forward rule: confirmed; run only on accept", () => {
    seedForwardRule(w);
    const r = w.h.applyFilters("account2", "mailbox://labo@127.0.0.1/Inbox");
    assert.equal(r.status, "pending_user_confirmation");
    assert.match(r.shownToUser.text, /apply filters including 1 sending rule\(s\)/);
    assert.equal(w.applied.length, 0);
    w.answer(1);
    assert.equal(w.applied.length, 0);
    const r2 = w.h.applyFilters("account2", "mailbox://labo@127.0.0.1/Inbox");
    w.answer(0);
    assert.equal(w.applied.length, 1);
    assert.deepEqual(Array.from(w.applied[0].folders), ["mailbox://labo@127.0.0.1/Inbox"]);
    assert.equal(w.h.getFilterConfirmation(r2.confirmationId).status, "accepted");
  });

  it("a failure while opening the dialog settles the request (failed), so the next one is not blocked", () => {
    w.breakDialog = true;
    const r = w.h.createFilter("account1", "cp-fwd", true, 17, COND, FWD);
    assert.match(r.error, /could not be opened \(E_OPEN\); nothing was written/);
    assert.equal(w.h.getFilterConfirmation().pending, null);
    assert.equal(w.h.getFilterConfirmation().recent[0].status, "failed");
    w.breakDialog = false;
    assert.equal(w.h.createFilter("account1", "cp-fwd", true, 17, COND, FWD).status, "pending_user_confirmation");
    assert.equal(w.lists.account1.filterCount, 0);
  });

  it("main window closed: refused, nothing pending", () => {
    w.mainWindowOpen = false;
    assert.match(w.h.createFilter("account1", "cp-fwd", true, 17, COND, FWD).error, /main window is not open/);
    assert.equal(w.h.getFilterConfirmation().pending, null);
  });

  it("getFilterConfirmation only reads: pending, recent, limits; unknown id is an error", () => {
    const r = w.h.createFilter("account1", "cp-fwd", true, 17, COND, FWD);
    const all = w.h.getFilterConfirmation();
    assert.equal(all.policy, "confirm");
    assert.equal(all.pending.confirmationId, r.confirmationId);
    assert.equal(all.limits.maxPending, 1);
    assert.equal(all.limits.maxPerHour, 5);
    assert.match(w.h.getFilterConfirmation("fc-nope").error, /Unknown confirmationId/);
    assert.equal(w.h.getFilterConfirmation(r.confirmationId).status, "pending");
    assert.equal(w.lists.account1.filterCount, 0);
  });
});

// A rule "made by hand" (or by other code): written without the MCP checks.
function seedHandMadeRule(w, account, name, actions, { enabled = true, type = 17, conditions = COND } = {}) {
  const f = makeFilter(name);
  f.enabled = enabled;
  f.filterType = type;
  w.h.buildTerms(f, conditions);
  for (const a of actions) {
    const act = f.createAction();
    act.type = a.type;
    if (a.value !== undefined) act.strValue = a.value;
    f.appendAction(act);
  }
  w.lists[account].filters.push(f);
  return f;
}

describe("only an explicit click on the confirmation button writes (the user's answer as commonDialog reports it)", () => {
  const answers = [
    ["button 0 but ok=false", { buttonNumClicked: 0, ok: false }],
    ["ok=true but button 1 (Refuse)", { buttonNumClicked: 1, ok: true }],
    ["button \"0\" (a string)", { buttonNumClicked: "0", ok: true }],
    ["ok \"true\" (a string)", { buttonNumClicked: 0, ok: "true" }],
    ["commonDialog's defaults (1 / false)", { buttonNumClicked: 1, ok: false }],
    ["extra button 2", { buttonNumClicked: 2, ok: true }],
    ["no answer in the bag (getProperty throws)", {}],
  ];
  for (const [label, props] of answers) {
    it(`${label} -> refused, nothing written`, () => {
      const w = makeWorld();
      const r = w.h.createFilter("account1", "cp-fwd", true, 17, COND, FWD);
      const dlg = w.lastDialog();
      w.load(dlg);
      delete dlg.bag.props.buttonNumClicked;
      delete dlg.bag.props.ok;
      for (const [k, v] of Object.entries(props)) dlg.bag.setProperty(k, v);
      dlg.close();
      assert.equal(w.h.getFilterConfirmation(r.confirmationId).status, "refused");
      assert.equal(w.lists.account1.filterCount, 0);
      assert.equal(w.lists.account1.saves, 0);
    });
  }
  it("button 0 with ok === true writes once; the unload listener replayed writes nothing more", () => {
    const w = makeWorld();
    const r = w.h.createFilter("account1", "cp-fwd", true, 17, COND, FWD);
    w.answer(0);
    assert.equal(w.h.getFilterConfirmation(r.confirmationId).status, "accepted");
    const dlg = w.lastDialog();
    for (const fn of dlg.listeners.unload || []) fn();
    assert.equal(w.lists.account1.saves, 1);
    assert.equal(w.lists.account1.filterCount, 1);
  });
  it("another dialog's \"loaded\" notification (even with ok) does not answer the confirmation", () => {
    const w = makeWorld();
    const r = w.h.createFilter("account1", "cp-fwd", true, 17, COND, FWD);
    const other = { bag: { getProperty: (k) => ({ buttonNumClicked: 0, ok: true })[k] }, listeners: {},
      addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); } };
    for (const { o, topic } of [...w.observers]) if (topic === "common-dialog-loaded") o.observe(other, topic);
    assert.equal((other.listeners.unload || []).length, 0, "no listener on another window");
    assert.equal(w.h.getFilterConfirmation(r.confirmationId).status, "pending");
    w.answer(1);
    assert.equal(w.h.getFilterConfirmation(r.confirmationId).status, "refused");
    assert.equal(w.lists.account1.filterCount, 0);
  });
  it("a click on the confirmation button exactly at the deadline writes nothing (expired)", () => {
    const w = makeWorld();
    const r = w.h.createFilter("account1", "cp-fwd", true, 17, COND, FWD);
    w.clock.advance(600000);
    w.answer(0);
    assert.equal(w.h.getFilterConfirmation(r.confirmationId).status, "expired");
    assert.equal(w.lists.account1.filterCount, 0);
  });
  it("a window closed before it loaded: no answer, stays pending, the deadline settles it; nothing written", () => {
    const w = makeWorld();
    const r = w.h.createFilter("account1", "cp-fwd", true, 17, COND, FWD);
    w.lastDialog().close();
    assert.equal(w.h.getFilterConfirmation(r.confirmationId).status, "pending");
    w.clock.advance(600050);
    w.fireTimers();
    assert.equal(w.h.getFilterConfirmation(r.confirmationId).status, "expired");
    assert.equal(w.lists.account1.filterCount, 0);
  });
  it("the five operations: Refuse default, delayed accept, their own accept label, no check box, no third button, non-modal", () => {
    const w = makeWorld();
    seedForwardRule(w);
    w.lists.account2.filters.push(makeFilter("other"));
    for (const [op, call, label] of [
      ["create", () => w.h.createFilter("account2", "ok", true, 17, COND, [{ type: "markRead" }]), "Create the rule"],
      ["update", () => w.h.updateFilter("account2", 0, undefined, false), "Save the change"],
      ["delete", () => w.h.deleteFilter("account2", 1), "Delete the rule"],
      ["reorder", () => w.h.reorderFilters("account2", 1, 0), "Move the rule"],
      ["apply", () => w.h.applyFilters("account2", "mailbox://labo@127.0.0.1/Inbox"), "Run the filters"]]) {
      assert.equal(call().status, "pending_user_confirmation", op);
      const props = w.lastDialog().bag.props;
      assert.equal(props.promptType, "confirmEx", op);
      assert.equal(props.defaultButtonNum, 1, op);
      assert.equal(props.enableDelay, true, op);
      assert.equal(props.button0Label, label, op);
      assert.equal(props.button1Label, "Refuse", op);
      for (const k of ["checkLabel", "checked", "button2Label", "button3Label"]) assert.ok(!(k in props), `${op}: ${k}`);
      assert.doesNotMatch(w.lastDialog().features, /modal/, op);
      w.answer(1);
    }
    assert.equal(w.lists.account2.saves, 0);
    assert.equal(w.applied.length, 0);
  });
});

describe("what is written is what was requested and shown (checked again at the click)", () => {
  it("the caller's arrays changed after the request: the stored copy is written", () => {
    const w = makeWorld();
    const conditions = [{ attrib: "subject", op: "contains", value: "facture" }];
    const actions = [{ type: "forward", value: "target@example.net" }];
    const r = w.h.createFilter("account1", "cp-fwd", true, 17, conditions, actions);
    actions[0].value = "other@example.org";
    conditions[0].value = "x";
    w.answer(0);
    assert.equal(w.h.getFilterConfirmation(r.confirmationId).status, "accepted");
    const f = w.lists.account1.getFilterAt(0);
    assert.equal(f.getActionAt(0).strValue, "target@example.net");
    assert.equal(f.searchTerms[0].value.str, "facture");
  });
  it("the address of a sending rule of the list changed before the click -> failed", () => {
    const w = makeWorld();
    const fwd = seedForwardRule(w);
    const r = w.h.createFilter("account2", "ok", true, 17, COND, [{ type: "markRead" }]);
    fwd.getActionAt(0).strValue = "elsewhere@example.org";
    w.answer(0);
    assert.equal(w.h.getFilterConfirmation(r.confirmationId).status, "failed");
    assert.equal(w.lists.account2.filterCount, 1);
    assert.equal(w.lists.account2.saves, 0);
  });
  it("a sending rule deleted through MCP while waiting (allowed without a dialog) -> the accepted applyFilters fails, nothing runs", () => {
    const w = makeWorld();
    seedForwardRule(w, "account2", "one@example.net");
    seedForwardRule(w, "account2", "two@example.net");
    const r = w.h.applyFilters("account2", "mailbox://labo@127.0.0.1/Inbox");
    assert.equal(r.status, "pending_user_confirmation");
    assert.equal(w.h.deleteFilter("account2", 1).success, true);
    w.answer(0);
    assert.equal(w.h.getFilterConfirmation(r.confirmationId).status, "failed");
    assert.equal(w.applied.length, 0);
  });
  it("the reply template removed, or its folder no longer a Templates folder -> failed", () => {
    const TPL = "mailbox://nobody@Local%20Folders/Templates?messageId=tpl-1@example.test&subject=x";
    for (const change of [(x) => { delete x.templateHdrs["tpl-1@example.test"]; },
      (x) => { x.folders["mailbox://nobody@Local%20Folders/Templates"].flags = 0; }]) {
      const w = makeWorld();
      const r = w.h.createFilter("account1", "auto", true, 17, COND, [{ type: "reply", value: TPL }]);
      assert.equal(r.status, "pending_user_confirmation");
      change(w);
      w.answer(0);
      assert.equal(w.h.getFilterConfirmation(r.confirmationId).status, "failed");
      assert.equal(w.lists.account1.filterCount, 0);
    }
  });
  it("the setting became unreadable as a boolean before the click -> failed (fail closed)", () => {
    const w = makeWorld();
    const r = w.h.createFilter("account1", "cp-fwd", true, 17, COND, FWD);
    w.prefs[P_BLOCK] = "allow";
    w.answer(0);
    assert.equal(w.h.getFilterConfirmation(r.confirmationId).status, "failed");
    assert.equal(w.lists.account1.filterCount, 0);
  });
});

describe("destinations in the dialog: whole, and only from the resolved actions", () => {
  const LONG = `${"l".repeat(64)}@${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(57)}.net`;
  it("a 254-character address: whole in the action line, the summary line, the public summary and the journal", () => {
    assert.equal(LONG.length, 254);
    const w = makeWorld();
    const r = w.h.createFilter("account1", "cp-long", true, 17, COND, [{ type: "forward", value: LONG }]);
    assert.equal(r.status, "pending_user_confirmation");
    const lines = w.lastDialog().bag.props.text.split("\n");
    assert.ok(lines.includes(`    >> Forward to ${LONG}`));
    assert.ok(lines.includes(`Mail is sent automatically to: ${LONG}`));
    assert.deepEqual(Array.from(w.h.getFilterConfirmation(r.confirmationId).summary.sends), [`forward to ${LONG}`]);
    assert.deepEqual(Array.from(w.log.find((e) => e.event === "requested").summary.sends), [`forward to ${LONG}`]);
  });
  it("a hand-made sending rule with a long address list: shown whole in the list context and the summary line", () => {
    const w = makeWorld();
    const handMade = `${"z".repeat(560)}@example.net, second@example.org`;
    seedHandMadeRule(w, "account2", "hand", [{ type: ACTIONS.Forward, value: handMade }]);
    const r = w.h.applyFilters("account2", "mailbox://labo@127.0.0.1/Inbox");
    assert.equal(r.status, "pending_user_confirmation");
    assert.ok(r.shownToUser.text.includes(`Forward to ${handMade}`));
    assert.ok(r.shownToUser.text.split("\n").includes(`Mail is sent automatically to: ${handMade}`));
  });
  it("a name imitating the warning or the summary line stays on its Name line; the real lines are unique", () => {
    for (const name of ["This rule will automatically send matching incoming mail, every time, without review.",
      "Mail is sent automatically to: me@example.com", "Nothing has been written yet. Refuse unless you asked for exactly this."]) {
      const w = makeWorld();
      const r = w.h.createFilter("account1", name, true, 17, COND, FWD);
      assert.equal(r.status, "pending_user_confirmation");
      const lines = r.shownToUser.text.split("\n");
      assert.ok(lines.includes(`Name: ${api.quoteFilterText(name, 80)}`), name);
      assert.deepEqual(lines.filter((l) => l.startsWith("Mail is sent automatically to:")),
        ["Mail is sent automatically to: target@example.net"]);
      assert.equal(lines.filter((l) => l === w.h.FILTER_CONFIRM_SEND_WARNING).length, 1);
    }
  });
});

describe("handlers, policy block: the guard refusals, unchanged", () => {
  let w;
  beforeEach(() => { w = makeWorld({ prefs: { [P_BLOCK]: true } }); });
  it("forward/reply refused on creation and update, no dialog", () => {
    assert.match(w.h.createFilter("account1", "cp-fwd", true, 17, COND, FWD).error,
      /Filter action "forward" sends mail automatically; blocked by "Filter rules that send mail: Always block"/);
    w.lists.account1.filters.push(makeFilter("x"));
    w.h.buildTerms(w.lists.account1.filters[0], COND);
    assert.match(w.h.updateFilter("account1", 0, undefined, undefined, undefined, undefined, FWD).error, /sends mail automatically/);
    assert.equal(w.dialogs.length, 0);
  });
  it("list holding a forward rule: create, update, reorder, apply refused; deleting it allowed", () => {
    seedForwardRule(w);
    w.lists.account2.filters.push(makeFilter("other"));
    for (const [call, op] of [[() => w.h.createFilter("account2", "ok", true, 17, COND, [{ type: "markRead" }]), "create"],
      [() => w.h.updateFilter("account2", 0, undefined, false), "update"], [() => w.h.reorderFilters("account2", 1, 0), "reorder"],
      [() => w.h.applyFilters("account2", "mailbox://labo@127.0.0.1/Inbox"), "apply"]]) {
      const r = call();
      assert.match(r.error, new RegExp(`MCP cannot (change|run) this filter list \\(${op}\\)`));
    }
    assert.match(w.h.deleteFilter("account2", 1).error, /deleting one of those rules is allowed/);
    assert.equal(w.h.deleteFilter("account2", 0).success, true);
    assert.equal(w.dialogs.length, 0);
    assert.equal(w.applied.length, 0);
  });
});

describe("wiring", () => {
  const handlers = apiSource.slice(apiSource.indexOf("function getFilterListForAccount(accountId)"),
    apiSource.indexOf("// BEGIN TOOL SCHEMA VALIDATOR"));
  const fn = (name) => {
    const start = handlers.indexOf(`function ${name}(`);
    assert.ok(start >= 0, name);
    return handlers.slice(start, handlers.indexOf("\n            }\n", start));
  };
  it("every filter-writing tool goes through runFilterOperation", () => {
    for (const [tool, kind] of [["createFilter", "createFilter"], ["updateFilter", "updateFilter"], ["deleteFilter", "deleteFilter"],
      ["reorderFilters", "reorderFilters"], ["applyFilters", "applyFilters"]]) {
      assert.match(fn(tool), new RegExp(`runFilterOperation\\("${kind}"`));
      assert.doesNotMatch(fn(tool), /saveToDefaultFile|applyFiltersToFolders|insertFilterAt|removeFilterAt/);
    }
  });
  it("the request path never writes; only a click on button 0 leads to commit", () => {
    assert.doesNotMatch(fn("requestFilterConfirmation"), /\.commit\(/);
    assert.match(fn("requestFilterConfirmation"), /status: "pending_user_confirmation"/);
    assert.match(fn("requestFilterConfirmation"), /dialogText: dialog\.text,/);
    assert.doesNotMatch(fn("requestFilterConfirmation"), /\bawait\b/);
    const closed = fn("onFilterConfirmationClosed");
    assert.ok(closed.indexOf("clicked === 0 && ok") < closed.indexOf("commitConfirmedFilterOperation(entry)"));
    const commit = fn("commitConfirmedFilterOperation");
    for (const check of ["filterSendRulePolicy()", "isToolEnabled(p.kind)", "prepareFilterOperation(p.kind, p.args, \"confirm\")",
      "fingerprintFilterList(plan.filterList) !== p.fingerprint", "plan.shown !== p.shown", "decideFilterPlan(plan)",
      "composeFilterConfirmationDialog(plan, verdict, p.dialogExpiresAt)", "again.text !== p.dialogText"]) {
      assert.ok(commit.indexOf(check) >= 0 && commit.indexOf(check) < commit.indexOf("plan.commit()"), check);
    }
  });
  it("getFilterConfirmation cannot settle anything", () => {
    assert.doesNotMatch(fn("getFilterConfirmation"), /settle|commit|close\(/);
  });
  it("the dialog: non-modal, Refuse default, delayed accept, no check box", () => {
    const open = fn("openFilterConfirmationDialog");
    assert.match(open, /defaultButtonNum: 1/);
    assert.match(open, /enableDelay: true/);
    assert.doesNotMatch(open, /checkLabel/);
    assert.doesNotMatch(open, /"[^"]*\bmodal\b/);
  });
  it("the block policy keeps the guard in each prepare step, before building", () => {
    for (const [name, op] of [["prepareCreateFilter", "create"], ["prepareUpdateFilter", "update"], ["prepareDeleteFilter", "delete"],
      ["prepareReorderFilters", "reorder"], ["prepareApplyFilters", "apply"]]) {
      assert.match(fn(name), new RegExp(`if \\(policy === "block"\\) guardFilterList\\(filterList, "${op}"`));
    }
    const create = fn("prepareCreateFilter");
    assert.ok(create.indexOf('guardFilterList(filterList, "create")') < create.indexOf("buildActions("));
    const apply = fn("prepareApplyFilters");
    assert.ok(apply.indexOf('guardFilterList(filterList, "apply")') < apply.indexOf("getAccessibleFolder("));
  });
  it("preference, schema, options page, shutdown", () => {
    assert.match(apiSource, /const PREF_BLOCK_FILTER_FORWARD_REPLY = "extensions\.commonpost-mcp\.blockFilterForwardReply";/);
    const schema = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/schema.json"), "utf8"));
    const names = schema[0].functions.map((f) => f.name);
    assert.ok(names.includes("getBlockFilterForwardReply") && names.includes("setBlockFilterForwardReply"));
    const set = schema[0].functions.find((f) => f.name === "setBlockFilterForwardReply");
    assert.equal(set.parameters[0].type, "boolean");
    const html = fs.readFileSync(path.resolve(__dirname, "../extension/options.html"), "utf8");
    const js = fs.readFileSync(path.resolve(__dirname, "../extension/options.js"), "utf8");
    assert.match(html, /value="block"[\s\S]*Always block[\s\S]*value="confirm"[\s\S]*Ask me each time/);
    assert.doesNotMatch(html, /value="allow"/);
    assert.match(js, /browser\.commonpostMcp\.setBlockFilterForwardReply\(chosen\.value === "block"\)/);
    assert.match(apiSource, /__commonpostMcpFilterConfirmations\.shutdown\(/);
  });
  it("getFilterConfirmation is a read-only tool of the filters group", () => {
    const i = apiSource.indexOf('name: "getFilterConfirmation"');
    assert.ok(i > 0);
    assert.match(apiSource.slice(i, i + 200), /group: "filters", crud: "read"/);
    assert.match(apiSource, /case "getFilterConfirmation":\s*\n\s*return getFilterConfirmation\(args\.confirmationId\);/);
  });
  it("tool descriptions state the real default (Always block), not the opposite", () => {
    for (const name of ["createFilter", "updateFilter", "deleteFilter", "reorderFilters", "applyFilters"]) {
      const i = apiSource.indexOf(`name: "${name}",`);
      assert.ok(i > 0, name);
      const description = apiSource.slice(i, apiSource.indexOf("inputSchema:", i));
      assert.match(description, /refused by default \(\\"(Filter rules that send mail: )?Always block\\"\)|is always allowed/, `${name}: ${description}`);
      // Never claims "Ask me each time" (or an unqualified "the default
      // setting") is what happens without the user having switched it.
      assert.doesNotMatch(description, /with the default setting/, name);
      assert.doesNotMatch(description, /default setting \(.Filter rules that send mail: Ask me each time/, name);
    }
  });
});
