// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";

// What the reproducible build scripts refuse, and how they read their input. Each case runs a byte-identical copy
// of the script in a throw-away tree (the script finds the repository from its own location), so that a tree can be
// made to break exactly one rule: a symlink, a stray file, a version that disagrees, a file that is not committed.

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const EPOCH = "1790000000";
const trees = [];

after(() => {
  for (const dir of trees) fs.rmSync(dir, { recursive: true, force: true });
});

function copyScripts(tree, names) {
  fs.mkdirSync(path.join(tree, "scripts"), { recursive: true });
  for (const name of names) fs.copyFileSync(path.join(root, "scripts", name), path.join(tree, "scripts", name));
}

function write(tree, rel, content) {
  const file = path.join(tree, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function git(tree, ...args) {
  return execFileSync("git", ["-C", tree, "-c", "user.name=Test", "-c", "user.email=test@example.org", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" },
  });
}

function commitAll(tree) {
  git(tree, "init", "-q", "-b", "main");
  git(tree, "add", "-A");
  git(tree, "commit", "-q", "-m", "tree");
}

// ── the XPI build ──

const XPI_MANIFEST = {
  manifest_version: 2,
  version: "1.2.3",
  browser_specific_settings: {
    gecko: {
      id: "commonpost-mcp@commonpost.github.io",
      update_url: "https://commonpost.github.io/thunderbird-mcp/updates.json",
      strict_min_version: "140.0",
    },
  },
};

function xpiTree(manifestChanges = {}, { packageVersion = "1.2.3" } = {}) {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "cp-xpi-tree-"));
  trees.push(tree);
  copyScripts(tree, ["build-xpi-reproducible.cjs", "zip-stored.cjs"]);
  const manifest = JSON.parse(JSON.stringify(XPI_MANIFEST));
  for (const [key, value] of Object.entries(manifestChanges)) {
    if (value === undefined) delete manifest[key];
    else manifest[key] = value;
  }
  write(tree, "extension/manifest.json", JSON.stringify(manifest));
  write(tree, "extension/background.js", "// background\n");
  write(tree, "package.json", JSON.stringify({ version: packageVersion }));
  write(tree, "LICENSE", "license text\n");
  write(tree, "THIRD-PARTY.md", "third party\n");
  return tree;
}

function geckoWith(changes) {
  return { gecko: { ...XPI_MANIFEST.browser_specific_settings.gecko, ...changes } };
}

function buildXpi(tree, args = ["--from-tree"], env = {}) {
  return spawnSync(process.execPath, [path.join(tree, "scripts/build-xpi-reproducible.cjs"), ...args], {
    cwd: tree,
    encoding: "utf8",
    env: { ...process.env, COMMONPOST_COMMIT: COMMIT, SOURCE_DATE_EPOCH: EPOCH, COMMONPOST_OUT_DIR: path.join(tree, "out"), ...env },
  });
}

function refused(result, pattern) {
  assert.equal(result.status, 1, `expected the build to be refused; stdout: ${result.stdout} stderr: ${result.stderr}`);
  assert.match(result.stderr, pattern);
}

