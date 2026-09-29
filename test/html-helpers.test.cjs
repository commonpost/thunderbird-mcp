"use strict";

// Regression tests for the HTML helpers of api.js flagged by code scanning
// (js/bad-tag-filter, js/incomplete-multi-character-sanitization).

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const apiSource = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");

// The helpers are nested in the Experiment API class: load the source of one
// function (from its declaration to the closing brace at the same indentation).
function loadHelper(name) {
  const indent = "            ";
  const start = apiSource.indexOf(`\n${indent}function ${name}(`);
  assert.ok(start >= 0, `${name} not found in api.js`);
  const close = `\n${indent}}\n`;
  const end = apiSource.indexOf(close, start);
  assert.ok(end > start, `end of ${name} not found in api.js`);
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${apiSource.slice(start, end + close.length)}\nthis.helper = ${name};`, sandbox);
  return sandbox.helper;
}

// stripHtml and htmlToMarkdown now call shared helpers (removeHiddenHtmlBlocks,
// isHiddenElementNode...) declared alongside them: load the whole marked block
// rather than one function's own brace-matched body.
function loadHtmlHiddenContentHelpers() {
  const start = apiSource.indexOf("// BEGIN HTML HIDDEN CONTENT HELPERS");
  const end = apiSource.indexOf("// END HTML HIDDEN CONTENT HELPERS");
  assert.ok(start >= 0 && end > start, "HTML HIDDEN CONTENT HELPERS marker missing");
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${apiSource.slice(start, end)}
this.stripHtml = stripHtml;
this.isHiddenElementNode = isHiddenElementNode;`, sandbox);
  return sandbox;
}

const htmlHelpers = loadHtmlHiddenContentHelpers();
const stripHtml = htmlHelpers.stripHtml;
const isHiddenElementNode = htmlHelpers.isHiddenElementNode;
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

  it("removes text hidden by the hidden attribute, CSS, or <template>, and counts it", () => {
    const cases = [
      ['a<div hidden>secret</div>b', 1],
      ['a<div hidden="hidden">secret</div>b', 1],
      ['a<span style="display:none">secret</span>b', 1],
      ['a<span style="display: none;">secret</span>b', 1],
      ['a<span style="visibility:hidden">secret</span>b', 1],
      ['a<span style="font-size:0">secret</span>b', 1],
      ['a<span style="font-size: 0px">secret</span>b', 1],
      ['a<span style="opacity:0">secret</span>b', 1],
      ['a<span style=\'opacity: 0.0\'>secret</span>b', 1],
      ['a<template><p>secret</p></template>b', 1],
    ];
    for (const [html, expectedCount] of cases) {
      const counter = { n: 0 };
      const text = stripHtml(html, counter);
      assert.ok(!text.includes("secret"), `${html} was not removed: ${text}`);
      assert.equal(counter.n, expectedCount, html);
    }
  });

  it("does not remove ordinary, visible text or unrelated style declarations", () => {
    const counter = { n: 0 };
    for (const html of [
      'a<div>visible</div>b',
      'a<span style="color:red">visible</span>b',
      'a<span style="font-size: 14px">visible</span>b',
      'a<span style="opacity: 1">visible</span>b',
      'a<div class="hidden-section">visible</div>b', // "hidden" inside a class name, not the attribute
    ]) {
      const text = stripHtml(html, counter);
      assert.ok(text.includes("visible"), `${html} wrongly removed: ${text}`);
    }
    assert.equal(counter.n, 0);
  });

  it("counts more than one hidden block, and defaults the counter when none is given", () => {
    const counter = { n: 0 };
    stripHtml('<div hidden>a</div><span style="display:none">b</span>', counter);
    assert.equal(counter.n, 2);
    assert.doesNotThrow(() => stripHtml('<div hidden>a</div>'));
  });
});

describe("isHiddenElementNode", () => {
  const node = (attrs) => ({
    hasAttribute: (n) => n in attrs,
    getAttribute: (n) => (n in attrs ? attrs[n] : null),
  });

  it("recognises the hidden attribute and every covered CSS declaration", () => {
    assert.equal(isHiddenElementNode(node({ hidden: "" })), true);
    for (const style of ["display:none", "display: none", "visibility:hidden", "font-size:0", "font-size: 0px",
      "opacity:0", "opacity: 0.0"]) {
      assert.equal(isHiddenElementNode(node({ style })), true, style);
    }
  });

  it("leaves a visible element alone", () => {
    assert.equal(isHiddenElementNode(node({})), false);
    assert.equal(isHiddenElementNode(node({ style: "color:red;font-size:14px" })), false);
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
