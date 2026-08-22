"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Mirrors the pure listFolders favorite-flag logic from api.js. The production
// module runs in Thunderbird/XPCOM and cannot be required directly, so the
// source-contract block below asserts the real file stays in sync.

// nsMsgFolderFlags.Favorite. NOT 0x00100000 -- that is ImapPublic.
const FLAG_FAVORITE = 0x80000000;

function isFavoriteFolder(flags) {
  return Boolean(flags & FLAG_FAVORITE);
}

function toColumnarTable(items, keys) {
  const columns = Array.from(keys).sort();
  return {
    columns,
    rows: items.map(item => columns.map(column => item[column])),
  };
}

// Mirrors formatFolderResults(): isFavorite is appended after the existing
// columns are computed and sorted, never folded into the sorted key set, so
// a client reading columns by position does not see them shift.
function formatFolderResults(results, folderKeys, outputFormat, favoritesOnly) {
  const selected = favoritesOnly ? results.filter(folder => folder.isFavorite) : results;
  if (outputFormat !== "table") return selected;
  const table = toColumnarTable(selected, folderKeys);
  return {
    columns: [...table.columns, "isFavorite"],
    rows: table.rows.map((row, i) => [...row, selected[i].isFavorite]),
  };
}

const FOLDER_KEYS = ["name", "path", "type", "accountId", "totalMessages", "unreadMessages", "depth"];

describe("listFolders favorite flag", () => {
  it("detects the Favorite bit on a real-world flag value", () => {
    // A folder with several other bits also set, Favorite among them.
    assert.equal(isFavoriteFolder(0x88082014), true);
  });

  it("does not treat ImapPublic (0x00100000) as favorite", () => {
    assert.equal(isFavoriteFolder(0x00100000), false);
  });

  it("returns false for ordinary folder flags", () => {
    assert.equal(isFavoriteFolder(0x00001000), false); // Inbox
    assert.equal(isFavoriteFolder(0x00000000), false);
    assert.equal(isFavoriteFolder(0x08082014), false); // same folder, favorite cleared
  });

  it("handles a flag value already read as a negative 32-bit signed integer", () => {
    // 0x88082014 read as a signed int32 (top bit set) is -2012240876, not its
    // unsigned 2282726420: some callers may hand back either representation.
    assert.equal(isFavoriteFolder(-2012240876), true);
  });
});

describe("listFolders favoritesOnly filter", () => {
  const folders = [
    { name: "INBOX", path: "imap://u@h/INBOX", isFavorite: false },
    { name: "Client A", path: "imap://u@h/Projects/Client A", isFavorite: true },
    { name: "Client B", path: "imap://u@h/Projects/Client B", isFavorite: true },
  ];

  it("returns every folder when favoritesOnly is falsy", () => {
    assert.equal(formatFolderResults(folders, FOLDER_KEYS, "objects", undefined).length, 3);
    assert.equal(formatFolderResults(folders, FOLDER_KEYS, "objects", false).length, 3);
  });

  it("returns only favorites when favoritesOnly is true", () => {
    const result = formatFolderResults(folders, FOLDER_KEYS, "objects", true);
    assert.deepStrictEqual(result.map(f => f.name), ["Client A", "Client B"]);
  });

  it("returns an empty array when nothing is favorited", () => {
    const none = folders.map(f => ({ ...f, isFavorite: false }));
    assert.deepStrictEqual(formatFolderResults(none, FOLDER_KEYS, "objects", true), []);
  });
});

describe("listFolders table format keeps the existing column order, isFavorite last", () => {
  const folders = [
    { name: "INBOX", path: "imap://u@h/INBOX", type: "inbox", accountId: "a1",
      totalMessages: 10, unreadMessages: 2, depth: 0, isFavorite: false },
    { name: "Client A", path: "imap://u@h/Projects/Client A", type: "folder", accountId: "a1",
      totalMessages: 5, unreadMessages: 0, depth: 1, isFavorite: true },
  ];

  it("keeps the pre-existing columns in their original (sorted) order", () => {
    const table = formatFolderResults(folders, FOLDER_KEYS, "table", false);
    assert.deepStrictEqual(table.columns.slice(0, -1), [
      "accountId", "depth", "name", "path", "totalMessages", "type", "unreadMessages",
    ]);
  });

  it("puts isFavorite last, not sorted alphabetically into the middle", () => {
    const table = formatFolderResults(folders, FOLDER_KEYS, "table", false);
    assert.equal(table.columns[table.columns.length - 1], "isFavorite");
    assert.equal(table.columns.length, 8);
  });

  it("appends the matching isFavorite value to each row, in row order", () => {
    const table = formatFolderResults(folders, FOLDER_KEYS, "table", false);
    assert.equal(table.rows[0][table.rows[0].length - 1], false);
    assert.equal(table.rows[1][table.rows[1].length - 1], true);
  });

  it("applies favoritesOnly before building the table, so rows and the filter agree", () => {
    const table = formatFolderResults(folders, FOLDER_KEYS, "table", true);
    assert.equal(table.rows.length, 1);
    assert.equal(table.rows[0][table.rows[0].length - 1], true);
  });
});

// The mirrored logic above proves the algorithm; these assertions prove the
// shipped api.js actually implements it -- precisely enough that removing any
// one piece (the isFavorite field, the favoritesOnly argument, or the filter
// itself) breaks a specific assertion here, not just a generic keyword search.
describe("api.js source contract", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "extension", "mcp_server", "api.js"),
    "utf8"
  );

  it("pushes isFavorite, computed from the real folder flags, into each result row", () => {
    assert.match(
      source,
      /isFavorite:\s*isFavoriteFolder\(folder\.flags\)/,
      "walkFolder does not push isFavorite: isFavoriteFolder(folder.flags)"
    );
  });

  it("uses the Favorite flag bit, not ImapPublic", () => {
    assert.match(source, /flags\s*&\s*0x80000000/, "api.js does not check the Favorite flag bit");
  });

  it("threads favoritesOnly from the tool call into listFolders", () => {
    assert.match(
      source,
      /return listFolders\(args\.accountId,\s*args\.folderPath,\s*args\.format,\s*args\.favoritesOnly,\s*args\.savedSearches\)/,
      "the listFolders tool handler does not pass args.favoritesOnly through"
    );
  });

  it("filters results by isFavorite when favoritesOnly is set", () => {
    assert.match(
      source,
      /favoritesOnly\s*\?\s*results\.filter\(folder\s*=>\s*folder\.isFavorite\)\s*:\s*results/,
      "formatFolderResults does not filter by isFavorite when favoritesOnly is set"
    );
  });

  it("exposes a favoritesOnly parameter on the listFolders tool schema", () => {
    assert.match(source, /favoritesOnly:\s*\{\s*type:\s*"boolean"/, "api.js does not declare favoritesOnly in the tool schema");
  });

  it("appends isFavorite after toColumnarTable, not folded into the sorted key set", () => {
    assert.match(
      source,
      /columns:\s*\[\.\.\.table\.columns,\s*"isFavorite"\]/,
      "listFolders does not append isFavorite as the last table column"
    );
    // folderKeys itself must NOT list isFavorite: mixing it in would sort it
    // in alphabetically and shift the pre-existing columns' positions.
    const keyLine = source.match(/const folderKeys = \[[^\]]*\]/);
    assert.ok(keyLine, "folderKeys declaration not found in api.js");
    assert.doesNotMatch(keyLine[0], /"isFavorite"/, "folderKeys must not include isFavorite");
  });
});
