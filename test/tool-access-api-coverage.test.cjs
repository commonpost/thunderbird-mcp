// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";

// The options page reads and writes which tools are disabled, and how many
// messages getMessages returns, through getToolAccessConfig and setToolAccess.
// These tests run the real methods of api.js against an in-memory preference
// store.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const apiSource = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");

const PREF_DISABLED_TOOLS = "extensions.commonpost-mcp.disabledTools";
const PREF_KNOWN_TOOLS = "extensions.commonpost-mcp.knownTools";
const PREF_GET_MESSAGES_LIMIT = "extensions.commonpost-mcp.getMessagesLimit";

function constSource(name) {
  const start = apiSource.indexOf(`const ${name} =`);
  assert.ok(start >= 0, `${name} not found in api.js`);
  return apiSource.slice(start, apiSource.indexOf(";", start) + 1);
}

function regionSource(name) {
  const start = apiSource.indexOf(`// BEGIN ${name}`);
  const end = apiSource.indexOf(`// END ${name}`, start);
  assert.ok(start >= 0 && end > start, `${name} markers missing`);
  return apiSource.slice(start, end);
}

function functionSource(name, indent) {
  const start = apiSource.indexOf(`\n${indent}function ${name}(`);
  assert.ok(start >= 0, `${name} not found in api.js`);
  const close = `\n${indent}}\n`;
  return apiSource.slice(start, apiSource.indexOf(close, start) + close.length);
}

// An entry of the object that getAPI() returns: "        name: async function(...) { ... },"
function methodSource(name) {
  const start = apiSource.indexOf(`\n        ${name}: async function(`);
  assert.ok(start >= 0, `${name} not found in api.js`);
  const close = "\n        },\n";
  return apiSource.slice(start + 1, apiSource.indexOf(close, start) + close.length);
}

// The value crossed a vm realm: compare it as plain JSON.
const plain = (value) => JSON.parse(JSON.stringify(value));

const TOOLS = [
  // Unknown group and kinds come first: the sort then also compares other tools against them.
  { name: "mysteryTool", group: "elsewhere", crud: "sideways" },
  { name: "oddOne", group: "messages", crud: "sideways" },
  { name: "oddTwo", group: "messages", crud: "weird" },
  { name: "sendMail", group: "messages", crud: "create" },
  { name: "deleteMessages", group: "messages", crud: "delete" },
  { name: "getMessages", group: "messages", crud: "read" },
  { name: "listFilters", group: "filters", crud: "read" },
  { name: "listAccounts", group: "system", crud: "read" },
  { name: "listFolders", group: "system", crud: "read" },
  { name: "getAccountAccess", group: "system", crud: "read" },
  { name: "emptyTrash", group: "folders", crud: "delete" },
  { name: "lateMystery", group: "also-elsewhere", crud: "read" },
];

function makeWorld({ tools = TOOLS } = {}) {
  const store = new Map();
  const unreadable = new Set();
  const cleared = [];
  const prefs = {
    getStringPref(name, fallback) {
      if (unreadable.has(name)) throw new Error("NS_ERROR_UNEXPECTED");
      return store.has(name) ? store.get(name) : fallback;
    },
    getIntPref(name, fallback) {
      if (unreadable.has(name)) throw new Error("NS_ERROR_UNEXPECTED");
      return store.has(name) ? store.get(name) : fallback;
    },
    setStringPref(name, value) { store.set(name, value); },
    setIntPref(name, value) { store.set(name, value); },
    clearUserPref(name) {
      cleared.push(name);
      if (unreadable.has(`clear:${name}`)) throw new Error("NS_ERROR_UNEXPECTED");
      store.delete(name);
    },
  };
  const sandbox = { Services: { prefs }, buildTools: () => tools };
  vm.createContext(sandbox);
  vm.runInContext([
    constSource("PREF_DISABLED_TOOLS"),
    constSource("PREF_KNOWN_TOOLS"),
    constSource("PREF_GET_MESSAGES_LIMIT"),
    constSource("CRUD_ORDER"),
    constSource("UNDISABLEABLE_TOOLS"),
    regionSource("TOOL ACCESS HELPERS"),
    constSource("DEFAULT_GET_MESSAGES_LIMIT"),
    constSource("MAX_GET_MESSAGES_LIMIT"),
    constSource("GROUP_ORDER"),
    constSource("GROUP_LABELS"),
    functionSource("normalizeGetMessagesLimit", "    "),
    functionSource("getConfiguredGetMessagesLimit", "    "),
    functionSource("readToolAccess", "    "),
    `this.api = {\n${methodSource("getToolAccessConfig")}${methodSource("setToolAccess")}};`,
  ].join("\n"), sandbox);
  return { api: sandbox.api, store, unreadable, cleared };
}

