"use strict";

// Regression tests for the HTML helpers of api.js flagged by code scanning
// (js/bad-tag-filter, js/incomplete-multi-character-sanitization).

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// The helpers are nested in the Experiment API class: load the source of one
// function (from its declaration to the closing brace at the same indentation).
function loadHelper(name) {
  const source = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");
  const indent = "            ";
  const start = source.indexOf(`\n${indent}function ${name}(`);
  assert.ok(start >= 0, `${name} not found in api.js`);
  const close = `\n${indent}}\n`;
  const end = source.indexOf(close, start);
  assert.ok(end > start, `end of ${name} not found in api.js`);
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${source.slice(start, end + close.length)}\nthis.helper = ${name};`, sandbox);
  return sandbox.helper;
}

const stripHtml = loadHelper("stripHtml");
const descriptionToHTML = loadHelper("descriptionToHTML");

describe("stripHtml", () => {
  it("drops script and style blocks", () => {
    assert.equal(stripHtml("a<script>run()</script>b<style>p{}</style>c"), "a b c");
  });

  it("ends a block on an end tag with whitespace or junk before >", () => {
    for (const end of ["</script >", "</script\n>", "</SCRIPT foo=bar>", "</script\t\n bar>"]) {
      const text = stripHtml(`keep<script>hidden()${end}after`);
      assert.ok(!text.includes("hidden"), `${JSON.stringify(end)} leaked the script body: ${text}`);
      assert.match(text, /^keep\s+after$/);
    }
    assert.equal(stripHtml("x<style>.a{}</style >y"), "x y");
  });
});

describe("descriptionToHTML", () => {
  // Only the markup built by descriptionToHTML itself may appear in its output.
  const OWN_TAGS = /<\/?(?:html|body|div)>|<br>|<a href="[^"<>]*">|<\/a>/g;

  it("leaves no foreign markup in link text, whatever its nesting", () => {
    for (const inner of ["<scr<b>ipt>x", "1 < 2 <b>bold</b> <i", "<<b>script>alert(1)", "<img src=x onerror=y>", "a<>b"]) {
      const html = descriptionToHTML(`see <a href="https://example.org/">${inner}</a> now`);
      assert.ok(!html.replace(OWN_TAGS, "").includes("<"), `${JSON.stringify(inner)} -> ${html}`);
      assert.match(html, /<a href="https:\/\/example\.org\/">/);
    }
  });

  it("drops links with an unsafe or missing href, keeping their text", () => {
    const html = descriptionToHTML('<a href="javascript:run()">one</a> <a>two</a> <a href="mailto:x@example.org">three</a>');
    assert.ok(!html.includes("javascript:"), html);
    assert.match(html, /one/);
    assert.match(html, /two/);
    assert.match(html, /<a href="mailto:x@example\.org">three<\/a>/);
  });
});
