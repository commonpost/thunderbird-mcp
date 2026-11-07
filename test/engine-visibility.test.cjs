// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";
// extension/engine-visibility.js, the background-page side of the hidden-text engine: the checks that keep a message's
// URLs from loading, the job check, the units of a document and the judge that reads a rendered frame. The file runs
// here in a vm context whose DOM classes are the small fakes below; the rendering itself (a sandboxed frame in a real
// Thunderbird) is covered by the lab scenarios. The api.js side has its own tests (hidden-text-engine.test.cjs).
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../extension/engine-visibility.js"), "utf8");

// A small DOM, as far as engine-visibility.js reads it. The file takes every property from the prototypes of the
// global's classes (domAccess), so the fakes define them as prototype getters and methods.
const HTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";
const VOID = new Set(["br", "hr", "img", "input", "meta", "link"]);

// A DOMRect: what getBoundingClientRect and getClientRects give
const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
const DEFAULT_RECT = rect(0, 0, 200, 50);
const DEFAULT_TEXT_RECTS = [rect(10, 10, 80, 16)];

// What getComputedStyle gives an element nobody styled; each element's `style` field overrides it
const DEFAULT_STYLE = {
  display: "block", visibility: "visible", opacity: "1", filter: "none", fontSize: "16px", color: "rgb(0, 0, 0)",
  backgroundColor: "rgba(0, 0, 0, 0)", backgroundImage: "none", overflowX: "visible", overflowY: "visible",
  position: "static", transform: "none", contain: "none", clip: "auto", clipPath: "none", contentVisibility: "visible",
  fill: "rgb(0, 0, 0)", fillOpacity: "1", stroke: "none", strokeWidth: "1px", strokeOpacity: "1", textShadow: "none",
  webkitTextStrokeWidth: "0px",
};

class FakeNode {
  constructor(type) {
    this._type = type;
    this._parent = null;
    this._kids = [];
  }
  get parentElement() { return this._parent; }
  get nodeType() { return this._type; }
  get childNodes() { return this._kids; }
  get textContent() { return this._kids.filter(k => k._type !== 8).map(k => k.textContent).join(""); }
  contains(other) {
    for (let n = other; n; n = n._parent) if (n === this) return true;
    return false;
  }
}

class FakeCharacterData extends FakeNode {
  constructor(type, data) {
    super(type);
    this._data = data;
  }
  get data() { return this._data; }
  get textContent() { return this._data; }
}
class FakeText extends FakeCharacterData {
  constructor(data, rects) {
    super(3, data);
    this._rects = rects || DEFAULT_TEXT_RECTS;
  }
}
class FakeComment extends FakeCharacterData {
  constructor(data) { super(8, data); }
}

class FakeAttr {
  constructor(name, value) {
    this._name = name;
    this._value = value;
  }
  get name() { return this._name; }
  get value() { return this._value; }
  set value(v) { this._value = String(v); }
}

class FakeElement extends FakeNode {
  // opts: attrs (name -> value), ns, visible (what checkVisibility says), style (computed style overrides), rect (the
  // element's box), rects (its client rects, one box by default), client ({ left, top, width, height }: the padding
  // box, the border box by default)
  constructor(tag, opts = {}) {
    super(1);
    this._tag = tag;
    this._ns = opts.ns || HTML_NS;
    this._attrs = Object.entries(opts.attrs || {}).map(([name, value]) => new FakeAttr(name, value));
    this._visible = opts.visible !== false;
    this._style = opts.style || {};
    this._rect = opts.rect || DEFAULT_RECT;
    this._rectList = opts.rects || null;
    this._client = opts.client || null;
  }
  get localName() { return this._tag; }
  get namespaceURI() { return this._ns; }
  get children() { return this._kids.filter(k => k._type === 1); }
  get attributes() { return this._attrs; }
  get clientLeft() { return this._client ? this._client.left : 0; }
  get clientTop() { return this._client ? this._client.top : 0; }
  get clientWidth() { return (this._client || this._rect).width; }
  get clientHeight() { return (this._client || this._rect).height; }
  getAttribute(name) {
    const attr = this._attrs.find(a => a._name === name);
    return attr ? attr._value : null;
  }
  hasAttribute(name) { return this._attrs.some(a => a._name === name); }
  toggleAttribute(name, force) {
    const present = this.hasAttribute(name);
    const want = force === undefined ? !present : Boolean(force);
    if (want && !present) this._attrs.push(new FakeAttr(name, ""));
    if (!want && present) this._attrs = this._attrs.filter(a => a._name !== name);
    return want;
  }
  // Only the selectors engine-visibility.js uses
  closest(selector) {
    const matches = {
      "details:not([open])": n => n._tag === "details" && !n.hasAttribute("open"),
      "[href]": n => n.hasAttribute("href"),
    }[selector];
    if (!matches) throw new Error(`the fake closest() does not know ${selector}`);
    for (let n = this; n; n = n._parent) if (matches(n)) return n;
    return null;
  }
  checkVisibility() { return this._visible; }
  getBoundingClientRect() { return this._rect; }
  getClientRects() { return this._rectList || [this._rect]; }
}

class FakeImage extends FakeElement {
  get naturalWidth() { return 1; }
  decode() { return Promise.resolve(); }
}

class FakeDocument extends FakeNode {
  constructor(root, body, view) {
    super(9);
    this._root = root;
    this._body = body;
    this._view = view;
    this._sheets = [];
    this._kids.push(root);
  }
  get defaultView() { return this._view; }
  get documentElement() { return this._root; }
  get body() { return this._body; }
  get images() { return this._all().filter(n => n._tag === "img"); }
  get adoptedStyleSheets() { return this._sheets; }
  _all() {
    const all = [];
    const walk = n => {
      if (n._type !== 1) return;
      all.push(n);
      n._kids.forEach(walk);
    };
    walk(this._root);
    return all;
  }
  // Only the selectors engine-visibility.js uses
  querySelectorAll(selector) {
    if (selector === "*") return this._all();
    if (selector === "link") return this._all().filter(n => n._tag === "link");
    throw new Error(`the fake querySelectorAll() does not know ${selector}`);
  }
  // The elements at a point, topmost first, as a test sets them (none by default: hit testing cannot tell)
  elementsFromPoint(x, y) { return this._hits ? this._hits(x, y) : []; }
  createRange() {
    let target = null;
    return {
      selectNodeContents(node) { target = node; },
      getClientRects() { return target._rects; },
    };
  }
}

function fakeWindow(width, height) {
  return {
    innerWidth: width, innerHeight: height, scrollX: 0, scrollY: 0,
    getComputedStyle(node) {
      const style = { ...DEFAULT_STYLE, ...node._style };
      // -webkit-text-fill-color computes to the colour itself unless it is set
      if (!("webkitTextFillColor" in node._style)) style.webkitTextFillColor = style.color;
      return style;
    },
  };
}

