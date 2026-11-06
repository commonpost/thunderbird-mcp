// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";
// The HTML to text conversions of api.js: every element htmlToMarkdown knows, the character references stripHtml
// decodes, and the nodes isHiddenElementNode may be given. Node has no DOMParser: a small stand-in parser is used (see
// html-link-schemes.test.cjs); the real one is exercised in the Thunderbird lab.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");

const VOID = new Set(["br", "hr", "img"]);
const element = (tagName, attrs = {}) => ({
  nodeType: 1, tagName: tagName.toUpperCase(), childNodes: [], parentElement: null,
  getAttribute: name => (name in attrs ? attrs[name] : null),
  hasAttribute: name => name in attrs,
  get textContent() { return this.childNodes.map(c => c.textContent).join(""); },
});

// Tags with quoted attributes, text, comments and void tags; no entity decoding
function parse(html) {
  const body = element("body");
  const stack = [body];
  const re = /<!--[\s\S]*?-->|<(\/)?([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    const top = stack[stack.length - 1];
    if (m[0].startsWith("<!--")) {
      top.childNodes.push({ nodeType: 8, textContent: "" });
    } else if (m[4] !== undefined) {
      top.childNodes.push({ nodeType: 3, textContent: m[4] });
    } else if (m[1]) {
      if (stack.length > 1) stack.pop();
    } else {
      const attrs = {};
      for (const a of m[3].matchAll(/([a-zA-Z-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g)) attrs[a[1]] = a[2] ?? a[3] ?? "";
      const node = element(m[2], attrs);
      node.parentElement = top;
      top.childNodes.push(node);
      if (!VOID.has(m[2].toLowerCase())) stack.push(node);
    }
  }
  return body;
}

function load(DOMParser) {
  const sandbox = { DOMParser };
  vm.createContext(sandbox);
  const slice = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
  vm.runInContext(`${slice("// BEGIN STRIP HELPERS", "// END STRIP HELPERS")}\n${slice("// BEGIN HTML HIDDEN CONTENT HELPERS", "// END HTML HIDDEN CONTENT HELPERS")}
const isHiddenElementNode = node => elementHiding(node, typeof node.tagName === "string" ? node.tagName.toLowerCase() : "", VISIBLE_CONTENT).hidden;
this.api = { stripHtml, isHiddenElementNode, htmlToMarkdown };`, sandbox);
  return sandbox.api;
}

const normal = load(class { parseFromString(html) { const body = parse(html); return { body, documentElement: body }; } });
const md = html => normal.htmlToMarkdown(html);

describe("stripHtml decodes numeric character references", () => {
  const strip = html => normal.stripHtml(html);

  it("gives an empty string for no html", () => {
    assert.equal(strip(""), "");
    assert.equal(strip(null), "");
    assert.equal(strip(undefined), "");
  });

  it("reads hexadecimal references with a small or a capital x, and decimal ones", () => {
    assert.equal(strip("a&#x41;b&#X42;c&#67;"), "aAbBcC");
    assert.equal(strip("&#x1F600; &#128512;"), "\u{1F600} \u{1F600}");
  });

  it("leaves a reference to nothing, to a code point that does not exist, or that is not a number, as it is", () => {
    assert.equal(strip("&#x0; &#0; &#x110000; &#1114112; &#abc;"), "&#x0; &#0; &#x110000; &#1114112; &#abc;");
  });

  it("leaves a reference to a name it does not know as it is, and decodes the ones it knows in one pass", () => {
    assert.equal(strip("&unknown; &amp;lt; &eacute;"), "&unknown; &lt; &eacute;");
  });
});

describe("isHiddenElementNode on partial nodes", () => {
  const { isHiddenElementNode } = normal;

  it("takes a node that cannot be asked for attributes for a visible one", () => {
    assert.equal(isHiddenElementNode({}), false);
    assert.equal(isHiddenElementNode({ hasAttribute: () => false }), false);
  });

  it("reads the style of a node that has no hasAttribute", () => {
    assert.equal(isHiddenElementNode({ getAttribute: name => (name === "style" ? "color:red; display: none" : null) }), true);
    assert.equal(isHiddenElementNode({ getAttribute: () => null }), false);
  });

  it("the hidden attribute alone hides, whatever the style", () => {
    assert.equal(isHiddenElementNode({ hasAttribute: name => name === "hidden", getAttribute: () => "" }), true);
  });
});

describe("htmlToMarkdown, element by element", () => {
  it("drops script, style and head, and keeps what is around them", () => {
    assert.equal(md("x<script>alert(1)</script><style>p{}</style><head><title>t</title></head>y"), "xy");
  });

  it("turns br into a line break and hr into a rule", () => {
    assert.equal(md("a<br>b"), "a\nb");
    assert.equal(md("a<hr>b"), "a\n\n---\n\nb");
  });

  it("turns h1 to h6 into the Markdown headings of the same level", () => {
    for (let level = 1; level <= 6; level++) assert.equal(md(`<h${level}>Title</h${level}>`), `${"#".repeat(level)} Title`);
    assert.equal(md("<h1>Title</h1><p>Body</p>"), "# Title\n\nBody");
  });

  it("makes paragraphs and sections blocks of their own", () => {
    assert.equal(md("<section>a</section><article>b</article><div>c</div>"), "a\n\nb\n\nc");
  });

  it("marks bold and italic, and writes nothing for an empty one", () => {
    assert.equal(md("<b>bold</b> <strong>strong</strong> <em>em</em> <i>it</i>"), "**bold** **strong** *em* *it*");
    assert.equal(md("a<b> </b><i></i><strong></strong><em></em>b"), "ab");
  });

  it("writes a link as text and address, as the address alone when the text is the address or empty", () => {
    assert.equal(md('<a href="https://x.test/p">site</a>'), "[site](https://x.test/p)");
    assert.equal(md('<a href="https://x.test/p">https://x.test/p</a>'), "https://x.test/p");
    assert.equal(md('<a href="https://x.test/p"></a>'), "https://x.test/p");
    assert.equal(md('<a href="javascript:alert(1)">click</a>'), "click");
  });

  it("writes an image as its alt text, nothing for a tracking pixel, whichever side is tiny", () => {
    assert.equal(md('<img alt="logo" width="100" height="50">'), "logo");
    assert.equal(md('<img alt="logo">'), "logo");
    assert.equal(md('<img alt="logo" width="0" height="0">'), "logo");
    assert.equal(md('<img alt="pixel" width="2">'), "");
    assert.equal(md('<img alt="pixel" height="1">'), "");
    assert.equal(md('<img alt="pixel" width="100" height="3">'), "");
    assert.equal(md('<img src="https://t.test/p.gif">'), "");
  });

  it("writes code inline and a pre block fenced", () => {
    assert.equal(md("a <code>x = 1</code> b"), "a `x = 1` b");
    assert.equal(md("<pre>line1\nline2</pre>"), "```\nline1\nline2\n```");
  });

  it("quotes every line of a blockquote", () => {
    assert.equal(md("<blockquote>one\ntwo</blockquote>"), "> one\n> two");
  });

  it("writes a bulleted list with dashes, a numbered one with 1., one item to a line", () => {
    assert.equal(md("<ul><li>a</li><li>b</li></ul>"), "- a\n- b");
    assert.equal(md("<ol><li>a</li><li>b</li></ol>"), "1. a\n1. b");
  });

  it("takes a list item with no parent for a bullet", () => {
    const orphan = element("li");
    orphan.childNodes.push({ nodeType: 3, textContent: "alone" });
    const lone = load(class { parseFromString() { return { body: orphan, documentElement: orphan }; } });
    assert.equal(lone.htmlToMarkdown("<li>alone</li>"), "- alone");
  });

  it("flattens a table to lines of cells, with its head, body and foot", () => {
    assert.equal(md("<table><thead><tr><th>H1</th><th>H2</th></tr></thead><tbody><tr><td>a</td><td>b</td></tr></tbody><tfoot><tr><td>f</td></tr></tfoot></table>"), "H1 H2\na b\nf");
  });

  it("reads the children of an element it has no rule for, and passes comments over", () => {
    assert.equal(md("<span>a</span><!-- hidden comment --><custom-x>b</custom-x>"), "ab");
  });

  it("counts what is hidden and leaves it out", () => {
    const counter = { n: 0 };
    assert.equal(normal.htmlToMarkdown('shown<div hidden>secret</div><template>t</template><p style="display:none">s</p>', counter), "shown");
    assert.equal(counter.n, 3);
  });

  it("reads the document element when the parser gives no body", () => {
    const root = parse("<p>from the root</p>");
    const noBody = load(class { parseFromString() { return { body: null, documentElement: root }; } });
    assert.equal(noBody.htmlToMarkdown("<p>from the root</p>"), "from the root");
  });
});
