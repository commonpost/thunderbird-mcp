"use strict";
// Experiment scripts run in a sandbox without web globals such as DOMParser or TextDecoder
// (all five imported below are undefined there in Thunderbird 156). api.js must import every one it uses, or the code
// that needs it silently takes its fallback or throws a ReferenceError inside Thunderbird only.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const API = fs.readFileSync(path.join(__dirname, "..", "extension", "mcp_server", "api.js"), "utf8");
const WEB_GLOBALS = ["atob", "btoa", "DOMParser", "TextDecoder", "TextEncoder", "URLSearchParams", "crypto", "fetch", "Blob", "File", "FileReader", "structuredClone"];

function stripCommentsAndStrings(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\])\/\/.*$/gm, "$1")
    .replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g, '""');
}

describe("experiment web globals", () => {
  const imported = (() => {
    const m = API.match(/Cu\.importGlobalProperties\(\[([^\]]*)\]\)/);
    return m ? [...m[1].matchAll(/"([^"]+)"/g)].map(x => x[1]) : [];
  })();
  const code = stripCommentsAndStrings(API);

  it("imports the web globals at the top level", () => {
    assert.ok(imported.length > 0, "Cu.importGlobalProperties call not found");
    const call = API.indexOf("Cu.importGlobalProperties(");
    assert.ok(call < API.indexOf("var commonpostMcp"), "import must run before the Experiment API is defined");
  });

  for (const name of WEB_GLOBALS) {
    it(`${name} is imported wherever it is used`, () => {
      const used = new RegExp(`(?<![.\\w$])${name}\\s*[(.]|new\\s+${name}\\b|typeof\\s+${name}\\b`).test(code);
      if (used) assert.ok(imported.includes(name), `${name} is used in api.js but not imported`);
    });
  }
});
