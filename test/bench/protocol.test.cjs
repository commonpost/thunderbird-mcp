"use strict";
// MCP protocol through the bridge and the running extension: instructions, tool metadata, isError results.
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const { SKIP, mcp, tbLib, closeAll, FOLDER } = require("./helpers.cjs");
const bridge = require("../../mcp-bridge.cjs");

describe("MCP protocol", { skip: SKIP }, () => {
  after(closeAll);

  it("returns the server instructions on initialize", async () => {
    const res = await mcp().request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "bench", version: "0" } });
    assert.equal(res.result.instructions, bridge.SERVER_INSTRUCTIONS);
  });

  it("lists tools with titles and explicit annotations", async () => {
    const { result } = await mcp().request("tools/list", {});
    const byName = Object.fromEntries(result.tools.map(t => [t.name, t]));
    assert.equal(byName.listAccounts.annotations.readOnlyHint, true);
    assert.equal(byName.deleteMessages.annotations.destructiveHint, true);
    assert.equal(byName.sendMail.annotations.openWorldHint, true);
    assert.equal(byName.sendMail.annotations.destructiveHint, true);
    assert.equal(byName.createFilter.annotations.destructiveHint, true);
    assert.equal(byName.getMessage.annotations.readOnlyHint, false);
    for (const t of result.tools) assert.ok(t.title && !t.group && !t.crud, t.name);
  });

  it("reports tool failures as isError results, not JSON-RPC errors", async () => {
    const missing = await mcp().request("tools/call", { name: "getMessage", arguments: { messageId: "nope@bench.test", folderPath: FOLDER.inbox } });
    assert.equal(missing.error, undefined);
    assert.equal(missing.result.isError, true);
    const invalid = await mcp().request("tools/call", { name: "getMessage", arguments: { folderPath: FOLDER.inbox } });
    assert.equal(invalid.result.isError, true);
    assert.match(invalid.result.content[0].text, /messageId/);
    const unknown = await mcp().request("tools/call", { name: "noSuchTool", arguments: {} });
    assert.equal(unknown.error.code, -32602);
  });

  it("removes hidden characters from contact text, counts them, and escapes them in the id", async () => {
    const uid = "bench-\u200Bhidden-contact";
    await tbLib(`
      const book = MailServices.ab.getDirectory("jsaddrbook://abook.sqlite");
      const card = Cc["@mozilla.org/addressbook/cardproperty;1"].createInstance(Ci.nsIAbCard);
      card.UID = args.uid;
      card.displayName = "Bench contact";
      card.firstName = "Hid\u200Bden\u202E";
      card.primaryEmail = "hidden@bench.test";
      book.addCard(card);
    `, { uid });
    try {
      const raw = await mcp().request("tools/call", { name: "searchContacts", arguments: { query: "hidden@bench.test" } });
      const [block, notice] = raw.result.content;
      // left in the id, but escaped in the text: visible, and the same id once parsed
      assert.doesNotMatch(block.text, /[\u200B\u202E]/);
      assert.ok(block.text.includes('"id":"bench-\\u200bhidden-contact"'), block.text);
      const [row] = JSON.parse(block.text);
      assert.equal(row.id, uid);
      assert.equal(row.firstName, "Hidden");
      // two in firstName, removed; one in the id, counted but left as it is
      assert.match(notice.text, /\b3 hidden or bidirectional-control character\(s\) were found/);
      const contact = await mcp().call("getContact", { contactId: row.id });
      assert.equal(contact.email, "hidden@bench.test", JSON.stringify(contact));
    } finally {
      await tbLib(`
        const book = MailServices.ab.getDirectory("jsaddrbook://abook.sqlite");
        const card = book.childCards.find(c => c.UID === args.uid);
        if (card) book.deleteCards([card]);
      `, { uid });
    }
  });
});
