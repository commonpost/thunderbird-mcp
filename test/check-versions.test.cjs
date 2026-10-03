"use strict";

// scripts/check-versions.cjs against throw-away git repositories (never the real one): the product version, the bridge
// version and its rule against the previous release tag, the thresholds and the announcement of an armed floor.

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const { previousReleaseTag } = require("../scripts/check-versions.cjs");

const GIT = ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "tag.gpgSign=false"];
const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function files(o) {
  const { V, B, M = B, A = B, MODE = A, C = B, F = "0.0.0", body = "// body 1\n", lockV = V, extV = V, mcpbV = B } = o;
  return {
    "package.json": JSON.stringify({ version: V }),
    "package-lock.json": JSON.stringify({ version: lockV, packages: { "": { version: lockV } } }),
    "extension/manifest.json": JSON.stringify({ version: extV }),
    "mcpb/manifest.json": `{\n  "version": "${mcpbV}"\n}\n`,
    "mcp-bridge.cjs": `const BRIDGE_VERSION = '${B}';\nconst MIN_EXTENSION_VERSION = '${M}';\n${body}`,
    "extension/mcp_server/api.js": `const MIN_BRIDGE_VERSION = "${A}";\nconst MODE_MIN_BRIDGE_VERSION = "${MODE}";\nconst BRIDGE_SECURITY_FLOOR = "${F}";\n${C === null ? "" : `const CURRENT_BRIDGE_VERSION = "${C}";\n`}`,
    "CHANGELOG.md": o.changelog || "# Changelog\n\n## [Unreleased]\n",
    "LICENSE": o.license || "license 1\n",
    "THIRD-PARTY.md": "third party\n",
    "extension/icons/icon-128.png": "png",
    "scripts/mcpb-inputs.cjs": fs.readFileSync(path.join(root, "scripts/mcpb-inputs.cjs")),
    "scripts/check-versions.cjs": fs.readFileSync(path.join(root, "scripts/check-versions.cjs")),
    "scripts/build-mcpb-reproducible.cjs": o.builder || "// builder\n",
    "scripts/zip-stored.cjs": o.zip || "// builder\n",
  };
}

