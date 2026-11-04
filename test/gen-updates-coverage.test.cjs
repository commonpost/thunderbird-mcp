// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";

// scripts/gen-updates.js writes the update manifest of a release. Each case runs a byte-identical copy of the
// script in a throw-away tree, so that the extension manifest it reads can be made to lack what it needs, and
// checks the message it gives, not only that it fails.

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const HASH = "b".repeat(64);
const OK_ENV = { TAG: "v1.4.0", VER: "1.4.0", HASH, GITHUB_REPOSITORY: "commonpost/thunderbird-mcp" };
const trees = [];

after(() => {
  for (const dir of trees) fs.rmSync(dir, { recursive: true, force: true });
});

function makeTree(manifestText) {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "cp-gen-updates-"));
  trees.push(tree);
  fs.mkdirSync(path.join(tree, "scripts"));
  fs.copyFileSync(path.join(root, "scripts/gen-updates.js"), path.join(tree, "scripts/gen-updates.js"));
  if (manifestText !== null) {
    fs.mkdirSync(path.join(tree, "extension"));
    fs.writeFileSync(path.join(tree, "extension/manifest.json"), manifestText);
  }
  return tree;
}

const manifestWith = (gecko) => JSON.stringify({ version: "1.4.0", browser_specific_settings: gecko === undefined ? undefined : { gecko } });
const GECKO = { id: "x", strict_min_version: "140.0", strict_max_version: "999.*" };

// The environment of this process (Node options and the like), without the variables the script reads.
function inheritedEnv() {
  const inherited = { ...process.env };
  for (const name of Object.keys(OK_ENV)) delete inherited[name];
  return inherited;
}

function run(tree, env) {
  return spawnSync(process.execPath, [path.join(tree, "scripts/gen-updates.js")], {
    cwd: tree,
    encoding: "utf8",
    env: { ...inheritedEnv(), ...env },
  });
}

function failed(result, message) {
  assert.equal(result.status, 1, `expected a failure; stdout: ${result.stdout}`);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, `Error: ${message}\n`);
}

describe("gen-updates: what it reads from the environment", () => {
  for (const name of ["TAG", "VER", "HASH", "GITHUB_REPOSITORY"]) {
    it(`needs ${name}`, () => {
      const tree = makeTree(manifestWith(GECKO));
      failed(run(tree, { ...OK_ENV, [name]: "" }), `${name} is required`);
      const env = { ...OK_ENV };
      delete env[name];
      failed(run(tree, env), `${name} is required`);
    });
  }

  it("says what is wrong with each value", () => {
    const tree = makeTree(manifestWith(GECKO));
    failed(run(tree, { ...OK_ENV, GITHUB_REPOSITORY: "no-slash" }), "GITHUB_REPOSITORY must look like owner/repository");
    failed(run(tree, { ...OK_ENV, GITHUB_REPOSITORY: "a/b/c" }), "GITHUB_REPOSITORY must look like owner/repository");
    failed(run(tree, { ...OK_ENV, VER: "v1.4.0" }), 'VER must not start with "v"');
    failed(run(tree, { ...OK_ENV, VER: "1.4" }), "VER must match X.Y.Z, for example 0.7.3");
    failed(run(tree, { ...OK_ENV, VER: "1.4.0-rc1" }), "VER must match X.Y.Z, for example 0.7.3");
    failed(run(tree, { ...OK_ENV, TAG: "v1.4.1" }), 'TAG must equal "v" + VER; expected v1.4.0, got v1.4.1');
    failed(run(tree, { ...OK_ENV, TAG: "1.4.0" }), 'TAG must equal "v" + VER; expected v1.4.0, got 1.4.0');
    failed(run(tree, { ...OK_ENV, HASH: "B".repeat(64) }), "HASH must be a bare lowercase 64-character sha256 hex digest");
    failed(run(tree, { ...OK_ENV, HASH: "b".repeat(63) }), "HASH must be a bare lowercase 64-character sha256 hex digest");
    failed(run(tree, { ...OK_ENV, HASH: `sha256:${HASH}` }), "HASH must be a bare lowercase 64-character sha256 hex digest");
  });
});

describe("gen-updates: what it reads from the extension manifest", () => {
  it("writes the update entry with the Thunderbird versions of the manifest", () => {
    const tree = makeTree(manifestWith(GECKO));
    const result = run(tree, OK_ENV);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.endsWith("}\n"));
    const entry = JSON.parse(result.stdout).addons["commonpost-mcp@commonpost.github.io"].updates[0];
    assert.deepEqual(entry, {
      version: "1.4.0",
      update_link: "https://github.com/commonpost/thunderbird-mcp/releases/download/v1.4.0/commonpost-mcp-v1.4.0.xpi",
      update_hash: `sha256:${HASH}`,
      applications: { gecko: { strict_min_version: "140.0", strict_max_version: "999.*" } },
    });
  });

  it("fails when the manifest has no gecko settings", () => {
    failed(run(makeTree(manifestWith(undefined)), OK_ENV), "extension/manifest.json is missing browser_specific_settings.gecko");
    failed(run(makeTree(JSON.stringify({ browser_specific_settings: {} })), OK_ENV), "extension/manifest.json is missing browser_specific_settings.gecko");
  });

  it("fails when the minimum or the maximum Thunderbird version is missing or not text", () => {
    for (const min of [undefined, "", 140]) {
      failed(run(makeTree(manifestWith({ ...GECKO, strict_min_version: min })), OK_ENV), "extension/manifest.json is missing gecko.strict_min_version");
    }
    for (const max of [undefined, "", 999]) {
      failed(run(makeTree(manifestWith({ ...GECKO, strict_max_version: max })), OK_ENV), "extension/manifest.json is missing gecko.strict_max_version");
    }
  });

  it("fails with the reason when the manifest is absent or is not JSON", () => {
    const absent = run(makeTree(null), OK_ENV);
    assert.equal(absent.status, 1);
    assert.match(absent.stderr, /^Error: ENOENT: no such file or directory, open '.*extension\/manifest\.json'\n$/);
    const broken = run(makeTree("{ not json"), OK_ENV);
    assert.equal(broken.status, 1);
    assert.match(broken.stderr, /^Error: .*JSON/);
  });
});