function append(parent, kid) {
  kid._parent = parent;
  parent._kids.push(kid);
  return parent;
}
const txt = (data, rects) => new FakeText(data, rects);
const comment = data => new FakeComment(data);
function el(tag, opts = {}, ...kids) {
  const node = new FakeElement(tag, opts);
  for (const kid of kids) append(node, typeof kid === "string" ? txt(kid) : kid);
  return node;
}
// A document of the given size: html > (head, body > kids)
function page(kids, { head = [], root, body, width = 800, height = 600 } = {}) {
  const bodyEl = el("body", { style: body }, ...kids);
  const rootEl = el("html", { style: root }, el("head", {}, ...head), bodyEl);
  return new FakeDocument(rootEl, bodyEl, fakeWindow(width, height));
}
// HTML as text to a fake document (html > body only), for the cases of engineUnits
function parse(html) {
  const body = el("body");
  const root = el("html", {}, body);
  const stack = [body];
  const re = /<!--[\s\S]*?-->|<(\/)?([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    const top = stack[stack.length - 1];
    if (m[0].startsWith("<!--")) append(top, comment(""));
    else if (m[4] !== undefined) append(top, txt(m[4]));
    else if (m[1]) {
      if (stack.length > 1) stack.pop();
    } else {
      const attrs = {};
      for (const a of m[3].matchAll(/([a-zA-Z-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g)) attrs[a[1]] = a[2] ?? a[3] ?? "";
      const node = el(m[2].toLowerCase(), { attrs });
      append(top, node);
      if (!VOID.has(m[2].toLowerCase())) stack.push(node);
    }
  }
  return new FakeDocument(root, body, fakeWindow(800, 600));
}

// engine-visibility.js in a context of its own, with the fake classes as the DOM and no `browser`: it does not
// register its listener
function load(extra = {}) {
  const sandbox = {
    Document: FakeDocument, Node: FakeNode, Element: FakeElement, CharacterData: FakeCharacterData,
    HTMLImageElement: FakeImage, Attr: FakeAttr, atob, ...extra,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  assert.ok(sandbox.commonpostEngineVisibility, "engine-visibility.js sets its global");
  return { sandbox, api: sandbox.commonpostEngineVisibility };
}

const { sandbox, api: V } = load();
const dom = V.domAccess(sandbox);
const SAFE = new Set(["http", "https", "data"]);
const SAFE_SHEET = new Set(["http", "https", "data", "chrome"]);

describe("inertUrl", () => {
  it("leaves http, https and data URLs alone", () => {
    for (const url of ["http://example.test/a.png", "https://example.test/a.png", "HTTPS://EXAMPLE.TEST/A",
      "data:image/png;base64,AAAA"]) {
      assert.equal(V.inertUrl(url, SAFE), null, url);
    }
  });

  it("gives a mailbox: URL a scheme of the same length that no handler takes", () => {
    assert.equal(V.inertUrl("mailbox:///x", SAFE), "x------:///x");
  });

  it("does the same for imap, news, cid, file, chrome and other schemes, keeping the length", () => {
    for (const [url, inert] of [
      ["imap://user@example.test/INBOX", "x---://user@example.test/INBOX"],
      ["news://news.example.test/group", "x---://news.example.test/group"],
      ["cid:logo@example.test", "x--:logo@example.test"],
      ["file:///tmp/a.png", "x---:///tmp/a.png"],
      ["chrome://messagebody/skin/a.png", "x-----://messagebody/skin/a.png"],
      ["javascript:void(0)", "x---------:void(0)"],
      ["MAILBOX:///x", "x------:///x"],
    ]) {
      assert.equal(V.inertUrl(url, SAFE), inert, url);
      assert.equal(inert.length, url.length, url);
    }
  });

  it("reads the URL as the URL parser does: edge controls and spaces dropped, tabs and newlines removed", () => {
    assert.equal(V.inertUrl("  \u0001mailbox:///x", SAFE), "x------:///x");
    assert.equal(V.inertUrl("\u0000mailbox:///x \n", SAFE), "x------:///x");
    assert.equal(V.inertUrl("mail\tbox:\n///x", SAFE), "x------:///x");
    assert.equal(V.inertUrl("\nmai\r\nlbox:///x", SAFE), "x------:///x");
    assert.equal(V.inertUrl(" \t http://example.test/ \n", SAFE), null);
  });

  it("leaves a relative URL and a URL that is already inert alone", () => {
    for (const url of ["/a/b.png", "a.png", "//example.test/a.png", "#fragment", "?a=b:c", "dir/file:name.png", "",
      "x------:///x", "x---://example.test/a", "x:a"]) {
      assert.equal(V.inertUrl(url, SAFE), null, JSON.stringify(url));
    }
  });

  it("lets chrome: stay when the set of the style sheets is given, and still refuses the message schemes", () => {
    const sheet = "chrome://messagebody/skin/messageBody.css";
    assert.equal(V.inertUrl(sheet, SAFE_SHEET), null);
    assert.equal(V.inertUrl(sheet, SAFE), "x-----://messagebody/skin/messageBody.css");
    assert.equal(V.inertUrl("mailbox:///x", SAFE_SHEET), "x------:///x");
  });
});

describe("inertSrcset", () => {
  it("rewrites only the unsafe candidates", () => {
    assert.equal(V.inertSrcset("https://example.test/a.png 1x, mailbox:///b.png 2x"),
      "https://example.test/a.png 1x, x------:///b.png 2x");
  });

  it("keeps a data: URL with commas intact", () => {
    assert.equal(V.inertSrcset("data:image/png;base64,AAAA,BBBB 1x, mailbox:///a.png 2x"),
      "data:image/png;base64,AAAA,BBBB 1x, x------:///a.png 2x");
  });

  it("keeps the descriptors and the separators, and reads a URL followed by a comma", () => {
    assert.equal(V.inertSrcset("cid:a 1x,imap://example.test/b 320w ,  https://example.test/c.png"),
      "x--:a 1x,x---://example.test/b 320w ,  https://example.test/c.png");
    assert.equal(V.inertSrcset("mailbox:///a.png, https://example.test/b.png 2x"), "x------:///a.png, https://example.test/b.png 2x");
    assert.equal(V.inertSrcset("https://example.test/a.png, mailbox:///b.png 2x"), "https://example.test/a.png, x------:///b.png 2x");
  });

  it("answers null when nothing changes", () => {
    assert.equal(V.inertSrcset("a.png 1x, https://example.test/b.png 2x, data:image/gif;base64,R0lG 3x"), null);
    assert.equal(V.inertSrcset(""), null);
  });
});

describe("cssLoadsUnsafeUrl", () => {
  it("finds a url() that is not http, https or data", () => {
    assert.equal(V.cssLoadsUnsafeUrl("a{background:url(mailbox:///x)}"), true);
    assert.equal(V.cssLoadsUnsafeUrl("a{background:url( 'imap://example.test/x' )}"), true);
    assert.equal(V.cssLoadsUnsafeUrl("a{background:URL(MAILBOX:///x)}"), true);
    assert.equal(V.cssLoadsUnsafeUrl("a{background:url(chrome://messagebody/skin/a.png)}"), true);
  });

  it("lets http, https and data URLs through", () => {
    assert.equal(V.cssLoadsUnsafeUrl("a{background:url(\"http://example.test/a.png\")}"), false);
    assert.equal(V.cssLoadsUnsafeUrl("a{background:url(https://example.test/a.png)}"), false);
    assert.equal(V.cssLoadsUnsafeUrl("a{background:url(data:image/png;base64,AAAA)}"), false);
    assert.equal(V.cssLoadsUnsafeUrl("a{background:url(a.png)}"), false);
  });

  it("reads CSS escapes as CSS does", () => {
    assert.equal(V.cssLoadsUnsafeUrl(String.raw`a{background:url(\6d ailbox:///x)}`), true);
    assert.equal(V.cssLoadsUnsafeUrl(String.raw`a{background:url("\6d ailbox:///x")}`), true);
    assert.equal(V.cssLoadsUnsafeUrl(String.raw`a{background:url(\6D AILBOX:///x)}`), true);
    assert.equal(V.cssLoadsUnsafeUrl(String.raw`a{background:url(\mailbox:///x)}`), true);
    assert.equal(V.cssLoadsUnsafeUrl(String.raw`a{background:url(h\74 tps://example.test/a.png)}`), false);
  });

  it("finds an @import of an unsafe URL", () => {
    assert.equal(V.cssLoadsUnsafeUrl("@import \"imap://example.test/x\";"), true);
    assert.equal(V.cssLoadsUnsafeUrl("@import 'cid:x';"), true);
    assert.equal(V.cssLoadsUnsafeUrl("@import \"https://example.test/a.css\";"), false);
  });

  it("finds an unsafe URL in image-set()", () => {
    assert.equal(V.cssLoadsUnsafeUrl("a{background-image:image-set(\"cid:x\" 1x)}"), true);
    assert.equal(V.cssLoadsUnsafeUrl("a{background-image:-webkit-image-set(\"https://example.test/a.png\" 1x, 'cid:x' 2x)}"), true);
    assert.equal(V.cssLoadsUnsafeUrl("a{background-image:image-set(\"https://example.test/a.png\" 1x)}"), false);
  });

  it("ignores comments and rules that load nothing", () => {
    assert.equal(V.cssLoadsUnsafeUrl("a{/* url(mailbox:///x) */color:red}"), false);
    assert.equal(V.cssLoadsUnsafeUrl("a:hover{color:red}"), false);
    assert.equal(V.cssLoadsUnsafeUrl("a[href^=\"mailbox:\"]{color:red}"), false);
    assert.equal(V.cssLoadsUnsafeUrl(""), false);
  });
});

describe("inertHtml", () => {
  // The document Thunderbird's MIME code writes: doctype, its style sheet, header table, the message in a wrapper
  const libmime = body => "<!DOCTYPE html>\n<html><head><meta http-equiv=\"Content-Type\" content=\"text/html; charset=UTF-8\">"
    + "<link rel=\"important stylesheet\" href=\"chrome://messagebody/skin/messageBody.css\"></head>"
    + "<body><table class=\"header-part1\"><tr><td>Subject</td><td>Hello</td></tr></table>"
    + `<div class="moz-text-html" lang="">${body}</div></body></html>`;

  it("rewrites the attributes a load starts from, in the document libmime writes, and says which it changed", () => {
    const out = V.inertHtml(libmime("<img src=\"mailbox:///Mail/Inbox?number=2&amp;part=1.2\" alt=\"Logo\" "
      + "srcset=\"imap://u@example.test/x 1x, https://example.test/b.png 2x\">"
      + "<table background=\"cid:bg@example.test\"><tr><td>t</td></tr></table>"
      + "<video poster=\"news://example.test/p\"></video>"
      + "<object data=\"file:///tmp/x.swf\"></object>"
      + "<link rel=\"icon\" href=\"imap://example.test/i\">"
      + "<svg><image xlink:href=\"mailbox:///z\"></image></svg>"));
    assert.ok(out.html.startsWith("<!DOCTYPE html>\n<html><head>"));
    for (const expected of [
      "src=\"x------:///Mail/Inbox?number=2&amp;part=1.2\"",
      "srcset=\"x---://u@example.test/x 1x, https://example.test/b.png 2x\"",
      "background=\"x--:bg@example.test\"",
      "poster=\"x---://example.test/p\"",
      "data=\"x---:///tmp/x.swf\"",
      "<link rel=\"icon\" href=\"x---://example.test/i\">",
      "xlink:href=\"x------:///z\"",
    ]) {
      assert.ok(out.html.includes(expected), expected);
    }
    assert.doesNotMatch(out.html, /mailbox:|imap:|news:|cid:|file:/);
    assert.deepEqual(Array.from(out.changed).sort(), ["background", "data", "href", "poster", "src", "srcset", "xlink:href"]);
  });

  it("keeps Thunderbird's own style sheet link and the href of a link a reader follows", () => {
    const html = libmime("<a href=\"mailbox:///Mail/Inbox?number=3\">older message</a><area href=\"imap://example.test/a\">");
    const out = V.inertHtml(html);
    assert.equal(out.html, html);
    assert.equal(out.changed.size, 0);
    assert.ok(out.html.includes("<link rel=\"important stylesheet\" href=\"chrome://messagebody/skin/messageBody.css\">"));
  });

  it("makes inert a style sheet link that is not Thunderbird's, and chrome: anywhere else", () => {
    const out = V.inertHtml("<link rel=stylesheet href=\"mailbox:///s.css\"><link rel=\"stylesheet\" href=\"https://example.test/s.css\">"
      + "<img src=\"chrome://messagebody/skin/a.png\">");
    assert.equal(out.html, "<link rel=stylesheet href=\"x------:///s.css\"><link rel=\"stylesheet\" href=\"https://example.test/s.css\">"
      + "<img src=\"x-----://messagebody/skin/a.png\">");
    assert.deepEqual(Array.from(out.changed).sort(), ["href", "src"]);
  });

  it("keeps alt and title text as written, entities included", () => {
    const html = "<img alt=\"a &lt;b&gt; &amp; &quot;c&quot; mailbox:///x\" title='cid:y &amp; z' src=\"mailbox:///x\">";
    assert.equal(V.inertHtml(html).html,
      "<img alt=\"a &lt;b&gt; &amp; &quot;c&quot; mailbox:///x\" title='cid:y &amp; z' src=\"x------:///x\">");
  });

  it("reads &amp; and character references in a value as the HTML parser does", () => {
    assert.equal(V.inertHtml("<img src=\"mailbox:///a?x=1&amp;y=2\">").html, "<img src=\"x------:///a?x=1&amp;y=2\">");
    assert.equal(V.inertHtml("<img src=\"&#109;ailbox:///a\">").html, "<img src=\"x------:///a\">");
    assert.equal(V.inertHtml("<img src=\"&#x6D;AILBOX:///a\">").html, "<img src=\"x------:///a\">");
    const safe = "<img src=\"https://example.test/a?x=1&amp;y=2\">";
    assert.equal(V.inertHtml(safe).html, safe);
  });

  it("handles single-quoted and unquoted values, upper case names and a > inside another value", () => {
    assert.equal(V.inertHtml("<img src='mailbox:///a'>").html, "<img src=\"x------:///a\">");
    assert.equal(V.inertHtml("<img src=mailbox:///b>").html, "<img src=\"x------:///b\">");
    assert.equal(V.inertHtml("<IMG SRC=imap://example.test/x>").html, "<IMG SRC=\"x---://example.test/x\">");
    assert.equal(V.inertHtml("<img alt=\"a > b\" src=\"mailbox:///a\">").html, "<img alt=\"a > b\" src=\"x------:///a\">");
    assert.equal(V.inertHtml("<img src = \"cid:a\"\n  width=\"3\">").html, "<img src = \"x--:a\"\n  width=\"3\">");
  });

  it("leaves text and attributes without a value alone", () => {
    const html = "<p>src=\"mailbox:///x\" in text</p><img src><img src=\"\">";
    const out = V.inertHtml(html);
    assert.equal(out.html, html);
    assert.equal(out.changed.size, 0);
  });
});

describe("checkLoads", () => {
  // "ok" or the error
  const verdict = (d, changed = []) => {
    const result = V.checkLoads(d, dom, new Set(changed));
    return result.ok ? "ok" : result.error;
  };

  it("says ok for a clean document", () => {
    const d = page([
      el("p", { attrs: { style: "color:red;background:url(https://example.test/a.png)" } }, "Hello"),
      el("img", { attrs: { src: "https://example.test/a.png", srcset: "data:image/gif;base64,R0lG 1x" } }),
      el("a", { attrs: { href: "mailbox:///Mail/Inbox?number=3" } }, "older message"),
    ], { head: [
      el("meta", { attrs: { "http-equiv": "Content-Type", content: "text/html" } }),
      el("link", { attrs: { rel: "important stylesheet", href: "chrome://messagebody/skin/messageBody.css" } }),
      el("style", {}, "p{color:red} a:hover{color:blue} img[alt^=\"x\"]{display:none}"),
    ] });
    assert.equal(verdict(d), "ok");
  });

  it("refuses a srcdoc frame", () => {
    assert.equal(verdict(page([el("iframe", { attrs: { srcdoc: "<p>x</p>" } })])), "srcdoc frame");
  });

  it("refuses a style attribute that loads an unsafe URL", () => {
    assert.equal(verdict(page([el("p", { attrs: { style: "background:url(mailbox:///x)" } })])), "message URL in a style");
    assert.equal(verdict(page([el("p", { attrs: { style: "background:url(\\6d ailbox:///x)" } })])), "message URL in a style");
    assert.equal(verdict(page([el("rect", { ns: SVG_NS, attrs: { fill: "url(imap:///x)" } })])), "message URL in a style");
  });

  it("refuses a style sheet that loads an unsafe URL", () => {
    assert.equal(verdict(page([], { head: [el("style", {}, "p{background:url(cid:x@example.test)}")] })), "message URL in a style sheet");
    assert.equal(verdict(page([el("style", {}, "@import \"imap:///x\";")])), "message URL in a style sheet");
    assert.equal(verdict(page([el("style", {}, "a{background-image:image-set(\"cid:x\" 1x)}")])), "message URL in a style sheet");
  });

  it("refuses a message URL left in an attribute a load starts from", () => {
    assert.equal(verdict(page([el("img", { attrs: { src: "mailbox:///x" } })])), "message URL left in src");
    assert.equal(verdict(page([el("img", { attrs: { src: "mail\tbox:///x" } })])), "message URL left in src");
    assert.equal(verdict(page([el("img", { attrs: { srcset: "https://example.test/a.png 1x, imap:///x 2x" } })])), "message URL left in srcset");
    assert.equal(verdict(page([el("video", { attrs: { poster: "cid:x" } })])), "message URL left in poster");
    assert.equal(verdict(page([], { head: [el("link", { attrs: { rel: "icon", href: "chrome://messagebody/skin/a.png" } })] })),
      "message URL left in href");
    assert.equal(verdict(page([], { head: [el("link", { attrs: { rel: "stylesheet", href: "mailbox:///x" } })] })),
      "message URL left in href");
  });

  it("refuses a <meta> that gives a Link header", () => {
    for (const value of ["Link", " link ", "LINK"]) {
      assert.equal(verdict(page([], { head: [el("meta", { attrs: { "http-equiv": value, content: "</a.css>; rel=preload" } })] })),
        "meta Link", value);
    }
  });

  it("refuses a <meta> refresh to a message URL, and lets one to a page or none pass", () => {
    const meta = content => page([], { head: [el("meta", { attrs: { "http-equiv": "Refresh", content } })] });
    assert.equal(verdict(meta("0; url=mailbox:///x?number=1")), "meta refresh");
    assert.equal(verdict(meta("0;URL='imap://example.test/x'")), "meta refresh");
    assert.equal(verdict(meta("0; url=https://example.test/")), "ok");
    assert.equal(verdict(meta("30")), "ok");
  });

  it("refuses SVG animation, which sets attributes once the checks are done", () => {
    for (const tag of ["set", "animate", "animateTransform", "animateMotion"]) {
      const d = page([el("svg", {}, el(tag.toLowerCase(), { attrs: { attributeName: "href", to: "x" } }))]);
      assert.equal(verdict(d), "SVG animation", tag);
    }
  });

  it("refuses a selector on an attribute that was changed", () => {
    const d = css => page([el("img", { attrs: { src: "x------:///x" } })], { head: [el("style", {}, css)] });
    for (const css of ["img[src^=\"x\"]{display:none}", "img[src]{display:none}", "[ SRC ~= x ]{display:none}",
      "img[src=\"x\" i]{display:none}", "img[\\73 rc^=x]{display:none}", "svg|img[*|src$=x]{display:none}"]) {
      assert.equal(verdict(d(css), ["src"]), "selector on src", css);
    }
    assert.equal(verdict(d("use[xlink|href]{display:none}"), ["xlink:href"]), "selector on xlink:href");
  });

  it("refuses attr() in a style sheet once an attribute was changed", () => {
    const d = page([el("img", { attrs: { src: "x------:///x" } })], { head: [el("style", {}, "p::after{content:attr(title)}")] });
    assert.equal(verdict(d, ["src"]), "attr() in a style sheet");
    assert.equal(verdict(d), "ok", "nothing changed: the selectors see what the pane shows");
  });

  it("says ok when the style sheet selects other attributes", () => {
    const d = page([el("img", { attrs: { src: "x------:///x" } })], { head: [el("style", {},
      "img[alt^=\"x\"]{a:b} img[srcset]{a:b} [data-src]{a:b} img[title=\"src\"]{a:b} p::after{content:\"src\"}")] });
    assert.equal(verdict(d, ["src"]), "ok");
    assert.equal(verdict(page([el("img", { attrs: { src: "x------:///x" } })], { head: [el("style", {}, "img[src]{a:b}")] })), "ok");
  });
});

describe("checkJob", () => {
  const job = (more = {}) => ({ html: "<p>x</p>", width: 800, height: 600, parts: [], ...more });

  it("accepts a good job", () => {
    assert.equal(V.checkJob(job()), null);
    assert.equal(V.checkJob(job({ width: 100, height: 10000 })), null);
    assert.equal(V.checkJob(job({ parts: [["mailbox:///Mail/Inbox?number=2&part=1.2", "data:image/png;base64,AAAA"]] })), null);
  });

  it("refuses what is not an object", () => {
    for (const bad of [undefined, null, 0, 5, "job", true]) assert.equal(V.checkJob(bad), "no job", String(bad));
  });

  it("refuses a job without html", () => {
    for (const html of [undefined, "", 5, null, ["<p>"]]) assert.equal(V.checkJob(job({ html })), "no html", String(html));
    const noHtml = job();
    delete noHtml.html;
    assert.equal(V.checkJob(noHtml), "no html");
  });

  it("refuses a width or a height that is not an integer from 100 to 10000", () => {
    for (const side of ["width", "height"]) {
      for (const bad of [99, 10001, 100.5, "800", NaN, Infinity, null, undefined, -800]) {
        assert.equal(V.checkJob(job({ [side]: bad })), `bad ${side}`, `${side} ${String(bad)}`);
      }
    }
  });

  it("refuses parts that are not a list", () => {
    for (const parts of [undefined, null, "parts", {}, 0]) assert.equal(V.checkJob(job({ parts })), "bad parts", String(parts));
  });

  it("refuses a part that is not a [url, data:image/ URL] pair", () => {
    for (const part of ["data:image/png;base64,AAAA", [], [1, "data:image/png;base64,AAAA"], ["mailbox:///x", 5],
      ["mailbox:///x", "https://example.test/a.png"], ["mailbox:///x", "data:text/html,<p>x"], ["mailbox:///x"], null]) {
      assert.equal(V.checkJob(job({ parts: [["mailbox:///x", "data:image/png;base64,AAAA"], part] })), "bad part", JSON.stringify(part));
    }
  });
});

describe("frameHtml", () => {
  const html = V.frameHtml();
  const meta = name => new RegExp(`<meta http-equiv="${name}" content="([^"]*)">`).exec(html);

  it("has the doctype and an empty body", () => {
    assert.ok(html.startsWith("<!DOCTYPE html><html><head>"));
    assert.ok(html.endsWith("</head><body></body></html>"));
    assert.doesNotMatch(html, /<script|<style|<link|<img|<iframe/i);
  });

  it("starts with a policy that forbids everything but data: images and Thunderbird's own style sheets", () => {
    const policy = meta("Content-Security-Policy");
    assert.ok(policy, "a CSP meta");
    assert.deepEqual(policy[1].split(/;\s*/), ["default-src 'none'", "img-src data:",
      "style-src 'unsafe-inline' chrome://messagebody/skin/ chrome://messenger/skin/"]);
    assert.ok(html.indexOf(policy[0]) < html.indexOf("</head>"));
  });

  it("turns DNS prefetching off", () => {
    assert.equal(meta("x-dns-prefetch-control")[1], "off");
  });
});

describe("domAccess", () => {
  it("reads properties and methods from the prototypes, so that a named item cannot shadow them", () => {
    const inner = el("p", { attrs: { alt: "a" } }, "x");
    // <form><input name="localName"> ...: a form's named controls shadow the properties of the form itself
    const form = el("form", {}, inner);
    for (const name of ["localName", "childNodes", "getAttribute", "parentElement", "nodeType", "attributes"]) {
      Object.defineProperty(form, name, { value: "shadow" });
    }
    assert.equal(dom.EL.localName.call(form), "form");
    assert.equal(dom.NODE.childNodes.call(form).length, 1);
    assert.equal(dom.NODE.nodeType.call(form), 1);
    assert.equal(dom.NODE.parentElement.call(inner), form);
    assert.equal(dom.EL.getAttribute.call(inner, "alt"), "a");
    assert.deepEqual(Array.from(V.units(page([form]), dom), u => u.key), ["x"]);
  });

  it("gives access to attributes, their values and their setter", () => {
    const link = el("a", { attrs: { href: "x" } }, "t");
    const [attr] = Array.from(dom.EL.attributes.call(link));
    assert.equal(dom.ATTR.name.call(attr), "href");
    assert.equal(dom.ATTR.value.call(attr), "x");
    dom.ATTR.setValue.call(attr, "y");
    assert.equal(dom.EL.getAttribute.call(link, "href"), "y");
    assert.equal(dom.EL.closest.call(link, "[href]"), link);
    assert.equal(dom.EL.hasAttribute.call(link, "shrinktofit"), false);
    dom.EL.toggleAttribute.call(link, "shrinktofit", true);
    assert.equal(dom.EL.hasAttribute.call(link, "shrinktofit"), true);
    assert.equal(dom.NODE.textContent.call(link), "t");
  });
});

describe("units", () => {
  const keysOf = html => Array.from(V.units(parse(html), dom), u => u.key);

  it("gives the runs of text with more than white space, images and links, in document order", () => {
    assert.deepEqual(keysOf("<p>one</p> <div>two<b>three</b></div><img alt=\"pic\"><a href=\"x\">four</a>"),
      ["one", "two", "three", "\u0000img\u0000pic", "\u0000a", "four"]);
  });

  it("leaves out the elements whose text is never rendered", () => {
    assert.deepEqual(keysOf("<p>a</p><script>s</script><style>t</style><title>u</title><template>v</template>"
      + "<noembed>w</noembed><noframes>x</noframes><iframe>y</iframe><p>b</p>"), ["a", "b"]);
  });

  it("ends a run at a skipped element, and does not look inside it", () => {
    assert.deepEqual(keysOf("<p>a<script>s<b>t</b></script>b</p>"), ["a", "b"]);
  });

  it("joins adjacent text nodes, as a document parsed again from its serialisation has them", () => {
    const d = parse("<p>x</p>");
    const p = d.body.childNodes[0];
    append(p, txt("y"));
    const found = V.units(d, dom);
    assert.deepEqual(Array.from(found, u => u.key), ["xy"]);
    assert.equal(found[0].nodes.length, 2);
  });

  it("ends a run at a comment and gives an image without alt an empty one", () => {
    assert.deepEqual(keysOf("<p>a<!-- c -->b<img></p>"), ["a", "b", "\u0000img\u0000"]);
  });

  it("drops runs of white space only, non-breaking spaces included", () => {
    assert.deepEqual(keysOf("<p> </p><p> \n\t</p><p> x</p>"), [" x"]);
  });

  it("keys a link by its own marker, not by its text", () => {
    assert.deepEqual(keysOf("<a href=\"x\"><img alt=\"i\">t</a>"), ["\u0000a", "\u0000img\u0000i", "t"]);
  });

  it("refuses a document with too many units", () => {
    const body = el("body");
    for (let i = 0; i < 200002; i++) append(body, el("b", {}, "x"));
    const d = new FakeDocument(el("html", {}, body), body, fakeWindow(800, 600));
    assert.throws(() => V.units(d, dom), /too many units/);
  });

  it("walks a deep document without overflowing the stack", () => {
    const body = el("body");
    let top = body;
    for (let i = 0; i < 20000; i++) {
      const inner = el("div");
      append(top, inner);
      top = inner;
    }
    append(top, txt("deep"));
    const d = new FakeDocument(el("html", {}, body), body, fakeWindow(800, 600));
    assert.deepEqual(Array.from(V.units(d, dom), u => u.key), ["deep"]);
  });
});

describe("units and engineUnits of api.js", () => {
  // api.js's engineUnits, from its region (which needs ENCRYPTED_CONTENT_TYPES, defined in another region)
  const apiSource = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");
  const region = name => {
    const start = apiSource.indexOf(`// BEGIN ${name}`);
    const end = apiSource.indexOf(`// END ${name}`, start);
    assert.ok(start >= 0 && end > start, `${name} missing`);
    return apiSource.slice(start, end);
  };
  const apiContext = {};
  vm.createContext(apiContext);
  vm.runInContext(`${region("ENCRYPTED MESSAGE HELPERS")}
${region("ENGINE VISIBILITY HELPERS")}
this.api = { engineUnits };`, apiContext);

  it("give the same units, keys and text nodes on the same document", () => {
    for (const html of [
      "<p>one</p> <div>two<b>three</b></div><img alt=\"pic\"><a href=\"x\">four</a>",
      "<p>a</p><script>s</script><style>t</style><title>u</title><template>v</template><noembed>w</noembed>"
        + "<noframes>x</noframes><iframe>y</iframe><p>b</p>",
      "<p>a<!-- c -->b<img></p><p>a<script>s</script>b</p>",
      "<p> </p><p> \n</p><div><span>x</span>y<a href=\"u\"><img alt=\"i\">z</a></div> tail",
      "<img alt=\"a\"><img alt=\"a\"><img><a>a</a><a>a</a>",
      "",
    ]) {
      const d = parse(html);
      const ours = V.units(d, dom);
      const theirs = apiContext.api.engineUnits(d.documentElement);
      assert.deepEqual(Array.from(ours, u => u.key), Array.from(theirs, u => u.key), html);
      assert.deepEqual(Array.from(ours, u => u.nodes.length), Array.from(theirs, u => u.nodes.length), html);
      ours.forEach((u, i) => u.nodes.forEach((n, j) => assert.equal(n, theirs[i].nodes[j], html)));
    }
  });

  it("both refuse a document with too many units", () => {
    const body = el("body");
    for (let i = 0; i < 200002; i++) append(body, el("b", {}, "x"));
    const d = new FakeDocument(el("html", {}, body), body, fakeWindow(800, 600));
    assert.throws(() => V.units(d, dom), /too many units/);
    assert.throws(() => apiContext.api.engineUnits(d.documentElement), /too many units/);
  });
});

describe("judge", () => {
  const judged = d => V.judge(d, dom);
  // Why the engine hides a text node (or an element), null when it shows it
  const reasonOf = (d, node) => judged(d).get(node) ?? null;
  const BOX = { rect: rect(0, 0, 100, 50), client: { left: 0, top: 0, width: 100, height: 50 } };

  it("leaves visible text visible", () => {
    const d = page([
      el("h1", { style: { fontSize: "32px" } }, "Hello"),
      el("p", { style: { color: "rgb(51, 51, 51)", backgroundColor: "rgb(255, 255, 255)" } }, "world"),
      el("a", { attrs: { href: "https://example.test/" } }, "link text"),
      el("img"),
      el("div", { style: { color: "rgb(255, 255, 255)", backgroundColor: "rgb(0, 0, 0)" } }, "inverted"),
      "bare text",
    ]);
    assert.equal(judged(d).size, 0);
  });

  describe("what the layout engine itself says", () => {
    it("hides a text in an element that checkVisibility says is not visible", () => {
      const t = txt("secret");
      assert.equal(reasonOf(page([el("p", { visible: false }, t)]), t), "checkVisibility");
    });

    it("asks the nearest box when the parent is display: contents", () => {
      const shown = txt("shown"), gone = txt("gone");
      const contents = { style: { display: "contents" }, visible: false };
      const d = page([
        el("div", {}, el("span", contents, shown)),
        el("div", { visible: false }, el("span", { ...contents }, el("span", { ...contents }, gone))),
      ]);
      const hidden = judged(d);
      assert.ok(!hidden.has(shown), "its box is the div's, which shows");
      assert.equal(hidden.get(gone), "checkVisibility");
    });

    it("hides a text under visibility: hidden", () => {
      const t = txt("secret");
      assert.equal(reasonOf(page([el("p", { style: { visibility: "hidden" } }, t)]), t), "visibility");
    });

    it("hides a text under an element with content-visibility: hidden", () => {
      const t = txt("secret");
      assert.equal(reasonOf(page([el("div", { style: { contentVisibility: "hidden" } }, el("p", {}, t))]), t), "content-visibility");
    });
  });

  describe("opacity and size", () => {
    it("multiplies the opacities of the ancestors", () => {
      const faint = txt("faint"), fine = txt("fine");
      const d = page([
        el("div", { style: { opacity: "0.3" } }, el("p", { style: { opacity: "0.3" } }, faint)),
        el("div", { style: { opacity: "0.4" } }, el("p", { style: { opacity: "0.4" } }, fine)),
      ]);
      const hidden = judged(d);
      assert.equal(hidden.get(faint), "opacity");
      assert.ok(!hidden.has(fine), "0.4 * 0.4 is still visible");
    });

    it("counts filter: opacity() as an opacity", () => {
      const t = txt("faint");
      assert.equal(reasonOf(page([el("p", { style: { filter: "opacity(5%)" } }, t)]), t), "opacity");
      const u = txt("faint");
      assert.equal(reasonOf(page([el("p", { style: { filter: "opacity(0.05)" } }, u)]), u), "opacity");
    });

    it("hides text in a font of 2px, not one of 12px", () => {
      const tiny = txt("tiny"), small = txt("small");
      const d = page([el("p", { style: { fontSize: "2px" } }, tiny), el("p", { style: { fontSize: "12px" } }, small)]);
      assert.equal(reasonOf(d, tiny), "font-size");
      assert.equal(reasonOf(d, small), null);
    });
  });

  describe("colour", () => {
    it("hides white text on a white background", () => {
      const t = txt("secret");
      const style = { color: "rgb(255, 255, 255)", backgroundColor: "rgb(255, 255, 255)" };
      assert.equal(reasonOf(page([el("p", { style }, t)]), t), "colour-on-background");
    });

    it("takes the background from an ancestor, and the white canvas when nobody paints one", () => {
      const onDiv = txt("a"), onCanvas = txt("b"), onGrey = txt("c");
      const white = { color: "rgb(255, 255, 255)" };
      const d = page([
        el("div", { style: { backgroundColor: "rgb(255, 255, 255)" } }, el("p", { style: white }, onDiv)),
        el("p", { style: white }, onCanvas),
        el("div", { style: { backgroundColor: "rgb(30, 30, 30)" } }, el("p", { style: white }, onGrey)),
      ]);
      assert.equal(reasonOf(d, onDiv), "colour-on-background");
      assert.equal(reasonOf(d, onCanvas), "colour-on-background");
      assert.equal(reasonOf(d, onGrey), null);
    });

    it("hides a colour a hair away from its background, not a readable grey", () => {
      const hair = txt("hair"), grey = txt("grey");
      const d = page([
        el("p", { style: { color: "rgb(254, 254, 254)" } }, hair),
        el("p", { style: { color: "rgb(119, 119, 119)" } }, grey),
      ]);
      assert.equal(reasonOf(d, hair), "colour-on-background");
      assert.equal(reasonOf(d, grey), null);
    });

    it("does not judge the colour when an image or a gradient may be behind the text", () => {
      const t = txt("on a picture"), u = txt("on a gradient");
      const white = { color: "rgb(255, 255, 255)" };
      const d = page([
        el("div", { style: { backgroundImage: "url(\"data:image/png;base64,AAAA\")" } }, el("p", { style: white }, t)),
        el("div", { style: { backgroundImage: "linear-gradient(red, blue)", backgroundColor: "rgb(255, 255, 255)" } },
          el("p", { style: white }, u)),
      ]);
      assert.equal(judged(d).size, 0);
    });

    it("hides text with a transparent colour, also through -webkit-text-fill-color and opacity", () => {
      const clear = txt("a"), filled = txt("b"), faint = txt("c"), dim = txt("d");
      const d = page([
        el("p", { style: { color: "rgba(0, 0, 0, 0)" } }, clear),
        el("p", { style: { color: "rgb(0, 0, 0)", webkitTextFillColor: "rgba(0, 0, 0, 0)" } }, filled),
        el("p", { style: { color: "rgba(0, 0, 0, 0.05)" } }, faint),
        el("p", { style: { color: "rgba(0, 0, 0, 0.5)", opacity: "0.15" } }, dim),
      ]);
      for (const t of [clear, filled, faint, dim]) assert.equal(reasonOf(d, t), "transparent-colour", t.data);
    });

    it("composites text that is partly transparent over its background", () => {
      const onWhite = txt("a"), onBlack = txt("b"), pale = txt("c");
      const d = page([
        el("p", { style: { color: "rgba(255, 255, 255, 0.5)", backgroundColor: "rgb(255, 255, 255)" } }, onWhite),
        el("p", { style: { color: "rgba(255, 255, 255, 0.5)", backgroundColor: "rgb(0, 0, 0)" } }, onBlack),
        // half of a light grey over white is a hair from white, though the grey itself is not
        el("p", { style: { color: "rgba(230, 230, 230, 0.5)" } }, pale),
      ]);
      assert.equal(reasonOf(d, onWhite), "colour-on-background");
      assert.equal(reasonOf(d, onBlack), null);
      assert.equal(reasonOf(d, pale), "colour-on-background");
    });

    it("does not call text hidden when a background is painted through it (background-clip: text)", () => {
      const gradient = txt("a"), inherited = txt("b"), solid = txt("c"), plain = txt("d"), unclipped = txt("e");
      const clear = { color: "rgba(0, 0, 0, 0)" };
      const clipped = { backgroundClip: "text", backgroundImage: "linear-gradient(red, blue)" };
      const d = page([
        el("h1", { style: { ...clear, ...clipped } }, gradient),
        el("div", { style: clipped }, el("h1", { style: clear }, inherited)),
        el("h1", { style: { ...clear, backgroundClip: "text", backgroundColor: "rgb(200, 0, 0)" } }, solid),
        el("h1", { style: { ...clear, backgroundClip: "text" } }, plain),
        el("h1", { style: { ...clear, backgroundImage: "linear-gradient(red, blue)" } }, unclipped),
      ]);
      const hidden = judged(d);
      for (const t of [gradient, inherited, solid]) assert.ok(!hidden.has(t), `${t.data} shows the background`);
      assert.equal(hidden.get(plain), "transparent-colour", "nothing is painted behind the glyphs");
      assert.equal(hidden.get(unclipped), "transparent-colour", "the background is not clipped to the glyphs");
    });

    it("reads a text by its shadow or stroke when they show, not when they are the background's colour", () => {
      const shadowed = txt("a"), stroked = txt("b"), whiteShadow = txt("c"), whiteStroke = txt("d"), clearShadow = txt("e");
      const d = page([
        el("p", { style: { color: "rgba(0, 0, 0, 0)", textShadow: "rgb(0, 0, 0) 1px 1px 0px" } }, shadowed),
        el("p", { style: { color: "rgb(255, 255, 255)", webkitTextStrokeWidth: "1px", webkitTextStrokeColor: "rgb(0, 0, 0)" } }, stroked),
        el("p", { style: { color: "rgb(255, 255, 255)", textShadow: "rgb(255, 255, 255) 0px 0px 0px, rgba(0, 0, 0, 0) 2px 2px 0px" } }, whiteShadow),
        el("p", { style: { color: "rgb(255, 255, 255)", webkitTextStrokeWidth: "1px", webkitTextStrokeColor: "rgb(255, 255, 255)" } }, whiteStroke),
        el("p", { style: { color: "rgba(0, 0, 0, 0)", textShadow: "rgba(0, 0, 0, 0) 1px 1px 0px" } }, clearShadow),
      ]);
      const hidden = judged(d);
      assert.ok(!hidden.has(shadowed) && !hidden.has(stroked), "a dark shadow or stroke shows the text");
      assert.equal(hidden.get(whiteShadow), "colour-on-background");
      assert.equal(hidden.get(whiteStroke), "colour-on-background");
      assert.equal(hidden.get(clearShadow), "transparent-colour");
    });
  });

  describe("position and clipping", () => {
    it("hides a text whose box lies outside an ancestor with overflow: hidden", () => {
      const outside = txt("outside", [rect(300, 10, 80, 16)]), inside = txt("inside", [rect(10, 10, 80, 16)]);
      const edge = txt("edge", [rect(90, 10, 80, 16)]);
      const d = page([el("div", { ...BOX, style: { overflowX: "hidden", overflowY: "hidden" } },
        el("p", {}, outside), el("p", {}, inside), el("p", {}, edge))]);
      assert.equal(reasonOf(d, outside), "clipped-or-offscreen");
      assert.equal(reasonOf(d, inside), null);
      assert.equal(reasonOf(d, edge), null, "partly inside is visible");
    });

    it("clips to the padding box of the ancestor, inside its border", () => {
      const inBorder = txt("border", [rect(0, 10, 4, 16)]), inside = txt("inside", [rect(10, 10, 80, 16)]);
      const bordered = { rect: rect(0, 0, 100, 50), client: { left: 5, top: 5, width: 90, height: 40 },
        style: { overflowX: "hidden", overflowY: "hidden" } };
      const d = page([el("div", bordered, el("p", {}, inBorder), el("p", {}, inside))]);
      assert.equal(reasonOf(d, inBorder), "clipped-or-offscreen");
      assert.equal(reasonOf(d, inside), null);
    });

    it("does not clip by the overflow of an element that has no box to clip with", () => {
      // The padding box of an inline box, of display: contents and of a table row is empty (clientWidth is 0)
      const dead = { rect: rect(0, 0, 80, 16), client: { left: 0, top: 0, width: 0, height: 0 } };
      const clipping = display => ({ ...dead, style: { display, overflowX: "hidden", overflowY: "hidden" } });
      const inline = txt("inline"), contents = txt("contents"), row = txt("row"), block = txt("block");
      const d = page([
        el("p", {}, el("span", clipping("inline"), inline)),
        el("p", {}, el("span", { ...clipping("contents"), visible: false }, contents)),
        el("table", {}, el("tr", clipping("table-row"), row)),
        el("div", clipping("block"), block),
      ]);
      const hidden = judged(d);
      for (const t of [inline, contents, row]) assert.ok(!hidden.has(t), `${t.data} stays visible`);
      assert.equal(hidden.get(block), "clipped-or-offscreen", "a block with no room does clip");
    });

    it("lets a scroll container's content be reached, unless the container has no room", () => {
      const beyond = txt("beyond", [rect(300, 10, 80, 16)]), cramped = txt("cramped", [rect(10, 10, 80, 16)]);
      const scroll = { overflowX: "auto", overflowY: "scroll" };
      const d = page([
        el("div", { ...BOX, style: scroll }, el("p", {}, beyond)),
        el("div", { rect: rect(0, 0, 100, 50), client: { left: 0, top: 0, width: 0, height: 0 }, style: scroll }, el("p", {}, cramped)),
      ]);
      assert.equal(reasonOf(d, beyond), null);
      assert.equal(reasonOf(d, cramped), "clipped-or-offscreen");
    });

    it("follows the containing block of an absolutely positioned box", () => {
      const free = txt("free", [rect(300, 10, 80, 16)]), held = txt("held", [rect(300, 10, 80, 16)]);
      const clipped = { ...BOX, style: { overflowX: "hidden", overflowY: "hidden" } };
      const absolute = { style: { position: "absolute" } };
      const d = page([
        el("div", clipped, el("span", absolute, free)),
        el("div", { ...clipped, style: { ...clipped.style, position: "relative" } }, el("span", absolute, held)),
      ]);
      assert.equal(reasonOf(d, free), null, "the static div is not its containing block");
      assert.equal(reasonOf(d, held), "clipped-or-offscreen");
    });

    it("hides a text clipped away by clip: rect() on an absolutely positioned element, or by clip-path", () => {
      const rectClipped = txt("a"), rectOpen = txt("b"), staticClip = txt("c"), inset = txt("d"), insetOpen = txt("e"), circle = txt("f");
      const d = page([
        el("span", { style: { position: "absolute", clip: "rect(0px, 0px, 0px, 0px)" } }, rectClipped),
        el("span", { style: { position: "absolute", clip: "rect(0px, 200px, 50px, 0px)" } }, rectOpen),
        el("span", { style: { clip: "rect(0px, 0px, 0px, 0px)" } }, staticClip),
        el("span", { style: { clipPath: "inset(50%)" } }, inset),
        el("span", { style: { clipPath: "inset(0px)" } }, insetOpen),
        el("span", { style: { clipPath: "circle(0px at 50% 50%)" } }, circle),
      ]);
      const hidden = judged(d);
      for (const t of [rectClipped, inset, circle]) assert.equal(hidden.get(t), "clipped-or-offscreen", t.data);
      for (const t of [rectOpen, staticClip, insetOpen]) assert.ok(!hidden.has(t), `${t.data} stays visible`);
    });

    it("hides a text left of the page or above it, not one that is partly in", () => {
      const left = txt("left", [rect(-500, 10, 100, 16)]), above = txt("above", [rect(10, -100, 80, 16)]);
      const partly = txt("partly", [rect(-50, 10, 100, 16)]);
      const d = page([el("p", {}, left), el("p", {}, above), el("p", {}, partly)]);
      assert.equal(reasonOf(d, left), "clipped-or-offscreen");
      assert.equal(reasonOf(d, above), "clipped-or-offscreen");
      assert.equal(reasonOf(d, partly), null);
    });

    it("hides a text below the window only when the root cannot be scrolled", () => {
      const below = () => txt("below", [rect(10, 700, 80, 16)]);
      const right = () => txt("right", [rect(900, 10, 80, 16)]);
      const hiddenRoot = { overflowX: "hidden", overflowY: "hidden" };
      for (const [name, options, reason] of [
        ["a root that scrolls", {}, null],
        ["a root with overflow: auto", { root: { overflowX: "auto", overflowY: "auto" } }, null],
        ["a root with overflow: hidden", { root: hiddenRoot }, "clipped-or-offscreen"],
        ["a root with overflow: clip", { root: { overflowX: "clip", overflowY: "clip" } }, "clipped-or-offscreen"],
        ["a body with overflow: hidden under a visible root", { body: hiddenRoot }, "clipped-or-offscreen"],
        ["a body with overflow: hidden under a root that scrolls", { root: { overflowX: "auto", overflowY: "auto" }, body: hiddenRoot }, null],
      ]) {
        const b = below(), r = right();
        const d = page([el("p", {}, b), el("p", {}, r)], options);
        assert.equal(reasonOf(d, b), reason, `below, ${name}`);
        assert.equal(reasonOf(d, r), reason, `right, ${name}`);
      }
      const inside = txt("inside", [rect(10, 500, 80, 16)]);
      assert.equal(reasonOf(page([el("p", {}, inside)], { root: hiddenRoot }), inside), null);
    });
  });

  describe("closed details", () => {
    it("hides a text in a closed <details> outside its <summary>", () => {
      const title = txt("Title"), secret = txt("secret"), opened = txt("opened"), openTitle = txt("Open title");
      const d = page([
        el("details", {}, el("summary", {}, title), el("p", {}, secret)),
        el("details", { attrs: { open: "" } }, el("summary", {}, openTitle), el("p", {}, opened)),
      ]);
      const hidden = judged(d);
      assert.equal(hidden.get(secret), "closed-details");
      assert.ok(!hidden.has(title), "the summary of a closed details shows");
      assert.ok(!hidden.has(opened) && !hidden.has(openTitle), "an open details shows all");
    });

    it("hides a text of a closed <details> without a summary, and one directly in it", () => {
      const direct = txt("direct"), nested = txt("nested");
      const d = page([el("details", {}, direct, el("div", {}, el("p", {}, nested)))]);
      assert.equal(reasonOf(d, direct), "closed-details");
      assert.equal(reasonOf(d, nested), "closed-details");
    });
  });

  describe("images and links", () => {
    it("hides an <img> or an <a> with no box that shows", () => {
      const none = el("img", { rects: [] }), shown = el("img"), flat = el("img", { rects: [rect(0, 0, 0, 0)] });
      const nobox = el("a", { attrs: { href: "x" }, rects: [] }, "label");
      const offscreen = el("img", { rects: [rect(-300, 0, 100, 20)] });
      const d = page([none, shown, flat, nobox, offscreen]);
      const hidden = judged(d);
      assert.equal(hidden.get(none), "no-box");
      assert.equal(hidden.get(flat), "no-box");
      assert.equal(hidden.get(nobox), "no-box");
      assert.equal(hidden.get(offscreen), "no-box");
      assert.ok(!hidden.has(shown));
    });

    it("does not clip an <img> by its own overflow, only by its ancestors'", () => {
      const own = el("img", { rect: rect(0, 0, 80, 16), client: { left: 0, top: 0, width: 0, height: 0 },
        style: { display: "block", overflowX: "hidden", overflowY: "hidden" } });
      const outside = el("img", { rects: [rect(300, 0, 80, 16)] });
      const d = page([own, el("div", { ...BOX, style: { overflowX: "hidden", overflowY: "hidden" } }, outside)]);
      const hidden = judged(d);
      assert.ok(!hidden.has(own), "its box is what the reader sees");
      assert.equal(hidden.get(outside), "no-box");
    });

    it("hides an <img> or an <a> for the same reasons as a text", () => {
      const gone = el("img", { visible: false }), invisible = el("img", { style: { visibility: "hidden" } });
      const faint = el("a", { attrs: { href: "x" }, style: { opacity: "0.01" } }, "x");
      const folded = el("img");
      const d = page([gone, invisible, faint, el("details", {}, el("p", {}, folded))]);
      const hidden = judged(d);
      assert.equal(hidden.get(gone), "checkVisibility");
      assert.equal(hidden.get(invisible), "visibility");
      assert.equal(hidden.get(faint), "opacity");
      assert.equal(hidden.get(folded), "closed-details");
    });
  });

  describe("form controls and SVG", () => {
    it("measures the text of a <textarea> or an <option> by the control, not by a range", () => {
      const typed = txt("typed", []), emptyBox = txt("x"), choice = txt("choice", []);
      const d = page([
        el("textarea", { rects: [rect(10, 10, 120, 40)] }, typed),
        el("textarea", { rects: [] }, emptyBox),
        el("select", {}, el("option", { rects: [rect(10, 60, 80, 16)] }, choice)),
      ]);
      const hidden = judged(d);
      assert.ok(!hidden.has(typed));
      assert.equal(hidden.get(emptyBox), "no-box");
      assert.ok(!hidden.has(choice));
    });

    it("says no-box for a text that has no rect at all", () => {
      const t = txt("nowhere", []);
      assert.equal(reasonOf(page([el("p", {}, t)]), t), "no-box");
    });

    it("hides SVG text painted with neither fill nor stroke", () => {
      const painted = txt("a"), nothing = txt("b"), strokeOnly = txt("c"), clearFill = txt("d"), thin = txt("e");
      const svg = (style, t) => el("text", { ns: SVG_NS, style }, t);
      const d = page([
        svg({}, painted),
        svg({ fill: "none", stroke: "none" }, nothing),
        svg({ fill: "none", stroke: "rgb(0, 0, 0)", strokeWidth: "2px" }, strokeOnly),
        svg({ fillOpacity: "0" }, clearFill),
        svg({ fill: "none", stroke: "rgb(0, 0, 0)", strokeWidth: "0px" }, thin),
      ]);
      const hidden = judged(d);
      assert.ok(!hidden.has(painted) && !hidden.has(strokeOnly));
      for (const t of [nothing, clearFill, thin]) assert.equal(hidden.get(t), "svg-no-paint", t.data);
    });
  });

  it("judges the units it is given, or those of the document", () => {
    const a = txt("a"), b = txt("b");
    const d = page([el("p", { visible: false }, a), el("p", { visible: false }, b)]);
    const found = V.units(d, dom).filter(u => u.key === "a");
    const some = V.judge(d, dom, found);
    assert.equal(some.get(a), "checkVisibility");
    assert.ok(!some.has(b));
    assert.equal(V.judge(d, dom).size, 2);
  });

  it("skips the text nodes of a run that hold white space only", () => {
    const secret = txt("secret"), blank = txt("  ");
    const p = el("p", { style: { fontSize: "1px" } }, secret);
    append(p, blank);
    const hidden = judged(page([p]));
    assert.equal(hidden.get(secret), "font-size");
    assert.ok(!hidden.has(blank));
  });
});

describe("parseRgb, contrast and intersect", () => {
  const rgb = value => {
    const parsed = V.parseRgb(value);
    return parsed && Array.from(parsed);
  };
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);

  it("reads the colours getComputedStyle gives, and the modern syntax", () => {
    assert.deepEqual(rgb("rgb(255, 0, 10)"), [255, 0, 10, 1]);
    assert.deepEqual(rgb("rgba(1, 2, 3, 0.5)"), [1, 2, 3, 0.5]);
    assert.deepEqual(rgb("rgba(0, 0, 0, 0)"), [0, 0, 0, 0]);
    assert.deepEqual(rgb("rgb(1 2 3 / 50%)"), [1, 2, 3, 0.5]);
    assert.deepEqual(rgb("rgb(1 2 3 / 0.25)"), [1, 2, 3, 0.25]);
    assert.deepEqual(rgb("rgb( 1 , 2 , 3 )"), [1, 2, 3, 1]);
  });

  it("answers null for what it cannot read", () => {
    for (const value of ["red", "#fff", "", undefined, null, "transparent", "rgb(1, 2)", "hsl(0, 0%, 0%)", "rgb(1, 2, 3"]) {
      assert.equal(V.parseRgb(value), null, String(value));
    }
  });

  it("gives the WCAG contrast ratio of two colours, 1 for a colour on itself and 21 for black on white", () => {
    near(V.contrast([0, 0, 0], [255, 255, 255]), 21);
    near(V.contrast([255, 255, 255], [0, 0, 0]), 21);
    near(V.contrast([10, 20, 30], [10, 20, 30]), 1);
    assert.ok(V.contrast([255, 255, 255], [254, 254, 254]) < 1.2);
    assert.ok(V.contrast([119, 119, 119], [255, 255, 255]) > 4.4);
  });

  it("intersects two boxes, with a width and a height that are never negative", () => {
    assert.deepEqual({ ...V.intersect({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 5, top: -5, right: 20, bottom: 6 }) },
      { left: 5, top: 0, right: 10, bottom: 6, width: 5, height: 6 });
    const apart = V.intersect({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 20, top: 20, right: 30, bottom: 30 });
    assert.equal(apart.width, 0);
    assert.equal(apart.height, 0);
    const everywhere = { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };
    assert.deepEqual({ ...V.intersect({ left: 1, top: 2, right: 3, bottom: 4 }, everywhere) },
      { left: 1, top: 2, right: 3, bottom: 4, width: 2, height: 2 });
  });
});

describe("renderJob", () => {
  const job = (more = {}) => ({ html: "<p>x</p>", width: 800, height: 600, parts: [], ...more });

  it("resolves { ok: false, error } and never throws for a bad job", async () => {
    for (const [bad, error] of [
      [undefined, "no job"], [null, "no job"], ["job", "no job"],
      [{}, "no html"], [job({ html: "" }), "no html"],
      [job({ width: 50 }), "bad width"], [job({ height: 10001 }), "bad height"],
      [job({ parts: "x" }), "bad parts"], [job({ parts: [["a", "https://example.test/a.png"]] }), "bad part"],
    ]) {
      const answer = await V.renderJob(bad);
      assert.equal(answer.ok, false, error);
      assert.equal(answer.error, error);
    }
  });

  it("resolves an error, not a rejection, when the page cannot check its policy", async () => {
    const bare = load().api;
    const answer = await bare.renderJob(job());
    assert.equal(answer.ok, false);
    assert.equal(typeof answer.error, "string");
    assert.ok(answer.error.length > 0 && answer.error.length <= 200);
  });

  // A page whose probe image does (violates) or does not raise a policy violation, and timers the test fires
  function pageEnvironment({ violates, parsed }) {
    const timers = [];
    const listeners = new Set();
    return {
      timers,
      globals: {
        document: { addEventListener: (_type, fn) => listeners.add(fn), removeEventListener: (_type, fn) => listeners.delete(fn) },
        URL: { createObjectURL: () => "blob:null/probe", revokeObjectURL() {} },
        Blob: class {},
        Image: class {
          set src(_url) {
            if (violates) for (const fn of listeners) fn({ violatedDirective: "img-src-elem", blockedURI: "blob" });
          }
        },
        setTimeout: fn => timers.push(fn),
        clearTimeout() {},
        DOMParser: class { parseFromString() { return parsed; } },
      },
    };
  }

  it("answers policy when the add-on's policy is not in force", async () => {
    const env = pageEnvironment({ violates: false });
    const answer = load(env.globals).api.renderJob(job());
    for (const fire of env.timers) fire();
    assert.deepEqual({ ...await answer }, { ok: false, error: "policy" });
  });

  it("answers no message document when the HTML gives none", async () => {
    const env = pageEnvironment({ violates: true, parsed: { documentElement: null } });
    assert.deepEqual({ ...await load(env.globals).api.renderJob(job()) }, { ok: false, error: "no message document" });
  });

  it("does not render a message whose parsed document fails the load checks", async () => {
    const parsed = page([el("iframe", { attrs: { srcdoc: "<p>x</p>" } })]);
    const env = pageEnvironment({ violates: true, parsed });
    assert.deepEqual({ ...await load(env.globals).api.renderJob(job({ html: "<iframe srcdoc=\"x\"></iframe>" })) },
      { ok: false, error: "srcdoc frame" });
    const loads = page([el("img", { attrs: { src: "mailbox:///x" } })]);
    const second = pageEnvironment({ violates: true, parsed: loads });
    assert.deepEqual({ ...await load(second.globals).api.renderJob(job()) }, { ok: false, error: "message URL left in src" });
  });
});

// A hostile message must not stall the background page: each of these took seconds with the regular expressions
// they replace (quadratic backtracking), and must stay far below that.
describe("time on hostile input", () => {
  const fast = (label, run) => {
    const t0 = process.hrtime.bigint();
    run();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 1000, `${label} took ${ms.toFixed(0)} ms`);
  };

  it("reads unterminated tags in linear time", () => {
    fast("unterminated tags", () => V.inertHtml("<a ".repeat(200000)));
    fast("unclosed quotes", () => V.inertHtml("<img src=\"".repeat(100000)));
  });

  it("trims a long run of spaces in a URL in linear time", () => {
    fast("spaces", () => V.inertUrl("x" + " ".repeat(400000) + "y", new Set(["http"])));
  });

  it("reads CSS with unclosed comments and image-set() in linear time", () => {
    fast("comments", () => V.cssLoadsUnsafeUrl("/* ".repeat(200000)));
    fast("image-set", () => V.cssLoadsUnsafeUrl("image-set(".repeat(200000)));
  });
});

describe("judge: what is painted over and around the text", () => {
  const judged = d => V.judge(d, dom);
  const WHITE = "rgb(255, 255, 255)";
  const at = (x, y, w, h) => rect(x, y, w, h);

  it("hides a text covered by an opaque box, and keeps it under a translucent one or a hit outside the box", () => {
    const covered = txt("covered", [at(10, 10, 80, 16)]), veiled = txt("veiled", [at(10, 40, 80, 16)]);
    const outside = txt("outside", [at(10, 70, 80, 16)]);
    const p1 = el("p", {}, covered), p2 = el("p", {}, veiled), p3 = el("p", {}, outside);
    const cover = el("div", { rect: at(0, 0, 200, 30), style: { backgroundColor: WHITE } });
    const veil = el("div", { rect: at(0, 30, 200, 30), style: { backgroundColor: "rgba(255, 255, 255, 0.3)" } });
    const pseudo = el("div", { rect: at(0, 300, 200, 30), style: { backgroundImage: "url(data:,x)" } });
    const d = page([p1, p2, p3, cover, veil, pseudo]);
    d._hits = (x, y) => (y < 30 ? [cover, p1] : y < 60 ? [veil, p2] : [pseudo, p3]);
    const hidden = judged(d);
    assert.equal(hidden.get(covered), "covered");
    assert.ok(!hidden.has(veiled), "a translucent veil does not hide");
    assert.ok(!hidden.has(outside), "a hit from outside the element's own box (a pseudo-element) does not count");
  });

  it("takes the background from what is under the text where it shows", () => {
    const white = txt("white text", [at(10, 10, 80, 16)]);
    const p = el("p", { style: { color: WHITE } }, white);
    const dark = el("div", { rect: at(0, 0, 200, 30), style: { backgroundColor: "rgb(0, 0, 0)" } });
    const d = page([dark, p]);
    assert.equal(judged(d).get(white), "colour-on-background", "the DOM ancestors are white");
    d._hits = () => [p, dark, d.body, d.documentElement];
    assert.ok(!judged(d).has(white), "a black layer under it shows it");
  });

  it("gives up when the text's element is not hit (pointer-events), keeping the other checks", () => {
    const t = txt("text", [at(10, 10, 80, 16)]);
    const cover = el("div", { rect: at(0, 0, 200, 30), style: { backgroundColor: WHITE } });
    const d = page([el("p", {}, t), cover]);
    d._hits = () => [cover];
    assert.ok(!judged(d).has(t));
  });

  it("hides text under a blend mode, a mask, a colour filter or a strong blur, and keeps small blurs and shadows", () => {
    const cases = {
      blend: { mixBlendMode: "screen" }, mask: { maskImage: "linear-gradient(transparent, transparent)" },
      filter: { filter: "invert(1)" }, blur: { filter: "blur(12px)" },
    };
    const nodes = Object.fromEntries(Object.keys(cases).map(k => [k, txt(k)]));
    const small = txt("small blur"), shadow = txt("drop shadow");
    const d = page([
      ...Object.entries(cases).map(([k, style]) => el("div", { style }, el("p", {}, nodes[k]))),
      el("p", { style: { filter: "blur(1px)" } }, small),
      el("p", { style: { filter: "drop-shadow(rgb(0, 0, 0) 1px 1px 0px)" } }, shadow),
    ]);
    const hidden = judged(d);
    for (const k of Object.keys(cases)) assert.equal(hidden.get(nodes[k]), k, k);
    assert.ok(!hidden.has(small) && !hidden.has(shadow));
  });

  it("reads any colour syntax through a canvas when there is one", () => {
    const canvasValues = { "oklch(1 0 0)": "#ffffff", "lab(0 0 0)": "#000000" };
    const fakeDocument = {
      createElement: () => ({
        getContext: () => {
          let value = "#000000";
          return {
            get fillStyle() { return value; },
            set fillStyle(v) { if (v in canvasValues) value = canvasValues[v]; else if (/^#[0-9a-f]{6}$/i.test(v)) value = v.toLowerCase(); },
          };
        },
      }),
    };
    const { sandbox: s2, api } = load({ document: fakeDocument });
    const dom2 = api.domAccess(s2);
    const white = txt("white"), black = txt("black");
    const d = page([el("p", { style: { color: "oklch(1 0 0)" } }, white), el("p", { style: { color: "lab(0 0 0)" } }, black)]);
    const hidden = api.judge(d, dom2);
    assert.equal(hidden.get(white), "colour-on-background");
    assert.ok(!hidden.has(black));
  });
});
