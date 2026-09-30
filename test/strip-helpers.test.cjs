"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { stripTrailing: bridgeStripTrailing } = require("../mcp-bridge.cjs");

const source = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");
const start = source.indexOf("// BEGIN STRIP HELPERS");
const end = source.indexOf("// END STRIP HELPERS", start);
assert.ok(start >= 0 && end > start, "STRIP HELPERS markers missing");
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(`${source.slice(start, end)}\nthis.stripTrailing = stripTrailing; this.stripLeading = stripLeading;`, sandbox);
const { stripTrailing, stripLeading } = sandbox;

describe("stripTrailing / stripLeading", () => {
  for (const [name, fn, trailing] of [["stripTrailing", stripTrailing, true], ["stripLeading", stripLeading, false]]) {
    it(`${name}: empty string, nothing to drop, only characters to drop`, () => {
      assert.equal(fn("", "_"), "");
      assert.equal(fn("abc", "_"), "abc");
      assert.equal(fn("_ab_c_", ""), "_ab_c_");
      assert.equal(fn("____", "_"), "");
      assert.equal(fn("_", "_"), "");
    });

    it(`${name}: drops one end only and any character of the set`, () => {
      assert.equal(fn("_a_", "_"), trailing ? "_a" : "a_");
      assert.equal(fn("/\\/a/\\/", "/\\"), trailing ? "/\\/a" : "a/\\/");
      assert.equal(fn("a.b. ", ". "), trailing ? "a.b" : "a.b. ");
    });

    it(`${name}: a long run followed by another character is linear`, () => {
      const run = "_".repeat(200000);
      const input = trailing ? `${run}x` : `x${run}`;
      const t0 = process.hrtime.bigint();
      const out = fn(input, "_");
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      assert.equal(out, input);
      assert.ok(ms < 50, `took ${ms} ms`);
    });
  }

  it("the bridge copy behaves the same", () => {
    assert.equal(bridgeStripTrailing("C:\\tmp\\\\/", "/\\"), "C:\\tmp");
    assert.equal(bridgeStripTrailing("", "/\\"), "");
    assert.equal(bridgeStripTrailing("a  ", " "), "a");
    const input = `${" ".repeat(200000)}x`;
    const t0 = process.hrtime.bigint();
    assert.equal(bridgeStripTrailing(input, " "), input);
    assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 50);
  });
});
