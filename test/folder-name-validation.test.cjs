"use strict";

// Folder names go through the same free-text validation as a filter name:
// a control character, backslash or lone surrogate is refused before
// Thunderbird ever sees it, whether creating or renaming a folder.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const apiSource = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");

function functionSource(name, indent = "            ") {
  const start = apiSource.indexOf(`\n${indent}function ${name}(`);
  assert.ok(start >= 0, `${name} not found in api.js`);
  const close = `\n${indent}}\n`;
  const end = apiSource.indexOf(close, start);
  assert.ok(end > start, `end of ${name} not found in api.js`);
  return apiSource.slice(start, end + close.length);
}

// Single-line `const NAME = ...;` declarations that assertFilterText/
// createFolder/renameFolder close over, wherever in the file they live.
function constSource(name) {
  const marker = `const ${name} =`;
  const start = apiSource.indexOf(marker);
  assert.ok(start >= 0, `${name} not found in api.js`);
  const end = apiSource.indexOf(";", start);
  assert.ok(end > start, `end of ${name} not found in api.js`);
  return apiSource.slice(start, end + 1);
}

function loadFolderFunctions() {
  const sandbox = {
    getAccessibleFolder: (uri) => (uri === "parent" || uri === "existing"
      ? { folder: { createSubfolder() {}, rename() {}, hasSubFolders: false, subFolders: [] } }
      : { error: `Folder not found: ${uri}` }),
  };
  vm.createContext(sandbox);
  vm.runInContext([
    constSource("FILTER_TEXT_FORBIDDEN"),
    constSource("FILTER_TEXT_NOTE"),
    constSource("FILTER_NAME_MAX_LENGTH"),
    constSource("FOLDER_TEXT_NOTE"),
    functionSource("assertFilterText", ""),
    functionSource("createFolder"),
    functionSource("renameFolder"),
    "this.createFolder = createFolder;",
    "this.renameFolder = renameFolder;",
  ].join("\n"), sandbox);
  return sandbox;
}

const api = loadFolderFunctions();

describe("createFolder/renameFolder: free-text validation", () => {
  const bad = ["a\nb", "a\rb", "a\u0000b", "a\\b", "a\u001bb"];
  const good = ["Invoices 2026", "Clients (VIP)", "Été"];

  it("refuses control characters, backslash and other unsafe text in a new folder's name", () => {
    for (const name of bad) {
      const result = api.createFolder("parent", name);
      assert.ok(result.error, JSON.stringify(name));
      assert.match(result.error, /control|line-separator|backslash|surrogate/i, name);
    }
  });

  it("refuses the same characters when renaming a folder", () => {
    for (const name of bad) {
      const result = api.renameFolder("existing", name);
      assert.ok(result.error, JSON.stringify(name));
    }
  });

  it("accepts ordinary names, including parentheses and non-ASCII text", () => {
    for (const name of good) {
      assert.equal(api.createFolder("parent", name).success, true, name);
      assert.equal(api.renameFolder("existing", name).success, true, name);
    }
  });

  it("gives a folder-appropriate reason, not the filter-file one", () => {
    const result = api.createFolder("parent", "a\nb");
    assert.match(result.error, /unambiguous folder name/);
    assert.doesNotMatch(result.error, /msgFilterRules\.dat/);
  });
});
