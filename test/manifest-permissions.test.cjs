"use strict";
// The add-on works through its privileged Experiment (mcp_server/api.js), which reaches Thunderbird directly. It asks
// for no WebExtension permission: each one would add a line to the install prompt and grant an API the add-on does not
// call. Before 0.21.1 it declared six it never used (accountsRead, addressBooks, messagesRead, messagesMove,
// accountsFolders, compose), kept from the original thunderbird-mcp.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "extension");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

function scripts(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return scripts(full);
    return /\.(js|mjs)$/.test(e.name) ? [full] : [];
  });
}

describe("manifest permissions", () => {
  it("declares no WebExtension permission", () => {
    assert.equal(manifest.permissions, undefined);
    assert.equal(manifest.optional_permissions, undefined);
    assert.equal(manifest.host_permissions, undefined);
  });

  it("calls no WebExtension API that would need one", () => {
    // runtime, i18n and windows.openDefaultBrowser need no permission; commonpostMcp is the Experiment.
    const allowed = new Set(["commonpostMcp", "runtime", "i18n", "windows"]);
    const used = new Set();
    for (const file of scripts(root)) {
      if (file.includes(path.join("mcp_server", ""))) continue;
      for (const m of fs.readFileSync(file, "utf8").matchAll(/\b(?:browser|messenger)\.([A-Za-z0-9]+)/g)) used.add(m[1]);
    }
    assert.deepEqual([...used].filter((n) => !allowed.has(n)), []);
  });
});