describe("getToolAccessConfig", () => {
  it("reports every tool enabled when nothing is disabled, listed by group then by read, create, update, delete", async () => {
    const { api } = makeWorld();
    const config = plain(await api.getToolAccessConfig());
    assert.equal(config.mode, "all");
    assert.deepEqual(config.disabledTools, []);
    assert.equal(config.error, undefined);
    assert.equal(config.getMessagesLimit, 10);
    assert.equal(config.getMessagesLimitMin, 1);
    assert.equal(config.getMessagesLimitMax, 20);
    assert.equal(config.groups.messages, "Mail");
    assert.deepEqual(config.tools.map((t) => t.name), [
      "listAccounts", "listFolders", "getAccountAccess", // system, all "read": kept in the order given
      "getMessages", "sendMail", "deleteMessages", "oddOne", "oddTwo", // messages: a CRUD kind that is not known goes last
      "emptyTrash", // folders
      "listFilters", // filters
      "lateMystery", "mysteryTool", // groups that are not known go last, then by CRUD kind (a known one before an unknown one)
    ]);
    assert.ok(config.tools.every((t) => t.enabled));
  });

  it("marks the three infrastructure tools as impossible to disable and none of the others", async () => {
    const { api } = makeWorld();
    const config = plain(await api.getToolAccessConfig());
    const locked = config.tools.filter((t) => t.undisableable).map((t) => t.name).sort();
    assert.deepEqual(locked, ["getAccountAccess", "listAccounts", "listFolders"]);
  });

  it("gives the getMessages entry, and only that one, its limit and the bounds", async () => {
    const { api, store } = makeWorld();
    store.set(PREF_GET_MESSAGES_LIMIT, 15);
    const config = plain(await api.getToolAccessConfig());
    assert.equal(config.getMessagesLimit, 15);
    for (const tool of config.tools) {
      if (tool.name === "getMessages") {
        assert.equal(tool.getMessagesLimit, 15);
        assert.equal(tool.getMessagesLimitMin, 1);
        assert.equal(tool.getMessagesLimitMax, 20);
      } else {
        assert.equal("getMessagesLimit" in tool, false, tool.name);
      }
    }
  });

  it("reads an out-of-range or unreadable limit preference as the clamped value or the default", async () => {
    const high = makeWorld();
    high.store.set(PREF_GET_MESSAGES_LIMIT, 500);
    assert.equal((await high.api.getToolAccessConfig()).getMessagesLimit, 20);
    const low = makeWorld();
    low.store.set(PREF_GET_MESSAGES_LIMIT, -4);
    assert.equal((await low.api.getToolAccessConfig()).getMessagesLimit, 1);
    const broken = makeWorld();
    broken.unreadable.add(PREF_GET_MESSAGES_LIMIT);
    assert.equal((await broken.api.getToolAccessConfig()).getMessagesLimit, 10);
  });

  it("lists the disabled tools as disabled and reports the restricted mode", async () => {
    const { api, store } = makeWorld();
    store.set(PREF_DISABLED_TOOLS, JSON.stringify(["sendMail", "emptyTrash"]));
    store.set(PREF_KNOWN_TOOLS, JSON.stringify(TOOLS.map((t) => t.name)));
    const config = plain(await api.getToolAccessConfig());
    assert.equal(config.mode, "restricted");
    assert.deepEqual(config.disabledTools, ["sendMail", "emptyTrash"]);
    assert.deepEqual(config.tools.filter((t) => !t.enabled).map((t) => t.name).sort(), ["emptyTrash", "sendMail"]);
    assert.deepEqual(config.newTools, []);
    assert.ok(config.tools.every((t) => t.isNew === undefined));
    assert.equal(config.error, undefined);
  });

  it("restricted: a tool the user has not seen (not in knownTools) is off and reported new", async () => {
    const { api, store } = makeWorld();
    store.set(PREF_DISABLED_TOOLS, JSON.stringify(["sendMail"]));
    store.set(PREF_KNOWN_TOOLS, JSON.stringify(TOOLS.map((t) => t.name).filter((n) => n !== "getMessages")));
    const config = plain(await api.getToolAccessConfig());
    assert.equal(config.mode, "restricted");
    assert.deepEqual(config.disabledTools, ["sendMail"]);
    assert.deepEqual(config.newTools, ["getMessages"]);
    const byName = Object.fromEntries(config.tools.map((t) => [t.name, t]));
    assert.equal(byName.getMessages.enabled, false);
    assert.equal(byName.getMessages.isNew, true);
    assert.equal(byName.deleteMessages.enabled, true);
    assert.equal(byName.sendMail.isNew, undefined);
  });

  it("upgrade: with no knownTools, the tools outside the 0.18.2 list are new when restricted, not otherwise", async () => {
    const restricted = makeWorld();
    restricted.store.set(PREF_DISABLED_TOOLS, JSON.stringify(["sendMail"]));
    const config = plain(await restricted.api.getToolAccessConfig());
    // The test tools that 0.18.2 did not have; the infrastructure tools are never new
    assert.deepEqual([...config.newTools].sort(), ["lateMystery", "mysteryTool", "oddOne", "oddTwo"]);
    assert.ok(config.tools.filter((t) => t.isNew).every((t) => !t.enabled));

    const open = makeWorld();
    const all = plain(await open.api.getToolAccessConfig());
    assert.deepEqual(all.newTools, []);
    assert.ok(all.tools.every((t) => t.enabled));
  });

  it("an empty preference means nothing is disabled", async () => {
    const { api, store } = makeWorld();
    store.set(PREF_DISABLED_TOOLS, "");
    const config = plain(await api.getToolAccessConfig());
    assert.equal(config.mode, "all");
    assert.ok(config.tools.every((t) => t.enabled));
  });

  for (const [label, setup] of [
    ["text that is not JSON", (w) => w.store.set(PREF_DISABLED_TOOLS, "{not json")],
    ["JSON that is not a list", (w) => w.store.set(PREF_DISABLED_TOOLS, JSON.stringify({ sendMail: true }))],
    ["a list holding something other than names", (w) => w.store.set(PREF_DISABLED_TOOLS, JSON.stringify(["sendMail", 7]))],
    ["a preference that cannot be read", (w) => w.unreadable.add(PREF_DISABLED_TOOLS)],
  ]) {
    it(`fails closed on ${label}: error mode, only the infrastructure tools stay enabled`, async () => {
      const world = makeWorld();
      setup(world);
      const config = plain(await world.api.getToolAccessConfig());
      assert.equal(config.mode, "error");
      assert.deepEqual(config.disabledTools, []);
      assert.match(config.error, /Disabled tools preference is corrupt\. All non-infrastructure tools are blocked\. Save to reset\./);
      assert.deepEqual(config.tools.filter((t) => t.enabled).map((t) => t.name).sort(),
        ["getAccountAccess", "listAccounts", "listFolders"]);
    });
  }
});

