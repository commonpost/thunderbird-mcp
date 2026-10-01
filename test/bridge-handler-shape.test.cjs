"use strict";

// The HTTP handler of api.js wires the bridge rules in the right order: the header is read after the token check, the
// security floor refuses before anything acts, the mode refusal comes after argument validation and before the tool
// runs, and the notice is added last. A source-shape test, like original-extension-notice.test.cjs: the handler
// itself needs Thunderbird.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");

function indexOfAfter(text, needle, from, label) {
  const index = text.indexOf(needle, from);
  assert.ok(index >= 0, `${label || needle} not found after position ${from}`);
  return index;
}

describe("bridge rules in the HTTP handler", () => {
  it("reads the header after the token check and after the request is parsed", () => {
    const token = indexOfAfter(source, "timingSafeEqual(reqToken", 0);
    const parsed = indexOfAfter(source, "const { id, method, params } = message;", token);
    indexOfAfter(source, "// BEGIN BRIDGE HEADER READ", parsed);
  });

  it("refuses by the floor before anything acts, and by mode after validation and before callTool", () => {
    const start = indexOfAfter(source, 'case "tools/call": {', 0);
    const end = indexOfAfter(source, "default:", start);
    const text = source.slice(start, end);
    const decision = indexOfAfter(text, "bridgeCompatDecision(", 0);
    assert.ok(decision < indexOfAfter(text, "isToolEnabled(params.name)", 0), "floor refusal before the enabled check");
    const validation = indexOfAfter(text, "validateToolArgs(", 0);
    const mode = indexOfAfter(text, "bridgeModeRefusal(", 0);
    assert.ok(mode > validation, "mode refusal after validateToolArgs");
    assert.ok(mode < indexOfAfter(text, "callTool(", 0), "mode refusal before callTool");
  });

  it("adds the notice after the switch, just before the result is written", () => {
    const start = indexOfAfter(source, 'case "tools/call": {', 0);
    const defaultCase = indexOfAfter(source, "default:", start);
    const notice = indexOfAfter(source, "appendBridgeNotice(", defaultCase);
    const write = indexOfAfter(source, 'res.write(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result }))', defaultCase);
    assert.ok(notice < write);
  });

  it("re-arms the notice on tools/list", () => {
    const start = indexOfAfter(source, 'case "tools/list":', 0);
    const end = indexOfAfter(source, 'case "tools/call"', start);
    assert.ok(source.slice(start, end).includes("armBridgeNotice(bridgeEntry"));
  });

  it("keeps the token check as the only 403", () => {
    assert.equal(source.split('setStatusLine("1.1", 403').length - 1, 1);
  });

  it("forgets the bridges on shutdown and exposes getBridgeStatus", () => {
    const shutdown = source.slice(indexOfAfter(source, "onShutdown(isAppShutdown) {", 0));
    assert.ok(shutdown.includes("globalThis.__cpMcpBridgesSeen = null"));
    assert.ok(source.includes("getBridgeStatus: async function()"));
  });
});