describe("XPI build from the files on disk: what it needs", () => {
  it("needs the commit and the commit time, both well formed", () => {
    const tree = xpiTree();
    const message = /build-xpi-reproducible: --from-tree needs COMMONPOST_COMMIT=<40-hex sha> and SOURCE_DATE_EPOCH=<seconds>/;
    refused(buildXpi(tree, ["--from-tree"], { COMMONPOST_COMMIT: "" }), message);
    refused(buildXpi(tree, ["--from-tree"], { COMMONPOST_COMMIT: "abc123" }), message);
    refused(buildXpi(tree, ["--from-tree"], { COMMONPOST_COMMIT: COMMIT.toUpperCase() }), message);
    refused(buildXpi(tree, ["--from-tree"], { SOURCE_DATE_EPOCH: "" }), message);
    refused(buildXpi(tree, ["--from-tree"], { SOURCE_DATE_EPOCH: "yesterday" }), message);
    refused(buildXpi(tree, ["--from-tree"], { SOURCE_DATE_EPOCH: "1.5" }), message);
    refused(buildXpi(tree, ["--from-tree"], { SOURCE_DATE_EPOCH: "0" }), message);
    refused(buildXpi(tree, ["--from-tree"], { SOURCE_DATE_EPOCH: "-100" }), message);
    const env = { ...process.env };
    delete env.COMMONPOST_COMMIT;
    const noCommit = spawnSync(process.execPath, [path.join(tree, "scripts/build-xpi-reproducible.cjs"), "--from-tree"], { cwd: tree, encoding: "utf8", env });
    refused(noCommit, message);
  });

  it("builds a tree that is in order, and --print-only writes nothing", () => {
    const tree = xpiTree();
    const printed = buildXpi(tree, ["--from-tree", "--print-only"]);
    assert.equal(printed.status, 0, printed.stderr);
    assert.match(printed.stdout, /^[0-9a-f]{64} {2}commonpost-mcp-v1\.2\.3\.xpi {2}\(\d+ bytes, 5 entries, commit 0123456789ab\)\n$/);
    assert.equal(fs.existsSync(path.join(tree, "out")), false);
  });

  it("writes into dist/ of the repository when no output folder is named", () => {
    const tree = xpiTree();
    const env = { ...process.env, COMMONPOST_COMMIT: COMMIT, SOURCE_DATE_EPOCH: EPOCH };
    delete env.COMMONPOST_OUT_DIR;
    const built = spawnSync(process.execPath, [path.join(tree, "scripts/build-xpi-reproducible.cjs"), "--from-tree"], { cwd: tree, encoding: "utf8", env });
    assert.equal(built.status, 0, built.stderr);
    assert.deepEqual(fs.readdirSync(path.join(tree, "dist")).sort(), ["commonpost-mcp-v1.2.3.xpi", "commonpost-mcp-v1.2.3.xpi.sha256"]);
  });

  it("generates buildinfo.json itself: one left in extension/ changes nothing", () => {
    const plainTree = xpiTree();
    const withInfo = xpiTree();
    write(withInfo, "extension/buildinfo.json", '{"version":"stale"}');
    assert.equal(buildXpi(withInfo, ["--from-tree", "--print-only"]).stdout.slice(0, 64), buildXpi(plainTree, ["--from-tree", "--print-only"]).stdout.slice(0, 64));
  });
});

