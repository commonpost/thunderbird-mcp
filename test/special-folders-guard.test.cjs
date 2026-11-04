// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";

// Thunderbird's special folders (Inbox, Trash, Sent, Drafts, Templates, Outbox,
// Junk, Archives) are never renamed, moved or deleted through MCP, no folder
// gets a special folder's name, and no folder is created or moved into
// Templates or the Outbox. Runs the real createFolder, renameFolder,
// deleteFolder and moveFolder against stand-in folders.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const apiSource = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");

const FLAGS = {
  Virtual: 0x20, Trash: 0x100, SentMail: 0x200, Drafts: 0x400, Queue: 0x800, Inbox: 0x1000,
  Archive: 0x4000, Templates: 0x400000, Junk: 0x40000000,
};

function slice(begin, end) {
  const start = apiSource.indexOf(begin);
  const stop = apiSource.indexOf(end, start);
  assert.ok(start >= 0 && stop > start, `${begin} not found in api.js`);
  return apiSource.slice(start, stop);
}

function constSource(name) {
  const start = apiSource.indexOf(`const ${name} =`);
  assert.ok(start >= 0, `${name} not found in api.js`);
  return apiSource.slice(start, apiSource.indexOf(";", start) + 1);
}

function functionSource(name, indent = "            ") {
  const start = apiSource.indexOf(`\n${indent}function ${name}(`);
  assert.ok(start >= 0, `${name} not found in api.js`);
  const close = `\n${indent}}\n`;
  return apiSource.slice(start, apiSource.indexOf(close, start) + close.length);
}

