"use strict";

// The Bridge section of the options page: the schema declares getBridgeStatus, the HTML has the section in the right
// place, and the script shows text only (no innerHTML), links only to this repository's release pages and opens them
// with the browser. A source-shape test: the page itself needs Thunderbird.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (p) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");

describe("Bridge section of the options page", () => {
  it("declares getBridgeStatus in the schema", () => {
    const schema = JSON.parse(read("extension/mcp_server/schema.json"));
    const fn = schema.flatMap((ns) => ns.functions || []).find((f) => f.name === "getBridgeStatus");
    assert.ok(fn, "getBridgeStatus missing from schema.json");
    assert.equal(fn.async, true);
    assert.deepEqual(fn.parameters, []);
  });

  it("has the section between Server Status and Account Access", () => {
    const html = read("extension/options.html");
    for (const id of ["bridgeSection", "bridgeThresholds", "bridgeList", "bridgeRefreshBtn", "bridgeRefreshStatus"]) {
      assert.ok(html.includes(`id="${id}"`), `${id} missing`);
    }
    assert.match(html, /id="bridgeEmpty" hidden>/);
    const status = html.indexOf("<h2>Server Status</h2>");
    const bridge = html.indexOf('id="bridgeSection"');
    const access = html.indexOf("<h2>Account Access</h2>");
    assert.ok(status >= 0 && status < bridge && bridge < access);
  });

  describe("options.js", () => {
    const js = read("extension/options.js");
    const start = js.indexOf("// --- Bridge (");
    assert.ok(start >= 0, "bridge block missing");
    const block = js.slice(start);

    it("never uses innerHTML", () => {
      assert.ok(!block.includes("innerHTML"));
    });

    it("reads the status and opens links with the browser", () => {
      assert.ok(block.includes("browser.commonpostMcp.getBridgeStatus()"));
      assert.ok(block.includes("browser.windows.openDefaultBrowser("));
      assert.ok(block.includes(
        "const BRIDGE_RELEASE_URL_PATTERN = /^https:\\/\\/github\\.com\\/commonpost\\/thunderbird-mcp\\/releases\\/(tag\\/v\\d{1,6}\\.\\d{1,6}\\.\\d{1,6}|latest)$/;"
      ));
    });

    it("labels every state", () => {
      for (const label of [
        '"up-to-date": "Up to date."',
        '"newer-available": "Newer version available: this bridge works, the update is optional."',
        '"update-recommended": "Update recommended."',
        '"unversioned": "Update recommended: this bridge does not report a readable version."',
        '"development": "Development build: not checked."',
        '"refused": "Refused: older than the security floor of this add-on (no tool works with it)."',
        '"newer-than-add-on": "Newer than this add-on:',
      ]) {
        assert.ok(block.includes(label), label);
      }
    });

    it("names the newest bridge only when its version is valid, and gives the advice and link for an optional update", () => {
      assert.ok(block.includes("const BRIDGE_VERSION_PATTERN = /^\\d{1,6}\\.\\d{1,6}\\.\\d{1,6}$/;"));
      assert.ok(block.includes("`Newer version available (${current}): this bridge works, the update is optional.`"));
      assert.ok(block.includes('["newer-available", "update-recommended", "unversioned", "refused"].includes(bridge.state)'));
      assert.ok(block.includes("renderBridge(bridge, status.currentBridgeVersion)"));
      assert.ok(block.includes("` The bridge published with it is ${current}.`"));
    });

    it("loads at the top level and on refresh", () => {
      assert.match(js, /^loadBridgeStatus\(\)\.catch\(/m);
    });
  });

  it("is counted in the Experiment inventory", () => {
    const doc = read("docs/experiment-inventory.md");
    assert.ok(doc.includes("20 functions"));
    assert.ok(doc.includes("bridge status"));
  });
});
