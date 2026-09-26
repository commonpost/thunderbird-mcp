"use strict";

// The options page warns when the original thunderbird-mcp add-on is active
// in the same profile.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const apiSource = fs.readFileSync(path.join(root, "extension/mcp_server/api.js"), "utf8");

function loadHelper(warnings) {
  const start = apiSource.indexOf("// BEGIN ORIGINAL EXTENSION NOTICE");
  const end = apiSource.indexOf("// END ORIGINAL EXTENSION NOTICE");
  assert.ok(start >= 0 && end > start, "original extension notice markers missing");
  const sandbox = { console: { warn: (...a) => warnings.push(a) } };
  vm.createContext(sandbox);
  vm.runInContext(
    `${apiSource.slice(start, end)}
this.detectOriginalExtensionActive = detectOriginalExtensionActive;
this.ORIGINAL_EXTENSION_ID = ORIGINAL_EXTENSION_ID;`,
    sandbox
  );
  return sandbox;
}

describe("original extension notice", () => {
  it("looks up the original add-on id and reports an active one", async () => {
    const warnings = [];
    const { detectOriginalExtensionActive, ORIGINAL_EXTENSION_ID } = loadHelper(warnings);
    const asked = [];
    const active = await detectOriginalExtensionActive(async (id) => { asked.push(id); return { isActive: true }; });
    assert.equal(active, true);
    assert.deepEqual(asked, [ORIGINAL_EXTENSION_ID]);
    assert.equal(ORIGINAL_EXTENSION_ID, "thunderbird-mcp@tkasperczyk.dev");
  });

  it("is false when the add-on is absent or disabled", async () => {
    const { detectOriginalExtensionActive } = loadHelper([]);
    assert.equal(await detectOriginalExtensionActive(async () => null), false);
    assert.equal(await detectOriginalExtensionActive(async () => ({ isActive: false })), false);
  });

  it("is false and logs when the lookup fails", async () => {
    const warnings = [];
    const { detectOriginalExtensionActive } = loadHelper(warnings);
    assert.equal(await detectOriginalExtensionActive(async () => { throw new Error("boom"); }), false);
    assert.equal(warnings.length, 1);
  });

  it("is reported by getServerInfo and shown in the options page", () => {
    assert.match(apiSource, /originalExtensionActive,\n\s*\};/);
    const html = fs.readFileSync(path.join(root, "extension/options.html"), "utf8");
    const js = fs.readFileSync(path.join(root, "extension/options.js"), "utf8");
    assert.match(html, /id="originalExtensionRow"[^>]*hidden/);
    assert.match(js, /originalExtensionRow\.hidden = !info\.originalExtensionActive/);
  });
});
