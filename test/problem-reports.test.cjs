// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";

// reportProblem: an assistant saves a report about a tool; it becomes a draft that the user sends, or not. It is
// sent without them only when they chose so in the options page, to the project alone, a few times a day.
// The real functions of api.js run here: what a report holds, what is refused, that mail addresses never reach
// the file, that the list is bounded, and that the only address the options page may open is a new issue of
// this repository.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const apiSource = fs.readFileSync(path.join(root, "extension/mcp_server/api.js"), "utf8");
const optionsSource = fs.readFileSync(path.join(root, "extension/options.js"), "utf8");

function slice(begin, end) {
  const start = apiSource.indexOf(begin);
  const stop = apiSource.indexOf(end, start);
  assert.ok(start >= 0 && stop > start, `${begin} not found in api.js`);
  return apiSource.slice(start, stop);
}

const plain = (value) => JSON.parse(JSON.stringify(value));
const NOW = Date.parse("2026-11-27T15:00:00Z");
const TOOLS = ["saveDraft", "searchMessages", "reportProblem"];

function load() {
  const sandbox = vm.createContext({});
  vm.runInContext(`${slice("// BEGIN PROBLEM REPORTS", "// END PROBLEM REPORTS")}
    this.api = { cleanReportText, rememberToolError, rememberToolCall, buildProblemReport, parseProblemReports, addProblemReport,
      problemReportIssue, problemReportIssueUrl, problemReportsView, problemReportMail, PROBLEM_REPORTS_MAX,
      problemReportDelivery, problemReportMailPlan, problemReportNext, PROBLEM_REPORT_MAIL_TO };
    this.newErrors = () => new Map();`, sandbox);
  return sandbox;
}

function facts(sandbox, errors = sandbox.newErrors()) {
  return { toolNames: TOOLS, addon: "0.26.3", addonUpdated: "2026-11-27", bridge: "0.20.0", thunderbird: "140.17.0", os: "WINNT", errors, calls: sandbox.newErrors() };
}

const ARGS = {
  kind: "bug", summary: "saveDraft keeps the old draft listed", called: "saveDraft with draftId on an IMAP account",
  got: "success, and the old version stayed listed", expected: "the old version no longer listed", tool: "saveDraft",
};
const SUGGESTION_ARGS = { kind: "suggestion", summary: "name the reminder words", details: "saveDraft could list them." };

describe("reportProblem: what a report holds", () => {
  it("keeps the arguments and adds the versions the add-on knows", () => {
    const sandbox = load();
    const { report, error } = plain(sandbox.api.buildProblemReport(ARGS, facts(sandbox), "pr-0011223344556677", NOW));
    assert.equal(error, undefined);
    assert.deepEqual(report, {
      id: "pr-0011223344556677",
      at: "2026-11-27T15:00:00.000Z",
      kind: "bug",
      summary: ARGS.summary,
      called: ARGS.called,
      got: ARGS.got,
      expected: ARGS.expected,
      details: null,
      tool: "saveDraft",
      addon: "0.26.3",
      addonUpdated: "2026-11-27",
      bridge: "0.20.0",
      thunderbird: "140.17.0",
      os: "WINNT",
      lastError: null,
      calls: [],
    });
  });

  it("adds the last error of the named tool, for 30 minutes", () => {
    const sandbox = load();
    const errors = sandbox.newErrors();
    sandbox.api.rememberToolError(errors, "saveDraft", "Draft not found", NOW - 29 * 60 * 1000);
    sandbox.api.rememberToolError(errors, "searchMessages", "Folder not found", NOW - 1000);
    let { report } = plain(sandbox.api.buildProblemReport(ARGS, facts(sandbox, errors), "pr-0011223344556677", NOW));
    assert.deepEqual(report.lastError, { text: "Draft not found", at: new Date(NOW - 29 * 60 * 1000).toISOString() });
    ({ report } = plain(sandbox.api.buildProblemReport(ARGS, facts(sandbox, errors), "pr-0011223344556677", NOW + 2 * 60 * 1000)));
    assert.equal(report.lastError, null, "an error older than 30 minutes is not attached");
    ({ report } = plain(sandbox.api.buildProblemReport({ ...ARGS, tool: undefined }, facts(sandbox, errors), "pr-0011223344556677", NOW)));
    assert.equal(report.tool, null);
    assert.equal(report.lastError, null, "no tool named, no error attached");
    assert.equal(report.calls, null, "no tool named, no record of calls");
  });

  it("remembers the message of an error result, not its JSON", () => {
    const sandbox = load();
    const errors = sandbox.newErrors();
    sandbox.api.rememberToolError(errors, "saveDraft", JSON.stringify({ error: "Draft not found: x" }), NOW);
    assert.equal(errors.get("saveDraft").text, "Draft not found: x");
    sandbox.api.rememberToolError(errors, "saveDraft", JSON.stringify({ error: { code: 5 } }), NOW);
    assert.equal(errors.get("saveDraft").text, "{\"error\":{\"code\":5}}");
  });

  it("cuts a remembered error at 300 characters", () => {
    const sandbox = load();
    const errors = sandbox.newErrors();
    sandbox.api.rememberToolError(errors, "saveDraft", "x".repeat(1000), NOW);
    assert.equal(errors.get("saveDraft").text.length, 300);
  });
});