function makeWorld({ identities = [] } = {}) {
  const calls = [];
  const folders = new Map();
  const root = { URI: "mailbox://nobody@Local%20Folders", name: "Local Folders", flags: 0, parent: null };
  function add(name, flags = 0, parent = root) {
    const f = {
      URI: `${parent.URI}/${encodeURIComponent(name)}`, name, prettyName: name, flags, parent,
      hasSubFolders: false, subFolders: [],
      createSubfolder: (n) => calls.push(["create", f.URI, n]),
      rename: (n) => calls.push(["rename", f.URI, n]),
      deleteSelf: () => calls.push(["deleteSelf", f.URI]),
    };
    folders.set(f.URI, f);
    parent.subFolders.push(f);
    parent.hasSubFolders = true;
    return f;
  }
  folders.set(root.URI, Object.assign(root, {
    isServer: true, hasSubFolders: false, subFolders: [], createSubfolder: (n) => calls.push(["create", root.URI, n]),
  }));
  const special = {
    Inbox: add("Inbox", FLAGS.Inbox), Trash: add("Trash", FLAGS.Trash), Sent: add("Sent", FLAGS.SentMail),
    Drafts: add("Drafts", FLAGS.Drafts), Templates: add("Templates", FLAGS.Templates),
    "Outbox (Unsent Messages)": add("Unsent Messages", FLAGS.Queue), Junk: add("Junk", FLAGS.Junk),
    Archives: add("Archives", FLAGS.Archive),
  };
  const plain = add("Projects");
  const other = add("Clients");
  const inTrash = add("Old", 0, special.Trash);
  // A user folder with a special folder's name, below the top level (made in Thunderbird itself)
  const namedLikeTemplates = add("Templates", 0, plain);
  // An identity's Templates folder chosen by the user, nested in an ordinary folder
  const work = add("Work");
  const nestedTemplates = add("MyTemplates", FLAGS.Templates, work);

  const sandbox = {
    Ci: { nsMsgFolderFlags: FLAGS },
    FILTER_NAME_MAX_LENGTH: 512,
    assertFilterText: () => {},
    getAccessibleFolder: (uri) => (folders.has(uri) ? { folder: folders.get(uri) } : { error: `Folder not found: ${uri}` }),
    folderDisplayName: (f) => f.prettyName,
    isTrashOrDescendant: (f) => f === special.Trash || f.parent === special.Trash,
    findTrashFolder: () => special.Trash,
    deleteVirtualFolder: () => ({ success: true, virtual: true }),
    isPlainObject: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
    createVirtualFolder: (name, parentUri) => { calls.push(["virtual", parentUri, name]); return { success: true }; },
    Services: { wm: { getMostRecentWindow: () => null } },
    MailServices: {
      copy: { copyFolder: (f, to) => calls.push(["copyFolder", f.URI, to.URI]) },
      accounts: { allIdentities: identities },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext([
    constSource("FOLDER_TEXT_NOTE"),
    slice("// BEGIN SPECIAL FOLDER GUARDS", "// END SPECIAL FOLDER GUARDS"),
    functionSource("createFolder"),
    functionSource("renameFolder"),
    functionSource("deleteFolder"),
    functionSource("moveFolder"),
    "this.api = { createFolder, renameFolder, deleteFolder, moveFolder };",
  ].join("\n"), sandbox);
  return { api: sandbox.api, calls, root, special, plain, other, inTrash, namedLikeTemplates, work, nestedTemplates };
}

describe("special folders are never renamed, moved or deleted", () => {
  const roles = Object.keys(makeWorld().special);
  for (const role of roles) {
    it(`${role}: rename, move and delete are refused, and Thunderbird is never asked`, () => {
      const w = makeWorld();
      const f = w.special[role];
      const renamed = w.api.renameFolder(f.URI, "Something else");
      assert.equal(renamed.error, `Cannot rename the ${role} folder through MCP`);
      const moved = w.api.moveFolder(f.URI, w.plain.URI);
      assert.equal(moved.error, `Cannot move the ${role} folder through MCP`);
      const deleted = w.api.deleteFolder(f.URI);
      assert.equal(deleted.error, `Cannot delete the ${role} folder through MCP`);
      assert.deepEqual(w.calls, []);
    });
  }

  it("an ordinary folder is still renamed, moved and deleted", () => {
    const w = makeWorld();
    assert.equal(w.api.renameFolder(w.plain.URI, "Projects 2026").success, true);
    assert.equal(w.api.moveFolder(w.other.URI, w.plain.URI).success, true);
    assert.equal(w.api.deleteFolder(w.other.URI).success, true);
    assert.equal(w.api.deleteFolder(w.inTrash.URI).success, true);
    assert.deepEqual(w.calls, [
      ["rename", w.plain.URI, "Projects 2026"],
      ["copyFolder", w.other.URI, w.plain.URI],
      ["copyFolder", w.other.URI, w.special.Trash.URI],
      ["deleteSelf", w.inTrash.URI],
    ]);
  });
});

describe("no folder gets a special folder's name", () => {
  const names = ["Inbox", "Trash", "Sent", "Drafts", "Templates", "Unsent Messages", "Outbox", "Junk", "Archives",
    "templates", "TEMPLATES", "  Templates ", "unsent messages", "Templates/x", "x/Templates"];
  for (const name of names) {
    it(`${JSON.stringify(name)}: refused at the top level for a new folder, a new name and a saved search`, () => {
      const w = makeWorld();
      const created = w.api.createFolder(w.root.URI, name);
      assert.match(created.error, /is the name of a Thunderbird special folder/);
      const renamed = w.api.renameFolder(w.plain.URI, name);
      assert.match(renamed.error, /is the name of a Thunderbird special folder/);
      const search = w.api.createFolder(w.root.URI, name, { searchFolderPaths: [w.plain.URI] });
      assert.match(search.error, /is the name of a Thunderbird special folder/);
      assert.deepEqual(w.calls, []);
    });
  }

  it("on a local account \".\" is not a folder level: Sent.old, Inbox.2023 and Archives.2019 are fine at the top level", () => {
    const w = makeWorld();
    for (const name of ["Sent.old", "Inbox.2023", "Archives.2019"]) {
      assert.equal(w.api.createFolder(w.root.URI, name).success, true, name);
    }
  });

  it("below the top level, Thunderbird gives no role by name: Clients/Sent and Projects/Templates.x are fine", () => {
    const w = makeWorld();
    assert.equal(w.api.createFolder(w.plain.URI, "Sent").success, true);
    assert.equal(w.api.createFolder(w.plain.URI, "Templates.x").success, true);
    assert.equal(w.api.renameFolder(w.other.URI, "Clients").success, true);
  });

  it("names that only contain a special folder's name are fine", () => {
    const w = makeWorld();
    for (const name of ["Templates old", "My Inbox", "Sent 2025", "Archive", "Trash bin"]) {
      assert.equal(w.api.createFolder(w.root.URI, name).success, true, name);
    }
  });

  it("a folder named like a special folder (made in Thunderbird) is not moved to the top level, but can move elsewhere", () => {
    const w = makeWorld();
    const r = w.api.moveFolder(w.namedLikeTemplates.URI, w.root.URI);
    assert.match(r.error, /is the name of a Thunderbird special folder/);
    assert.deepEqual(w.calls, []);
    assert.equal(w.api.moveFolder(w.namedLikeTemplates.URI, w.other.URI).success, true);
  });

  it("no folder takes the address an identity names for its Sent, Drafts, Templates or Archives folder", () => {
    const root = "mailbox://nobody@Local%20Folders";
    for (const [key, name] of [["stationeryFolder", "My Templates"], ["templatesFolderURI", "My Templates"],
      ["fccFolder", "Copies"], ["draftFolder", "Brouillons"], ["archiveFolder", "Kept"]]) {
      const w = makeWorld({ identities: [{ [key]: `${root}/${encodeURIComponent(name)}` }] });
      assert.match(w.api.createFolder(root, name).error, /where an identity keeps its/, key);
      assert.match(w.api.createFolder(root, name.toUpperCase()).error, /where an identity keeps its/, key);
      assert.match(w.api.renameFolder(w.plain.URI, name).error, /where an identity keeps its/, key);
      assert.deepEqual(w.calls, []);
      assert.equal(w.api.createFolder(root, `${name} 2`).success, true, key);
    }
  });
});

describe("a folder holding a special folder is not renamed, moved or deleted", () => {
  it("Work holds the identity's Templates folder: refused, and Thunderbird is never asked", () => {
    const w = makeWorld();
    assert.equal(w.api.renameFolder(w.work.URI, "Job").error, "Cannot rename a folder that holds the Templates folder through MCP");
    assert.equal(w.api.moveFolder(w.work.URI, w.plain.URI).error, "Cannot move a folder that holds the Templates folder through MCP");
    assert.equal(w.api.deleteFolder(w.work.URI).error, "Cannot delete a folder that holds the Templates folder through MCP");
    assert.equal(w.api.deleteFolder(w.nestedTemplates.URI).error, "Cannot delete the Templates folder through MCP");
    assert.deepEqual(w.calls, []);
  });
});

describe("nothing is created or moved into Templates or the Outbox", () => {
  for (const role of ["Templates", "Outbox (Unsent Messages)"]) {
    it(`${role}: no new subfolder, no folder moved in`, () => {
      const w = makeWorld();
      const target = w.special[role];
      assert.match(w.api.createFolder(target.URI, "Inside").error, /^Cannot put a folder inside/);
      assert.match(w.api.createFolder(target.URI, "Inside", { searchFolderPaths: [w.plain.URI] }).error, /^Cannot put a folder inside/);
      assert.match(w.api.moveFolder(w.plain.URI, target.URI).error, /^Cannot put a folder inside/);
      assert.deepEqual(w.calls, []);
    });
  }

  it("other special folders can still hold new subfolders (Inbox, Archives)", () => {
    const w = makeWorld();
    assert.equal(w.api.createFolder(w.special.Inbox.URI, "Receipts").success, true);
    assert.equal(w.api.moveFolder(w.plain.URI, w.special.Archives.URI).success, true);
  });
});

describe("an existing filter rule that files into Templates is not kept or run through MCP", () => {
  function load(flags, identities = []) {
    const sandbox = {
      Ci: { nsMsgFolderFlags: FLAGS },
      MailServices: { accounts: { allIdentities: identities } },
      getAccessibleFolder: (uri) => (uri === "missing" ? { error: "x" } : { folder: { URI: uri, getFlag: (f) => (flags & f) !== 0 } }),
    };
    vm.createContext(sandbox);
    vm.runInContext([slice("// BEGIN SPECIAL FOLDER GUARDS", "// END SPECIAL FOLDER GUARDS"),
      constSource("FILTER_TARGET_NOT_ACCESSIBLE"), constSource("FILTER_TARGET_IS_OUTBOX"),
      constSource("FILTER_TARGET_IS_TEMPLATES"), functionSource("checkExistingFilterTarget"),
      "this.check = checkExistingFilterTarget;"].join("\n"), sandbox);
    return sandbox.check;
  }
  it("Templates, the Outbox and an inaccessible folder are refused; an ordinary folder is accepted", () => {
    assert.equal(load(FLAGS.Templates)("t"), "move/copy target is a Templates folder");
    assert.equal(load(FLAGS.Queue)("q"), "move/copy target is the Outbox");
    assert.equal(load(0)("missing"), "move/copy target not accessible");
    assert.equal(load(FLAGS.Archive)("a"), true);
  });

  it("so is the address an identity names for its Templates folder, before Thunderbird flags it", () => {
    const check = load(0, [{ stationeryFolder: "mailbox://nobody@Local%20Folders/My%20Templates" }]);
    assert.equal(check("mailbox://nobody@Local%20Folders/My%20Templates"), "move/copy target is a Templates folder");
    assert.equal(check("mailbox://nobody@Local%20Folders/Other"), true);
  });
});

// An IMAP account: root, INBOX (Inbox flag), a delimiter and a trash name.
function makeImapWorld({ delimiter = "/", trashName = "Trash", identities = [] } = {}) {
  const calls = [];
  const folders = new Map();
  const server = { trashFolderName: trashName };
  const root = { URI: "imap://user@mail.example.test", name: "user", flags: 0, parent: null, isServer: true, subFolders: [], server };
  function add(name, flags = 0, parent = root) {
    const f = {
      URI: `${parent.URI}/${name}`, name, prettyName: name, flags, parent, subFolders: [], server,
      hierarchyDelimiter: delimiter,
      createSubfolder: (n) => calls.push(["create", f.URI, n]),
      rename: (n) => calls.push(["rename", f.URI, n]),
    };
    folders.set(f.URI, f);
    parent.subFolders.push(f);
    return f;
  }
  root.hierarchyDelimiter = delimiter;
  root.createSubfolder = (n) => calls.push(["create", root.URI, n]);
  folders.set(root.URI, root);
  const inbox = add("INBOX", FLAGS.Inbox);
  const work = add("Work", 0, inbox);
  const sandbox = {
    Ci: { nsMsgFolderFlags: FLAGS },
    MailServices: { accounts: { allIdentities: identities }, copy: { copyFolder: (f, to) => calls.push(["copyFolder", f.URI, to.URI]) } },
    assertFilterText: () => {},
    FILTER_NAME_MAX_LENGTH: 512,
    getAccessibleFolder: (uri) => (folders.has(uri) ? { folder: folders.get(uri) } : { error: `Folder not found: ${uri}` }),
    folderDisplayName: (f) => f.prettyName,
    isPlainObject: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
    createVirtualFolder: () => ({ success: true }),
  };
  vm.createContext(sandbox);
  vm.runInContext([
    constSource("FOLDER_TEXT_NOTE"),
    slice("// BEGIN SPECIAL FOLDER GUARDS", "// END SPECIAL FOLDER GUARDS"),
    functionSource("createFolder"),
    functionSource("renameFolder"),
    functionSource("moveFolder"),
    "this.api = { createFolder, renameFolder, moveFolder, encodeImapUtf7 };",
  ].join("\n"), sandbox);
  return { api: sandbox.api, calls, root, inbox, work };
}

describe("IMAP: folder levels, the trash name and identity addresses", () => {
  it("a name with \"/\" is refused: the server would read it as folder levels", () => {
    const w = makeImapWorld();
    assert.match(w.api.createFolder(w.inbox.URI, "Work/Templates/x").error, /cannot contain "\/"/);
    assert.match(w.api.renameFolder(w.work.URI, "a/b").error, /cannot contain "\/"/);
    assert.deepEqual(w.calls, []);
  });

  it("so is the server's own delimiter, \".\" when that is it", () => {
    const dotted = makeImapWorld({ delimiter: "." });
    assert.match(dotted.api.createFolder(dotted.inbox.URI, "Work.Templates").error, /cannot contain "\/" or "\."/);
    const slashed = makeImapWorld({ delimiter: "/" });
    assert.equal(slashed.api.createFolder(slashed.inbox.URI, "Report v1.2").success, true);
  });

  it("with an unknown delimiter, both \"/\" and \".\" are refused", () => {
    const w = makeImapWorld({ delimiter: null });
    assert.match(w.api.createFolder(w.inbox.URI, "a.b").error, /cannot contain "\/" or "\."/);
  });

  it("the server's trash name is refused at the top level and under the Inbox, not elsewhere", () => {
    const w = makeImapWorld({ trashName: "Deleted Items" });
    assert.match(w.api.createFolder(w.inbox.URI, "deleted items").error, /special folder/);
    assert.match(w.api.createFolder(w.root.URI, "Deleted Items").error, /special folder/);
    assert.equal(w.api.createFolder(w.work.URI, "Deleted Items").success, true);
  });

  it("an identity address spelled in modified UTF-7 is matched", () => {
    const w = makeImapWorld({ identities: [{ templatesFolderURI: "imap://user@mail.example.test/INBOX/Mod&AOg-les" }] });
    assert.equal(w.api.encodeImapUtf7("Modèles"), "Mod&AOg-les");
    assert.equal(w.api.encodeImapUtf7("R&D 日本"), "R&-D &ZeVnLA-");
    assert.match(w.api.createFolder(w.inbox.URI, "Modèles").error, /where an identity keeps its/);
    assert.deepEqual(w.calls, []);
  });

  it("renaming or moving a folder onto the parent of an identity address is refused", () => {
    const w = makeImapWorld({ identities: [{ stationeryFolder: "imap://user@mail.example.test/INBOX/Jobs/Templates" }] });
    assert.match(w.api.renameFolder(w.work.URI, "Jobs").error, /would hold the place where an identity keeps/);
    assert.equal(w.api.createFolder(w.inbox.URI, "Jobs").success, true);
  });
});

describe("identity addresses with characters that URIs escape", () => {
  it("\"50% off\" is matched against its percent-escaped address", () => {
    const w = makeWorld({ identities: [{ fccFolder: "mailbox://nobody@Local%20Folders/50%25%20off" }] });
    assert.match(w.api.createFolder(w.root.URI, "50% off").error, /where an identity keeps its/);
  });
});

describe("the guards refuse when they cannot check (fail closed)", () => {
  it("identities that cannot be read: no folder is created, renamed or moved", () => {
    const w = makeWorld({ identities: { [Symbol.iterator]() { throw new Error("no accounts"); } } });
    assert.match(w.api.createFolder(w.root.URI, "Ok").error, /^Cannot check the folder's place/);
    assert.match(w.api.renameFolder(w.plain.URI, "Ok").error, /^Cannot check the folder's place/);
    assert.match(w.api.moveFolder(w.other.URI, w.plain.URI).error, /^Cannot check the folder's place/);
    assert.deepEqual(w.calls, []);
  });

  it("subfolders that cannot be read: not renamed, moved or deleted", () => {
    const w = makeWorld();
    Object.defineProperty(w.other, "subFolders", { get() { throw new Error("not loaded"); } });
    assert.match(w.api.renameFolder(w.other.URI, "Ok").error, /subfolders could not be read/);
    assert.match(w.api.deleteFolder(w.other.URI).error, /subfolders could not be read/);
    assert.deepEqual(w.calls, []);
  });

  it("too many subfolders to walk: refused", () => {
    const w = makeWorld();
    w.other.subFolders = Array.from({ length: 10001 }, (_, i) => ({ URI: `x${i}`, flags: 0, subFolders: [] }));
    assert.match(w.api.deleteFolder(w.other.URI).error, /too many folders to check/);
  });
});
