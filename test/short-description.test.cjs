// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";

// The project's short description: one line, in three places that must agree, short enough for the MCP registry.
// Without this test the mismatch only shows up after the tag, in the registry publication of a release that is
// already out: v0.20.1 was refused with `422 ... expected length <= 100 ... body.description` for a line of 104.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const readFile = (p) => fs.readFileSync(path.join(root, p), "utf8");

// The official registry schema (ServerDetail.description, maxLength 100) and the Standard Readme convention
// (under 120 characters, on its own line, matching the package manager's description and GitHub's).
const REGISTRY_MAX = 100;

describe("short description", () => {
  const description = JSON.parse(readFile("package.json")).description;

  it(`fits the ${REGISTRY_MAX} characters the MCP registry accepts`, () => {
    assert.ok(description.length >= 1 && description.length <= REGISTRY_MAX,
      `package.json description is ${description.length} characters; the registry refuses the publication above ${REGISTRY_MAX}`);
  });

  it("is a line of its own in the README, right after the badges", () => {
    const lines = readFile("README.md").split("\n");
    const at = lines.indexOf(description);
    assert.ok(at !== -1, "the README has no line equal to the description of package.json");
    assert.equal(lines.indexOf(description, at + 1), -1, "the README repeats the short description");
    assert.ok(lines[at - 1] === "" && lines[at + 1] === "", "the short description shares its line with something else");
  });

  it("is the description published to the MCP registry", () => {
    const quoted = readFile(".github/workflows/mcp-registry.yml")
      .split("\n")
      .map((line) => /^\s*description: "(.*)",$/.exec(line))
      .filter(Boolean);
    assert.equal(quoted.length, 1, "the registry workflow no longer has exactly one quoted description");
    assert.equal(quoted[0][1], description);
  });

  it("names the three systems, which is why directories and search engines read it", () => {
    for (const system of ["Windows", "macOS", "Linux"]) assert.match(description, new RegExp(system));
  });
});
