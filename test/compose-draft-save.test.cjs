"use strict";
// saveComposeFieldsAsDraft: drafts go through a window-less nsIMsgCompose, whose state
// listener is removed however the save ends; nsIMsgSend is the fallback. An edited draft is replaced.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const API = fs.readFileSync(path.join(__dirname, "..", "extension", "mcp_server", "api.js"), "utf8");
const region = API.slice(API.indexOf("// BEGIN COMPOSE DRAFT SAVE"), API.indexOf("// END COMPOSE DRAFT SAVE"));

const CompType = { New: 0, Reply: 1, ReplyAll: 2, ForwardInline: 4, Draft: 9 };

function load({ initThrows = false, sendMsg } = {}) {
  const composes = [];
  const timers = [];
  const directSends = [];
  const Cc = {
    "@mozilla.org/timer;1": {
      createInstance: () => {
        const timer = { cancelled: false, initWithCallback(cb) { timer.fire = () => { if (!timer.cancelled) cb.notify(); }; }, cancel() { timer.cancelled = true; } };
        timers.push(timer);
        return timer;
      },
    },
    "@mozilla.org/messengercompose/composeparams;1": { createInstance: () => ({}) },
  };
  const initCompose = params => {
    if (initThrows) throw new Error("initCompose unavailable");
    const compose = {
      params,
      compFields: { draftId: "", messageId: "" },
      listeners: new Set(),
      calls: [],
      RegisterStateListener(l) { this.listeners.add(l); },
      UnregisterStateListener(l) { this.listeners.delete(l); },
      sendMsg(...args) {
        compose.calls.push(args);
        return (sendMsg || defaultSend)(compose, args);
      },
      done(status) { for (const l of this.listeners) l.ComposeProcessDone(status); },
    };
    composes.push(compose);
    return compose;
  };
  const defaultSend = compose => {
    compose.compFields.draftId = "mailbox-message://drafts#1";
    return Promise.resolve();
  };
  const sandbox = {
    Cc,
    Ci: {
      nsIMsgComposeParams: {},
      nsIMsgCompType: CompType,
      nsIMsgCompFormat: { HTML: 1, PlainText: 2 },
      nsIMsgCompDeliverMode: { SaveAsDraft: 4 },
      nsIMsgCompSendFormat: { Unset: 0, Auto: 4 },
      nsITimer: { TYPE_ONE_SHOT: 0 },
    },
    ChromeUtils: { generateQI: () => () => {} },
    Components: { isSuccessCode: status => status === 0 },
    Services: {
      prefs: { getIntPref: (name, fallback) => fallback },
      tm: { dispatchToMainThread: fn => setImmediate(fn) },
    },
    MailServices: {
      compose: { initCompose },
      messageServiceFromURI: () => ({
        messageURIToMsgHdr: uri => ({ messageId: `saved-${uri.split("#")[1]}@example.test`, folder: { URI: "mailbox://nobody@Local%20Folders/Drafts" } }),
      }),
    },
    console: { warn() {} },
    descsToMsgAttachments: descs => descs,
    accountKeyForIdentity: () => "account1",
    getDraftsFolder: () => ({ URI: "mailbox://nobody@Local%20Folders/Drafts" }),
    generateMessageId: () => "<generated@example.test>",
    sendMessageDirectly: async (...args) => { directSends.push(args); return { success: true, message: "Draft saved" }; },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${region}\nthis.save = saveComposeFieldsAsDraft;`, sandbox);
  return { save: sandbox.save, composes, timers, directSends };
}

const identity = { email: "me@example.test" };
const fields = (extra = {}) => ({ deliveryFormat: 0, attachments: [], addAttachment(a) { this.attachments.push(a); }, removeAttachments() { this.attachments = []; }, ...extra });
const tick = () => new Promise(r => setImmediate(r));
const draftHdr = () => {
  const hdr = { deleted: 0, folder: { getUriForMsg: () => "mailbox-message://drafts#3", deleteMessages(list) { hdr.deleted += list.length; } } };
  return hdr;
};

describe("saveComposeFieldsAsDraft", () => {
  it("saves through nsIMsgCompose and returns the new draft", async () => {
    const { save, composes, directSends } = load({
      sendMsg: (compose) => { compose.compFields.draftId = "mailbox-message://drafts#7"; setImmediate(() => compose.done(0)); return Promise.resolve(); },
    });
    const result = await save(fields(), identity, [{ name: "a.txt" }], false);
    assert.deepEqual({ ...result }, { success: true, messageId: "saved-7@example.test", folderPath: "mailbox://nobody@Local%20Folders/Drafts" });
    assert.equal(composes.length, 1);
    assert.equal(composes[0].listeners.size, 0, "state listener removed");
    assert.equal(composes[0].calls[0].length, 4);
    assert.equal(composes[0].calls[0][0], 4);
    assert.equal(directSends.length, 0);
  });

  it("keeps the reply recipients the caller set and sets the type after init", async () => {
    const { save, composes } = load({
      sendMsg: (compose) => { setImmediate(() => compose.done(0)); return Promise.resolve(); },
    });
    const composeFields = fields({ from: "", to: "a@example.test", cc: "b@example.test", bcc: "", replyTo: "desk@example.test" });
    await save(composeFields, identity, [], true, "mailbox-message://inbox#1", CompType.ReplyAll);
    const [compose] = composes;
    assert.equal(compose.params.type, CompType.New);
    assert.equal(compose.params.originalMsgURI, "mailbox-message://inbox#1");
    assert.equal(compose.type, CompType.ReplyAll);
    assert.equal(compose.compFields.to, "a@example.test");
    assert.equal(compose.compFields.replyTo, "desk@example.test");
  });

  it("removes the listener when the send is rejected", async () => {
    const { save, composes } = load({ sendMsg: () => Promise.reject(Object.assign(new Error("no drafts folder"), { result: 0x80004005 })) });
    const result = await save(fields(), identity, [], false);
    assert.match(result.error, /Draft save failed \(status: 0x80004005\)/);
    assert.equal(composes[0].listeners.size, 0);
  });

  it("removes the listener when the save reports a failure", async () => {
    const { save, composes } = load({ sendMsg: (compose) => { setImmediate(() => compose.done(0x80553012)); return new Promise(() => {}); } });
    const result = await save(fields(), identity, [], false);
    assert.match(result.error, /status: 0x80553012/);
    assert.equal(composes[0].listeners.size, 0);
  });

  it("removes the listener on timeout", async () => {
    const { save, composes, timers } = load({ sendMsg: () => new Promise(() => {}) });
    const pending = save(fields(), identity, [], false);
    await tick();
    timers[0].fire();
    assert.match((await pending).error, /timed out after 120s/);
    assert.equal(composes[0].listeners.size, 0);
  });

  it("passes the msgWindow argument that 140 ESR still takes", async () => {
    const { save, composes } = load({
      sendMsg: (compose, args) => {
        if (args.length < 5) throw Object.assign(new Error("Not enough arguments"), { result: 0x80570001 });
        setImmediate(() => compose.done(0));
        return Promise.resolve();
      },
    });
    const result = await save(fields(), identity, [], false);
    assert.equal(result.success, true);
    assert.deepEqual(composes[0].calls.map(c => c.length), [4, 5]);
    assert.equal(composes[0].listeners.size, 0);
  });

  it("falls back to nsIMsgSend when nsIMsgCompose cannot be used", async () => {
    for (const options of [{ initThrows: true }, { sendMsg: () => { throw new Error("broken"); } }]) {
      const { save, composes, directSends } = load(options);
      const composeFields = fields();
      const result = await save(composeFields, identity, [{ name: "a.txt" }], true, "mailbox-message://inbox#1", CompType.Reply);
      assert.deepEqual({ ...result }, { success: true, messageId: "generated@example.test", folderPath: "mailbox://nobody@Local%20Folders/Drafts" });
      assert.equal(directSends.length, 1);
      assert.deepEqual(directSends[0].slice(3), ["mailbox-message://inbox#1", CompType.Reply, 4, "text/html"]);
      assert.equal(composeFields.attachments.length, 0, "attachments are added again by nsIMsgSend");
      for (const compose of composes) assert.equal(compose.listeners.size, 0);
    }
  });

  it("replaces an edited draft as a Draft compose: no original, no reply type, the new draft returned", async () => {
    const { save, composes } = load({
      sendMsg: (compose) => { compose.compFields.draftId = "mailbox-message://drafts#8"; setImmediate(() => compose.done(0)); return Promise.resolve(); },
    });
    const composeFields = fields({ to: "a@example.test" });
    const old = draftHdr();
    const result = await save(composeFields, identity, [], true, "mailbox-message://inbox#1", CompType.Reply, old);
    const [compose] = composes;
    assert.equal(compose.params.type, CompType.Draft);
    assert.equal(compose.params.originalMsgURI, "");
    assert.equal(compose.params.composeFields.draftId, "mailbox-message://drafts#3");
    assert.equal(compose.type, undefined);
    assert.equal(compose.compFields.to, undefined, "no reply recipients copied");
    assert.equal(result.messageId, "saved-8@example.test");
    assert.equal(old.deleted, 0, "Thunderbird removes the old version itself");
  });

  it("the nsIMsgSend fallback saves an edited draft as new and removes the old version", async () => {
    const { save, directSends } = load({ initThrows: true });
    const composeFields = fields();
    const old = draftHdr();
    const result = await save(composeFields, identity, [], false, "mailbox-message://inbox#1", CompType.Reply, old);
    assert.equal(result.messageId, "generated@example.test");
    assert.equal(composeFields.draftId, "");
    assert.deepEqual(directSends[0].slice(3), [null, CompType.New, 4, "text/plain"]);
    assert.equal(old.deleted, 1);
  });
});
