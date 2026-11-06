// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";

// The repository as a Claude Code plugin marketplace: the manifests at .claude-plugin/ and what they point to.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));
const numbers = (v) => v.split(".").map(Number);
const notLater = (a, b) => {
  const [x, y] = [numbers(a), numbers(b)];
  const i = x.findIndex((n, k) => n !== y[k]);
  return i === -1 || x[i] < y[i];
};

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
    assert.equal(marketplace.plugins[0].source.path, "plugins/claude-code");
    assert.ok(!fs.existsSync(path.join(root, "plugins/claude-code/package.json")));
    assert.ok(!fs.existsSync(path.join(root, "plugins/claude-code/package-lock.json")));
    assert.equal(marketplace.plugins[0].version, undefined, "the version lives in plugin.json only");
    assert.equal(marketplace.plugins[0].displayName, plugin.displayName, "shown before install, when plugin.json is not read yet");
  });

  it("points the plugin at a published release, by its tag and its commit, over https", () => {
    const source = marketplace.plugins[0].source;
    assert.equal(source.source, "git-subdir");
    // An owner/repo shorthand is cloned over SSH (git@github.com), which fails without a GitHub SSH key.
    assert.equal(source.url, "https://github.com/commonpost/thunderbird-mcp.git");
    assert.match(source.ref, /^v\d+\.\d+\.\d+$/);
    assert.match(source.sha, /^[0-9a-f]{40}$/);
    // The release tool moves the pin once a release is published, so between a version bump and that move it
    // names the previous release.
    const pinned = source.ref.slice(1);
    assert.ok(notLater(pinned, product), `${source.ref} is later than ${product}`);
    const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
    assert.ok(changelog.includes(`\n## [${pinned}] - `), `${pinned} is a released version`);
    // With the tags at hand (a shallow CI checkout has none), the commit is the tag's.
    const tag = spawnSync("git", ["-C", root, "rev-parse", "--verify", "--quiet", `refs/tags/${source.ref}^{commit}`], { encoding: "utf8" });
    if (tag.status === 0) assert.equal(tag.stdout.trim(), source.sha);
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

  it("carries the thunderbird-mail skill, whose frontmatter Claude Code reads and whose tool names exist", () => {
    const text = fs.readFileSync(path.join(root, "plugins/claude-code/skills/thunderbird-mail/SKILL.md"), "utf8");
    assert.ok(text.startsWith("---\n"), "the frontmatter opens on the first line");
    const end = text.indexOf("\n---\n", 4);
    assert.ok(end > 0, "the frontmatter is closed");
    const fields = Object.fromEntries(text.slice(4, end).split("\n").map((l) => {
      const i = l.indexOf(": ");
      return [l.slice(0, i), l.slice(i + 2)];
    }));
    assert.equal(fields.name, "thunderbird-mail");
    assert.ok(fields.description && fields.description.length <= 1536, "a description within the listing's limit");
    assert.ok(!/: /.test(fields.description), "no ': ' in the plain YAML scalar");
    // Every camelCase name in backquotes is a tool, a parameter of one, or a result field a description names, as
    // the tools/list snapshot has them: the skill cannot drift from the tools.
    const snapshot = read("test/fixtures/tools-list.snapshot.json").tools;
    const tools = new Set(snapshot.map((t) => t.name));
    const params = new Set(snapshot.flatMap((t) => Object.keys(t.inputSchema.properties || {})));
    const described = JSON.stringify(snapshot.map((t) => [t.description, t.inputSchema]));
    const named = [...new Set([...text.matchAll(/`([a-z]+[A-Z][A-Za-z]*)`/g)].map((m) => m[1]))];
    assert.ok(named.filter((n) => tools.has(n)).length >= 15, "the skill names the tools it is about");
    for (const name of named) {
      assert.ok(tools.has(name) || params.has(name) || new RegExp(`\\b${name}\\b`).test(described), `${name} is unknown to the tools`);
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
