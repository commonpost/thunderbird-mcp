// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";

// The helpers behind the special folder guards: how an IMAP server spells a folder name, which names it reads as
// folder levels, where the identities keep their Sent, Drafts, Templates and Archives folders, and what a guard
// does when what it must check cannot be read. The real region of api.js runs against stand-in folders.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const apiSource = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");
const begin = apiSource.indexOf("// BEGIN SPECIAL FOLDER GUARDS");
const end = apiSource.indexOf("// END SPECIAL FOLDER GUARDS");
assert.ok(begin >= 0 && end > begin, "special folder guard markers missing");

const FLAGS = { Inbox: 0x1000, Trash: 0x100, SentMail: 0x200, Drafts: 0x400, Queue: 0x800, Archive: 0x4000, Templates: 0x400000, Junk: 0x40000000 };

function load({ identities = [] } = {}) {
  const sandbox = {
    Ci: { nsMsgFolderFlags: FLAGS, nsIMsgImapMailFolder: Symbol("imapFolder"), nsIImapIncomingServer: Symbol("imapServer") },
    MailServices: { accounts: { allIdentities: identities } },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${apiSource.slice(begin, end)}
this.api = { specialFolderRole, specialFolderRefusal, imapDelimiter, imapTrashName, encodeImapUtf7, normalizedFolderUri,
  candidateFolderUris, identityFolderUris, isIdentityTemplatesAddress, reservedFolderPlaceError, noNewFolderInsideError,
  isTopLevel, isImapFolder };`, sandbox);
  return { api: sandbox.api, Ci: sandbox.Ci };
}

describe("IMAP spelling of a folder name (modified UTF-7)", () => {
  const { api } = load();

  it("keeps printable ASCII as it is and doubles the ampersand", () => {
    assert.equal(api.encodeImapUtf7("Projects 2026"), "Projects 2026");
    assert.equal(api.encodeImapUtf7("R&D"), "R&-D");
    assert.equal(api.encodeImapUtf7(""), "");
  });

  it("encodes other characters between & and -, with the padding bits of the last group", () => {
    assert.equal(api.encodeImapUtf7("é"), "&AOk-");
    assert.equal(api.encodeImapUtf7("Café"), "Caf&AOk-");
    assert.equal(api.encodeImapUtf7("日本語"), "&ZeVnLIqe-");
  });

  it("a run whose bits end exactly on a sextet needs no padding bits (three characters: 48 bits)", () => {
    assert.equal(api.encodeImapUtf7("éàü"), "&AOkA4AD8-");
  });

  it("treats a control character as one that needs encoding", () => {
    assert.equal(api.encodeImapUtf7("a\u0001b"), "a&AAE-b");
    assert.equal(api.encodeImapUtf7("\u007f"), "&AH8-");
  });
});

describe("folder addresses", () => {
  const { api } = load();

  it("normalizes an address: decoded when it can be, without trailing slashes, in lower case", () => {
    assert.equal(api.normalizedFolderUri("imap://User@Host/INBOX/Caf%C3%A9//"), "imap://user@host/inbox/café");
    assert.equal(api.normalizedFolderUri("imap://host/100%"), "imap://host/100%", "an address that does not decode is kept as it is");
    assert.equal(api.normalizedFolderUri(undefined), "");
    assert.equal(api.normalizedFolderUri(null), "");
  });

  it("lists the spellings under which a folder of that name may exist, escaped, raw and in modified UTF-7", () => {
    const uris = [...api.candidateFolderUris({ URI: "imap://user@host/INBOX" }, "Café")].sort();
    assert.deepEqual(uris, ["imap://user@host/inbox/caf&aok-", "imap://user@host/inbox/café"]);
    assert.ok(api.candidateFolderUris({ URI: "imap://host/100%" }, "x").has("imap://host/100%/x"), "an address that does not decode is used as it is");
    assert.ok(api.candidateFolderUris(undefined, "Name").has("/name"), "a missing parent has no address");
  });

  it("reads where each identity keeps its folders, ignoring empty or non-text addresses and those it cannot read", () => {
    const { api: guarded } = load({
      identities: [
        { fccFolderURI: "imap://u@h/Sent/", draftsFolderURI: "", templatesFolderURI: 7, stationeryFolder: "mailbox://x/Templates" },
        { get fccFolderURI() { throw new Error("NS_ERROR_FAILURE"); }, archivesFolderURI: "imap://u@h/Archives" },
      ],
    });
    assert.deepEqual([...guarded.identityFolderUris()].sort(), ["imap://u@h/archives", "imap://u@h/sent", "mailbox://x/templates"]);
    assert.deepEqual([...guarded.identityFolderUris(["stationeryFolder"])], ["mailbox://x/templates"]);
  });

  it("recognizes the address of an identity's Templates folder, and answers yes when the identities cannot be read", () => {
    const { api: guarded } = load({ identities: [{ templatesFolderURI: "imap://u@h/Templates" }] });
    assert.equal(guarded.isIdentityTemplatesAddress({ URI: "imap://U@h/templates/" }), true);
    assert.equal(guarded.isIdentityTemplatesAddress({ URI: "imap://u@h/Other" }), false);
    const broken = load({ identities: { [Symbol.iterator]() { throw new Error("NS_ERROR_FAILURE"); } } }).api;
    assert.equal(broken.isIdentityTemplatesAddress({ URI: "imap://u@h/Other" }), true, "fails closed");
  });
});

describe("the IMAP server's own settings", () => {
  const { api, Ci } = load();

  it("reads the hierarchy delimiter through the IMAP interface when the folder has one, and as is otherwise", () => {
    const viaInterface = { QueryInterface: (iid) => { assert.equal(iid, Ci.nsIMsgImapMailFolder); return { hierarchyDelimiter: "." }; } };
    assert.equal(api.imapDelimiter(viaInterface), ".");
    assert.equal(api.imapDelimiter({ hierarchyDelimiter: "/" }), "/");
    assert.equal(api.imapDelimiter({ hierarchyDelimiter: "ab" }), null, "a delimiter is one character");
    assert.equal(api.imapDelimiter({ hierarchyDelimiter: 5 }), null);
    assert.equal(api.imapDelimiter({ QueryInterface() { throw new Error("NS_NOINTERFACE"); } }), null);
  });

  it("reads the name of the server's Trash folder through the IMAP server interface, with Trash as the default", () => {
    const viaInterface = { server: { QueryInterface: (iid) => { assert.equal(iid, Ci.nsIImapIncomingServer); return { trashFolderName: "Corbeille" }; } } };
    assert.equal(api.imapTrashName(viaInterface), "Corbeille");
    assert.equal(api.imapTrashName({ server: { trashFolderName: "Papierkorb" } }), "Papierkorb");
    assert.equal(api.imapTrashName({ server: { trashFolderName: "" } }), "Trash");
    assert.equal(api.imapTrashName({ server: { trashFolderName: 3 } }), "Trash");
    assert.equal(api.imapTrashName({}), "Trash", "a folder with no server");
    assert.equal(api.imapTrashName({ server: { QueryInterface() { throw new Error("NS_NOINTERFACE"); } } }), "Trash");
  });
});

describe("reservedFolderPlaceError", () => {
  const imapParent = (delimiter, extra = {}) => ({ URI: "imap://u@h/INBOX", flags: FLAGS.Inbox, hierarchyDelimiter: delimiter, ...extra });
  const { api } = load();

  it("on IMAP, refuses a name with a character the server reads as a folder level", () => {
    assert.match(api.reservedFolderPlaceError(imapParent("."), "a.b"), /cannot contain "\/" or "\."/);
    assert.match(api.reservedFolderPlaceError(imapParent("/"), "a/b"), /cannot contain "\/"/);
    assert.match(api.reservedFolderPlaceError(imapParent(undefined), "a.b"), /cannot contain "\/" or "\."/, "with no known delimiter both are refused");
  });

  it("refuses the names of special folders at the top level, in any case and inside a path", () => {
    const top = { URI: "mailbox://nobody@Local%20Folders", isServer: true };
    assert.match(api.reservedFolderPlaceError(top, "Templates"), /name of a Thunderbird special folder/);
    assert.match(api.reservedFolderPlaceError(top, "work/ SENT "), /name of a Thunderbird special folder/);
    assert.equal(api.reservedFolderPlaceError(top, "Projects"), null);
    assert.equal(api.reservedFolderPlaceError({ URI: "mailbox://nobody@Local%20Folders/Work", parent: { isServer: true } }, "Templates"), null, "not at the top level");
  });

  it("on IMAP, refuses the server's own Trash name under the Inbox or the top level, whatever its case", () => {
    const withTrash = (name) => ({ ...imapParent("/"), server: { trashFolderName: name } });
    assert.match(api.reservedFolderPlaceError(withTrash("Corbeille"), "corbeille"), /name of a Thunderbird special folder/);
    assert.equal(api.reservedFolderPlaceError({ ...withTrash("Corbeille"), flags: 0, parent: { parent: {} } }, "corbeille"), null);
  });

  it("refuses a place that an identity names for one of its folders, and one that would hold such a place", () => {
    const { api: guarded } = load({ identities: [{ fccFolderURI: "mailbox://nobody@Local%20Folders/Work/Sent" }] });
    const work = { URI: "mailbox://nobody@Local%20Folders/Work", parent: { isServer: true }, flags: 0 };
    const root = { URI: "mailbox://nobody@Local%20Folders", isServer: true, flags: 0 };
    assert.match(guarded.reservedFolderPlaceError(work, "Sent"), /is where an identity keeps its Sent, Drafts, Templates or Archives folder/);
    assert.equal(guarded.reservedFolderPlaceError(root, "Work"), null, "a new folder cannot hold subfolders yet");
    assert.match(guarded.reservedFolderPlaceError(root, "Work", true), /would hold the place where an identity keeps/);
    assert.equal(guarded.reservedFolderPlaceError(root, "Elsewhere", true), null);
  });

  it("refuses when the identities cannot be read", () => {
    const broken = load({ identities: { [Symbol.iterator]() { throw new Error("NS_ERROR_FAILURE"); } } }).api;
    assert.match(broken.reservedFolderPlaceError({ URI: "mailbox://x/Work", parent: { isServer: true } }, "New"), /Cannot check the folder's place against the identities/);
  });
});

describe("what a folder holds, and where nothing may be put", () => {
  const { api } = load();

  it("names the special role of a folder from its flags, and none for a folder without flags", () => {
    assert.equal(api.specialFolderRole({ flags: FLAGS.Junk }), "Junk");
    assert.equal(api.specialFolderRole({ flags: FLAGS.Queue }), "Outbox (Unsent Messages)");
    assert.equal(api.specialFolderRole({ flags: 0 }), null);
    assert.equal(api.specialFolderRole({}), null);
    assert.equal(api.specialFolderRole(null), null);
    assert.equal(api.specialFolderRole({ flags: "junk" }), null);
  });

  it("says why a folder with unreadable or too many subfolders cannot be changed", () => {
    const unreadable = { flags: 0, get subFolders() { throw new Error("NS_ERROR_FAILURE"); } };
    assert.match(api.specialFolderRefusal(unreadable, "rename"), /Cannot rename this folder through MCP: its subfolders could not be read/);
    const wide = { flags: 0, subFolders: Array.from({ length: 10001 }, () => ({ flags: 0, subFolders: null })) };
    assert.match(api.specialFolderRefusal(wide, "move"), /Cannot move this folder through MCP: it holds too many folders to check/);
    assert.equal(api.specialFolderRefusal({ flags: 0, subFolders: null }, "delete"), null);
    assert.equal(api.specialFolderRefusal({ flags: 0, subFolders: [{ flags: 0, subFolders: [] }] }, "delete"), null);
  });

  it("finds a special folder deep in the tree, and names it", () => {
    const tree = { flags: 0, subFolders: [{ flags: 0, subFolders: [{ flags: FLAGS.Templates, subFolders: [] }] }] };
    assert.equal(api.specialFolderRefusal(tree, "delete"), "Cannot delete a folder that holds the Templates folder through MCP");
    assert.equal(api.specialFolderRefusal({ flags: FLAGS.Trash }, "rename"), "Cannot rename the Trash folder through MCP");
  });

  it("allows no new folder inside Templates or the Outbox", () => {
    assert.equal(api.noNewFolderInsideError({ flags: FLAGS.Templates }), "Cannot put a folder inside a Templates folder through MCP");
    assert.equal(api.noNewFolderInsideError({ flags: FLAGS.Queue }), "Cannot put a folder inside the Outbox (Unsent Messages) through MCP");
    assert.equal(api.noNewFolderInsideError({ flags: FLAGS.Inbox }), null);
    assert.equal(api.noNewFolderInsideError(undefined), null);
  });

  it("takes a parent that cannot be read, or has no parent, as the top level", () => {
    assert.equal(api.isTopLevel(undefined), true);
    assert.equal(api.isTopLevel({ isServer: true, parent: {} }), true);
    assert.equal(api.isTopLevel({ parent: null }), true);
    assert.equal(api.isTopLevel({ get isServer() { throw new Error("NS_ERROR_FAILURE"); } }), true);
    assert.equal(api.isTopLevel({ parent: {} }), false);
    assert.equal(api.isImapFolder({ URI: "IMAP://x/y" }), true);
    assert.equal(api.isImapFolder({}), false);
    assert.equal(api.isImapFolder(undefined), false);
  });
});
