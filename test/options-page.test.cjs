// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";

// Behaviour of the add-on options page script (extension/options.js).
//
// The real script is run in a vm context against a small fake DOM that is
// built from extension/options.html (every id of the page exists in the fake
// document) and a fake `browser.commonpostMcp` that records its calls and
// returns configurable results, error objects or thrown errors. Each test
// opens a fresh page.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const optionsPath = path.resolve(__dirname, "../extension/options.js");
const optionsSource = fs.readFileSync(optionsPath, "utf8");
const optionsHtml = fs.readFileSync(path.resolve(__dirname, "../extension/options.html"), "utf8");

// ---------------------------------------------------------------------------
// Fake DOM
// ---------------------------------------------------------------------------

class FakeText {
  constructor(text) {
    this.nodeType = 3;
    this.textContent = String(text);
    this.parentNode = null;
  }
}

const SIMPLE_SELECTOR = /^([a-z]+)\[([a-z-]+)="([^"]*)"\]$/;
const ATTRIBUTE_SELECTOR = /^\[([a-z0-9-]+)\]$/;

class FakeElement {
  constructor(tagName) {
    this.nodeType = 1;
    this.tagName = String(tagName).toUpperCase();
    this.id = "";
    this.className = "";
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = "";
    this.type = this.tagName === "INPUT" ? "text" : "";
    this.dataset = {};
    this.style = {};
    this.children = [];
    this.parentNode = null;
    this._text = "";
    this._attrs = new Map();
    this._listeners = new Map();
  }

  // Own text first, then the text of the children (the order in which options.js builds its labels).
  get textContent() {
    return this._text + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }

  get ownText() {
    return this._text;
  }

  // options.js only assigns "" or a single list item with a plain message.
  set innerHTML(markup) {
    this._text = "";
    this.children = [];
    if (markup === "") return;
    const single = /^<li>([^<]*)<\/li>$/.exec(markup);
    if (!single) throw new Error("FakeElement.innerHTML: unsupported markup " + markup);
    const li = new FakeElement("li");
    li.textContent = single[1];
    this.appendChild(li);
  }

  setAttribute(name, value) { this._attrs.set(name, String(value)); }
  getAttribute(name) { return this._attrs.has(name) ? this._attrs.get(name) : null; }
  removeAttribute(name) { this._attrs.delete(name); }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...nodes) {
    for (const node of nodes) {
      this.appendChild(typeof node === "string" ? new FakeText(node) : node);
    }
  }

  replaceChildren(...nodes) {
    this._text = "";
    this.children = [];
    this.append(...nodes);
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index < 0) throw new Error("removeChild: not a child");
    this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  // Only the selectors options.js uses: tag[attr="value"] and [attr], matched in the whole subtree.
  querySelectorAll(selector) {
    const attribute = ATTRIBUTE_SELECTOR.exec(selector);
    if (attribute) return descendants(this).filter((el) => el._attrs.has(attribute[1]));
    const parsed = SIMPLE_SELECTOR.exec(selector);
    if (!parsed) throw new Error("FakeElement.querySelectorAll: unsupported selector " + selector);
    const [, tag, attr, expected] = parsed;
    return descendants(this).filter((el) => {
      if (el.tagName !== tag.toUpperCase()) return false;
      const actual = el._attrs.has(attr) ? el._attrs.get(attr) : el[attr];
      return actual === expected;
    });
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  addEventListener(type, listener) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(listener);
  }

  // Runs the listeners of `type` and waits for the async ones.
  async dispatch(type, extra = {}) {
    const event = {
      type,
      target: this,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      ...extra,
    };
    const running = (this._listeners.get(type) || []).map((listener) => listener.call(this, event));
    await Promise.all(running);
    return event;
  }
}

function descendants(root) {
  const found = [];
  for (const child of root.children) {
    if (child.nodeType !== 1) continue;
    found.push(child, ...descendants(child));
  }
  return found;
}

function findById(root, id) {
  return descendants(root).find((el) => el.id === id) || null;
}

function parseAttributes(text) {
  const attrs = new Map();
  for (const m of text.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) {
    attrs.set(m[1], m[2] === undefined ? "" : m[2]);
  }
  return attrs;
}

// One element per tag of options.html that carries an id, with the initial
// state the markup gives it (hidden, disabled, type, name, value, class, style).
function makeDocument() {
  const byId = new Map();
  const body = new FakeElement("body");
  for (const tag of optionsHtml.matchAll(/<(\w+)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*>/g)) {
    const attrs = parseAttributes(tag[2]);
    if (!attrs.has("id")) continue;
    const el = new FakeElement(tag[1]);
    for (const [name, value] of attrs) el.setAttribute(name, value);
    el.id = attrs.get("id");
    el.className = attrs.get("class") || "";
    el.hidden = attrs.has("hidden");
    el.disabled = attrs.has("disabled");
    if (attrs.has("type")) el.type = attrs.get("type");
    if (attrs.has("name")) el.name = attrs.get("name");
    if (attrs.has("value")) el.value = attrs.get("value");
    const display = /display:\s*(\w+)/.exec(attrs.get("style") || "");
    if (display) el.style.display = display[1];
    byId.set(el.id, el);
    body.appendChild(el);
  }
  return {
    ids: [...byId.keys()],
    document: {
      body,
      getElementById: (id) => byId.get(id) || null,
      createElement: (tagName) => new FakeElement(tagName),
      createTextNode: (text) => new FakeText(text),
      querySelectorAll: (selector) => body.querySelectorAll(selector),
      querySelector: (selector) => body.querySelector(selector),
    },
  };
}

// ---------------------------------------------------------------------------
// Fake browser.commonpostMcp
// ---------------------------------------------------------------------------

const ACCOUNTS = [
  { id: "id1", name: "Work", type: "imap", allowed: true },
  { id: "id2", name: "Home", type: "pop3", allowed: true },
  { id: "id3", name: "Local Folders", type: "none", allowed: true },
];

const TOOL_CONFIG = {
  groups: { accounts: "Accounts", messages: "Messages" },
  getMessagesLimit: 10,
  getMessagesLimitMin: 1,
  getMessagesLimitMax: 20,
  tools: [
    { name: "listAccounts", group: "accounts", crud: "read", enabled: true, undisableable: true },
    { name: "searchMessages", group: "messages", crud: "read", enabled: true },
    { name: "getMessages", group: "messages", crud: "read", enabled: true },
    { name: "sendMail", group: "messages", crud: "create", enabled: false },
    { name: "deleteMessages", group: "messages", crud: "delete", enabled: true },
  ],
};

const DEFAULT_RESULTS = {
  getServerInfo: {
    running: true,
    port: 8765,
    connectionFile: "/home/user/.thunderbird/commonpost-mcp-connection.json",
    buildVersion: "v0.18.0",
    originalExtensionActive: false,
  },
  getCurrentAuthToken: { authToken: "session-token-1" },
  getStableAuthToken: { stableAuthToken: "" },
  generateAuthToken: { authToken: "generated-token-1" },
  setStableAuthToken: (token) => ({ stableAuthToken: token }),
  getAccountAccessConfig: { mode: "all", accounts: ACCOUNTS },
  setAccountAccess: { success: true },
  getToolAccessConfig: TOOL_CONFIG,
  setToolAccess: { success: true },
  getBlockSkipReview: { blockSkipReview: true },
  setBlockSkipReview: { success: true },
  getBlockCalendarSkipReview: { blockCalendarSkipReview: true },
  setBlockCalendarSkipReview: { success: true },
  getBlockFilterForwardReply: { blockFilterForwardReply: true },
  setBlockFilterForwardReply: { success: true },
  getAllowEncryptedContent: { allowEncryptedContent: false },
  setAllowEncryptedContent: { success: true },
  getListenAll: { listenAll: false },
  setListenAll: { success: true },
  retryStart: { success: true },
  getBridgeStatus: {
    extensionVersion: "0.18.0",
    minBridgeVersion: "0.17.0",
    securityFloor: "0.0.0",
    currentBridgeVersion: "0.18.0",
    bridges: [],
  },
};

// browser.i18n.getMessage on extension/_locales/en/messages.json, as Thunderbird resolves it: the $NAME$
// placeholders take their content, then $1-$9 take the substitutions. So the English of the page comes from
// messages.json, and every English assertion below also checks it.
const readMessages = (lang) => JSON.parse(fs.readFileSync(path.resolve(__dirname, `../extension/_locales/${lang}/messages.json`), "utf8"));
const enMessages = readMessages("en");

function getMessage(messages, key, substitutions) {
  const entry = messages[key];
  if (!entry) return "";
  const values = substitutions === undefined ? [] : [].concat(substitutions);
  for (const value of values) assert.equal(typeof value, "string", `getMessage("${key}"): substitutions are strings`);
  const placeholders = entry.placeholders || {};
  const expanded = entry.message.replace(/\$([A-Za-z0-9_@]+)\$/g, (whole, name) => {
    const placeholder = placeholders[name.toLowerCase()];
    return placeholder ? placeholder.content : whole;
  });
  return expanded.replace(/\$(?:([1-9]\d*)|(\$+))/g, (whole, index, dollars) => {
    if (index) return values[Number(index) - 1] ?? "";
    return dollars;
  });
}

// A result is a constant (returned as a copy), or a function of the call
// arguments that returns the result or throws.
function makeBrowser(overrides, openDefaultBrowser, messages = enMessages) {
  const calls = [];
  const results = { ...DEFAULT_RESULTS, ...overrides };
  const commonpostMcp = {};
  for (const name of Object.keys(DEFAULT_RESULTS)) {
    commonpostMcp[name] = async (...args) => {
      calls.push({ name, args: structuredClone(args) });
      const result = results[name];
      return typeof result === "function" ? result(...args) : structuredClone(result);
    };
  }
  return { calls, browser: { commonpostMcp, windows: { openDefaultBrowser }, i18n: { getMessage: (key, substitutions) => getMessage(messages, key, substitutions) } } };
}

// ---------------------------------------------------------------------------
// Page harness
// ---------------------------------------------------------------------------

async function settle() {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => { setImmediate(resolve); });
  }
}

// `options.clipboard`: undefined = a recording clipboard, null = no clipboard API, or a custom object.
// `options.openDefaultBrowser`: replaces the recording fake.
// `options.messages`: the messages.json the page reads (default: English).
async function openPage(overrides = {}, options = {}) {
  const { document, ids } = makeDocument();
  const opened = [];
  const clipboardWrites = [];
  const consoleErrors = [];
  const openDefaultBrowser = options.openDefaultBrowser || (async (url) => { opened.push(url); });
  const { browser, calls } = makeBrowser(overrides, openDefaultBrowser, options.messages);
  let clipboard = options.clipboard;
  if (clipboard === undefined) {
    clipboard = { writeText: async (text) => { clipboardWrites.push(text); } };
  }
  const context = vm.createContext({
    document,
    browser,
    navigator: { clipboard: clipboard === null ? undefined : clipboard },
    console: { error: (...args) => consoleErrors.push(args) },
  });
  vm.runInContext(optionsSource, context, { filename: optionsPath });
  await settle();

  const $ = (id) => {
    const el = document.getElementById(id);
    assert.ok(el, `no element #${id} in options.html`);
    return el;
  };
  return {
    $,
    ids,
    opened,
    clipboardWrites,
    consoleErrors,
    // Arguments of every call to a commonpostMcp method, in order.
    callsTo: (name) => calls.filter((call) => call.name === name).map((call) => call.args),
    // Dispatch an event, then let everything it started finish.
    async fire(el, type, extra) {
      const event = await el.dispatch(type, extra);
      await settle();
      return event;
    },
    async click(id) {
      await $(id).dispatch("click");
      await settle();
    },
    async setChecked(el, checked) {
      el.checked = checked;
      await el.dispatch("change");
      await settle();
    },
  };
}

