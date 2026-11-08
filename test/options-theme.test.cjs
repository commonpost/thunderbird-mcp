// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";

// The options page follows Thunderbird's theme: it opts in to dark mode (color-scheme), defines its colors once as
// variables with a dark set, and uses no other fixed color, so a new rule cannot bring back white on a dark theme.
// Checked in Thunderbird 156 with the dark and the light theme (November 2026).

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.resolve(__dirname, "../extension/options.html"), "utf8");
const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));

describe("options page theme", () => {
  it("opts in to the dark scheme, in the head and in the style", () => {
    assert.match(html, /<meta name="color-scheme" content="light dark">/);
    assert.match(css, /:root \{\n\s+color-scheme: light dark;/);
    assert.match(css, /@media \(prefers-color-scheme: dark\) \{\n\s+:root \{/);
  });

  it("gives every color variable a dark value", () => {
    const block = (start) => css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
    const names = (text) => [...text.matchAll(/(--[a-z-]+):/g)].map((m) => m[1]).sort();
    const light = names(block(css.indexOf(":root {")));
    const dark = names(block(css.indexOf(":root {", css.indexOf("@media (prefers-color-scheme: dark)"))));
    assert.ok(light.length >= 10);
    assert.deepEqual(dark, light);
  });

  it("uses no fixed color outside the variables, except the status dots", () => {
    const rules = css.replace(/:root \{[^}]*\}/g, "");
    const fixed = [...rules.matchAll(/[a-z-]+:\s*[^;{}]*#[0-9a-fA-F]{3,6}\b[^;]*;/g)].map((m) => m[0]);
    assert.deepEqual(fixed, ["background: #30e60b;", "background: #ff0039;"]);
    assert.doesNotMatch(html.slice(html.indexOf("</style>")), /style="[^"]*#[0-9a-fA-F]{3,6}/);
  });
});
