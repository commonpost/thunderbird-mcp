// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";

// createFolder and moveFolder: the arguments they refuse, the way a new folder's address is reported, a folder that
// already exists, a saved search made in the place of a folder, and the names used in their messages. The real
// functions of api.js (and the special folder guards they call) run against stand-in folders.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const apiSource = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");

function slice(begin, end) {
  const start = apiSource.indexOf(begin);
  const stop = apiSource.indexOf(end, start);
  assert.ok(start >= 0 && stop > start, `${begin} not found in api.js`);
  return apiSource.slice(start, stop);
}

function functionSource(name, indent = "            ") {
  const start = apiSource.indexOf(`\n${indent}function ${name}(`);
  assert.ok(start >= 0, `${name} not found in api.js`);
  const close = `\n${indent}}\n`;
  return apiSource.slice(start, apiSource.indexOf(close, start) + close.length);
}

const FLAGS = { Inbox: 0x1000, Trash: 0x100, SentMail: 0x200, Drafts: 0x400, Queue: 0x800, Archive: 0x4000, Templates: 0x400000, Junk: 0x40000000 };
const ROOT_URI = "mailbox://nobody@Local%20Folders";

function makeWorld({ folders = {}, createFails = null, copyFails = null } = {}) {
  const log = { created: [], copied: [], virtual: [] };
  const byUri = new Map(Object.entries(folders));
  const sandbox = {
    arrivalResendCheck: () => null, folderArrivalInfo: () => null, someUnread: () => true, folderHasUnread: () => true, // arrival guard: arrival-resend-guard.test.cjs
    Ci: { nsMsgFolderFlags: FLAGS },
    FILTER_NAME_MAX_LENGTH: 500,
    FOLDER_TEXT_NOTE: "it cannot be a folder name",
    assertFilterText(label, value) {
      if (value.includes("\n")) throw new Error(`${label} contains a control or line-separator character`);
      return value;
    },
    isPlainObject: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
    getAccessibleFolder: (uri) => (byUri.has(uri) ? { folder: byUri.get(uri) } : { error: `Folder not found: ${uri}` }),
    folderDisplayName: (folder) => folder.display ?? folder.name,
    createVirtualFolder(...args) { log.virtual.push(args); return { success: true, virtual: true }; },
    MailServices: {
      accounts: { allIdentities: [] },
      copy: { copyFolder(...args) { log.copied.push(args); if (copyFails) throw copyFails; } },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext([
    slice("// BEGIN SPECIAL FOLDER GUARDS", "// END SPECIAL FOLDER GUARDS"),
    functionSource("createFolder"),
    functionSource("moveFolder"),
    "this.api = { createFolder, moveFolder };",
  ].join("\n"), sandbox);
  const make = (uri, props = {}) => {
    const folder = {
      URI: uri, name: decodeURIComponent(uri.split("/").pop()), flags: 0, hasSubFolders: false, subFolders: [], parent: null,
      createSubfolder(name, win) { log.created.push([uri, name, win]); if (createFails) throw createFails; },
      ...props,
    };
    byUri.set(uri, folder);
    return folder;
  };
  return { api: sandbox.api, log, make };
}

const plain = (value) => JSON.parse(JSON.stringify(value));

describe("createFolder: arguments", () => {
  it("refuses a parent or a name that is not a non-empty string", () => {
    const w = makeWorld();
    for (const bad of [undefined, null, "", 7, {}]) {
      assert.deepEqual(plain(w.api.createFolder(bad, "New")), { error: "parentFolderPath must be a non-empty string" });
      assert.deepEqual(plain(w.api.createFolder(ROOT_URI, bad)), { error: "name must be a non-empty string" });
    }
    assert.deepEqual(w.log.created, []);
  });

  it("refuses a name with a control character, with the reason", () => {
    const w = makeWorld();
    assert.deepEqual(plain(w.api.createFolder(ROOT_URI, "bad\nname")), { error: "Folder name contains a control or line-separator character" });
  });

  it("answers with the error of a parent that cannot be reached", () => {
    const w = makeWorld();
    assert.deepEqual(plain(w.api.createFolder("mailbox://nobody@Local%20Folders/Gone", "New")), { error: "Folder not found: mailbox://nobody@Local%20Folders/Gone" });
  });

  it("refuses a place inside Templates and a name that is reserved, before creating anything", () => {
    const w = makeWorld();
    const templates = w.make(`${ROOT_URI}/Templates`, { flags: FLAGS.Templates });
    const root = w.make(ROOT_URI, { isServer: true });
    assert.match(w.api.createFolder(templates.URI, "Sub").error, /Cannot put a folder inside a Templates folder/);
    assert.match(w.api.createFolder(root.URI, "Trash").error, /name of a Thunderbird special folder/);
    assert.deepEqual(w.log.created, []);
  });
});

describe("createFolder: the new folder", () => {
  function parentWith(w, subs, extra = {}) {
    const parent = w.make(`${ROOT_URI}/Projects`, { parent: { isServer: true }, ...extra });
    parent.hasSubFolders = subs !== null;
    parent.subFolders = subs ?? [];
    return parent;
  }

  it("reports the address of the new folder, found by its display name or its name", () => {
    const w = makeWorld();
    const byDisplay = { URI: `${ROOT_URI}/Projects/x`, name: "x", display: "Résumés" };
    const byName = { URI: `${ROOT_URI}/Projects/Plain`, name: "Plain", display: "Something else" };
    const parent = parentWith(w, [{ URI: `${ROOT_URI}/Projects/other`, name: "other" }, byDisplay, byName]);
    assert.deepEqual(plain(w.api.createFolder(parent.URI, "Résumés")), { success: true, message: 'Folder "Résumés" created', path: byDisplay.URI });
    assert.equal(w.api.createFolder(parent.URI, "Plain").path, byName.URI);
    assert.deepEqual(w.log.created.map((c) => c.slice(0, 2)), [[parent.URI, "Résumés"], [parent.URI, "Plain"]]);
    assert.equal(w.log.created[0][2], null, "no window");
  });

  it("reports no address when the new folder is not visible yet, or the parent has no subfolders, or they cannot be read", () => {
    const w = makeWorld();
    const hidden = parentWith(w, [{ URI: "x", name: "other" }]);
    assert.equal(w.api.createFolder(hidden.URI, "New").path, null);
    const none = w.make(`${ROOT_URI}/Empty`, { parent: { isServer: true }, hasSubFolders: false });
    assert.equal(w.api.createFolder(none.URI, "New").path, null);
    const unreadable = w.make(`${ROOT_URI}/Locked`, { parent: { isServer: true }, hasSubFolders: true });
    Object.defineProperty(unreadable, "subFolders", { get() { throw new Error("NS_ERROR_NOT_AVAILABLE"); } });
    const result = plain(w.api.createFolder(unreadable.URI, "New"));
    assert.equal(result.success, true);
    assert.equal(result.path, null);
  });

  it("says a folder of that name already exists, and gives any other failure as text", () => {
    const exists = makeWorld({ createFails: new Error("NS_MSG_FOLDER_EXISTS") });
    const parent = exists.make(`${ROOT_URI}/Projects`, { parent: { isServer: true } });
    assert.deepEqual(plain(exists.api.createFolder(parent.URI, "Dup")), { error: 'Folder "Dup" already exists under this parent' });
    const broken = makeWorld({ createFails: new Error("NS_ERROR_FAILURE") });
    const p2 = broken.make(`${ROOT_URI}/Projects`, { parent: { isServer: true } });
    assert.deepEqual(plain(broken.api.createFolder(p2.URI, "New")), { error: "Error: NS_ERROR_FAILURE" });
  });
});

describe("createFolder: saved searches", () => {
  it("refuses a saved search that is not an object", () => {
    const w = makeWorld();
    const parent = w.make(`${ROOT_URI}/Projects`, { parent: { isServer: true } });
    for (const bad of ["inbox", 3, [], true]) {
      assert.deepEqual(plain(w.api.createFolder(parent.URI, "Search", bad)), { error: "savedSearch must be an object" });
    }
    assert.deepEqual(w.log.virtual, []);
  });

  it("hands the parts of a saved search to createVirtualFolder, even when the parent address is not one of a real folder", () => {
    const w = makeWorld();
    const result = plain(w.api.createFolder("virtual-parent", "Search", { searchFolderPaths: ["a"], conditions: [{ attrib: "subject" }], searchOnline: true }));
    assert.deepEqual(result, { success: true, virtual: true });
    assert.deepEqual(plain(w.log.virtual), [["Search", "virtual-parent", ["a"], [{ attrib: "subject" }], true]]);
    assert.deepEqual(w.log.created, [], "no ordinary folder is made");
  });

  it("takes null as no saved search at all", () => {
    const w = makeWorld();
    const parent = w.make(`${ROOT_URI}/Projects`, { parent: { isServer: true } });
    assert.equal(w.api.createFolder(parent.URI, "Plain", null).success, true);
    assert.equal(w.log.created.length, 1);
  });
});

describe("moveFolder", () => {
  function tree() {
    const w = makeWorld();
    const root = w.make(ROOT_URI, { isServer: true });
    const projects = w.make(`${ROOT_URI}/Projects`, { parent: root });
    const clients = w.make(`${ROOT_URI}/Clients`, { parent: root });
    const old = w.make(`${ROOT_URI}/Projects/Old`, { parent: projects });
    return { w, root, projects, clients, old };
  }

  it("refuses a folder or a destination that is not a non-empty string", () => {
    const { w } = tree();
    for (const bad of [undefined, null, "", 7]) {
      assert.deepEqual(plain(w.api.moveFolder(bad, `${ROOT_URI}/Clients`)), { error: "folderPath must be a non-empty string" });
      assert.deepEqual(plain(w.api.moveFolder(`${ROOT_URI}/Projects/Old`, bad)), { error: "newParentPath must be a non-empty string" });
    }
    assert.deepEqual(w.log.copied, []);
  });

  it("answers with the error of a folder or a destination that cannot be reached", () => {
    const { w, old } = tree();
    assert.deepEqual(plain(w.api.moveFolder("mailbox://x/Gone", `${ROOT_URI}/Clients`)), { error: "Folder not found: mailbox://x/Gone" });
    assert.deepEqual(plain(w.api.moveFolder(old.URI, "mailbox://x/Nowhere")), { error: "Folder not found: mailbox://x/Nowhere" });
  });

  it("refuses to move a special folder, to move into Templates, and to move to the place it already is in", () => {
    const { w, old, projects, clients, root } = tree();
    const trash = w.make(`${ROOT_URI}/Trash`, { parent: root, flags: FLAGS.Trash });
    const templates = w.make(`${ROOT_URI}/Templates`, { parent: root, flags: FLAGS.Templates });
    assert.match(w.api.moveFolder(trash.URI, clients.URI).error, /Cannot move the Trash folder through MCP/);
    assert.match(w.api.moveFolder(old.URI, templates.URI).error, /Cannot put a folder inside a Templates folder/);
    assert.deepEqual(plain(w.api.moveFolder(old.URI, projects.URI)), { error: "Folder is already under this parent" });
    assert.deepEqual(w.log.copied, []);
  });

  it("moves a folder and names both folders in the message", () => {
    const { w, old, clients } = tree();
    assert.deepEqual(plain(w.api.moveFolder(old.URI, clients.URI)), { success: true, message: 'Folder "Old" moved to "Clients"' });
    assert.equal(w.log.copied.length, 1);
    assert.deepEqual(w.log.copied[0].slice(0, 2).map((f) => f.URI), [old.URI, clients.URI]);
    assert.deepEqual(w.log.copied[0].slice(2), [true, null, null], "moved, not copied");
  });

  it("names a folder by its display name, else its name, else the address it was given", () => {
    const { w, root, clients } = tree();
    const shown = w.make(`${ROOT_URI}/Shown`, { parent: root, name: "raw-name", display: "Shown name" });
    assert.match(w.api.moveFolder(shown.URI, clients.URI).message, /^Folder "Shown name" moved to "Clients"$/);
    const plainName = w.make(`${ROOT_URI}/Plain`, { parent: root, name: "Plain name", display: "" });
    assert.match(w.api.moveFolder(plainName.URI, clients.URI).message, /^Folder "Plain name" moved/);
    const nameless = w.make(`${ROOT_URI}/Nameless`, { parent: root, name: "", display: "" });
    assert.match(w.api.moveFolder(nameless.URI, clients.URI).message, /^Folder "mailbox:\/\/nobody@Local%20Folders\/Nameless" moved/);
    const unnamedParent = w.make(`${ROOT_URI}/UnnamedParent`, { parent: root, name: "", display: "" });
    const old = w.make(`${ROOT_URI}/Another`, { parent: root });
    assert.match(w.api.moveFolder(old.URI, unnamedParent.URI).message, /moved to "mailbox:\/\/nobody@Local%20Folders\/UnnamedParent"$/);
    const namedByName = w.make(`${ROOT_URI}/ByName`, { parent: root, name: "By name", display: "" });
    assert.match(w.api.moveFolder(old.URI, namedByName.URI).message, /moved to "By name"$/);
  });

  it("gives the failure of Thunderbird as text", () => {
    const failing = makeWorld({ copyFails: new Error("NS_ERROR_FAILURE") });
    const root = failing.make(ROOT_URI, { isServer: true });
    const a = failing.make(`${ROOT_URI}/A`, { parent: root });
    const b = failing.make(`${ROOT_URI}/B`, { parent: root });
    assert.deepEqual(plain(failing.api.moveFolder(a.URI, b.URI)), { error: "Error: NS_ERROR_FAILURE" });
  });
});
