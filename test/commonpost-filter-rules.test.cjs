"use strict";

// filter actions resolved by name, typed copy of
// conditions and actions in updateFilter (customId kept), canonical target
// folder URI, no Custom action creation, no silent failure.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const apiPath = path.resolve(__dirname, "../extension/mcp_server/api.js");
const apiSource = fs.readFileSync(apiPath, "utf8");

// Real enums (nsMsgSearchCore.idl / nsMsgFilterCore.idl).
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

// Named access only, no own keys (like Ci in the experiment context).
function nonEnumerable(constants) {
  return new Proxy({}, {
    get: (_t, name) => constants[name],
    has: (_t, name) => name in constants,
    ownKeys: () => [],
    getOwnPropertyDescriptor: () => undefined,
  });
}

function loadHelpers({ actions = ACTIONS } = {}) {
  const blocks = [
    ["// BEGIN FILTER SEARCH TERM HELPERS", "// END FILTER SEARCH TERM HELPERS"],
    ["// BEGIN FILTER RULE HELPERS", "// END FILTER RULE HELPERS"],
  ].map(([b, e]) => {
    const start = apiSource.indexOf(b);
    const end = apiSource.indexOf(e);
    assert.ok(start >= 0 && end > start, `marker missing: ${b}`);
    return apiSource.slice(start, end);
  });
  const sandbox = {
    Ci: {
      nsMsgSearchAttrib: nonEnumerable(ATTRIB),
      nsMsgSearchOp: nonEnumerable(OPS),
      nsMsgFilterAction: nonEnumerable(actions),
      nsMsgFilterType: nonEnumerable({ InboxRule: 0x1, Manual: 0x10, PostPlugin: 0x20, PostOutgoing: 0x40, Archive: 0x80, Periodic: 0x100 }),
      nsMsgMessageFlags: nonEnumerable({ Read: 0x1, Replied: 0x2, Marked: 0x4, Forwarded: 0x1000, New: 0x10000, Attachment: 0x10000000 }),
      nsMsgPriority: nonEnumerable({ lowest: 2, low: 3, normal: 4, high: 5, highest: 6 }),
    },
    Services: { prefs: { getCharPref: (_n, fallback) => fallback } },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${blocks.join("\n")}
this.api = { ACTION_MAP, buildTerms, buildRuleActions, copySearchValue, copySearchTerm,
  copyRuleAction, serializeFilterRule, planFilterUpdate, FILTER_ACTION_CUSTOM, SEARCH_ATTRIB_CUSTOM,
  assertFilterListGuard, listSendingRules, FILTER_TYPE_POST_OUTGOING, selectManualRunFilters, FILTER_TYPE_MANUAL };`, sandbox);
  return sandbox.api;
}

const api = loadHelpers();

// nsIMsgSearchValue double: a tagged union that throws on the wrong member.
const LEGAL_VALUE_MEMBER = {
  [ATTRIB.Priority]: "priority", [ATTRIB.MsgStatus]: "status", [ATTRIB.Date]: "date",
  [ATTRIB.AgeInDays]: "age", [ATTRIB.Size]: "size", [ATTRIB.JunkStatus]: "junkStatus",
  [ATTRIB.JunkPercent]: "junkPercent", [ATTRIB.HasAttachmentStatus]: "status",
  [ATTRIB.FolderFlag]: "status", [ATTRIB.Uint32HdrProperty]: "status", [ATTRIB.MessageKey]: "msgKey",
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

// nsIMsgRuleAction double: typed members throw on the wrong action type.
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
  return {
    filters,
    createFilter(name) { return makeFilter(name); },
    get filterCount() { return filters.length; },
    getFilterAt(i) { return filters[i]; },
  };
}

const FOLDERS = {
  "mailbox://nobody@Local Folders/Archive": "mailbox://nobody@Local%20Folders/Archive",
  "mailbox://nobody@Local%20Folders/Archive": "mailbox://nobody@Local%20Folders/Archive",
};
function resolveFolder(uri) {
  return FOLDERS[uri] ? { folder: { URI: FOLDERS[uri] } } : { error: `Folder not found: ${uri}` };
}

const ALLOWED = [
  ["moveToFolder", ACTIONS.MoveToFolder, "mailbox://nobody@Local Folders/Archive"],
  ["copyToFolder", ACTIONS.CopyToFolder, "mailbox://nobody@Local Folders/Archive"],
  ["markRead", ACTIONS.MarkRead],
  ["markUnread", ACTIONS.MarkUnread],
  ["markFlagged", ACTIONS.MarkFlagged],
  ["addTag", ACTIONS.AddTag, "$label1"],
  ["changePriority", ACTIONS.ChangePriority, "6"],
  ["delete", ACTIONS.Delete],
  ["stopExecution", ACTIONS.StopExecution],
  ["killThread", ACTIONS.KillThread],
  ["watchThread", ACTIONS.WatchThread],
];

describe("buildRuleActions resolves every action by name", () => {
  for (const [type, id, value] of ALLOWED) {
    it(`${type} -> nsMsgFilterAction ${id}`, () => {
      const filter = makeFilter();
      api.buildRuleActions(filter, [value === undefined ? { type } : { type, value }], resolveFolder);
      assert.equal(filter.actionCount, 1);
      assert.equal(filter.getActionAt(0).type, id);
    });
  }

  it("stores the folder's canonical URI, not the caller's spelling", () => {
    const filter = makeFilter();
    api.buildRuleActions(filter, [{ type: "moveToFolder", value: "mailbox://nobody@Local Folders/Archive" }], resolveFolder);
    assert.equal(filter.getActionAt(0).targetFolderUri, "mailbox://nobody@Local%20Folders/Archive");
  });

  it("types the priority value as an integer, bounded to nsMsgPriority.lowest..highest", () => {
    const filter = makeFilter();
    api.buildRuleActions(filter, [{ type: "changePriority", value: "6" }], resolveFolder);
    assert.equal(filter.getActionAt(0).priority, 6);
    assert.throws(() => api.buildRuleActions(makeFilter(), [{ type: "changePriority", value: "high" }], resolveFolder), /must be an integer/);
    assert.throws(() => api.buildRuleActions(makeFilter(), [{ type: "changePriority", value: "7" }], resolveFolder), /must be an integer from 2 to 6/);
  });

  it("bounds junkScore to 0..100", () => {
    assert.throws(() => api.buildRuleActions(makeFilter(), [{ type: "junkScore", value: "101" }], resolveFolder),
      /must be an integer from 0 \(not junk\) to 100 \(junk\)/);
    const filter = makeFilter();
    api.buildRuleActions(filter, [{ type: "junkScore", value: "0" }], resolveFolder);
    assert.equal(filter.getActionAt(0).junkScore, 0);
  });

  it("error messages say \"Action value\", not \"Condition value\"", () => {
    assert.throws(() => api.buildRuleActions(makeFilter(), [{ type: "changePriority", value: "x" }], resolveFolder),
      /Action value for "changePriority" must be/);
  });

  it("requires a resolveFolder function", () => {
    assert.throws(() => api.buildRuleActions(makeFilter(), [{ type: "markRead" }], undefined), /requires a resolveFolder/);
    assert.throws(() => api.buildRuleActions(makeFilter(), [{ type: "markRead" }], null), /requires a resolveFolder/);
  });

  it("requires a value where the action needs one, and rejects one where it does not", () => {
    assert.throws(() => api.buildRuleActions(makeFilter(), [{ type: "moveToFolder" }], resolveFolder), /requires a value/);
    assert.throws(() => api.buildRuleActions(makeFilter(), [{ type: "addTag", value: "" }], resolveFolder), /requires a value/);
    assert.throws(() => api.buildRuleActions(makeFilter(), [{ type: "markRead", value: "x" }], resolveFolder), /does not take a value/);
  });

  it("refuses an inaccessible target folder", () => {
    assert.throws(() => api.buildRuleActions(makeFilter(), [{ type: "copyToFolder", value: "imap://x@y/Secret" }], resolveFolder),
      /not accessible/);
  });

  it("refuses to create a Custom (add-on) action, whatever the spelling", () => {
    for (const type of ["custom", "Custom", " CUSTOM "]) {
      assert.throws(() => api.buildRuleActions(makeFilter(), [{ type, value: "x" }], resolveFolder), /Custom \(add-on\) filter actions cannot be created/);
    }
  });

  it("refuses numeric ids and non-object actions", () => {
    assert.throws(() => api.buildRuleActions(makeFilter(), [{ type: 4 }], resolveFolder), /Unknown action type/);
    assert.throws(() => api.buildRuleActions(makeFilter(), [{ type: "4" }], resolveFolder), /Unknown action type/);
    assert.throws(() => api.buildRuleActions(makeFilter(), ["markRead"], resolveFolder), /must be an object/);
  });
});

function ageRule() {
  // "Age in days is greater than 30 -> move to Archive", as the filter editor builds it.
  const filter = makeFilter("old mail");
  api.buildTerms(filter, [{ attrib: "ageInDays", op: "isGreaterThan", value: "30" }]);
  api.buildRuleActions(filter, [{ type: "moveToFolder", value: "mailbox://nobody@Local%20Folders/Archive" }], resolveFolder);
  return filter;
}

describe("planFilterUpdate copies what it does not replace, typed", () => {
  it("requires a resolveFolder function, even when only conditions/name/enabled change", () => {
    const list = makeFilterList();
    const original = ageRule();
    assert.throws(() => api.planFilterUpdate(list, original, { name: "x" }, undefined), /requires a resolveFolder/);
    assert.throws(() => api.planFilterUpdate(list, original, { actions: [{ type: "markRead" }] }, null), /requires a resolveFolder/);
  });

  it("changing only the action keeps 'age in days > 30' (typed .age copy)", () => {
    const list = makeFilterList();
    const original = ageRule();
    const { changes, replacement } = api.planFilterUpdate(list, original, { actions: [{ type: "markRead" }] }, resolveFolder);
    assert.deepEqual([...changes], ["actions"]);
    assert.equal(replacement.searchTerms.length, 1);
    const term = replacement.searchTerms[0];
    assert.equal(term.attrib, ATTRIB.AgeInDays);
    assert.equal(term.op, OPS.IsGreaterThan);
    assert.equal(term.value.age, 30);
    assert.equal(replacement.getActionAt(0).type, ACTIONS.MarkRead);
    // The original rule is untouched.
    assert.equal(original.getActionAt(0).type, ACTIONS.MoveToFolder);
  });

  it("the old untyped copy (.str) would have lost that value", () => {
    const original = ageRule();
    assert.throws(() => original.searchTerms[0].value.str, /NS_ERROR_ILLEGAL_VALUE/);
  });

  it("changing only the conditions copies every action with its typed member and customId", () => {
    const list = makeFilterList();
    const original = makeFilter("multi");
    api.buildTerms(original, [{ attrib: "subject", op: "contains", value: "x" }]);
    api.buildRuleActions(original, [
      { type: "moveToFolder", value: "mailbox://nobody@Local%20Folders/Archive" },
      { type: "changePriority", value: "2" },
      { type: "addTag", value: "$label3" },
      { type: "stopExecution" },
    ], resolveFolder);
    const custom = original.createAction();
    custom.type = ACTIONS.Custom;
    custom.customId = "filtaquilla@mesquilla.com#runFile";
    custom.strValue = "arg";
    original.appendAction(custom);

    // The rule holds a Custom action: the forward/reply guard (tested below)
    // refuses to touch it unless explicitly allowed.
    const { changes, replacement } = api.planFilterUpdate(list, original,
      { conditions: [{ attrib: "from", op: "contains", value: "boss@example.com" }] }, resolveFolder,
      { allowSendActions: true });
    assert.deepEqual([...changes], ["conditions"]);
    assert.equal(replacement.actionCount, 5);
    assert.equal(replacement.getActionAt(0).targetFolderUri, "mailbox://nobody@Local%20Folders/Archive");
    assert.equal(replacement.getActionAt(1).priority, 2);
    assert.equal(replacement.getActionAt(2).strValue, "$label3");
    assert.equal(replacement.getActionAt(3).type, ACTIONS.StopExecution);
    assert.equal(replacement.getActionAt(4).type, ACTIONS.Custom);
    assert.equal(replacement.getActionAt(4).customId, "filtaquilla@mesquilla.com#runFile");
    assert.equal(replacement.getActionAt(4).strValue, "arg");
  });

  it("keeps customId, hdrProperty, header, grouping and match-all on copied terms", () => {
    const list = makeFilterList();
    const original = makeFilter("terms");
    const custom = original.createTerm();
    custom.attrib = ATTRIB.Custom; custom.op = OPS.Contains; custom.customId = "addon#term";
    custom.value.attrib = ATTRIB.Custom; custom.value.str = "needle";
    custom.beginsGrouping = true;
    original.appendTerm(custom);
    const prop = original.createTerm();
    prop.attrib = ATTRIB.Uint32HdrProperty; prop.op = OPS.Is; prop.hdrProperty = "replyTo";
    prop.value.attrib = ATTRIB.Uint32HdrProperty; prop.value.status = 7;
    prop.endsGrouping = true; prop.booleanAnd = false;
    original.appendTerm(prop);
    const all = original.createTerm();
    all.matchAll = true;
    original.appendTerm(all);
    api.buildRuleActions(original, [{ type: "markRead" }], resolveFolder);

    const { replacement } = api.planFilterUpdate(list, original, { actions: [{ type: "markFlagged" }] }, resolveFolder);
    const [t0, t1, t2] = replacement.searchTerms;
    assert.equal(t0.customId, "addon#term");
    assert.equal(t0.value.str, "needle");
    assert.equal(t0.beginsGrouping, true);
    assert.equal(t1.hdrProperty, "replyTo");
    assert.equal(t1.value.status, 7);
    assert.equal(t1.endsGrouping, true);
    assert.equal(t1.booleanAnd, false);
    assert.equal(t2.matchAll, true);
  });

  it("aborts with an error (nothing replaced) when a value cannot be copied", () => {
    const list = makeFilterList();
    const original = makeFilter("broken");
    const term = original.createTerm();
    term.attrib = 999; term.op = OPS.Is;
    term.value = { attrib: 999 }; // no readable member at all
    original.appendTerm(term);
    api.buildRuleActions(original, [{ type: "markRead" }], resolveFolder);
    assert.throws(() => api.planFilterUpdate(list, original, { actions: [{ type: "delete" }] }, resolveFolder),
      /Failed to copy existing condition #0/);
  });

  it("aborts when an existing action cannot be read", () => {
    const list = makeFilterList();
    const original = ageRule();
    original.getActionAt = () => { throw new Error("NS_ERROR_FAILURE"); };
    // With the forward/reply guard on, the unreadable action is refused even
    // earlier (fail closed, tested below); here the copy path itself.
    assert.throws(() => api.planFilterUpdate(list, original, { conditions: [{ attrib: "subject", op: "contains", value: "x" }] }, resolveFolder,
      { allowSendActions: true }),
      /Failed to copy existing action #0: NS_ERROR_FAILURE/);
    assert.throws(() => api.planFilterUpdate(list, original, { conditions: [{ attrib: "subject", op: "contains", value: "x" }] }, resolveFolder),
      /unreadable \(NS_ERROR_FAILURE\)/);
  });

  it("refuses to rebuild an unparseable filter", () => {
    const original = ageRule();
    original.unparseable = true;
    assert.throws(() => api.planFilterUpdate(makeFilterList(), original, { actions: [{ type: "delete" }] }, resolveFolder),
      /could not parse it/);
  });

  it("name/enabled/type only: no rebuild", () => {
    const { changes, replacement } = api.planFilterUpdate(makeFilterList(), ageRule(), { name: "n", enabled: false }, resolveFolder);
    assert.equal(replacement, null);
    assert.deepEqual([...changes], ["name", "enabled"]);
  });
});

describe("serializeFilterRule reports what it cannot read", () => {
  it("reads typed values, custom actions and match-all back", () => {
    const f = ageRule();
    const custom = f.createAction();
    custom.type = ACTIONS.Custom; custom.customId = "addon#act"; custom.strValue = "v";
    f.appendAction(custom);
    const all = f.createTerm(); all.matchAll = true; f.appendTerm(all);
    const out = api.serializeFilterRule(f, 3);
    assert.equal(out.index, 3);
    assert.equal(out.terms[0].attrib, "ageInDays");
    assert.equal(out.terms[0].op, "isGreaterThan");
    assert.equal(out.terms[0].value, "30");
    assert.equal(out.terms[1].matchAll, true);
    assert.equal(out.actions[0].type, "moveToFolder");
    assert.equal(out.actions[0].value, "mailbox://nobody@Local%20Folders/Archive");
    assert.equal(out.actions[1].type, "custom");
    assert.equal(out.actions[1].customId, "addon#act");
  });

  it("reads hdrProperty back on a HdrProperty/Uint32HdrProperty term", () => {
    const f = makeFilter("hdr");
    const prop = f.createTerm();
    prop.attrib = ATTRIB.Uint32HdrProperty; prop.op = OPS.Is; prop.hdrProperty = "replyTo";
    prop.value.attrib = ATTRIB.Uint32HdrProperty; prop.value.status = 7;
    f.appendTerm(prop);
    const out = api.serializeFilterRule(f, 0);
    assert.equal(out.terms[0].hdrProperty, "replyTo");
  });

  it("marks an unreadable action and an unreadable value instead of skipping them", () => {
    const f = ageRule();
    f.searchTerms[0].value = { get age() { throw new Error("E_AGE"); }, get str() { throw new Error("E_STR"); } };
    f.getActionAt = () => { throw new Error("E_ACTION"); };
    const out = api.serializeFilterRule(f, 0);
    assert.match(out.terms[0].valueError, /E_AGE/);
    assert.equal(out.actions[0].type, "unreadable");
    assert.match(out.actions[0].error, /E_ACTION/);
  });
});

describe("filter tool handlers (wiring)", () => {
  const start = apiSource.indexOf("function getFilterListForAccount(accountId)");
  const end = apiSource.indexOf("// BEGIN TOOL SCHEMA VALIDATOR");
  const handlers = apiSource.slice(start, end);

  it("contain no silent catch", () => {
    assert.ok(start > 0 && end > start);
    assert.doesNotMatch(handlers, /catch\s*\{\s*\}/);
    assert.doesNotMatch(handlers, /catch\s*\{\s*\/\/[^\n]*\n\s*\}/);
  });

  it("updateFilter plans (and validates) the rebuild before touching the list", () => {
    const u = handlers.slice(handlers.indexOf("function prepareUpdateFilter("), handlers.indexOf("function prepareDeleteFilter("));
    const plan = u.indexOf("planFilterUpdate(");
    assert.ok(plan > 0);
    assert.ok(plan < u.indexOf("removeFilterAt("));
    assert.ok(plan < u.indexOf("filter.filterName = a.name"));
  });

  it("buildActions stores the canonical folder URI via the module helper", () => {
    assert.match(handlers, /buildRuleActions\(filter, actions, resolveFilterTargetFolder[,)]/);
    assert.match(apiSource, /action\.targetFolderUri = targetCheck\.folder\.URI;/);
  });
});

// ── "No sending rule without review" guard ──

function listOf(...filters) {
  const list = makeFilterList();
  list.filters.push(...filters);
  return list;
}

function forwardRule(name = "fwd", { enabled = true } = {}) {
  const f = makeFilter(name);
  f.enabled = enabled;
  api.buildTerms(f, [{ attrib: "subject", op: "contains", value: "x" }]);
  api.buildRuleActions(f, [{ type: "forward", value: "target@example.com" }], resolveFolder, { allowSendActions: true });
  return f;
}

describe("forward/reply guard on created actions", () => {
  it("refuses forward and reply by default, on the resolved type", () => {
    for (const type of ["forward", "reply"]) {
      assert.throws(() => api.buildRuleActions(makeFilter(), [{ type, value: "a@example.com" }], resolveFolder),
        /sends mail automatically; blocked by "Filter rules that send mail: Always block"/);
    }
  });

  it("fails closed: only allowSendActions === true lets them through", () => {
    for (const opt of [{}, { allowSendActions: "yes" }, { allowSendActions: 1 }, undefined]) {
      assert.throws(() => api.buildRuleActions(makeFilter(), [{ type: "forward", value: "a@example.com" }], resolveFolder, opt),
        /sends mail automatically/);
    }
    const f = makeFilter();
    // A reply is built only with a template check (see
    // commonpost-filter-confirm.test.cjs).
    api.buildRuleActions(f, [{ type: "forward", value: "a@example.com" }, { type: "reply", value: "uri" }], resolveFolder,
      { allowSendActions: true, checkSendAction: () => {} });
    assert.deepEqual([f.getActionAt(0).type, f.getActionAt(1).type], [ACTIONS.Forward, ACTIONS.Reply]);
  });

  it("follows the id Thunderbird reports, not a hardcoded number", () => {
    const moved = loadHelpers({ actions: { ...ACTIONS, Forward: 42, Reply: 43 } });
    assert.throws(() => moved.buildRuleActions(makeFilter(), [{ type: "forward", value: "a@example.com" }], resolveFolder),
      /sends mail automatically/);
    // markRead is not a sending action whatever its id.
    const f = makeFilter();
    moved.buildRuleActions(f, [{ type: "markRead" }], resolveFolder);
    assert.equal(f.getActionAt(0).type, ACTIONS.MarkRead);
  });

  it("refuses adding reply to an existing rule through updateFilter", () => {
    assert.throws(() => api.planFilterUpdate(makeFilterList(), ageRule(), { actions: [{ type: "reply", value: "x" }] }, resolveFolder),
      /sends mail automatically/);
  });
});

describe("forward/reply guard on existing sending rules", () => {
  it("a sending rule cannot be renamed, enabled or retargeted", () => {
    for (const update of [{ name: "n" }, { enabled: true }, { conditions: [{ attrib: "subject", op: "contains", value: "" }] }]) {
      assert.throws(() => api.planFilterUpdate(makeFilterList(), forwardRule(), update, resolveFolder),
        /sends mail or runs add-on actions \(forward\); it cannot be modified through MCP/);
    }
  });

  it("nor marked for outgoing mail (PostOutgoing)", () => {
    assert.equal(api.FILTER_TYPE_POST_OUTGOING, 0x40);
    assert.throws(() => api.planFilterUpdate(makeFilterList(), forwardRule(), { type: 17 | 0x40 }, resolveFolder),
      /cannot be modified or marked for outgoing mail through MCP/);
  });

  it("replacing its actions with non-sending ones is allowed", () => {
    const { replacement } = api.planFilterUpdate(makeFilterList(), forwardRule(), { actions: [{ type: "markRead" }] }, resolveFolder);
    assert.equal(replacement.actionCount, 1);
    assert.equal(replacement.getActionAt(0).type, ACTIONS.MarkRead);
  });

  it("a list holding a sending rule cannot be changed or run, except deleting that rule", () => {
    const list = listOf(ageRule(), forwardRule("fwd", { enabled: false }));
    for (const op of ["create", "update", "reorder", "apply"]) {
      assert.throws(() => api.assertFilterListGuard(list, op), /#1 "fwd" \(forward, disabled\)/);
    }
    assert.throws(() => api.assertFilterListGuard(list, "delete", 0), /deleting one of those rules is allowed/);
    api.assertFilterListGuard(list, "delete", 1);
  });

  it("add-on (Custom) actions count as unknown, possibly sending", () => {
    const f = ageRule();
    const custom = f.createAction();
    custom.type = ACTIONS.Custom; custom.customId = "addon#send";
    f.appendAction(custom);
    assert.throws(() => api.assertFilterListGuard(listOf(f), "apply"), /\(custom\)/);
  });

  it("fails closed on an unreadable action", () => {
    const f = ageRule();
    f.getActionAt = () => { throw new Error("E_READ"); };
    assert.throws(() => api.assertFilterListGuard(listOf(f), "apply"), /unreadable \(E_READ\)/);
  });

  it("a list without sending rules is untouched by the guard", () => {
    const list = listOf(ageRule(), ageRule());
    for (const op of ["create", "update", "reorder", "apply", "delete"]) api.assertFilterListGuard(list, op, 0);
    assert.equal(api.listSendingRules(list).length, 0);
  });
});

describe("forward/reply guard wiring (policy \"block\")", () => {
  const handlers = apiSource.slice(apiSource.indexOf("function getFilterListForAccount(accountId)"),
    apiSource.indexOf("// BEGIN TOOL SCHEMA VALIDATOR"));
  const body = (fn, next) => handlers.slice(handlers.indexOf(`function ${fn}(`), handlers.indexOf(`function ${next}(`));

  it("every filter-writing step and applyFilters consult the guard under \"block\"", () => {
    assert.match(body("prepareCreateFilter", "prepareUpdateFilter"), /if \(policy === "block"\) guardFilterList\(filterList, "create"\)/);
    assert.match(body("prepareUpdateFilter", "prepareDeleteFilter"), /if \(policy === "block"\) guardFilterList\(filterList, "update"\)/);
    assert.match(body("prepareUpdateFilter", "prepareDeleteFilter"), /sendActionOptions\(policy\)/);
    assert.match(body("prepareDeleteFilter", "prepareReorderFilters"), /guardFilterList\(filterList, "delete", a\.filterIndex\)/);
    assert.match(body("prepareReorderFilters", "prepareApplyFilters"), /guardFilterList\(filterList, "reorder"\)/);
    const apply = body("prepareApplyFilters", "prepareFilterOperation");
    assert.ok(apply.indexOf('guardFilterList(filterList, "apply")') < apply.indexOf("applyFiltersToFolders("));
    assert.match(body("sendActionOptions", "buildActions"), /policy === "confirm"\s*\?\s*\{ allowSendActions: true, checkSendAction: checkSendActionValue \}\s*:\s*\{ allowSendActions: false \}/);
  });

  it("the policy is read on every call through the fail-closed resolver", () => {
    assert.match(apiSource, /const PREF_BLOCK_FILTER_FORWARD_REPLY = "extensions\.commonpost-mcp\.blockFilterForwardReply";/);
    const fn = apiSource.slice(apiSource.indexOf("function filterSendRulePolicy()"));
    assert.match(fn.slice(0, 300), /resolveFilterSendRulePolicy\(FILTER_PREFS\)/);
  });

  it("is exposed in the experiment schema and the options page", () => {
    const schema = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/schema.json"), "utf8"));
    const names = schema[0].functions.map((f) => f.name);
    assert.ok(names.includes("getBlockFilterForwardReply") && names.includes("setBlockFilterForwardReply"));
    const html = fs.readFileSync(path.resolve(__dirname, "../extension/options.html"), "utf8");
    const js = fs.readFileSync(path.resolve(__dirname, "../extension/options.js"), "utf8");
    assert.match(html, /id="filterSendRulePolicyBlock"/);
    assert.match(js, /browser\.commonpostMcp\.setBlockFilterForwardReply\(/);
  });
});


describe("applyFilters runs only enabled, Manually Run rules with accessible targets", () => {
  const ARCHIVE = "mailbox://nobody@Local%20Folders/Archive";
  const OTHER = "imap://other@example.org/Archive";
  const MANUAL = api.FILTER_TYPE_MANUAL;
  const OUTBOX = "mailbox://nobody@Local%20Folders/Unsent%20Messages";
  // What the handlers' checkExistingFilterTarget returns: true, or the reason.
  const allowArchive = (uri) => (uri === ARCHIVE ? true : uri === OUTBOX ? "move/copy target is the Outbox" : false);

  function rule(name, { enabled = true, temporary = false, filterType = MANUAL, actions = [{ type: "markRead" }] } = {}) {
    const f = makeFilter(name);
    api.buildRuleActions(f, actions, (uri) => ({ folder: { URI: uri } }));
    f.enabled = enabled;
    f.temporary = temporary;
    f.filterType = filterType;
    return f;
  }
  function listOf(...rules) {
    const list = makeFilterList();
    list.filters.push(...rules);
    return list;
  }
  const plain = (selection) => ({
    run: [...selection.run].map((r) => [r.index, r.filter.filterName]),
    skipped: [...selection.skipped].map((r) => ({ ...r })),
  });

  it("FILTER_TYPE_MANUAL is nsMsgFilterType.Manual", () => {
    assert.equal(MANUAL, 0x10);
  });

  it("skips a disabled rule", () => {
    const sel = plain(api.selectManualRunFilters(listOf(rule("off", { enabled: false })), MANUAL, allowArchive));
    assert.deepEqual(sel, { run: [], skipped: [{ index: 0, name: "off", reason: "disabled" }] });
  });

  it("skips a temporary rule", () => {
    const sel = plain(api.selectManualRunFilters(listOf(rule("tmp", { temporary: true })), MANUAL, allowArchive));
    assert.deepEqual(sel, { run: [], skipped: [{ index: 0, name: "tmp", reason: "temporary" }] });
  });

  it("skips a rule that is not marked Manually Run", () => {
    const sel = plain(api.selectManualRunFilters(listOf(rule("inc", { filterType: 0x1 })), MANUAL, allowArchive));
    assert.deepEqual(sel, { run: [], skipped: [{ index: 0, name: "inc", reason: "not marked for manual run" }] });
  });

  it("runs an enabled Manually Run rule, also when it has other types", () => {
    const sel = plain(api.selectManualRunFilters(listOf(rule("a", { filterType: 0x11 })), MANUAL, allowArchive));
    assert.deepEqual(sel, { run: [[0, "a"]], skipped: [] });
  });

  it("skips a rule whose move or copy target is not accessible, runs one whose targets are", () => {
    const list = listOf(
      rule("ok", { actions: [{ type: "moveToFolder", value: ARCHIVE }] }),
      rule("move-out", { actions: [{ type: "moveToFolder", value: OTHER }] }),
      rule("copy-out", { actions: [{ type: "markRead" }, { type: "copyToFolder", value: OTHER }] }),
    );
    const sel = plain(api.selectManualRunFilters(list, MANUAL, allowArchive));
    assert.deepEqual(sel.run, [[0, "ok"]]);
    assert.deepEqual(sel.skipped, [
      { index: 1, name: "move-out", reason: "move/copy target not accessible" },
      { index: 2, name: "copy-out", reason: "move/copy target not accessible" },
    ]);
  });

  it("skips a rule whose move or copy target is the Outbox, with its own reason", () => {
    const list = listOf(
      rule("to-outbox", { actions: [{ type: "moveToFolder", value: OUTBOX }] }),
      rule("copy-outbox", { actions: [{ type: "markRead" }, { type: "copyToFolder", value: OUTBOX }] }),
      rule("fine", { actions: [{ type: "moveToFolder", value: ARCHIVE }] }),
    );
    const sel = plain(api.selectManualRunFilters(list, MANUAL, allowArchive));
    assert.deepEqual(sel.run, [[2, "fine"]]);
    assert.deepEqual(sel.skipped.map((r) => r.reason), ["move/copy target is the Outbox", "move/copy target is the Outbox"]);
  });

  it("an isTargetAllowed that throws skips the rule", () => {
    const list = listOf(rule("t", { actions: [{ type: "moveToFolder", value: ARCHIVE }] }));
    const sel = plain(api.selectManualRunFilters(list, MANUAL, () => { throw new Error("boom"); }));
    assert.equal(sel.run.length, 0);
    assert.match(sel.skipped[0].reason, /^unreadable \(boom\)$/);
  });

  it("a rule that cannot be read is skipped with the reason, the others still run", () => {
    const broken = rule("broken");
    Object.defineProperty(broken, "enabled", { get() { throw new Error("NS_ERROR_FAILURE"); } });
    const unreadableAction = rule("noaction", { actions: [{ type: "moveToFolder", value: ARCHIVE }] });
    unreadableAction.getActionAt = () => { throw new Error("no action"); };
    const list = listOf(broken, unreadableAction, rule("fine"));
    const sel = plain(api.selectManualRunFilters(list, MANUAL, allowArchive));
    assert.deepEqual(sel.run, [[2, "fine"]]);
    assert.match(sel.skipped[0].reason, /^unreadable \(NS_ERROR_FAILURE\)$/);
    assert.match(sel.skipped[1].reason, /^unreadable \(no action\)$/);
  });

  it("keeps the order of the list and the list indices", () => {
    const list = listOf(rule("one"), rule("off", { enabled: false }), rule("two"), rule("three"));
    const sel = plain(api.selectManualRunFilters(list, MANUAL, allowArchive));
    assert.deepEqual(sel.run, [[0, "one"], [2, "two"], [3, "three"]]);
    assert.deepEqual(sel.skipped.map((r) => r.index), [1]);
  });

  it("no rule selected: the result has nothing to run", () => {
    const list = listOf(rule("a", { enabled: false }), rule("b", { filterType: 0x1 }));
    const sel = api.selectManualRunFilters(list, MANUAL, allowArchive);
    assert.equal(sel.run.length, 0);
    assert.equal(sel.skipped.length, 2);
  });

  it("an empty list selects nothing", () => {
    const sel = api.selectManualRunFilters(listOf(), MANUAL, allowArchive);
    assert.equal(sel.run.length + sel.skipped.length, 0);
  });
});

describe("updateFilter refuses to keep a move/copy target in an unauthorized account or the Outbox", () => {
  const ARCHIVE = "mailbox://nobody@Local%20Folders/Archive";
  const OTHER = "imap://other@example.org/Archive";
  const OUTBOX = "mailbox://nobody@Local%20Folders/Unsent%20Messages";
  const opts = { isKeptTargetAllowed: (uri) => (uri === ARCHIVE ? true : uri === OUTBOX ? "move/copy target is the Outbox" : false) };
  function ruleTo(uri, type = "moveToFolder") {
    const f = makeFilter("r");
    api.buildTerms(f, [{ attrib: "subject", op: "contains", value: "x" }]);
    api.buildRuleActions(f, [{ type, value: uri }], (u) => ({ folder: { URI: u } }));
    return f;
  }

  it("refuses a rename or enable/disable that keeps an inaccessible move target", () => {
    const list = makeFilterList();
    assert.throws(() => api.planFilterUpdate(list, ruleTo(OTHER), { name: "y" }, resolveFolder, opts),
      /does not allow \(move\/copy target not accessible.*provide new actions, or delete the rule/s);
    assert.throws(() => api.planFilterUpdate(list, ruleTo(OTHER), { enabled: true }, resolveFolder, opts), /does not allow/);
  });

  it("allows an update that only disables the rule, even with an inaccessible target or the Outbox", () => {
    const list = makeFilterList();
    for (const rule of [ruleTo(OTHER), ruleTo(OTHER, "copyToFolder"), ruleTo(OUTBOX)]) {
      const plan = api.planFilterUpdate(list, rule, { enabled: false }, resolveFolder, opts);
      assert.deepEqual([...plan.changes], ["enabled"]);
      assert.equal(plan.replacement, null);
    }
  });

  it("anything else next to the disabling is still refused", () => {
    const list = makeFilterList();
    for (const update of [
      { enabled: false, name: "y" },
      { enabled: false, type: 1 },
      { enabled: false, conditions: [{ attrib: "subject", op: "contains", value: "z" }] },
      { name: "y" },
      { type: 1 },
    ]) {
      assert.throws(() => api.planFilterUpdate(list, ruleTo(OTHER), update, resolveFolder, opts), /does not allow/, JSON.stringify(update));
    }
  });

  it("refuses when only the conditions change and a copy target is kept", () => {
    const list = makeFilterList();
    assert.throws(() => api.planFilterUpdate(list, ruleTo(OTHER, "copyToFolder"),
      { conditions: [{ attrib: "subject", op: "contains", value: "z" }] }, resolveFolder, opts), /does not allow/);
  });

  it("refuses to keep a move or copy target that is the Outbox", () => {
    const list = makeFilterList();
    assert.throws(() => api.planFilterUpdate(list, ruleTo(OUTBOX), { name: "y" }, resolveFolder, opts),
      /move\/copy target is the Outbox.*provide new actions, or delete the rule/s);
    assert.throws(() => api.planFilterUpdate(list, ruleTo(OUTBOX, "copyToFolder"), { enabled: true }, resolveFolder, opts),
      /Outbox/);
  });

  it("allows the update when the kept targets are accessible, or when new actions replace them", () => {
    const list = makeFilterList();
    const kept = api.planFilterUpdate(list, ruleTo(ARCHIVE), { name: "y" }, resolveFolder, opts);
    assert.deepEqual([...kept.changes], ["name"]);
    const replaced = api.planFilterUpdate(list, ruleTo(OTHER), { actions: [{ type: "markRead" }] }, resolveFolder, opts);
    assert.deepEqual([...replaced.changes], ["actions"]);
  });

  it("an isKeptTargetAllowed that throws refuses (fail closed)", () => {
    const list = makeFilterList();
    assert.throws(() => api.planFilterUpdate(list, ruleTo(ARCHIVE), { name: "y" }, resolveFolder,
      { isKeptTargetAllowed: () => { throw new Error("boom"); } }), /does not allow/);
    assert.throws(() => api.planFilterUpdate(list, ruleTo(ARCHIVE), { enabled: true }, resolveFolder,
      { isKeptTargetAllowed: () => { throw new Error("boom"); } }), /does not allow/);
  });
});

describe("applyFilters wiring", () => {
  it("prepareApplyFilters hands Thunderbird a temporary list of the selected rules, and skips the call when none is", () => {
    const start = apiSource.indexOf("function prepareApplyFilters");
    const end = apiSource.indexOf("function prepareFilterOperation");
    const body = apiSource.slice(start, end);
    assert.match(body, /selectManualRunFilters\(filterList, FILTER_TYPE_MANUAL, checkExistingFilterTarget\)/);
    assert.match(body, /getTempFilterList\(folder\)/);
    assert.match(body, /applyFiltersToFolders\(tempList, \[folder\], null\)/);
    assert.doesNotMatch(body, /applyFiltersToFolders\(filterList/);
    // selected again inside commit(), before running; no call when empty
    const commit = body.slice(body.indexOf("commit()"));
    assert.match(commit, /selectRules\(\)/);
    assert.ok(commit.indexOf("run.length === 0") < commit.indexOf("applyFiltersToFolders"));
  });

  it("updateFilter re-checks kept targets against the account restriction only", () => {
    assert.match(apiSource, /isKeptTargetAllowed: checkExistingFilterTarget/);
    const start = apiSource.indexOf("function checkExistingFilterTarget(uri)");
    const body = apiSource.slice(start, apiSource.indexOf("\n            }\n", start));
    assert.match(body, /getAccessibleFolder\(uri\)/);
    assert.match(body, /Queue\)\) return FILTER_TARGET_IS_OUTBOX/);
    assert.doesNotMatch(body, /Templates/);
  });
});

describe("a condition 'is / isn't in address book' under an address book restriction", () => {
  const OK_BOOK = "jsaddrbook://abook.sqlite";
  const BAD_BOOK = "jsaddrbook://other.sqlite";
  const allow = (uri) => (uri === OK_BOOK ? true : "address book not accessible");
  const cond = (op, value) => [{ attrib: "from", op, value }];
  function ruleWith(op, value) {
    const f = makeFilter("r");
    api.buildTerms(f, cond(op, value));
    api.buildRuleActions(f, [{ type: "markRead" }], resolveFolder);
    return f;
  }

  it("buildTerms refuses an address book that is not accessible, for both operators", () => {
    for (const op of ["isInAB", "isntInAB"]) {
      assert.throws(() => api.buildTerms(makeFilter(), cond(op, BAD_BOOK), { isAddressBookAllowed: allow }),
        /address book not accessible/);
      const ok = makeFilter();
      api.buildTerms(ok, cond(op, OK_BOOK), { isAddressBookAllowed: allow });
      assert.equal(ok.searchTerms.length, 1);
    }
  });

  it("does not touch other operators, and does nothing without a restriction hook", () => {
    api.buildTerms(makeFilter(), cond("is", BAD_BOOK), { isAddressBookAllowed: allow });
    api.buildTerms(makeFilter(), cond("isInAB", BAD_BOOK));
    api.buildTerms(makeFilter(), cond("isInAB", BAD_BOOK), { isAddressBookAllowed: () => true });
  });

  it("a hook that throws refuses (fail closed)", () => {
    assert.throws(() => api.buildTerms(makeFilter(), cond("isInAB", OK_BOOK),
      { isAddressBookAllowed: () => { throw new Error("boom"); } }), /address book not accessible/);
  });

  it("planFilterUpdate refuses a replacement condition on an inaccessible address book", () => {
    const list = makeFilterList();
    assert.throws(() => api.planFilterUpdate(list, ruleWith("contains", "x"), { conditions: cond("isInAB", BAD_BOOK) },
      resolveFolder, { isAddressBookAllowed: allow }), /address book not accessible/);
  });

  it("planFilterUpdate refuses to keep such a condition, and allows replacing it", () => {
    const list = makeFilterList();
    const opts = { isAddressBookAllowed: allow };
    assert.throws(() => api.planFilterUpdate(list, ruleWith("isInAB", BAD_BOOK), { name: "y" }, resolveFolder, opts),
      /does not allow \(address book not accessible.*provide new conditions, or delete the rule/s);
    const replaced = api.planFilterUpdate(list, ruleWith("isntInAB", BAD_BOOK),
      { conditions: cond("contains", "x") }, resolveFolder, opts);
    assert.deepEqual([...replaced.changes], ["conditions"]);
  });

  it("planFilterUpdate keeps an accessible address book condition, and a rule without one", () => {
    const list = makeFilterList();
    const opts = { isAddressBookAllowed: allow };
    const kept = api.planFilterUpdate(list, ruleWith("isInAB", OK_BOOK), { name: "y" }, resolveFolder, opts);
    assert.deepEqual([...kept.changes], ["name"]);
    api.planFilterUpdate(list, ruleWith("contains", "x"), { name: "y" }, resolveFolder, opts);
  });

  it("both creation and update are wired to the address book restriction", () => {
    assert.match(apiSource, /buildTerms\(filter, a\.conditions, \{ isAddressBookAllowed: checkFilterAddressBook \}\)/);
    assert.match(apiSource, /isAddressBookAllowed: checkFilterAddressBook \}\);/);
    const start = apiSource.indexOf("function checkFilterAddressBook(uri)");
    const body = apiSource.slice(start, apiSource.indexOf("\n            }\n", start));
    assert.match(body, /accountRestrictionState\(\) === "all"/);
    assert.match(body, /getAccessibleAddressBooks\(\)/);
  });
});
