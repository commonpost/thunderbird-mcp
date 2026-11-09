// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";

// The repository as a Gemini CLI extension: gemini-extension.json at the root of the release archive.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));

describe("Gemini CLI extension", () => {
  const manifest = read("gemini-extension.json");

  it("carries the product version", () => {
    assert.equal(manifest.version, read("package.json").version);
  });

  it("has a name the Gemini CLI accepts and a description for its gallery", () => {
    assert.match(manifest.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(manifest.description.length > 0);
  });

  it("starts the bridge at the root of the extension, on every platform", () => {
    const servers = Object.values(manifest.mcpServers);
    assert.equal(servers.length, 1);
    assert.deepEqual(servers[0], { command: "node", args: ["${extensionPath}${/}mcp-bridge.cjs"] });
    assert.ok(fs.existsSync(path.join(root, "mcp-bridge.cjs")));
  });
});
