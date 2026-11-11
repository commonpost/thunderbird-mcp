// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";

// Tags by the name the user sees: updateMessage turns "Important" into "$label1". Another keyword is still
// added, with a warning that Thunderbird does not show it and the list of known tags; what cannot be a
// keyword is refused with that list, and nothing changes then.

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
      { tagsToAdd: ["$label1", "$label4", "$label2", "projet-x"], tagsToRemove: [], unknown: [], unknownWarning: null });
  });

  it("lists each key once", () => {
    const r = plain(resolveMessageTags(["Important", "$label1"], ["Plus tard", "$label5"]));
    assert.deepEqual([r.tagsToAdd, r.tagsToRemove], [["$label1"], ["$label5"]]);
  });

  it("adds another keyword as it is, with a warning that lists the known tags", () => {
    const r = resolveMessageTags(["lab-x", "Important"], undefined);
    assert.deepEqual(plain(r.tagsToAdd), ["lab-x", "$label1"]);
    assert.equal(r.unknownWarning,
      "Not Thunderbird tags, added as keywords Thunderbird does not show: lab-x. Known tags: Important ($label1), "
      + "Travail ($label2), Personnel ($label3), À faire ($label4), Plus tard ($label5), Projet X (projet-x).");
  });

  it("removes a keyword that is on a message but not in the tag list, without a warning", () => {
    const r = plain(resolveMessageTags(undefined, ["Important", "Urgent"]));
    assert.deepEqual([r.tagsToRemove, r.unknownWarning], [["$label1", "Urgent"], null]);
  });

  it("refuses what cannot be a keyword, with the known tags, and empty or non-string entries", () => {
    assert.match(resolveMessageTags(["À faire bientôt"]).error,
      /^Unknown tag 'À faire bientôt'\. Known tags: Important \(\$label1\).*\. Nothing was changed\.$/);
    assert.match(resolveMessageTags(undefined, ["two words"]).error, /Unknown tag 'two words'/);
    assert.match(resolveMessageTags(undefined, ['a"b']).error, /Unknown tag/);
    assert.match(resolveMessageTags([""], undefined).error, /non-empty strings/);
    assert.match(resolveMessageTags([42], undefined).error, /non-empty strings/);
  });

  it("says so when Thunderbird has no tags at all", () => {
    assert.match(loadTagHelpers([]).resolveMessageTags(["Important"]).unknownWarning, /Known tags: none\.$/);
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

  it("a tag that cannot be a keyword changes nothing at all, read state included", () => {
    const { update, mutations } = harness();
    const r = update(["Important", "À faire bientôt"], undefined);
    assert.match(r.error, /Unknown tag 'À faire bientôt'.*À faire \(\$label4\)/);
    assert.deepEqual(mutations, []);
  });

  it("another keyword is added, and the result warns", () => {
    const { update, mutations } = harness();
    const r = update(["Urgent"], undefined);
    assert.equal(r.success, true, JSON.stringify(r));
    assert.deepEqual(mutations, [["read", true], ["addTags", "Urgent"]]);
    assert.match(r.warning, /^Not Thunderbird tags, added as keywords Thunderbird does not show: Urgent\. Known tags: /);
  });
});
