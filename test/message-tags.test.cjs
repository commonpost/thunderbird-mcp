// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";

// Tags by the name the user sees: updateMessage turns "Important" into "$label1", refuses a tag
// Thunderbird does not know (it would not show) with the list of known tags, and changes nothing then.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadTagHelpers } = require("./support/message-tags.cjs");

const FRENCH_TAGS = [
  { key: "$label1", tag: "Important" }, { key: "$label2", tag: "Travail" }, { key: "$label3", tag: "Personnel" },
  { key: "$label4", tag: "À faire" }, { key: "$label5", tag: "Plus tard" }, { key: "projet-x", tag: "Projet X" },
];

describe("resolveMessageTags", () => {
  const { resolveMessageTags } = loadTagHelpers(FRENCH_TAGS);
  const plain = (v) => JSON.parse(JSON.stringify(v));

  it("turns labels into keys, any case, and keeps keys as they are", () => {
    assert.deepEqual(plain(resolveMessageTags(["Important", "à FAIRE", "$label2", "Projet X"], undefined)),
      { tagsToAdd: ["$label1", "$label4", "$label2", "projet-x"], tagsToRemove: [] });
  });

  it("lists each key once", () => {
    assert.deepEqual(plain(resolveMessageTags(["Important", "$label1"], ["Plus tard", "$label5"])),
      { tagsToAdd: ["$label1"], tagsToRemove: ["$label5"] });
  });

  it("refuses a tag to add that Thunderbird does not know, with the known tags", () => {
    const r = resolveMessageTags(["Urgent"], undefined);
    assert.match(r.error, /^Unknown tag 'Urgent'\. Known tags: Important \(\$label1\), Travail \(\$label2\)/);
    assert.match(r.error, /Nothing was changed/);
    assert.match(r.error, /Settings > General > Tags/);
  });

  it("removes a keyword that is on a message but not in the tag list", () => {
    assert.deepEqual(plain(resolveMessageTags(undefined, ["Important", "Urgent"])),
      { tagsToAdd: [], tagsToRemove: ["$label1", "Urgent"] });
  });

  it("refuses what cannot be a keyword, and empty or non-string entries", () => {
    assert.match(resolveMessageTags(undefined, ["two words"]).error, /Unknown tag 'two words'/);
    assert.match(resolveMessageTags(undefined, ['a"b']).error, /Unknown tag/);
    assert.match(resolveMessageTags([""], undefined).error, /non-empty strings/);
    assert.match(resolveMessageTags([42], undefined).error, /non-empty strings/);
  });

  it("says so when Thunderbird has no tags at all", () => {
    assert.match(loadTagHelpers([]).resolveMessageTags(["Important"]).error, /Known tags: none/);
  });
});

describe("updateMessage with tags by name", () => {
  function harness() {
    const source = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");
    const start = source.indexOf("function updateMessage(");
    const end = source.indexOf("\n            function createFolder(", start);
    assert.ok(start >= 0 && end > start, "updateMessage markers missing");
    const hdr = { messageId: "m1@lab.test" };
    const mutations = [];
    const folder = {
      markMessagesRead: (_h, v) => mutations.push(["read", v]),
      markMessagesFlagged: (_h, v) => mutations.push(["flagged", v]),
      addKeywordsToMessages: (_h, k) => mutations.push(["addTags", k]),
      removeKeywordsFromMessages: (_h, k) => mutations.push(["removeTags", k]),
    };
    const db = { getMsgHdrForMessageID: (id) => (id === hdr.messageId ? hdr : null), enumerateMessages: () => [] };
    const sandbox = {
      Ci: { nsMsgFolderFlags: {} }, arrivalResendCheck: () => null, someUnread: () => true,
      resolveMessageTags: loadTagHelpers(FRENCH_TAGS).resolveMessageTags,
      openFolder: () => ({ folder, db }), findTrashFolder: () => null, getAccessibleFolder: () => ({ error: "none" }),
      MailServices: { accounts: { allIdentities: [] }, copy: { copyMessages() {} } },
    };
    vm.createContext(sandbox);
    vm.runInContext(`${source.slice(start, end)}\nthis.updateMessage = updateMessage;`, sandbox);
    return { mutations, update: (add, remove) => sandbox.updateMessage("m1@lab.test", undefined, "mailbox://x/Inbox", true, undefined, add, remove) };
  }

  it("writes the keys of the labels and reports them", () => {
    const { update, mutations } = harness();
    const r = update(["Important", "À faire"], ["Plus tard"]);
    assert.equal(r.success, true, JSON.stringify(r));
    assert.deepEqual(mutations, [["read", true], ["addTags", "$label1 $label4"], ["removeTags", "$label5"]]);
    assert.deepEqual(JSON.parse(JSON.stringify(r.actions)).filter(a => a.type !== "read"),
      [{ type: "addTags", value: ["$label1", "$label4"] }, { type: "removeTags", value: ["$label5"] }]);
  });

  it("an unknown tag changes nothing at all, read state included", () => {
    const { update, mutations } = harness();
    const r = update(["Important", "Urgent"], undefined);
    assert.match(r.error, /Unknown tag 'Urgent'.*À faire \(\$label4\)/);
    assert.deepEqual(mutations, []);
  });
});
