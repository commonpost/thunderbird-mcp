// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";
// The compose window of a reply or a forward: waiting for the right window, anchoring the caret, putting the caller's
// body and recipients in. Runs the real functions of api.js against stand-ins for the windows, editors and services;
// the real thing is exercised in the Thunderbird lab.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const API = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");

// A function of the Experiment class, from its declaration to the closing brace at the same indentation
function fn(name) {
  const indent = "            ";
  const start = API.indexOf(`\n${indent}function ${name}(`);
  assert.ok(start >= 0, `${name} not found in api.js`);
  const close = `\n${indent}}\n`;
  const end = API.indexOf(close, start);
  assert.ok(end > start, `end of ${name} not found in api.js`);
  return API.slice(start, end + close.length);
}

const code = `
const _claimedComposeWindows = new WeakSet();
function escapeHtml(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }
${["splitAddressHeader", "extractAddressEmail", "mergeAddressHeaders", "getIdentityAutoRecipientHeader", "applyComposeRecipientOverrides",
  "formatBodyHtml", "formatBodyFragmentHtml", "moveComposeSelectionToBodyStartIfRange", "insertReplyBodyIntoComposeWindow",
  "shouldUseDirectComposeOpen", "addAttachmentsToComposeWindow", "openComposeWindowWithCustomizations"].map(fn).join("\n")}
this.api = { mergeAddressHeaders, getIdentityAutoRecipientHeader, applyComposeRecipientOverrides, formatBodyFragmentHtml,
  moveComposeSelectionToBodyStartIfRange, insertReplyBodyIntoComposeWindow, openComposeWindowWithCustomizations };`;

const CompType = { New: 0, Reply: 1, ReplyAll: 2, ForwardInline: 4 };
const plain = v => JSON.parse(JSON.stringify(v));
const tick = () => new Promise(resolve => { setImmediate(resolve); });

