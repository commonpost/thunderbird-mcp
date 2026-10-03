"use strict";

// The repository as a Claude Code plugin marketplace: the manifests at .claude-plugin/ and what they point to.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));

describe("Claude Code plugin", () => {
  const plugin = read("plugins/claude-code/.claude-plugin/plugin.json");
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
    assert.ok(fs.readFileSync(path.join(root, "plugins/claude-code/mcp-bridge.cjs")).equals(fs.readFileSync(path.join(root, "mcp-bridge.cjs"))),
      "the plugin's bridge is a copy of the repository's");
  });

  it("is listed by the marketplace under the same name, from its own directory (no package.json there: Claude Code would install the repository's npm packages)", () => {
    assert.equal(marketplace.name, "commonpost");
    assert.equal(marketplace.plugins.length, 1);
    assert.equal(marketplace.plugins[0].name, plugin.name);
    assert.equal(marketplace.plugins[0].source, "./plugins/claude-code");
    assert.ok(!fs.existsSync(path.join(root, "plugins/claude-code/package.json")));
    assert.ok(!fs.existsSync(path.join(root, "plugins/claude-code/package-lock.json")));
    assert.equal(marketplace.plugins[0].version, undefined, "the version lives in plugin.json only");
  });

  it("has no bin/ directory and no CLAUDE.md in the plugin (plugin layout rules)", () => {
    assert.ok(!fs.existsSync(path.join(root, "plugins/claude-code/bin")));
    assert.ok(!fs.existsSync(path.join(root, "plugins/claude-code/CLAUDE.md")));
  });

  it("has what Anthropic's directory requires in the plugin folder: a README of 40 words or more and the license", () => {
    const readme = fs.readFileSync(path.join(root, "plugins/claude-code/README.md"), "utf8");
    const words = readme.replace(/```[\s\S]*?```/g, "").split(/\s+/).filter(Boolean).length;
    assert.ok(words >= 40, `${words} words`);
    // Listing icon: a square PNG, 512 to 2048 px, under 2 MB, at the default path the directory reads.
    const icon = fs.readFileSync(path.join(root, "plugins/claude-code/.claude-plugin/icon.png"));
    assert.ok(icon.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "PNG signature");
    const w = icon.readUInt32BE(16), h = icon.readUInt32BE(20);
    assert.equal(w, h, "square");
    assert.ok(w >= 512 && w <= 2048, `${w} px`);
    assert.ok(icon.length < 2 * 1024 * 1024);
    assert.ok(readme.includes("127.0.0.1") && readme.includes("connection.json"), "the README says where the bridge connects");
    assert.equal(fs.readFileSync(path.join(root, "plugins/claude-code/LICENSE"), "utf8"), fs.readFileSync(path.join(root, "LICENSE"), "utf8"));
    for (const f of fs.readdirSync(path.join(root, "plugins/claude-code"))) {
      const st = fs.statSync(path.join(root, "plugins/claude-code", f));
      assert.ok(!st.isSymbolicLink(), `${f} is a symbolic link`);
      if (st.isFile()) assert.ok(st.size < 256 * 1024, `${f} is ${st.size} bytes, over 256 KiB`);
    }
  });

  it("is named in the README and in the release page", () => {
    const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
    assert.ok(readme.includes("claude plugin install commonpost-mcp@commonpost"));
    assert.ok(readme.includes("mcp__plugin_commonpost-mcp_commonpost-mail__"));
    const notes = fs.readFileSync(path.join(root, "scripts/release-notes.cjs"), "utf8");
    assert.ok(notes.includes("/plugin marketplace update commonpost"));
  });
});
