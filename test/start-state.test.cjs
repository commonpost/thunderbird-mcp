"use strict";

// failed MCP server start must be visible and
// retryable without restarting Thunderbird (upstream issue #179).

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const apiPath = path.resolve(__dirname, "../extension/mcp_server/api.js");
const apiSource = fs.readFileSync(apiPath, "utf8");

function loadStartStateHelpers() {
  const startMarker = "// BEGIN SERVER START STATE HELPERS";
  const endMarker = "// END SERVER START STATE HELPERS";
  const start = apiSource.indexOf(startMarker);
  const end = apiSource.indexOf(endMarker);
  assert.ok(start >= 0, "server start state helper start marker missing");
  assert.ok(end > start, "server start state helper end marker missing");
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(
    `${apiSource.slice(start, end)}
this.runGuardedStart = runGuardedStart;
this.computeServerRunState = computeServerRunState;
this.describeStartError = describeStartError;`,
    sandbox
  );
  return sandbox;
}

const { runGuardedStart, computeServerRunState, describeStartError } = loadStartStateHelpers();

// Mimics the production start body: fully synchronous, and its catch block
// used to clear the cached promise itself (the #179 bug).
function failingBody(state, calls, message = "Error: thunderbird-mcp tmp directory has group/world permissions") {
  return async () => {
    calls.push("fail");
    state.__tbMcpStartPromise = null; // legacy reset, runs before the promise is stored
    return { success: false, error: message };
  };
}

function succeedingBody(state, calls, port = 8765) {
  return async () => {
    calls.push("ok");
    state.__tbMcpServer = { port };
    return { success: true, port };
  };
}

describe("server start state (#179)", () => {
  it("a failed start does not leave a cached promise behind and is reported", async () => {
    const state = {};
    const calls = [];
    const result = await runGuardedStart(state, failingBody(state, calls));
    assert.equal(result.success, false);
    assert.equal(state.__tbMcpStartPromise, null, "failed start must not stay cached");
    assert.match(state.__tbMcpStartError.message, /group\/world permissions/);
    assert.match(state.__tbMcpStartError.at, /^\d{4}-\d{2}-\d{2}T/);
    const info = computeServerRunState(state);
    assert.equal(info.running, false, "a failed start must not be reported as running");
    assert.match(info.startError, /group\/world permissions/);
    assert.equal(info.startErrorAt, state.__tbMcpStartError.at);
  });

  it("a retry after a failure runs the start body again and clears the error", async () => {
    const state = {};
    const calls = [];
    await runGuardedStart(state, failingBody(state, calls));
    const result = await runGuardedStart(state, succeedingBody(state, calls));
    assert.deepEqual(calls, ["fail", "ok"]);
    assert.equal(result.success, true);
    assert.equal(state.__tbMcpStartError, null);
    const info = computeServerRunState(state);
    assert.equal(info.running, true);
    assert.equal(info.startError, null);
  });

  it("a successful start stays cached: a second start does not rebind", async () => {
    const state = {};
    const calls = [];
    await runGuardedStart(state, succeedingBody(state, calls));
    const again = await runGuardedStart(state, succeedingBody(state, calls, 9999));
    assert.deepEqual(calls, ["ok"]);
    assert.equal(again.port, 8765);
  });

  it("concurrent starts share one attempt", async () => {
    const state = {};
    const calls = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const body = async () => {
      calls.push("start");
      await gate;
      state.__tbMcpServer = {};
      return { success: true, port: 8766 };
    };
    const a = runGuardedStart(state, body);
    const b = runGuardedStart(state, body);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    assert.deepEqual(calls, ["start"]);
    assert.equal(ra.port, 8766);
    assert.equal(rb.port, 8766);
  });

  it("a start body that throws is turned into a reported failure", async () => {
    const state = {};
    const result = await runGuardedStart(state, () => { throw new Error("boom"); });
    assert.equal(result.success, false);
    assert.equal(result.error, "Error: boom");
    assert.equal(state.__tbMcpStartPromise, null);
    assert.equal(computeServerRunState(state).startError, "Error: boom");
  });

  it("running follows the bound server, and hides a stale error once bound", () => {
    assert.deepEqual(
      JSON.parse(JSON.stringify(computeServerRunState({ __tbMcpStartPromise: Promise.resolve({ success: false }) }))),
      { running: false, startError: null, startErrorAt: null },
      "a truthy promise alone is not 'running'"
    );
    const info = computeServerRunState({ __tbMcpServer: {}, __tbMcpStartError: { message: "old", at: "x" } });
    assert.equal(info.running, true);
    assert.equal(info.startError, null);
  });

  it("describeStartError never throws", () => {
    assert.equal(describeStartError(undefined), "Unknown error");
    assert.equal(describeStartError("plain"), "plain");
    assert.equal(describeStartError({ toString() { throw new Error("x"); } }), "Unknown error");
  });
});

describe("server start wiring (#179)", () => {
  it("start() goes through runGuardedStart and the body no longer clears the promise", () => {
    const startIdx = apiSource.indexOf("start: async function()");
    const retryIdx = apiSource.indexOf("retryStart: async function()");
    assert.ok(startIdx > 0 && retryIdx > startIdx, "start/retryStart not found");
    const startSource = apiSource.slice(startIdx, retryIdx);
    assert.match(startSource, /return await runGuardedStart\(globalThis, async \(\) => \{/);
    assert.doesNotMatch(startSource, /__tbMcpStartPromise\s*=/);
  });

  it("getServerInfo derives running from computeServerRunState and returns the error", () => {
    const idx = apiSource.indexOf("getServerInfo: async function()");
    const body = apiSource.slice(idx, apiSource.indexOf("getCurrentAuthToken: async function()", idx));
    assert.match(body, /computeServerRunState\(globalThis\)/);
    assert.match(body, /startError: runState\.startError/);
    assert.doesNotMatch(body, /running: !!globalThis\.__tbMcpStartPromise/);
  });

  it("retryStart is declared in the experiment schema and wired in the options page", () => {
    const schema = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/schema.json"), "utf8"));
    const names = schema[0].functions.map((f) => f.name);
    assert.ok(names.includes("retryStart"));
    const html = fs.readFileSync(path.resolve(__dirname, "../extension/options.html"), "utf8");
    const js = fs.readFileSync(path.resolve(__dirname, "../extension/options.js"), "utf8");
    assert.match(html, /id="retryStartBtn"/);
    assert.match(html, /id="startErrorText"/);
    assert.match(js, /browser\.mcpServer\.retryStart\(\)/);
    assert.match(js, /info\.startError/);
  });
});