function load(extra = {}) {
  const warnings = [];
  const observers = [];
  const unregistered = [];
  const timers = [];
  const composeCalls = [];
  const composeService = {
    OpenComposeWindowWithParams: (...args) => { composeCalls.push(["params", ...args]); },
    OpenComposeWindow: (...args) => { composeCalls.push(["direct", ...args]); },
  };
  const sandbox = {
    console: { warn: (...args) => warnings.push(args) },
    Services: {
      ww: {
        registerNotification: observer => { observers.push(observer); },
        unregisterNotification: observer => { unregistered.push(observer); const i = observers.indexOf(observer); if (i >= 0) observers.splice(i, 1); },
      },
    },
    Cc: {
      "@mozilla.org/timer;1": {
        createInstance: () => {
          const timer = { cancelled: false, initWithCallback(callback, ms, type) { timer.callback = callback; timer.ms = ms; timer.type = type; }, cancel() { timer.cancelled = true; } };
          timers.push(timer);
          return timer;
        },
      },
      "@mozilla.org/messengercompose;1": { getService: () => composeService },
    },
    Ci: { nsITimer: { TYPE_ONE_SHOT: 0 }, nsIMsgCompType: CompType, nsIMsgComposeService: {} },
    ChromeUtils: { generateQI: () => () => {} },
    MailServices: { compose: composeService },
    descsToMsgAttachments: descs => descs.map(d => ({ ...d, converted: true })),
    ...extra,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { api: sandbox.api, warnings, observers, unregistered, timers, composeCalls, sandbox };
}

// A compose window as the observer and the body-ready listener see it
function composeWindow({ uri = "mailbox-message://inbox#1", type = CompType.Reply, windowtype = "msgcompose", withCompose = true, ...extra } = {}) {
  const win = {
    eventListeners: [],
    addEventListener(name, listener, options) { win.eventListeners.push({ name, listener, options }); },
    document: { documentElement: { getAttribute: name => (name === "windowtype" ? windowtype : null) } },
    gComposeType: type,
    ...extra,
  };
  if (withCompose) {
    win.gMsgCompose = {
      originalMsgURI: uri,
      compFields: {},
      stateListeners: [],
      RegisterStateListener(listener) { this.stateListeners.push(listener); },
      UnregisterStateListener(listener) { this.stateListeners = this.stateListeners.filter(l => l !== listener); },
    };
  }
  return win;
}

// The window the compose service would show: an editor that records what is done to it
function editableWindow(log, extra = {}) {
  const selection = { isCollapsed: false, removeAllRanges() { log.push("removeAllRanges"); }, addRange(range) { log.push(["addRange", range.collapsedToStart, range.startOffset]); } };
  const body = {};
  const doc = {
    body,
    getSelection: () => selection,
    createRange: () => ({ setStart(node, offset) { this.startOffset = offset; this.startNode = node; }, collapse(toStart) { this.collapsedToStart = toStart; } }),
    execCommand(name, ui, value) { log.push(["execCommand", name, ui, value]); return true; },
  };
  return composeWindow({
    getBrowser: () => ({ contentDocument: doc }),
    AddAttachments: list => log.push(["AddAttachments", list]),
    SetComposeDetails: details => log.push(["SetComposeDetails", details]),
    ...extra,
  });
}

describe("mergeAddressHeaders", () => {
  it("lists an address once, whatever its form, and keeps a quoted name with a comma in one piece", () => {
    const { api } = load();
    assert.equal(api.mergeAddressHeaders("a@x.test, Dup <dup@x.test>", "DUP@x.test, \"Doe, Jane\" <jane@x.test>"), "a@x.test, Dup <dup@x.test>, \"Doe, Jane\" <jane@x.test>");
  });

  it("passes over empty entries and missing headers", () => {
    const { api } = load();
    assert.equal(api.mergeAddressHeaders("a@x.test, , ,b@x.test", undefined, "", "a@x.test"), "a@x.test, b@x.test");
    assert.equal(api.mergeAddressHeaders(), "");
  });
});

describe("getIdentityAutoRecipientHeader", () => {
  const { api } = load();
  const identity = { doCc: true, doCcList: "boss@x.test", doBcc: true, doBccList: "arch@x.test" };

  it("gives the automatic Cc or Bcc list of the identity when it is switched on", () => {
    assert.equal(api.getIdentityAutoRecipientHeader(identity, "cc"), "boss@x.test");
    assert.equal(api.getIdentityAutoRecipientHeader(identity, "bcc"), "arch@x.test");
  });

  it("gives nothing for a list that is off, empty or missing, for another kind and for no identity", () => {
    assert.equal(api.getIdentityAutoRecipientHeader({ doCc: false, doCcList: "boss@x.test" }, "cc"), "");
    assert.equal(api.getIdentityAutoRecipientHeader({ doCc: true }, "cc"), "");
    assert.equal(api.getIdentityAutoRecipientHeader({ doBcc: true }, "bcc"), "");
    assert.equal(api.getIdentityAutoRecipientHeader({ doBcc: false, doBccList: "arch@x.test" }, "bcc"), "");
    assert.equal(api.getIdentityAutoRecipientHeader(identity, "to"), "");
    assert.equal(api.getIdentityAutoRecipientHeader(null, "cc"), "");
  });

  it("gives nothing when the identity cannot be read", () => {
    const broken = { get doCc() { throw new Error("gone"); } };
    assert.equal(api.getIdentityAutoRecipientHeader(broken, "cc"), "");
  });
});

describe("applyComposeRecipientOverrides", () => {
  const identity = { doCc: true, doCcList: "boss@x.test, Dup <dup@x.test>", doBcc: true, doBccList: "arch@x.test" };

  it("does nothing without a window, or without a recipient to set", () => {
    const { api } = load();
    const calls = [];
    api.applyComposeRecipientOverrides(null, identity, "a@x.test", "", "");
    api.applyComposeRecipientOverrides({ SetComposeDetails: d => calls.push(d) }, identity, "", "", "");
    assert.deepEqual(calls, []);
  });

  it("sets the given recipients through SetComposeDetails, with the automatic Cc and Bcc of the identity merged in", () => {
    const { api } = load();
    const calls = [];
    api.applyComposeRecipientOverrides({ SetComposeDetails: d => calls.push(d) }, identity, "t@x.test", "dup@x.test, other@x.test", "z@x.test, ARCH@x.test");
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{
      identityKey: null, to: "t@x.test", cc: "boss@x.test, Dup <dup@x.test>, other@x.test", bcc: "arch@x.test, z@x.test",
    }]);
  });

  it("changes only the field it was given", () => {
    const { api } = load();
    const calls = [];
    api.applyComposeRecipientOverrides({ SetComposeDetails: d => calls.push(d) }, identity, "", "c@x.test", "");
    assert.deepEqual(Object.keys(calls[0]).sort(), ["cc", "identityKey"]);
    api.applyComposeRecipientOverrides({ SetComposeDetails: d => calls.push(d) }, null, "t@x.test", "", "");
    assert.deepEqual(Object.keys(calls[1]).sort(), ["identityKey", "to"]);
  });

  it("writes the compose fields and redraws the recipient rows when the window has no SetComposeDetails", () => {
    const { api } = load();
    const redrawn = [];
    const fields = { to: "old@x.test", cc: "oldcc@x.test", bcc: "oldbcc@x.test", subject: "S" };
    const win = { gMsgCompose: { compFields: fields }, CompFields2Recipients: f => redrawn.push({ ...f }) };
    api.applyComposeRecipientOverrides(win, identity, "t@x.test", "c@x.test", "");
    assert.deepEqual({ ...fields }, { to: "t@x.test", cc: "boss@x.test, Dup <dup@x.test>, c@x.test", bcc: "oldbcc@x.test", subject: "S" });
    assert.equal(redrawn.length, 1);
    assert.equal(redrawn[0].to, "t@x.test");
  });

  it("writes the fields even when the window cannot redraw the rows, and does nothing when it has no fields", () => {
    const { api } = load();
    const fields = { to: "", cc: "", bcc: "" };
    api.applyComposeRecipientOverrides({ gMsgCompose: { compFields: fields } }, null, "", "", "z@x.test");
    assert.equal(fields.bcc, "z@x.test");
    assert.doesNotThrow(() => api.applyComposeRecipientOverrides({ gMsgCompose: {} }, null, "t@x.test", "", ""));
    assert.doesNotThrow(() => api.applyComposeRecipientOverrides({}, null, "t@x.test", "", ""));
  });
});

