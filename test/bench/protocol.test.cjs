"use strict";
// MCP protocol through the bridge and the running extension: instructions, tool metadata, isError results.
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const { SKIP, mcp, closeAll, FOLDER } = require("./helpers.cjs");
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
});
