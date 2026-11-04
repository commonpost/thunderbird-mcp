// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";

// The checks every tools/call goes through: the schema validator, the argument coercion and validation, the
// error flag of a tool result and the answer to an MCP notification. The real code of api.js runs against small
// schemas written for the cases below.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const apiSource = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");

function snippet(name) {
  const start = apiSource.indexOf(`// BEGIN ${name}`);
  const end = apiSource.indexOf(`// END ${name}`, start);
  assert.ok(start >= 0 && end > start, `marker missing: ${name}`);
  return apiSource.slice(start, end);
}

const plain = (value) => JSON.parse(JSON.stringify(value));

const TOOLS = [
  {
    name: "demo",
    inputSchema: {
      type: "object",
      required: ["flag"],
      properties: {
        flag: { type: "boolean" },
        count: { type: "number", minimum: 1, maximum: 10 },
        whole: { type: "integer" },
        text: { type: "string", minLength: 2 },
        mode: { type: "string", enum: ["draft", "send"] },
        list: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 2 },
        anything: { type: "array" },
        shape: {
          type: "object",
          required: ["a"],
          additionalProperties: false,
          properties: { a: { type: "string" }, b: { type: "integer" } },
        },
        looseShape: { type: "object", properties: { a: { type: "string" } } },
        data: { type: "string", contentEncoding: "base64" },
        either: { anyOf: [{ type: "string", minLength: 3 }, { type: "number" }] },
        exactlyOne: { oneOf: [{ type: "string" }, { type: "string", minLength: 1 }] },
        oneOfThese: { oneOf: [{ type: "string" }, { type: "number" }] },
        maxResults: { type: "integer", maximum: 50 },
        maxBodyChars: { type: "number", maximum: 1000 },
        level: { enum: [1, "high"] },
      },
    },
  },
  { name: "unbounded", inputSchema: { type: "object", properties: { maxResults: { type: "integer" } } } },
  { name: "bare", inputSchema: { type: "object" } },
  { name: "schemaless" },
];

function load() {
  const warnings = [];
  const sandbox = { buildTools: () => TOOLS, console: { warn: (...args) => warnings.push(args) } };
  vm.createContext(sandbox);
  vm.runInContext(`${["INLINE ATTACHMENT BASE64 HELPERS", "OUTBOUND ATTACHMENT LIMITS", "TOOL SCHEMA VALIDATOR", "TOOL ARGUMENT CHECKS"].map(snippet).join("\n")}
this.api = { validateAgainstSchema, validateToolArgs, coerceToolArgs, MAX_BASE64_SIZE };`, sandbox);
  return { api: sandbox.api, warnings };
}

const { api, warnings } = load();

function validate(value, schema, name = "p") {
  const errors = [];
  api.validateAgainstSchema(value, schema, name, errors);
  return plain(errors);
}

