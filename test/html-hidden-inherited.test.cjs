// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";
// Hidden content in email HTML, as a reader would see it. Inline styles are read as Gecko reads them, with one
// asymmetry: a declaration that hides text is read liberally, one that would show it again counts only in a plain form
// Gecko surely accepts. Text smaller than 3px, or under an opacity product below 0.1, is out of sight; font-size and
// visibility are inherited, so a descendant that sets its own size or visibility:visible is shown. Layout templates
// such as MJML put font-size:0px on the wrappers of their columns: their text must reach the assistant.
// Node has no DOMParser: a small stand-in parser is used (see html-hidden-coverage.test.cjs); the real one is
// exercised in the Thunderbird lab, and the cases below were checked against Gecko's rendering (Firefox 150).
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");

const VOID = new Set(["br", "hr", "img", "input"]);
const element = (tagName, attrs = {}) => ({
  nodeType: 1, tagName: tagName.toUpperCase(), childNodes: [], parentElement: null,
  getAttribute: name => (name in attrs ? attrs[name] : null),
  hasAttribute: name => name in attrs,
  get textContent() { return this.childNodes.map(c => c.textContent).join(""); },
});

// Tags with quoted or unquoted attributes (the first of two with one name wins, as in HTML), text, comments and void
// tags; no entity decoding. An <html> element at the top becomes the document element, as in a real document.
function parseDocument(html) {
  const top = element("body");
  const stack = [top];
  const re = /<!--[\s\S]*?-->|<(\/)?([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    const parent = stack[stack.length - 1];
    if (m[0].startsWith("<!--")) {
      parent.childNodes.push({ nodeType: 8, textContent: "" });
    } else if (m[4] !== undefined) {
      parent.childNodes.push({ nodeType: 3, textContent: m[4] });
    } else if (m[1]) {
      if (stack.length > 1) stack.pop();
    } else {
      const attrs = {};
      for (const a of m[3].matchAll(/([a-zA-Z-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
        if (!(a[1] in attrs)) attrs[a[1]] = a[2] ?? a[3] ?? a[4] ?? "";
      }
      const node = element(m[2], attrs);
      node.parentElement = parent;
      parent.childNodes.push(node);
      if (!VOID.has(m[2].toLowerCase())) stack.push(node);
    }
  }
  const elements = top.childNodes.filter(n => n.nodeType === 1);
  if (elements.length === 1 && elements[0].tagName === "HTML") {
    const root = elements[0];
    root.parentElement = null;
    return { documentElement: root, body: root.childNodes.find(n => n.nodeType === 1 && n.tagName === "BODY") || root };
  }
  const root = element("html");
  root.childNodes.push(top);
  top.parentElement = root;
  return { documentElement: root, body: top };
}

function load(DOMParser) {
  const sandbox = DOMParser ? { DOMParser } : {};
  vm.createContext(sandbox);
  const slice = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
  vm.runInContext(`${slice("// BEGIN STRIP HELPERS", "// END STRIP HELPERS")}\n${slice("// BEGIN HTML HIDDEN CONTENT HELPERS", "// END HTML HIDDEN CONTENT HELPERS")}
const isHiddenElementNode = node => elementHiding(node, typeof node.tagName === "string" ? node.tagName.toLowerCase() : "", VISIBLE_CONTENT).hidden;
this.api = { stripHtml, htmlToMarkdown, emailHtmlToText, isHiddenElementNode, cssDeclarations, fontSizePx,
  fontShorthandSize, legacyFontSizePx, shortenDataUris, VISIBLE_CONTENT };`, sandbox);
  return sandbox.api;
}

const api = load(class { parseFromString(html) { return parseDocument(html); } });
const noDom = load(null);
const throwing = load(class { parseFromString() { return { get documentElement() { throw new Error("broken"); } }; } });

// The three conversions of an HTML body: getMessage markdown, getMessage text, and the lexical fallback.
function convert(html) {
  const counters = { markdown: { n: 0 }, text: { n: 0 }, regex: { n: 0 } };
  return {
    markdown: api.htmlToMarkdown(html, counters.markdown),
    text: api.emailHtmlToText(html, counters.text),
    regex: api.stripHtml(html, counters.regex),
    counts: { markdown: counters.markdown.n, text: counters.text.n, regex: counters.regex.n },
  };
}
const shown = (html, word = "shown") => {
  const out = convert(html);
  assert.match(out.markdown, new RegExp(word), `markdown: ${html}`);
  assert.match(out.text, new RegExp(word), `text: ${html}`);
};
const gone = (html, word = "secret") => {
  const out = convert(html);
  assert.doesNotMatch(out.markdown, new RegExp(word), `markdown: ${html}`);
  assert.doesNotMatch(out.text, new RegExp(word), `text: ${html}`);
};

const MJML = `<div style="margin:0px auto;max-width:600px;"><table role="presentation" style="width:100%;"><tbody><tr>
<td style="direction:ltr;font-size:0px;padding:20px 0;text-align:center;">
<div class="mj-column-per-100" style="font-size:0px;text-align:left;direction:ltr;display:inline-block;width:100%;">
<table role="presentation" width="100%"><tbody><tr><td align="left" style="font-size:0px;padding:10px 25px;">
<div style="font-family:Ubuntu, Helvetica, Arial, sans-serif;font-size:13px;line-height:1;color:#000000;">Hello from MJML</div>
</td></tr></tbody></table></div></td></tr></tbody></table></div>`;

describe("text a reader sees is kept", () => {
  it("keeps the columns of an MJML layout, whose wrappers have font-size:0px", () => {
    const out = convert(MJML);
    assert.match(out.markdown, /Hello from MJML/);
    assert.match(out.text, /Hello from MJML/);
    assert.deepEqual([out.counts.markdown, out.counts.text], [0, 0]);
  });

  it("keeps a column whose size comes from the font shorthand, or that is a form control", () => {
    shown('<td style="font-size:0"><div style="font:13px/1.4 Arial, sans-serif">shown</div></td>');
    shown('<td style="font-size:0"><div style="font: bold 14px / 1.2 Arial">shown</div></td>');
    shown('<td style="font-size:0"><div style="font: italic small-caps 700 1rem serif">shown</div></td>');
    shown('<td style="font-size:0"><button>shown</button></td>');
  });

  it("does not read a fractional size or opacity as 0", () => {
    for (const style of ["font-size:0.875rem", "font-size: 0.9em", "font-size:.8em", "font-size:0.2em", "font-size:3px",
      "opacity:0.8", "opacity: 0.5", "opacity:.5", "opacity:0.1", "opacity:10%"]) {
      const out = convert(`<p>a</p><span style="${style}">small print</span>`);
      for (const format of ["markdown", "text", "regex"]) assert.match(out[format], /small print/, `${format}: ${style}`);
    }
  });

  it("shows a descendant that sets its own size inside font-size:0, in any absolute unit or keyword", () => {
    for (const size of ["13px", "10pt", "1rem", "1vw", "small", "medium", "initial", "13PX", "1.5e1px"]) {
      shown(`<div style="font-size:0"><span style="font-size:${size}">shown</span></div>`);
    }
    shown('<div style="font-size:0"><font size="3">shown</font></div>');
  });

  it("shows the child of a visibility:hidden element that sets visibility:visible", () => {
    const out = convert('<div style="visibility:hidden">gone <span style="visibility:visible">shown</span></div>');
    for (const format of ["markdown", "text"]) {
      assert.match(out[format], /shown/, format);
      assert.doesNotMatch(out[format], /gone/, format);
    }
    assert.deepEqual([out.counts.markdown, out.counts.text], [1, 1]);
  });

  it("keeps an element whose display:none a later plain declaration replaces", () => {
    for (const style of ["display:none;display:block", "display:none; display: inline-block", "display:none;display:BLOCK",
      "display:none;display:initial", "opacity:0;opacity:1", "opacity:0;opacity:.5", "opacity:0;opacity:5e-1"]) {
      shown(`<span style="${style}">shown</span>`);
    }
  });

  it("does not cut a declaration at a semicolon inside a url(), and errs toward removing around strings", () => {
    shown('<span style="background:url(x;displayed:none)">shown</span>');
    // A style with a string, a comment or a bracket that names a hiding declaration anywhere is taken as hidden
    gone(`<span style="font-family:'a;display:none'">secret</span>`);
    gone(`<span style="font-family:'a';display:none;display:block">secret</span>`);
  });

  it("keeps an element with the hidden attribute whose style sets a display, and an old IE hack Gecko ignores", () => {
    shown('<div hidden style="display:block">shown</div>');
    gone('<div hidden style="display:revert">secret</div>');
    shown('<span style="display:none\\9">shown</span>');
  });

  it("sizes headings, small, sub, sup and big as the default style sheet does", () => {
    gone('<div style="font-size:4px"><h6>secret</h6></div>');
    gone('<div style="font-size:3.5px"><small>secret</small></div>');
    shown('<div style="font-size:2px"><h1>shown</h1></div>');
  });

  it("keeps the alt text of an image in a font-size:0 wrapper, and an open dialog", () => {
    assert.equal(api.htmlToMarkdown('<div style="font-size:0"><img alt="logo" width="100"></div>'), "logo");
    assert.match(api.htmlToMarkdown("<dialog open>shown</dialog>"), /shown/);
  });

  it("does not take a no-break space in a value for a space, nor glue the two sides of a comment", () => {
    shown('<span style="display:none\u00A0">shown</span>');
    shown('<span style="display:no/**/ne">shown</span>');
  });
});

describe("text a reader does not see is removed", () => {
  it("removes text under font-size:0 when nothing inside sets a size again, counting the element once", () => {
    const out = convert('<p>keep</p><div style="font-size:0px">one <b>two</b> three</div>');
    for (const format of ["markdown", "text", "regex"]) {
      assert.match(out[format], /keep/, format);
      assert.doesNotMatch(out[format], /one|two|three/, format);
    }
    assert.deepEqual(out.counts, { markdown: 1, text: 1, regex: 1 });
  });

  it("removes text whose relative size is a share of 0, or whose size Gecko might not take", () => {
    for (const size of ["1.5em", "150%", "larger", "inherit", "unset", "revert", "revert-layer"]) {
      gone(`<div style="font-size:0"><span style="font-size:${size}">secret</span></div>`);
    }
    // Not trusted to show text: a function, a unitless number (pixels in quirks mode only), a number Gecko rejects
    for (const size of ["calc(14px)", "foo(12px)", "13", "12.px", "\\31 3px", "1/**/3px"]) {
      gone(`<div style="font-size:0"><span style="font-size:${size}">secret</span></div>`);
    }
  });

  it("reads zero however it is written", () => {
    for (const style of ["font-size:0", "font-size:00", "font-size:0.0em", "font-size:.0px", "font-size:0%", "opacity:0",
      "opacity:0.00", "opacity:0%", "opacity:-1", "font:0/0 a"]) {
      const out = convert(`<span style="${style}">secret</span>`);
      assert.doesNotMatch(out.markdown, /secret/, style);
      assert.doesNotMatch(out.text, /secret/, style);
      if (!style.startsWith("font:")) assert.doesNotMatch(out.regex, /secret/, style);
    }
  });

  it("removes text too small to read and text under an opacity below 0.1, also as a product", () => {
    for (const style of ["font-size:1px", "font-size:2.9px", "font-size:0.5px", "font-size:2pt", "font-size:0.1em",
      "font-size:15%", "font-size:0.1vw", "font-size:1", "opacity:0.05", "opacity:.09", "opacity:5%"]) {
      gone(`<span style="${style}">secret</span>`);
    }
    for (const style of ["opacity:0.05", "opacity:.09", "opacity:5%"]) assert.doesNotMatch(convert(`<span style="${style}">secret</span>`).regex, /secret/, style);
    gone('<div style="opacity:0.3"><div style="opacity:0.3">secret</div></div>');
    gone('<div style="opacity:0.3"><div style="opacity:inherit">secret</div></div>');
    shown('<div style="opacity:0.5"><div style="opacity:0.5">shown</div></div>');
  });

  it("multiplies relative sizes along the way, and takes rem from the root", () => {
    gone('<div style="font-size:0.5em"><div style="font-size:0.3em">secret</div></div>');
    shown('<div style="font-size:2px"><div style="font-size:200%">shown</div></div>');
    gone('<div style="font-size:3.5px"><span style="font-size:smaller">secret</span></div>');
    gone('<html style="font-size:1px"><body><p style="font-size:2rem">secret</p></body></html>');
  });

  it("is not fooled by an override Gecko drops", () => {
    for (const style of [
      // invalid or unsure values after a hiding one
      "display:none;display:x", "display:none;display:none block", "display:none;display:block inline",
      "display:none;display:run-in", "display:none;display:math", "display:none;display:-moz-box",
      "opacity:0;opacity:foo(1)", "opacity:0;opacity:1.", "opacity:0;opacity:calc(1)",
      "font-size:0;font-size:big", "font-size:0;font-size:foo(12px)", "font-size:0;font-size:12.px",
      "visibility:hidden;visibility:maybe", "font-size:0;font:bold 700 12px a", "font-size:0;font:12px",
      // !important, comments and escapes
      "display:none !important;display:block", "display:block \\21 important;display:none",
      "display:/**/none", "display:none/* unterminated", "displ\\61y:none", "display:n\\6f ne", "DISPLAY:NONE",
      "display:none;display:bl/**/ock", "display:none;display:block\\9", "display:none;display:\\20 block",
      "opacity:0;opacity:\\31", "font-size:0;font-size:1/**/3px",
      // a comment opening inside a string or url() does not swallow what follows
      "font-family:'/*';display:none", "background:url(/*);display:none", "font-family:'/*';opacity:0",
      // the tokenizer reads blocks and url() as Gecko does
      "background:\\75 rl(/*);display:none", `background:url(${" ".repeat(70)}')');display:none`,
      "display:none;x:(];display:block", "display:none;x:[);display:block",
      // other ways
      "content-visibility:hidden",
    ]) {
      gone(`<span style="${style}">secret</span>`);
    }
    gone('<!DOCTYPE html><span style="font-size:0;font-size:12">secret</span>');
    gone('<div hidden="until-found" style="display:block">secret</div>');
    gone('<div hidden="UNTIL-FOUND">secret</div>');
  });

  it("does not trust a font shorthand Gecko rejects to show text", () => {
    for (const font of ["30px 1", "30px/ a", "30px a,", "30px/x a", "bold bold 30px a"]) {
      gone(`<div style="font-size:0"><span style="font:${font}">secret</span></div>`);
    }
  });

  it("lets a declaration that is not plain lower the opacity or the size, never raise it", () => {
    gone('<div style="opacity:/**/0.3"><div style="opacity:/**/0.3">secret</div></div>');
    gone('<div style="font-size:/**/0.4em"><div style="font-size:/**/0.4em">secret</div></div>');
    gone('<div style="font-size:0"><span style="font-size:/**/13px">secret</span></div>');
  });

  it("reads fill-opacity on SVG text only, and leaves out <title>", () => {
    gone('<p>a</p><svg><text style="fill-opacity:0">secret</text></svg>');
    shown('<span style="fill-opacity:0">shown</span>');
    gone("<p>a</p><title>secret</title>");
  });

  it("removes the elements a mail client never renders", () => {
    gone("<dialog>secret</dialog>");
    gone("<datalist><option>secret</option></datalist>");
    gone("<noembed>secret</noembed>");
    gone("<noframes>secret</noframes>");
    gone("<iframe>secret</iframe>");
  });

  it("removes a hidden child of pre and code, which are copied as text", () => {
    const out = api.htmlToMarkdown('<pre>a<span style="display:none">X</span>b<span style="font-size:0">Y</span></pre><code>c<template>Z</template>d</code>');
    assert.equal(out, "```\nab\n```\n\n`cd`");
  });

  it("gives nothing for a link whose text is out of sight, not its URL", () => {
    assert.equal(api.htmlToMarkdown('<p>a</p><div style="font-size:0"><a href="https://evil.example/IGNORE">t</a></div>'), "a");
    assert.equal(api.htmlToMarkdown('<p>a</p><a style="visibility:hidden" href="https://evil.example/IGNORE"><img alt="x" width="100"></a>'), "a");
    assert.equal(api.htmlToMarkdown('<a href="https://example.com/p"></a>'), "https://example.com/p");
  });

  it("drops the alt text of an invisible image", () => {
    assert.equal(api.htmlToMarkdown('<div style="visibility:hidden"><img alt="secret" width="100"></div>'), "");
  });

  it("judges the root element too", () => {
    assert.equal(api.htmlToMarkdown('<html style="display:none"><body>secret</body></html>'), "");
    assert.equal(api.emailHtmlToText('<html style="font-size:0"><body>secret</body></html>'), "");
  });

  it("keeps the first of two style attributes, as HTML does", () => {
    gone('<span style="display:none" style="display:block">secret</span>');
    shown('<span style="display:block" style="display:none">shown</span>');
  });

  it("does not count hidden whitespace", () => {
    const counter = { n: 0 };
    api.htmlToMarkdown('<td style="font-size:0;line-height:0">  </td><div style="display:none"> </div><p>text</p>', counter);
    assert.equal(counter.n, 0);
  });
});

describe("emailHtmlToText", () => {
  it("lays text out as stripHtml does", () => {
    for (const html of [
      "<h1>Heading One</h1><p>Visible <b>bold</b> and <a href=\"https://example.com/\">a link</a>.</p><ul><li>first</li><li>second</li></ul><p>after</p>",
      "<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>",
      "line one<br>line two<br/>line three",
      "<div>x</div><div>y</div>",
    ]) {
      assert.equal(api.emailHtmlToText(html), api.stripHtml(html), html);
    }
  });

  it("leaves out script, style and head, and gives an empty string for no html", () => {
    assert.equal(api.emailHtmlToText("<head><title>t</title></head>a<script>run()</script>b<style>p{}</style>c"), "a b c");
    assert.equal(api.emailHtmlToText(""), "");
    assert.equal(api.emailHtmlToText(null), "");
  });

  it("falls back to stripHtml without DOMParser, and counts there too", () => {
    const counter = { n: 0 };
    assert.equal(noDom.emailHtmlToText('<p>keep</p><div style="display:none">secret</div>', counter), "keep");
    assert.equal(counter.n, 1);
  });

  it("does not count twice when the DOM walk fails and stripHtml takes over", () => {
    for (const convertWith of [throwing.htmlToMarkdown, throwing.emailHtmlToText]) {
      const counter = { n: 2 };
      assert.equal(convertWith('<p>keep</p><div style="display:none">secret</div>', counter), "keep");
      assert.equal(counter.n, 3);
    }
  });
});

describe("without a DOM (stripHtml)", () => {
  it("errs toward removing: an element with font-size:0 or visibility:hidden goes with all it contains", () => {
    assert.doesNotMatch(noDom.htmlToMarkdown(MJML), /Hello from MJML/);
    assert.doesNotMatch(api.stripHtml('<div style="visibility:hidden">a <span style="visibility:visible">secret</span></div>'), /secret/);
    assert.doesNotMatch(api.stripHtml('<div style="font-size:0">secret<!-- font-size: --></div>'), /secret/);
  });

  it("removes the other hidden elements, also matched inside content-visibility and fill-opacity", () => {
    const counter = { n: 0 };
    const text = api.stripHtml('<p hidden>1</p><p style="display:none">2</p><p style="opacity:0">3</p><p style="font-size:0">4</p><p style="visibility:hidden">5</p><template>6</template><p style="content-visibility:hidden">7</p><p style="fill-opacity:0">8</p>ok', counter);
    assert.equal(text, "ok");
    assert.equal(counter.n, 8);
  });

  it("shortens long data: URIs of src, href, background and url() before the size limit is checked, never text or a style", () => {
    const image = "data:image/png;base64," + "A".repeat(3 * 1024 * 1024);
    const html = `<p>visible</p><img src="${image}" alt="logo"><p style="background:url('${image}')">more</p><table><tr><td background=${image}>x</td></tr></table>`;
    assert.equal(api.shortenDataUris(html), `<p>visible</p><img src="data:image/png;base64," alt="logo"><p style="background:url('data:image/png;base64,')">more</p><table><tr><td background=data:image/png;base64,>x</td></tr></table>`);
    const counter = { n: 0 };
    assert.equal(api.htmlToMarkdown(`${html}<div style="font-size:0"><span style="font-size:13px">column</span></div>`, counter), "visible\n\nlogo\n\nmore\n\nx\n\ncolumn");
    const long = "data:" + "B".repeat(2000);
    for (const untouched of [`<p>${long}</p>`, `<span style="${long};display:none">s</span>`, `<span style=${long};display:none>s</span>`,
      `<span style="font-family:'a'${long};display:none">s</span>`]) {
      assert.equal(api.shortenDataUris(untouched), untouched);
    }
  });
});

describe("cssDeclarations, fontSizePx and fontShorthandSize", () => {
  it("splits declarations as a CSS parser does and says which are plain", () => {
    const list = api.cssDeclarations("Display : None !Important; font-family:'a;b'; background:url(x;y); c\\6flor:red; x:/**/y");
    assert.deepEqual(JSON.parse(JSON.stringify(list)), [
      { name: "display", value: "none", important: true, plain: true },
      { name: "font-family", value: "'a;b'", important: false, plain: true },
      { name: "background", value: "url(x;y)", important: false, plain: true },
      { name: "color", value: "red", important: false, plain: false },
      { name: "x", value: "y", important: false, plain: false },
    ]);
  });

  it("gives the size in pixels of a font-size value, from the parent's and the root's", () => {
    const inherited = { ...api.VISIBLE_CONTENT, fontPx: 20, rootPx: 10 };
    const sizes = Object.fromEntries(["0", "0px", "0.0em", "13px", "12pt", "1.5rem", "2vw", "small", "1em", "50%",
      "smaller", "inherit", "revert", "calc(2px)", "12", "12.px", "-1px", "1foo", "big", "constructor"]
      .map(value => [value, api.fontSizePx(value, inherited, false)]));
    assert.deepEqual(sizes, {
      "0": 0, "0px": 0, "0.0em": 0, "13px": 13, "12pt": 16, "1.5rem": 15, "2vw": 51.2, small: 13, "1em": 20, "50%": 10,
      smaller: 20 / 1.2, inherit: 20, revert: 20, "calc(2px)": undefined, "12": 12, "12.px": 12, "-1px": undefined,
      "1foo": undefined, big: undefined, constructor: undefined,
    });
    assert.equal(api.fontSizePx("12", inherited, true), undefined);
    assert.equal(api.fontSizePx("12.px", inherited, true), undefined);
    assert.equal(api.fontSizePx("0", inherited, true), 0);
    assert.deepEqual(["1", "3", "7", "9", "+2", "-1", "-9", "x"].map(api.legacyFontSizePx), [10, 16, 48, 48, 24, 13, 10, undefined]);
  });

  it("reads the size of a font shorthand, strictly only when Gecko takes it", () => {
    const sizes = ["13px/1.4 arial", "bold 14px / 1.2 arial", "italic small-caps 700 1rem serif", "0/0 a", "inherit", "caption",
      "bold 700 12px a", "12px", "normal normal 12px a"].map(value => [api.fontShorthandSize(value, false), api.fontShorthandSize(value, true)]);
    assert.deepEqual(sizes, [["13px", "13px"], ["14px", "14px"], ["1rem", "1rem"], ["0", "0"], ["inherit", "inherit"], ["small", "small"],
      ["12px", undefined], ["12px", undefined], ["12px", "12px"]]);
  });

  it("isHiddenElementNode hides the whole element for the hidden attribute, display:none and an opacity below 0.1", () => {
    const node = attrs => ({ hasAttribute: name => name in attrs, getAttribute: name => (name in attrs ? attrs[name] : null) });
    for (const attrs of [{ hidden: "" }, { style: "display:none" }, { style: "opacity:0" }, { style: "opacity:0.05" }]) {
      assert.equal(api.isHiddenElementNode(node(attrs)), true, JSON.stringify(attrs));
    }
    for (const style of ["visibility:hidden", "font-size:0", "opacity:0.5", "opacity:0.1", "display:block"]) {
      assert.equal(api.isHiddenElementNode(node({ style })), false, style);
    }
    assert.equal(api.isHiddenElementNode({}), false);
  });
});
