// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";

// The translations of the options page and of the manifest (extension/_locales): English and French hold the same
// messages, every key the page and the script use exists, the English matches the text of options.html and the
// fallbacks of options.js word for word, placeholders are declared and used in both languages, and the French is
// French. The page itself is run in English and in French by options-page.test.cjs.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const en = JSON.parse(read("extension/_locales/en/messages.json"));
const fr = JSON.parse(read("extension/_locales/fr/messages.json"));
const html = read("extension/options.html");
const js = read("extension/options.js");
const api = read("extension/mcp_server/api.js");
const manifest = JSON.parse(read("extension/manifest.json"));

// French messages that are rightly the same as the English.
const SAME_IN_FRENCH = new Set(["navAriaLabel", "accountTypeLocal", "toolGroup_contacts"]);

const PLACEHOLDER = /\$([A-Za-z0-9_@]+)\$/g;
const MARK = "\u0000";
const placeholdersIn = (message) => [...message.matchAll(PLACEHOLDER)].map((m) => m[1].toLowerCase());
const collapse = (text) => text.replace(/\s+/g, " ").trim();
const decode = (text) => text.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// The English of a message with its placeholders replaced by MARK, and the $n each one stands for, in order.
function englishShape(key) {
  const entry = en[key];
  const order = placeholdersIn(entry.message).map((name) => Number(entry.placeholders[name].content.slice(1)));
  return { text: entry.message.replace(PLACEHOLDER, MARK), order };
}

// Splits "a, f(b, c), [d], 'e, f'" at its top-level commas.
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (text.slice(start).trim()) parts.push(text.slice(start).trim());
  return parts;
}

// The argument list of the call that opens at `open` (the index of its "(").
function callArguments(source, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return splitTopLevel(source.slice(open + 1, i));
  }
  throw new Error("unclosed call at " + open);
}

// Every call t("key", ...) and tParts("key", ...) of options.js with a key written out.
function calls(name) {
  const found = [];
  for (const m of js.matchAll(new RegExp(`\\b${name}\\(\\s*"`, "g"))) {
    const args = callArguments(js, m.index + name.length);
    found.push({ key: JSON.parse(args[0]), args });
  }
  return found;
}

// A const of options.js holding an object or an array literal, evaluated.
function constant(name) {
  const m = new RegExp(`^const ${name} = ([\\s\\S]*?);$`, "m").exec(js);
  assert.ok(m, `${name} missing from options.js`);
  return vm.runInNewContext(`(${m[1]})`);
}

// The elements of options.html carrying `attribute`: the key, the tag and, for data-i18n, the text inside.
function tagged(attribute) {
  const found = [];
  for (const m of html.matchAll(new RegExp(`<(\\w+)\\b([^>]*\\s${attribute}="([^"]+)"[^>]*)>`, "g"))) {
    const [, tag, attrs, key] = m;
    const after = m.index + m[0].length;
    const close = html.indexOf(`</${tag}>`, after);
    found.push({ key, tag, attrs, inner: close >= 0 ? html.slice(after, close) : "" });
  }
  return found;
}

const titles = [...api.matchAll(/\n {8}name: "(\w+)",\n {8}group: "(\w+)", crud: "\w+",\n {8}title: "([^"]+)",/g)]
  .map((m) => ({ name: m[1], title: m[3] }));
const groupLabels = vm.runInNewContext(`(${/const GROUP_LABELS = (\{[^}]*\});/.exec(api)[1]})`);

