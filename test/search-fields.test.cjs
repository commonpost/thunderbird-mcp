// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";
// `fields` of searchMessages and getRecentMessages: rows cut to the chosen columns, id and folderPath always kept,
// with the real helpers, schemas and argument checks of api.js.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const API = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));

function region(name) {
  const start = API.indexOf(`// BEGIN ${name}`);
  const end = API.indexOf(`// END ${name}`, start);
  assert.ok(start >= 0 && end > start, `${name} markers missing`);
  return API.slice(start, end);
}

function fn(name, indent = "            ") {
  const start = API.indexOf(`\n${indent}function ${name}(`);
  assert.ok(start >= 0, `${name} not found in api.js`);
  const close = `\n${indent}}\n`;
  return API.slice(start, API.indexOf(close, start) + close.length);
}

const sandbox = { getConfiguredGetMessagesLimit: () => 20, console: { warn() {} } };
vm.createContext(sandbox);
vm.runInContext(`${[
  "INLINE ATTACHMENT BASE64 HELPERS", "OUTBOUND ATTACHMENT LIMITS", "CONTACT FIELD CONSTANTS", "FILTER SEARCH TERM HELPERS",
  "MESSAGE SEARCH HELPERS", "TOOL SCHEMA BUILDER", "TOOL SCHEMA VALIDATOR", "TOOL ARGUMENT CHECKS",
].map(region).join("\n")}
${fn("prepareSearch")}
Object.assign(this, { SEARCH_FIELD_CHOICES, searchFieldsRefusal, projectSearchRow, buildSearchPage, buildTools,
  coerceToolArgs, validateToolArgs, prepareSearch });`, sandbox);

const ROW = {
  id: "<m1@example.test>", folderPath: "imap://a/INBOX", date: "2026-11-01T10:00:00.000Z", author: "Alice <a@example.test>",
  recipients: "Bob <b@example.test>", subject: "Invoice", read: false, flagged: true, tags: ["$label1"],
  preview: "Please find attached", attachments: [{ name: "invoice.pdf" }], _dateTs: 1,
};

describe("fields: the columns", () => {
  it("are the search row columns but id and folderPath", () => {
    assert.deepEqual([...sandbox.SEARCH_FIELD_CHOICES],
      ["date", "author", "recipients", "ccList", "subject", "read", "flagged", "tags", "preview", "dupLocations"]);
  });

  it("are the enum of both tools' schemas", () => {
    const tools = sandbox.buildTools();
    for (const name of ["searchMessages", "getRecentMessages"]) {
      const fields = tools.find((t) => t.name === name).inputSchema.properties.fields;
      assert.equal(fields.type, "array", name);
      assert.deepEqual([...fields.items.enum], [...sandbox.SEARCH_FIELD_CHOICES], name);
    }
  });
});

describe("fields: a row cut to them", () => {
  it("keeps id, folderPath, the chosen columns and those an option added", () => {
    assert.deepEqual(plain(sandbox.projectSearchRow(ROW, ["subject", "date"])), {
      id: ROW.id, folderPath: ROW.folderPath, date: ROW.date, subject: "Invoice",
      attachments: [{ name: "invoice.pdf" }], _dateTs: 1,
    });
  });

  it("an empty list keeps only id, folderPath and option columns; none keeps the whole row", () => {
    assert.deepEqual(Object.keys(sandbox.projectSearchRow(ROW, [])), ["id", "folderPath", "attachments", "_dateTs"]);
    assert.equal(sandbox.projectSearchRow(ROW, null), ROW);
  });

  it("applies to a page in objects and in table format", () => {
    const objects = plain(sandbox.buildSearchPage([ROW], { offset: 0, limit: 20, fields: ["subject"] }));
    assert.deepEqual(objects.messages, [{ id: ROW.id, folderPath: ROW.folderPath, subject: "Invoice", attachments: [{ name: "invoice.pdf" }] }]);
    assert.equal(objects.totalMatches, 1);
    const table = plain(sandbox.buildSearchPage([ROW], { offset: 0, limit: 20, format: "table", fields: ["author", "read"] }));
    assert.deepEqual(table.messages.columns, ["id", "folderPath", "author", "read", "attachments"]);
    assert.deepEqual(table.messages.rows, [[ROW.id, ROW.folderPath, ROW.author, false, [{ name: "invoice.pdf" }]]]);
    const whole = plain(sandbox.buildSearchPage([ROW], { offset: 0, limit: 20 }));
    assert.ok("preview" in whole.messages[0]);
  });
});

describe("fields: what the tools accept", () => {
  const check = (name, args) => [...sandbox.validateToolArgs(name, sandbox.coerceToolArgs(name, { ...args }))];

  it("the schema refuses a name that is not a column, for both tools", () => {
    assert.match(check("searchMessages", { query: "", fields: ["subject", "body"] }).join(), /fields\[1\].*must be one of/);
    assert.match(check("getRecentMessages", { fields: ["id"] }).join(), /fields\[0\].*must be one of/);
    assert.deepEqual(check("getRecentMessages", { fields: ["subject", "date"] }), []);
    // A JSON string is accepted as for other array arguments
    assert.deepEqual(check("searchMessages", { query: "", fields: '["subject"]' }), []);
  });

  it("refuses the combinations with countOnly, groupBy and the legacy format, before searching", () => {
    for (const [extra, other] of [[{ countOnly: true }, "countOnly"], [{ groupBy: "sender" }, "groupBy"], [{ format: "legacy" }, 'format "legacy"']]) {
      assert.deepEqual(plain(sandbox.prepareSearch({ query: "", fields: ["subject"], ...extra })),
        { error: `fields cannot be combined with ${other}` });
    }
    assert.equal(sandbox.searchFieldsRefusal({ fields: ["subject"], format: "table" }), null);
    assert.equal(sandbox.searchFieldsRefusal({ countOnly: true }), null);
    assert.equal(sandbox.searchFieldsRefusal({ fields: "subject" }), "fields must be an array of column names");
    assert.match(sandbox.searchFieldsRefusal({ fields: ["body"] }), /^Unknown fields: body \(valid: date, author/);
  });
});

describe("fields: getRecentMessages passes them on", () => {
  it("to the search it runs", () => {
    const seen = [];
    const recent = { searchMessages: (args) => { seen.push(args); return {}; } };
    vm.createContext(recent);
    vm.runInContext(`${region("RECENT MESSAGES")}\nthis.getRecentMessages = getRecentMessages;`, recent);
    recent.getRecentMessages({ fields: ["subject"], daysBack: 2 });
    assert.deepEqual([...seen[0].fields], ["subject"]);
  });
});
