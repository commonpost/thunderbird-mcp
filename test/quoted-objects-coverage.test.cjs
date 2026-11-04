// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";
// The quote of a reply or forward when the parser gives nothing to check the quote against. Complements
// quoted-objects.test.cjs, with the same kind of stand-in for the parser.
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

// probeElements(quote): the elements the stand-in parser finds in the quote followed by the probe; serialized: what the
// parser writes back for the quote
function load({ probeElements, serialized }) {
  const sandbox = {
    DOMParser: class {
      parseFromString() {
        return {
          createElement() {
            const template = {
              set innerHTML(html) { template.html = html; },
              get innerHTML() { return serialized; },
              content: {
                querySelectorAll: selector => {
                  if (selector === "img, a") return [];
                  return probeElements(template.html);
                },
              },
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
  return sandbox.tagQuotedObjects;
}

const probeElement = { localName: "b", attributes: { length: 1 }, hasAttribute: name => name === "data-commonpost-quote-end", hasChildNodes: () => false };

describe("tagQuotedObjects when the probe finds no element at all", () => {
  it("does not take the quote for closed, and gives the quote as the parser writes it, with no moz-do-not-send of the message", () => {
    const tag = load({ probeElements: () => [], serialized: '<p moz-do-not-send="false">parsed</p>' });
    assert.equal(tag("<p>quote", () => false), '<p moz&#45;do-not-send="false">parsed</p>');
  });

  it("keeps the text of the quote when the probe is the last element, whatever the parser would write", () => {
    const tag = load({ probeElements: () => [probeElement], serialized: "<p>parsed</p>" });
    assert.equal(tag("<p>quote</p>", () => false), "<p>quote</p>");
  });
});
