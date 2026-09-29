"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");
const start = source.indexOf("// BEGIN FOLDER NAME HELPERS");
const end = source.indexOf("// END FOLDER NAME HELPERS", start);
assert.ok(start >= 0 && end > start, "FOLDER NAME HELPERS markers missing");
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(`${source.slice(start, end)}\nthis.folderDisplayName = folderDisplayName;`, sandbox);
const { folderDisplayName } = sandbox;

describe("folderDisplayName", () => {
  it("reads localizedName (Thunderbird 141+), else prettyName (140 ESR)", () => {
    assert.equal(folderDisplayName({ localizedName: "Posteingang", name: "Inbox" }), "Posteingang");
    assert.equal(folderDisplayName({ prettyName: "Papierkorb", name: "Trash" }), "Papierkorb");
    assert.equal(folderDisplayName({ name: "Inbox" }), undefined);
    assert.equal(folderDisplayName(null), undefined);
  });
});
