// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";

// reportProblem: an assistant saves a report about a tool; the user sends it, or not, from the options page.
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
    this.api = { cleanReportText, rememberToolError, buildProblemReport, parseProblemReports, addProblemReport,
      problemReportIssue, problemReportIssueUrl, problemReportsView, problemReportMail, PROBLEM_REPORTS_MAX };
    this.newErrors = () => new Map();`, sandbox);
  return sandbox;
}

function facts(sandbox, errors = sandbox.newErrors()) {
  return { toolNames: TOOLS, addon: "0.26.3", bridge: "0.20.0", thunderbird: "140.17.0", os: "WINNT", errors };
}

const ARGS = { kind: "bug", summary: "saveDraft keeps the old draft listed", details: "Called saveDraft with draftId on an IMAP account.\nThe old version stayed listed.", tool: "saveDraft" };

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
      details: ARGS.details,
      tool: "saveDraft",
      addon: "0.26.3",
      bridge: "0.20.0",
      thunderbird: "140.17.0",
      os: "WINNT",
      lastError: null,
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

describe("reportProblem: mail addresses never reach the report", () => {
  it("replaces them in the summary, the details and the remembered error", () => {
    const sandbox = load();
    const errors = sandbox.newErrors();
    sandbox.api.rememberToolError(errors, "saveDraft", "Folder not found: imap://jane.doe%40example.com@imap.example.com/INBOX", NOW);
    const { report } = plain(sandbox.api.buildProblemReport({
      kind: "bug",
      summary: "reply to jane.doe@example.com fails",
      details: "The message from Jane <jane.doe+list@mail.example.co.uk> was not found.",
      tool: "saveDraft",
    }, facts(sandbox, errors), "pr-0011223344556677", NOW));
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
    ["empty details", { ...ARGS, details: "\n" }, /^details is empty$/],
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
    const out = plain(sandbox.api.buildProblemReport({ ...ARGS, summary: "s".repeat(120), details: "d".repeat(1500) }, facts(sandbox), "pr-0011223344556677", NOW));
    assert.equal(out.error, undefined);
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
      "text",
      null,
    ]);
    assert.deepEqual(plain(sandbox.api.parseProblemReports(text)), [good]);
    for (const broken of ["", "{", "{}", "null", "\"x\""]) {
      assert.deepEqual(plain(sandbox.api.parseProblemReports(broken)), [], JSON.stringify(broken));
    }
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
    const first = plain(sandbox.api.buildProblemReport(ARGS, facts(sandbox, errors), "pr-0000000000000001", NOW)).report;
    const second = plain(sandbox.api.buildProblemReport({ kind: "suggestion", summary: "name the reminder words", details: "saveDraft could list them." },
      { ...facts(sandbox), bridge: null }, "pr-0000000000000002", NOW + 1)).report;
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
      "### Details",
      "",
      "Called saveDraft with draftId on an IMAP account.",
      "The old version stayed listed.",
      "",
      "### Last error of this tool (recorded by the add-on, 2026-11-27T15:00:00.000Z)",
      "",
      "```",
      "Draft ~~~not~~~ found",
      "```",
      "",
      "### Versions",
      "",
      "- Add-on: 0.26.3",
      "- Bridge: 0.20.0",
      "- Thunderbird: 140.17.0",
      "- System: WINNT",
    ].join("\n"));
    assert.ok(suggestion.text.startsWith("Suggestion: name the reminder words\n"));
    assert.ok(suggestion.text.includes("- Bridge: not reported"));
    assert.ok(!suggestion.text.includes("**Tool:**"));
    const url = new URL(bug.issueUrl);
    assert.equal(url.origin + url.pathname, "https://github.com/commonpost/thunderbird-mcp/issues/new");
    assert.equal(url.searchParams.get("title"), "Bug: saveDraft keeps the old draft listed");
    assert.equal(`${url.searchParams.get("title")}\n\n${url.searchParams.get("body")}`, bug.text);
    assert.deepEqual([...url.searchParams.keys()], ["title", "body"]);
  });

  it("cuts the details in a link that GitHub would refuse, never in the text", () => {
    const sandbox = load();
    const long = plain(sandbox.api.buildProblemReport({ ...ARGS, details: "é ".repeat(750).trim() }, facts(sandbox), "pr-0000000000000001", NOW)).report;
    const [entry] = plain(sandbox.api.problemReportsView([long])).reports;
    assert.ok(entry.issueUrl.length <= 7000, `${entry.issueUrl.length} characters`);
    assert.ok(new URL(entry.issueUrl).searchParams.get("body").includes("Cut to fit a link"));
    assert.ok(entry.text.includes(long.details), "the text to copy keeps the whole details");
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
    const compose = slice("    function composeProblemReport(report) {", "    function reportProblem(args) {");
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
  function tool({ stored = [], bridges = [], failWrite = false } = {}) {
    const state = { stored, written: null };
    const sandbox = vm.createContext({
      Cc: { "@mozilla.org/security/random-generator;1": { createInstance: () => ({ generateRandomBytes: (n) => Array.from({ length: n }, (_, i) => i + 1) }) } },
      Ci: { nsIRandomGenerator: {} },
      Services: { appinfo: { version: "156.0.1", OS: "Linux" } },
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
      ${slice("    function reportProblem(args) {", "    // END PROBLEM REPORT STORE")}
      globalThis.__cpMcpBridgesSeen = new Map(${JSON.stringify(bridges)});
      this.reportProblem = reportProblem; this.rememberToolError = rememberToolError;
      this.errors = () => (globalThis.__cpMcpToolErrors ??= new Map());`, sandbox);
    return { sandbox, state };
  }

  it("saves the report, says it was not sent and tells the assistant what to tell the user", () => {
    const { sandbox, state } = tool({ bridges: [["a", { version: "0.19.0", lastSeenMs: 5 }], ["b", { version: "0.20.0", lastSeenMs: 9 }]] });
    const out = plain(sandbox.reportProblem({ ...ARGS }));
    assert.equal(out.saved, true);
    assert.equal(out.sent, false);
    assert.equal(out.waiting, 1);
    assert.match(out.next, /Options page/);
    assert.match(out.next, /Give the user issueUrl as a link, unchanged/);
    const url = new URL(out.issueUrl);
    assert.equal(url.origin + url.pathname, "https://github.com/commonpost/thunderbird-mcp/issues/new");
    assert.equal(url.searchParams.get("title"), `Bug: ${ARGS.summary}`);
    assert.ok(url.searchParams.get("body").includes("- Add-on: 0.26.3"));
    assert.match(out.next, /Do not say it was sent/);
    assert.equal(state.written.length, 1);
    assert.equal(state.written[0].id, "pr-0102030405060708");
    assert.equal(state.written[0].addon, "0.26.3");
    assert.equal(state.written[0].bridge, "0.20.0", "the bridge last seen is the one of this request");
    assert.equal(state.written[0].thunderbird, "156.0.1");
    assert.equal(state.written[0].os, "Linux");
  });

  it("attaches the error the named tool returned earlier", () => {
    const { sandbox, state } = tool();
    sandbox.rememberToolError(sandbox.errors(), "saveDraft", "Draft not found", NOW - 5000);
    sandbox.reportProblem({ ...ARGS });
    assert.equal(state.written[0].lastError.text, "Draft not found");
    assert.equal(state.written[0].bridge, null, "no bridge header, no bridge version");
  });

  it("writes nothing when the report is refused", () => {
    const { sandbox, state } = tool();
    assert.deepEqual(plain(sandbox.reportProblem({ ...ARGS, kind: "x" })), { error: "kind must be one of: bug, suggestion" });
    assert.equal(state.written, null);
  });

  it("lets a failed write reach the assistant as an error", () => {
    const { sandbox } = tool({ failWrite: true });
    assert.throws(() => sandbox.reportProblem({ ...ARGS }), /disk full/);
  });
});

describe("reportProblem: wiring", () => {
  it("is dispatched, and its own errors are not remembered as the error of a tool", () => {
    assert.match(apiSource, /case "reportProblem":\s+return reportProblem\(args\);/);
    assert.match(apiSource, /if \(method === "tools\/call" && result\?\.isError && params\.name !== "reportProblem"\) \{/);
  });

  it("the file is in the profile, created for the user only, and removed when the last report is deleted", () => {
    const store = slice("    // BEGIN PROBLEM REPORT STORE", "    // END PROBLEM REPORT STORE");
    assert.match(store, /Services\.dirsvc\.get\("ProfD", Ci\.nsIFile\)/);
    assert.match(store, /ostream\.init\(file, 0x02 \| 0x08 \| 0x20, 0o600, 0\)/);
    assert.match(store, /if \(reports\.length === 0\) \{\s+if \(file\.exists\(\)\) file\.remove\(false\);/);
    assert.equal((store.match(/file\.isSymlink\(\) \|\| !file\.isFile\(\)/g) || []).length, 2, "read and write both refuse a link");
  });

  it("no code of the add-on sends a report", () => {
    const helpers = slice("// BEGIN PROBLEM REPORTS", "// END PROBLEM REPORTS") + slice("    // BEGIN PROBLEM REPORT STORE", "    // END PROBLEM REPORT STORE");
    assert.ok(!/fetch\(|XMLHttpRequest|nsIHttpChannel|openDefaultBrowser|launch\(|sendMsg|nsIMsgSend\b/.test(helpers));
  });

  it("the options page deletes through the add-on and shows what remains", () => {
    assert.match(optionsSource, /showReports\(await browser\.commonpostMcp\.deleteProblemReport\(report\.id\)\);/);
    assert.match(optionsSource, /showReports\(await browser\.commonpostMcp\.getProblemReports\(\)\);/);
  });
});
