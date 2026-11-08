// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";

// A refusal that comes from a default tells the user where to act, with the labels they will see: the add-on's name in
// the Add-ons Manager, the section of its options page, Thunderbird's own menu. These tests keep the texts in step with
// manifest.json and options.html.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const apiSource = fs.readFileSync(path.join(root, "extension/mcp_server/api.js"), "utf8");
const optionsHtml = fs.readFileSync(path.join(root, "extension/options.html"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "extension/manifest.json"), "utf8"));

function constant(name) {
  const start = apiSource.indexOf(`\nconst ${name} =`);
  assert.ok(start >= 0, `${name} not found in api.js`);
  return apiSource.slice(start + 1, apiSource.indexOf(";\n", start) + 2);
}

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(`${constant("ADDON_OPTIONS_PATH")}${constant("ENCRYPTED_CONTENT_NOTICE")}${constant("FILTER_SEND_GUARD_NOTE")}
this.texts = { ADDON_OPTIONS_PATH, ENCRYPTED_CONTENT_NOTICE, FILTER_SEND_GUARD_NOTE };`, sandbox);
const { ADDON_OPTIONS_PATH, ENCRYPTED_CONTENT_NOTICE, FILTER_SEND_GUARD_NOTE } = sandbox.texts;

describe("refusals that come from a default say where the user acts", () => {
  it("the path to the options page names the add-on as the Add-ons Manager lists it", () => {
    assert.ok(ADDON_OPTIONS_PATH.includes(` > ${manifest.name} > `), ADDON_OPTIONS_PATH);
    assert.ok(ADDON_OPTIONS_PATH.startsWith("Tools > Add-ons and Themes > "));
  });

  it("an encrypted message names the path and the section of the option", () => {
    assert.ok(ENCRYPTED_CONTENT_NOTICE.includes("content not sent"));
    assert.ok(ENCRYPTED_CONTENT_NOTICE.includes(`${ADDON_OPTIONS_PATH}, Encrypted messages`));
    assert.match(optionsHtml, /<h2 data-i18n="encryptedHeading">Encrypted messages<\/h2>/);
  });

  it("a filter rule that sends mail names the setting and Thunderbird's own filter editor", () => {
    assert.ok(FILTER_SEND_GUARD_NOTE.includes('"Filter rules that send mail: Always block"'));
    assert.ok(optionsHtml.includes(">Filter rules that send mail (forward / reply)</h3>"));
    assert.match(optionsHtml, /<strong data-i18n="filterBlockTitle">Always block<\/strong>/);
    assert.ok(FILTER_SEND_GUARD_NOTE.includes("(Tools > Message Filters)"));
  });
});
