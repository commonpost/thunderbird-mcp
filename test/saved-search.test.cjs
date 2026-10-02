"use strict";

/**
 * Saved searches (virtual folders) reached through createFolder, listFolders
 * and deleteFolder: conditions are built by the filter code (buildTerms),
 * every searched folder passes the account restriction, and a saved search is
 * deleted as a view, never as mail.
 *
 * The real FILTER SEARCH TERM / FILTER RULE helpers and the VIRTUAL FOLDER
 * block are loaded into one vm context with stand-ins for the XPCOM objects.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");

function region(begin, end, from = 0) {
  const start = source.indexOf(begin, from);
  const stop = source.indexOf(end, start);
  assert.ok(start >= 0, `${begin} missing`);
  assert.ok(stop > start, `${end} missing`);
  return source.slice(start, stop);
}

// nsMsgSearchAttrib / nsMsgSearchOp (nsMsgSearchCore.idl), the members the
// filter vocabulary resolves by name.
const ATTRIB = {
  Custom: -2, Subject: 0, Sender: 1, Body: 2, Date: 3, Priority: 4, MsgStatus: 5,
  To: 6, CC: 7, ToOrCC: 8, AllAddresses: 9, AgeInDays: 12, Size: 14, Keywords: 16,
  HasAttachmentStatus: 44, JunkStatus: 45, JunkPercent: 46, HdrProperty: 49,
  Uint32HdrProperty: 51, OtherHeader: 52,
};
const OPS = {
  Contains: 0, DoesntContain: 1, Is: 2, Isnt: 3, IsEmpty: 4, IsBefore: 5, IsAfter: 6,
  BeginsWith: 9, EndsWith: 10, IsGreaterThan: 13, IsLessThan: 14, IsInAB: 16,
  IsntInAB: 17, IsntEmpty: 18, Matches: 19, DoesntMatch: 20, kNumMsgSearchOperators: 21,
};
const LEGAL_ACCESSOR = {
  [ATTRIB.Priority]: "priority", [ATTRIB.MsgStatus]: "status", [ATTRIB.Date]: "date",
  [ATTRIB.AgeInDays]: "age", [ATTRIB.Size]: "size", [ATTRIB.JunkStatus]: "junkStatus",
  [ATTRIB.JunkPercent]: "junkPercent", [ATTRIB.HasAttachmentStatus]: "status",
};
const VIRTUAL = 0x00000020;

function nonEnumerable(constants) {
  return new Proxy({}, {
    get: (_t, name) => constants[name],
    has: (_t, name) => name in constants,
    ownKeys: () => [],
    getOwnPropertyDescriptor: () => undefined,
  });
}

// An nsIMsgSearchValue that enforces the union rule: only the member matching
// the attribute may be accessed.
function makeSearchValue() {
  const state = { attrib: undefined, stored: undefined };
  const value = {
    get attrib() { return state.attrib; },
    set attrib(v) { state.attrib = v; },
  };
  for (const accessor of ["str", "priority", "date", "status", "size", "age", "junkStatus", "junkPercent"]) {
    Object.defineProperty(value, accessor, {
      enumerable: true,
      get() { if ((LEGAL_ACCESSOR[state.attrib] || "str") !== accessor) throw new Error("NS_ERROR_ILLEGAL_VALUE"); return state.stored; },
      set(v) { if ((LEGAL_ACCESSOR[state.attrib] || "str") !== accessor) throw new Error("NS_ERROR_ILLEGAL_VALUE"); state.stored = v; },
    });
  }
  return value;
}

function makeTerm() {
  return { attrib: undefined, op: undefined, booleanAnd: undefined, arbitraryHeader: "", value: makeSearchValue() };
}

function makeFolder(uri, { flags = 0, parent = null, serverKey = "server1", name } = {}) {
  const deleted = [];
  return {
    URI: uri, flags, parent, name: name || uri, prettyName: name || uri,
    server: { key: serverKey },
    deleted,
    propagateDelete(child, deleteStorage) { deleted.push([child.URI, deleteStorage]); },
  };
}

function loadSandbox({ blocked = [], blockedBooks = [] } = {}) {
  const created = [];
  const wrappers = new Map();
  const folders = new Map();
  const sandbox = {
    Ci: {
      nsMsgSearchAttrib: nonEnumerable(ATTRIB),
      nsMsgSearchOp: nonEnumerable(OPS),
      nsMsgMessageFlags: nonEnumerable({ Attachment: 0x10000000, Read: 1 }),
      nsMsgPriority: nonEnumerable({ normal: 4, Default: 4 }),
      nsMsgFolderFlags: { Virtual: VIRTUAL },
      nsIMsgSearchSession: {},
    },
    Cc: {
      "@mozilla.org/messenger/searchSession;1": {
        createInstance: () => ({ createTerm: makeTerm }),
      },
    },
    Services: { prefs: { getCharPref: (_n, fallback) => fallback } },
    ChromeUtils: {
      importESModule: () => ({
        VirtualFolderHelper: {
          createNewVirtualFolder(name, parent, searchFolders, terms, online) {
            created.push({ name, parent, searchFolders, terms, online });
            return { virtualFolder: { URI: `${parent.URI}/${name}` } };
          },
          wrapVirtualFolder: (folder) => wrappers.get(folder.URI),
        },
      }),
    },
    MailServices: {
      accounts: {
        get allFolders() { return [...folders.values()]; },
        // account1 owns server1, as in Thunderbird: the tools speak in account keys
        findAccountForServer: (server) => ({ key: server.key.replace("server", "account") }),
      },
    },
    getAccessibleFolder(uri) {
      if (blocked.includes(uri)) return { error: `Account not accessible for folder: ${uri}` };
      const folder = folders.get(uri);
      return folder ? { folder } : { error: `Folder not found: ${uri}` };
    },
    checkFilterAddressBook: (uri) => (blockedBooks.includes(uri) ? "address book not accessible" : true),
    created, wrappers, folders,
  };
  vm.createContext(sandbox);
  const code = [
    region("// BEGIN FILTER SEARCH TERM HELPERS", "// END FILTER SEARCH TERM HELPERS"),
    region("// BEGIN FILTER RULE HELPERS", "// END FILTER RULE HELPERS"),
    region("// BEGIN VIRTUAL FOLDER (SAVED SEARCH) HELPERS", "// END VIRTUAL FOLDER (SAVED SEARCH) HELPERS"),
    "this.buildSearchTerms = buildSearchTerms; this.createVirtualFolder = createVirtualFolder;",
    "this.listVirtualFolders = listVirtualFolders; this.deleteVirtualFolder = deleteVirtualFolder;",
  ].join("\n");
  vm.runInContext(code, sandbox);
  return sandbox;
}

function addFolder(sb, uri, opts) {
  const f = makeFolder(uri, opts);
  sb.folders.set(uri, f);
  return f;
}

describe("buildSearchTerms (term factory around buildTerms)", () => {
  const sb = loadSandbox();

  it("mints typed values through the filter vocabulary", () => {
    const [size, attach, date, from] = sb.buildSearchTerms([
      { attrib: "size", op: "isGreaterThan", value: "1024" },
      { attrib: "hasAttachment", op: "is" },
      { attrib: "date", op: "isAfter", value: "2026-01-01" },
      { attrib: "from", op: "contains", value: "a@example.com", booleanAnd: false },
    ]);
    assert.equal(size.attrib, ATTRIB.Size);
    assert.equal(typeof size.value.size, "number");
    assert.equal(attach.attrib, ATTRIB.HasAttachmentStatus);
    assert.equal(attach.value.status, 0x10000000);
    assert.equal(typeof date.value.date, "number");
    assert.equal(from.value.str, "a@example.com");
    assert.equal(from.booleanAnd, false);
    assert.equal(size.booleanAnd, true);
  });

  it("refuses an unknown attribute, operator and raw enum value", () => {
    assert.throws(() => sb.buildSearchTerms([{ attrib: "nope", op: "contains", value: "x" }]), /Unknown attribute/);
    assert.throws(() => sb.buildSearchTerms([{ attrib: "subject", op: "nope", value: "x" }]), /Unknown operator/);
    assert.throws(() => sb.buildSearchTerms([{ attrib: 44, op: 2, value: "x" }]), /Unknown attribute/);
  });

  it("refuses an address book the restrictions do not allow", () => {
    const blockedSb = loadSandbox({ blockedBooks: ["moz-abdirectory://secret.sqlite"] });
    assert.throws(
      () => blockedSb.buildSearchTerms([{ attrib: "from", op: "isInAB", value: "moz-abdirectory://secret.sqlite" }]),
      /address book not accessible/
    );
    const [ok] = blockedSb.buildSearchTerms([{ attrib: "from", op: "isInAB", value: "moz-abdirectory://abook.sqlite" }]);
    assert.equal(ok.op, OPS.IsInAB);
  });
});

describe("createVirtualFolder", () => {
  const conds = [{ attrib: "subject", op: "contains", value: "invoice" }];

  function setup(opts) {
    const sb = loadSandbox(opts);
    addFolder(sb, "imap://a/INBOX");
    addFolder(sb, "imap://a/Archive");
    addFolder(sb, "imap://a");
    addFolder(sb, "imap://a/Searches", { flags: VIRTUAL });
    return sb;
  }

  it("creates the view over every searched folder", () => {
    const sb = setup();
    const r = sb.createVirtualFolder("Invoices", "imap://a", ["imap://a/INBOX", "imap://a/Archive"], conds, true);
    assert.equal(r.success, true);
    assert.equal(r.path, "imap://a/Invoices");
    assert.deepEqual([...r.searchFolders], ["imap://a/INBOX", "imap://a/Archive"]);
    assert.equal(sb.created.length, 1);
    assert.equal(sb.created[0].online, true);
    assert.equal(sb.created[0].terms.length, 1);
  });

  it("refuses when any searched folder is not accessible", () => {
    const sb = setup({ blocked: ["imap://a/Archive"] });
    const r = sb.createVirtualFolder("Invoices", "imap://a", ["imap://a/INBOX", "imap://a/Archive"], conds);
    assert.match(r.error, /imap:\/\/a\/Archive/);
    assert.equal(sb.created.length, 0);
  });

  it("allows at most 50 folders and 50 conditions", () => {
    const sb = setup();
    const many = Array.from({ length: 51 }, () => "imap://a/INBOX");
    assert.match(sb.createVirtualFolder("X", "imap://a", many, conds).error, /at most 50/);
    assert.equal(sb.createVirtualFolder("X", "imap://a", many.slice(0, 50), conds).success, true);
    const manyConds = Array.from({ length: 51 }, () => conds[0]);
    assert.match(sb.createVirtualFolder("X", "imap://a", ["imap://a/INBOX"], manyConds).error, /at most 50/);
    assert.equal(sb.createVirtualFolder("X", "imap://a", ["imap://a/INBOX"], manyConds.slice(0, 50)).success, true);
  });

  it("refuses empty or non-string paths and non-object conditions", () => {
    const sb = setup();
    assert.match(sb.createVirtualFolder("X", "imap://a", ["imap://a/INBOX", ""], conds).error, /non-empty folder URI/);
    assert.match(sb.createVirtualFolder("X", "imap://a", ["imap://a/INBOX", 7], conds).error, /non-empty folder URI/);
    assert.match(sb.createVirtualFolder("X", "imap://a", ["imap://a/INBOX"], ["subject"]).error, /must be an object/);
    assert.equal(sb.created.length, 0);
  });

  it("refuses a parent that is itself a saved search", () => {
    const sb = setup();
    const r = sb.createVirtualFolder("X", "imap://a/Searches", ["imap://a/INBOX"], conds);
    assert.match(r.error, /under a saved search/);
    assert.equal(sb.created.length, 0);
  });

  it("reports a bad condition as an error, not an exception", () => {
    const sb = setup();
    const r = sb.createVirtualFolder("X", "imap://a", ["imap://a/INBOX"], [{ attrib: "nope", op: "is", value: "x" }]);
    assert.match(r.error, /Unknown attribute/);
  });
});

describe("listVirtualFolders", () => {
  function setup(opts) {
    const sb = loadSandbox(opts);
    addFolder(sb, "imap://a/INBOX");
    addFolder(sb, "imap://b/INBOX", { serverKey: "server2" });
    const vf = addFolder(sb, "imap://a/Invoices", { flags: VIRTUAL, name: "Invoices" });
    addFolder(sb, "imap://a/Plain");
    const terms = sb.buildSearchTerms([{ attrib: "size", op: "isGreaterThan", value: "1024" }]);
    sb.wrappers.set(vf.URI, {
      searchFolders: [sb.folders.get("imap://a/INBOX"), sb.folders.get("imap://b/INBOX")],
      onlineSearch: false,
      searchTerms: terms,
    });
    return sb;
  }

  it("lists only saved searches, with typed condition values", () => {
    const sb = setup();
    const out = sb.listVirtualFolders();
    assert.equal(out.length, 1);
    assert.equal(out[0].path, "imap://a/Invoices");
    assert.equal(out[0].terms[0].attrib, "size");
    assert.equal(out[0].terms[0].op, "isGreaterThan");
    assert.equal(out[0].terms[0].value, "1024");
    assert.equal(out[0].hiddenSearchFolders, undefined);
  });

  it("names only accessible searched folders and counts the others", () => {
    const sb = setup({ blocked: ["imap://b/INBOX"] });
    const [entry] = sb.listVirtualFolders();
    assert.deepEqual([...entry.searchFolders], ["imap://a/INBOX"]);
    assert.equal(entry.hiddenSearchFolders, 1);
    assert.ok(!JSON.stringify(entry).includes("imap://b/INBOX"));
  });

  it("skips a saved search in an account that is not accessible and filters by account", () => {
    const hidden = setup({ blocked: ["imap://a/Invoices"] });
    assert.equal(hidden.listVirtualFolders().length, 0);
    const sb = setup();
    assert.equal(sb.listVirtualFolders("account2").length, 0);
    assert.equal(sb.listVirtualFolders("server1").length, 0);
    const [listed] = sb.listVirtualFolders("account1");
    assert.equal(listed.accountId, "account1");
  });
});

describe("deleteFolder with a saved search", () => {
  // deleteFolder itself, with stand-ins for its collaborators.
  const code = region("function deleteFolder(", "/**\n             * Find a special folder");

  function load(blocked = []) {
    const sb = loadSandbox({ blocked });
    const trashCopies = [];
    sb.trashCopies = trashCopies;
    sb.folderDisplayName = (f) => f.prettyName;
    sb.isTrashOrDescendant = () => false;
    sb.findTrashFolder = () => ({ URI: "imap://a/Trash" });
    sb.MailServices.copy = { copyFolder: (f) => trashCopies.push(f.URI) };
    sb.Services.wm = { getMostRecentWindow: () => null };
    vm.runInContext(`${code}\nthis.deleteFolder = deleteFolder;`, sb);
    return sb;
  }

  it("removes only the view, without Trash, and says no message was deleted", () => {
    const sb = load();
    const root = addFolder(sb, "imap://a");
    const vf = addFolder(sb, "imap://a/Invoices", { flags: VIRTUAL, parent: root, name: "Invoices" });
    const r = sb.deleteFolder("imap://a/Invoices");
    assert.equal(r.success, true);
    assert.equal(r.message, 'Saved search "Invoices" deleted (no message was deleted)');
    assert.equal(root.deleted.length, 1);
    assert.equal(sb.trashCopies.length, 0);
    assert.equal(vf.deleted.length, 0);
  });

  it("calls propagateDelete on the parent", () => {
    const sb = load();
    const root = addFolder(sb, "imap://a");
    addFolder(sb, "imap://a/Invoices", { flags: VIRTUAL, parent: root });
    sb.deleteFolder("imap://a/Invoices");
    assert.deepEqual(JSON.parse(JSON.stringify(root.deleted)), [["imap://a/Invoices", true]]);
  });

  it("keeps the access check", () => {
    const sb = load(["imap://a/Invoices"]);
    const root = addFolder(sb, "imap://a");
    addFolder(sb, "imap://a/Invoices", { flags: VIRTUAL, parent: root });
    assert.match(sb.deleteFolder("imap://a/Invoices").error, /not accessible/);
    assert.deepEqual(root.deleted, []);
  });

  it("leaves a real folder on the Trash path", () => {
    const sb = load();
    const root = addFolder(sb, "imap://a");
    addFolder(sb, "imap://a/Plain", { parent: root, name: "Plain" });
    const r = sb.deleteFolder("imap://a/Plain");
    assert.equal(r.message, 'Folder "Plain" moved to Trash');
    assert.deepEqual([...sb.trashCopies], ["imap://a/Plain"]);
    assert.deepEqual(root.deleted, []);
  });

  it("deleteVirtualFolder refuses a real folder", () => {
    const sb = load();
    const root = addFolder(sb, "imap://a");
    addFolder(sb, "imap://a/Plain", { parent: root });
    assert.match(sb.deleteVirtualFolder("imap://a/Plain").error, /Not a saved search/);
    assert.deepEqual(root.deleted, []);
  });
});

describe("createFolder / listFolders wiring", () => {
  it("createFolder routes savedSearch to the saved-search code and rejects a non-object", () => {
    const sb = loadSandbox();
    const calls = [];
    sb.createVirtualFolder = (...args) => { calls.push(args); return { success: true }; };
    sb.assertFilterText = (_label, v) => { if (v.includes("\\")) throw new Error("bad name"); };
    sb.FILTER_NAME_MAX_LENGTH = 100;
    sb.folderDisplayName = (f) => f.name;
    const code = region("const FOLDER_TEXT_NOTE", "// BEGIN VIRTUAL FOLDER (SAVED SEARCH) HELPERS");
    // isPlainObject lives in the virtual-folder block; it is a function
    // declaration of the same scope in api.js.
    vm.runInContext(`function isPlainObject(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }\n${code}\nthis.createFolder = createFolder;`, sb);
    const ss = { searchFolderPaths: ["a"], conditions: [{}], searchOnline: true };
    assert.deepEqual(sb.createFolder("p", "N", ss), { success: true });
    assert.deepEqual(calls[0], ["N", "p", ["a"], [{}], true]);
    assert.match(sb.createFolder("p", "N", "x").error, /savedSearch must be an object/);
    assert.match(sb.createFolder("p", "N", [1]).error, /savedSearch must be an object/);
    assert.equal(sb.createFolder("p", "a\\b", ss).error, "bad name");
    assert.equal(calls.length, 1);
  });

  it("listFolders returns only saved searches when savedSearches is true", () => {
    assert.match(source, /if \(savedSearches === true\) return listVirtualFolders\(accountId\);/);
    assert.match(source, /return createFolder\(args\.parentFolderPath, args\.name, args\.savedSearch\)/);
  });

  it("the three tools describe the saved-search options", () => {
    assert.match(source, /savedSearches: \{ type: "boolean"/);
    assert.match(source, /savedSearch: \{\s*type: "object"/);
  });
});
