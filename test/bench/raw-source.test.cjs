"use strict";
// R1: rawSource is decoded text; the body Thunderbird itself decodes (getMessage) appears in it unchanged.
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const { SKIP, mcp, closeAll, FOLDER } = require("./helpers.cjs");

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
      const raw = await mcp().call("getMessage", { ...args, rawSource: true });
      const parsed = await mcp().call("getMessage", { ...args, bodyFormat: "text" });
      assert.equal(raw.rawCharset, charset, messageId);
      assert.ok(raw.rawSource.includes(text), messageId);
      const lines = parsed.body.split("\n").map(l => l.trim()).filter(Boolean);
      assert.ok(lines.some(l => l.includes(text)), `${messageId}: ${parsed.body}`);
      for (const line of lines) assert.ok(raw.rawSource.includes(line), `${messageId}: ${line}`);
    }
  });
});
