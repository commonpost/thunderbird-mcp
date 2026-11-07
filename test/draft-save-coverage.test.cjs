// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";
// Saving a draft: what saveComposeFieldsAsDraft does with the compose object of older Thunderbird versions, with a
// rejection that carries no status, with a send format that is already chosen, and what the nsIMsgSend fallback
// returns when it fails. Complements compose-draft-save.test.cjs.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const API = fs.readFileSync(path.join(__dirname, "..", "extension", "mcp_server", "api.js"), "utf8");
const region = API.slice(API.indexOf("// BEGIN COMPOSE DRAFT SAVE"), API.indexOf("// END COMPOSE DRAFT SAVE"));

const CompType = { New: 0, Reply: 1, Draft: 9 };
const plain = v => JSON.parse(JSON.stringify(v));

function load({ capitalSend = false, sendMsg, initThrows = false, directSend, draftsFolder = { URI: "mailbox://nobody@Local%20Folders/Drafts" }, prefs = {} } = {}) {
  const composes = [];
  const prefReads = [];
  const directSends = [];
  const Cc = {
    "@mozilla.org/timer;1": { createInstance: () => ({ initWithCallback() {}, cancel() {} }) },
    "@mozilla.org/messengercompose/composeparams;1": { createInstance: () => ({}) },
  };
  const initCompose = params => {
    if (initThrows) throw new Error("initCompose unavailable");
    const compose = {
      params,
      compFields: { draftId: "", messageId: "" },
      RegisterStateListener() {},
      UnregisterStateListener() {},
      done(status) { compose.listener.ComposeProcessDone(status); },
    };
    const send = (...args) => (sendMsg || ((c) => { c.compFields.draftId = "mailbox-message://drafts#1"; setImmediate(() => c.done(0)); return Promise.resolve(); }))(compose, args);
    if (capitalSend) compose.SendMsg = send; else compose.sendMsg = send;
    compose.RegisterStateListener = listener => { compose.listener = listener; };
    composes.push(compose);
    return compose;
  };
  const sandbox = {
    draftArrivalCheck: () => null, // arrival guard: arrival-resend-guard.test.cjs
    Cc,
    Ci: {
      nsIMsgComposeParams: {}, nsIMsgCompType: CompType, nsIMsgCompFormat: { HTML: 1, PlainText: 2 }, nsIMsgCompDeliverMode: { SaveAsDraft: 4 },
      nsIMsgCompSendFormat: { Unset: 0, Auto: 4 }, nsITimer: { TYPE_ONE_SHOT: 0 },
    },
    ChromeUtils: { generateQI: () => () => {} },
    Components: { isSuccessCode: status => status === 0 },
    Services: {
      prefs: { getIntPref: (name, fallback) => { prefReads.push(name); return name in prefs ? prefs[name] : fallback; } },
      tm: { dispatchToMainThread: fn => setImmediate(fn) },
      uuid: { generateUUID: () => ({ toString: () => "{0a1b2c3d-0000}" }) },
    },
    MailServices: {
      compose: { initCompose },
      messageServiceFromURI: () => ({ messageURIToMsgHdr: uri => ({ messageId: `saved-${uri.split("#")[1]}@example.test`, folder: { URI: "mailbox://nobody@Local%20Folders/Drafts" } }) }),
    },
    console: { warn() {} },
    descsToMsgAttachments: descs => descs,
    accountKeyForIdentity: () => "account1",
    getDraftsFolder: () => draftsFolder,
    generateMessageId: () => "<generated@example.test>",
    sendMessageDirectly: directSend || (async (...args) => { directSends.push(args); return { success: true }; }),
  };
  vm.createContext(sandbox);
  vm.runInContext(`${region}\nthis.save = saveComposeFieldsAsDraft;`, sandbox);
  return { save: sandbox.save, composes, prefReads, directSends };
}

const identity = { email: "me@example.test" };
const fields = (extra = {}) => ({ deliveryFormat: 0, attachments: [], addAttachment(a) { this.attachments.push(a); }, removeAttachments() { this.attachments = []; }, ...extra });
const draftHdr = (extra = {}) => ({ deleted: 0, folder: { getUriForMsg: () => "mailbox-message://drafts#3", deleteMessages(list) { this.owner.deleted += list.length; }, ...extra }, get owner() { return this; } });

describe("saveComposeFieldsAsDraft with older and newer Thunderbird", () => {
  it("saves through SendMsg when the compose object only has the older capitalised method", async () => {
    const { save, composes } = load({ capitalSend: true });
    const result = await save(fields(), identity, [], false);
    assert.equal(result.success, true);
    assert.equal(composes[0].sendMsg, undefined);
  });

  it("reports the generic failure status when the send is rejected without a status of its own", async () => {
    for (const rejection of [new Error("boom"), { result: "NS_ERROR" }, undefined]) {
      const { save } = load({ sendMsg: () => Promise.reject(rejection) });
      const result = await save(fields(), identity, [], false);
      assert.deepEqual(plain(result), { error: "Draft save failed (status: 0x80004005)" }, String(rejection));
    }
  });

  it("asks the preference for the send format only when the fields do not have one yet", async () => {
    const unset = load({ prefs: { "mail.default_send_format": 2 } });
    const unsetFields = fields({ deliveryFormat: 0 });
    await unset.save(unsetFields, identity, [], false);
    assert.deepEqual(unset.prefReads, ["mail.default_send_format"]);
    assert.equal(unsetFields.deliveryFormat, 2);
    const chosen = load({ prefs: { "mail.default_send_format": 2 } });
    const chosenFields = fields({ deliveryFormat: 1 });
    await chosen.save(chosenFields, identity, [], false);
    assert.deepEqual(chosen.prefReads, []);
    assert.equal(chosenFields.deliveryFormat, 1);
  });
});

