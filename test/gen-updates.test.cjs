"use strict";

// scripts/gen-updates.js: the update manifest points at this repository's release asset.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const script = path.resolve(__dirname, "../scripts/gen-updates.js");
const HASH = "a".repeat(64);

function run(env) {
  return spawnSync(process.execPath, [script], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
}

describe("gen-updates", () => {
  it("builds the release link from GITHUB_REPOSITORY and the tag", () => {
    const r = run({ TAG: "v0.8.0", VER: "0.8.0", HASH, GITHUB_REPOSITORY: "commonpost/thunderbird-mcp" });
    assert.equal(r.status, 0, r.stderr);
    const updates = JSON.parse(r.stdout);
    const entry = updates.addons["commonpost-mcp@commonpost.github.io"].updates[0];
    assert.equal(entry.version, "0.8.0");
    assert.equal(entry.update_hash, `sha256:${HASH}`);
    assert.equal(entry.applications.gecko.strict_min_version, "156.0");
    assert.equal(
      entry.update_link,
      "https://github.com/commonpost/thunderbird-mcp/releases/download/v0.8.0/commonpost-mcp-v0.8.0.xpi"
    );
  });

  it("follows a fork through GITHUB_REPOSITORY", () => {
    const r = run({ TAG: "v0.8.0", VER: "0.8.0", HASH, GITHUB_REPOSITORY: "someone/thunderbird-mcp" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(JSON.parse(r.stdout).addons["commonpost-mcp@commonpost.github.io"].updates[0].update_link,
      /^https:\/\/github\.com\/someone\/thunderbird-mcp\/releases\/download\/v0\.8\.0\//);
  });

  it("refuses a missing or malformed repository, tag, version or hash", () => {
    const ok = { TAG: "v0.8.0", VER: "0.8.0", HASH, GITHUB_REPOSITORY: "commonpost/thunderbird-mcp" };
    assert.notEqual(run({ ...ok, GITHUB_REPOSITORY: "" }).status, 0);
    assert.notEqual(run({ ...ok, GITHUB_REPOSITORY: "a/b/c" }).status, 0);
    assert.notEqual(run({ ...ok, GITHUB_REPOSITORY: "evil.example/x?y" }).status, 0);
    assert.notEqual(run({ ...ok, TAG: "v0.8.1" }).status, 0);
    assert.notEqual(run({ ...ok, VER: "v0.8.0" }).status, 0);
    assert.notEqual(run({ ...ok, HASH: "sha256:" + HASH }).status, 0);
  });
});
