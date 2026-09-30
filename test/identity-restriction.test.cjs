"use strict";
// Which identity a reply or forward may use under an account restriction. Runs the real functions of api.js against
// fake accounts; test/bench/identity.test.cjs checks the same on a real Thunderbird.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const API = fs.readFileSync(path.join(__dirname, "..", "extension", "mcp_server", "api.js"), "utf8");
const start = API.indexOf("function findIdentityIn(");
const end = API.indexOf("// Sender of a reply / forward:");
assert.ok(start > 0 && end > start, "identity helpers not found");
const region = API.slice(start, end);

// accounts: [{ key, identities: [identity] }], allowed: account keys ([] = no restriction).
// MailUtils: what Thunderbird's own picks return.
function load(accounts, allowed, mailUtils = {}) {
  const isAccountAllowed = key => allowed.length === 0 || allowed.includes(key);
  const getAccessibleAccounts = () => accounts.filter(account => isAccountAllowed(account.key));
  const sandbox = {
    MailServices: { accounts: { accounts, allIdentities: accounts.flatMap(account => account.identities) }, headerParser: {} },
    Services: { prefs: { getStringPref: () => "" } },
    ChromeUtils: { importESModule: () => ({ MailUtils: mailUtils }) },
    isAccountAllowed,
    getAccessibleAccounts,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${region}
this.fns = { findIdentity, accountKeyForIdentity, isIdentityAllowed, identityForMessage };`, sandbox);
  return sandbox.fns;
}

const identity = (key, email) => ({ key, email });
const shared = identity("id-shared", "shared@example.test");
const own = identity("id-own", "own@example.test");
const other = identity("id-other", "other@example.test");
const msgHdr = { folder: { server: { type: "pop3" }, customIdentity: null }, recipients: "shared@example.test", ccList: "" };

describe("identity shared between accounts", () => {
  const accounts = [
    { key: "restricted", identities: [shared, own] },
    { key: "open", identities: [shared, other] },
  ];

  it("belongs to an accessible account whatever the account order", () => {
    for (const order of [accounts, [...accounts].reverse()]) {
      const fns = load(order, ["open"]);
      assert.equal(fns.isIdentityAllowed(shared), true);
      assert.equal(fns.accountKeyForIdentity(shared), "open");
    }
  });

  it("agrees with findIdentity", () => {
    for (const order of [accounts, [...accounts].reverse()]) {
      const fns = load(order, ["open"]);
      assert.equal(fns.findIdentity("shared@example.test"), shared);
      assert.equal(fns.isIdentityAllowed(fns.findIdentity("shared@example.test")), true);
      assert.equal(fns.findIdentity("own@example.test"), null);
      assert.equal(fns.isIdentityAllowed(own), false);
    }
  });

  it("is refused when every account that holds it is restricted", () => {
    const fns = load(accounts, ["other-account"]);
    assert.equal(fns.isIdentityAllowed(shared), false);
    assert.equal(fns.isIdentityAllowed(other), false);
    assert.equal(fns.findIdentity("shared@example.test"), null);
  });

  it("takes the first account when nothing is restricted", () => {
    const fns = load(accounts, []);
    assert.equal(fns.accountKeyForIdentity(shared), "restricted");
    assert.equal(fns.isIdentityAllowed(shared), true);
  });

  it("knows nothing about an identity that no account holds", () => {
    const fns = load(accounts, ["open"]);
    assert.equal(fns.accountKeyForIdentity(identity("id-none", "none@example.test")), "");
    assert.equal(fns.isIdentityAllowed(identity("id-none", "none@example.test")), false);
    assert.equal(fns.isIdentityAllowed(null), false);
  });
});

describe("identityForMessage under a restriction", () => {
  const accounts = [
    { key: "restricted", identities: [own] },
    { key: "open", identities: [other] },
  ];

  it("keeps the identity Thunderbird picks when an accessible account holds it", () => {
    const fns = load([{ key: "restricted", identities: [shared] }, { key: "open", identities: [shared] }], ["open"],
      { getIdentityForHeader: () => [shared, null], getBestIdentity: () => { throw new Error("no fallback needed"); } });
    assert.deepEqual({ ...fns.identityForMessage(msgHdr, 0, null) }, { identity: shared, from: "" });
  });

  it("falls back to the accessible identities when the picked one is restricted", () => {
    let offered = null;
    const fns = load(accounts, ["open"], {
      getIdentityForHeader: () => [own, null],
      getBestIdentity: (list) => { offered = list; return [list[0], null]; },
    });
    const result = fns.identityForMessage(msgHdr, 0, null);
    assert.equal(result.identity, other);
    assert.deepEqual(offered, [other]);
  });

  it("returns an error when every account is restricted", () => {
    const fns = load(accounts, ["account-without-identity"], {
      getIdentityForHeader: () => [own, null],
      getBestIdentity: list => [list[0] || null, null],
    });
    assert.deepEqual({ ...fns.identityForMessage(msgHdr, 0, null) }, { error: "No accessible identity found -- all accounts are restricted" });
  });
});
