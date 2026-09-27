"use strict";

// Property-based tests (fast-check) on the validators that take input from MCP clients:
// the strict Base64 check and the tool argument schema validator.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const fc = require("fast-check");

const apiSource = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");

function snippet(startMarker, endMarker) {
  const start = apiSource.indexOf(startMarker);
  const end = apiSource.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `api.js markers missing: ${startMarker}`);
  return apiSource.slice(start, end);
}

function loadValidators() {
  const sandbox = { getConfiguredGetMessagesLimit: () => 20 };
  vm.createContext(sandbox);
  vm.runInContext([
    snippet("// BEGIN INLINE ATTACHMENT BASE64 HELPERS", "// END INLINE ATTACHMENT BASE64 HELPERS"),
    snippet("// BEGIN OUTBOUND ATTACHMENT LIMITS", "// END OUTBOUND ATTACHMENT LIMITS"),
    snippet("// BEGIN CONTACT FIELD CONSTANTS", "// END CONTACT FIELD CONSTANTS"),
    snippet("// BEGIN FILTER SEARCH TERM HELPERS", "// END FILTER SEARCH TERM HELPERS"),
    snippet("// BEGIN TOOL SCHEMA BUILDER", "// END TOOL SCHEMA BUILDER"),
    snippet("// BEGIN TOOL SCHEMA VALIDATOR", "// END TOOL SCHEMA VALIDATOR"),
    "this.isValidBase64 = isValidBase64;",
    "this.buildTools = buildTools;",
    "this.validateAgainstSchema = validateAgainstSchema;",
  ].join("\n"), sandbox);
  return sandbox;
}

const { isValidBase64, buildTools, validateAgainstSchema } = loadValidators();

// Reference: standard Base64 with '=' padding only at the end, whole quartets, nothing after.
const referenceBase64 = (s) => s.length > 0 && s.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(s) && !s.includes("\n");

describe("isValidBase64 (properties)", () => {
  it("accepts the Base64 of any non-empty byte string", () => {
    fc.assert(fc.property(fc.uint8Array({ minLength: 1, maxLength: 512 }), (bytes) => {
      assert.equal(isValidBase64(Buffer.from(bytes).toString("base64")), true);
    }));
  });

  it("rejects any string that contains a character outside the Base64 alphabet", () => {
    const bad = fc.constantFrom("\n", "\r", " ", "-", "_", "\u2028", "\u2029", "\0", "\u00e9", "=");
    fc.assert(fc.property(fc.uint8Array({ minLength: 3, maxLength: 96 }), bad, fc.nat(), (bytes, ch, at) => {
      const good = Buffer.from(bytes).toString("base64");
      const i = at % (good.length + 1);
      const mutated = good.slice(0, i) + ch + good.slice(i);
      // '=' in the middle is bad; '=' at the very end may still be a valid pad only if quartets stay whole.
      assert.equal(isValidBase64(mutated), referenceBase64(mutated));
    }));
  });

  it("agrees with the reference check on arbitrary strings", () => {
    const alphabet = fc.constantFrom(..."AZaz09+/=\n-_ ");
    fc.assert(fc.property(fc.array(alphabet, { maxLength: 40 }).map((a) => a.join("")), (s) => {
      assert.equal(isValidBase64(s), referenceBase64(s));
    }), { numRuns: 500 });
  });

  it("rejects non-strings and the empty string", () => {
    fc.assert(fc.property(fc.anything(), (v) => {
      if (typeof v !== "string") assert.equal(isValidBase64(v), false);
    }));
    assert.equal(isValidBase64(""), false);
  });
});

describe("validateAgainstSchema (properties)", () => {
  const tools = buildTools();

  it("never throws, whatever JSON a client sends for any parameter of any tool", () => {
    const jsonValue = fc.jsonValue({ maxDepth: 4 });
    for (const tool of tools) {
      for (const [key, propSchema] of Object.entries(tool.inputSchema.properties || {})) {
        fc.assert(fc.property(jsonValue, (value) => {
          const errors = [];
          validateAgainstSchema(value, propSchema, key, errors);
          assert.ok(Array.isArray(errors));
        }), { numRuns: 25 });
      }
    }
  });

  it("reports an error for a value of the wrong primitive type", () => {
    for (const tool of tools) {
      for (const [key, propSchema] of Object.entries(tool.inputSchema.properties || {})) {
        if (propSchema.type !== "string" && propSchema.type !== "number" && propSchema.type !== "boolean") continue;
        const wrong = propSchema.type === "string" ? [123, true, {}, []] : ["text", {}, []];
        for (const value of wrong) {
          const errors = [];
          validateAgainstSchema(value, propSchema, key, errors);
          assert.ok(errors.length > 0, `${tool.name}.${key} accepted ${JSON.stringify(value)}`);
        }
      }
    }
  });
});
