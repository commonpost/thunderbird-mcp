"use strict";

// Free text handed to the filter tools (filter name, condition values, header
// name, action values) is validated before Thunderbird stores it in
// msgFilterRules.dat, whose line-based format cannot represent line breaks,
// NUL or a backslash.

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
const OPS = { Contains: 0, DoesntContain: 1, Is: 2, Isnt: 3, IsEmpty: 4, IsGreaterThan: 13 };
const TYPES = {
  None: 0, InboxRule: 0x1, InboxJavaScript: 0x2, Inbox: 0x3, NewsRule: 0x4, NewsJavaScript: 0x8, News: 0xc,
  // All is Incoming | Manual in Thunderbird 156 in Thunderbird 156, not every bit.
  Incoming: 0xf, Manual: 0x10, PostPlugin: 0x20, PostOutgoing: 0x40, Archive: 0x80, Periodic: 0x100, All: 0x1f,
};

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
      nsMsgFilterType: nonEnumerable(TYPES),
      nsMsgMessageFlags: { Attachment: 0x10000000 },
    },
    Services: { prefs: { getCharPref: (_n, fallback) => fallback } },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${blocks.join("\n")}
this.api = { assertFilterText, validateFilterName, validateFilterType, buildTerms, buildRuleActions,
  planFilterUpdate, arbitraryHeaderAttrib, FILTER_TYPE_KNOWN_BITS, FILTER_NAME_MAX_LENGTH, FILTER_VALUE_MAX_LENGTH };`, sandbox);
  return sandbox.api;
}

const api = loadHelpers();

function makeValue() {
  const value = { attrib: undefined };
  for (const member of ["str", "status", "priority", "date", "age", "size", "junkStatus", "junkPercent"]) value[member] = undefined;
  return value;
}
function makeTerm() {
  return { attrib: undefined, op: undefined, booleanAnd: true, arbitraryHeader: "", customId: "", hdrProperty: "",
    matchAll: false, beginsGrouping: false, endsGrouping: false, value: makeValue() };
}
function makeAction() {
  return { type: ACTIONS.None, strValue: "", customId: "", targetFolderUri: "", priority: 0, junkScore: 0 };
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
const noFolder = () => ({ error: "no folder" });

// Line breaks, NUL, other controls, the Unicode separators, backslashes.
const BAD_TEXT = [
  ["LF", "a\nb", /control or line-separator character \(U\+000A at position 1\)/],
  ["CR", "a\rb", /U\+000D/],
  ["CRLF", "a\r\nb", /U\+000D/],
  ["NUL", "a\u0000b", /U\+0000/],
  ["TAB", "a\tb", /U\+0009/],
  ["ESC", "a\u001bb", /U\+001B/],
  ["DEL", "a\u007fb", /U\+007F/],
  ["NEL (C1)", "a\u0085b", /U\+0085/],
  ["LINE SEPARATOR", "a\u2028b", /U\+2028/],
  ["PARAGRAPH SEPARATOR", "a\u2029b", /U\+2029/],
  ["backslash", "a\\b", /contains a backslash \(position 1\)/],
  ["trailing backslash", "ab\\", /contains a backslash \(position 2\)/],
  ["backslash-quote", "a\\\"b", /contains a backslash/],
  ["lone surrogate", "a\ud800b", /lone UTF-16 surrogate/],
];
// Quotes, parentheses, commas, a leading space and accents round-trip in
// Thunderbird 156 and stay allowed.
const GOOD_TEXT = ["a \"b\" (c)", "\"Dupont, Jean\" <j@example.com>", " espace-initiale", "liste-été", "x)y", "\"", "日本語"];

describe("assertFilterText", () => {
  for (const [label, text, re] of BAD_TEXT) {
    it(`refuses ${label}`, () => {
      assert.throws(() => api.assertFilterText("Filter name", text, 100), re);
    });
  }
  it("accepts quotes, parentheses, commas, a leading space and non-ASCII text", () => {
    for (const text of GOOD_TEXT) assert.equal(api.assertFilterText("x", text, 100), text);
  });
  it("enforces the length limit and the string type", () => {
    assert.throws(() => api.assertFilterText("x", "a".repeat(11), 10), /too long \(11 characters, limit 10\)/);
    assert.throws(() => api.assertFilterText("x", 42, 10), /must be a string/);
  });
});

describe("filter name and type", () => {
  it("validateFilterName refuses empty, non-string and unsafe names", () => {
    assert.throws(() => api.validateFilterName(""), /non-empty string/);
    assert.throws(() => api.validateFilterName(undefined), /non-empty string/);
    assert.throws(() => api.validateFilterName("x\ny"), /U\+000A/);
    assert.throws(() => api.validateFilterName("n".repeat(api.FILTER_NAME_MAX_LENGTH + 1)), /too long/);
    assert.equal(api.validateFilterName("Règle \"test\" (ok)"), "Règle \"test\" (ok)");
  });

  it("validateFilterType accepts nsMsgFilterType bits only (every bit, not just All = 0x1f)", () => {
    assert.equal(api.FILTER_TYPE_KNOWN_BITS, 0x1ff);
    for (const ok of [1, 16, 17, 0x20, 0x40, 17 | 0x40, 0x80, 0x100, 0x1ff]) assert.equal(api.validateFilterType(ok), ok);
    for (const bad of [0, -1, 0x200, 1024, 0x7fffffff, 1.5, NaN, "17"]) {
      assert.throws(() => api.validateFilterType(bad), /nsMsgFilterType bits/, String(bad));
    }
  });
});

describe("conditions: values and header names", () => {
  for (const [label, text, re] of BAD_TEXT) {
    it(`a text condition value with ${label} is refused before the term is appended`, () => {
      const filter = makeFilter();
      assert.throws(() => api.buildTerms(filter, [{ attrib: "subject", op: "contains", value: text }]), re);
      assert.equal(filter.searchTerms.length, 0);
    });
  }

  it("safe condition values are stored unchanged", () => {
    for (const text of GOOD_TEXT) {
      const filter = makeFilter();
      api.buildTerms(filter, [{ attrib: "subject", op: "contains", value: text }]);
      assert.equal(filter.searchTerms[0].value.str, text);
    }
  });

  it("a condition value longer than the limit is refused", () => {
    assert.throws(() => api.buildTerms(makeFilter(), [{ attrib: "body", op: "contains", value: "v".repeat(api.FILTER_VALUE_MAX_LENGTH + 1) }]),
      /too long/);
  });

  it("header names are RFC 7230 tokens: quote, comma, parentheses, backslash, colon, space and controls refused", () => {
    for (const header of ["X-A\",contains,a", "X,Y", "X(Y", "X)Y", "X\\Y", "X:Y", "X Y", "X\nY", "X\u0000", "X-É",
      "", "h".repeat(101)]) {
      assert.throws(() => api.buildTerms(makeFilter(), [{ attrib: "otherHeader", header, op: "contains", value: "v" }]),
        header === "" ? /requires a "header" name/ : /Invalid header name/, JSON.stringify(header));
    }
    assert.throws(() => api.arbitraryHeaderAttrib(42), /Invalid header name/);
    for (const header of ["X-Mailing-List", "List-Id", "X-Spam_Flag", "x.y", "X-!#$%&'*+^`|~"]) {
      const filter = makeFilter();
      api.buildTerms(filter, [{ attrib: "otherHeader", header, op: "contains", value: "v" }]);
      assert.equal(filter.searchTerms[0].arbitraryHeader, header);
    }
  });
});