describe("options page translations", () => {
  it("English and French hold the same keys, each with a message and a description", () => {
    assert.deepEqual(Object.keys(fr).sort(), Object.keys(en).sort());
    assert.ok(Object.keys(en).length > 150);
    for (const [lang, messages] of [["en", en], ["fr", fr]]) {
      for (const [key, entry] of Object.entries(messages)) {
        assert.match(key, /^[A-Za-z0-9_]+$/, `${lang}: ${key}`);
        assert.equal(typeof entry.message, "string", `${lang}: ${key}`);
        assert.ok(entry.message.trim(), `${lang}: ${key} is empty`);
        assert.equal(typeof entry.description, "string", `${lang}: ${key} has no description`);
        assert.ok(entry.description.trim(), `${lang}: ${key} has an empty description`);
      }
    }
  });

  it("declares every placeholder, uses each one, and gives both languages the same", () => {
    for (const key of Object.keys(en)) {
      const declared = Object.keys(en[key].placeholders || {});
      assert.deepEqual(fr[key].placeholders || {}, en[key].placeholders || {}, `${key}: French placeholders differ`);
      for (const name of declared) assert.equal(name, name.toLowerCase(), `${key}: placeholder names are lower case`);
      for (const [lang, messages] of [["en", en], ["fr", fr]]) {
        const used = placeholdersIn(messages[key].message);
        assert.deepEqual([...new Set(used)].sort(), [...declared].sort(), `${lang}: ${key} uses ${used}, declares ${declared}`);
        // Only placeholders take a $: a literal one would have to be written $$.
        assert.doesNotMatch(messages[key].message.replace(PLACEHOLDER, ""), /\$/, `${lang}: ${key}`);
      }
      const contents = declared.map((name) => en[key].placeholders[name].content).sort();
      assert.deepEqual(contents, declared.map((_, i) => `$${i + 1}`), `${key}: placeholders take $1, $2... in turn`);
    }
  });

  it("translates every message into French, but for a few that are the same word", () => {
    for (const key of Object.keys(en)) {
      if (SAME_IN_FRENCH.has(key)) assert.equal(fr[key].message, en[key].message, `${key} is no longer the same: take it off the list`);
      else assert.notEqual(fr[key].message, en[key].message, `${key} is not translated`);
    }
  });

  it("leaves no English sentence in the French", () => {
    // Names and code that stay as they are: commands, tool names, Claude Desktop's menu, product names.
    const keep = [
      /Commonpost MCP for Thunderbird/g, /Settings > Extensions > Advanced settings > Install Extension/g,
      /Claude (Desktop|Code)/g, /\$[A-Z_]+\$/g, /\b[a-z]+[A-Z]\w*\b/g, /\S+\.(cjs|mcpb|log)\b/g, /github\.com\S*/g,
      // The English name of a section, in parentheses after its French one: the add-on's messages to the
      // assistant quote it ("section Bridge", "Filter rules that send mail: Always block").
      /\((Bridge|Encrypted messages|Account Access|Filter rules that send mail|Always block)\)/g,
    ];
    const english = /\b(the|and|or|you|your|is|are|this|that|with|from|not|of|to|when|will|can|by|be|it)\b/i;
    for (const [key, entry] of Object.entries(fr)) {
      let text = entry.message;
      for (const pattern of keep) text = text.replace(pattern, " ");
      assert.doesNotMatch(text, english, `fr: ${key}: ${entry.message}`);
    }
  });

  it("uses every message: on the page, in the script, in the manifest or for a tool of the add-on", () => {
    const used = new Set([
      ...tagged("data-i18n").map((el) => el.key),
      ...tagged("data-i18n-placeholder").map((el) => el.key),
      ...tagged("data-i18n-aria-label").map((el) => el.key),
      ...[...js.matchAll(/"([A-Za-z0-9_]+)"/g)].map((m) => m[1]),
      ...[...JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)].map((m) => m[1]),
      ...titles.map((tool) => `toolTitle_${tool.name}`),
      ...Object.keys(groupLabels).map((id) => `toolGroup_${id}`),
    ]);
    for (const key of Object.keys(en)) assert.ok(used.has(key), `${key} is not used`);
  });
});

describe("options.html translations", () => {
  it("has a message for every data-i18n, data-i18n-placeholder and data-i18n-aria-label", () => {
    const keys = [
      ...tagged("data-i18n"), ...tagged("data-i18n-placeholder"), ...tagged("data-i18n-aria-label"),
    ].map((el) => el.key);
    assert.ok(keys.length > 80, "expected many translated elements");
    for (const key of keys) assert.ok(en[key], `options.html uses ${key}, missing from en/messages.json`);
  });

  it("translates whole text elements only, whose English is the message word for word", () => {
    for (const { key, tag, inner } of tagged("data-i18n")) {
      assert.doesNotMatch(inner, /</, `<${tag} data-i18n="${key}"> holds markup: its text would be replaced with it`);
      assert.equal(collapse(decode(inner)), en[key].message, `options.html ${key}`);
    }
  });

  it("gives the placeholder and the accessible name their English in the markup", () => {
    for (const [attribute, target] of [["data-i18n-placeholder", "placeholder"], ["data-i18n-aria-label", "aria-label"]]) {
      for (const { key, attrs } of tagged(attribute)) {
        const value = new RegExp(`\\s${target}="([^"]*)"`).exec(attrs);
        assert.ok(value, `${key}: no ${target} in the markup`);
        assert.equal(value[1], en[key].message, `${key}: ${target}`);
      }
    }
  });

  it("names its language", () => {
    assert.match(html, /^<html lang="en">$/m);
  });
});

