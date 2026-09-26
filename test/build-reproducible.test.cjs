"use strict";

// scripts/build-xpi-reproducible.cjs: same input, same bytes; release files inside.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const script = path.join(root, "scripts/build-xpi-reproducible.cjs");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

function build(outDir, epoch = "1790000000") {
  const out = execFileSync(process.execPath, [script, "--from-tree"], {
    env: { ...process.env, COMMONPOST_COMMIT: COMMIT, SOURCE_DATE_EPOCH: epoch, COMMONPOST_OUT_DIR: outDir },
    encoding: "utf8",
  });
  return out;
}

function zipEntries(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, "end of central directory missing");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    assert.equal(buf.readUInt16LE(p + 10), 0, "entries must be stored, not compressed");
    names.push(buf.subarray(p + 46, p + 46 + nameLen).toString("utf8"));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

describe("reproducible XPI build", () => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "cp-xpi-a-"));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "cp-xpi-b-"));
  const name = `commonpost-mcp-v${pkg.version}.xpi`;

  it("builds the release asset name, with a sha256 file", () => {
    const out = build(dirA);
    assert.match(out, new RegExp(`^[0-9a-f]{64}  ${name.replace(/\./g, "\\.")}`));
    assert.ok(fs.existsSync(path.join(dirA, name)));
    assert.ok(fs.existsSync(path.join(dirA, `${name}.sha256`)));
  });

  it("gives identical bytes for two builds", () => {
    build(dirB);
    assert.deepEqual(fs.readFileSync(path.join(dirA, name)), fs.readFileSync(path.join(dirB, name)));
  });

  it("changes only through the commit time (buildinfo.json)", () => {
    const dirC = fs.mkdtempSync(path.join(os.tmpdir(), "cp-xpi-c-"));
    build(dirC, "1790000001");
    assert.notDeepEqual(fs.readFileSync(path.join(dirA, name)), fs.readFileSync(path.join(dirC, name)));
  });

  it("holds sorted entries, LICENSE and THIRD-PARTY.md, no dotfiles", () => {
    const names = zipEntries(fs.readFileSync(path.join(dirA, name)));
    for (const required of ["manifest.json", "buildinfo.json", "LICENSE", "THIRD-PARTY.md", "httpd.sys.mjs"]) {
      assert.ok(names.includes(required), `${required} missing from the XPI`);
    }
    const sorted = [...names].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    assert.deepEqual(names, sorted);
    assert.ok(!names.some((n) => /(^|\/)\./.test(n)));
  });

  it("keeps manifest and package.json versions in step, with the update channel set", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "extension/manifest.json"), "utf8"));
    assert.equal(manifest.version, pkg.version);
    assert.equal(manifest.browser_specific_settings.gecko.id, "commonpost-mcp@commonpost.github.io");
    assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, "156.0");
    assert.equal(pkg.engines.node, ">=22");
    assert.equal(
      manifest.browser_specific_settings.gecko.update_url,
      "https://commonpost.github.io/thunderbird-mcp/updates.json"
    );
  });
});