describe("moveComposeSelectionToBodyStartIfRange", () => {
  const selectionOf = (isCollapsed, log) => ({ isCollapsed, removeAllRanges() { log.push("removeAllRanges"); }, addRange(range) { log.push(["addRange", range.collapsedToStart, range.startOffset]); } });
  const docOf = (selection, extra = {}) => ({
    body: { tag: "body" },
    getSelection: () => selection,
    createRange: () => ({ setStart(node, offset) { this.startNode = node; this.startOffset = offset; }, collapse(toStart) { this.collapsedToStart = toStart; } }),
    ...extra,
  });
  const windowOf = (doc, editor) => ({ getBrowser: () => ({ contentDocument: doc }), ...(editor ? { GetCurrentEditor: () => editor } : {}) });

  it("leaves a caret where it is", () => {
    const { api, warnings } = load();
    const log = [];
    assert.equal(api.moveComposeSelectionToBodyStartIfRange(windowOf(docOf(selectionOf(true, log)))), true);
    assert.deepEqual(log, []);
    assert.deepEqual(warnings, []);
  });

  it("puts a selected quote's place at the start of the body as a collapsed range", () => {
    const { api } = load();
    const log = [];
    assert.equal(api.moveComposeSelectionToBodyStartIfRange(windowOf(docOf(selectionOf(false, log)))), true);
    assert.deepEqual(log, ["removeAllRanges", ["addRange", true, 0]]);
  });

  it("anchors through the editor when the document cannot do it", () => {
    const { api, warnings } = load();
    const log = [];
    const editor = { beginningOfDocument: () => log.push("beginningOfDocument") };
    const failing = docOf(selectionOf(false, log), { createRange() { throw new Error("no range"); } });
    assert.equal(api.moveComposeSelectionToBodyStartIfRange(windowOf(failing, editor)), true);
    assert.deepEqual(log, ["beginningOfDocument"]);
    // a document without body or without createRange is the same case
    for (const doc of [docOf(selectionOf(false, log), { body: undefined }), docOf(selectionOf(false, log), { createRange: undefined })]) {
      log.length = 0;
      assert.equal(api.moveComposeSelectionToBodyStartIfRange(windowOf(doc, editor)), true);
      assert.deepEqual(log, ["beginningOfDocument"]);
    }
    assert.deepEqual(warnings, []);
  });

  it("says it could not anchor, with the reason, when nothing can move the caret", () => {
    const { api, warnings } = load();
    const error = new Error("no range");
    const failing = docOf(selectionOf(false, []), { createRange() { throw error; } });
    assert.equal(api.moveComposeSelectionToBodyStartIfRange(windowOf(failing)), false);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0][0], /could not anchor compose body insertion/);
    assert.equal(warnings[0][1], error);
  });

  it("reads the selection of the editor when the window has no document of its own", () => {
    const { api } = load();
    const log = [];
    const beginningOfDocument = () => log.push("beginningOfDocument");
    const run = editor => api.moveComposeSelectionToBodyStartIfRange({ GetCurrentEditor: () => editor });
    assert.equal(run({ selection: { isCollapsed: true }, beginningOfDocument }), true);
    assert.deepEqual(log, []);
    assert.equal(run({ selection: { isCollapsed: false }, beginningOfDocument }), true);
    assert.deepEqual(log, ["beginningOfDocument"]);
  });

  it("anchors defensively when the editor shows no selection, or fails to show it", () => {
    const { api } = load();
    const log = [];
    const beginningOfDocument = () => log.push("beginningOfDocument");
    assert.equal(api.moveComposeSelectionToBodyStartIfRange({ GetCurrentEditor: () => ({ beginningOfDocument }) }), true);
    assert.equal(api.moveComposeSelectionToBodyStartIfRange({ GetCurrentEditor: () => ({ get selection() { throw new Error("no selection"); }, beginningOfDocument }) }), true);
    assert.deepEqual(log, ["beginningOfDocument", "beginningOfDocument"]);
  });

  it("takes a selection it cannot read for nothing to move", () => {
    const { api, warnings } = load();
    const log = [];
    const selection = { get isCollapsed() { throw new Error("detached"); } };
    assert.equal(api.moveComposeSelectionToBodyStartIfRange({ GetCurrentEditor: () => ({ selection, beginningOfDocument: () => log.push("beginningOfDocument") }) }), true);
    assert.deepEqual(log, []);
    assert.deepEqual(warnings, []);
  });

  it("warns when the editor cannot go to the start of the document, or fails on the way", () => {
    const { api, warnings } = load();
    const error = new Error("busy");
    assert.equal(api.moveComposeSelectionToBodyStartIfRange({ GetCurrentEditor: () => ({ selection: { isCollapsed: false } }) }), false);
    assert.equal(warnings[0][1], null);
    assert.equal(api.moveComposeSelectionToBodyStartIfRange({ GetCurrentEditor: () => ({ selection: { isCollapsed: false }, beginningOfDocument() { throw error; } }) }), false);
    assert.equal(warnings[1][1], error);
  });

  it("warns for a window with neither document nor editor, or none at all", () => {
    const { api, warnings } = load();
    assert.equal(api.moveComposeSelectionToBodyStartIfRange({}), false);
    assert.equal(api.moveComposeSelectionToBodyStartIfRange(null), false);
    assert.equal(warnings.length, 2);
  });
});

