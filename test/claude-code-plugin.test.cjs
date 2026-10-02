"use strict";

// The repository as a Claude Code plugin marketplace: the manifests at .claude-plugin/ and what they point to.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));

describe("Claude Code plugin", () => {
  const plugin = read(".claude-plugin/plugin.json");
  const marketplace = read(".claude-plugin/marketplace.json");
  const product = read("package.json").version;

  it("carries the product version, so that every release reaches plugin users", () => {
    assert.equal(plugin.version, product);
  });

  it("declares the bridge of this repository as the commonpost-mail server", () => {
    assert.deepEqual(Object.keys(plugin.mcpServers), ["commonpost-mail"]);
    const server = plugin.mcpServers["commonpost-mail"];
    assert.equal(server.command, "node");
    assert.deepEqual(server.args, ["${CLAUDE_PLUGIN_ROOT}/mcp-bridge.cjs"]);
    assert.ok(fs.existsSync(path.join(root, "mcp-bridge.cjs")));
  });

  it("is listed by the marketplace under the same name, from the repository root", () => {
    assert.equal(marketplace.name, "commonpost");
    assert.equal(marketplace.plugins.length, 1);
    assert.equal(marketplace.plugins[0].name, plugin.name);
    assert.equal(marketplace.plugins[0].source, ".");
    assert.equal(marketplace.plugins[0].version, undefined, "the version lives in plugin.json only");
  });

  it("has no bin/ directory and no CLAUDE.md at the root (plugin layout rules)", () => {
    assert.ok(!fs.existsSync(path.join(root, "bin")));
    assert.ok(!fs.existsSync(path.join(root, "CLAUDE.md")));
  });

  it("is named in the README and in the release page", () => {
    const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
    assert.ok(readme.includes("claude plugin install commonpost-mcp@commonpost"));
    assert.ok(readme.includes("mcp__plugin_commonpost-mcp_commonpost-mail__"));
    const notes = fs.readFileSync(path.join(root, "scripts/release-notes.cjs"), "utf8");
    assert.ok(notes.includes("/plugin marketplace update commonpost"));
  });
});
