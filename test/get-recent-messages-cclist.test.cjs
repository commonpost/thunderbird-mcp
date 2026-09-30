"use strict";

// getRecentMessages omitted ccList from its result rows; searchMessages includes it
// (upstream TKasperczyk/thunderbird-mcp#174 by Gunther Schulz). getRecentMessages now
// runs through searchMessages, so both share one row format. Runs the real functions.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const apiSource = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");

function region(name) {
  const start = apiSource.indexOf(`// BEGIN ${name}`);
  const end = apiSource.indexOf(`// END ${name}`, start);
  assert.ok(start >= 0 && end > start, `${name} markers missing`);
  return apiSource.slice(start, end);
}

const HAS_RE = 0x10;
const ENCODED_CC = "=?UTF-8?Q?Bob_=C3=85lpha?= <bob@alpha.test>";

function load() {
  const searches = [];
  const sandbox = {
    Ci: { nsMsgFolderFlags: { Drafts: 0x400, Templates: 0x400000, Queue: 0x800 }, nsMsgMessageFlags: { HasRe: HAS_RE } },
    decodeHeaderValue: value => (value === ENCODED_CC ? "Bob Ålpha <bob@alpha.test>" : value || ""),
    getUserTags: () => [],
    outerWireSubject: (msgHdr, fallback) => msgHdr.wireSubject ?? fallback,
    searchMessages: (args, options) => { searches.push(args); searches.options = options; return { messages: [] }; },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${region("FOLDER NAME HELPERS")}
${region("SEARCH ROW BUILDER")}
${region("RECENT MESSAGES")}
this.buildSearchRow = buildSearchRow;
this.getRecentMessages = getRecentMessages;`, sandbox);
  return { ...sandbox, searches };
}

const hdr = {
  messageId: "chain3@alpha.test",
  threadId: 3,
  mime2DecodedSubject: "Project kickoff",
  flags: HAS_RE,
  mime2DecodedAuthor: "Ann Alpha <ann@alpha.test>",
  mime2DecodedRecipients: "me@bench.test",
  ccList: ENCODED_CC,
  date: Date.UTC(2026, 2, 2, 11) * 1000,
  isRead: true,
  isFlagged: false,
  getStringProperty: name => (name === "preview" ? "See you there" : ""),
};
const folder = { URI: "mailbox://nobody@Local%20Folders/Inbox", prettyName: "Inbox", isSpecialFolder: () => false };

describe("getRecentMessages result rows", () => {
  it("runs searchMessages over the last daysBack days with its filters", () => {
    const { getRecentMessages, searches } = load();
    const before = Date.now();
    getRecentMessages({ folderPath: folder.URI, daysBack: 3, maxResults: 5, offset: 2, unreadOnly: true, includeTrash: true, format: "legacy" });
    const [args] = searches;
    assert.deepEqual(
      { ...args, startDate: undefined },
      { query: "", folderPath: folder.URI, startDate: undefined, maxResults: 5, offset: 2, sortOrder: "desc", unreadOnly: true,
        flaggedOnly: undefined, includeSubfolders: undefined, includeTrash: true, format: "legacy" }
    );
    // No query: an encrypted message is listed with its content withheld, as getRecentMessages did in 0.10.x.
    assert.deepEqual({ ...searches.options }, { listEncrypted: true });
    const start = Date.parse(args.startDate);
    assert.ok(start >= before - 3 * 86400000 - 1000 && start <= Date.now() - 3 * 86400000);
    getRecentMessages({});
    assert.ok(Math.abs(Date.parse(searches[1].startDate) - (Date.now() - 7 * 86400000)) < 5000);
  });

  it("search rows carry the decoded ccList", () => {
    const { buildSearchRow } = load();
    const row = JSON.parse(JSON.stringify(buildSearchRow(hdr, folder)));
    assert.equal(row.ccList, "Bob Ålpha <bob@alpha.test>");
    assert.equal(row.subject, "Re: Project kickoff");
    assert.equal(row.date, "2026-03-02T11:00:00.000Z");
    assert.equal(row.preview, "See you there");
    assert.equal(row._threadId, undefined);
    const legacy = buildSearchRow(hdr, folder, true);
    assert.deepEqual([legacy._threadId, legacy._folderName, legacy._legacySubject], [3, "Inbox", "Project kickoff"]);
    const renamed = { URI: folder.URI, localizedName: "Posteingang", isSpecialFolder: () => false };
    assert.equal(buildSearchRow(hdr, renamed, true)._folderName, "Posteingang");
  });

  it("withholds the subject and preview of an encrypted message", () => {
    const { buildSearchRow } = load();
    const row = JSON.parse(JSON.stringify(buildSearchRow({ ...hdr, wireSubject: "..." }, folder, true, true)));
    assert.deepEqual([row.subject, row._legacySubject, row.encrypted, row.preview], ["...", "...", true, undefined]);
  });
});