describe("actions: tag keys and text values", () => {
  it("addTag takes one IMAP-keyword-like tag key", () => {
    for (const key of ["$label1", "$label5", "important", "a_b-c.d", "&AOk-t&AOk-"]) {
      const filter = makeFilter();
      api.buildRuleActions(filter, [{ type: "addTag", value: key }], noFolder);
      assert.equal(filter.getActionAt(0).strValue, key);
    }
    for (const key of ["$label1 junk", "a\tb", "a(b", "a)b", "a{b", "a%b", "a*b", "a\"b", "a]b", "a/b", "a<b", "a>b", "été", "t".repeat(101)]) {
      assert.throws(() => api.buildRuleActions(makeFilter(), [{ type: "addTag", value: key }], noFolder),
        /must be a tag key|control or line-separator|too long/, JSON.stringify(key));
    }
    assert.throws(() => api.buildRuleActions(makeFilter(), [{ type: "addTag", value: "$label1\nb" }], noFolder),
      /U\+000A/);
    assert.throws(() => api.buildRuleActions(makeFilter(), [{ type: "addTag", value: "a\\b" }], noFolder), /backslash/);
  });

  it("with the send guard off, a forward address is still checked for line breaks", () => {
    assert.throws(() => api.buildRuleActions(makeFilter(), [{ type: "forward", value: "a@example.com\nb@example.net" }],
      noFolder, { allowSendActions: true }), /U\+000A/);
    const filter = makeFilter();
    api.buildRuleActions(filter, [{ type: "forward", value: "a@example.com" }], noFolder, { allowSendActions: true });
    assert.equal(filter.getActionAt(0).strValue, "a@example.com");
  });
});