describe("setToolAccess", () => {
  it("refuses anything but a list of strings", async () => {
    const { api, store } = makeWorld();
    assert.deepEqual(plain(await api.setToolAccess("sendMail")), { error: "disabledTools must be an array" });
    assert.deepEqual(plain(await api.setToolAccess(undefined)), { error: "disabledTools must be an array" });
    assert.deepEqual(plain(await api.setToolAccess(["sendMail", 3])), { error: "All tool names must be strings" });
    assert.deepEqual(plain(await api.setToolAccess([null])), { error: "All tool names must be strings" });
    assert.equal(store.size, 0, "nothing is stored after a refusal");
  });

  it("refuses the internal __all__ marker, which would block every tool", async () => {
    const { api, store } = makeWorld();
    assert.deepEqual(plain(await api.setToolAccess(["sendMail", "__all__"])), { error: "Invalid tool name: __all__" });
    assert.equal(store.size, 0);
  });

  it("refuses to disable the infrastructure tools and names them", async () => {
    const { api, store } = makeWorld();
    const result = plain(await api.setToolAccess(["sendMail", "listFolders", "getAccountAccess"]));
    assert.deepEqual(result, { error: "Cannot disable infrastructure tools: listFolders, getAccountAccess" });
    assert.equal(store.size, 0);
  });

  it("stores the disabled tools as JSON and reports the restricted mode", async () => {
    const { api, store } = makeWorld();
    const result = plain(await api.setToolAccess(["sendMail", "emptyTrash"]));
    assert.deepEqual(result, { success: true, mode: "restricted", disabledTools: ["sendMail", "emptyTrash"], getMessagesLimit: 10 });
    assert.equal(store.get(PREF_DISABLED_TOOLS), '["sendMail","emptyTrash"]');
  });

  it("an empty list removes the preference and reports mode all, even when the removal fails", async () => {
    const world = makeWorld();
    world.store.set(PREF_DISABLED_TOOLS, '["sendMail"]');
    const result = plain(await world.api.setToolAccess([]));
    assert.deepEqual(result, { success: true, mode: "all", disabledTools: [], getMessagesLimit: 10 });
    assert.equal(world.store.has(PREF_DISABLED_TOOLS), false);

    const stubborn = makeWorld();
    stubborn.unreadable.add(`clear:${PREF_DISABLED_TOOLS}`);
    stubborn.unreadable.add(`clear:${PREF_KNOWN_TOOLS}`);
    const again = plain(await stubborn.api.setToolAccess([]));
    assert.equal(again.success, true);
    assert.deepEqual(stubborn.cleared, [PREF_DISABLED_TOOLS, PREF_KNOWN_TOOLS]);
  });

  it("an empty list also forgets knownTools: with no restriction, tools added later are on", async () => {
    const world = makeWorld();
    world.store.set(PREF_DISABLED_TOOLS, '["sendMail"]');
    world.store.set(PREF_KNOWN_TOOLS, '["sendMail"]');
    await world.api.setToolAccess([]);
    assert.equal(world.store.has(PREF_KNOWN_TOOLS), false);
  });

  it("a restriction records every tool of this version as seen, so only later tools become new", async () => {
    const world = makeWorld();
    await world.api.setToolAccess(["sendMail"]);
    assert.deepEqual(JSON.parse(world.store.get(PREF_KNOWN_TOOLS)), TOOLS.map((t) => t.name));
    const config = plain(await world.api.getToolAccessConfig());
    assert.deepEqual(config.newTools, []);
    assert.deepEqual(config.tools.filter((t) => !t.enabled).map((t) => t.name), ["sendMail"]);

    const later = makeWorld({ tools: [...TOOLS, { name: "deleteTask", group: "calendar", crud: "delete" }] });
    later.store.set(PREF_DISABLED_TOOLS, world.store.get(PREF_DISABLED_TOOLS));
    later.store.set(PREF_KNOWN_TOOLS, world.store.get(PREF_KNOWN_TOOLS));
    const after = plain(await later.api.getToolAccessConfig());
    assert.deepEqual(after.newTools, ["deleteTask"]);
    assert.equal(after.tools.find((t) => t.name === "deleteTask").enabled, false);
  });

  it("does not touch the limit when none is given (undefined, null or an empty string)", async () => {
    for (const value of [undefined, null, ""]) {
      const world = makeWorld();
      world.store.set(PREF_GET_MESSAGES_LIMIT, 17);
      const result = plain(await world.api.setToolAccess(["sendMail"], value));
      assert.equal(result.getMessagesLimit, 17, String(value));
      assert.equal(world.store.get(PREF_GET_MESSAGES_LIMIT), 17);
    }
  });

  it("stores a limit other than the default and reports it, also when given as text", async () => {
    const world = makeWorld();
    const result = plain(await world.api.setToolAccess([], "15"));
    assert.equal(result.getMessagesLimit, 15);
    assert.equal(world.store.get(PREF_GET_MESSAGES_LIMIT), 15);
    const edge = plain(await world.api.setToolAccess([], 20));
    assert.equal(edge.getMessagesLimit, 20);
    const low = plain(await world.api.setToolAccess([], 1));
    assert.equal(low.getMessagesLimit, 1);
  });

  it("setting the limit back to the default removes the preference instead of storing 10", async () => {
    const world = makeWorld();
    world.store.set(PREF_GET_MESSAGES_LIMIT, 15);
    const result = plain(await world.api.setToolAccess([], 10));
    assert.equal(result.getMessagesLimit, 10);
    assert.equal(world.store.has(PREF_GET_MESSAGES_LIMIT), false);

    const stubborn = makeWorld();
    stubborn.unreadable.add(`clear:${PREF_GET_MESSAGES_LIMIT}`);
    assert.equal(plain(await stubborn.api.setToolAccess([], 10)).success, true);
  });

  it("refuses a limit that is not a whole number or is out of range, and writes nothing", async () => {
    for (const bad of ["many", 2.5, "3.1", NaN]) {
      const world = makeWorld();
      const result = plain(await world.api.setToolAccess(["sendMail"], bad));
      assert.deepEqual(result, { error: "getMessagesLimit must be an integer" }, String(bad));
      assert.equal(world.store.size, 0, "the disabled tools are not written either");
    }
    for (const bad of [0, -1, 21, "100"]) {
      const world = makeWorld();
      const result = plain(await world.api.setToolAccess(["sendMail"], bad));
      assert.deepEqual(result, { error: "getMessagesLimit must be between 1 and 20" }, String(bad));
      assert.equal(world.store.size, 0);
    }
  });
});