describe("XPI build: files it refuses", () => {
  it("refuses a symlink in extension/", { skip: process.platform === "win32" }, () => {
    const tree = xpiTree();
    fs.symlinkSync("manifest.json", path.join(tree, "extension/link.js"));
    refused(buildXpi(tree), /refusing symlink link\.js/);
  });

  it("refuses a special file (a named pipe) in extension/", { skip: process.platform === "win32" }, () => {
    const tree = xpiTree();
    execFileSync("mkfifo", [path.join(tree, "extension/pipe")]);
    refused(buildXpi(tree), /refusing special file pipe/);
  });

  for (const name of [".DS_Store", "Thumbs.db", "desktop.ini", "notes.txt~", "patch.orig", "patch.rej", "x.swp", "x.swo", "copy.bak", "a.tmp", "debug.log", "sub/.hidden", "sub/deeper/.env"]) {
    it(`refuses the stray file ${name}`, () => {
      const tree = xpiTree();
      write(tree, `extension/${name}`, "x");
      refused(buildXpi(tree), new RegExp(`refusing parasite file extension/${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    });
  }

  it("refuses a LICENSE inside extension/, as the root one is added", () => {
    const tree = xpiTree();
    write(tree, "extension/LICENSE", "other");
    refused(buildXpi(tree), /LICENSE exists in extension\/ and at the repository root/);
  });

  it("refuses a tree without extension/manifest.json", () => {
    const tree = xpiTree();
    fs.rmSync(path.join(tree, "extension/manifest.json"));
    refused(buildXpi(tree), /extension\/manifest\.json missing/);
  });
});

describe("XPI build: the manifest it checks", () => {
  it("refuses a version that is not X.Y.Z, and one that differs from package.json", () => {
    refused(buildXpi(xpiTree({ version: "1.2" })), /manifest version 1\.2 is not X\.Y\.Z/);
    refused(buildXpi(xpiTree({ version: "1.2.3-beta" })), /is not X\.Y\.Z/);
    refused(buildXpi(xpiTree({}, { packageVersion: "1.2.4" })), /manifest version 1\.2\.3, package\.json 1\.2\.4/);
  });

  it("refuses an add-on id, an update address or a minimum version that is not the expected one", () => {
    refused(buildXpi(xpiTree({ browser_specific_settings: geckoWith({ id: "other@example.org" }) })), /manifest id other@example\.org, expected commonpost-mcp@commonpost\.github\.io/);
    refused(buildXpi(xpiTree({ browser_specific_settings: geckoWith({ update_url: "https://example.org/updates.json" }) })), /update_url https:\/\/example\.org\/updates\.json, expected https:\/\/commonpost\.github\.io/);
    refused(buildXpi(xpiTree({ browser_specific_settings: geckoWith({ strict_min_version: "115.0" }) })), /strict_min_version 115\.0, expected 140\.0/);
  });

  it("refuses a manifest without gecko settings", () => {
    refused(buildXpi(xpiTree({ browser_specific_settings: undefined })), /manifest id undefined, expected/);
    refused(buildXpi(xpiTree({ browser_specific_settings: {} })), /manifest id undefined, expected/);
  });
});

describe("XPI build from the committed tree (git)", () => {
  function committedTree(changes) {
    const tree = xpiTree();
    if (changes) changes(tree);
    commitAll(tree);
    return tree;
  }
  const gitBuild = (tree, env = {}) => spawnSync(process.execPath, [path.join(tree, "scripts/build-xpi-reproducible.cjs"), "--print-only"], {
    cwd: tree, encoding: "utf8", env: { ...process.env, ...env },
  });

  it("builds HEAD with the commit and its time", () => {
    const tree = committedTree();
    const result = gitBuild(tree);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\(\d+ bytes, 5 entries, commit [0-9a-f]{12}\)/);
    assert.doesNotMatch(result.stderr, /uncommitted/);
    const head = git(tree, "rev-parse", "HEAD").trim();
    assert.ok(result.stdout.includes(`commit ${head.slice(0, 12)}`));
  });

  it("builds the same bytes whatever the working tree holds, and says that changes are not built", () => {
    const tree = committedTree();
    const before = gitBuild(tree).stdout;
    write(tree, "extension/background.js", "// changed after the commit\n");
    const edited = gitBuild(tree);
    assert.equal(edited.stdout, before);
    assert.match(edited.stderr, /extension\/ has uncommitted changes; they are NOT built \(HEAD is\)/);
  });

  it("accepts an executable file, which git records as mode 100755", { skip: process.platform === "win32" }, () => {
    const tree = committedTree((dir) => {
      write(dir, "extension/tool.sh", "#!/bin/sh\n");
      fs.chmodSync(path.join(dir, "extension/tool.sh"), 0o755);
    });
    const result = gitBuild(tree);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /6 entries/);
  });

  it("refuses a committed symlink", { skip: process.platform === "win32" }, () => {
    const tree = committedTree((dir) => fs.symlinkSync("manifest.json", path.join(dir, "extension/alias.json")));
    refused(gitBuild(tree), /refusing extension\/alias\.json \(git mode 120000 blob\)/);
  });

  it("refuses a submodule, which git records as a commit and not a file", () => {
    const tree = committedTree();
    git(tree, "update-index", "--add", "--cacheinfo", `160000,${COMMIT},extension/vendor`);
    git(tree, "commit", "-q", "-m", "add a submodule");
    refused(gitBuild(tree), /refusing extension\/vendor \(git mode 160000 commit\)/);
  });

  it("refuses a committed stray file, whatever the working tree holds", () => {
    const tree = committedTree((dir) => write(dir, "extension/.DS_Store", "x"));
    refused(gitBuild(tree), /refusing parasite file extension\/\.DS_Store/);
  });
});

// ── the .mcpb build ──

const BRIDGE_SOURCE = (version) => `'use strict';\nconst BRIDGE_VERSION = '${version}';\n`;
const MCPB_MANIFEST = {
  manifest_version: "0.3",
  version: "1.2.3",
  server: { type: "node", entry_point: "mcp-bridge.cjs" },
};

function mcpbTree({ manifest = {}, bridgeVersion = "1.2.3", packageVersion = "1.2.3", bridge, omit = [], packageJson } = {}) {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "cp-mcpb-tree-"));
  trees.push(tree);
  copyScripts(tree, ["build-mcpb-reproducible.cjs", "mcpb-inputs.cjs", "zip-stored.cjs"]);
  const merged = { ...MCPB_MANIFEST, ...manifest };
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  const files = {
    "mcpb/manifest.json": JSON.stringify(merged),
    "mcp-bridge.cjs": bridge === undefined ? BRIDGE_SOURCE(bridgeVersion) : bridge,
    LICENSE: "license\n",
    "THIRD-PARTY.md": "third party\n",
    "extension/icons/icon-128.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    "package.json": packageJson === undefined ? JSON.stringify({ version: packageVersion }) : packageJson,
  };
  for (const [rel, content] of Object.entries(files)) if (!omit.includes(rel)) write(tree, rel, content);
  return tree;
}

function buildMcpb(tree, args = ["--from-tree"], env = {}) {
  return spawnSync(process.execPath, [path.join(tree, "scripts/build-mcpb-reproducible.cjs"), ...args], {
    cwd: tree,
    encoding: "utf8",
    env: { ...process.env, COMMONPOST_OUT_DIR: path.join(tree, "out"), ...env },
  });
}

describe(".mcpb build: success", () => {
  it("builds the five entries, names the release asset by the bridge version and writes the hash file", () => {
    const tree = mcpbTree();
    const result = buildMcpb(tree);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^[0-9a-f]{64} {2}commonpost-mcp-v1\.2\.3\.mcpb {2}\(\d+ bytes, 5 entries\)\n$/);
    assert.deepEqual(fs.readdirSync(path.join(tree, "out")).sort(), ["commonpost-mcp-v1.2.3.mcpb", "commonpost-mcp-v1.2.3.mcpb.sha256"]);
  });

  it("--print-only writes nothing, and with no output folder named dist/ of the repository is used", () => {
    const tree = mcpbTree();
    assert.equal(buildMcpb(tree, ["--from-tree", "--print-only"]).status, 0);
    assert.equal(fs.existsSync(path.join(tree, "out")), false);
    const env = { ...process.env };
    delete env.COMMONPOST_OUT_DIR;
    const built = spawnSync(process.execPath, [path.join(tree, "scripts/build-mcpb-reproducible.cjs"), "--from-tree"], { cwd: tree, encoding: "utf8", env });
    assert.equal(built.status, 0, built.stderr);
    assert.ok(fs.existsSync(path.join(tree, "dist/commonpost-mcp-v1.2.3.mcpb")));
  });

  it("accepts a bridge older than package.json, or equal to it", () => {
    assert.equal(buildMcpb(mcpbTree({ bridgeVersion: "1.2.3", packageVersion: "1.3.0", manifest: { version: "1.2.3" } }), ["--from-tree", "--print-only"]).status, 0);
    assert.equal(buildMcpb(mcpbTree({ bridgeVersion: "1.2.3", packageVersion: "2.0.0" }), ["--from-tree", "--print-only"]).status, 0);
    assert.equal(buildMcpb(mcpbTree({ bridgeVersion: "1.2.3", packageVersion: "1.2.3" }), ["--from-tree", "--print-only"]).status, 0);
  });
});

describe(".mcpb build: what it refuses", () => {
  it("refuses an input file that is missing, and names it", () => {
    for (const rel of ["mcpb/manifest.json", "mcp-bridge.cjs", "LICENSE", "extension/icons/icon-128.png"]) {
      refused(buildMcpb(mcpbTree({ omit: [rel] })), new RegExp(`build-mcpb-reproducible: cannot read ${rel.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}: ENOENT`));
    }
  });

  it("refuses a manifest version that is not 0.3 or a version that is not X.Y.Z", () => {
    refused(buildMcpb(mcpbTree({ manifest: { manifest_version: "0.2" } })), /manifest_version 0\.2, expected 0\.3/);
    refused(buildMcpb(mcpbTree({ manifest: { version: "1.2" } })), /manifest version 1\.2 is not X\.Y\.Z/);
  });

  it("refuses a bridge whose version cannot be read or disagrees with the manifest", () => {
    refused(buildMcpb(mcpbTree({ bridge: "'use strict';\n" })), /mcpb manifest 1\.2\.3 and BRIDGE_VERSION undefined must agree/);
    refused(buildMcpb(mcpbTree({ bridgeVersion: "1.2.4" })), /mcpb manifest 1\.2\.3 and BRIDGE_VERSION 1\.2\.4 must agree/);
  });

  it("refuses a package.json whose version is missing or not X.Y.Z, and a bridge newer than it", () => {
    refused(buildMcpb(mcpbTree({ packageJson: "{}" })), /BRIDGE_VERSION 1\.2\.3 must not be newer than package\.json undefined/);
    refused(buildMcpb(mcpbTree({ packageVersion: "next" })), /must not be newer than package\.json next/);
    refused(buildMcpb(mcpbTree({ packageVersion: "1.1.9" })), /BRIDGE_VERSION 1\.2\.3 must not be newer than package\.json 1\.1\.9/);
    refused(buildMcpb(mcpbTree({ packageVersion: "0.9.9" })), /must not be newer than/);
  });

  it("refuses a manifest with another entry point, with no server, or with user_config", () => {
    refused(buildMcpb(mcpbTree({ manifest: { server: { type: "node", entry_point: "other.cjs" } } })), /server\.entry_point other\.cjs, expected mcp-bridge\.cjs/);
    refused(buildMcpb(mcpbTree({ manifest: { server: undefined } })), /server\.entry_point undefined, expected mcp-bridge\.cjs/);
    refused(buildMcpb(mcpbTree({ manifest: { user_config: {} } })), /user_config is not allowed in this bundle/);
  });
});

describe(".mcpb build from the committed tree (git)", () => {
  const gitBuild = (tree) => spawnSync(process.execPath, [path.join(tree, "scripts/build-mcpb-reproducible.cjs"), "--print-only"], { cwd: tree, encoding: "utf8" });

  it("builds HEAD, and says that uncommitted changes to the inputs are not built", () => {
    const tree = mcpbTree();
    commitAll(tree);
    const clean = gitBuild(tree);
    assert.equal(clean.status, 0, clean.stderr);
    assert.doesNotMatch(clean.stderr, /uncommitted/);
    write(tree, "LICENSE", "edited after the commit\n");
    const dirty = gitBuild(tree);
    assert.equal(dirty.stdout, clean.stdout);
    assert.match(dirty.stderr, /bundle inputs have uncommitted changes; they are NOT built \(HEAD is\)/);
  });

  it("refuses an input that is not in the commit", () => {
    const tree = mcpbTree({ omit: ["THIRD-PARTY.md"] });
    commitAll(tree);
    write(tree, "THIRD-PARTY.md", "present on disk only\n");
    refused(gitBuild(tree), /cannot read THIRD-PARTY\.md: /);
  });
});