describe("formatBodyFragmentHtml", () => {
  const parserOf = ({ onParse, body = { innerHTML: "BODY" }, signatures = [] } = {}) => class {
    parseFromString(html, type) {
      if (onParse) onParse(html, type);
      return { body, querySelectorAll: selector => { signatures.selector = selector; return signatures; } };
    }
  };

  it("turns a plain text body into escaped HTML with line breaks, and takes an HTML body as it is, without line feeds", () => {
    const { api } = load();
    assert.equal(api.formatBodyFragmentHtml("a <b>\nc", false), "a &lt;b&gt;<br>c");
    assert.equal(api.formatBodyFragmentHtml("<p>Café</p>\n<p>x</p>", true), "<p>Caf&#233;</p><p>x</p>");
    assert.equal(api.formatBodyFragmentHtml("\n\n", true), "");
  });

  it("keeps only the body of a whole document, without the signature the identity adds", () => {
    const removed = [];
    const signatures = [{ remove: () => removed.push("div") }, { remove: () => removed.push("pre") }];
    const parsed = [];
    const { api } = load({ DOMParser: parserOf({ onParse: (html, type) => parsed.push([html, type]), body: { innerHTML: "<p>x</p>" }, signatures }) });
    assert.equal(api.formatBodyFragmentHtml("<html><body><p>x</p></body></html>", true), "<p>x</p>");
    assert.deepEqual(parsed, [["<html><body><p>x</p></body></html>", "text/html"]]);
    assert.equal(signatures.selector, "div.moz-signature, pre.moz-signature");
    assert.deepEqual(removed, ["div", "pre"]);
  });

  it("parses a fragment too when it holds a signature block of its own", () => {
    const parsed = [];
    const { api } = load({ DOMParser: parserOf({ onParse: html => parsed.push(html), body: { innerHTML: "<p>x</p>" } }) });
    assert.equal(api.formatBodyFragmentHtml('<p>x</p><div class="moz-signature">S</div>', true), "<p>x</p>");
    assert.equal(parsed.length, 1);
    // a fragment without document tags or signature class is not parsed at all
    assert.equal(api.formatBodyFragmentHtml("<p>plain</p>", true), "<p>plain</p>");
    assert.equal(parsed.length, 1);
  });

  it("returns the text itself when the parser gives no body or fails", () => {
    const html = "<html><body><p>x</p></body></html>";
    assert.equal(load({ DOMParser: parserOf({ body: null }) }).api.formatBodyFragmentHtml(html, true), html);
    const throwing = class { parseFromString() { throw new Error("no parser"); } };
    assert.equal(load({ DOMParser: throwing }).api.formatBodyFragmentHtml(html, true), html);
  });
});

