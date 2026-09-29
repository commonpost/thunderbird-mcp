"use strict";

// Account restrictions: the server and the options page read the preference
// the same way, an unreadable value refuses everything, and calendars and
// address books follow the accounts they belong to.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const apiSource = fs.readFileSync(path.join(root, "extension/mcp_server/api.js"), "utf8");
const optionsJs = fs.readFileSync(path.join(root, "extension/options.js"), "utf8");

const start = apiSource.indexOf("// BEGIN ACCOUNT RESTRICTION HELPERS");
const end = apiSource.indexOf("// END ACCOUNT RESTRICTION HELPERS");
assert.ok(start >= 0 && end > start, "account restriction helpers block missing");
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(`${apiSource.slice(start, end)}
this.api = { parseAllowedAccountsPref, isCollectionAllowed, INVALID_ACCOUNT_RESTRICTION };`, sandbox);
const { parseAllowedAccountsPref, isCollectionAllowed } = sandbox.api;

describe("parseAllowedAccountsPref", () => {
  it("unset, empty and empty-list values allow every account", () => {
    for (const raw of [undefined, null, "", "[]"]) {
      assert.deepEqual(JSON.parse(JSON.stringify(parseAllowedAccountsPref(raw))), { state: "all", ids: [] }, String(raw));
    }
  });

  it("a list of account ids restricts to those accounts", () => {
    assert.deepEqual(JSON.parse(JSON.stringify(parseAllowedAccountsPref('["account1","account3"]'))),
      { state: "restricted", ids: ["account1", "account3"] });
  });

  it("anything else is invalid", () => {
    for (const raw of ["{", "null", "true", "42", '"account1"', '{"a":1}', "[1]", '[""]', '["a",null]', "[[]]", "undefined"]) {
      assert.equal(parseAllowedAccountsPref(raw).state, "invalid", raw);
    }
  });
});

describe("isCollectionAllowed", () => {
  const accounts = [
    { key: "account1", allowed: true, emails: ["me@work.example"], identityKeys: ["id1"] },
    { key: "account2", allowed: false, emails: ["me@home.example", "Home.User"], identityKeys: ["id2"] },
  ];
  const local = { emails: [], remote: false };

  it("allows everything when there is no restriction", () => {
    assert.equal(isCollectionAllowed("all", { emails: ["me@home.example"], remote: true }, accounts), true);
  });

  it("refuses everything when the restriction is invalid", () => {
    assert.equal(isCollectionAllowed("invalid", local, accounts), false);
    assert.equal(isCollectionAllowed("invalid", { emails: ["me@work.example"], remote: true }, accounts), false);
  });

  it("refuses a collection that names a restricted account, by address or user name, in any letter case", () => {
    assert.equal(isCollectionAllowed("restricted", { emails: ["Me@Home.Example"], remote: true }, accounts), false);
    assert.equal(isCollectionAllowed("restricted", { emails: ["home.user"], remote: true }, accounts), false);
  });

  it("refuses a calendar tied to a restricted account by identity or account key", () => {
    assert.equal(isCollectionAllowed("restricted", { identityKeys: ["id2"], remote: false }, accounts), false);
    assert.equal(isCollectionAllowed("restricted", { accountKeys: ["account2"], remote: false }, accounts), false);
  });

  it("allows a collection that names an allowed account", () => {
    assert.equal(isCollectionAllowed("restricted", { emails: ["me@work.example"], remote: true }, accounts), true);
    assert.equal(isCollectionAllowed("restricted", { identityKeys: ["id1"], remote: true }, accounts), true);
  });

  it("refuses a collection that names both an allowed and a restricted account", () => {
    assert.equal(isCollectionAllowed("restricted", { emails: ["me@work.example", "me@home.example"], remote: true }, accounts), false);
  });

  it("allows a local collection that names no account and refuses a remote one", () => {
    assert.equal(isCollectionAllowed("restricted", local, accounts), true);
    assert.equal(isCollectionAllowed("restricted", { emails: ["other@elsewhere.example"], remote: true }, accounts), false);
    assert.equal(isCollectionAllowed("restricted", { emails: [""], remote: true }, accounts), false);
  });

  it("ignores empty hints", () => {
    assert.equal(isCollectionAllowed("restricted", { emails: ["", null], identityKeys: [""], accountKeys: [""], remote: false }, accounts), true);
  });
});