describe("validateAgainstSchema", () => {
  it("has nothing to say about a value that is absent or a schema that is absent", () => {
    assert.deepEqual(validate(undefined, { type: "string" }), []);
    assert.deepEqual(validate(null, { type: "string" }), []);
    assert.deepEqual(validate("x", undefined), []);
    assert.deepEqual(validate("x", null), []);
  });

  it("checks an array's type and each item, and rejects a null item", () => {
    assert.deepEqual(validate("nope", { type: "array" }), ["Parameter 'p' must be an array, got string"]);
    assert.deepEqual(validate(["a", 2, null], { type: "array", items: { type: "string" } }),
      ["Parameter 'p[1]' must be string, got number", "Parameter 'p[2]' must not be null"]);
  });

  it("an array without an item schema accepts any items", () => {
    assert.deepEqual(validate([1, "a", {}], { type: "array" }), []);
  });

  it("checks an object: type, required members, unknown members and nested values", () => {
    const schema = { type: "object", required: ["a"], additionalProperties: false, properties: { a: { type: "string" }, b: { type: "integer" } } };
    assert.deepEqual(validate([], schema), ["Parameter 'p' must be an object, got array"]);
    assert.deepEqual(validate("s", schema), ["Parameter 'p' must be an object, got string"]);
    assert.deepEqual(validate({ b: 1.5, c: 1 }, schema),
      ["Missing required parameter: p.a", "Parameter 'p.b' must be an integer, got non-integer number", "Unknown parameter: p.c"]);
    assert.deepEqual(validate({ a: null }, schema), ["Missing required parameter: p.a"]);
    assert.deepEqual(validate({ a: "x", extra: 1 }, { type: "object", properties: { a: { type: "string" } } }), [], "unknown members are allowed unless forbidden");
  });

  it("an inline attachment object may carry the legacy 'content' alias beside base64 without it being checked", () => {
    const schema = {
      type: "object",
      properties: { base64: { type: "string", contentEncoding: "base64" }, content: { type: "string", contentEncoding: "base64" } },
    };
    assert.deepEqual(validate({ base64: "QUJD", content: "not base64!" }, schema), []);
    assert.deepEqual(validate({ content: "not base64!" }, schema), ["Parameter 'p.content' must contain valid base64 data"]);
    assert.deepEqual(validate({ base64: null, content: "not base64!" }, schema), ["Parameter 'p.content' must contain valid base64 data"]);
  });

  it("checks integers and the other primitive types by name", () => {
    assert.deepEqual(validate("3", { type: "integer" }), ["Parameter 'p' must be an integer, got string"]);
    assert.deepEqual(validate(2.5, { type: "integer" }), ["Parameter 'p' must be an integer, got non-integer number"]);
    assert.deepEqual(validate("yes", { type: "boolean" }), ["Parameter 'p' must be boolean, got string"]);
    assert.deepEqual(validate(3, { type: "integer", minimum: 5 }), ["Parameter 'p' must be >= 5, got 3"]);
    assert.deepEqual(validate(30, { type: "number", maximum: 10 }), ["Parameter 'p' must be <= 10, got 30"]);
    assert.deepEqual(validate(7, { type: "number", minimum: 5, maximum: 10 }), []);
  });

  it("checks the length of a string and base64 data, and the size limit before the pattern", () => {
    assert.deepEqual(validate("a", { type: "string", minLength: 2 }), ["Parameter 'p' must contain at least 2 character(s)"]);
    assert.deepEqual(validate("QUJD", { type: "string", contentEncoding: "base64" }), []);
    assert.deepEqual(validate("QUJ", { type: "string", contentEncoding: "base64" }), ["Parameter 'p' must contain valid base64 data"]);
    const huge = "A".repeat(api.MAX_BASE64_SIZE + 4);
    assert.deepEqual(validate(huge, { type: "string", contentEncoding: "base64" }),
      [`Parameter 'p' exceeds the 25 MB inline attachment limit (${huge.length} base64 characters)`]);
  });

  it("anyOf accepts a value that fits one alternative, and lists why it fits none", () => {
    const schema = { anyOf: [{ type: "string", minLength: 3 }, { type: "number" }] };
    assert.deepEqual(validate("abc", schema), []);
    assert.deepEqual(validate(4, schema), []);
    assert.deepEqual(validate("ab", schema), [
      "Parameter 'p' did not match any required schema alternative: Parameter 'p' must contain at least 3 character(s); Parameter 'p' must be number, got string",
    ]);
  });

  it("oneOf accepts a value that fits exactly one variant, refuses none and refuses more than one", () => {
    assert.deepEqual(validate("a", { oneOf: [{ type: "string" }, { type: "number" }] }), []);
    assert.deepEqual(validate(true, { oneOf: [{ type: "string" }, { type: "number" }] }),
      ["Parameter 'p' did not match any allowed schema variant: Parameter 'p' must be string, got boolean; Parameter 'p' must be number, got boolean"]);
    assert.deepEqual(validate("a", { oneOf: [{ type: "string" }, { type: "string", minLength: 1 }] }), ["Parameter 'p' matched more than one schema variant"]);
  });

  it("enum refuses a value outside the list and shows both", () => {
    assert.deepEqual(validate("fax", { type: "string", enum: ["draft", "send"] }), ["Parameter 'p' must be one of [\"draft\",\"send\"], got \"fax\""]);
    assert.deepEqual(validate("send", { type: "string", enum: ["draft", "send"] }), []);
  });
});

