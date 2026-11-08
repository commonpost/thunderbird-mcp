// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";

// Runs the real listAddressBooks against fake address books: empty books are listed, and default marks the book
// createContact takes without addressBookId (the first writable one).

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

function load(getBooks) {
  // The account restriction of address books is covered by account-restriction.test.cjs.
  const sandbox = { getAccessibleAddressBooks: getBooks };
  vm.createContext(sandbox);
  vm.runInContext(`${region("CONTACT FIELD HELPERS")}
${region("MESSAGE SEARCH HELPERS")}
${region("SEARCH CONTACTS")}
this.listAddressBooks = listAddressBooks;`, sandbox);
  return () => JSON.parse(JSON.stringify(sandbox.listAddressBooks()));
}

const book = (dirName, URI, readOnly = false) => ({ dirName, URI, readOnly, childCards: [] });

describe("listAddressBooks", () => {
  it("lists every accessible book, empty ones included, with the id createContact takes", () => {
    const list = load(() => [book("Personal Address Book", "jsaddrbook://abook.sqlite"),
      book("Collected Addresses", "jsaddrbook://history.sqlite")]);
    assert.deepEqual(list(), [
      { addressBookId: "jsaddrbook://abook.sqlite", name: "Personal Address Book", readOnly: false, default: true },
      { addressBookId: "jsaddrbook://history.sqlite", name: "Collected Addresses", readOnly: false, default: false },
    ]);
  });

  it("marks as default the first writable book, after read-only ones", () => {
    const list = load(() => [book("Directory", "moz-abldapdirectory://ldap", true),
      book("Work", "jsaddrbook://work.sqlite"), book("Home", "jsaddrbook://home.sqlite")]);
    assert.deepEqual(list().map((b) => [b.name, b.readOnly, b.default]),
      [["Directory", true, false], ["Work", false, true], ["Home", false, false]]);
  });

  it("marks no default when every book is read-only, and lists nothing when no book is accessible", () => {
    assert.deepEqual(load(() => [book("Directory", "moz-abldapdirectory://ldap", true)])().map((b) => b.default), [false]);
    assert.deepEqual(load(() => [])(), []);
  });

  it("returns an error instead of throwing", () => {
    assert.deepEqual(load(() => { throw new Error("no address book service"); })(),
      { error: "Error: no address book service" });
  });

  it("is dispatched and declared as a contacts read tool", () => {
    assert.match(apiSource, /case "listAddressBooks":\n\s+return listAddressBooks\(\);/);
    assert.match(apiSource, /name: "listAddressBooks",\n\s+group: "contacts", crud: "read",/);
  });
});