describe("options.js translations", () => {
  it("guards browser.i18n and has the helpers", () => {
    assert.ok(js.includes('const i18n = (typeof browser !== "undefined" && browser.i18n) ? browser.i18n : null;'));
    assert.match(js, /^function t\(key, substitutions, fallback\) \{/m);
    assert.match(js, /^function localizePage\(\) \{/m);
    assert.match(js, /^localizePage\(\);$/m);
  });

  it("has an English message equal to the fallback of every t() call, with the substitutions in place", () => {
    const found = calls("t");
    assert.equal(found.length, (js.match(/\bt\(\s*"/g) || []).length);
    assert.ok(found.length > 70, "expected many messages");
    for (const { key, args } of found) {
      assert.ok(en[key], `options.js uses ${key}, missing from en/messages.json`);
      assert.equal(args.length, 3, `t("${key}") takes a key, the substitutions and the English`);
      const [, substitutions, fallback] = args;
      const shape = englishShape(key);
      if (fallback.startsWith("`")) {
        const values = substitutions === "null" ? [] : splitTopLevel(substitutions.slice(1, -1));
        const expressions = [...fallback.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1].trim());
        const text = fallback.slice(1, -1).replace(/\$\{[^}]*\}/g, MARK);
        assert.equal(text, shape.text, `t("${key}")`);
        assert.deepEqual(expressions.map((expression) => values.indexOf(expression) + 1), shape.order, `t("${key}"): substitutions`);
      } else {
        assert.equal(substitutions, "null", `t("${key}") with a plain English text takes no substitution`);
        assert.equal(JSON.parse(fallback), en[key].message, `t("${key}")`);
      }
    }
  });

  it("has an English message equal to the parts of every tParts() call, one placeholder per code or link", () => {
    const parts = [
      ...calls("tParts").map(({ key, args }) => ({ key, expression: args[1] })),
      ...[...js.matchAll(/\{ key: "(\w+)", text: (\[[^\]]*\])/g)].map((m) => ({ key: m[1], expression: m[2] })),
    ];
    assert.ok(parts.length >= 6);
    const context = { BRIDGE_PLUGIN_NOTE: constant("BRIDGE_PLUGIN_NOTE"), bridgeLink: () => ({ link: true }), download: {} };
    for (const { key, expression } of parts) {
      assert.ok(en[key], `options.js uses ${key}, missing from en/messages.json`);
      const list = vm.runInNewContext(`(${expression})`, context);
      const text = list.map((part) => (typeof part === "string" ? part : MARK)).join("");
      const shape = englishShape(key);
      assert.equal(text, shape.text, `tParts("${key}")`);
      assert.deepEqual(shape.order, shape.order.map((_, i) => i + 1), `${key}: the English takes the parts in order`);
    }
  });

  it("has an English message equal to every label of its tables", () => {
    for (const [labels, messages] of [
      ["ACCOUNT_TYPE_LABELS", "ACCOUNT_TYPE_MESSAGES"],
      ["CRUD_LABELS", "CRUD_MESSAGES"],
      ["BRIDGE_PACKAGING_LABELS", "BRIDGE_PACKAGING_MESSAGES"],
      ["BRIDGE_STATE_LABELS", "BRIDGE_STATE_MESSAGES"],
    ]) {
      const english = constant(labels);
      for (const [id, key] of Object.entries(constant(messages))) {
        assert.ok(en[key], `${messages}.${id}: ${key} missing from en/messages.json`);
        assert.equal(en[key].message, english[id], `${messages}.${id}`);
      }
    }
  });

  it("has a message for every group and tool title of the add-on, in its English", () => {
    assert.ok(titles.length > 30);
    assert.equal(titles.length, (api.match(/\n {8}title: "/g) || []).length, "a tool definition of api.js is not read");
    for (const { name, title } of titles) assert.equal(en[`toolTitle_${name}`]?.message, title, `toolTitle_${name}`);
    for (const [id, label] of Object.entries(groupLabels)) assert.equal(en[`toolGroup_${id}`]?.message, label, `toolGroup_${id}`);
    const names = new Set(titles.map((tool) => tool.name));
    for (const key of Object.keys(en)) {
      if (key.startsWith("toolTitle_")) assert.ok(names.has(key.slice("toolTitle_".length)), `${key}: no such tool`);
      if (key.startsWith("toolGroup_")) assert.ok(key.slice("toolGroup_".length) in groupLabels, `${key}: no such group`);
    }
  });
});

describe("manifest translations", () => {
  it("defaults to English, keeps the add-on name and takes its description from the messages", () => {
    assert.equal(manifest.default_locale, "en");
    assert.equal(manifest.name, "Commonpost MCP for Thunderbird");
    assert.equal(manifest.description, "__MSG_extensionDescription__");
  });

  it("has a description of at most 132 characters in each language", () => {
    for (const messages of [en, fr]) assert.ok(messages.extensionDescription.message.length <= 132, messages.extensionDescription.message);
  });
});
