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
vm.runInContext(`${source.slice(start, end)}\nthis.folderDisplayName = folderDisplayName;
this.folderUriWithoutTrailingSlash = folderUriWithoutTrailingSlash;`, sandbox);
const { folderDisplayName, folderUriWithoutTrailingSlash } = sandbox;

describe("folderDisplayName", () => {
  it("reads localizedName (Thunderbird 141+), else prettyName (140 ESR)", () => {
    assert.equal(folderDisplayName({ localizedName: "Posteingang", name: "Inbox" }), "Posteingang");
    assert.equal(folderDisplayName({ prettyName: "Papierkorb", name: "Trash" }), "Papierkorb");
    assert.equal(folderDisplayName({ name: "Inbox" }), undefined);
    assert.equal(folderDisplayName(null), undefined);
  });
});

describe("folderUriWithoutTrailingSlash", () => {
  it("removes the trailing slashes of a folder URI", () => {
    assert.equal(folderUriWithoutTrailingSlash("mailbox://nobody@Local%20Folders/"), "mailbox://nobody@Local%20Folders");
    assert.equal(folderUriWithoutTrailingSlash("imap://user@example.org/INBOX/Sub//"), "imap://user@example.org/INBOX/Sub");
  });

  it("returns null when there is nothing to remove", () => {
    assert.equal(folderUriWithoutTrailingSlash("mailbox://nobody@Local%20Folders"), null);
    assert.equal(folderUriWithoutTrailingSlash("mailbox://nobody@Local%20Folders/Inbox"), null);
  });

  it("returns null rather than a bare scheme or a non-URI", () => {
    assert.equal(folderUriWithoutTrailingSlash("mailbox://"), null);
    assert.equal(folderUriWithoutTrailingSlash("mailbox:///"), null);
    assert.equal(folderUriWithoutTrailingSlash("///"), null);
    assert.equal(folderUriWithoutTrailingSlash("Inbox/"), null);
    assert.equal(folderUriWithoutTrailingSlash(undefined), null);
    assert.equal(folderUriWithoutTrailingSlash(42), null);
  });

  it("stays fast on a long run of slashes", () => {
    const t = Date.now();
    assert.equal(folderUriWithoutTrailingSlash("imap://u@h/" + "/".repeat(200000) + "x"), null);
    assert.equal(folderUriWithoutTrailingSlash("imap://u@h/a" + "/".repeat(200000)), "imap://u@h/a");
    assert.ok(Date.now() - t < 500);
  });

  it("is what the shared folder lookup falls back to", () => {
    const body = source.slice(source.indexOf("function getAccessibleFolder("), source.indexOf("function getAccessibleFolder(") + 700);
    assert.match(body, /folderUriWithoutTrailingSlash\(folderPath\)/);
    assert.match(body, /isFolderAccessible\(folder\)/);
  });

  it("leaves no guard comparing the URI as written with the folder found", () => {
    // moveFolder: "already under this parent" must hold for a parent written with a trailing slash.
    assert.match(source, /folder\.parent\.URI === newParent\.URI/);
    assert.doesNotMatch(source, /folder\.parent\.URI === newParentPath/);
  });
});
