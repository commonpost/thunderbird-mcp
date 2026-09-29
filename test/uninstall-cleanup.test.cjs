"use strict";

// The stable token and the listen-all setting are cleared when the add-on is
// removed; other add-ons' removal and a mere disable leave them alone.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const apiSource = fs.readFileSync(path.join(root, "extension/mcp_server/api.js"), "utf8");
const start = apiSource.indexOf("// BEGIN UNINSTALL CLEANUP HELPERS");
const end = apiSource.indexOf("// END UNINSTALL CLEANUP HELPERS");
assert.ok(start >= 0 && end > start, "uninstall cleanup helpers block missing");
const errors = [];
const sandbox = { console: { error: (...args) => errors.push(args) } };
vm.createContext(sandbox);
vm.runInContext(`${apiSource.slice(start, end)}\nthis.createUninstallCleanupListener = createUninstallCleanupListener;`, sandbox);
const { createUninstallCleanupListener } = sandbox;

describe("createUninstallCleanupListener", () => {
  it("clears when this add-on is being uninstalled", () => {
    let cleared = 0;
    const listener = createUninstallCleanupListener("commonpost-mcp@commonpost.github.io", () => { cleared++; });
    listener.onUninstalling({ id: "commonpost-mcp@commonpost.github.io" });
    assert.equal(cleared, 1);
  });

  it("ignores other add-ons and missing arguments", () => {
    let cleared = 0;
    const listener = createUninstallCleanupListener("commonpost-mcp@commonpost.github.io", () => { cleared++; });
    listener.onUninstalling({ id: "other-addon@example.org" });
    listener.onUninstalling(undefined);
    listener.onUninstalling({});
    assert.equal(cleared, 0);
  });

  it("only listens for uninstalls: disabling or updating does not clear", () => {
    const listener = createUninstallCleanupListener("x", () => {});
    assert.deepEqual(Object.keys(listener), ["onUninstalling"]);
  });

  it("reports a failure to clear and does not throw", () => {
    const listener = createUninstallCleanupListener("x", () => { throw new Error("prefs unavailable"); });
    assert.doesNotThrow(() => listener.onUninstalling({ id: "x" }));
    assert.ok(errors.length >= 1);
  });
});

describe("wiring", () => {
  it("the listener clears the stable token and the listen-all setting, and is removed on shutdown", () => {
    const i = apiSource.indexOf("createUninstallCleanupListener(context.extension.id");
    assert.ok(i > 0);
    const snippet = apiSource.slice(i, i + 500);
    assert.match(snippet, /PREF_STABLE_AUTH_TOKEN, PREF_LISTEN_ALL/);
    assert.match(snippet, /clearUserPref\(pref\)/);
    assert.match(apiSource, /AddonManager\.addAddonListener\(globalThis\.__commonpostUninstallListener\)/);
    const shutdown = apiSource.slice(apiSource.indexOf("onShutdown(isAppShutdown) {"));
    assert.match(shutdown.slice(0, 600), /removeAddonListener\(globalThis\.__commonpostUninstallListener\)/);
  });

  it("the options page warns about the clear-text token and the disabled Host check", () => {
    const html = fs.readFileSync(path.join(root, "extension/options.html"), "utf8");
    const warning = html.slice(html.indexOf('id="listenAllWarning"'), html.indexOf('id="listenAllWarning"') + 700);
    assert.match(warning, /clear\s+text/);
    assert.match(warning, /Host header/);
    assert.match(html, /stored in your Thunderbird profile\s+while the add-on is enabled/);
  });
});