describe("the nsIMsgSend fallback of saveComposeFieldsAsDraft", () => {
  it("saves a new message as a plain New compose with no original", async () => {
    const { save, directSends } = load({ initThrows: true });
    const result = await save(fields(), identity, [{ name: "a.txt" }], false);
    assert.deepEqual(plain(result), { success: true, messageId: "generated@example.test", folderPath: "mailbox://nobody@Local%20Folders/Drafts" });
    assert.deepEqual(plain(directSends[0].slice(2)), [[{ name: "a.txt" }], null, CompType.New, 4, "text/plain"]);
  });

  it("returns the failure of the save as it is, and leaves the edited draft in place", async () => {
    const failure = { error: "No drafts folder" };
    const { save } = load({ initThrows: true, directSend: async () => failure });
    const old = draftHdr();
    assert.equal(await save(fields(), identity, [], false, null, null, old), failure);
    assert.equal(old.deleted, 0);
  });

  it("returns the new draft without a folder when the identity has no Drafts folder", async () => {
    const { save } = load({ initThrows: true, draftsFolder: null });
    assert.deepEqual(plain(await save(fields(), identity, [], true)), { success: true, messageId: "generated@example.test" });
  });

  it("says so when the old version of an edited draft cannot be removed", async () => {
    const { save } = load({ initThrows: true });
    const old = draftHdr({ deleteMessages() { throw new Error("locked"); } });
    const result = plain(await save(fields(), identity, [], false, "mailbox-message://inbox#1", CompType.Reply, old));
    assert.equal(result.success, true);
    assert.equal(result.warning, "New draft saved, but the old version could not be removed: Error: locked");
  });
});

describe("generateMessageId", () => {
  const generate = (identityValue) => {
    const sandbox = { Services: { uuid: { generateUUID: () => ({ toString: () => "{0a1b2c3d-0000}" }) } } };
    vm.createContext(sandbox);
    const i = API.indexOf("function generateMessageId(");
    assert.ok(i >= 0);
    const j = API.indexOf("\n            }\n", i);
    vm.runInContext(`${API.slice(i, j + "\n            }\n".length)}\nthis.result = generateMessageId(${JSON.stringify(identityValue)});`, sandbox);
    return sandbox.result;
  };

  it("makes an id of a new UUID without braces, at the domain of the identity", () => {
    assert.equal(generate({ email: "me@mail.example.test" }), "<0a1b2c3d-0000@mail.example.test>");
  });

  it("uses localhost when the identity has no address with a domain", () => {
    assert.equal(generate({ email: "me" }), "<0a1b2c3d-0000@localhost>");
    assert.equal(generate({}), "<0a1b2c3d-0000@localhost>");
    assert.equal(generate(null), "<0a1b2c3d-0000@localhost>");
  });
});

describe("getDraftsFolder", () => {
  const find = (identityValue, folders) => {
    const sandbox = {
      draftArrivalCheck: () => null, // arrival guard: arrival-resend-guard.test.cjs
      MailServices: { folderLookup: { getFolderForURL: uri => { if (!(uri in folders)) throw new Error("no such folder"); return folders[uri]; } } },
    };
    vm.createContext(sandbox);
    const i = API.indexOf("function getDraftsFolder(");
    assert.ok(i >= 0);
    const end = "\n            }\n";
    const j = API.indexOf(end, i);
    vm.runInContext(`${API.slice(i, j + end.length)}\nthis.found = (id) => getDraftsFolder(id);`, sandbox);
    return sandbox.found(identityValue);
  };
  const drafts = { URI: "imap://me@example.test/Drafts" };

  it("looks the folder up by the Drafts URI of the identity, or by its older name draftFolder", () => {
    assert.equal(find({ draftsFolderURI: "imap://me@example.test/Drafts" }, { "imap://me@example.test/Drafts": drafts }), drafts);
    assert.equal(find({ draftFolder: "imap://me@example.test/Drafts" }, { "imap://me@example.test/Drafts": drafts }), drafts);
  });

  it("has no folder for an identity without a Drafts URI, one that cannot be read, or a URI that is not a folder", () => {
    assert.equal(find({}, {}), null);
    assert.equal(find(null, {}), null);
    assert.equal(find({ get draftsFolderURI() { throw new Error("no pref"); } }, {}), null);
    assert.equal(find({ draftsFolderURI: "imap://me@example.test/Gone" }, {}), null);
  });
});
