// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";

// Runs the real searchContacts (and formatContact) against a fake address book.

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

function card({ displayName = "", email = "", firstName = "", lastName = "", organization = "" }) {
  const props = { Company: organization };
  return {
    UID: `uid-${displayName || email}`,
    displayName,
    primaryEmail: email,
    firstName,
    lastName,
    isMailList: false,
    supportsVCard: false,
    getProperty: (name, fallback) => props[name] ?? fallback,
  };
}

function loadSearchContacts(cards) {
  const books = [{ dirName: "Personal", URI: "jsaddrbook://abook.sqlite", childCards: cards.map(card) }];
  const sandbox = {
    MailServices: { ab: { directories: books } },
    // The account restriction of address books is covered by its own tests.
    getAccessibleAddressBooks: () => books,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${region("CONTACT FIELD HELPERS")}
${region("MESSAGE SEARCH HELPERS")}
${region("SEARCH CONTACTS")}
this.searchContacts = searchContacts;`, sandbox);
  return sandbox.searchContacts;
}

const KLOCOK = { displayName: "Klocok, Viliam", firstName: "Viliam", lastName: "Klocok", email: "viliam.klocok@example.test" };
const SMITH = { displayName: "Smith, John", firstName: "John", lastName: "Smith" };
const ROE = { displayName: "Jane Roe", email: "jane@acme.example", organization: "Acme Corp" };
const search = loadSearchContacts([KLOCOK, { displayName: "Guedes, Robson" }, SMITH, ROE]);
const names = query => JSON.parse(JSON.stringify(search(query))).map(c => c.displayName);

describe("searchContacts tokenization", () => {
  it("matches CardDAV 'Lastname, Firstname' display names in either order", () => {
    assert.deepEqual(names("Klocok Viliam"), ["Klocok, Viliam"]);
    assert.deepEqual(names("Viliam Klocok"), ["Klocok, Viliam"]);
    assert.deepEqual(names("Robson Guedes"), ["Guedes, Robson"]);
    assert.deepEqual(names("Guedes Robson"), ["Guedes, Robson"]);
  });

  it("preserves single-token substring matching", () => {
    assert.deepEqual(names("Viliam"), ["Klocok, Viliam"]);
    assert.deepEqual(names("viliam.klocok@example.test"), ["Klocok, Viliam"]);
  });

  it("splits comma-included queries into AND tokens", () => {
    assert.deepEqual(names("Klocok, Viliam"), ["Klocok, Viliam"]);
    assert.deepEqual(names("John Doe"), []);
  });

  it("handles empty and failed queries", () => {
    assert.equal(names("").length, 4);
    for (const query of ["   ", ",,,", " , "]) assert.deepEqual(names(query), [], JSON.stringify(query));
  });

  it("matches organization and email domain", () => {
    assert.deepEqual(names("acme corp"), ["Jane Roe"]);
    assert.deepEqual(names("@acme.example"), ["Jane Roe"]);
    assert.deepEqual(names("globex"), []);
  });

  it("remains case-insensitive and omits empty fields", () => {
    assert.deepEqual(names("KLOCOK"), ["Klocok, Viliam"]);
    const [smith] = JSON.parse(JSON.stringify(search("smith")));
    assert.equal("email" in smith, false);
    assert.equal("phones" in smith, false);
    assert.equal(smith.addressBook, "Personal");
  });

  it("stops at maxResults and says so", () => {
    const limited = JSON.parse(JSON.stringify(search("", 2)));
    assert.equal(limited.contacts.length, 2);
    assert.equal(limited.hasMore, true);
    const table = JSON.parse(JSON.stringify(search("roe", undefined, "table")));
    assert.ok(table.contacts.columns.includes("displayName"));
    assert.equal(table.contacts.rows.length, 1);
  });
});

describe("searchContacts: hasMore only when a match was left out", () => {
  const plain = (r) => JSON.parse(JSON.stringify(r));
  it("exactly as many matches as maxResults: the whole list, not marked truncated", () => {
    const r = plain(search("Smith", 1));
    assert.ok(Array.isArray(r), JSON.stringify(r));
    assert.deepEqual(r.map((c) => c.displayName), ["Smith, John"]);
  });
  it("more matches than maxResults: the first ones, with hasMore", () => {
    const r = plain(search("", 2));
    assert.equal(r.hasMore, true);
    assert.equal(r.contacts.length, 2);
  });
  it("same rule for the table format", () => {
    assert.equal(plain(search("Smith", 1, "table")).hasMore, undefined);
    assert.equal(plain(search("", 2, "table")).hasMore, true);
  });
});

describe("searchContacts: pages and one address book (issue #212)", () => {
  const plain = (r) => JSON.parse(JSON.stringify(r));
  const bookA = { dirName: "A", URI: "jsaddrbook://a.sqlite", dirPrefId: "ldap_2.servers.a", UID: "uid-a", childCards: [KLOCOK, SMITH].map(card) };
  const bookB = { dirName: "B", URI: "jsaddrbook://b.sqlite", dirPrefId: "ldap_2.servers.b", UID: "uid-b", childCards: [ROE].map(card) };
  const sandbox = { MailServices: { ab: { directories: [bookA, bookB] } }, getAccessibleAddressBooks: () => [bookA, bookB] };
  vm.createContext(sandbox);
  vm.runInContext(`${region("CONTACT FIELD HELPERS")}
${region("MESSAGE SEARCH HELPERS")}
${region("SEARCH CONTACTS")}
this.searchContacts = searchContacts;`, sandbox);
  const two = sandbox.searchContacts;

  it("a full page gives nextOffset, and the next page reaches the other book", () => {
    const first = plain(two("", 2));
    assert.equal(first.hasMore, true);
    assert.equal(first.nextOffset, 2);
    assert.match(first.message, /^Results limited to 2\. Pass offset: 2/);
    assert.deepEqual(first.contacts.map((c) => c.addressBook), ["A", "A"]);
    const next = plain(two("", 2, undefined, first.nextOffset));
    assert.ok(Array.isArray(next), JSON.stringify(next));
    assert.deepEqual(next.map((c) => c.displayName), ["Jane Roe"]);
  });

  it("pages never repeat or skip a contact", () => {
    const seen = [];
    let offset = 0;
    for (let i = 0; i < 5; i++) {
      const r = plain(two("", 1, undefined, offset));
      const rows = Array.isArray(r) ? r : r.contacts;
      seen.push(...rows.map((c) => c.displayName));
      if (Array.isArray(r)) break;
      offset = r.nextOffset;
    }
    assert.deepEqual(seen, ["Klocok, Viliam", "Smith, John", "Jane Roe"]);
  });

  it("table format carries nextOffset too", () => {
    const r = plain(two("", 1, "table"));
    assert.equal(r.hasMore, true);
    assert.equal(r.nextOffset, 1);
  });

  it("an offset past the end returns an empty list", () => {
    assert.deepEqual(plain(two("", 10, undefined, 99)), []);
  });

  it("refuses a bad offset", () => {
    for (const bad of [-1, 1.5, "2", true]) {
      assert.equal(plain(two("", 10, undefined, bad)).error, "offset must be a non-negative integer", JSON.stringify(bad));
    }
  });

  it("addressBookId limits the search to that book, by URI, UID or dirPrefId", () => {
    for (const id of ["jsaddrbook://b.sqlite", "uid-b", "ldap_2.servers.b"]) {
      assert.deepEqual(plain(two("", 10, undefined, undefined, id)).map((c) => c.displayName), ["Jane Roe"], id);
    }
    assert.deepEqual(plain(two("roe", 10, undefined, undefined, "jsaddrbook://a.sqlite")), []);
  });

  it("refuses an unknown address book", () => {
    assert.equal(plain(two("", 10, undefined, undefined, "jsaddrbook://nope.sqlite")).error, "Address book not found: jsaddrbook://nope.sqlite");
  });

  it("an empty addressBookId searches every book", () => {
    assert.equal(plain(two("", 10, undefined, undefined, "")).length, 3);
  });
});
