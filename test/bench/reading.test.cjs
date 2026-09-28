"use strict";
// Reading on a real Thunderbird: libmime decodes bodies and headers, search finds the fixtures.
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const { SKIP, mcp, closeAll, FOLDER } = require("./helpers.cjs");

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

  it("returns the HTML part of multipart/alternative as Markdown", { todo: "needs the web globals import (#13)" }, async () => {
    const msg = await mcp().call("getMessage", { messageId: "html-alt@eta.test", folderPath: FOLDER.inbox });
    assert.match(msg.body, /\*\*Q1\*\*/);
    assert.match(msg.body, /\[report\]\(https:\/\/example\.com\/q1\)/);
  });

  it("returns inline images as MCP image content", { todo: "needs the web globals import (#13)" }, async () => {
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
});
