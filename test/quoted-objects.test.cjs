"use strict";
// The quote of a reply or a forward: tagEmbeddedObjects marks the tags it finds in the text, then the elements
// Thunderbird's parser finds are checked (tagQuotedObjects). Here with a stand-in for the parser; the real one is
// exercised in the Thunderbird lab.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const API = fs.readFileSync(path.join(__dirname, "..", "extension", "mcp_server", "api.js"), "utf8");

function slice(start, end) {
  const i = API.indexOf(start);
  assert.ok(i >= 0, `${start} not found`);
  const j = API.indexOf(end, i);
  assert.ok(j > i, `${end} not found`);
  return API.slice(i, j);
}

const el = (localName, attrs) => ({
  localName,
  attrs: { ...attrs },
  getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; },
  setAttribute(name, value) { this.attrs[name] = value; },
});

// As a serializer writes an element: lower-case name, every value in double quotes
const serialized = e => `<${e.localName}${Object.entries(e.attrs).map(([name, value]) => ` ${name}="${value}"`).join("")}>`;

// elementsOf(html): the <img> and <a> elements the stand-in parser "finds" in that text
function load(elementsOf) {
  const parsed = [];
  const sandbox = {
    DOMParser: class {
      parseFromString(text, type) {
        assert.equal(text, "");
        assert.equal(type, "text/html");
        return {
          createElement(name) {
            assert.equal(name, "template");
            const template = {
              set innerHTML(html) { template.html = html; template.elements = elementsOf(html); parsed.push(html); },
              get innerHTML() { return template.elements.map(serialized).join(""); },
              content: { querySelectorAll: () => template.elements },
            };
            return template;
          },
        };
      }
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${slice("// BEGIN COMPOSE HELPERS", "// END COMPOSE HELPERS")}
${slice("// BEGIN QUOTED OBJECTS", "// END QUOTED OBJECTS")}
this.tagQuotedObjects = tagQuotedObjects;`, sandbox);
  return { tag: sandbox.tagQuotedObjects, parsed };
}

const safe = url => url.startsWith("mailbox:");

// tagEmbeddedObjects alone, to show what the text misses
const helpers = {};
vm.createContext(helpers);
vm.runInContext(`${slice("// BEGIN COMPOSE HELPERS", "// END COMPOSE HELPERS")}\nthis.tagEmbeddedObjects = tagEmbeddedObjects;`, helpers);
const tagEmbeddedObjectsOf = html => helpers.tagEmbeddedObjects(html, safe);

describe("tagQuotedObjects", () => {
  it("keeps the text of tagEmbeddedObjects when the parser finds nothing more", () => {
    const { tag, parsed } = load(() => [el("img", { src: "https://x.test/i.png", "moz-do-not-send": "true" })]);
    const out = tag('<p>hi <img src="https://x.test/i.png"></p>', safe);
    assert.equal(out, '<p>hi <img src="https://x.test/i.png" moz-do-not-send="true"></p>');
    // the parser is given the text already marked
    assert.deepEqual(parsed, [out]);
  });

  it("takes the parsed quote, marked, when the parser finds an element the text missed", () => {
    // as Thunderbird 156 serializes <img src=... x"y>: for the text the quote character opens a string and the
    // tag has no end, for the parser x"y is an attribute name
    const html = '<img src="http://192.168.0.1/status" x"y="">';
    assert.equal(tagEmbeddedObjectsOf(html), html);
    const { tag } = load(() => [el("img", { src: "http://192.168.0.1/status", 'x"y': "" })]);
    assert.equal(tag(html, safe), '<img src="http://192.168.0.1/status" x"y="" moz-do-not-send="true">');
  });

  it("leaves no moz-do-not-send of the message, in the text or in the parsed quote", () => {
    const kept = load(() => []);
    assert.equal(kept.tag('<img src="http://192.168.0.1/" x"y="" moz-do-not-send="false"><p moz-do-not-send=false>', safe),
      '<img src="http://192.168.0.1/" x"y="" moz&#45;do-not-send="false"><p moz&#45;do-not-send=false>');
    // a serializer writes text nodes and attribute values decoded: neutralized again
    const sandbox = load(() => [el("img", { src: "http://x.test/", title: "moz-do-not-send=false" })]);
    assert.equal(sandbox.tag('<img src="http://x.test/" x"y="" title="moz-do-not-send=false">', safe),
      '<img src="http://x.test/" title="moz&#45;do-not-send=false" moz-do-not-send="true">');
  });

  it("uses the URL the parser gives, not the one the text shows", () => {
    // for the text the first " src=" is inside data-x and looks safe; the element's src is the second one
    const html = '<img data-x=" src=mailbox:///Inbox?number=5 " src="http://192.168.0.1/status">';
    const { tag } = load(() => [el("img", { "data-x": " src=mailbox:///Inbox?number=5 ", src: "http://192.168.0.1/status" })]);
    assert.equal(tag(html, safe), '<img data-x=" src=mailbox:///Inbox?number=5 " src="http://192.168.0.1/status" moz-do-not-send="true">');
  });
});

describe("quote and caller HTML wiring", () => {
  it("the quote of a reply and of a forward goes through tagQuotedObjects", () => {
    const calls = API.split("tagEmbeddedObjects(").length - 1;
    // its definition and the call inside tagQuotedObjects
    assert.equal(calls, 2);
    assert.equal(API.split("tagQuotedObjects(").length - 1, 3);
    assert.ok(slice("function forwardBodyFor(", "async function buildReplyBody(").includes("return tagQuotedObjects(container, embeddedObjectFilter("));
    assert.ok(slice("async function buildReplyBody(", "function newMessageBody(").includes("parts.quote = tagQuotedObjects(removePlaintextTag(stripDocumentTags(html)), embeddedObjectFilter(msgURI));"));
  });

  it("the HTML body of a new message is neutralized before it is used, whole document or not", () => {
    const body = slice("function newMessageBody(", "function buildForwardBody(");
    const neutral = body.indexOf("if (isHtml) text = neutralizeEmbedMarks(text);");
    const whole = body.indexOf("if (isHtml && /<html[\\s>]/i.test(text))");
    assert.ok(neutral >= 0 && whole > neutral, `${neutral} ${whole}`);
  });
});