// base: the state of the previous release (tagged with `tags`); current: the state being checked.
function makeRepo(base, tags, current, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-check-versions-"));
  tmpDirs.push(dir);
  const git = (...args) => {
    const r = spawnSync("git", [...GIT, "-C", dir, ...args], { encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  };
  const write = (state) => {
    for (const [p, data] of Object.entries(state)) {
      fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
      fs.writeFileSync(path.join(dir, p), data);
    }
  };
  git("init", "-q", "-b", "main");
  const baseFiles = opts.baseFiles ? opts.baseFiles : files(base);
  write(baseFiles);
  for (const p of opts.baseRemove || []) fs.rmSync(path.join(dir, p));
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  for (const t of tags) git("tag", t);
  write(files(current));
  git("add", "-A");
  git("commit", "-q", "-m", "current", "--allow-empty");
  if (opts.tagCurrent) git("tag", opts.tagCurrent);
  return dir;
}

function run(dir, ...args) {
  const r = spawnSync(process.execPath, [path.join(dir, "scripts/check-versions.cjs"), ...args], { encoding: "utf8" });
  return { status: r.status, out: r.stdout + r.stderr };
}

const PREV = { V: "0.11.0", B: "0.10.0" };

describe("check-versions.cjs", () => {
  it("1. between releases, finds the highest tag by number and keeps the bridge version", () => {
    const dir = makeRepo(PREV, ["v0.8.3", "v0.11.0"], PREV);
    const r = run(dir);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /since v0\.11\.0/);
    assert.match(r.out, /bridge bundle unchanged/);
  });

  it("2. fails without any release tag", () => {
    const dir = makeRepo(PREV, [], PREV);
    const r = run(dir);
    assert.equal(r.status, 1);
    assert.match(r.out, /fetch the tags/);
  });

  it("3. refuses a new bridge version when the bundle is unchanged", () => {
    const dir = makeRepo({ V: "0.10.0", B: "0.10.0" }, ["v0.10.0"], { V: "0.11.0", B: "0.11.0", M: "0.10.0", A: "0.10.0" });
    const r = run(dir);
    assert.equal(r.status, 1);
    assert.match(r.out, /keep 0\.10\.0/);
  });

  it("4. a changed bridge keeps the previous number between releases; thresholds are checked later", () => {
    const dir = makeRepo(PREV, ["v0.11.0"], { ...PREV, body: "// body 2\n", M: "0.12.0", A: "0.12.0" });
    const r = run(dir);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /thresholds checked in the release pull request/);
  });

  it("5. a changed bridge with the bridge version already raised, between releases, is refused", () => {
    const dir = makeRepo(PREV, ["v0.11.0"], { V: "0.11.0", B: "0.11.0", body: "// body 2\n" });
    const r = run(dir);
    assert.equal(r.status, 1);
    assert.match(r.out, /must stay/);
  });

  it("6. in a release pull request, a changed bridge sets BRIDGE_VERSION to the new version", () => {
    const ok = makeRepo(PREV, ["v0.11.0"], { V: "0.12.0", B: "0.12.0", body: "// body 2\n" });
    const r = run(ok);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /bridge bundle changed since v0\.11\.0/);
    const bad = makeRepo(PREV, ["v0.11.0"], { V: "0.12.0", B: "0.10.0", body: "// body 2\n" });
    const r2 = run(bad);
    assert.equal(r2.status, 1);
    assert.match(r2.out, /set BRIDGE_VERSION/);
  });

  it("7. a change of LICENSE or of a builder script counts as a change of the bridge bundle", () => {
    for (const change of [{ license: "license 2\n" }, { zip: "// builder 2\n" }]) {
      const ok = makeRepo(PREV, ["v0.11.0"], { V: "0.12.0", B: "0.12.0", ...change });
      assert.equal(run(ok).status, 0, JSON.stringify(change));
      const bad = makeRepo(PREV, ["v0.11.0"], { V: "0.12.0", B: "0.10.0", ...change });
      const r = run(bad);
      assert.equal(r.status, 1, JSON.stringify(change));
      assert.match(r.out, /set BRIDGE_VERSION/);
    }
  });

  it("8. an old previous release without the .mcpb manifest or BRIDGE_VERSION counts as changed", () => {
    const old = files({ V: "0.10.0", B: "0.10.0" });
    old["mcp-bridge.cjs"] = "// old bridge\n";
    const dir = makeRepo(null, ["v0.10.0"], { V: "0.10.0", B: "0.10.0" }, { baseFiles: old, baseRemove: ["mcpb/manifest.json"] });
    const r = run(dir);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /bridge bundle changed since v0\.10\.0/);
  });

  it("9. --release-tag: the tag itself is not the previous release, and must be the version", () => {
    const state = { V: "0.11.0", B: "0.11.0", body: "// body 2\n" };
    const dir = makeRepo({ V: "0.10.0", B: "0.10.0" }, ["v0.10.0"], state, { tagCurrent: "v0.11.0" });
    const r = run(dir, "--release-tag", "v0.11.0");
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /since v0\.10\.0/);
    const r2 = run(dir, "--release-tag", "v0.12.0");
    assert.equal(r2.status, 1);
    assert.match(r2.out, /must be v0\.11\.0/);
  });

  it("10. refuses disagreeing versions", () => {
    const check = (current, pattern) => {
      const r = run(makeRepo(PREV, ["v0.11.0"], { ...PREV, ...current }));
      assert.equal(r.status, 1, JSON.stringify(current));
      assert.match(r.out, pattern);
    };
    check({ lockV: "0.11.1" }, /package-lock\.json/);
    check({ extV: "0.11.1" }, /extension\/manifest\.json/);
    check({ mcpbV: "0.9.0" }, /mcpb\/manifest\.json/);
    check({ B: "0.11.1" }, /must not be newer/);
    check({ V: "0.10.5", B: "0.10.0" }, /older than the previous release/);
  });

  it("11. an armed security floor must be announced in the CHANGELOG, and be at most MIN_BRIDGE_VERSION", () => {
    const armed = { V: "0.12.0", B: "0.12.0", body: "// body 2\n", F: "0.12.0" };
    const without = run(makeRepo(PREV, ["v0.11.0"], armed));
    assert.equal(without.status, 1);
    assert.match(without.out, /security floor/);
    const changelog = "# Changelog\n\n## [Unreleased]\n\nBridge security floor raised to 0.12.0.\n";
    assert.equal(run(makeRepo(PREV, ["v0.11.0"], { ...armed, changelog })).status, 0);
    const above = run(makeRepo(PREV, ["v0.11.0"], { ...armed, changelog, A: "0.11.0", M: "0.11.0" }));
    assert.equal(above.status, 1);
    assert.match(above.out, /must be 0\.0\.0 or at most MIN_BRIDGE_VERSION/);
  });

  it("12. once the bridge version is final, the thresholds are at most BRIDGE_VERSION", () => {
    // The add-on thresholds (api.js) are not part of the bridge bundle: unchanged bundle, final bridge version.
    for (const current of [{ A: "0.12.0" }, { MODE: "0.12.0" }]) {
      const r = run(makeRepo(PREV, ["v0.11.0"], { ...PREV, M: "0.10.0", A: "0.10.0", MODE: "0.10.0", ...current }));
      assert.equal(r.status, 1, JSON.stringify(current));
      assert.match(r.out, /must be at most BRIDGE_VERSION/);
    }
    // MIN_EXTENSION_VERSION lives in mcp-bridge.cjs: it can only change with the bundle, in the release pull request.
    const r = run(makeRepo(PREV, ["v0.11.0"], { V: "0.12.0", B: "0.12.0", body: "// body 2\n", M: "0.13.0" }));
    assert.equal(r.status, 1);
    assert.match(r.out, /must be at most BRIDGE_VERSION/);
  });

  it("14. CURRENT_BRIDGE_VERSION must exist and equal BRIDGE_VERSION", () => {
    const missing = run(makeRepo(PREV, ["v0.11.0"], { ...PREV, C: null }));
    assert.equal(missing.status, 1);
    assert.match(missing.out, /needs const CURRENT_BRIDGE_VERSION = "X\.Y\.Z"/);
    const differs = run(makeRepo(PREV, ["v0.11.0"], { ...PREV, C: "0.11.0" }));
    assert.equal(differs.status, 1);
    assert.match(differs.out, /CURRENT_BRIDGE_VERSION 0\.11\.0 .* must equal BRIDGE_VERSION 0\.10\.0/);
    assert.equal(run(makeRepo(PREV, ["v0.11.0"], { ...PREV })).status, 0);
  });

  it("15. previousReleaseTag compares tags number by number", () => {
    const tags = ["v0.8.3", "v0.11.0", "v0.10.1", "v1.0.0-rc.1", "x"];
    assert.equal(previousReleaseTag(tags, null), "v0.11.0");
    assert.equal(previousReleaseTag(tags, "v0.11.0"), "v0.10.1");
  });

  it("plugin: plugins/claude-code must carry the product version and a copy of the bridge when it exists", () => {
    const dir = makeRepo(PREV, ["v0.11.0"], PREV);
    fs.mkdirSync(path.join(dir, "plugins/claude-code/.claude-plugin"), { recursive: true });
    fs.copyFileSync(path.join(dir, "mcp-bridge.cjs"), path.join(dir, "plugins/claude-code/mcp-bridge.cjs"));
    fs.writeFileSync(path.join(dir, "plugins/claude-code/.claude-plugin/plugin.json"), JSON.stringify({ name: "x", version: "0.10.0" }));
    let r = run(dir);
    assert.equal(r.status, 1);
    assert.match(r.out, /plugin\.json version 0\.10\.0 must equal package\.json 0\.11\.0/);
    fs.writeFileSync(path.join(dir, "plugins/claude-code/.claude-plugin/plugin.json"), JSON.stringify({ name: "x", version: "0.11.0" }));
    r = run(dir);
    assert.equal(r.status, 0, r.out);
    fs.appendFileSync(path.join(dir, "plugins/claude-code/mcp-bridge.cjs"), "// drift\n");
    r = run(dir);
    assert.equal(r.status, 1);
    assert.match(r.out, /byte-for-byte copy of mcp-bridge\.cjs/);
  });
});
