"use strict";

// scripts/build-mcpb-reproducible.cjs: same input, same bytes; the bundle holds the bridge only and its
// extracted bridge runs and announces the version of package.json.

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const script = path.join(root, "scripts/build-mcpb-reproducible.cjs");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const bridgeVersion = /^const BRIDGE_VERSION = '([^']*)';$/m.exec(fs.readFileSync(path.join(root, "mcp-bridge.cjs"), "utf8"))[1];
const name = `commonpost-mcp-v${bridgeVersion}.mcpb`;
const newer = (a, b) => {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  const i = [0, 1, 2].find((k) => x[k] !== y[k]);
  return i !== undefined && x[i] > y[i];
};

function build(outDir) {
  return execFileSync(process.execPath, [script, "--from-tree"], {
    env: { ...process.env, COMMONPOST_OUT_DIR: outDir },
    encoding: "utf8",
  });
}

// Reads a zip (stored entries only) into [{ name, data, method }], in central directory order.
function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, "end of central directory missing");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const entryName = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    out.push({ name: entryName, method, data: buf.subarray(dataStart, dataStart + size) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

describe("reproducible .mcpb build", () => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "cp-mcpb-a-"));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "cp-mcpb-b-"));
  let entries;
  let manifest;

  before(() => {
    build(dirA);
    entries = readZip(fs.readFileSync(path.join(dirA, name)));
    manifest = JSON.parse(entries.find((e) => e.name === "manifest.json").data.toString("utf8"));
  });

  it("builds the release asset name, with a sha256 file", () => {
    assert.ok(fs.existsSync(path.join(dirA, `${name}.sha256`)));
    const line = fs.readFileSync(path.join(dirA, `${name}.sha256`), "utf8");
    assert.match(line.slice(0, 66), /^[0-9a-f]{64} {2}$/);
    assert.equal(line.slice(66), `${name}\n`);
  });

  it("gives identical bytes for two builds", () => {
    build(dirB);
    assert.deepEqual(fs.readFileSync(path.join(dirA, name)), fs.readFileSync(path.join(dirB, name)));
  });

  it("holds the five expected entries, sorted, stored, no hidden file", () => {
    const names = entries.map((e) => e.name);
    assert.deepEqual(names, ["LICENSE", "THIRD-PARTY.md", "icon.png", "manifest.json", "mcp-bridge.cjs"]);
    assert.deepEqual(names, [...names].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
    assert.ok(entries.every((e) => e.method === 0), "entries must be stored, not compressed");
    assert.ok(!names.some((n) => /(^|\/)\./.test(n)));
  });

  it("includes the bridge, licence and icon of the repository unchanged", () => {
    const get = (n) => entries.find((e) => e.name === n).data;
    assert.deepEqual(get("mcp-bridge.cjs"), fs.readFileSync(path.join(root, "mcp-bridge.cjs")));
    assert.deepEqual(get("LICENSE"), fs.readFileSync(path.join(root, "LICENSE")));
    assert.deepEqual(get("THIRD-PARTY.md"), fs.readFileSync(path.join(root, "THIRD-PARTY.md")));
    assert.deepEqual(get("icon.png"), fs.readFileSync(path.join(root, "extension/icons/icon-128.png")));
    assert.deepEqual(get("manifest.json"), fs.readFileSync(path.join(root, "mcpb/manifest.json")));
  });

  it("has a manifest with the bridge version, never newer than package.json", () => {
    assert.equal(manifest.manifest_version, "0.3");
    assert.equal(manifest.version, bridgeVersion);
    assert.ok(!newer(bridgeVersion, pkg.version), `${bridgeVersion} > ${pkg.version}`);
    assert.equal(manifest.server.type, "node");
    assert.equal(manifest.server.entry_point, "mcp-bridge.cjs");
    assert.deepEqual(manifest.server.mcp_config.args, ["${__dirname}/mcp-bridge.cjs"]);
  });

  it("tells the bridge it runs from the bundle, with a fixed value", () => {
    assert.deepEqual(manifest.server.mcp_config.env, { COMMONPOST_MCP_PACKAGING: "mcpb" });
  });

  it("links to the releases, the README section of the bundle and the issues", () => {
    assert.equal(manifest.homepage, "https://github.com/commonpost/thunderbird-mcp/releases/latest");
    assert.equal(manifest.documentation, "https://github.com/commonpost/thunderbird-mcp#claude-desktop-one-click-bundle");
    assert.equal(manifest.support, "https://github.com/commonpost/thunderbird-mcp/issues");
    const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
    assert.match(readme, /^### Claude Desktop \(one-click bundle\)$/m);
  });

  it("asks for the Node version of package.json engines and only macOS and Windows", () => {
    const min = /^>=(\d+)$/.exec(pkg.engines.node);
    assert.ok(min, "engines.node is expected to look like >=22");
    assert.equal(manifest.compatibility.runtimes.node, `>=${min[1]}.0.0`);
    assert.deepEqual(manifest.compatibility.platforms, ["darwin", "win32"]);
  });

  it("has no user_config", () => {
    assert.equal(manifest.user_config, undefined);
    assert.ok(!JSON.stringify(manifest).includes("user_config"));
  });

  it("refuses a version disagreement", () => {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), "cp-mcpb-bad-"));
    fs.mkdirSync(path.join(copy, "scripts"));
    fs.mkdirSync(path.join(copy, "mcpb"));
    fs.mkdirSync(path.join(copy, "extension/icons"), { recursive: true });
    for (const f of ["scripts/build-mcpb-reproducible.cjs", "scripts/mcpb-inputs.cjs", "scripts/zip-stored.cjs", "mcp-bridge.cjs", "LICENSE", "THIRD-PARTY.md", "extension/icons/icon-128.png"]) {
      fs.copyFileSync(path.join(root, f), path.join(copy, f));
    }
    fs.writeFileSync(path.join(copy, "package.json"), JSON.stringify({ version: pkg.version }));
    fs.writeFileSync(path.join(copy, "mcpb/manifest.json"), JSON.stringify({ ...manifest, version: "9.9.9" }));
    const r = spawnSync(process.execPath, [path.join(copy, "scripts/build-mcpb-reproducible.cjs"), "--from-tree", "--print-only"], { encoding: "utf8" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /must agree/);
  });

  it("refuses a bridge version newer than package.json", () => {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), "cp-mcpb-newer-"));
    fs.mkdirSync(path.join(copy, "scripts"));
    fs.mkdirSync(path.join(copy, "mcpb"));
    fs.mkdirSync(path.join(copy, "extension/icons"), { recursive: true });
    for (const f of ["scripts/build-mcpb-reproducible.cjs", "scripts/mcpb-inputs.cjs", "scripts/zip-stored.cjs", "LICENSE", "THIRD-PARTY.md", "extension/icons/icon-128.png"]) {
      fs.copyFileSync(path.join(root, f), path.join(copy, f));
    }
    const bridge = fs.readFileSync(path.join(root, "mcp-bridge.cjs"), "utf8").replace(/^const BRIDGE_VERSION = '[^']*';$/m, "const BRIDGE_VERSION = '999.0.0';");
    fs.writeFileSync(path.join(copy, "mcp-bridge.cjs"), bridge);
    fs.writeFileSync(path.join(copy, "package.json"), JSON.stringify({ version: pkg.version }));
    fs.writeFileSync(path.join(copy, "mcpb/manifest.json"), JSON.stringify({ ...manifest, version: "999.0.0" }));
    const r = spawnSync(process.execPath, [path.join(copy, "scripts/build-mcpb-reproducible.cjs"), "--from-tree", "--print-only"], { encoding: "utf8" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /must not be newer than package\.json/);
  });

  it("the extracted bridge starts and announces BRIDGE_VERSION", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-mcpb-run-"));
    for (const e of entries) fs.writeFileSync(path.join(dir, e.name), e.data);
    const request = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    });
    const r = spawnSync(process.execPath, [path.join(dir, "mcp-bridge.cjs")], {
      input: request + "\n",
      encoding: "utf8",
      timeout: 15000,
      env: { ...process.env, COMMONPOST_MCP_CONNECTION_FILE: path.join(dir, "no-such-connection.json") },
    });
    const line = r.stdout.split("\n").find((l) => l.includes('"serverInfo"'));
    assert.ok(line, `no initialize answer; stderr: ${r.stderr}`);
    const info = JSON.parse(line).result.serverInfo;
    assert.equal(info.version, bridgeVersion);
    assert.notEqual(info.version, "0.0.0");
  });
});
