// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";

// searchMessages with searchBody: true asks Thunderbird's Gloda full-text index and then keeps only the hits the
// caller may see. The real glodaBodySearch of api.js runs against a stand-in index.

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

function makeWorld({ folders = {}, encrypted = new Set(), encryptedAllowed = false, inaccessible = new Set(), trash = new Set(), cap = 100, searcherFails = false, finishFails = false } = {}) {
  const log = { searcher: null, rows: [], threadFields: [], folderAsks: [] };
  class GlodaMsgSearcher {
    constructor(listener, query) {
      if (searcherFails) throw new Error("Gloda is not ready");
      log.searcher = { listener, query };
      this.listener = listener;
    }
    getCollection() { log.collectionRequested = true; }
  }
  const sandbox = {
    GlodaMsgSearcher,
    SEARCH_COLLECTION_CAP: cap,
    getOwnEmails: () => new Set(["me@example.org"]),
    getAccessibleFolder(folderPath) {
      log.folderAsks.push(folderPath);
      const folder = folders[folderPath];
      return folder ? { folder } : { error: `Folder not found: ${folderPath}` };
    },
    isTrashOrJunkFolder: (folder, checkAncestors) => {
      assert.equal(checkAncestors, true);
      return trash.has(folder.URI);
    },
    isEncryptedContentAllowed: () => encryptedAllowed,
    isFolderAccessible: (folder) => !inaccessible.has(folder.URI),
    isRawMimeEnvelopeEncrypted: (msgHdr) => encrypted.has(msgHdr.id),
    buildSearchRow(msgHdr, folder, legacy) {
      const row = { id: msgHdr.id, folderPath: folder.URI, legacy };
      log.rows.push(row);
      return row;
    },
    addThreadGroupingFields(row, msgHdr, thread, ownEmails) {
      log.threadFields.push([row.id, thread, [...ownEmails]]);
    },
    finishSearch(rows, args, prepared, incomplete) {
      if (finishFails) throw new Error("sorting failed");
      return { rows: rows.map((r) => r.id), incomplete, query: args.query };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${functionSource("glodaBodySearch")}\nthis.glodaBodySearch = glodaBodySearch;`, sandbox);
  return { search: sandbox.glodaBodySearch, log };
}

const folder = (URI) => ({ URI });
const hit = (id, URI) => ({ folderMessage: { id, folder: folder(URI) } });
const prepared = (filter = () => true) => ({ passesHeaderFilters: filter });

describe("glodaBodySearch: the folder asked for", () => {
  it("returns the error of a folder the caller may not reach, without querying the index", () => {
    const w = makeWorld();
    const result = w.search({ folderPath: "imap://x/Nope", query: "invoice" }, prepared());
    assert.deepEqual(plain(result), { error: "Folder not found: imap://x/Nope" });
    assert.equal(w.log.searcher, null);
  });

  it("hands the query to the index and waits for its collection", async () => {
    const w = makeWorld();
    const pending = w.search({ query: "quarterly report" }, prepared());
    assert.equal(w.log.searcher.query, "quarterly report");
    assert.equal(w.log.collectionRequested, true);
    w.log.searcher.listener.onItemsAdded();
    w.log.searcher.listener.onItemsModified();
    w.log.searcher.listener.onItemsRemoved();
    w.log.searcher.listener.onQueryCompleted({ items: [hit("m1", "imap://x/INBOX")] });
    assert.deepEqual(plain(await pending), { rows: ["m1"], incomplete: false, query: "quarterly report" });
  });

  it("answers with the error text when the index cannot be started", async () => {
    const w = makeWorld({ searcherFails: true });
    assert.deepEqual(plain(await w.search({ query: "x" }, prepared())), { error: "Error: Gloda is not ready" });
  });
});

describe("glodaBodySearch: which hits are kept", () => {
  const INBOX = "imap://x/INBOX";
  const WORK = "imap://x/INBOX/Work";
  const TRASH = "imap://x/Trash";

  async function run(options, args, items, filter) {
    const w = makeWorld(options);
    const pending = w.search({ query: "q", ...args }, prepared(filter));
    w.log.searcher.listener.onQueryCompleted({ items });
    return { result: plain(await pending), w };
  }

  it("skips a hit whose message cannot be read, has no folder, or sits in a folder that is not accessible", async () => {
    const broken = { get folderMessage() { throw new Error("NS_ERROR_NOT_AVAILABLE"); } };
    const noMessage = { folderMessage: null };
    const noFolder = { folderMessage: { id: "m-nofolder", folder: null } };
    const { result } = await run({ inaccessible: new Set(["imap://other/INBOX"]) }, {}, [
      broken, noMessage, noFolder, hit("m-other", "imap://other/INBOX"), hit("m-ok", INBOX),
    ]);
    assert.deepEqual(result.rows, ["m-ok"]);
    assert.equal(result.incomplete, false);
  });

  it("leaves out an encrypted message unless reading encrypted content is allowed", async () => {
    const items = [hit("plain", INBOX), hit("secret", INBOX)];
    const refused = await run({ encrypted: new Set(["secret"]) }, {}, items);
    assert.deepEqual(refused.result.rows, ["plain"]);
    const allowed = await run({ encrypted: new Set(["secret"]), encryptedAllowed: true }, {}, items);
    assert.deepEqual(allowed.result.rows, ["plain", "secret"]);
  });

  it("with folderPath, keeps that folder and its subfolders only", async () => {
    const folders = { [INBOX]: folder(INBOX) };
    const { result } = await run({ folders }, { folderPath: INBOX }, [hit("a", INBOX), hit("b", WORK), hit("c", "imap://x/Archive")]);
    assert.deepEqual(result.rows, ["a", "b"]);
  });

  it("leaves out the Trash and Junk folders unless includeTrash is set or the folder named is itself one of them", async () => {
    const items = [hit("a", INBOX), hit("gone", TRASH)];
    const options = { trash: new Set([TRASH]) };
    assert.deepEqual((await run(options, {}, items)).result.rows, ["a"]);
    assert.deepEqual((await run(options, { includeTrash: true }, items)).result.rows, ["a", "gone"]);
    const inTrash = await run({ ...options, folders: { [TRASH]: folder(TRASH) } }, { folderPath: TRASH }, items);
    assert.deepEqual(inTrash.result.rows, ["gone"]);
  });

  it("applies the header filters of the search to every hit", async () => {
    const { result } = await run({}, {}, [hit("keep", INBOX), hit("drop", INBOX)], (msgHdr) => msgHdr.id === "keep");
    assert.deepEqual(result.rows, ["keep"]);
  });

  it("stops at the cap and says the result is incomplete", async () => {
    const items = ["a", "b", "c", "d"].map((id) => hit(id, INBOX));
    const { result } = await run({ cap: 3 }, {}, items);
    assert.deepEqual(result.rows, ["a", "b", "c"]);
    assert.equal(result.incomplete, true);
  });

  it("builds legacy rows when asked for the legacy format", async () => {
    const legacy = await run({}, { format: "legacy" }, [hit("a", INBOX)]);
    assert.equal(legacy.w.log.rows[0].legacy, true);
    const normal = await run({}, {}, [hit("a", INBOX)]);
    assert.equal(normal.w.log.rows[0].legacy, false);
    assert.deepEqual(normal.w.log.threadFields, []);
  });

  it("adds the thread fields, with the user's own addresses, when grouping by thread", async () => {
    const { w, result } = await run({}, { groupBy: "thread" }, [hit("a", INBOX), hit("b", INBOX)]);
    assert.deepEqual(result.rows, ["a", "b"]);
    assert.deepEqual(plain(w.log.threadFields), [["a", null, ["me@example.org"]], ["b", null, ["me@example.org"]]]);
  });

  it("answers with the error text when the result cannot be put together", async () => {
    const { result } = await run({ finishFails: true }, {}, [hit("a", INBOX)]);
    assert.deepEqual(result, { error: "Error: sorting failed" });
  });
});