describe("planFilterUpdate validates what it is given", () => {
  function rule() {
    const filter = makeFilter("r");
    api.buildTerms(filter, [{ attrib: "subject", op: "contains", value: "x" }]);
    api.buildRuleActions(filter, [{ type: "markRead" }], noFolder);
    return filter;
  }
  const list = { createFilter: (name) => makeFilter(name) };

  it("a renamed rule with a line break is refused, the rule is untouched", () => {
    const filter = rule();
    assert.throws(() => api.planFilterUpdate(list, filter, { name: "r\nx" }, noFolder), /U\+000A/);
    assert.equal(filter.filterName, "r");
  });

  it("a type with bits nsMsgFilterType does not define is refused", () => {
    assert.throws(() => api.planFilterUpdate(list, rule(), { type: 0x400 }, noFolder), /nsMsgFilterType bits/);
  });

  it("new conditions and actions are checked like on creation", () => {
    assert.throws(() => api.planFilterUpdate(list, rule(), { conditions: [{ attrib: "subject", op: "contains", value: "a\nb" }] }, noFolder),
      /U\+000A/);
    assert.throws(() => api.planFilterUpdate(list, rule(), { actions: [{ type: "addTag", value: "$label1 junk" }] }, noFolder),
      /must be a tag key/);
  });

  it("a safe rename passes", () => {
    const { changes, replacement } = api.planFilterUpdate(list, rule(), { name: "Règle (2)" }, noFolder);
    assert.deepEqual([...changes], ["name"]);
    assert.equal(replacement, null);
  });
});

describe("wiring in the tools", () => {
  // The tools prepare (validate + build) in prepare<Tool>(a,
  // policy), then write; a confirmed change is prepared again before writing.
  const body = (name) => {
    const start = apiSource.indexOf(`function ${name}(a, policy)`);
    assert.ok(start > 0, name);
    return apiSource.slice(start, apiSource.indexOf("\n            }\n", start));
  };
  it("createFilter validates the name and type before creating the filter", () => {
    const src = body("prepareCreateFilter");
    assert.ok(src.indexOf("validateFilterName(a.name)") > 0);
    assert.ok(src.indexOf("validateFilterName(a.name)") < src.indexOf("filterList.createFilter(a.name)"));
    assert.ok(src.indexOf("validateFilterType(a.type)") < src.indexOf("filterList.createFilter(a.name)"));
  });
  it("updateFilter validates the name and type before touching the filter", () => {
    const src = body("prepareUpdateFilter");
    assert.ok(src.indexOf("validateFilterName(a.name)") > 0);
    assert.ok(src.indexOf("validateFilterName(a.name)") < src.indexOf("planFilterUpdate("));
    assert.ok(src.indexOf("validateFilterType(a.type)") < src.indexOf("planFilterUpdate("));
  });
});
