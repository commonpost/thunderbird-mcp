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
  const sandbox = {
    MailServices: { ab: { directories: [{ dirName: "Personal", URI: "jsaddrbook://abook.sqlite", childCards: cards.map(card) }] } },
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
