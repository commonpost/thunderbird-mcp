// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";

// Under an account restriction, a calendar or an address book is allowed when it names an allowed account. These
// tests run describeAccountsForOwnership, which lists each account with its addresses and identities.

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
  return apiSource.slice(start, apiSource.indexOf(close, start) + close.length);
}

const plain = (value) => JSON.parse(JSON.stringify(value));

function load(accounts, allowedKeys) {
  const warnings = [];
  const sandbox = {
    console: { warn: (...args) => warnings.push(args) },
    MailServices: { accounts: { accounts } },
    isAccountAllowed: (key) => allowedKeys.includes(key),
  };
  vm.createContext(sandbox);
  vm.runInContext(`${functionSource("describeAccountsForOwnership")}\nthis.describe = describeAccountsForOwnership;`, sandbox);
  return { describe: sandbox.describe, warnings };
}

describe("describeAccountsForOwnership", () => {
  it("lists each account with its identity keys, identity addresses and server user names", () => {
    const { describe: run, warnings } = load([
      {
        key: "account1",
        identities: [{ key: "id1", email: "me@work.example" }, { key: "id2", email: "alias@work.example" }],
        incomingServer: { username: "me@work.example", realUsername: "work.user" },
      },
      { key: "account2", identities: [{ key: "id3", email: "me@home.example" }], incomingServer: { username: "home" } },
    ], ["account1"]);
    assert.deepEqual(plain(run()), [
      { key: "account1", allowed: true, emails: ["me@work.example", "alias@work.example", "me@work.example", "work.user"], identityKeys: ["id1", "id2"] },
      { key: "account2", allowed: false, emails: ["me@home.example", "home"], identityKeys: ["id3"] },
    ]);
    assert.deepEqual(warnings, []);
  });

  it("leaves out an identity without an address, a server without user names and an account without a server", () => {
    const { describe: run } = load([
      { key: "a1", identities: [{ key: "id1", email: "" }, { key: "id2" }], incomingServer: { username: "", realUsername: "" } },
      { key: "a2", identities: [], incomingServer: null },
      { key: "a3", identities: [], incomingServer: undefined },
    ], []);
    assert.deepEqual(plain(run()), [
      { key: "a1", allowed: false, emails: [], identityKeys: ["id1", "id2"] },
      { key: "a2", allowed: false, emails: [], identityKeys: [] },
      { key: "a3", allowed: false, emails: [], identityKeys: [] },
    ]);
  });

  it("still lists an account whose identities cannot be read, with what was read before the failure, and warns", () => {
    const broken = {
      key: "broken",
      get identities() { throw new Error("NS_ERROR_FAILURE"); },
      incomingServer: { username: "never read" },
    };
    const halfway = {
      key: "halfway",
      identities: [{ key: "id1", email: "me@work.example" }],
      get incomingServer() { throw new Error("server gone"); },
    };
    const { describe: run, warnings } = load([broken, halfway], ["broken"]);
    assert.deepEqual(plain(run()), [
      { key: "broken", allowed: true, emails: [], identityKeys: [] },
      { key: "halfway", allowed: false, emails: ["me@work.example"], identityKeys: ["id1"] },
    ]);
    assert.equal(warnings.length, 2);
    assert.match(String(warnings[0][0]), /could not read account identities for ownership/);
  });

  it("lists nothing when there are no accounts", () => {
    assert.deepEqual(plain(load([], []).describe()), []);
  });
});