describe("validateToolArgs", () => {
  it("names a tool that does not exist or has no input schema", () => {
    assert.deepEqual(plain(api.validateToolArgs("missing", {})), ["Unknown tool: missing"]);
    assert.deepEqual(plain(api.validateToolArgs("schemaless", {})), ["Unknown tool: schemaless"]);
  });

  it("a schema without properties or required members accepts no argument, and no argument is fine", () => {
    assert.deepEqual(plain(api.validateToolArgs("bare", {})), []);
    assert.deepEqual(plain(api.validateToolArgs("bare", { anything: 1 })), ["Unknown parameter: anything"]);
  });

  it("reports a missing required argument, one set to null, and a name inherited from Object.prototype", () => {
    assert.deepEqual(plain(api.validateToolArgs("demo", {})), ["Missing required parameter: flag"]);
    assert.deepEqual(plain(api.validateToolArgs("demo", { flag: null })), ["Missing required parameter: flag"]);
    assert.deepEqual(plain(api.validateToolArgs("demo", { flag: true, constructor: 1, toString: "x" })),
      ["Unknown parameter: constructor", "Unknown parameter: toString"]);
  });

  it("skips an optional argument that is undefined or null, and checks the others", () => {
    assert.deepEqual(plain(api.validateToolArgs("demo", { flag: true, count: null, text: undefined })), []);
    assert.deepEqual(plain(api.validateToolArgs("demo", { flag: true, count: 11, text: "a" })),
      ["Parameter 'count' must be <= 10, got 11", "Parameter 'text' must contain at least 2 character(s)"]);
  });

  it("keeps the number of items of a list within the schema's bounds", () => {
    assert.deepEqual(plain(api.validateToolArgs("demo", { flag: true, list: [] })), ["Parameter 'list' must contain at least 1 item(s)"]);
    assert.deepEqual(plain(api.validateToolArgs("demo", { flag: true, list: ["a", "b", "c"] })), ["Parameter 'list' must contain at most 2 item(s)"]);
    assert.deepEqual(plain(api.validateToolArgs("demo", { flag: true, list: ["a"] })), []);
    assert.deepEqual(plain(api.validateToolArgs("demo", { flag: true, anything: [] })), [], "no bounds, none enforced");
    assert.deepEqual(plain(api.validateToolArgs("demo", { flag: true, list: "a" })), ["Parameter 'list' must be an array, got string"], "no bound check on what is not a list");
  });
});

describe("coerceToolArgs", () => {
  const coerce = (args) => plain(api.coerceToolArgs("demo", { ...args }));

  it("leaves the arguments of an unknown or schema-less tool as they are", () => {
    const args = { x: "1" };
    assert.equal(api.coerceToolArgs("missing", args), args);
    assert.equal(api.coerceToolArgs("schemaless", args), args);
    assert.deepEqual(plain(api.coerceToolArgs("bare", { x: "1" })), { x: "1" });
  });

  it("ignores null and undefined values and arguments the schema does not know", () => {
    assert.deepEqual(coerce({ flag: null, count: undefined, mystery: "true", constructor: "x" }), { flag: null, mystery: "true", constructor: "x" });
  });

  it("turns the text of a boolean, a number or an integer into the value, and leaves what is not one", () => {
    assert.deepEqual(coerce({ flag: "true", count: "2.5", whole: "7" }), { flag: true, count: 2.5, whole: 7 });
    assert.deepEqual(coerce({ flag: "false" }), { flag: false });
    assert.deepEqual(coerce({ flag: "maybe", count: "abc", whole: "1.5" }), { flag: "maybe", count: "abc", whole: "1.5" });
    assert.deepEqual(coerce({ count: "  ", whole: "" }), { count: "  ", whole: "" }, "blank text is not the number 0");
    assert.deepEqual(coerce({ count: "Infinity", whole: "1e400" }), { count: "Infinity", whole: "1e400" });
  });

  it("matches an enum value whatever its letter case, and leaves one that matches nothing", () => {
    assert.deepEqual(coerce({ mode: " SEND " }), { mode: "send" });
    assert.deepEqual(coerce({ mode: "Draft" }), { mode: "draft" });
    assert.deepEqual(coerce({ mode: "fax" }), { mode: "fax" });
    assert.deepEqual(coerce({ mode: 5 }), { mode: 5 });
  });

  it("parses a list or an object sent as JSON text, and leaves text that is not one, with a warning for a list", () => {
    warnings.length = 0;
    assert.deepEqual(coerce({ list: '["a","b"]', shape: '{"a":"x"}' }), { list: ["a", "b"], shape: { a: "x" } });
    assert.deepEqual(coerce({ list: '{"a":1}', shape: "[1]" }), { list: '{"a":1}', shape: "[1]" }, "a list is not an object and the reverse");
    assert.deepEqual(coerce({ list: "not json", shape: "{broken" }), { list: "not json", shape: "{broken" });
    assert.deepEqual(coerce({ shape: "null" }), { shape: "null" });
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0][0]), /coerceToolArgs JSON\.parse failed for key=list/);
  });

  it("matches an enum that holds values other than text, by its text values only", () => {
    assert.deepEqual(coerce({ level: "HIGH" }), { level: "high" });
    assert.deepEqual(coerce({ level: "low" }), { level: "low" });
  });

  it("clamps a limit only when the schema gives it a maximum", () => {
    assert.deepEqual(plain(api.coerceToolArgs("unbounded", { maxResults: "500.5" })), { maxResults: "500.5" });
    assert.deepEqual(plain(api.coerceToolArgs("unbounded", { maxResults: 500 })), { maxResults: 500 });
    assert.deepEqual(plain(api.coerceToolArgs("unbounded", { maxResults: "500" })), { maxResults: 500 });
  });

  it("brings a limit down to its maximum, and rounds a limit of an integer type down", () => {
    assert.deepEqual(coerce({ maxResults: 500, maxBodyChars: 5000 }), { maxResults: 50, maxBodyChars: 1000 });
    assert.deepEqual(coerce({ maxResults: "49.9" }), { maxResults: "49.9" }, "text that is not an integer stays text, for the validator to refuse");
    assert.deepEqual(coerce({ maxResults: "500" }), { maxResults: 50 });
    assert.deepEqual(coerce({ maxResults: 7.9 }), { maxResults: 7 });
    assert.deepEqual(coerce({ maxBodyChars: 12.5 }), { maxBodyChars: 12.5 });
    assert.deepEqual(coerce({ count: 50 }), { count: 50 }, "only the limits named maxResults and maxBodyChars are clamped");
  });
});