describe("insertReplyBodyIntoComposeWindow", () => {
  it("anchors the caret, then inserts the body as HTML at it, and marks the window as modified", () => {
    const { api } = load();
    const log = [];
    const win = editableWindow(log, { gContentChanged: false });
    win.gMsgCompose.bodyModified = false;
    api.insertReplyBodyIntoComposeWindow(win, "Hello <you>\nBye", false);
    assert.deepEqual(log, ["removeAllRanges", ["addRange", true, 0], ["execCommand", "insertHTML", false, "Hello &lt;you&gt;<br>Bye"]]);
    assert.equal(win.gMsgCompose.bodyModified, true);
    assert.equal(win.gContentChanged, true);
  });

  it("inserts through the editor when the document has no execCommand", () => {
    const { api } = load();
    const log = [];
    const editor = { selection: { isCollapsed: true }, insertHTML: html => log.push(["insertHTML", html]) };
    const win = composeWindow({ getBrowser: () => ({ contentDocument: {} }), GetCurrentEditor: () => editor });
    api.insertReplyBodyIntoComposeWindow(win, "<p>Hi</p>", true);
    assert.deepEqual(log, [["insertHTML", "<p>Hi</p>"]]);
    assert.equal(win.gMsgCompose.bodyModified, true);
    assert.equal("gContentChanged" in win, false);
  });

  it("inserts nothing, but still marks the window, when there is neither document nor editor to insert into", () => {
    const { api } = load();
    const noEditor = composeWindow({});
    api.insertReplyBodyIntoComposeWindow(noEditor, "Hi", false);
    assert.equal(noEditor.gMsgCompose.bodyModified, true);
    const log = [];
    const noInsert = composeWindow({ GetCurrentEditor: () => ({ insertHTML: undefined }) });
    api.insertReplyBodyIntoComposeWindow(noInsert, "Hi", false);
    assert.deepEqual(log, []);
    // a window that is not a compose window at all is left alone
    assert.doesNotThrow(() => api.insertReplyBodyIntoComposeWindow({}, "Hi", false));
  });

  it("does nothing for no window, no body, or a body that is empty once formatted", () => {
    const { api } = load();
    const log = [];
    const win = editableWindow(log);
    api.insertReplyBodyIntoComposeWindow(null, "Hi", false);
    api.insertReplyBodyIntoComposeWindow(win, "", false);
    api.insertReplyBodyIntoComposeWindow(win, "\n\n", true);
    assert.deepEqual(log, []);
    assert.equal(win.gMsgCompose.bodyModified, undefined);
  });
});