describe("reportProblem: the add-on's record of calls", () => {
  it("keeps the names of the arguments, never their values, and the last five calls of a tool", () => {
    const sandbox = load();
    const calls = sandbox.newErrors();
    for (let n = 0; n < 7; n++) {
      sandbox.api.rememberToolCall(calls, "saveDraft", { to: "jane@example.com", body: `text ${n}`, "bad name!": 1 }, "imap", n, n % 2 === 0, NOW + n);
    }
    sandbox.api.rememberToolCall(calls, "searchMessages", "not an object", undefined, -3, "yes", NOW);
    const saved = plain(calls.get("saveDraft"));
    assert.equal(saved.length, 5);
    assert.deepEqual(saved[0], { atMs: NOW + 2, args: ["body", "to"], account: "imap", ms: 2, ok: true });
    assert.deepEqual(saved[4], { atMs: NOW + 6, args: ["body", "to"], account: "imap", ms: 6, ok: true });
    assert.ok(!JSON.stringify(saved).includes("jane"));
    assert.deepEqual(plain(calls.get("searchMessages")), [{ atMs: NOW, args: [], account: null, ms: 0, ok: false }]);
  });

  it("a report that names a tool never called since Thunderbird started says so", () => {
    const sandbox = load();
    const { report } = plain(sandbox.api.buildProblemReport(ARGS, facts(sandbox), "pr-0011223344556677", NOW));
    assert.deepEqual(report.calls, []);
    const text = plain(sandbox.api.problemReportIssue(report)).body;
    assert.ok(text.includes("None: this version of the add-on has not seen this tool called. What is described above was not observed since Thunderbird last started."));
  });

  it("the dispatch records every call but those of reportProblem, with its duration and outcome", () => {
    assert.match(apiSource, /if \(method === "tools\/call" && params\.name !== "reportProblem"\) \{/);
    assert.match(apiSource, /rememberToolCall\(globalThis\.__cpMcpToolCalls \?\?= new Map\(\), params\.name, params\.arguments,\s+reportAccountKind\(params\.arguments\), nowMs - requestStartMs, !result\?\.isError, nowMs\);/);
  });

  it("the kind of account comes from the account or the folder, and a failure to tell is not an error", () => {
    const fn = slice("            function reportAccountKind(args) {", "            const server = new HttpServer();");
    assert.match(fn, /isGMailServer \? "imap \(gmail\)" : "imap"/);
    assert.match(fn, /\} catch \{\s+return null;/);
  });
});

describe("reportProblem: mail addresses never reach the report", () => {
  it("replaces them in the summary, the details and the remembered error", () => {
    const sandbox = load();
    const errors = sandbox.newErrors();
    sandbox.api.rememberToolError(errors, "saveDraft", "Folder not found: imap://jane.doe%40example.com@imap.example.com/INBOX", NOW);
    const { report } = plain(sandbox.api.buildProblemReport({
      ...ARGS,
      summary: "reply to jane.doe@example.com fails",
      details: "The message from Jane <jane.doe+list@mail.example.co.uk> was not found.",
      called: "replyToMessage to jane.doe@example.com",
      got: "an error for jane.doe@example.com",
      expected: "a draft to jane.doe@example.com",
    }, facts(sandbox, errors), "pr-0011223344556677", NOW));
    assert.equal(report.called, "replyToMessage to <address>");
    assert.equal(report.got, "an error for <address>");
    assert.equal(report.expected, "a draft to <address>");
    const stored = JSON.stringify(report);
    assert.ok(!/example\.co|jane\.doe/.test(stored), stored);
    assert.equal(report.summary, "reply to <address> fails");
    assert.equal(report.details, "The message from Jane <<address>> was not found.");
    assert.equal(report.lastError.text, "Folder not found: imap://<address>/INBOX");
  });

  it("leaves a search operator and a version alone", () => {
    const sandbox = load();
    assert.equal(sandbox.api.cleanReportText("participant:@example.com on 140.17.0esr", false), "participant:@example.com on 140.17.0esr");
  });

  it("removes control characters, keeps line breaks in the details only", () => {
    const sandbox = load();
    assert.equal(sandbox.api.cleanReportText("a\u0000b\u001bc\nd\te", false), "a b c\nd e");
    assert.equal(sandbox.api.cleanReportText("  a\n\n b\t c  ", true), "a b c");
  });
});

describe("reportProblem: what is refused", () => {
  const cases = [
    ["an unknown kind", { ...ARGS, kind: "praise" }, /^kind must be one of: bug, suggestion$/],
    ["an empty summary", { ...ARGS, summary: "   " }, /^summary is empty$/],
    ["a bug without what was called", { ...ARGS, called: " " }, /^A bug report needs called, got, expected: missing called$/],
    ["a bug with details only, as 0.27.0 took it", { kind: "bug", summary: "x", details: "all in one" }, /^A bug report needs called, got, expected: missing called, got, expected$/],
    ["a bug answer over 500 characters", { ...ARGS, got: "g".repeat(501) }, /^got is too long \(501 characters, limit 500\)$/],
    ["a suggestion without details", { kind: "suggestion", summary: "x", called: "y" }, /^A suggestion needs details: what you needed/],
    ["a summary over 120 characters", { ...ARGS, summary: "s".repeat(121) }, /^summary is too long \(121 characters, limit 120\)$/],
    ["details over 1500 characters", { ...ARGS, details: "d".repeat(1501) }, /^details is too long \(1501 characters, limit 1500\)$/],
    ["a tool this server does not have", { ...ARGS, tool: "sendEverything" }, /^tool is not the name of a tool of this server: sendEverything$/],
    ["a summary that is not text", { ...ARGS, summary: 12 }, /^summary is empty$/],
  ];
  for (const [name, args, pattern] of cases) {
    it(name, () => {
      const sandbox = load();
      const out = plain(sandbox.api.buildProblemReport(args, facts(sandbox), "pr-0011223344556677", NOW));
      assert.equal(out.report, undefined);
      assert.match(out.error, pattern);
    });
  }

  it("accepts the limits themselves", () => {
    const sandbox = load();
    const out = plain(sandbox.api.buildProblemReport({ ...ARGS, summary: "s".repeat(120), details: "d".repeat(1500), called: "c".repeat(500), got: "g".repeat(500), expected: "e".repeat(500) }, facts(sandbox), "pr-0011223344556677", NOW));
    assert.equal(out.error, undefined);
    assert.equal(plain(sandbox.api.buildProblemReport(SUGGESTION_ARGS, facts(sandbox), "pr-0011223344556677", NOW)).error, undefined);
  });
});

describe("reportProblem: the list of waiting reports", () => {
  function report(sandbox, n) {
    return plain(sandbox.api.buildProblemReport({ ...ARGS, summary: `report ${n}` }, facts(sandbox), `pr-${String(n).padStart(16, "0")}`, NOW + n)).report;
  }

  it("holds 20 reports and refuses the 21st", () => {
    const sandbox = load();
    let reports = [];
    for (let n = 0; n < 20; n++) reports = plain(sandbox.api.addProblemReport(reports, report(sandbox, n))).reports;
    assert.equal(reports.length, 20);
    const out = plain(sandbox.api.addProblemReport(reports, report(sandbox, 20)));
    assert.equal(out.reports, undefined);
    assert.match(out.error, /^20 reports are waiting for the user/);
  });

  it("refuses the same report twice", () => {
    const sandbox = load();
    const { reports } = plain(sandbox.api.addProblemReport([], report(sandbox, 1)));
    const again = { ...report(sandbox, 1), id: "pr-ffffffffffffffff" };
    assert.deepEqual(plain(sandbox.api.addProblemReport(reports, again)), { error: "This report is already saved." });
  });

  it("reads back what it wrote, and drops what lost its shape", () => {
    const sandbox = load();
    const good = report(sandbox, 1);
    const text = JSON.stringify([
      good,
      { ...good, id: "../../etc/passwd" },
      { ...good, id: "pr-0000000000000002", kind: "other" },
      { ...good, id: "pr-0000000000000003", details: "d".repeat(1501) },
      { ...good, id: "pr-0000000000000004", lastError: { text: 5, at: "x" } },
      { ...good, id: "pr-0000000000000005", tool: { name: "x" } },
      { ...good, id: "pr-0000000000000006", got: null },
      { ...good, id: "pr-0000000000000007", calls: [{ at: "x", args: ["a"], account: null, ms: "fast", ok: true }] },
      { ...good, id: "pr-0000000000000008", calls: Array.from({ length: 6 }, () => ({ at: "x", args: [], account: null, ms: 1, ok: true })) },
      "text",
      null,
    ]);
    assert.deepEqual(plain(sandbox.api.parseProblemReports(text)), [good]);
    for (const broken of ["", "{", "{}", "null", "\"x\""]) {
      assert.deepEqual(plain(sandbox.api.parseProblemReports(broken)), [], JSON.stringify(broken));
    }
  });

  it("keeps a report saved by 0.27.0: details only, no record of calls", () => {
    const sandbox = load();
    const old = {
      id: "pr-79f391772df3d02f", at: "2026-11-27T21:51:47.513Z", kind: "bug", summary: "old shape", details: "all in one",
      tool: "saveDraft", addon: "0.27.0", bridge: "0.20.0", thunderbird: "161.0", os: "WINNT", lastError: null,
    };
    assert.deepEqual(plain(sandbox.api.parseProblemReports(JSON.stringify([old]))), [old]);
    const [entry] = plain(sandbox.api.problemReportsView([old])).reports;
    assert.ok(entry.text.includes("### Details\n\nall in one"));
    assert.ok(!entry.text.includes("### Calls of this tool"));
  });

  it("reads at most 20 reports from a file that holds more", () => {
    const sandbox = load();
    const many = Array.from({ length: 30 }, (_, n) => report(sandbox, n));
    assert.equal(sandbox.api.parseProblemReports(JSON.stringify(many)).length, 20);
  });
});

describe("reportProblem: what the options page receives", () => {
  it("lists the newest first, with the text and the address of the issue", () => {
    const sandbox = load();
    const errors = sandbox.newErrors();
    sandbox.api.rememberToolError(errors, "saveDraft", "Draft ```not``` found", NOW);
    const withCalls = facts(sandbox, errors);
    sandbox.api.rememberToolCall(withCalls.calls, "saveDraft", { draftId: "<x@y.example>", body: "secret text", isHtml: true }, "imap (gmail)", 512.4, true, NOW - 60000);
    sandbox.api.rememberToolCall(withCalls.calls, "saveDraft", { draftId: "x" }, null, 8, false, NOW - 1000);
    const first = plain(sandbox.api.buildProblemReport(ARGS, withCalls, "pr-0000000000000001", NOW)).report;
    const second = plain(sandbox.api.buildProblemReport(SUGGESTION_ARGS,
      { ...facts(sandbox), bridge: null, addonUpdated: null }, "pr-0000000000000002", NOW + 1)).report;
    const view = plain(sandbox.api.problemReportsView([first, second]));
    assert.equal(view.max, 20);
    assert.deepEqual(view.reports.map((r) => r.id), ["pr-0000000000000002", "pr-0000000000000001"]);
    const [suggestion, bug] = view.reports;
    assert.equal(bug.text, [
      "Bug: saveDraft keeps the old draft listed",
      "",
      "_Written by an AI assistant with the `reportProblem` tool, then read and sent by the user._",
      "",
      "**Kind:** bug",
      "**Tool:** `saveDraft`",
      "",
      "### Call",
      "",
      "saveDraft with draftId on an IMAP account",
      "",
      "### Result",
      "",
      "success, and the old version stayed listed",
      "",
      "### Expected",
      "",
      "the old version no longer listed",
      "",
      "### Last error of this tool (recorded by the add-on, 2026-11-27T15:00:00.000Z)",
      "",
      "```",
      "Draft ~~~not~~~ found",
      "```",
      "",
      "### Calls of this tool since Thunderbird started (recorded by the add-on, argument names only)",
      "",
      "- 2026-11-27T14:59:00.000Z: saveDraft(body, draftId, isHtml) on imap (gmail): ok, 512 ms",
      "- 2026-11-27T14:59:59.000Z: saveDraft(draftId): error, 8 ms",
      "",
      "### Versions",
      "",
      "- Add-on: 0.26.3 (installed or updated 2026-11-27)",
      "- Bridge: 0.20.0",
      "- Thunderbird: 140.17.0",
      "- System: WINNT",
    ].join("\n"));
    assert.ok(suggestion.text.startsWith("Suggestion: name the reminder words\n"));
    assert.ok(suggestion.text.includes("- Bridge: not reported"));
    assert.ok(suggestion.text.includes("- Add-on: 0.26.3\n"));
    assert.ok(suggestion.text.includes("### Details\n\nsaveDraft could list them."));
    assert.ok(!bug.text.includes("secret text"), "the values of the arguments are never recorded");
    assert.ok(!suggestion.text.includes("**Tool:**"));
    const url = new URL(bug.issueUrl);
    assert.equal(url.origin + url.pathname, "https://github.com/commonpost/thunderbird-mcp/issues/new");
    assert.equal(url.searchParams.get("title"), "Bug: saveDraft keeps the old draft listed");
    assert.equal(`${url.searchParams.get("title")}\n\n${url.searchParams.get("body")}`, bug.text);
    assert.deepEqual([...url.searchParams.keys()], ["title", "body"]);
  });

  it("cuts the details in a link that GitHub would refuse, never in the text", () => {
    const sandbox = load();
    const long = plain(sandbox.api.buildProblemReport({ ...ARGS, details: "é ".repeat(750).trim(), got: "è".repeat(500) }, facts(sandbox), "pr-0000000000000001", NOW)).report;
    const [entry] = plain(sandbox.api.problemReportsView([long])).reports;
    assert.ok(entry.issueUrl.length <= 7000, `${entry.issueUrl.length} characters`);
    assert.ok(new URL(entry.issueUrl).searchParams.get("body").includes("Cut to fit a link"));
    assert.ok(entry.text.includes(long.details), "the text to copy keeps the whole details");
    assert.ok(entry.text.includes(long.got));
  });

  it("the options page opens nothing but a new issue of this repository", () => {
    const m = /const REPORT_ISSUE_URL_PATTERN = (\/.+\/);/.exec(optionsSource);
    assert.ok(m, "REPORT_ISSUE_URL_PATTERN not found in options.js");
    const pattern = vm.runInNewContext(m[1]);
    const sandbox = load();
    const report = plain(sandbox.api.buildProblemReport({ ...ARGS, details: "a & b # c ? d = e\n<script>" }, facts(sandbox), "pr-0000000000000001", NOW)).report;
    const [entry] = plain(sandbox.api.problemReportsView([report])).reports;
    assert.ok(pattern.test(entry.issueUrl), entry.issueUrl);
    for (const other of [
      "https://github.com/commonpost/thunderbird-mcp/issues/new?title=a&body=b&assignees=someone",
      "https://github.com/other/repo/issues/new?title=a&body=b",
      "https://github.com.example.org/commonpost/thunderbird-mcp/issues/new?title=a&body=b",
      "http://github.com/commonpost/thunderbird-mcp/issues/new?title=a&body=b",
      "https://github.com/commonpost/thunderbird-mcp/issues/new?title=a&body=b#x",
      "javascript:alert(1)",
    ]) {
      assert.ok(!pattern.test(other), other);
    }
    assert.match(optionsSource, /if \(REPORT_ISSUE_URL_PATTERN\.test\(report\.issueUrl\)\) \{/);
  });
});

describe("reportProblem: the report as a message to the project", () => {
  it("is addressed to the project's mailbox and holds the text of the issue", () => {
    const sandbox = load();
    const report = plain(sandbox.api.buildProblemReport(ARGS, facts(sandbox), "pr-0000000000000001", NOW)).report;
    const mail = plain(sandbox.api.problemReportMail(report));
    assert.equal(mail.to, "commonpost.mcp@gmail.com");
    assert.equal(mail.subject, "[report] Bug: saveDraft keeps the old draft listed");
    assert.equal(mail.body, plain(sandbox.api.problemReportIssue(report)).body);
  });

  it("opens a plain text compose window and sends nothing itself", () => {
    const compose = slice("    function composeProblemReport(report) {", "    // When this add-on was installed or last updated");
    assert.match(compose, /params\.type = Ci\.nsIMsgCompType\.New;/);
    assert.match(compose, /params\.format = Ci\.nsIMsgCompFormat\.PlainText;/);
    assert.match(compose, /OpenComposeWindowWithParams\(null, params\)/);
    assert.ok(!/sendMsg|SendMsg|nsIMsgSend|deliverMode/.test(compose), "no send path");
    assert.ok(!/addAttachment|\.cc =|\.bcc =/.test(compose), "one recipient, no attachment");
  });

  it("removes the report only after the window opened", () => {
    const fn = slice("        mailProblemReport: async function(id) {", "        getCurrentAuthToken: async function() {");
    assert.ok(fn.indexOf("composeProblemReport(report);") < fn.indexOf("writeProblemReports(kept);"));
    assert.match(fn, /if \(!report\) return \{ error: "This report is no longer in the list\." \};/);
  });
});

describe("reportProblem: the tool", () => {
  function tool({ stored = [], bridges = [], failWrite = false, delivery, draft, send } = {}) {
    const state = { stored, written: null, drafts: [], sends: [] };
    const mailer = {
      draft: async (mail) => { state.drafts.push(mail); return draft ? draft() : { success: true, messageId: "d1@x", folderPath: "imap://u@h/Drafts" }; },
      send: async (mail) => { state.sends.push(mail); return send ? send() : { success: true }; },
    };
    const sandbox = vm.createContext({
      Cc: { "@mozilla.org/security/random-generator;1": { createInstance: () => ({ generateRandomBytes: (n) => Array.from({ length: n }, (_, i) => i + 1) }) } },
      Ci: { nsIRandomGenerator: {} },
      Services: {
        appinfo: { version: "156.0.1", OS: "Linux" },
        prefs: { getCharPref: (name, fallback) => {
          assert.equal(name, "extensions.commonpost-mcp.reportDelivery");
          if (delivery === "throws") throw new Error("pref unreadable");
          return delivery ?? fallback;
        } },
      },
      buildTools: () => TOOLS.map((name) => ({ name })),
      getExtVersion: () => "0.26.3",
      readProblemReports: () => state.stored,
      writeProblemReports: (reports) => {
        if (failWrite) throw new Error("disk full");
        state.written = JSON.parse(JSON.stringify(reports));
        state.stored = state.written;
      },
    });
    vm.runInContext(`${slice("// BEGIN PROBLEM REPORTS", "// END PROBLEM REPORTS")}
      Date.now = () => ${NOW};
      const addonUpdateDate = async () => "2026-11-27";
      ${slice("    function reportDeliveryPref() {", "    // END PROBLEM REPORT STORE")}
      globalThis.__cpMcpBridgesSeen = new Map(${JSON.stringify(bridges)});
      this.rawReportProblem = reportProblem; this.rememberToolError = rememberToolError;
      this.errors = () => (globalThis.__cpMcpToolErrors ??= new Map());`, sandbox);
    sandbox.reportProblem = (args) => sandbox.rawReportProblem(args, mailer);
    return { sandbox, state };
  }

  it("saves the report, makes a draft of it, says it was not sent and tells the assistant what to tell the user", async () => {
    const { sandbox, state } = tool({ bridges: [["a", { version: "0.19.0", lastSeenMs: 5 }], ["b", { version: "0.20.0", lastSeenMs: 9 }]] });
    const out = plain(await sandbox.reportProblem({ ...ARGS }));
    assert.equal(out.saved, true);
    assert.equal(state.written[0].addonUpdated, "2026-11-27");
    assert.equal(out.sent, false);
    assert.equal(out.waiting, 1);
    assert.deepEqual(out.draft, { messageId: "d1@x", folderPath: "imap://u@h/Drafts" });
    assert.match(out.next, /^Nothing was sent\. A draft addressed to the maintainers is in the user's Drafts folder: tell them to read it and send it\./);
    assert.equal(state.sends.length, 0);
    assert.equal(state.drafts.length, 1);
    assert.equal(state.drafts[0].to, "commonpost.mcp@gmail.com");
    assert.match(state.drafts[0].body, /^_Written by an AI assistant with the `reportProblem` tool, then read and sent by the user\._/);
    assert.equal(state.written[0].mail.mode, "draft");
    const url = new URL(out.issueUrl);
    assert.equal(url.origin + url.pathname, "https://github.com/commonpost/thunderbird-mcp/issues/new");
    assert.equal(url.searchParams.get("title"), `Bug: ${ARGS.summary}`);
    assert.ok(url.searchParams.get("body").includes("- Add-on: 0.26.3"));
    assert.equal(state.written.length, 1);
    assert.equal(state.written[0].id, "pr-0102030405060708");
    assert.equal(state.written[0].addon, "0.26.3");
    assert.equal(state.written[0].bridge, "0.20.0", "the bridge last seen is the one of this request");
    assert.equal(state.written[0].thunderbird, "156.0.1");
    assert.equal(state.written[0].os, "Linux");
  });

  it("attaches the error the named tool returned earlier", async () => {
    const { sandbox, state } = tool();
    sandbox.rememberToolError(sandbox.errors(), "saveDraft", "Draft not found", NOW - 5000);
    await sandbox.reportProblem({ ...ARGS });
    assert.equal(state.written[0].lastError.text, "Draft not found");
    assert.equal(state.written[0].bridge, null, "no bridge header, no bridge version");
  });

  it("writes nothing when the report is refused", async () => {
    const { sandbox, state } = tool();
    assert.deepEqual(plain(await sandbox.reportProblem({ ...ARGS, kind: "x" })), { error: "kind must be one of: bug, suggestion" });
    assert.equal(state.written, null);
  });

  it("send: true without the user's choice in the options page sends nothing: a draft, and the reason", async () => {
    for (const delivery of [undefined, "draft", "anything", "throws"]) {
      const { sandbox, state } = tool({ delivery });
      const out = plain(await sandbox.reportProblem({ ...ARGS, send: true }));
      assert.equal(out.sent, false, String(delivery));
      assert.equal(state.sends.length, 0, String(delivery));
      assert.equal(state.drafts.length, 1, String(delivery));
      assert.match(out.next, /It was not sent: the user has not allowed assistants to send reports/);
    }
  });

  it("sends when the user chose so and the assistant passes send: true, and says who sent it", async () => {
    const { sandbox, state } = tool({ delivery: "send" });
    const out = plain(await sandbox.reportProblem({ ...ARGS, send: true }));
    assert.equal(out.sent, true);
    assert.equal(out.draft, undefined);
    assert.equal(state.drafts.length, 0);
    assert.equal(state.sends.length, 1);
    assert.equal(state.sends[0].to, "commonpost.mcp@gmail.com");
    assert.match(state.sends[0].body, /^_Written by an AI assistant with the `reportProblem` tool and sent by the add-on: .*They may not have read this text\._/);
    assert.match(out.next, /^Sent to the maintainers/);
    assert.equal(state.written[0].mail.mode, "sent");
  });

  it("the user's choice alone sends nothing: without send: true the report is a draft", async () => {
    for (const send of [undefined, false, null]) {
      const { sandbox, state } = tool({ delivery: "send" });
      const out = plain(await sandbox.reportProblem({ ...ARGS, send }));
      assert.equal(out.sent, false);
      assert.equal(state.sends.length, 0);
      assert.equal(state.drafts.length, 1);
      assert.doesNotMatch(out.next, /not allowed/);
    }
  });

  it("refuses a send that is not true or false", async () => {
    const { sandbox, state } = tool({ delivery: "send" });
    assert.deepEqual(plain(await sandbox.reportProblem({ ...ARGS, send: "yes" })), { error: "send must be true or false" });
    assert.equal(state.written, null);
    assert.equal(state.sends.length, 0);
  });

  it("a send that fails leaves a draft and says so", async () => {
    const { sandbox, state } = tool({ delivery: "send", send: () => ({ error: "SMTP down" }) });
    const out = plain(await sandbox.reportProblem({ ...ARGS, send: true }));
    assert.equal(out.sent, false);
    assert.equal(state.drafts.length, 1);
    assert.match(state.drafts[0].body, /then read and sent by the user/);
    assert.match(out.next, /Sending failed \(SMTP down\)/);
    assert.equal(state.written[0].mail.mode, "draft");
  });

  it("a draft that cannot be made leaves the report in the list, saved", async () => {
    for (const draft of [() => ({ error: "No accessible identity found" }), () => { throw new Error("No accessible identity found"); }]) {
      const { sandbox, state } = tool({ draft });
      const out = plain(await sandbox.reportProblem({ ...ARGS }));
      assert.equal(out.saved, true);
      assert.equal(out.sent, false);
      assert.equal(out.draft, undefined);
      assert.match(out.next, /No draft could be made \(.*No accessible identity found\)\. The report waits in the add-on's Options page/);
      assert.equal(state.written.length, 1);
      assert.equal(state.written[0].mail, undefined);
    }
  });

  it("with the choice to only list, no message is made, whatever the assistant asks", async () => {
    const { sandbox, state } = tool({ delivery: "list" });
    const out = plain(await sandbox.reportProblem({ ...ARGS, send: true }));
    assert.equal(out.sent, false);
    assert.equal(state.drafts.length + state.sends.length, 0);
    assert.match(out.next, /^Nothing was sent\. The report waits in the add-on's Options page/);
  });

  it("past three sends in 24 hours a report is a draft, past six messages it only waits in the list", async () => {
    const at = (hoursAgo) => new Date(NOW - hoursAgo * 3600 * 1000).toISOString();
    const old = (n, mode, hoursAgo) => Array.from({ length: n }, (_, i) => ({ id: `pr-${mode}${hoursAgo}${i}`, mail: { mode, at: at(hoursAgo) } }));
    let run = tool({ delivery: "send", stored: [...old(3, "sent", 23), ...old(2, "sent", 25)] });
    let out = plain(await run.sandbox.reportProblem({ ...ARGS, send: true }));
    assert.equal(out.sent, false);
    assert.equal(run.state.sends.length, 0);
    assert.equal(run.state.drafts.length, 1);
    assert.match(out.next, /It was not sent: 3 reports were sent in the last 24 hours/);

    run = tool({ delivery: "send", stored: [...old(2, "sent", 23), ...old(5, "sent", 25)] });
    out = plain(await run.sandbox.reportProblem({ ...ARGS, send: true }));
    assert.equal(out.sent, true, "a send older than a day does not count");

    run = tool({ delivery: "send", stored: [...old(2, "sent", 1), ...old(4, "draft", 2)] });
    out = plain(await run.sandbox.reportProblem({ ...ARGS, send: true }));
    assert.equal(out.sent, false);
    assert.equal(run.state.sends.length + run.state.drafts.length, 0);
    assert.match(out.next, /No draft was made: 6 reports became messages in the last 24 hours/);
  });

  it("lets a failed write reach the assistant as an error", async () => {
    const { sandbox } = tool({ failWrite: true });
    await assert.rejects(() => sandbox.reportProblem({ ...ARGS }), /disk full/);
  });
});

describe("reportProblem: wiring", () => {
  it("is dispatched, and its own errors are not remembered as the error of a tool", () => {
    assert.match(apiSource, /case "reportProblem":\s+return reportProblem\(args, \{\s+draft: \(mail\) => saveDraft\(mail\.to, mail\.subject, mail\.body, "", "", false\),\s+send: \(mail\) => sendProblemReportMail\(mail\),\s+\}\);/);
    assert.match(apiSource, /if \(result\?\.isError\) \{\s+rememberToolError\(/);
  });

  it("the file is in the profile, created for the user only, and removed when the last report is deleted", () => {
    const store = slice("    // BEGIN PROBLEM REPORT STORE", "    // END PROBLEM REPORT STORE");
    assert.match(store, /Services\.dirsvc\.get\("ProfD", Ci\.nsIFile\)/);
    assert.match(store, /ostream\.init\(file, 0x02 \| 0x08 \| 0x20, 0o600, 0\)/);
    assert.match(store, /if \(reports\.length === 0\) \{\s+if \(file\.exists\(\)\) file\.remove\(false\);/);
    assert.equal((store.match(/file\.isSymlink\(\) \|\| !file\.isFile\(\)/g) || []).length, 2, "read and write both refuse a link");
  });

  it("the report code reaches no network itself: a message goes through the mailer it is given", () => {
    const helpers = slice("// BEGIN PROBLEM REPORTS", "// END PROBLEM REPORTS") + slice("    // BEGIN PROBLEM REPORT STORE", "    // END PROBLEM REPORT STORE");
    assert.ok(!/fetch\(|XMLHttpRequest|nsIHttpChannel|openDefaultBrowser|launch\(|sendMsg|nsIMsgSend\b|sendMessageDirectly/.test(helpers));
    assert.equal((helpers.match(/mailer\.send\(/g) || []).length, 1);
    assert.match(helpers, /if \(plan\.mode === "send"\) \{\s+const sent = await mailer\.send\(problemReportMail\(built\.report, true\)\);/);
  });

  it("a report is only ever addressed to the project, with no copy to anyone", () => {
    const sandbox = load();
    const report = plain(sandbox.api.buildProblemReport(ARGS, facts(sandbox), "pr-0000000000000001", NOW)).report;
    for (const unread of [false, true]) assert.equal(sandbox.api.problemReportMail(report, unread).to, "commonpost.mcp@gmail.com");
    const send = slice("            function sendProblemReportMail(mail) {", "             * Saves a composed message to the identity's Drafts folder");
    assert.match(send, /fields\.to = mail\.to;/);
    assert.ok(!/\.cc\b|\.bcc\b|addAttachment|setDirectSendRecipients/.test(send), "no Cc, Bcc or attachment");
    assert.match(send, /setComposeIdentity\(params, null, null\)/, "the default identity, among the accounts the user allows");
  });

  it("the options page can only set one of the three choices", () => {
    const fn = slice("        setReportDelivery: async function(reportDelivery) {", "        deleteProblemReport: async function(id) {");
    assert.match(fn, /if \(!PROBLEM_REPORT_DELIVERIES\.includes\(reportDelivery\)\) \{\s+return \{ error:/);
    const sandbox = load();
    for (const [value, expected] of [["draft", "draft"], ["send", "send"], ["list", "list"], ["", "draft"], [undefined, "draft"], ["SEND", "draft"], [true, "draft"]]) {
      assert.equal(sandbox.api.problemReportDelivery(value), expected, String(value));
    }
  });

  it("the options page deletes through the add-on and shows what remains", () => {
    assert.match(optionsSource, /showReports\(await browser\.commonpostMcp\.deleteProblemReport\(report\.id\)\);/);
    assert.match(optionsSource, /showReports\(await browser\.commonpostMcp\.getProblemReports\(\)\);/);
  });
});

describe("reportProblem: a list that rolls", () => {
  const report = (i, mail) => ({ id: `pr-${String(i).padStart(16, "0")}`, at: "2026-11-27T15:00:00.000Z", kind: "suggestion", summary: `s${i}`, details: "d", ...(mail ? { mail } : {}) });

  it("when the list is full, the oldest report that became a message makes room", () => {
    const sandbox = load();
    const full = Array.from({ length: sandbox.api.PROBLEM_REPORTS_MAX }, (_, i) => report(i, i === 3 || i === 7 ? { mode: "draft", at: "2026-11-27T15:00:00.000Z" } : null));
    const out = plain(sandbox.api.addProblemReport(full, report(99)));
    assert.equal(out.reports.length, sandbox.api.PROBLEM_REPORTS_MAX);
    assert.ok(!out.reports.some((r) => r.summary === "s3"));
    assert.ok(out.reports.some((r) => r.summary === "s7"));
    assert.equal(out.reports.at(-1).summary, "s99");
  });

  it("a full list of reports nobody has seen as a message still refuses", () => {
    const sandbox = load();
    const full = Array.from({ length: sandbox.api.PROBLEM_REPORTS_MAX }, (_, i) => report(i));
    assert.match(plain(sandbox.api.addProblemReport(full, report(99))).error, /^20 reports are waiting/);
  });

  it("the file keeps what became of a report, and drops one whose record lost its shape", () => {
    const sandbox = load();
    const good = report(1, { mode: "sent", at: "2026-11-27T15:00:00.000Z" });
    const parsed = plain(sandbox.api.parseProblemReports(JSON.stringify([good, report(2, { mode: "posted", at: "x" }), report(3, "draft"), report(4)])));
    assert.deepEqual(parsed.map((r) => r.summary), ["s1", "s4"]);
    assert.deepEqual(plain(sandbox.api.problemReportsView(parsed)).reports.map((r) => r.mail), [null, good.mail]);
  });
});