// ---------------------------------------------------------------------------
// Small helpers for the assertions
// ---------------------------------------------------------------------------

function accountCheckboxes(page) {
  return page.$("accountList").querySelectorAll('input[type="checkbox"]');
}

function toolCheckboxes(page) {
  return page.$("toolList").querySelectorAll('input[type="checkbox"]');
}

function toolRows(list) {
  return list.children.map((li) => {
    if (li.className === "tool-group-header") return `group ${li.textContent}`;
    if (li.className === "tool-crud-header") return `crud ${li.textContent}`;
    return `tool ${li.children[1].ownText}`;
  });
}

function limitInput(page) {
  return findById(page.$("toolList"), "getMessagesLimit");
}

// Stateful fakes: a save is visible in the next load, as with the real API.
function statefulAccounts(initialAllowedIds) {
  let allowedIds = initialAllowedIds;
  return {
    getAccountAccessConfig: () => ({
      mode: allowedIds.length === 0 ? "all" : "restricted",
      accounts: ACCOUNTS.map((a) => ({ ...a, allowed: allowedIds.length === 0 || allowedIds.includes(a.id) })),
    }),
    setAccountAccess: (ids) => {
      allowedIds = ids;
      return { success: true };
    },
  };
}

function statefulTools(initialDisabled, initialLimit) {
  let disabledNames = initialDisabled;
  let limit = initialLimit;
  return {
    getToolAccessConfig: () => ({
      ...TOOL_CONFIG,
      getMessagesLimit: limit,
      tools: TOOL_CONFIG.tools.map((t) => ({ ...t, enabled: t.undisableable || !disabledNames.includes(t.name) })),
    }),
    setToolAccess: (names, newLimit) => {
      disabledNames = names;
      if (newLimit !== undefined) limit = newLimit;
      return { success: true };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("options page: markup and script stay in sync", () => {
  it("every element id read by options.js exists in options.html", () => {
    const wanted = [...optionsSource.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]);
    assert.ok(wanted.length > 40, "expected the script to look up many elements");
    const defined = new Set([...optionsHtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    for (const id of wanted) assert.ok(defined.has(id), `#${id} is read by options.js but not defined in options.html`);
  });

  it("the fake document holds one element for every id of options.html", async () => {
    const page = await openPage();
    const defined = [...optionsHtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(page.ids, defined);
  });

  it("the page loads on a healthy server without logging an error", async () => {
    const page = await openPage();
    assert.deepEqual(page.consoleErrors, []);
  });

  it("every section loads once when the page opens", async () => {
    const page = await openPage();
    for (const name of [
      "getServerInfo", "getCurrentAuthToken", "getStableAuthToken", "getAccountAccessConfig", "getToolAccessConfig",
      "getBlockSkipReview", "getBlockCalendarSkipReview", "getBlockFilterForwardReply", "getAllowEncryptedContent",
      "getListenAll", "getBridgeStatus",
    ]) {
      assert.equal(page.callsTo(name).length, 1, name);
    }
  });
});

describe("options page: server status", () => {
  it("shows a running server with its port, connection file and build", async () => {
    const page = await openPage();
    assert.equal(page.$("statusDot").className, "status-dot running");
    assert.equal(page.$("statusText").textContent, "Running");
    assert.equal(page.$("serverPort").textContent, "8765");
    assert.equal(page.$("connFile").textContent, "/home/user/.thunderbird/commonpost-mcp-connection.json");
    assert.equal(page.$("buildInfo").textContent, "v0.18.0 (v0.18.0)");
    assert.equal(page.$("startErrorRow").hidden, true);
    assert.equal(page.$("startErrorText").textContent, "");
    assert.equal(page.$("originalExtensionRow").hidden, true);
  });

  it("shows placeholders when a running server reports no port or connection file", async () => {
    const page = await openPage({ getServerInfo: { running: true } });
    assert.equal(page.$("statusText").textContent, "Running");
    assert.equal(page.$("serverPort").textContent, "--");
    assert.equal(page.$("connFile").textContent, "--");
    assert.equal(page.$("buildInfo").textContent, "--");
  });

  it("shows the start error with its UTC time and a retry button when the start failed", async () => {
    const page = await openPage({
      getServerInfo: {
        running: false,
        startError: "Address already in use",
        startErrorAt: "2026-11-03T14:05:09.321Z",
        port: 8765,
        connectionFile: "/stale/file.json",
      },
    });
    assert.equal(page.$("statusDot").className, "status-dot stopped");
    assert.equal(page.$("statusText").textContent, "Start failed");
    assert.equal(page.$("serverPort").textContent, "--");
    assert.equal(page.$("connFile").textContent, "--");
    assert.equal(page.$("startErrorRow").hidden, false);
    assert.equal(page.$("startErrorText").textContent, "Address already in use (2026-11-03 14:05:09 UTC)");
    assert.equal(page.$("retryStartBtn").disabled, false);
  });

  it("shows the start error without a time when none is recorded", async () => {
    const page = await openPage({ getServerInfo: { running: false, startError: "Port 8765 is busy" } });
    assert.equal(page.$("startErrorText").textContent, "Port 8765 is busy");
    assert.equal(page.$("startErrorRow").hidden, false);
  });

  it("reports a stopped server that never failed to start", async () => {
    const page = await openPage({ getServerInfo: { running: false } });
    assert.equal(page.$("statusDot").className, "status-dot stopped");
    assert.equal(page.$("statusText").textContent, "Not running");
    assert.equal(page.$("serverPort").textContent, "--");
    assert.equal(page.$("startErrorText").textContent, "Server is not running.");
    assert.equal(page.$("startErrorRow").hidden, false);
  });

  it("shows the notice when the original add-on is active", async () => {
    const page = await openPage({ getServerInfo: { running: true, port: 1, originalExtensionActive: true } });
    assert.equal(page.$("originalExtensionRow").hidden, false);
  });

  it("keeps the notice hidden when the original add-on is not active", async () => {
    const page = await openPage({ getServerInfo: { running: true, port: 1, originalExtensionActive: false } });
    assert.equal(page.$("originalExtensionRow").hidden, true);
  });

  it("shows an error when the server info cannot be read", async () => {
    const page = await openPage({ getServerInfo: () => { throw new Error("experiment API unavailable"); } });
    assert.equal(page.$("statusDot").className, "status-dot stopped");
    assert.equal(page.$("statusText").textContent, "Error: experiment API unavailable");
    assert.deepEqual(page.consoleErrors, []);
  });

  const BUILD_CASES = [
    ["a release tag", "v0.18.0", undefined, "v0.18.0 (v0.18.0)"],
    ["commits after a tag", "v0.2.0-7-g1461f1a", undefined, "v0.2.0 +7 (1461f1a)"],
    ["zero commits after a tag", "v0.2.0-0-g1461f1a", undefined, "v0.2.0 (1461f1a)"],
    ["a dirty build with its date", "v0.2.0-7-g1461f1a+dirty", "2026-11-03T10:11:12.345Z", "v0.2.0 +7 (1461f1a) +dirty 2026-11-03 10:11:12 UTC"],
    ["a dirty build without a date", "v0.2.0-7-g1461f1a+dirty", undefined, "v0.2.0 +7 (1461f1a) +dirty"],
    ["a version string that is not git describe output", "custom-build-42", undefined, "custom-build-42"],
    ["an empty version", "", undefined, "--"],
    ["no version", undefined, undefined, "--"],
  ];
  for (const [label, buildVersion, buildDate, expected] of BUILD_CASES) {
    it(`formats the build for ${label}`, async () => {
      const page = await openPage({ getServerInfo: { running: true, port: 1, buildVersion, buildDate } });
      assert.equal(page.$("buildInfo").textContent, expected);
    });
  }
});

describe("options page: retry start", () => {
  const STOPPED = { running: false, startError: "Address already in use" };

  // First read: stopped; every later read: running (the retry worked).
  function stoppedThenRunning() {
    let reads = 0;
    return () => {
      reads += 1;
      return reads === 1 ? STOPPED : { running: true, port: 9001, connectionFile: "/new/conn.json" };
    };
  }

  it("starts the server, shows 'Started.' and refreshes the status and the token", async () => {
    const page = await openPage({ getServerInfo: stoppedThenRunning() });
    assert.equal(page.$("statusText").textContent, "Start failed");
    await page.click("retryStartBtn");
    assert.equal(page.callsTo("retryStart").length, 1);
    assert.equal(page.$("retryStartStatus").textContent, "Started.");
    assert.equal(page.$("retryStartStatus").className, "save-status");
    assert.equal(page.$("retryStartBtn").disabled, false);
    assert.equal(page.$("statusText").textContent, "Running");
    assert.equal(page.$("serverPort").textContent, "9001");
    assert.equal(page.$("startErrorRow").hidden, true);
    assert.equal(page.callsTo("getServerInfo").length, 2);
    assert.equal(page.callsTo("getCurrentAuthToken").length, 2);
    assert.equal(page.callsTo("getStableAuthToken").length, 2);
  });

  it("says so when the server was already running", async () => {
    const page = await openPage({
      getServerInfo: STOPPED,
      retryStart: { success: true, alreadyRunning: true },
    });
    await page.click("retryStartBtn");
    assert.equal(page.$("retryStartStatus").textContent, "Already running.");
  });

  it("shows the reason when the start fails again", async () => {
    const page = await openPage({ getServerInfo: STOPPED, retryStart: { success: false, error: "port busy" } });
    await page.click("retryStartBtn");
    assert.equal(page.$("retryStartStatus").textContent, "Failed: port busy");
    assert.equal(page.$("retryStartStatus").className, "save-status error");
    assert.equal(page.$("retryStartBtn").disabled, false);
    assert.equal(page.$("statusText").textContent, "Start failed");
  });

  it("falls back to 'unknown error' when the failure has no reason", async () => {
    const page = await openPage({ getServerInfo: STOPPED, retryStart: { success: false } });
    await page.click("retryStartBtn");
    assert.equal(page.$("retryStartStatus").textContent, "Failed: unknown error");
    assert.equal(page.$("retryStartStatus").className, "save-status error");
  });

  it("treats an empty answer as a failure", async () => {
    const page = await openPage({ getServerInfo: STOPPED, retryStart: null });
    await page.click("retryStartBtn");
    assert.equal(page.$("retryStartStatus").textContent, "Failed: unknown error");
  });

  it("shows the error when the call throws, and still refreshes the status", async () => {
    const page = await openPage({
      getServerInfo: STOPPED,
      retryStart: () => { throw new Error("no permission"); },
    });
    await page.click("retryStartBtn");
    assert.equal(page.$("retryStartStatus").textContent, "Error: no permission");
    assert.equal(page.$("retryStartStatus").className, "save-status error");
    assert.equal(page.$("retryStartBtn").disabled, false);
    assert.equal(page.callsTo("getServerInfo").length, 2);
  });

  it("disables the button and shows 'Starting...' while the start runs", async () => {
    const ref = {};
    const seen = [];
    ref.page = await openPage({
      getServerInfo: STOPPED,
      retryStart: () => {
        seen.push([ref.page.$("retryStartBtn").disabled, ref.page.$("retryStartStatus").textContent]);
        return { success: true };
      },
    });
    await ref.page.click("retryStartBtn");
    assert.deepEqual(seen, [[true, "Starting..."]]);
  });
});

describe("options page: authentication", () => {
  it("shows the session token and an unchecked stable-token setting", async () => {
    const page = await openPage();
    assert.equal(page.$("currentAuthToken").value, "session-token-1");
    assert.equal(page.$("copyAuthTokenBtn").disabled, false);
    assert.equal(page.$("copyAuthTokenStatus").textContent, "");
    assert.equal(page.$("useStableAuthToken").checked, false);
    assert.equal(page.$("stableAuthToken").value, "");
    assert.equal(page.$("stableAuthTokenControls").hidden, true);
    assert.equal(page.$("stableAuthTokenStatus").textContent, "");
  });

  it("checks the setting and shows the controls when a stable token is stored", async () => {
    const page = await openPage({ getStableAuthToken: { stableAuthToken: "stable-abc" } });
    assert.equal(page.$("useStableAuthToken").checked, true);
    assert.equal(page.$("stableAuthToken").value, "stable-abc");
    assert.equal(page.$("stableAuthTokenControls").hidden, false);
  });

  it("disables Copy when there is no session token", async () => {
    const page = await openPage({ getCurrentAuthToken: {} });
    assert.equal(page.$("currentAuthToken").value, "");
    assert.equal(page.$("copyAuthTokenBtn").disabled, true);
  });

  it("reports a failure to read the tokens", async () => {
    const page = await openPage({ getCurrentAuthToken: () => { throw new Error("denied"); } });
    assert.equal(page.$("copyAuthTokenStatus").textContent, "Error loading token: denied");
    assert.equal(page.$("copyAuthTokenStatus").className, "save-status error");
    assert.equal(page.$("stableAuthTokenStatus").textContent, "Error loading setting: denied");
    assert.equal(page.$("stableAuthTokenStatus").className, "save-status error");
  });

  describe("copy", () => {
    it("copies the session token and confirms", async () => {
      const ref = {};
      const disabledDuringWrite = [];
      ref.page = await openPage({}, {
        clipboard: { writeText: async () => { disabledDuringWrite.push(ref.page.$("copyAuthTokenBtn").disabled); } },
      });
      await ref.page.click("copyAuthTokenBtn");
      assert.deepEqual(disabledDuringWrite, [true]);
      assert.equal(ref.page.$("copyAuthTokenStatus").textContent, "Copied.");
      assert.equal(ref.page.$("copyAuthTokenStatus").className, "save-status");
      assert.equal(ref.page.$("copyAuthTokenBtn").disabled, false);
    });

    it("writes exactly the token shown", async () => {
      const page = await openPage();
      await page.click("copyAuthTokenBtn");
      assert.deepEqual(page.clipboardWrites, ["session-token-1"]);
    });

    it("shows the error when the clipboard refuses", async () => {
      const page = await openPage({}, { clipboard: { writeText: async () => { throw new Error("denied by the browser"); } } });
      await page.click("copyAuthTokenBtn");
      assert.equal(page.$("copyAuthTokenStatus").textContent, "Error: denied by the browser");
      assert.equal(page.$("copyAuthTokenStatus").className, "save-status error");
      assert.equal(page.$("copyAuthTokenBtn").disabled, false);
    });

    it("shows an error instead of throwing when there is no clipboard API", async () => {
      const page = await openPage({}, { clipboard: null });
      await page.click("copyAuthTokenBtn");
      assert.match(page.$("copyAuthTokenStatus").textContent, /^Error: /);
      assert.equal(page.$("copyAuthTokenStatus").className, "save-status error");
      assert.equal(page.$("copyAuthTokenBtn").disabled, false);
    });
  });

  describe("stable token setting", () => {
    it("generates and stores a token when the setting is switched on", async () => {
      const page = await openPage();
      await page.setChecked(page.$("useStableAuthToken"), true);
      assert.equal(page.callsTo("generateAuthToken").length, 1);
      assert.deepEqual(page.callsTo("setStableAuthToken"), [["generated-token-1"]]);
      assert.equal(page.$("stableAuthToken").value, "generated-token-1");
      assert.equal(page.$("stableAuthTokenStatus").textContent, "Generated and saved.");
      assert.equal(page.$("stableAuthTokenStatus").className, "save-status");
      assert.equal(page.$("stableAuthTokenControls").hidden, false);
      assert.equal(page.$("useStableAuthToken").disabled, false);
    });

    it("saves the trimmed text instead of generating when the box already holds a token", async () => {
      const page = await openPage();
      page.$("stableAuthToken").value = "  typed-token  ";
      await page.setChecked(page.$("useStableAuthToken"), true);
      assert.equal(page.callsTo("generateAuthToken").length, 0);
      assert.deepEqual(page.callsTo("setStableAuthToken"), [["typed-token"]]);
      assert.equal(page.$("stableAuthToken").value, "typed-token");
      assert.equal(page.$("stableAuthTokenStatus").textContent, "Saved.");
    });

    it("clears the stored token when the setting is switched off", async () => {
      const page = await openPage({ getStableAuthToken: { stableAuthToken: "stable-abc" } });
      await page.setChecked(page.$("useStableAuthToken"), false);
      assert.deepEqual(page.callsTo("setStableAuthToken"), [[""]]);
      assert.equal(page.$("stableAuthToken").value, "");
      assert.equal(page.$("stableAuthTokenStatus").textContent, "Stable token cleared.");
      assert.equal(page.$("stableAuthTokenControls").hidden, true);
    });

    it("ignores edits of the token box while the setting is off", async () => {
      const page = await openPage();
      page.$("stableAuthToken").value = "whatever";
      await page.fire(page.$("stableAuthToken"), "change");
      assert.equal(page.callsTo("setStableAuthToken").length, 0);
      assert.equal(page.callsTo("generateAuthToken").length, 0);
    });

    it("saves a token typed by hand, trimmed", async () => {
      const page = await openPage({ getStableAuthToken: { stableAuthToken: "stable-abc" } });
      page.$("stableAuthToken").value = " my-own-token ";
      await page.fire(page.$("stableAuthToken"), "change");
      assert.deepEqual(page.callsTo("setStableAuthToken"), [["my-own-token"]]);
      assert.equal(page.$("stableAuthToken").value, "my-own-token");
      assert.equal(page.$("stableAuthTokenStatus").textContent, "Saved.");
    });

    it("generates a new token when the box is emptied while the setting is on", async () => {
      const page = await openPage({ getStableAuthToken: { stableAuthToken: "stable-abc" } });
      page.$("stableAuthToken").value = "   ";
      await page.fire(page.$("stableAuthToken"), "change");
      assert.equal(page.callsTo("generateAuthToken").length, 1);
      assert.deepEqual(page.callsTo("setStableAuthToken"), [["generated-token-1"]]);
      assert.equal(page.$("stableAuthTokenStatus").textContent, "Generated and saved.");
    });

    it("Generate stores a fresh token", async () => {
      const page = await openPage({ getStableAuthToken: { stableAuthToken: "stable-abc" } });
      await page.click("generateStableAuthTokenBtn");
      assert.deepEqual(page.callsTo("setStableAuthToken"), [["generated-token-1"]]);
      assert.equal(page.$("stableAuthToken").value, "generated-token-1");
      assert.equal(page.$("stableAuthTokenStatus").textContent, "Generated and saved.");
    });

    it("Regenerate replaces the token and says so", async () => {
      const page = await openPage({ getStableAuthToken: { stableAuthToken: "stable-abc" } });
      await page.click("regenerateStableAuthTokenBtn");
      assert.deepEqual(page.callsTo("setStableAuthToken"), [["generated-token-1"]]);
      assert.equal(page.$("stableAuthToken").value, "generated-token-1");
      assert.equal(page.$("stableAuthTokenStatus").textContent, "Regenerated and saved.");
    });

    it("locks the controls while a save is running and unlocks them after", async () => {
      const ref = {};
      const seen = [];
      ref.page = await openPage({
        getStableAuthToken: { stableAuthToken: "stable-abc" },
        setStableAuthToken: (token) => {
          seen.push(["useStableAuthToken", "stableAuthToken", "generateStableAuthTokenBtn", "regenerateStableAuthTokenBtn"]
            .map((id) => ref.page.$(id).disabled));
          seen.push(ref.page.$("stableAuthTokenStatus").textContent);
          return { stableAuthToken: token };
        },
      });
      await ref.page.click("regenerateStableAuthTokenBtn");
      assert.deepEqual(seen, [[true, true, true, true], "Saving..."]);
      for (const id of ["useStableAuthToken", "stableAuthToken", "generateStableAuthTokenBtn", "regenerateStableAuthTokenBtn"]) {
        assert.equal(ref.page.$(id).disabled, false, id);
      }
    });

    it("shows the error and stores nothing when the token cannot be generated", async () => {
      const page = await openPage({ generateAuthToken: { error: "no randomness available" } });
      await page.click("generateStableAuthTokenBtn");
      assert.equal(page.callsTo("setStableAuthToken").length, 0);
      assert.equal(page.$("stableAuthTokenStatus").textContent, "Error: no randomness available");
      assert.equal(page.$("stableAuthTokenStatus").className, "save-status error");
      assert.equal(page.$("generateStableAuthTokenBtn").disabled, false);
    });

    it("rejects an empty generated token", async () => {
      const page = await openPage({ generateAuthToken: {} });
      await page.click("regenerateStableAuthTokenBtn");
      assert.equal(page.callsTo("setStableAuthToken").length, 0);
      assert.equal(page.$("stableAuthTokenStatus").textContent, "Error: Generated token was empty");
      assert.equal(page.$("stableAuthTokenStatus").className, "save-status error");
    });

    it("shows the reason when the host refuses the token", async () => {
      const page = await openPage({ setStableAuthToken: { error: "Token must be at least 16 characters" } });
      await page.click("generateStableAuthTokenBtn");
      assert.equal(page.$("stableAuthTokenStatus").textContent, "Token must be at least 16 characters");
      assert.equal(page.$("stableAuthTokenStatus").className, "save-status error");
      assert.equal(page.$("regenerateStableAuthTokenBtn").disabled, false);
    });

    it("shows the error when saving a typed token throws", async () => {
      const page = await openPage({
        getStableAuthToken: { stableAuthToken: "stable-abc" },
        setStableAuthToken: () => { throw new Error("prefs locked"); },
      });
      page.$("stableAuthToken").value = "another-token";
      await page.fire(page.$("stableAuthToken"), "change");
      assert.equal(page.$("stableAuthTokenStatus").textContent, "Error: prefs locked");
      assert.equal(page.$("stableAuthTokenStatus").className, "save-status error");
      assert.equal(page.$("useStableAuthToken").disabled, false);
    });
  });
});

describe("options page: account access", () => {
  it("lists every account with its type, checked as allowed", async () => {
    const page = await openPage();
    const boxes = accountCheckboxes(page);
    assert.deepEqual(boxes.map((b) => b.id), ["acct-id1", "acct-id2", "acct-id3"]);
    assert.deepEqual(boxes.map((b) => b.value), ["id1", "id2", "id3"]);
    assert.deepEqual(boxes.map((b) => b.checked), [true, true, true]);
    const rows = page.$("accountList").children;
    assert.deepEqual(rows.map((li) => li.children[1].ownText), ["Work", "Home", "Local Folders"]);
    assert.deepEqual(rows.map((li) => li.children[1].children[0].textContent), ["IMAP", "POP3", "local"]);
    assert.deepEqual(rows.map((li) => li.children[1].htmlFor), ["acct-id1", "acct-id2", "acct-id3"]);
    assert.equal(rows[0].children[1].children[0].className, "account-type");
    assert.equal(page.$("saveBtn").disabled, false);
    assert.equal(page.$("saveStatus").textContent, "");
  });

  it("reflects a restriction already saved", async () => {
    const page = await openPage(statefulAccounts(["id2"]));
    assert.deepEqual(accountCheckboxes(page).map((b) => b.checked), [false, true, false]);
  });

  it("says so when there are no accounts, and leaves Save disabled", async () => {
    const page = await openPage({ getAccountAccessConfig: { mode: "all", accounts: [] } });
    assert.equal(page.$("accountList").children.length, 1);
    assert.equal(page.$("accountList").children[0].textContent, "No accounts found.");
    assert.equal(page.$("saveBtn").disabled, true);
  });

  it("treats a missing account list as empty", async () => {
    const page = await openPage({ getAccountAccessConfig: {} });
    assert.equal(page.$("accountList").children[0].textContent, "No accounts found.");
  });

  it("shows the error when the accounts cannot be loaded", async () => {
    const page = await openPage({ getAccountAccessConfig: () => { throw new Error("accounts unavailable"); } });
    assert.equal(page.$("accountList").children.length, 1);
    assert.equal(page.$("accountList").children[0].textContent, "Error loading accounts: accounts unavailable");
    assert.equal(page.$("saveBtn").disabled, true);
  });

  it("saves the checked accounts, then reloads the list", async () => {
    const page = await openPage(statefulAccounts([]));
    await page.setChecked(accountCheckboxes(page)[1], false);
    await page.click("saveBtn");
    assert.deepEqual(page.callsTo("setAccountAccess"), [[["id1", "id3"]]]);
    assert.equal(page.callsTo("getAccountAccessConfig").length, 2);
    assert.deepEqual(accountCheckboxes(page).map((b) => b.checked), [true, false, true]);
    assert.equal(page.$("saveStatus").textContent, "Saved.");
    assert.equal(page.$("saveBtn").disabled, false);
  });

  it("sends an empty list (all accounts) when every account is checked", async () => {
    const page = await openPage(statefulAccounts(["id1"]));
    for (const box of accountCheckboxes(page)) await page.setChecked(box, true);
    await page.click("saveBtn");
    assert.deepEqual(page.callsTo("setAccountAccess"), [[[]]]);
    assert.deepEqual(accountCheckboxes(page).map((b) => b.checked), [true, true, true]);
  });

  it("refuses an empty selection instead of opening every account", async () => {
    const page = await openPage();
    for (const box of accountCheckboxes(page)) await page.setChecked(box, false);
    await page.click("saveBtn");
    assert.equal(page.callsTo("setAccountAccess").length, 0);
    assert.equal(page.$("saveStatus").textContent, "Select at least one account.");
    assert.equal(page.$("saveStatus").className, "save-status error");
    assert.equal(page.$("saveBtn").disabled, false);
  });

  it("clears an old message when a checkbox is changed", async () => {
    const page = await openPage();
    page.$("saveStatus").textContent = "Select at least one account.";
    await page.setChecked(accountCheckboxes(page)[0], false);
    assert.equal(page.$("saveStatus").textContent, "");
  });

  it("shows the error returned by the host and does not reload", async () => {
    const page = await openPage({ setAccountAccess: { error: "Unknown account id3" } });
    await page.setChecked(accountCheckboxes(page)[2], false);
    await page.click("saveBtn");
    assert.equal(page.$("saveStatus").textContent, "Unknown account id3");
    assert.equal(page.$("saveStatus").className, "save-status error");
    assert.equal(page.callsTo("getAccountAccessConfig").length, 1);
    assert.equal(page.$("saveBtn").disabled, false);
  });

  it("shows the error when the save throws", async () => {
    const page = await openPage({ setAccountAccess: () => { throw new Error("prefs locked"); } });
    await page.setChecked(accountCheckboxes(page)[2], false);
    await page.click("saveBtn");
    assert.equal(page.$("saveStatus").textContent, "Error: prefs locked");
    assert.equal(page.$("saveStatus").className, "save-status error");
    assert.equal(page.$("saveBtn").disabled, false);
  });

  describe("after an unreadable saved restriction", () => {
    const unreadable = (allowed) => ({
      getAccountAccessConfig: { mode: "invalid", accounts: ACCOUNTS.map((a) => ({ ...a, allowed })) },
    });
    const WARNING = "The saved account restriction could not be read: every account is blocked until you save a new choice.";

    it("warns and keeps the warning when a checkbox changes", async () => {
      const page = await openPage(unreadable(false));
      assert.equal(page.$("saveStatus").textContent, WARNING);
      assert.equal(page.$("saveStatus").className, "save-status error");
      assert.equal(page.$("saveBtn").disabled, false);
      await page.setChecked(accountCheckboxes(page)[0], true);
      assert.equal(page.$("saveStatus").textContent, WARNING);
    });

    it("saves a partial selection at once", async () => {
      const page = await openPage(unreadable(false));
      await page.setChecked(accountCheckboxes(page)[0], true);
      await page.click("saveBtn");
      assert.deepEqual(page.callsTo("setAccountAccess"), [[["id1"]]]);
    });

    it("asks for a second click before allowing every account", async () => {
      const page = await openPage(unreadable(false));
      for (const box of accountCheckboxes(page)) await page.setChecked(box, true);
      await page.click("saveBtn");
      assert.equal(page.callsTo("setAccountAccess").length, 0);
      assert.equal(
        page.$("saveStatus").textContent,
        "The saved restriction was unreadable and everything is blocked. Click Save again to allow every account.",
      );
      assert.equal(page.$("saveStatus").className, "save-status error");
      assert.equal(page.$("saveBtn").disabled, false);
      await page.click("saveBtn");
      assert.deepEqual(page.callsTo("setAccountAccess"), [[[]]]);
    });

    it("asks again if the selection changed between the two clicks", async () => {
      const page = await openPage(unreadable(true));
      await page.click("saveBtn");
      assert.equal(page.callsTo("setAccountAccess").length, 0);
      // The user unchecks and rechecks an account: the confirmation no longer counts.
      await page.setChecked(accountCheckboxes(page)[0], false);
      await page.setChecked(accountCheckboxes(page)[0], true);
      await page.click("saveBtn");
      assert.equal(page.callsTo("setAccountAccess").length, 0);
      await page.click("saveBtn");
      assert.deepEqual(page.callsTo("setAccountAccess"), [[[]]]);
    });
  });
});

describe("options page: tool access", () => {
  it("groups the tools under group and CRUD headers", async () => {
    const page = await openPage();
    assert.deepEqual(toolRows(page.$("toolList")), [
      "group Accounts", "crud Read", "tool listAccounts",
      "group Messages", "crud Read", "tool searchMessages", "tool getMessages",
      "crud Create", "tool sendMail",
      "crud Delete", "tool deleteMessages",
    ]);
    assert.equal(page.$("saveToolsBtn").disabled, false);
    assert.equal(page.$("saveToolsStatus").textContent, "");
  });

  it("checks the enabled tools and locks the required ones", async () => {
    const page = await openPage();
    const boxes = toolCheckboxes(page);
    assert.deepEqual(boxes.map((b) => b.value), ["listAccounts", "searchMessages", "getMessages", "sendMail", "deleteMessages"]);
    assert.deepEqual(boxes.map((b) => b.checked), [true, true, true, false, true]);
    assert.deepEqual(boxes.map((b) => b.disabled), [true, false, false, false, false]);
    assert.deepEqual(boxes.map((b) => b.id), boxes.map((b) => "tool-" + b.value));
    const required = page.$("toolList").children.find((li) => li.children[0] === boxes[0]);
    assert.equal(required.children[1].children[0].textContent, "required");
    const optional = page.$("toolList").children.find((li) => li.children[0] === boxes[1]);
    assert.equal(optional.children[1].children.length, 0);
  });

  it("marks the tools added by an update since the tools were restricted, and names them above the list", async () => {
    const page = await openPage({
      getToolAccessConfig: {
        ...TOOL_CONFIG,
        newTools: ["deleteTask"],
        tools: [
          ...TOOL_CONFIG.tools,
          { name: "deleteTask", group: "calendar", crud: "delete", enabled: false, isNew: true },
        ],
      },
    });
    const boxes = toolCheckboxes(page);
    const box = boxes.find((b) => b.value === "deleteTask");
    assert.equal(box.checked, false);
    assert.equal(box.disabled, false);
    const row = page.$("toolList").children.find((li) => li.children[0] === box);
    assert.equal(row.children[1].children[0].textContent, "new");
    assert.equal(page.$("newToolsNote").hidden, false);
    assert.match(page.$("newToolsNote").textContent, /deleteTask/);
  });

  it("hides the new-tools note when no tool is new", async () => {
    const page = await openPage();
    assert.equal(page.$("newToolsNote").hidden, true);
    assert.equal(page.$("newToolsNote").textContent, "");
  });

  it("keeps the list folded unless an update brought tools that wait for the user", async () => {
    const folded = await openPage();
    assert.ok(!folded.$("toolDetails").open);
    const opened = await openPage({
      getToolAccessConfig: {
        ...TOOL_CONFIG,
        newTools: ["deleteTask"],
        tools: [...TOOL_CONFIG.tools, { name: "deleteTask", group: "calendar", crud: "delete", enabled: false, isNew: true }],
      },
    });
    assert.equal(opened.$("toolDetails").open, true);
  });

  it("says next to the folded list how many tools are on, and follows the checkboxes", async () => {
    const page = await openPage();
    const boxes = toolCheckboxes(page);
    const total = boxes.length;
    const on = boxes.filter((b) => b.checked).length;
    assert.equal(page.$("toolSummary").textContent, on === total ? `(all ${total} on)` : `(${on} of ${total} on)`);
    const box = boxes.find((b) => b.checked && !b.disabled);
    box.checked = false;
    await page.fire(box, "change");
    assert.equal(page.$("toolSummary").textContent, `(${on - 1} of ${total} on)`);
  });

  it("names a tool by its title, with the name clients see beside it", async () => {
    const page = await openPage({
      getToolAccessConfig: { tools: [{ name: "searchContacts", title: "Search Contacts", group: "contacts", crud: "read", enabled: true }] },
    });
    const row = page.$("toolList").children.find((li) => li.className !== "tool-group-header" && li.className !== "tool-crud-header");
    const label = row.children[1];
    assert.equal(label.ownText.trim(), "Search Contacts");
    const code = label.children.find((el) => el.tagName === "CODE");
    assert.equal(code.textContent, "searchContacts");
  });

  it("capitalizes the group and CRUD names it has no label for", async () => {
    const page = await openPage({
      getToolAccessConfig: {
        tools: [
          { name: "alpha", group: "calendar", crud: "update", enabled: true },
          { name: "gamma", group: "calendar", crud: "archive", enabled: true },
          { name: "beta", enabled: true },
        ],
      },
    });
    assert.deepEqual(toolRows(page.$("toolList")), [
      "group Calendar", "crud Change", "tool alpha",
      "crud Archive", "tool gamma",
      "group Other", "crud Other", "tool beta",
    ]);
  });

  it("says so when there are no tools, and leaves Save disabled", async () => {
    const page = await openPage({ getToolAccessConfig: { tools: [] } });
    assert.equal(page.$("toolList").children[0].textContent, "No tools found.");
    assert.equal(page.$("saveToolsBtn").disabled, true);
  });

  it("treats a missing tool list as empty", async () => {
    const page = await openPage({ getToolAccessConfig: {} });
    assert.equal(page.$("toolList").children[0].textContent, "No tools found.");
  });

  it("shows the error when the tools cannot be loaded", async () => {
    const page = await openPage({ getToolAccessConfig: () => { throw new Error("tools unavailable"); } });
    assert.equal(page.$("toolList").children.length, 1);
    assert.equal(page.$("toolList").children[0].textContent, "Error loading tools: tools unavailable");
    assert.equal(page.$("saveToolsBtn").disabled, true);
  });

  describe("getMessages limit", () => {
    it("adds a numeric limit input to getMessages only, with the range from the host", async () => {
      const page = await openPage();
      const input = limitInput(page);
      assert.ok(input);
      assert.equal(descendants(page.$("toolList")).filter((el) => el.id === "getMessagesLimit").length, 1);
      assert.equal(input.type, "text");
      assert.equal(input.inputMode, "numeric");
      assert.equal(input.value, "10");
      assert.equal(input.dataset.min, "1");
      assert.equal(input.dataset.max, "20");
      assert.equal(input.disabled, false);
      const li = input.parentNode.parentNode;
      assert.equal(li.className, "tool-with-option");
      assert.equal(li.children[0].value, "getMessages");
      assert.equal(input.parentNode.className, "tool-option");
      assert.equal(input.parentNode.children[0].htmlFor, "getMessagesLimit");
      assert.equal(input.parentNode.children[0].textContent, "Max full messages per call");
      assert.equal(input.parentNode.children[2].className, "range-note");
      assert.equal(input.parentNode.children[2].textContent, "1-20");
      assert.equal(li.children[3].className, "tool-limit-error");
      assert.equal(li.children[3].textContent, "");
    });

    it("prefers the range of the tool entry over the one of the whole answer", async () => {
      const page = await openPage({
        getToolAccessConfig: {
          ...TOOL_CONFIG,
          tools: TOOL_CONFIG.tools.map((t) => (t.name === "getMessages"
            ? { ...t, getMessagesLimit: 7, getMessagesLimitMin: 2, getMessagesLimitMax: 15 }
            : t)),
        },
      });
      const input = limitInput(page);
      assert.equal(input.value, "7");
      assert.equal(input.dataset.min, "2");
      assert.equal(input.dataset.max, "15");
    });

    it("falls back to 1, 20 and 10 when the host gives no range or value", async () => {
      const page = await openPage({
        getToolAccessConfig: { tools: [{ name: "getMessages", group: "messages", crud: "read", enabled: true }] },
      });
      const input = limitInput(page);
      assert.equal(input.dataset.min, "1");
      assert.equal(input.dataset.max, "20");
      assert.equal(input.value, "10");
    });

    it("has no limit input when getMessages is not offered", async () => {
      const page = await openPage({
        getToolAccessConfig: { tools: [{ name: "searchMessages", group: "messages", crud: "read", enabled: true }] },
      });
      assert.equal(limitInput(page), null);
    });

    it("starts the input disabled when getMessages is disabled", async () => {
      const page = await openPage({
        getToolAccessConfig: {
          ...TOOL_CONFIG,
          tools: TOOL_CONFIG.tools.map((t) => (t.name === "getMessages" ? { ...t, enabled: false } : t)),
        },
      });
      assert.equal(limitInput(page).disabled, true);
    });

    const LIMIT_CASES = [
      ["1", 1],
      ["10", 10],
      ["20", 20],
      [" 7 ", 7],
      ["007", 7],
      ["0", null],
      ["21", null],
      ["100", null],
      ["-3", null],
      ["", null],
      ["   ", null],
      ["abc", null],
      ["1.5", null],
      ["1e1", null],
      ["+5", null],
      ["5 6", null],
    ];
    for (const [typed, expected] of LIMIT_CASES) {
      it(`input ${JSON.stringify(typed)} is ${expected === null ? "rejected" : "accepted as " + expected}`, async () => {
        const page = await openPage();
        const input = limitInput(page);
        const status = input.parentNode.parentNode.children[3];
        input.value = typed;
        await page.fire(input, "input");
        if (expected === null) {
          assert.equal(input.getAttribute("aria-invalid"), "true");
          assert.equal(status.textContent, "Enter an integer from 1 to 20.");
        } else {
          assert.equal(input.getAttribute("aria-invalid"), null);
          assert.equal(status.textContent, "");
          await page.click("saveToolsBtn");
          assert.deepEqual(page.callsTo("setToolAccess").map((args) => args[1]), [expected]);
        }
      });
    }

    it("uses the range sent by the host in the error message and the bounds", async () => {
      const page = await openPage({
        getToolAccessConfig: { ...TOOL_CONFIG, getMessagesLimitMin: 3, getMessagesLimitMax: 8 },
      });
      const input = limitInput(page);
      const status = input.parentNode.parentNode.children[3];
      for (const [typed, valid] of [["2", false], ["3", true], ["8", true], ["9", false]]) {
        input.value = typed;
        await page.fire(input, "input");
        assert.equal(input.getAttribute("aria-invalid") === "true", !valid, typed);
        assert.equal(status.textContent, valid ? "" : "Enter an integer from 3 to 8.", typed);
      }
    });

    it("clears the invalid mark when the input becomes valid again", async () => {
      const page = await openPage();
      const input = limitInput(page);
      input.value = "x";
      await page.fire(input, "input");
      assert.equal(input.getAttribute("aria-invalid"), "true");
      input.value = "12";
      await page.fire(input, "input");
      assert.equal(input.getAttribute("aria-invalid"), null);
    });

    it("clears the saved message when the input is edited", async () => {
      const page = await openPage();
      page.$("saveToolsStatus").textContent = "Saved.";
      await page.fire(limitInput(page), "input");
      assert.equal(page.$("saveToolsStatus").textContent, "");
    });

    it("disables the input and clears its error when getMessages is unchecked, and validates again when rechecked", async () => {
      const page = await openPage();
      const input = limitInput(page);
      const status = input.parentNode.parentNode.children[3];
      const box = input.parentNode.parentNode.children[0];
      input.value = "abc";
      await page.fire(input, "input");
      assert.equal(status.textContent, "Enter an integer from 1 to 20.");

      await page.setChecked(box, false);
      assert.equal(input.disabled, true);
      assert.equal(input.getAttribute("aria-invalid"), null);
      assert.equal(status.textContent, "");

      await page.setChecked(box, true);
      assert.equal(input.disabled, false);
      assert.equal(input.getAttribute("aria-invalid"), "true");
      assert.equal(status.textContent, "Enter an integer from 1 to 20.");
    });
  });

  describe("saving", () => {
    it("sends the unchecked tools and the limit, then reloads the list", async () => {
      const page = await openPage(statefulTools([], 10));
      const boxes = toolCheckboxes(page);
      await page.setChecked(boxes[1], false);
      await page.setChecked(boxes[2], false);
      await page.setChecked(boxes[3], true);
      limitInput(page).value = "15";
      await page.fire(limitInput(page), "input");
      await page.click("saveToolsBtn");
      // getMessages is unchecked, so its (disabled) limit field is not sent and the stored limit stays
      assert.deepEqual(page.callsTo("setToolAccess"), [[["searchMessages", "getMessages"], undefined]]);
      assert.equal(page.callsTo("getToolAccessConfig").length, 2);
      assert.deepEqual(toolCheckboxes(page).map((b) => b.checked), [true, false, false, true, true]);
      assert.equal(limitInput(page).value, "10");
      assert.equal(page.$("saveToolsStatus").textContent, "Saved.");
      assert.equal(page.$("saveToolsBtn").disabled, false);
    });

    it("saves a new limit while getMessages stays enabled, and says Saved. after the reload", async () => {
      const page = await openPage(statefulTools([], 10));
      limitInput(page).value = "15";
      await page.fire(limitInput(page), "input");
      await page.click("saveToolsBtn");
      assert.deepEqual(page.callsTo("setToolAccess"), [[[], 15]]);
      assert.equal(limitInput(page).value, "15");
      assert.equal(page.$("saveToolsStatus").textContent, "Saved.");
    });

    it("does not block the save on an invalid limit once getMessages is unchecked", async () => {
      const page = await openPage(statefulTools([], 10));
      limitInput(page).value = "99";
      await page.fire(limitInput(page), "input");
      const getMessagesBox = toolCheckboxes(page).find((b) => b.value === "getMessages");
      await page.setChecked(getMessagesBox, false);
      await page.click("saveToolsBtn");
      assert.deepEqual(page.callsTo("setToolAccess"), [[["getMessages"], undefined]]);
      assert.equal(page.$("saveToolsStatus").textContent, "Saved.");
    });

    it("never lists a required tool as disabled", async () => {
      const page = await openPage();
      toolCheckboxes(page)[0].checked = false;
      await page.click("saveToolsBtn");
      assert.deepEqual(page.callsTo("setToolAccess")[0][0], ["sendMail"]);
    });

    it("sends the limit as a number", async () => {
      const page = await openPage();
      await page.click("saveToolsBtn");
      assert.equal(page.callsTo("setToolAccess")[0][1], 10);
    });

    it("sends no limit when getMessages is not offered", async () => {
      const page = await openPage({
        getToolAccessConfig: { tools: [{ name: "searchMessages", group: "messages", crud: "read", enabled: true }] },
      });
      await page.click("saveToolsBtn");
      assert.deepEqual(page.callsTo("setToolAccess"), [[[], undefined]]);
    });

    it("blocks the save while the limit is invalid", async () => {
      const page = await openPage();
      limitInput(page).value = "99";
      await page.click("saveToolsBtn");
      assert.equal(page.callsTo("setToolAccess").length, 0);
      assert.equal(page.$("saveToolsStatus").textContent, "Fix the highlighted getMessages limit before saving.");
      assert.equal(page.$("saveToolsStatus").className, "save-status error");
      assert.equal(limitInput(page).getAttribute("aria-invalid"), "true");
      assert.equal(page.$("saveToolsBtn").disabled, false);
    });

    it("clears an old message when a tool is toggled", async () => {
      const page = await openPage();
      page.$("saveToolsStatus").textContent = "Fix the highlighted getMessages limit before saving.";
      await page.setChecked(toolCheckboxes(page)[1], false);
      assert.equal(page.$("saveToolsStatus").textContent, "");
    });

    it("shows the error returned by the host and does not reload", async () => {
      const page = await openPage({ setToolAccess: { error: "getMessagesLimit must be between 1 and 20" } });
      await page.click("saveToolsBtn");
      assert.equal(page.$("saveToolsStatus").textContent, "getMessagesLimit must be between 1 and 20");
      assert.equal(page.$("saveToolsStatus").className, "save-status error");
      assert.equal(page.callsTo("getToolAccessConfig").length, 1);
      assert.equal(page.$("saveToolsBtn").disabled, false);
    });

    it("shows the error when the save throws", async () => {
      const page = await openPage({ setToolAccess: () => { throw new Error("prefs locked"); } });
      await page.click("saveToolsBtn");
      assert.equal(page.$("saveToolsStatus").textContent, "Error: prefs locked");
      assert.equal(page.$("saveToolsStatus").className, "save-status error");
      assert.equal(page.$("saveToolsBtn").disabled, false);
    });
  });
});

describe("options page: send safety (skipReview)", () => {
  it("loads the setting and enables Save", async () => {
    const page = await openPage({ getBlockSkipReview: { blockSkipReview: true } });
    assert.equal(page.$("blockSkipReview").checked, true);
    assert.equal(page.$("saveSkipReviewBtn").disabled, false);
    assert.equal(page.$("saveSkipReviewStatus").textContent, "");
  });

  it("shows an unchecked box when blocking is off", async () => {
    const page = await openPage({ getBlockSkipReview: { blockSkipReview: false } });
    assert.equal(page.$("blockSkipReview").checked, false);
    assert.equal(page.$("blockCalendarSkipReview").checked, true, "each box shows its own block");
  });

  it("shows the block for events and tasks apart from the one for mail", async () => {
    const page = await openPage({
      getBlockSkipReview: { blockSkipReview: true },
      getBlockCalendarSkipReview: { blockCalendarSkipReview: false },
    });
    assert.equal(page.$("blockSkipReview").checked, true);
    assert.equal(page.$("blockCalendarSkipReview").checked, false);
  });

  it("keeps Save disabled when the block for events and tasks cannot be read", async () => {
    const page = await openPage({ getBlockCalendarSkipReview: () => { throw new Error("pref unreadable"); } });
    assert.equal(page.$("saveSkipReviewBtn").disabled, true);
    assert.equal(page.$("saveSkipReviewStatus").textContent, "Error loading setting: pref unreadable");
  });

  it("keeps Save disabled and shows the error when the setting cannot be read", async () => {
    const page = await openPage({ getBlockSkipReview: () => { throw new Error("pref unreadable"); } });
    assert.equal(page.$("saveSkipReviewBtn").disabled, true);
    assert.equal(page.$("saveSkipReviewStatus").textContent, "Error loading setting: pref unreadable");
    assert.equal(page.$("saveSkipReviewStatus").className, "save-status error");
  });

  it("saves the state of the box", async () => {
    const page = await openPage({ getBlockSkipReview: { blockSkipReview: true } });
    page.$("blockSkipReview").checked = false;
    await page.click("saveSkipReviewBtn");
    assert.deepEqual(page.callsTo("setBlockSkipReview"), [[false]]);
    assert.deepEqual(page.callsTo("setBlockCalendarSkipReview"), [[true]], "the untouched box is saved as shown");
    assert.equal(page.$("saveSkipReviewStatus").textContent, "Saved.");
    assert.equal(page.$("saveSkipReviewStatus").className, "save-status");
    assert.equal(page.$("saveSkipReviewBtn").disabled, false);
  });

  it("says a changed box is not saved yet, until Save is pressed", async () => {
    const page = await openPage();
    await page.setChecked(page.$("blockCalendarSkipReview"), false);
    assert.equal(page.$("saveSkipReviewStatus").textContent, "Not saved yet: press Save.");
    assert.equal(page.$("saveSkipReviewStatus").className, "save-status pending");
    assert.deepEqual(page.callsTo("setBlockCalendarSkipReview"), [], "nothing is written before Save");
    await page.click("saveSkipReviewBtn");
    assert.equal(page.$("saveSkipReviewStatus").textContent, "Saved.");
    assert.equal(page.$("saveSkipReviewStatus").className, "save-status");
  });

  it("marks only the Save button that covers the changed setting", async () => {
    const page = await openPage();
    await page.setChecked(page.$("listenAll"), true);
    assert.equal(page.$("saveListenAllStatus").className, "save-status pending");
    assert.equal(page.$("saveSkipReviewStatus").textContent, "");
    assert.equal(page.$("saveEncryptedContentStatus").textContent, "");
  });

  it("saves the block for events and tasks before the one for mail", async () => {
    // Not yet set, it follows the block for mail: written second, it could be lifted by the mail block alone.
    const order = [];
    const page = await openPage({
      setBlockCalendarSkipReview: (v) => { order.push(["calendar", v]); return { success: true }; },
      setBlockSkipReview: (v) => { order.push(["mail", v]); return { success: true }; },
    });
    page.$("blockCalendarSkipReview").checked = false;
    await page.click("saveSkipReviewBtn");
    assert.deepEqual(order, [["calendar", false], ["mail", true]]);
    assert.equal(page.$("saveSkipReviewStatus").textContent, "Saved.");
  });

  it("does not save the block for mail when the one for events and tasks fails", async () => {
    const page = await openPage({ setBlockCalendarSkipReview: { error: "not allowed" } });
    page.$("blockSkipReview").checked = false;
    await page.click("saveSkipReviewBtn");
    assert.deepEqual(page.callsTo("setBlockSkipReview"), []);
    assert.equal(page.$("saveSkipReviewStatus").textContent, "not allowed");
    assert.equal(page.$("saveSkipReviewStatus").className, "save-status error");
    assert.equal(page.$("saveSkipReviewBtn").disabled, false);
  });

  it("shows 'Saving...' and disables the button during the save", async () => {
    const ref = {};
    const seen = [];
    ref.page = await openPage({
      setBlockSkipReview: () => {
        seen.push([ref.page.$("saveSkipReviewBtn").disabled, ref.page.$("saveSkipReviewStatus").textContent]);
        return { success: true };
      },
    });
    await ref.page.click("saveSkipReviewBtn");
    assert.deepEqual(seen, [[true, "Saving..."]]);
  });

  it("shows the error returned by the host", async () => {
    const page = await openPage({ setBlockSkipReview: { error: "not allowed" } });
    await page.click("saveSkipReviewBtn");
    assert.equal(page.$("saveSkipReviewStatus").textContent, "not allowed");
    assert.equal(page.$("saveSkipReviewStatus").className, "save-status error");
    assert.equal(page.$("saveSkipReviewBtn").disabled, false);
  });

  it("shows the error when the save throws", async () => {
    const page = await openPage({ setBlockSkipReview: () => { throw new Error("prefs locked"); } });
    await page.click("saveSkipReviewBtn");
    assert.equal(page.$("saveSkipReviewStatus").textContent, "Error: prefs locked");
    assert.equal(page.$("saveSkipReviewStatus").className, "save-status error");
    assert.equal(page.$("saveSkipReviewBtn").disabled, false);
  });
});

describe("options page: filter rules that send mail", () => {
  const block = (page) => page.$("filterSendRulePolicyBlock");
  const confirm = (page) => page.$("filterSendRulePolicyConfirm");

  function choose(radio, others) {
    for (const other of others) other.checked = false;
    radio.checked = true;
  }

  it("has both options from the markup", async () => {
    const page = await openPage();
    assert.equal(block(page).type, "radio");
    assert.equal(block(page).value, "block");
    assert.equal(confirm(page).value, "confirm");
  });

  for (const [label, answer, expectBlock] of [
    ["blocking", { blockFilterForwardReply: true }, true],
    ["asking each time", { blockFilterForwardReply: false }, false],
    ["blocking when the setting is missing", {}, true],
  ]) {
    it(`selects the right option for ${label}`, async () => {
      const page = await openPage({ getBlockFilterForwardReply: answer });
      assert.equal(block(page).checked, expectBlock);
      assert.equal(confirm(page).checked, !expectBlock);
      assert.equal(page.$("saveFilterSendRulePolicyBtn").disabled, false);
      assert.equal(page.$("saveFilterSendRulePolicyStatus").textContent, "");
    });
  }

  it("keeps Save disabled and shows the error when the setting cannot be read", async () => {
    const page = await openPage({ getBlockFilterForwardReply: () => { throw new Error("pref unreadable"); } });
    assert.equal(page.$("saveFilterSendRulePolicyBtn").disabled, true);
    assert.equal(page.$("saveFilterSendRulePolicyStatus").textContent, "Error loading setting: pref unreadable");
    assert.equal(page.$("saveFilterSendRulePolicyStatus").className, "save-status error");
  });

  it("saves 'ask each time' as blockFilterForwardReply false", async () => {
    const page = await openPage();
    choose(confirm(page), [block(page)]);
    await page.click("saveFilterSendRulePolicyBtn");
    assert.deepEqual(page.callsTo("setBlockFilterForwardReply"), [[false]]);
    assert.equal(page.$("saveFilterSendRulePolicyStatus").textContent, "Saved.");
    assert.equal(page.$("saveFilterSendRulePolicyStatus").className, "save-status");
    assert.equal(page.$("saveFilterSendRulePolicyBtn").disabled, false);
  });

  it("saves 'always block' as blockFilterForwardReply true", async () => {
    const page = await openPage({ getBlockFilterForwardReply: { blockFilterForwardReply: false } });
    choose(block(page), [confirm(page)]);
    await page.click("saveFilterSendRulePolicyBtn");
    assert.deepEqual(page.callsTo("setBlockFilterForwardReply"), [[true]]);
  });

  it("asks to choose an option when none is selected", async () => {
    const page = await openPage();
    block(page).checked = false;
    confirm(page).checked = false;
    await page.click("saveFilterSendRulePolicyBtn");
    assert.equal(page.callsTo("setBlockFilterForwardReply").length, 0);
    assert.equal(page.$("saveFilterSendRulePolicyStatus").textContent, "Choose one of the two options.");
    assert.equal(page.$("saveFilterSendRulePolicyStatus").className, "save-status error");
  });

  it("shows the error returned by the host", async () => {
    const page = await openPage({ setBlockFilterForwardReply: { error: "not allowed" } });
    await page.click("saveFilterSendRulePolicyBtn");
    assert.equal(page.$("saveFilterSendRulePolicyStatus").textContent, "not allowed");
    assert.equal(page.$("saveFilterSendRulePolicyStatus").className, "save-status error");
    assert.equal(page.$("saveFilterSendRulePolicyBtn").disabled, false);
  });

  it("shows the error when the save throws", async () => {
    const page = await openPage({ setBlockFilterForwardReply: () => { throw new Error("prefs locked"); } });
    await page.click("saveFilterSendRulePolicyBtn");
    assert.equal(page.$("saveFilterSendRulePolicyStatus").textContent, "Error: prefs locked");
    assert.equal(page.$("saveFilterSendRulePolicyStatus").className, "save-status error");
    assert.equal(page.$("saveFilterSendRulePolicyBtn").disabled, false);
  });
});

describe("options page: encrypted messages", () => {
  it("is off unless the host says exactly true", async () => {
    for (const [answer, expected] of [
      [{ allowEncryptedContent: true }, true],
      [{ allowEncryptedContent: false }, false],
      [{}, false],
      [{ allowEncryptedContent: "yes" }, false],
    ]) {
      const page = await openPage({ getAllowEncryptedContent: answer });
      assert.equal(page.$("allowEncryptedContent").checked, expected, JSON.stringify(answer));
      assert.equal(page.$("saveEncryptedContentBtn").disabled, false);
    }
  });

  it("keeps Save disabled and shows the error when the setting cannot be read", async () => {
    const page = await openPage({ getAllowEncryptedContent: () => { throw new Error("pref unreadable"); } });
    assert.equal(page.$("saveEncryptedContentBtn").disabled, true);
    assert.equal(page.$("saveEncryptedContentStatus").textContent, "Error loading setting: pref unreadable");
    assert.equal(page.$("saveEncryptedContentStatus").className, "save-status error");
  });

  it("saves the state of the box", async () => {
    const page = await openPage();
    page.$("allowEncryptedContent").checked = true;
    await page.click("saveEncryptedContentBtn");
    assert.deepEqual(page.callsTo("setAllowEncryptedContent"), [[true]]);
    assert.equal(page.$("saveEncryptedContentStatus").textContent, "Saved.");
    assert.equal(page.$("saveEncryptedContentStatus").className, "save-status");
    assert.equal(page.$("saveEncryptedContentBtn").disabled, false);
  });

  it("shows the error returned by the host", async () => {
    const page = await openPage({ setAllowEncryptedContent: { error: "not allowed" } });
    await page.click("saveEncryptedContentBtn");
    assert.equal(page.$("saveEncryptedContentStatus").textContent, "not allowed");
    assert.equal(page.$("saveEncryptedContentStatus").className, "save-status error");
    assert.equal(page.$("saveEncryptedContentBtn").disabled, false);
  });

  it("shows the error when the save throws", async () => {
    const page = await openPage({ setAllowEncryptedContent: () => { throw new Error("prefs locked"); } });
    await page.click("saveEncryptedContentBtn");
    assert.equal(page.$("saveEncryptedContentStatus").textContent, "Error: prefs locked");
    assert.equal(page.$("saveEncryptedContentStatus").className, "save-status error");
    assert.equal(page.$("saveEncryptedContentBtn").disabled, false);
  });
});

describe("options page: listen on all interfaces", () => {
  it("starts with the warning hidden and Save enabled once loaded", async () => {
    const page = await openPage();
    assert.equal(page.$("listenAll").checked, false);
    assert.equal(page.$("listenAllWarning").style.display, "none");
    assert.equal(page.$("saveListenAllBtn").disabled, false);
    assert.equal(page.$("saveListenAllStatus").textContent, "");
  });

  it("shows the warning when the setting is already on", async () => {
    const page = await openPage({ getListenAll: { listenAll: true } });
    assert.equal(page.$("listenAll").checked, true);
    assert.equal(page.$("listenAllWarning").style.display, "block");
  });

  it("shows and hides the warning as the box is toggled", async () => {
    const page = await openPage();
    await page.setChecked(page.$("listenAll"), true);
    assert.equal(page.$("listenAllWarning").style.display, "block");
    await page.setChecked(page.$("listenAll"), false);
    assert.equal(page.$("listenAllWarning").style.display, "none");
  });

  it("keeps Save disabled and shows the error when the setting cannot be read", async () => {
    const page = await openPage({ getListenAll: () => { throw new Error("pref unreadable"); } });
    assert.equal(page.$("saveListenAllBtn").disabled, true);
    assert.equal(page.$("saveListenAllStatus").textContent, "Error loading setting: pref unreadable");
    assert.equal(page.$("saveListenAllStatus").className, "save-status error");
  });

  it("saves the state of the box, then refreshes the server status", async () => {
    const page = await openPage();
    page.$("listenAll").checked = true;
    await page.click("saveListenAllBtn");
    assert.deepEqual(page.callsTo("setListenAll"), [[true]]);
    assert.equal(page.$("saveListenAllStatus").textContent, "Saved.");
    assert.equal(page.$("saveListenAllStatus").className, "save-status");
    assert.equal(page.$("saveListenAllBtn").disabled, false);
    assert.equal(page.callsTo("getServerInfo").length, 2);
  });

  it("shows the error returned by the host and does not refresh", async () => {
    const page = await openPage({ setListenAll: { error: "cannot bind 0.0.0.0" } });
    await page.click("saveListenAllBtn");
    assert.equal(page.$("saveListenAllStatus").textContent, "cannot bind 0.0.0.0");
    assert.equal(page.$("saveListenAllStatus").className, "save-status error");
    assert.equal(page.callsTo("getServerInfo").length, 1);
    assert.equal(page.$("saveListenAllBtn").disabled, false);
  });

  it("shows the error when the save throws", async () => {
    const page = await openPage({ setListenAll: () => { throw new Error("prefs locked"); } });
    await page.click("saveListenAllBtn");
    assert.equal(page.$("saveListenAllStatus").textContent, "Error: prefs locked");
    assert.equal(page.$("saveListenAllStatus").className, "save-status error");
    assert.equal(page.$("saveListenAllBtn").disabled, false);
  });
});

describe("options page: bridge status", () => {
  const RELEASE_LATEST = "https://github.com/commonpost/thunderbird-mcp/releases/latest";
  const RELEASE_TAG = "https://github.com/commonpost/thunderbird-mcp/releases/tag/v0.18.0";
  const SEEN = "2026-11-03T12:00:00.000Z";
  const BRIDGE = {
    version: "0.17.5",
    packaging: "file",
    profile: "default-release",
    lastSeen: SEEN,
    state: "up-to-date",
    releaseUrl: RELEASE_LATEST,
  };
  const status = (bridges, extra = {}) => ({ ...DEFAULT_RESULTS.getBridgeStatus, bridges, ...extra });
  const lines = (li) => li.children.map((line) => line.textContent);
  const seenText = (iso) => "Last seen: " + new Date(iso).toLocaleString();
  const links = (li) => descendants(li).filter((el) => el.tagName === "A");
  const steps = (li) => li.children.find((el) => el.tagName === "OL").children.map((step) => step.textContent);
  const DL = "https://github.com/commonpost/thunderbird-mcp/releases/";

  it("says that no bridge connected, and recommends the minimum version", async () => {
    const page = await openPage();
    assert.equal(page.$("bridgeEmpty").hidden, false);
    assert.equal(page.$("bridgeList").children.length, 0);
    assert.equal(
      page.$("bridgeThresholds").textContent,
      "This add-on (version 0.18.0) recommends bridge 0.17.0 or newer. The bridge published with it is 0.18.0.",
    );
    assert.equal(page.$("bridgeRefreshStatus").textContent, "");
  });

  it("leaves out the add-on version, and names the security floor, when they are known", async () => {
    const page = await openPage({
      getBridgeStatus: status([], { extensionVersion: undefined, securityFloor: "0.15.0", currentBridgeVersion: undefined }),
    });
    assert.equal(
      page.$("bridgeThresholds").textContent,
      "This add-on recommends bridge 0.17.0 or newer. It refuses bridges older than 0.15.0.",
    );
  });

  it("does not repeat a published bridge version that is not a plain x.y.z", async () => {
    const page = await openPage({ getBridgeStatus: status([], { currentBridgeVersion: "<b>9</b>" }) });
    assert.doesNotMatch(page.$("bridgeThresholds").textContent, /published/);
  });

  it("lists a bridge that is up to date, without advice or release link", async () => {
    const page = await openPage({ getBridgeStatus: status([BRIDGE]) });
    assert.equal(page.$("bridgeEmpty").hidden, true);
    assert.equal(page.$("bridgeList").children.length, 1);
    const li = page.$("bridgeList").children[0];
    assert.deepEqual(lines(li), [
      "Version: 0.17.5",
      "Installed as: mcp-bridge.cjs file",
      "Profile: default-release",
      seenText(SEEN),
      "Status: Up to date.",
    ]);
    assert.equal(links(li).length, 0);
  });

  it("lists several bridges in the order given", async () => {
    const page = await openPage({
      getBridgeStatus: status([BRIDGE, { ...BRIDGE, version: "0.18.0", packaging: "mcpb", profile: "work" }]),
    });
    const rows = page.$("bridgeList").children.map((li) => [li.children[0].textContent, li.children[1].textContent]);
    assert.deepEqual(rows, [
      ["Version: 0.17.5", "Installed as: mcp-bridge.cjs file"],
      ["Version: 0.18.0", "Installed as: .mcpb bundle (Claude Desktop)"],
    ]);
  });

  it("offers an optional update with the published version", async () => {
    const page = await openPage({ getBridgeStatus: status([{ ...BRIDGE, state: "newer-available" }]) });
    const li = page.$("bridgeList").children[0];
    assert.equal(lines(li)[4], "Status: Newer version available (0.18.0): this bridge works, the update is optional.");
    assert.equal(lines(li)[5], "To update this bridge:");
    const [download, replace, restart] = steps(li);
    assert.equal(download, "Download mcp-bridge.cjs.");
    assert.match(replace, /^Put the downloaded file in place of the mcp-bridge\.cjs that your MCP client starts: same name, same folder\./);
    assert.match(replace, /Claude Code: claude mcp list names the server, claude mcp get <name> shows the path\./);
    assert.match(replace, /Other clients: the path is in the arguments of the server/);
    assert.equal(restart, "Restart the MCP client, or reconnect the server (in Claude Code: /mcp).");
    assert.equal(lines(li)[7],
      "Claude Code with the Commonpost plugin: nothing to download. Run /plugin marketplace update commonpost, then /reload-plugins.");
    const codes = descendants(li).filter((el) => el.tagName === "CODE").map((el) => el.textContent);
    assert.deepEqual(codes, ["mcp-bridge.cjs", "claude mcp list", "claude mcp get <name>", "/mcp",
      "/plugin marketplace update commonpost", "/reload-plugins"]);
    assert.equal(lines(li)[8], "Release notes: " + RELEASE_LATEST);
    assert.deepEqual(links(li).map((a) => [a.textContent, a.href]), [
      ["mcp-bridge.cjs", DL + "latest/download/mcp-bridge.cjs"],
      [RELEASE_LATEST, RELEASE_LATEST],
    ]);
  });

  it("links the file of the add-on's own release, not the latest one, when the release is named", async () => {
    const page = await openPage({ getBridgeStatus: status([{ ...BRIDGE, state: "update-recommended", releaseUrl: RELEASE_TAG }]) });
    assert.equal(links(page.$("bridgeList").children[0])[0].href, DL + "download/v0.18.0/mcp-bridge.cjs");
  });

  it("falls back to the plain label when the published version is not usable", async () => {
    const page = await openPage({
      getBridgeStatus: status([{ ...BRIDGE, state: "newer-available" }], { currentBridgeVersion: "not-a-version" }),
    });
    assert.equal(
      lines(page.$("bridgeList").children[0])[4],
      "Status: Newer version available: this bridge works, the update is optional.",
    );
  });

  it("recommends reinstalling a .mcpb bundle in Claude Desktop", async () => {
    const page = await openPage({
      getBridgeStatus: status([{ ...BRIDGE, packaging: "mcpb", state: "update-recommended", releaseUrl: RELEASE_TAG }]),
    });
    const li = page.$("bridgeList").children[0];
    assert.equal(lines(li)[1], "Installed as: .mcpb bundle (Claude Desktop)");
    assert.equal(lines(li)[4], "Status: Update recommended.");
    const [download, open] = steps(li);
    assert.equal(download, "Download commonpost-mcp-v0.18.0.mcpb.");
    assert.match(open, /^Open the downloaded file with Claude Desktop: it replaces the installed bundle/);
    assert.equal(steps(li).length, 2);
    assert.ok(!lines(li).some((line) => line.includes("plugin")));
    assert.deepEqual(links(li).map((a) => a.href), [DL + "download/v0.18.0/commonpost-mcp-v0.18.0.mcpb", RELEASE_TAG]);
  });

  it("names no .mcpb file when the published bridge version is not usable, and still links the release", async () => {
    const page = await openPage({
      getBridgeStatus: status([{ ...BRIDGE, packaging: "mcpb", state: "update-recommended", releaseUrl: RELEASE_TAG }],
        { currentBridgeVersion: "x" }),
    });
    const li = page.$("bridgeList").children[0];
    assert.match(steps(li)[0], /^Download the \.mcpb bundle from the release of this add-on/);
    assert.deepEqual(links(li).map((a) => a.href), [RELEASE_TAG]);
  });

  it("reports a bridge without a readable version", async () => {
    const page = await openPage({
      getBridgeStatus: status([{ ...BRIDGE, version: null, packaging: "none", profile: undefined, state: "unversioned" }]),
    });
    const li = page.$("bridgeList").children[0];
    assert.deepEqual(lines(li).slice(0, 5), [
      "Version: not reported (bridge 0.11 or older, or another HTTP client)",
      "Installed as: unknown",
      seenText(SEEN),
      "Status: Update recommended: this bridge does not report a readable version.",
      "To update this bridge:",
    ]);
    assert.equal(steps(li)[0], "Download mcp-bridge.cjs.");
  });

  it("calls a version that could not be parsed unreadable", async () => {
    const page = await openPage({ getBridgeStatus: status([{ ...BRIDGE, version: null }]) });
    assert.equal(page.$("bridgeList").children[0].children[0].textContent, "Version: unreadable");
  });

  it("refuses a bridge older than the security floor and links the release", async () => {
    const page = await openPage({
      getBridgeStatus: status([{ ...BRIDGE, version: "0.10.0", state: "refused" }], { securityFloor: "0.12.0" }),
    });
    const li = page.$("bridgeList").children[0];
    assert.equal(
      lines(li)[4],
      "Status: Refused: older than the security floor of this add-on (no tool works with it).",
    );
    assert.equal(links(li).length, 2);
    assert.match(page.$("bridgeThresholds").textContent, /It refuses bridges older than 0\.12\.0\./);
  });

  it("tells to update the add-on when the bridge is newer, with the release link but no bridge advice", async () => {
    const page = await openPage({
      getBridgeStatus: status([{ ...BRIDGE, version: "0.19.0", state: "newer-than-add-on" }]),
    });
    const li = page.$("bridgeList").children[0];
    assert.match(lines(li)[4], /^Status: Newer than this add-on: in Add-ons and Themes/);
    assert.equal(lines(li).length, 6);
    assert.equal(lines(li)[5], "Release page: " + RELEASE_LATEST);
  });

  it("marks a development build as not checked, without a link", async () => {
    const page = await openPage({ getBridgeStatus: status([{ ...BRIDGE, version: "0.0.0", state: "development" }]) });
    const li = page.$("bridgeList").children[0];
    assert.equal(lines(li)[0], "Version: development build (0.0.0)");
    assert.equal(lines(li)[4], "Status: Development build: not checked.");
    assert.equal(links(li).length, 0);
  });

  it("shows an unknown state as is", async () => {
    const page = await openPage({ getBridgeStatus: status([{ ...BRIDGE, state: "mystery" }]) });
    assert.equal(lines(page.$("bridgeList").children[0])[4], "Status: mystery");
  });

  it("marks an invalid profile name as ignored, and omits an absent one", async () => {
    const page = await openPage({
      getBridgeStatus: status([
        { ...BRIDGE, profile: undefined, profileInvalid: true },
        { ...BRIDGE, profile: undefined },
      ]),
    });
    const [invalid, absent] = page.$("bridgeList").children.map(lines);
    assert.equal(invalid[2], "Profile: invalid (ignored)");
    assert.equal(absent.length, 4);
    assert.ok(!absent.some((line) => line.startsWith("Profile:")));
  });

  for (const url of [
    "https://example.com/commonpost/thunderbird-mcp/releases/latest",
    "http://github.com/commonpost/thunderbird-mcp/releases/latest",
    "https://github.com/commonpost/thunderbird-mcp/releases/tag/v1.2",
    "https://github.com/commonpost/thunderbird-mcp/releases/latest?x=1",
    "https://github.com/someone-else/thunderbird-mcp/releases/latest",
    "javascript:alert(1)",
    undefined,
  ]) {
    it(`does not link the release URL ${String(url)}`, async () => {
      const page = await openPage({
        getBridgeStatus: status([{ ...BRIDGE, state: "update-recommended", releaseUrl: url }]),
      });
      const li = page.$("bridgeList").children[0];
      assert.equal(links(li).length, 0);
      assert.ok(!lines(li).some((line) => line.startsWith("Release")));
      assert.match(steps(li)[0], /^Download mcp-bridge\.cjs from the release of this add-on, on the Releases page/);
    });
  }

  it("opens the file and the release page in the default browser instead of following the links", async () => {
    const page = await openPage({
      getBridgeStatus: status([{ ...BRIDGE, state: "update-recommended", releaseUrl: RELEASE_TAG }]),
    });
    const [file, release] = links(page.$("bridgeList").children[0]);
    assert.equal(release.href, RELEASE_TAG);
    assert.equal(release.textContent, RELEASE_TAG);
    for (const link of [file, release]) {
      const event = await page.fire(link, "click");
      assert.equal(event.defaultPrevented, true);
    }
    assert.deepEqual(page.opened, [DL + "download/v0.18.0/mcp-bridge.cjs", RELEASE_TAG]);
    assert.deepEqual(page.consoleErrors, []);
  });

  it("logs, and does not throw, when the browser cannot be opened", async () => {
    const page = await openPage(
      { getBridgeStatus: status([{ ...BRIDGE, state: "update-recommended" }]) },
      { openDefaultBrowser: async () => { throw new Error("no default browser"); } },
    );
    const [link] = links(page.$("bridgeList").children[0]);
    await page.fire(link, "click");
    assert.equal(page.consoleErrors.length, 1);
    assert.equal(page.consoleErrors[0][0], "commonpost-mcp options:");
    assert.equal(page.consoleErrors[0][1], "openDefaultBrowser failed:");
    assert.equal(page.consoleErrors[0][2].message, "no default browser");
  });

  it("Refresh loads the status again", async () => {
    let reads = 0;
    const page = await openPage({
      getBridgeStatus: () => {
        reads += 1;
        return status(reads === 1 ? [] : [BRIDGE, { ...BRIDGE, version: "0.18.0" }]);
      },
    });
    assert.equal(page.$("bridgeList").children.length, 0);
    assert.equal(page.$("bridgeEmpty").hidden, false);
    await page.click("bridgeRefreshBtn");
    assert.equal(page.callsTo("getBridgeStatus").length, 2);
    assert.equal(page.$("bridgeList").children.length, 2);
    assert.equal(page.$("bridgeEmpty").hidden, true);
  });

  it("shows the error when the status cannot be read, and recovers on the next refresh", async () => {
    let reads = 0;
    const page = await openPage({
      getBridgeStatus: () => {
        reads += 1;
        if (reads === 1) throw new Error("bridge registry unavailable");
        return status([BRIDGE]);
      },
    });
    assert.equal(page.$("bridgeRefreshStatus").textContent, "Error: bridge registry unavailable");
    assert.equal(page.$("bridgeRefreshStatus").className, "save-status error");
    await page.click("bridgeRefreshBtn");
    assert.equal(page.$("bridgeRefreshStatus").textContent, "");
    assert.equal(page.$("bridgeRefreshStatus").className, "save-status");
    assert.equal(page.$("bridgeList").children.length, 1);
  });
});

describe("options page: in French", () => {
  const fr = readMessages("fr");
  const openFrench = (overrides) => openPage(overrides, { messages: fr });

  it("translates the page, its buttons and the placeholder of the token field", async () => {
    const page = await openFrench();
    assert.equal(page.$("retryStartBtn").textContent, "Réessayer de démarrer");
    assert.equal(page.$("saveBtn").textContent, "Enregistrer");
    assert.equal(page.$("bridgeEmpty").textContent, "Aucune passerelle ne s'est connectée depuis le démarrage de Thunderbird.");
    assert.equal(page.$("currentAuthToken").getAttribute("placeholder"), "Non disponible");
    assert.equal(page.$("listenAllWarning").textContent, fr.listenAllWarning.message);
  });

  it("builds its statuses and summaries in French", async () => {
    const page = await openFrench();
    assert.equal(page.$("statusText").textContent, "En marche");
    assert.equal(page.$("toolSummary").textContent, "(4 sur 5 activés)");
    assert.equal(
      page.$("bridgeThresholds").textContent,
      "Ce module (version 0.18.0) recommande la passerelle 0.17.0 ou plus récente. La passerelle publiée avec lui est la 0.18.0.",
    );
    await page.click("saveBtn");
    assert.equal(page.$("saveStatus").textContent, "Enregistré.");
  });

  it("translates group names and tool titles by id, and keeps a label it does not know", async () => {
    const page = await openFrench({
      getToolAccessConfig: {
        ...TOOL_CONFIG,
        tools: TOOL_CONFIG.tools.map((tool) => (tool.name === "searchMessages" ? { ...tool, title: "Search Mail" } : tool)),
      },
    });
    const rows = toolRows(page.$("toolList"));
    assert.deepEqual(rows.slice(0, 5), ["group Accounts", "crud Lecture", "tool listAccounts", "group Courrier", "crud Lecture"]);
    assert.ok(rows.includes("tool Rechercher dans le courrier"), rows.join("; "));
    const required = descendants(page.$("toolList")).find((el) => el.className === "account-type");
    assert.equal(required.textContent, "requis");
  });

  it("keeps code and links inside the translated bridge steps", async () => {
    const page = await openFrench({
      getBridgeStatus: {
        ...DEFAULT_RESULTS.getBridgeStatus,
        bridges: [{
          version: "0.16.0", packaging: "file", profile: "", lastSeen: "2026-11-03T12:00:00.000Z",
          state: "update-recommended", releaseUrl: "https://github.com/commonpost/thunderbird-mcp/releases/latest",
        }],
      },
    });
    const li = page.$("bridgeList").children[0];
    const steps = li.children.find((el) => el.tagName === "OL").children;
    assert.equal(steps[0].textContent, "Téléchargez mcp-bridge.cjs.");
    assert.equal(steps[0].children.find((el) => el.tagName === "A").textContent, "mcp-bridge.cjs");
    assert.equal(steps[1].children[0].textContent, "Mettez le fichier téléchargé à la place du ");
    assert.equal(steps[1].children[1].tagName, "CODE");
    assert.equal(steps[1].children[1].textContent, "mcp-bridge.cjs");
    const where = steps[1].children.find((el) => el.tagName === "UL").children.map((item) => item.textContent);
    assert.deepEqual(where, [
      "Claude Code\u00a0: claude mcp list donne le nom du serveur, claude mcp get <name> affiche le chemin.",
      "Autres clients\u00a0: le chemin figure dans les arguments du serveur, dans la configuration MCP du client.",
    ]);
    assert.equal(li.children[1].textContent, "Installée sous forme de\u00a0: fichier mcp-bridge.cjs");
    assert.equal(li.children[3].textContent, "État\u00a0: Mise à jour recommandée.");
  });
});
