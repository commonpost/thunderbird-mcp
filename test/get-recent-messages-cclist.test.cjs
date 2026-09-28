"use strict";

// getRecentMessages omitted ccList from its result rows; searchMessages includes it
// (upstream TKasperczyk/thunderbird-mcp#174 by Gunther Schulz). getRecentMessages now
// runs through searchMessages, so both share one row format.

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
    assert.ok(start >= 0, "getRecentMessages not found in api.js");
    const body = apiSource.slice(start, apiSource.indexOf("\n            }", start));
    assert.match(body, /return searchMessages\(/, "getRecentMessages no longer delegates to searchMessages");
    assert.match(apiSource, /const SEARCH_ROW_COLUMNS = \[[^\]]*"ccList"/, "search rows do not carry ccList");
    assert.match(apiSource, /ccList: [^,\n]*msgHdr\.ccList/, "search rows do not fill ccList");
  });
});