// The notification branch of the HTTP handler, run as the extension runs it.
function runNotificationBranch(method) {
  const calls = [];
  const sandbox = {
    method,
    res: {
      setStatusLine: (...args) => calls.push(["setStatusLine", ...args]),
      finish: () => calls.push(["finish"]),
    },
  };
  vm.runInNewContext(`(function () {\n${snippet("MCP NOTIFICATION HTTP RESPONSE")}\n})()`, sandbox);
  return calls;
}

describe("answering a notification over HTTP", () => {
  it("accepts a notifications/ method with 202 and no body", () => {
    assert.deepEqual(plain(runNotificationBranch("notifications/initialized")), [["setStatusLine", "1.1", 202, "Accepted"], ["finish"]]);
  });

  it("does not answer a method that is not a notification, or is not text, here", () => {
    assert.deepEqual(runNotificationBranch("tools/list"), []);
    assert.deepEqual(runNotificationBranch(undefined), []);
    assert.deepEqual(runNotificationBranch(7), []);
    assert.deepEqual(runNotificationBranch({ startsWith: () => true }), []);
  });
});

describe("isToolErrorResult", () => {
  const sandbox = { buildToolResultContent: (r) => [{ type: "text", text: JSON.stringify(r) }] };
  vm.createContext(sandbox);
  vm.runInContext(`${snippet("MCP TOOL PROTOCOL HELPERS")}\nthis.api = { isToolErrorResult, toolCallResult, toolCallError };`, sandbox);
  const { isToolErrorResult, toolCallResult, toolCallError } = sandbox.api;

  it("is an error only for a plain object with a non-empty error and no success: true", () => {
    assert.equal(isToolErrorResult({ error: "boom" }), true);
    assert.equal(isToolErrorResult({ error: "boom", success: false }), true);
    assert.equal(isToolErrorResult({ error: "partial", success: true }), false);
    assert.equal(isToolErrorResult({ error: "" }), false);
    assert.equal(isToolErrorResult({ error: null }), false);
    assert.equal(isToolErrorResult({}), false);
  });

  it("is never an error for something that is not an object", () => {
    for (const value of [null, undefined, 0, "", "error", 42, true, [], [{ error: "x" }]]) {
      assert.equal(isToolErrorResult(value), false, JSON.stringify(value));
    }
  });

  it("flags only error results, and turns a message into an error result", () => {
    assert.equal(toolCallResult({ error: "x" }).isError, true);
    assert.equal("isError" in toolCallResult(null), false);
    const wrapped = plain(toolCallError(new Error("failed")));
    assert.equal(wrapped.isError, true);
    assert.deepEqual(JSON.parse(wrapped.content[0].text), { error: "Error: failed" });
  });
});
