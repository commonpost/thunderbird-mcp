"use strict";
// Reading on a real Thunderbird: libmime decodes bodies and headers, search finds the fixtures.
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const { SKIP, mcp, tb, closeAll, FOLDER, unwrapUntrusted } = require("./helpers.cjs");

describe("reading", { skip: SKIP }, () => {
  after(closeAll);

  it("decodes UTF-8, windows-1251 and KOI8-R bodies and subjects", async () => {
    const cases = [
      ["charset-utf8@rho.test", "Отчет за март готов"],
      ["charset-cp1251@tau.test", "Здравствуйте, это письмо"],
      ["charset-koi8r@sigma.test", "Привет, это письмо"],
    ];
    for (const [messageId, text] of cases) {
      const msg = await mcp().call("getMessage", { messageId, folderPath: FOLDER.inbox, bodyFormat: "text" });
      assert.ok(msg.body.includes(text), `${messageId}: ${msg.body}`);
      assert.doesNotMatch(msg.subject, /=\?/, messageId);
    }
  });

  it("returns the HTML part of multipart/alternative as Markdown", async () => {
    const msg = await mcp().call("getMessage", { messageId: "html-alt@eta.test", folderPath: FOLDER.inbox });
    assert.match(msg.body, /\*\*Q1\*\*/);
    assert.match(msg.body, /\[report\]\(https:\/\/example\.com\/q1\)/);
  });

  it("returns inline images as MCP image content", async () => {
    const msg = await mcp().request("tools/call", {
      name: "getMessage",
      arguments: { messageId: "inline-image@phi.test", folderPath: FOLDER.inbox, includeInlineImages: true },
    });
    const images = msg.result.content.filter(c => c.type === "image");
    assert.equal(images.length, 1, msg.result.content[0].text);
    assert.equal(images[0].mimeType, "image/png");
    assert.ok(Buffer.from(images[0].data, "base64").subarray(1, 4).equals(Buffer.from("PNG")));
  });

  it("lists attachments", async () => {
    const msg = await mcp().call("getMessage", { messageId: "attachment@upsilon.test", folderPath: FOLDER.inbox });
    assert.ok(msg.attachments?.length >= 1, JSON.stringify(msg.attachments));
  });

  it("finds fixtures by subject and skips Trash by default", async () => {
    const res = await mcp().call("searchMessages", { query: "Project kickoff" });
    const rows = Array.isArray(res) ? res : res.messages;
    assert.ok(rows.some(m => m.id === "chain1@alpha.test" || m.messageId === "chain1@alpha.test"), JSON.stringify(res));
    assert.ok(rows.every(m => !String(m.folderPath).endsWith("/Trash")));
  });

  it("names folders as Thunderbird displays them (prettyName is localizedName since 141)", async () => {
    const expected = await tb(`
      const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
      const folder = MailServices.folderLookup.getFolderForURL(args.uri);
      return folder.localizedName ?? folder.prettyName;`, { uri: FOLDER.inbox });
    assert.equal(expected, "Inbox");
    const res = await mcp().call("searchMessages", { query: "Project kickoff", folderPath: FOLDER.inbox, format: "legacy" });
    const rows = Array.isArray(res) ? res : res.messages;
    assert.ok(rows.length > 0 && rows.every(m => m.folder === expected), JSON.stringify(rows));
    const folders = await mcp().call("listFolders", {});
    assert.equal(folders.find(f => f.path === FOLDER.inbox)?.name, expected);
  });

  it("getRecentMessages rows carry ccList like searchMessages rows", async () => {
    const recent = unwrapUntrusted(await mcp().call("getRecentMessages", { daysBack: 36500, folderPath: FOLDER.inbox, maxResults: 200 }));
    const found = unwrapUntrusted(await mcp().call("searchMessages", { query: "", folderPath: FOLDER.inbox, maxResults: 200 }));
    const row = recent.messages.find(m => m.id === "chain3@alpha.test");
    assert.equal(row?.ccList, "Bob Alpha <bob@alpha.test>", JSON.stringify(row));
    assert.deepEqual(row, found.messages.find(m => m.id === "chain3@alpha.test"));
  });

  it("format legacy returns the 0.8 output", async () => {
    const current = await mcp().call("searchMessages", { query: "Project kickoff" });
    const legacy = await mcp().call("searchMessages", { query: "Project kickoff", format: "legacy" });
    assert.ok(Array.isArray(legacy), JSON.stringify(legacy));
    assert.deepEqual(legacy.map(m => m.id), current.messages.map(m => m.id));
    for (const row of legacy) {
      assert.equal(typeof row.threadId, "number");
      assert.equal(typeof row.folder, "string");
      assert.equal(typeof row.flagged, "boolean");
      assert.ok(Array.isArray(row.tags));
    }
    const paged = await mcp().call("getRecentMessages", { daysBack: 36500, offset: 0, format: "legacy" });
    assert.equal(paged.limit, 50);
    assert.ok(Array.isArray(paged.messages) && paged.messages.length > 0);
    assert.equal(typeof paged.messages[0].folder, "string");
  });
});
