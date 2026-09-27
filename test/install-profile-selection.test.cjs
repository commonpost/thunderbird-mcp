"use strict";

// scripts/install.sh: profile selection when several Thunderbird profiles are found.
// The interactive menu itself needs a real TTY (`[[ ! -t 0 ]]` in select_profile), which
// a spawned child's stdin pipe never is -- even with data written to it. So the label
// logic (full path vs. bare name on a name collision) is mirrored here and exercised
// directly, and a source-contract block proves the real script implements it the same
// way. The non-interactive failure path (no TTY at all) needs no mirroring: it is
// exercised directly against the real script below.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const scriptPath = path.resolve(__dirname, "../scripts/install.sh");
const source = fs.readFileSync(scriptPath, "utf8");

// Mirrors the profile_name + name-collision logic of select_profile().
function profileName(profileDir) {
  return path.basename(profileDir);
}

function profileLabels(profiles) {
  const names = profiles.map(profileName);
  const counts = new Map();
  for (const name of names) counts.set(name, (counts.get(name) || 0) + 1);
  return profiles.map((profileDir, i) => (counts.get(names[i]) > 1 ? profileDir : names[i]));
}

describe("install.sh profile label (mirrored logic)", () => {
  it("uses the full path for profiles whose bare name collides", () => {
    const deb = "/home/u/.thunderbird/abc123.default-release";
    const snap = "/home/u/snap/thunderbird/common/.thunderbird/abc123.default-release";
    assert.deepEqual(profileLabels([deb, snap]), [deb, snap]);
  });

  it("uses the bare name when nothing collides", () => {
    const a = "/home/u/root1/alpha.default-release";
    const b = "/home/u/root2/beta.default-release";
    assert.deepEqual(profileLabels([a, b]), ["alpha.default-release", "beta.default-release"]);
  });

  it("only the colliding profiles fall back to the full path, not every profile", () => {
    const a = "/home/u/root1/shared.default-release";
    const b = "/home/u/root2/shared.default-release";
    const c = "/home/u/root3/unique.default-release";
    assert.deepEqual(profileLabels([a, b, c]), [a, b, "unique.default-release"]);
  });
});

describe("install.sh source contract", () => {
  it("detects and reports a bare-name collision, falling back to the full path", () => {
    assert.match(source, /\[\[ "\$other" != "\$index" && "\$\{names\[\$other\]\}" == "\$\{names\[\$index\]\}" \]\]/,
      "install.sh does not pairwise-compare profile names for a collision");
    assert.match(source, /label="\$\{profiles\[\$index\]\}"/, "install.sh does not fall back to the full path on collision");
  });

  it("uses no associative array (bash 3.2, macOS's /bin/bash, has none)", () => {
    assert.doesNotMatch(source, /\b(local|declare)\s+-A\b/);
  });

  it("points at the saved default-profile file when it cannot prompt", () => {
    const start = source.indexOf("if [[ ! -t 0 ]]; then");
    assert.ok(start >= 0, "the non-interactive guard is missing from select_profile");
    const block = source.slice(start, source.indexOf("exit 1", start));
    assert.match(block, /cannot prompt/i);
    assert.match(block, /DEFAULT_PROFILE_FILE/);
  });
});

describe("install.sh select_profile (real script, non-interactive path)", () => {
  function makeProfile(root, leaf) {
    const dir = path.join(root, leaf);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "prefs.js"), "");
    return dir;
  }

  it("fails with a clear message and does not choose silently when stdin is not a TTY", () => {
    const endMarker = "# Build if needed";
    const endIdx = source.indexOf(endMarker);
    assert.ok(endIdx > 0, "install.sh: 'Build if needed' marker not found");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cp-install-"));
    const a = makeProfile(path.join(tmp, "root1"), "alpha.default-release");
    const b = makeProfile(path.join(tmp, "root2"), "beta.default-release");
    const defaultProfileFile = path.join(tmp, "default-profile");

    const script = `${source.slice(0, endIdx)}
DEFAULT_PROFILE_FILE="${defaultProfileFile}"
select_profile "$@"
`;
    const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-install-script-"));
    const scriptFile = path.join(scriptDir, "select-profile.sh");
    fs.writeFileSync(scriptFile, script);

    // A pipe (spawnSync's default stdin), unlike a TTY, is exactly what a
    // real non-interactive run (CI, a cron job) looks like to `[[ ! -t 0 ]]`.
    const result = spawnSync("bash", [scriptFile, a, b], { input: "", encoding: "utf8" });

    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /cannot prompt/i);
    assert.match(result.stderr, /Run scripts\/install\.sh interactively once/);
    assert.match(result.stderr, /default-profile/);
  });
});
