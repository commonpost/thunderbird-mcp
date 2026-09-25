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

function loadHelpers() {
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
      nsMsgFilterAction: nonEnumerable(ACTIONS),
      nsMsgMessageFlags: { Attachment: 0x10000000 },
    },
    Services: { prefs: { getCharPref: (_n, fallback) => fallback } },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${blocks.join("\n")}
this.api = { ACTION_MAP, buildTerms, buildRuleActions, copySearchValue, copySearchTerm,
  copyRuleAction, serializeFilterRule, planFilterUpdate, FILTER_ACTION_CUSTOM, SEARCH_ATTRIB_CUSTOM };`, sandbox);
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

  it("types the priority value as an integer", () => {
    const filter = makeFilter();
    api.buildRuleActions(filter, [{ type: "changePriority", value: "6" }], resolveFolder);
    assert.equal(filter.getActionAt(0).priority, 6);
    assert.throws(() => api.buildRuleActions(makeFilter(), [{ type: "changePriority", value: "high" }], resolveFolder), /must be an integer/);
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

    const { changes, replacement } = api.planFilterUpdate(list, original,
      { conditions: [{ attrib: "from", op: "contains", value: "boss@example.com" }] }, resolveFolder);
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
    assert.throws(() => api.planFilterUpdate(list, original, { conditions: [{ attrib: "subject", op: "contains", value: "x" }] }, resolveFolder),
      /Failed to copy existing action #0: NS_ERROR_FAILURE/);
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
    const u = handlers.slice(handlers.indexOf("function updateFilter("), handlers.indexOf("function deleteFilter("));
    const plan = u.indexOf("planFilterUpdate(");
    assert.ok(plan > 0);
    assert.ok(plan < u.indexOf("removeFilterAt("));
    assert.ok(plan < u.indexOf("filter.filterName = name"));
  });

  it("buildActions stores the canonical folder URI via the module helper", () => {
    assert.match(handlers, /buildRuleActions\(filter, actions, resolveFilterTargetFolder\)/);
    assert.match(apiSource, /action\.targetFolderUri = targetCheck\.folder\.URI;/);
  });
});
