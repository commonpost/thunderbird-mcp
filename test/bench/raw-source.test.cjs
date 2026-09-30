"use strict";
// R1: rawSource is decoded text; the body Thunderbird itself decodes (getMessage) appears in it unchanged.
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { SKIP, mcp, closeAll, FOLDER, unwrapUntrusted } = require("./helpers.cjs");

const CASES = [
  ["charset-utf8@rho.test", "utf-8", "Отчет за март готов"],
  ["charset-cp1251@tau.test", "windows-1251", "Здравствуйте, это письмо"],
  ["charset-koi8r@sigma.test", "koi8-r", "Привет, это письмо"],
];

describe("rawSource decoding (R1)", { skip: SKIP }, () => {
  after(() => closeAll());

  it("UTF-8, windows-1251 and KOI8-R sources are readable and name their charset", async () => {
    for (const [messageId, charset, text] of CASES) {
      const args = { messageId, folderPath: FOLDER.inbox };
      const raw = unwrapUntrusted(await mcp().call("getMessage", { ...args, rawSource: true }));
      const parsed = unwrapUntrusted(await mcp().call("getMessage", { ...args, bodyFormat: "text" }));
      assert.equal(raw.rawCharset, charset, messageId);
      assert.ok(raw.rawSource.includes(text), messageId);
      const lines = parsed.body.split("\n").map(l => l.trim()).filter(Boolean);
      assert.ok(lines.some(l => l.includes(text)), `${messageId}: ${parsed.body}`);
      for (const line of lines) assert.ok(raw.rawSource.includes(line), `${messageId}: ${line}`);
    }
  });

  it("rawEncoding base64 returns the stored bytes, in pages that decode on their own", async () => {
    const args = { messageId: "charset-cp1251@tau.test", folderPath: FOLDER.inbox, rawSource: true, rawEncoding: "base64" };
    const eml = fs.readFileSync(path.join(__dirname, "../fixtures/mail/Inbox/charset-cp1251.eml"));
    const body = eml.subarray(eml.indexOf("\n\n") + 2);
    const whole = unwrapUntrusted(await mcp().call("getMessage", args));
    assert.equal(whole.rawEncoding, "base64");
    assert.equal(whole.rawCharset, undefined);
    const bytes = Buffer.from(whole.rawSource, "base64");
    assert.ok(bytes.includes(body), "8-bit body bytes unchanged");
    const pages = [];
    for (let bodyOffset = 0; bodyOffset !== undefined;) {
      const page = unwrapUntrusted(await mcp().call("getMessage", { ...args, bodyOffset, maxBodyChars: 101 }));
      assert.equal(page.rawSource.length % 4, 0);
      pages.push(Buffer.from(page.rawSource, "base64"));
      bodyOffset = page.nextBodyOffset;
    }
    assert.ok(pages.length > 1);
    assert.ok(Buffer.concat(pages).equals(bytes));
    const [many] = unwrapUntrusted(await mcp().call("getMessages", { messages: [{ messageId: args.messageId, folderPath: args.folderPath }], rawSource: true, rawEncoding: "base64" })).messages;
    assert.ok(Buffer.from(many.rawSource, "base64").includes(body));
  });
});
