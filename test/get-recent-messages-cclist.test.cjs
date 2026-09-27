"use strict";

// getRecentMessages omitted ccList from its result rows; searchMessages includes it.
// One line restores field parity (upstream TKasperczyk/thunderbird-mcp#174 by Gunther Schulz).

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const apiSource = fs.readFileSync(
  path.resolve(__dirname, "../extension/mcp_server/api.js"),
  "utf8"
);

describe("getRecentMessages result rows", () => {
  it("carries ccList, like searchMessages does", () => {
    const start = apiSource.indexOf("function getRecentMessages(");
    const end = apiSource.indexOf("\n            }", apiSource.indexOf("function ", start + 1));
    assert.ok(start >= 0, "getRecentMessages not found in api.js");
    const body = apiSource.slice(start, end > start ? end : start + 4000);
    assert.match(body, /ccList:\s*msgHdr\.ccList/, "getRecentMessages does not carry ccList");
  });
});