describe("openComposeWindowWithCustomizations", () => {
  const URI = "mailbox-message://inbox#1";
  const params = { composeFields: { from: "me@x.test" }, format: 1, origMsgHdr: { key: 7 } };
  const identity = { email: "id@x.test", doCc: true, doCcList: "boss@x.test" };
  const open = (api, type = CompType.Reply, body = "Hi", to = "t@x.test", cc = "c@x.test", attachDescs = [{ name: "a.txt" }]) =>
    api.openComposeWindowWithCustomizations(params, URI, type, identity, body, false, to, cc, "", attachDescs);
  // the window opens, Thunderbird starts it, and the observer binds to it
  const start = (observer, win) => {
    observer.observe(win, "domwindowopened");
    for (const { name, listener } of win.eventListeners.splice(0)) { assert.equal(name, "compose-window-init"); listener(); }
  };
  const settledValue = promise => {
    const out = { done: false };
    promise.then(value => { out.done = true; out.value = value; return value; }).catch(() => { out.done = true; });
    return out;
  };

  it("opens the compose window with the params, and fills the window of its own message once its body is ready", async () => {
    const { api, observers, unregistered, timers, composeCalls } = load();
    const log = [];
    const promise = open(api);
    assert.equal(observers.length, 1);
    assert.deepEqual(composeCalls, [["params", null, params]]);
    assert.equal(timers[0].ms, 15000);
    const win = editableWindow(log, { uri: URI });
    win.gMsgCompose.originalMsgURI = URI;
    // topics other than a window opening, and subjects that are not windows, are ignored
    observers[0].observe(win, "domwindowclosed");
    observers[0].observe({}, "domwindowopened");
    observers[0].observe(null, "domwindowopened");
    assert.deepEqual(win.eventListeners, []);
    observers[0].observe(win, "domwindowopened");
    assert.equal(win.eventListeners.length, 1);
    assert.deepEqual({ ...win.eventListeners[0].options }, { once: true, capture: true });
    win.eventListeners[0].listener();
    // bound: the observer is gone and Thunderbird is told to report when the body is ready
    assert.equal(observers.length, 0);
    assert.equal(win.gMsgCompose.stateListeners.length, 1);
    win.gMsgCompose.stateListeners[0].NotifyComposeBodyReady();
    assert.deepEqual(plain(await promise), { success: true });
    assert.deepEqual(log.map(entry => (Array.isArray(entry) ? entry[0] : entry)), ["SetComposeDetails", "removeAllRanges", "addRange", "execCommand", "AddAttachments"]);
    assert.deepEqual(JSON.parse(JSON.stringify(log[0][1])), { identityKey: null, to: "t@x.test", cc: "boss@x.test, c@x.test" });
    assert.deepEqual(JSON.parse(JSON.stringify(log[4][1])), [{ name: "a.txt", converted: true }]);
    assert.equal(win.gMsgCompose.stateListeners.length, 0);
    assert.equal(timers[0].cancelled, true);
    assert.ok(unregistered.length >= 1);
  });

  it("gives an inline forward the compose service call that fills the forward itself, and more time", async () => {
    const { api, observers, timers, composeCalls } = load();
    const promise = open(api, CompType.ForwardInline);
    assert.equal(timers[0].ms, 60000);
    assert.deepEqual(composeCalls, [["direct", null, params.origMsgHdr, URI, CompType.ForwardInline, 1, identity, "me@x.test", null]]);
    timers[0].callback.notify();
    assert.deepEqual(plain(await promise), { error: "Timed out waiting for compose window" });
    assert.equal(observers.length, 0);
  });

  it("sends an inline forward from the identity address when the fields hold no sender, and from nothing when it has no address either", () => {
    const { api, composeCalls } = load();
    const noFrom = { composeFields: {}, format: 2, origMsgHdr: {} };
    api.openComposeWindowWithCustomizations(noFrom, URI, CompType.ForwardInline, identity, "", false, "", "", "", []);
    api.openComposeWindowWithCustomizations({ format: 2, origMsgHdr: {} }, URI, CompType.ForwardInline, null, "", false, "", "", "", []);
    assert.equal(composeCalls[0][7], "id@x.test");
    assert.equal(composeCalls[1][7], "");
  });

  it("uses the compose service of the component manager when MailServices has none", () => {
    const { api, composeCalls } = load({ MailServices: {} });
    open(api);
    assert.deepEqual(composeCalls, [["params", null, params]]);
  });

  it("reports an error, and stops waiting, when the window cannot be opened", async () => {
    const { api, observers, timers, sandbox } = load();
    sandbox.MailServices.compose.OpenComposeWindowWithParams = () => { throw new Error("no window"); };
    assert.deepEqual(plain(await open(api)), { error: "Error: no window" });
    assert.equal(observers.length, 0);
    assert.equal(timers[0].cancelled, true);
  });

  it("reports an error when the observer cannot be registered", async () => {
    const { api, sandbox, composeCalls } = load();
    sandbox.Services.ww.registerNotification = () => { throw new Error("no observer"); };
    assert.deepEqual(plain(await open(api)), { error: "Error: no observer" });
    assert.deepEqual(composeCalls, []);
  });

  it("does not bind to a window that is not the compose window of its message and type", async () => {
    const { api, observers } = load();
    const promise = settledValue(open(api));
    const others = [
      composeWindow({ windowtype: "mail:3pane" }),
      composeWindow({ withCompose: false }),
      composeWindow({ uri: "mailbox-message://inbox#2" }),
      composeWindow({ uri: URI, type: CompType.ReplyAll }),
    ];
    for (const win of others) start(observers[0], win);
    await tick();
    for (const win of others) assert.equal(win.gMsgCompose?.stateListeners.length ?? 0, 0);
    assert.equal(observers.length, 1);
    assert.equal(promise.done, false);
    // the right one is still found
    const win = composeWindow({ uri: URI });
    start(observers[0], win);
    assert.equal(win.gMsgCompose.stateListeners.length, 1);
  });

  it("binds each concurrent call to exactly one window, though both see every window", async () => {
    const { api, observers } = load();
    open(api);
    open(api);
    const [first, second] = observers.slice();
    const a = composeWindow({ uri: URI });
    const b = composeWindow({ uri: URI });
    // both observers see window A: the one that is first to start it gets it
    first.observe(a, "domwindowopened");
    second.observe(a, "domwindowopened");
    a.eventListeners[0].listener();
    a.eventListeners[1].listener();
    assert.equal(a.gMsgCompose.stateListeners.length, 1);
    assert.deepEqual(observers, [second]);
    start(second, b);
    assert.equal(b.gMsgCompose.stateListeners.length, 1);
    assert.equal(observers.length, 0);
  });

  it("ignores a second start event of the window it is bound to", () => {
    const { api, observers } = load();
    open(api);
    const win = composeWindow({ uri: URI });
    observers[0].observe(win, "domwindowopened");
    win.eventListeners[0].listener();
    win.eventListeners[0].listener();
    assert.equal(win.gMsgCompose.stateListeners.length, 1);
  });

  it("reports an error when Thunderbird refuses the state listener", async () => {
    const { api, observers } = load();
    const promise = open(api);
    const win = composeWindow({ uri: URI });
    win.gMsgCompose.RegisterStateListener = () => { throw new Error("no listener"); };
    start(observers[0], win);
    assert.deepEqual(plain(await promise), { error: "Error: no listener" });
  });

  it("reports an error when the window cannot take the body, and stops listening", async () => {
    const { api, observers } = load();
    const log = [];
    const promise = open(api);
    const win = editableWindow(log, { AddAttachments() { throw new Error("disk full"); } });
    win.gMsgCompose.originalMsgURI = URI;
    start(observers[0], win);
    win.gMsgCompose.stateListeners[0].NotifyComposeBodyReady();
    assert.deepEqual(plain(await promise), { error: "Error: disk full" });
    assert.equal(win.gMsgCompose.stateListeners.length, 0);
  });

  it("gives up after the timeout, takes its state listener back, and leaves a window that gets ready later alone", async () => {
    const { api, observers, timers } = load();
    const log = [];
    const promise = open(api);
    const win = editableWindow(log);
    win.gMsgCompose.originalMsgURI = URI;
    start(observers[0], win);
    const listener = win.gMsgCompose.stateListeners[0];
    timers[0].callback.notify();
    assert.deepEqual(plain(await promise), { error: "Timed out waiting for compose window" });
    assert.equal(win.gMsgCompose.stateListeners.length, 0);
    // a body-ready that was already on its way changes nothing, and the first result stands
    listener.NotifyComposeBodyReady();
    assert.deepEqual(log, []);
    timers[0].callback.notify();
    assert.deepEqual(plain(await promise), { error: "Timed out waiting for compose window" });
  });

  it("settles even when the observer, the timer or the state listener cannot be taken away", async () => {
    const { api, observers, timers, sandbox } = load();
    const log = [];
    const promise = open(api);
    sandbox.Services.ww.unregisterNotification = () => { throw new Error("gone"); };
    timers[0].cancel = () => { throw new Error("gone"); };
    const win = editableWindow(log);
    win.gMsgCompose.originalMsgURI = URI;
    win.gMsgCompose.UnregisterStateListener = () => { throw new Error("gone"); };
    start(observers[0], win);
    win.gMsgCompose.stateListeners[0].NotifyComposeBodyReady();
    assert.deepEqual(plain(await promise), { success: true });
  });

  it("settles with the timeout error even when the state listener cannot be unregistered", async () => {
    const { api, observers, timers } = load();
    const promise = open(api);
    const win = composeWindow({ uri: URI });
    win.gMsgCompose.UnregisterStateListener = () => { throw new Error("gone"); };
    start(observers[0], win);
    timers[0].callback.notify();
    assert.deepEqual(plain(await promise), { error: "Timed out waiting for compose window" });
    // late: the listener is unregistered again, the error swallowed
    assert.doesNotThrow(() => win.gMsgCompose.stateListeners[0].NotifyComposeBodyReady());
  });
});