describe("wiring", () => {
  it("the server reads the preference through the shared parser and fails closed", () => {
    const i = apiSource.indexOf("function getAllowedAccountIds()");
    const fn = apiSource.slice(i, i + 900);
    assert.match(fn, /parseAllowedAccountsPref\(raw\)/);
    assert.match(fn, /catch \(e\) \{[\s\S]*return \[INVALID_ACCOUNT_RESTRICTION\]/);
  });

  it("the options page configuration uses the same parser and reports an invalid value as such", () => {
    const i = apiSource.indexOf("getAccountAccessConfig: async function()");
    const fn = apiSource.slice(i, i + 1800);
    assert.match(fn, /parseAllowedAccountsPref\(Services\.prefs\.getStringPref\(PREF_ALLOWED_ACCOUNTS, ""\)\)/);
    assert.match(fn, /state: "invalid"/);
    assert.match(fn, /allowed: state === "all" \|\| \(state === "restricted"/);
  });

  it("no tool reads calendars or address books except through the filtered helpers", () => {
    assert.equal(apiSource.match(/cal\.manager\.getCalendars\(\)/g).length, 1);
    assert.equal(apiSource.match(/MailServices\.ab\.directories/g).length, 1);
    assert.ok(apiSource.indexOf("function getAccessibleCalendars()") < apiSource.indexOf("cal.manager.getCalendars()"));
  });

  it("the options page does not turn an empty selection or an unreadable value into 'allow all'", () => {
    assert.match(optionsJs, /accountRestrictionInvalid = data\.mode === "invalid";/);
    assert.match(optionsJs, /if \(checked\.length === 0\) \{[\s\S]*Select at least one account[\s\S]*return;/);
    assert.match(optionsJs, /if \(allChecked && accountRestrictionInvalid && !openAllConfirmed\)/);
    assert.ok(optionsJs.indexOf("checked.length === 0") < optionsJs.indexOf("const allowedIds = allChecked ? [] : checked;"));
  });

  it("Collected Addresses (dirType 101) is not defaulted to local-allowed under a restriction", () => {
    // pab and history share dirType 101 (mailnews.js:
    // ldap_2.servers.pab.dirType=101, ldap_2.servers.history.dirType=101;
    // dirType 2 does not exist for either) -- the personal address book (pab)
    // stays reachable under a restriction, Collected Addresses (history)
    // does not, a CardDAV book (dirType 102 here) follows the account it
    // names like any other remote collection. Behavior, not source pattern:
    // dirType alone cannot tell pab and history apart, so a check for the
    // old (wrong) `dirType !== 2` text would not catch a bug here.
    function functionSource(name) {
      const marker = `\n            function ${name}(`;
      const fnStart = apiSource.indexOf(marker);
      assert.ok(fnStart >= 0, `${name} not found in api.js`);
      const close = "\n            }\n";
      const fnEnd = apiSource.indexOf(close, fnStart);
      assert.ok(fnEnd > fnStart, `end of ${name} not found in api.js`);
      return apiSource.slice(fnStart, fnEnd + close.length);
    }

    const abSandbox = {
      isCollectionAllowed,
      accountRestrictionState: () => "restricted",
      describeAccountsForOwnership: () => [
        { key: "account1", allowed: true, emails: ["me@work.example"], identityKeys: [] },
      ],
      readTextProperty: (fn) => { try { return fn() || ""; } catch { return ""; } },
      MailServices: { ab: { directories: [] } },
    };
    vm.createContext(abSandbox);
    vm.runInContext(`${functionSource("isCollectedAddressesBook")}
${functionSource("getAccessibleAddressBooks")}
this.getAccessibleAddressBooks = getAccessibleAddressBooks;`, abSandbox);

    const pab = { name: "pab", dirType: 101, dirPrefId: "ldap_2.servers.pab", URI: "jsaddrbook://abook.sqlite", getStringValue: () => "" };
    const history = { name: "history", dirType: 101, dirPrefId: "ldap_2.servers.history", URI: "jsaddrbook://history.sqlite", getStringValue: () => "" };
    const cardDavAllowed = { name: "cardDavAllowed", dirType: 102, dirPrefId: "ldap_2.servers.carddav1", URI: "jsaddrbook://carddav1.sqlite", getStringValue: (p) => (p === "carddav.username" ? "me@work.example" : "") };
    const cardDavOther = { name: "cardDavOther", dirType: 102, dirPrefId: "ldap_2.servers.carddav2", URI: "jsaddrbook://carddav2.sqlite", getStringValue: (p) => (p === "carddav.username" ? "other@elsewhere.example" : "") };

    abSandbox.MailServices.ab.directories = [pab, history, cardDavAllowed, cardDavOther];
    // .join, not deepEqual: the array comes back from a different vm realm,
    // whose Array is not === the host's, which deepStrictEqual is picky about.
    const names = abSandbox.getAccessibleAddressBooks().map((b) => b.name).sort().join(",");
    assert.equal(names, "cardDavAllowed,pab");
  });
});
